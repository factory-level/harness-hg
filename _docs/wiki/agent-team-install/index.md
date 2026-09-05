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
