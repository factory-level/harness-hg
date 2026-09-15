# Repository mounts

**What this page tells you:** how an agent gets a Git repository as working context, who
may grant one, and how an agent knows the files are current.

## What it means

A **repository mount** puts a Git checkout inside an agent's filesystem, at a known revision
or following a branch. The agent reads it as ordinary files: a codebase, a strategy document,
the operation's own source.

## What you write

The team declares the repositories it brings in `harness-hg/workspaces.yaml`. The operator
grants extra mounts, with their credentials, in the environment spec. Your repository cannot
request a mount of someone else's repository.

```yaml
# harness-hg/workspaces.yaml
repositories:
  - name: webapp
    source:
      url: https://github.com/you/your-webapp.git
      revision: { mode: pinned, sha: <40-hex> }
      authSecretRef: webapp-git
    mount:
      access: read-only
bindings:
  - repository: webapp
    profiles: [project-agent]
    purpose: code-context
```

**Default access is none.** Bundle membership grants nothing. A binding must name both the
repository and the agent. `source: self` mounts the agent's own repository at its deployed
revision. `mode: application-revision` follows another application's deployed revision and
refuses when that application lives in a different repository.

## What you get

| Property | Detail |
|---|---|
| Path | On Eve, under the workspaces root, found through `EVE_WORKSPACE_<NAME>` |
| Access | `read-only` or `read-write`. Read-only is enforced by mode bits, and by a read-only mount when every binding of the agent is read-only |
| Revision | pinned, tracked to another application's deployment, or following a branch |
| Credential | a Secret reference. An `ssh://` URL without one is refused |

A mount that fails to clone degrades loudly: the agent starts without it.

```bash
hg workspace verify --profile <p>     # mounted rows, revisions, freshness, a real write probe
hg workspace doctor --deep
```

## Follow a branch

A reference repository with its own release channel, such as brand and company documents on
`main`, can follow a branch instead of a pin. The agent sees the branch's current files within
the refresh interval, and its pod does not restart when the branch moves.

```yaml
# harness-hg/workspaces.yaml
apiVersion: hermes.gitops/v1alpha2
kind: WorkspaceBindings
repositories:
  - name: vision
    source:
      url: https://github.com/you/vision.git
      revision: { mode: tracked, branch: main, refreshInterval: 30m }
      authSecretRef: vision-git
    mount:
      path: /workspaces/vision
      access: read-only
bindings:
  - repository: vision
    profiles: [marketing-manager]
    purpose: brand-context
```

| Behaviour | Detail |
|---|---|
| First checkout | The branch tip, when the pod starts |
| Refresh | Every `refreshInterval` (at least `5m`), fast-forward only, without a restart |
| Switch | Each commit is its own checkout, and the path switches in one step: a read never sees a mix of two commits |
| Refused | Rewritten history, or a checkout something modified. The agent keeps the last good files and the refresh counts as failed |
| Credential | Held by the refresh container. The agent's own container never sees it |
| Where | Standalone Eve agents. A bundled agent, or an agent on another harness, refuses a tracked repository |

### Freshness

Every refresh writes a stamp beside the workspaces, `.stamps/<name>.json` under
`EVE_WORKSPACES_ROOT`:

| Field | Meaning |
|---|---|
| `branch`, `sha` | The branch followed and the commit served now |
| `fetchedAt` | When the served commit arrived |
| `lastSuccessAt` | The last refresh that confirmed the served commit is still the branch tip |
| `consecutiveFailures`, `error` | Failed refreshes since the last success, and the last reason |

A tracked workspace is **stale** when its last successful refresh is older than twice its
interval. An agent that must not act on stale content reads the stamp before it relies on the
files.

- `hg workspace verify` shows the branch, the served commit, the last success and `STALE`, and
  fails on a stale workspace or on any failed refresh.
- The pod exports `hg_workspace_*` metrics. The `WorkspaceStale` alert fires when a tracked
  workspace is stale, or when the pod reports no freshness at all. It routes to the contact point
  of the agent's own monitoring app, `<namespace>-alerts`, so that app must be deployed in the
  agent's namespace. Without it the alert is not delivered. The operator can name another
  Grafana contact point in the environment's cluster values (`alerts.contactPoint`).

## In Nexus UI

Rows inside a card's repository badge, and in the Agents directory. Revisions may show.
Credentials never leave the cluster.

## Limits

A pinned mount does not move until someone edits the SHA. A branch-following mount records only
the commit it serves now, not which commit an agent read earlier, and reverting an installation
does not revert it: revert the branch. Changing a mount can need a one-time `--cascade=orphan`
step, covered in [Workspace bindings](../runbooks/workspace-bindings.md).

## The exact fields

[Environment workspaces](../reference/contracts/environment-workspaces.md).
