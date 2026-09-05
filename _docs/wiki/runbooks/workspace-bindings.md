# Workspace bindings

**Outcome:** a repository mount attached, migrated or rotated, and every binding verified
against what the pods actually mounted.

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
2. `hg workspace verify --repository <r>`. A wrong value shows as the `unavailable` marker:
   fetch failed, checkout stale.

## Proof

```bash
hg workspace verify                       # desired vs observed: mounts, revisions, read-only probe
hg test --tier workspace-bindings --json  # the failure matrix, ~3 minutes
```

The tier rehearses: an invalid sha refused before deploy, a missing credential degrading
loudly, a clone failure reported as `unavailable` never as an empty mount, revision drift on
the row, an unbound sibling seeing nothing, and a read-only mount refusing a real write.

**Done when** `hg workspace verify` reports every row as expected and the tier passes.
