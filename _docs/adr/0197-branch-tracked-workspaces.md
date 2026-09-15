# 0197 — Branch-tracked workspaces

**Status:** Accepted
**Changes:** `_docs/design/platform.md`
**Amends:** [ADR-75](CHANGES.md#adr-75) and [ADR-76](CHANGES.md#adr-76), for workspace bindings only

## Decision

A workspace repository's revision may be **tracked**: a branch, which is the release channel,
and a refresh interval of at least five minutes (`environment-workspaces/v1alpha2`). A tracked
workspace is refreshed inside the running pod. A refresh never passes through Git, Argo CD or a
pod restart.

- The build container clones the branch tip at boot, exactly where it clones a pinned workspace.
  A clone that fails leaves the `.unavailable` marker, and the agent starts without the
  workspace, loudly.
- A `workspace-sync` container, rendered only when a tracked binding exists, fetches the branch
  every interval. It fast-forwards only. Rewritten history, or a checkout that is modified or no
  longer at its recorded commit, is a refresh failure and never a convergence (ADR-76's
  refuse-unsafe-convergence rule, kept).
- Each revision is materialized as its own checkout under the workspaces root. The workspace
  path is a symlink, switched to a new checkout by one rename, so a reader sees the old tree or
  the new tree and never a mixture. The two newest revisions are kept and older ones pruned.
- The sync writes a freshness stamp per workspace: branch, commit, when that commit was fetched,
  the last successful refresh, consecutive failures and the last error. It serves the stamp as
  metrics. A `WorkspaceStale` Grafana rule fires when the last successful refresh is older than
  twice the interval, or when the agent reports no freshness at all. `hg workspace verify`
  reports branch, commit, last success and staleness, and fails on a failed or stale refresh.
- The workspace Git credential is mounted in the build and sync containers, never in the agent
  container. The agent container's workspaces mount is read-only whenever every binding is.
- Pinned and application-revision workspaces are unchanged. ADR 0190's installation lock still
  governs every source ref, runtime and chart revision; workspace content sits outside the lock.
- Bundled agents refuse tracked workspaces, in the compiler and in the bundle chart.

## Reason

The marketing agents read brand and company documents from a content repository whose release
channel is its `main` branch, and that branch receives bursts of commits, some from bots. With a
pinned SHA every edit waits for a pin bump, and every bump changes the rendered record and
restarts the pod. Those documents are reference material an agent reads, not code the platform
deploys, so the revision guarantees ADR-75, ADR-76 and ADR 0190 give deployed code are the wrong
tool for them. What matters is that the agent sees the branch's current files within a bounded
delay, and knows when it does not.

## Cost

- **Git no longer records which commit an agent read at a given time.** The stamp holds only the
  current commit. The history lives in the sync container's log and in whatever read telemetry
  the agent emits.
- **Rollback does not restore workspace content.** Reverting the installation lock leaves a
  tracked workspace at its branch tip; reverting content is a commit on the tracked branch.
- **A long-running container holds the workspace credential** for the pod's lifetime, not only
  during boot. It is mounted read-only in the sync container and used from a throwaway home per
  fetch, but a compromise of that container is a compromise of the key.
- **Old revisions and a full-history mirror occupy the workspaces claim.** Two checkouts plus
  the mirror must fit, and the fast-forward check needs full history, so a large repository
  costs claim space a pinned shallow need would not.
- **Bundled agents cannot track a branch.** A bundle mounts each workspace through a `subPath`,
  which pins the directory when the member container starts, so a switched symlink never reaches
  a member and pruning would empty its view. The compiler and the bundle chart refuse it; a
  bundled tracked workspace needs a different mount strategy.
- **A read that spans a switch can fail.** A reader that resolves the workspace root before the
  switch and a file after it sees a path outside the root it resolved; a containment check
  reports that as an escape. The read fails loudly and succeeds when retried.
- **The runtime manifest names `tracked:<branch>`, not a commit,** so its digest, the build
  receipt and the startup gate stay stable across refreshes. The live commit is only in the stamp.
- **Every Eve agent restarts once** when the new boot script and sync files land in the boot
  ConfigMap.
- **Alert delivery depends on the environment.** `WorkspaceStale` routes to the fleet contact
  point by default, which exists only where fleet alerting is configured.
- **`hg team status` and Nexus show no workspace freshness.** `team-status/v1alpha1` enumerates
  its fields, and a new one is a contract version this change does not take.
- **Only Eve agents can track a branch.** The Hermes charts are frozen legacy, and the compiler
  refuses a tracked binding to a profile whose record names another runtime.
