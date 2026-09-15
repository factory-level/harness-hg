# Agent Team Install

**What this page tells you:** what your repository must contain so the platform can install
it, and where the line runs between what you declare and what the platform decides.

Harness Hg installs **teams**, not single processes. One agent is the smallest team.
[Platform](../platform/index.md) is what Harness Hg supplies. This tab is what you supply.

## One rule

**`harness-hg/` at any level is exactly what the platform reads.** One at the repository root
for the team. One inside each `agents/<harness>/<name>/` for the agent, with the agent's
code in `src/` beside it. Everything else is yours.

```text
harness-hg/                      the TEAM: team.yaml, destination.yaml, workspaces.yaml, …
agents/eve/<name>/
  harness-hg/                    the AGENT: agent.yaml, backup.yaml, endpoints.yaml, …
  src/                           the npm project the harness builds and runs
evals/                           behaviour suite, never deployed
```

[Repository scaffolds](../reference/repo-scaffolds.md) prints the whole tree.

## Three words

| Term | Means |
|---|---|
| **Agent** | One declared agent: its persona, settings and needs. One agent becomes one running instance |
| **Bundle** | Several agents in one shared pod |
| **Agent application** | An agent plus everything it needs: workloads, endpoints, dashboards, backups |

The third is the one that matters. **You never deploy a lone agent.**

## The install path

```bash
hg bundle init ../my-team --agent my-team --gitops <url>   # scaffold
hg onboard ../my-team                                     # register it with the loop
hg validate                                               # every failure at once, no cluster
hg up                                                     # render the records, deploy
```

There is no install hook. `hg up`, `hg validate` and a hosted environment's reconciler all
run the same emitter. Once the record is in Git, the platform owns what happens next: it
compiles, reconciles, and shows the result in Nexus UI and the proof commands.

## Bundles

A bundle puts several agents in one pod. Right when they share a purpose and one failure
domain is acceptable. Wrong when one of them watches the others. **A bundled agent loses its
own Application, namespace and Service.** Anything addressing it by name has to read
`harness-hg/bundles.yaml`. No `bundles.yaml`, every agent is standalone.

## Who controls what, from your side

| You declare | You may override | You may request, not control | You cannot touch |
|---|---|---|---|
| What the agent is | Supporting workload values | Which secret values you get | Reconciliation |
| Which workloads come with it | Image tag, disk size | Where an endpoint is exposed | The tunnel |
| Which capabilities you need | Backup routine settings | When a backup runs | The observability baseline |
| Which secrets you need, by name | | Which layout the environment uses | The secret transport |

**An override tunes how your application runs. It cannot change what it is.** `topology`,
`endpoints` and `requires` are agent-owned and are refused in an override, with an
explanation.

## Pin a version

Pin the repository revision you install from, and pin every remote chart to an exact
version. A remote chart without a `version` is refused. A `repo: local` chart forbids one.

## Where to go next

- [Eve agents](eve-agents.md), what an agent on the default harness must contain
- [Declaring capabilities](declaring-capabilities.md), everything you can ask for
- [Use cases](use-cases/index.md), three real shapes of team

## Plan and apply a complete team

Use `hg-team-onboard` in the team source repository, then `hg-team-bootstrap` in the bootstrap
repository. Persist the installation plan there, including every team sharing the generated
GitOps destination. GitOps repairs go through the publisher; never commit them manually.

Pin versions with a version 2 plan. Each source names a tag or a commit, never a branch. Run
`hg team compile --plan installation.yaml --dir .` to record the exact commits in the
installation lock. Commit the plan and the lock together. The other team commands refuse a stale
lock, and refuse a tag that moved after you compiled. To roll back, revert that commit. Agent
data does not roll back.

Customize a team's agents without forking it. In the installation plan, add overlays to a
source or to one agent. An overlay adds, replaces or removes a skill, tool, connection, file or
the agent's instructions. Its content comes from a Git commit you pin. Run
`hg team overlays prepare` to stage what will change, review it, then record your decision with
`hg team overlays approve`. The team commands refuse overlays nobody approved, and any change to
the content needs a new approval. The build applies overlays before the agent is built and stops
if the content differs from what you approved. Overlays cannot add npm packages, replace the
agent definition or channels, or change skills the team repository locks.

Let a watcher publish for you. A reconcile watcher of `kind: team` on the bootstrap repository
runs `hg team resume --unattended` on every commit. It publishes what the lock names and stops,
as pending, on anything only you can decide: an approval, a pull request that needs review, an
activation, a write scenario you did not opt in with `unattended: true`. Approve or merge, and
the next attempt continues. A version 1 plan cannot be resumed unattended.

Agents that commit content to their own repository do not restart themselves. For each source,
`hg team` records a digest of what its agents are built from:

- each agent's source directory and its declarations;
- the files its code imports from elsewhere in the repository;
- the team's declarations and charts;
- the plan and the platform.

When a new commit leaves that digest unchanged, `hg team resume` records the commit as applied
and says why. Nothing rolls out, the pods keep the commit they run, and acceptance does not run
again. The agents see the new content through their tracked workspaces. Any change to an input
rolls out as before, and an input that cannot be read counts as changed. Agent code that reads a
file elsewhere in the repository must name it by a relative import or a relative path string;
otherwise a change to that file waits for the next change to an input.

Run `hg team plan --plan installation.yaml --dir .` to resolve source revisions and review the
actual destination diff. Run `hg team apply` with the same arguments to execute the declared
gates. `hg team resume` rechecks and continues an incomplete installation. An unknown or failing
stage keeps installation incomplete.

`hg team status` answers a different question: what the agents are **actually running**. It reads
the cluster — the Argo CD Application, the workload, the pod, the build receipt, the smoke check
and the watcher's published phase — and compares each against what the lock intends. It reports
the local stage ledger too, but never in place of the cluster. What it could not read is reported
as unknown with the reason, never as a pass; a missing build receipt means an agent nobody can
vouch for yet, not a broken one. A successful smoke check is still proven after its Job removes
itself, from the result Argo CD recorded for that sync. An installation nobody runs a watcher for
shows the watcher as not applicable rather than unknown. It exits `0` when everything is proven,
`1` when something differs, and `2` when something cannot be proven. It changes nothing and takes
no lock, so it is safe to run while an installation is mid-flight. See the
[team command reference](../reference/cli/team.md) for arguments and the bootstrap skill's
installation reference for plan fields.

With recorded `recover` authorization, Hg can add a first workspace claim to an existing
single-replica agent. It verifies Argo's desired manifest, preserves the healthy pod and bound
data claim, and orphans only the exact old controller for Argo to recreate. Existing claim
changes and other immutable migrations are refused. Readiness and live acceptance still run.
An older-source sync blocking that verified migration is terminated through an identity-tested
Argo operation update before the current-source sync proceeds.
When the recreated controller cannot add volumes to its adopted old pod, Hg gracefully
replaces only that recorded pod after checking the migration receipt and retained PVCs.
If Argo exhausted its retries before controller recreation, Hg requests a fresh sync of only
that StatefulSet at the verified revisions, with pruning disabled.

Nexus combines the default and named repository watcher records in its reconciliation status.
The reasons identify each watcher and its retry command. A failed or stale named watcher keeps
its state visible even when the default watcher is healthy.

When bootstrap changes the platform chart source, it retains access to the local-app chart
repository explicitly declared in existing cluster values. Existing application chart
configuration is preserved during this transition.
