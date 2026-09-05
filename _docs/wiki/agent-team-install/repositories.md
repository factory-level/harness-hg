# Repository mounts

**What this page tells you:** how an agent gets a Git repository as working context, and who
may grant one.

## What it means

A **repository mount** puts a Git checkout inside an agent's filesystem, pinned to a known
revision. The agent reads it as ordinary files: a codebase, a strategy document, the
operation's own source.

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
| Access | `read-only` or `read-write`. Read-only is the norm, enforced by mode bits |
| Revision | pinned, or tracked to another application's deployment |
| Credential | a Secret reference. An `ssh://` URL without one is refused |

A mount that fails to clone degrades loudly: the agent starts without it.

```bash
hg workspace verify --profile <p>     # mounted rows, resolved revisions, a real write probe
hg workspace doctor --deep
```

## In Nexus UI

Rows inside a card's repository badge, and in the Agents directory. Revisions may show.
Credentials never leave the cluster.

## Limits

A pinned mount does not move until someone edits the SHA. Changing a mount can need a
one-time `--cascade=orphan` step, covered in [Workspace bindings](../runbooks/workspace-bindings.md).

## The exact fields

[Environment workspaces](../reference/contracts/environment-workspaces.md).
