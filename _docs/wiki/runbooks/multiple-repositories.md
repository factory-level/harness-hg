# Reconcile multiple team repositories

An environment can watch more than one team repository. Each watcher keeps its own checkout,
history, retry state, timer, and status record. Their deployment cycles share one lock.

Declare extra watchers as named entries in the environment's `infra.reconcile.instances`
mapping. Each entry accepts the same configuration as the default watcher: `enabled`,
`repoUrl`, `branch`, `version`, `intervalSeconds`, `checks`, `apply`, `statusNamespace`, and
`kubeContext`. Supply each watcher's repository and host-owned check/apply commands explicitly.
A watcher that resumes a team installation takes `kind: team` and `team: {plan: <path>}` in
place of `checks` and `apply`, and an optional `environmentFile` (a 0600 dotenv file on the host
carrying the plan's credential names). Nested instances are not supported.
Apply the environment configuration through your normal
operator deployment to install the timers.

Inspect or operate one named watcher:

```bash
hg reconcile status --instance inferops --json
hg reconcile sync --instance inferops
hg reconcile prove --instance inferops --json
```

Omitting `--instance` selects the original watcher. A busy shared lock skips the competing
tick; its next timer interval tries again. A failed revision stays blocked for that watcher
until its source changes or the operator runs `hg reconcile retry --instance inferops`. A team
watcher that is waiting on a person (an approval, a review, an activation) reports `pending`
with the reason; it is not blocked, and `hg reconcile sync` re-attempts it at once.
Removing a watcher removes its timer while retaining its history and checkout.

Use the instance-specific CLI status and proof for named watchers. The existing Nexus
reconciliation card shows the default watcher.

**Proof:** each watcher's status reports the expected source revision as applied, its timer
is enabled, and its deployed workloads are healthy. An unavailable proof is not a pass.

## Inferlab internal company team

Use `infra/environments/factory-inferops-prepare.py` to prepare the three `inferops-*` Eve
identities from HQ's encrypted Slack outputs. HQ owns all three apps and channels. The
proposal uses the existing shared factory GitOps destination and named `inferops` watcher,
preserving social-media. New agents remain inactive until explicit activation and live proofs.
See the source repository's `docs/agent-team.md` for role capabilities and rollout details.
## Compile the shared Nexus view

After every registered team's deployment records have converged, prepare clean checkouts at
the exact revisions in `profiles/<name>/profile.yaml`. Create a local JSON array with one entry
per repository:

```json
[
  {
    "id": "delivery",
    "repository": "github.com/example/delivery",
    "root": "/tmp/delivery-at-deployed-revision",
    "environment": "/path/to/operator/topology.yaml"
  }
]
```

Run from the platform checkout:

```bash
bun infra/environments/nexus-source-set.ts /path/to/environment.yaml /tmp/sources.json /path/to/gitops
hg gitops doctor /path/to/gitops
```

The operator environment's `infra.agents` is the active registry. The command refuses missing
repositories, dirty checkouts, mismatched revisions/runtime/source paths and duplicate component identities before
writing. It preserves all teams in one plan and records exact inputs in
`deployments/dashboard/sources.json`. Review and publish the GitOps diff through a PR.

Proof: verify the generated provenance against the deployed records, then open Nexus's Agents
view and inspect a card from each team. Confirm the expected namespace and observed health.
Source compilation alone does not prove workload activation or live channel delivery.
