# agent-team — an agent team

Authored against the Harness Hg contract (ADR 0178). The one rule of this tree:
**`harness-hg/` at any level is exactly what the platform reads.** Everything beside it
belongs to the harness (`src/`, the payload it installs) or to the team.

```
harness-hg/                      the TEAM: identity, destination, mounts (+ the files below when you need them)
agents/<harness>/<name>/
  harness-hg/                    the AGENT: agent.yaml, backup.yaml, test.yaml, dashboard.yaml (+ endpoints.yaml)
  src/                           the payload the harness builds and runs
evals/                           behaviour suite - never deployed
```

Added on top of the scaffold, so the demo exercises the loop end to end: `harness-hg/apps.yaml`
(the manager's test page), `harness-hg/bundles.yaml` (manager + research in one pod), and in
`agents/eve/manager/src/`: a `shout` subagent, a five-minute schedule, and eve evals beside the
platform's `evals/scenarios/`. Edit the page body in `apps.yaml` under `hg dev` to watch a
change converge.

Not scaffolded, because absent means honestly off - add one when you need it:

- `harness-hg/apps.yaml` - shared workloads (a board, a publisher): one chart each, with the agent that owns it - absent = none
- `harness-hg/bundles.yaml` - which agents share one pod (ADR-28) - absent = every agent standalone
- `harness-hg/communication.yaml` - ChatOps connection aliases + the durable transport - absent = no ChatOps, no queued routes
- `harness-hg/connections.yaml` - third-party app registrations (GitHub App) the team binds to - absent = none
- `harness-hg/capabilities.yaml` - capability -> provider bindings the team brings - absent = only peer endpoints provide
- `harness-hg/topology.yaml` - the layout the team is built for (regions, no cluster names) - absent = single
- `agents/<harness>/<name>/harness-hg/endpoints.yaml` - what the agent exposes and receives - absent = nothing

The loop:

```bash
hg validate --dir .          # the contract gate, every failure at once
hg topology plan --dir .     # the physical plan
hg topology emit --dir .     # records -> the destination (harness-hg/destination.yaml)
hg gitops doctor <dest>      # the destination verifies clean
```
