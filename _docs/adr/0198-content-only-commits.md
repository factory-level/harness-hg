# 0198 — Content-only commits roll nothing out

**Status:** Accepted
**Changes:** `_docs/design/cli.md`

## Decision

A team source commit that changes nothing an agent is built from is applied without a rollout
and without acceptance. `hg team` decides this, not the watcher.

- **Agent inputs.** For each source, at the commit its ref resolves to, `hg team` digests the
  Git objects of:
  - every tracked file under each agent's `subdir`, and each agent's sibling `harness-hg/`
    declaration directory;
  - the repository-root declaration trees `harness-hg/`, `environment/`, `dashboard/`,
    `topologies/`, `schemas/` and `charts/`, and any repository chart path the team's
    `harness-hg/apps.yaml` names;
  - every file outside the subdirectory that an input names by a relative module specifier or
    relative path literal (`import`, `export … from`, `import()`, `require()`,
    `new URL(…, import.meta.url)`, a `file:` dependency), followed transitively, plus symbolic
    link targets;
  - from every ancestor directory of an input, the files that change how it installs, builds or
    checks out (`package.json`, lockfiles, `tsconfig.json`, `.npmrc`, `.gitattributes`, …);
  - the plan with source refs left out, the lock with source commits left out, the bootstrap
    files the plan names (by content), and the platform identity: its commit, a digest of any
    uncommitted tracked change, and `versions.json`.

  A relative literal that names nothing widens the input to its nearest existing directory. A
  path that leaves the repository, a missing commit, or a platform that is not a Git checkout
  cannot be digested, and that source runs in full.
- **Record.** Whenever a run's publication stands, the installation ledger records per source
  (`applied`) the desired commit, the effective commit (what records, pod labels and
  `EVE_DIST_SHA` declare), the digest, the stage input and the credential fingerprint.
- **Carry.** In `hg team plan|apply|resume|publish`, a source whose digest equals its recorded
  one, and whose recorded effective commit is in the new commit's history, is carried. It
  compiles from the new tree, labelled with the effective commit, so anything the compiler reads
  that the digest missed still changes the projection fingerprint and therefore the stage input.
- **Skip.** `hg team resume` enters no stage when three things hold: the last run completed at
  exactly the recomputed stage input and credential fingerprint, and at least one source is
  carried. It records the new commit as applied with the reason
  `no agent input changed since <effective>` (ledger `skipped` and
  `applied.sources[].reason`), exits complete, and reports `effectiveSha` beside `appliedSha`.
  No preview, provisioning, publication, readiness wait, activation or acceptance runs. A resume
  with nothing carried keeps its old behaviour and re-verifies. `hg team apply` carries but
  never skips.
- **Report.** A reconcile watcher records the reason as the run's `note`, for both kinds.
  `hg team status` compares a build with the effective commit only when the ledger names exactly
  the locked commit.

## Reason

The social persona repository is both agent source and the content store its Eve agents commit
to. On 2026-09-14 the research chain made nine commits under `content/topics/` and
`content/angle-options/`. The factory watcher saw the desired commit differ from the applied one
and ran `hg team resume` for `3bb74578`. All four marketing pods restarted at 07:36Z because
their `source-sha` label changed, and the full acceptance set ran twice, at about $0.50 of model
spend per round. Drafting writes content all day, so every burst would restart agents mid-task
and pay for acceptance again. Content already reaches running agents through tracked workspaces
([ADR 0197](0197-branch-tracked-workspaces.md)), refreshed inside the pod without Git, Argo CD
or a restart. A rollout for a content commit delivers nothing.

The decision lives in `hg team` because every path to a rollout passes through it. The factory
watchers are `command`-kind watchers whose apply is `hg team resume`, a `team`-kind watcher
runs it unattended, and a person runs it by hand. A watcher knows only that a commit changed,
not what was built from it.

Two design choices keep the decision fail-closed:

- **A digest of reached inputs, not a list of ignored paths.** A new directory counts as input
  when an agent's code reaches it, not when someone remembers to exempt it.
- **Carrying the deployed commit rather than rewriting it.** The destination projection stays
  byte-identical, so Argo CD sees no change and no pod rolls. Compiling the new tree under the
  old label is the backstop for every compiler input the digest does not name.

## Cost

- **One full run after upgrade.** A ledger written before this change has no `applied` record,
  so the first commit afterwards runs in full, whatever it changed. `hg reconcile sync` right
  after the upgrade pays that run at a chosen time: acceptance runs once, and nothing rolls when
  the projection is unchanged.
- **The source is the unit.** A change to one agent still rolls every agent of its source,
  exactly as before.
- **The import scan is static.** A path assembled at run time from segments
  (`path.join(dir, "..", "lib")`) is not found. Agent code that reads repository files outside
  its subdirectory must name them by a relative specifier or literal, or a change to them is
  skipped until another input changes.
- **Any platform change counts.** The platform identity includes its commit and uncommitted
  tracked changes. After any platform commit, even documentation, the next source commit runs in
  full. A tracked file that keeps changing in the platform checkout, such as a stack file edited
  by `pulumi config set`, prevents skips while it changes.
- **A skip observes nothing.** Drift such as a deleted pod or an out-of-sync Application is no
  longer noticed as a side effect of content commits. A resume at a carried commit also skips,
  so re-verifying after a skip takes `hg team apply` (which carries but never skips) or
  `hg team status`.
- **A skip is cheap, not free.** It still resolves every source, validates skills, fetches
  overlays and renders every record (tens of seconds). It does not preview the destination.
- **The reason stays on the host.** The published reconciliation-status contract is unchanged:
  Nexus shows the desired commit as applied, but not why nothing rolled out.
- **Provenance names the effective commit.** Records, labels and the Nexus source set keep
  naming the effective commit, which can be older than the source head. Links go to that commit.
- **The ledger is per host.** A second host running the same installation without that ledger
  runs in full once.
- **An incomplete run still records.** After a run that published but did not complete, a
  content-only commit rolls nothing, but the unfinished stages still run on the next resume,
  acceptance included.
