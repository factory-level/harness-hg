# Agent Team Repo

**Outcome:** a repository of your own that declares an agent team, passes every gate with no
cluster, and emits its records into a destination repo with zero doctor findings.

This is the **agent-bundle loop**. It assumes [Install the tools](install-the-tools.md) is
done. Every step here reads declarations. No cluster is involved.

## 1. Scaffold

```bash
hg bundle init ../my-team --agent my-team --gitops https://github.com/<org>/my-team.gitops.git
```

[`hg bundle init`](../reference/cli/bundle.md) writes the team's `harness-hg/` folder
(`team.yaml`, `destination.yaml`, `workspaces.yaml`) and one Eve agent under
`agents/eve/my-team/` with its own `harness-hg/` beside its `src/`. It then proves its own
output passes `hg validate`. `--agents eve:manager,eve:research` scaffolds several agents.

Every file it leaves out is a feature that is off. The README it writes lists them.

## 2. Declare

Edit declarations. You name needs, never providers.

| File | What you put there |
|---|---|
| `agents/eve/<name>/harness-hg/agent.yaml` | What the agent needs. `envRequires` names secrets by name; values never enter Git |
| `agents/eve/<name>/harness-hg/endpoints.yaml` | What the agent exposes |
| `agents/eve/<name>/harness-hg/backup.yaml` | Its backup routine |
| `agents/eve/<name>/harness-hg/dashboard.yaml` | Its card in Nexus UI |
| `harness-hg/apps.yaml` | Supporting workloads the team runs |
| `harness-hg/workspaces.yaml` | Repositories the team mounts for its agents |

Field by field: [Declaring capabilities](../agent-team-install/declaring-capabilities.md).

## 3. Gate

Run the gates in order. Each one says what to fix. Rerun until clean.

```bash
hg validate --dir ../my-team          # the contract gate: every failure at once
hg topology plan --dir ../my-team     # the physical plan: instances, bindings, findings
hg observability inspect              # the workload inventory
hg nexus compile --source ../my-team  # the Nexus UI cards compile
hg workspace doctor --dir ../my-team  # workspace bindings are coherent
```

`hg topology doctor --dir ../my-team` also catches the classic mistakes: a copy-pasted
service URL, a dependency that only lives in prose.

## 4. Emit and prove the destination

The declarations become records in the destination repo `harness-hg/destination.yaml` names.
Seed the destination once, then emit into it:

```bash
GITOPS_REPO_URL=https://github.com/<org>/my-team.gitops.git \
HERMES_GITOPS_REPO_URL=https://github.com/factory-level/harness-hg \
CHART_REVISION=main \
  uv run python -m gitops_emitter.scaffold_cli   # seed the destination's managed files
git clone https://github.com/<org>/my-team.gitops.git ../my-team.gitops
hg topology emit --dir ../my-team --output ../my-team.gitops
hg gitops doctor ../my-team.gitops
```

[`hg gitops doctor`](../reference/cli/gitops.md) checks the destination end to end: the
ownership manifest, the generator set, and `deployments/` against the plan. What a
destination holds, and which parts are yours: [Repository scaffolds](../reference/repo-scaffolds.md).

## Proof

**Done when** `hg gitops doctor` reports **zero findings**. The repo now declares a
deployable team. Run it yourself with the [dev loop](dev-quickstart.md), or hand it to
whoever hosts an environment: [Host an environment](host-an-environment.md).
