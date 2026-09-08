# Reconcile multiple team repositories

An environment can watch more than one team repository. Each watcher keeps its own checkout,
history, retry state, timer, and status record. Their deployment cycles share one lock.

Declare extra watchers as named entries in the environment's `infra.reconcile.instances`
mapping. Each entry accepts the same configuration as the default watcher: `enabled`,
`repoUrl`, `branch`, `version`, `intervalSeconds`, `checks`, `apply`, `statusNamespace`, and
`kubeContext`. Supply each watcher's repository and host-owned check/apply commands explicitly.
Nested instances are not supported. Apply the environment configuration through your normal
operator deployment to install the timers.

Inspect or operate one named watcher:

```bash
hg reconcile status --instance inferops --json
hg reconcile sync --instance inferops
hg reconcile prove --instance inferops --json
```

Omitting `--instance` selects the original watcher. A busy shared lock skips the competing
tick; its next timer interval tries again. A failed revision stays blocked for that watcher
until its source changes or the operator runs `hg reconcile retry --instance inferops`.
Removing a watcher removes its timer while retaining its history and checkout.

Use the instance-specific CLI status and proof for named watchers. The existing Nexus
reconciliation card shows the default watcher.

**Proof:** each watcher's status reports the expected source revision as applied, its timer
is enabled, and its deployed workloads are healthy. An unavailable proof is not a pass.
