# Workspace bindings

**Outcome:** a repository mount attached, migrated, moved to a branch or rotated, and every
binding verified against what the pods actually mounted.

Repository access is declared in one place, `harness-hg/workspaces.yaml`: every repository
and every repository→agent grant. The model: [Repository mounts](../agent-team-install/repositories.md).

## Attach a repository to an agent

1. Add the agent to the binding's `profiles:` list, or add a new binding for a different
   mount or access.
2. `hg workspace plan`, then deploy (`hg up`, or merge and let the reconciler tick).
3. `hg workspace verify --profile <agent>`.

The StatefulSet template changes, so expect one pod roll. An agent gaining its first
workspace adds a volume claim, which needs a one-time `--cascade=orphan` on a pre-existing
StatefulSet.

## Move a repository to a branch

For a standalone Eve agent. A bundled agent refuses a branch-following repository.

1. Set the file's `apiVersion` to `hermes.gitops/v1alpha2`; nothing else in a v1alpha1 file
   changes meaning.
2. Replace the repository's revision with `{ mode: tracked, branch: main, refreshInterval: 30m }`.
3. `hg workspace plan` shows `tracks main every 30m` for it.
4. Deploy. The pod rolls once: it gains the refresh container.
5. `hg workspace verify --repository <r>`: every bound row shows
   `tracks main@<sha> last ok <time>` and no `STALE`.

Going back to a pin is the same edit in reverse; the next pod start replaces the branch
checkout with the pinned one.

## A branch-following workspace is stale or failing

`WorkspaceStale` fired, or `hg workspace verify` reports `last refresh failed` or `STALE`.

1. Read the reason: `kubectl -n <namespace> logs <pod> -c workspace-sync`, or the `error` in
   `hg workspace verify --json`.
2. Fix by cause:
   - **Fetching the branch failed:** the credential or the URL. Rotate the Secret; the next
     interval retries.
   - **The branch was rewritten** or **the checkout has local modifications:** the refresh
     refuses to converge over either. Restore the branch history, or discard the workspace
     and start the pod again, which clones the current tip:

     ```bash
     kubectl -n <namespace> exec <pod> -c workspace-sync -- rm /app/workspaces/<name>
     kubectl -n <namespace> delete pod <pod>
     ```

   - **No freshness reported:** the refresh container is not running, or nothing scrapes the
     pod. Check the container's state, then the `hg_workspace_last_success_timestamp_seconds`
     series in Grafana.
3. `hg workspace verify --repository <r>` is clean.

## Migrate a legacy declaration

Older repos declared repositories inside `bundles.yaml`. The loader refuses those fields.

1. Author the same facts in `harness-hg/workspaces.yaml`:

   ```yaml
   apiVersion: hermes.gitops/v1alpha1
   kind: WorkspaceBindings
   repositories:
     - name: product
       source:
         url: https://github.com/org/product
         revision: { mode: pinned, sha: <40-hex> }
         authSecretRef: <secret-name, if any>
       mount: { path: /workspaces/product, access: read-only }
   bindings:
     - repository: product
       profiles: [<every agent that had it>]
       purpose: strategy-context
   ```

2. Delete the old fields from `bundles.yaml`.
3. `hg workspace plan --json` must show the same repository, sha, mount and agents.
4. Deploy, then `hg workspace verify`: every bound row `mounted`, every unbound row `absent`.

Rollback is reverting to the previous `workspaces.yaml`, never resurrecting the old fields.

## Rotate a repository credential

The declaration carries a reference, never a value, so rotation never touches Git.

1. Update the Secret where the bound agents run.
2. `hg workspace verify --repository <r>`. A wrong value shows as the `unavailable` marker
   (fetch failed, checkout stale), or, for a branch-following repository, as a failed refresh.

## Proof

```bash
hg workspace verify                       # desired vs observed: mounts, revisions, freshness, read-only probe
hg test --tier workspace-bindings --json  # the failure matrix, ~3 minutes
```

The tier rehearses: an invalid sha refused before deploy, a missing credential degrading
loudly, a clone failure reported as `unavailable` never as an empty mount, revision drift on
the row, an unbound sibling seeing nothing, and a read-only mount refusing a real write.

**Done when** `hg workspace verify` reports every row as expected, no branch-following row is
`STALE`, and the tier passes.
