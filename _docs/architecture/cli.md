# CLI — as built

`hg` as it actually stands. The desired state is [`../design/cli.md`](../design/cli.md) (the
three loops, front doors, grammar); the diff is the gap list.

## What exists

- **Workspace migration recovery**: `cli/src/team/recovery.ts` reads desired manifests through
  the Argo controller API and permits only an additive first-workspace claim. It orphans the
  UID/resourceVersion-matched StatefulSet while retaining the healthy pod and bound data PVC.
  Changed existing claims and unrelated immutable fields refuse recovery. Readiness also
  requires the owning Argo Application to be synchronized.
  If an older-source sync blocks the verified migration, Hg first sets its operation phase to
  Terminating with Application UID/resourceVersion and operation identity tests. The controller
  orphan operation waits for a later pass against a current-source sync.
  A subsequent gate gracefully replaces the recorded adopted old pod when Kubernetes refuses
  its changed volume list. It verifies the accepted migration receipt, desired manifest and
  retained PVC identities and owners. Unrelated healthy pods never qualify.
  If Argo exhausted retries before recreating the orphaned controller, Hg verifies the
  preserved pod/data and rendered manifest again, then requests a selective StatefulSet sync
  at exact observed Git revisions. The Application UID/resourceVersion are preconditions;
  pruning is disabled and unrelated resources are excluded.
- **Team installation coordinator**: `cli/src/team/` resolves all declared sources, checks
  runtime skill contents, compiles one complete projection and previews the destination diff
  before provisioning. `hg team apply` gates publication on production-image startup and
  records readiness, Slack transport, activation and deployed acceptance separately. Generated
  commits belong to the publisher, in disposable checkouts. Resumption uses an installation
  lock and private evidence ledger. Existing profiles cannot be silently dropped. Profile inventory considers directories,
  preserves sentinel files such as `.gitkeep`, and rejects symbolic links. Gates:
  `cli/tests/team.test.ts`, CLI typecheck, chart lint. Provider and cluster stages still need
  clean-install evidence; see the maintainers gap ledger.
- **Content-only commits** (ADR 0198): `cli/src/team/inputs.ts` digests each source's agent
  inputs from the source clone's Git objects (`git ls-tree -r`, `git cat-file --batch`).
  - **Inputs:** each agent's `subdir` and sibling `harness-hg/`; the root trees `harness-hg/`,
    `environment/`, `dashboard/`, `topologies/`, `schemas/` and `charts/`; repository chart
    paths named in `harness-hg/apps.yaml`; and the transitive closure of relative literals in
    `*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,json}` files and symbolic links. Also every ancestor's
    install and checkout manifests, the plan without source refs, the lock without source
    commits, the plan-named bootstrap files, and `platformIdentity()` (`git rev-parse HEAD`, a
    digest of `git diff --binary HEAD`, `versions.json`).
  - **Carry:** `carryForward` runs in `hg team plan|apply|resume|publish` right after
    `resolveSources`. It relabels a source with its recorded effective commit when the digest
    matches and `git merge-base --is-ancestor` holds.
  - **Skip:** `runOrSkip` skips the stage machine in `resume` when the prior ledger is complete
    at the same stage input, `applied.input` and credential fingerprint and something is
    carried. Otherwise it runs `executeStages` and records `applied` once `published` passes
    at this input. The destination preview is computed only when not skipping.
  - **Outputs:** the ledger gains `applied` and `skipped`, and the unattended report gains
    `effectiveSha`, `reason` and `skipped` (`reportedAppliedSha` calls the desired commit
    applied). The reconciler records `run.note` from `skippedNote` for both kinds.
    `desiredAgent` substitutes the effective commit only when the ledger names the locked commit.
  - **Defects:** the unit is the source, not the agent. The scan misses paths assembled from
    segments at run time. A skip still renders every record and fetches overlays. The note is
    not published. No live installation has run it yet.
  - **Gates:** `cli/tests/team-inputs.test.ts` (real temporary Git repositories covering
    content-only skip, repeated manual resume, subdir, transitive lib, declaration, chart, plan,
    platform and credential changes, and absent, corrupt or uncomputable digests; rewritten
    history; an incomplete run; a byte-identical projection) and `cli/tests/reconcile.test.ts`
    (the note, both kinds).
- **Credential gate** (ADR 0196, layer 1): `cli/src/team/credentials.ts` runs in `hg team
  plan|apply|resume|publish|compile` before any credential is read. It probes access and reports
  every failure together: the bootstrap backend derived from the environment spec named for the
  stack (`<bootstrap>/environments/<stack>.yaml` or `environments/*/environment.yaml`; an
  operator `PULUMI_BACKEND_URL` that differs, or no derivable backend, refuses before any
  Pulumi call), unreadable or malformed stack files, `pulumi stack ls` for the stack, a
  `gcloud` token check when Pulumi did not exercise Google credentials, and the kube context
  plus `auth can-i get secrets/<name>` per declared Secret. It then lists every missing value
  from the stack files without decrypting (`cli/src/env/stack-config.ts`): unfilled inputs,
  `<UNSET - see findings>` placeholders, and binding, source, overlay, runtime and app-value
  names with no source. After `compileResolved`, `assertRequirementsDelivered` refuses a
  required `envRequires` entry that is undelivered, empty plaintext, still a placeholder, or a
  secret missing from `agents[].environment` (`cli/src/team/delivery.ts` mirrors
  `availableSecretNames`). A refusal is a `CredentialGateError`: the `validated` ledger summary
  and, unattended, `report.findings` or `report.access` with exit 1. `cli/src/team/process.ts`
  classifies failed children (Google re-authentication, KMS denial, backend login, stack or
  config key missing, kube context missing, API unreachable, RBAC, Argo CD without its cluster
  config, Eve build validation, a failed `kubectl exec` into an agent) into a named cause and fix;
  any other failure surfaces its last meaningful stderr line (npm notices and credential-shaped
  text dropped, declared secret values scrubbed) instead of "repair the declared input".
  Every Pulumi call on the team path carries the derived backend. Defects: an encrypted empty
  value passes; `compile` does not read `credentials.inputs`; integration stacks are assumed to
  share the bootstrap backend. Gates: `cli/tests/team-credentials.test.ts`, `team.test.ts`,
  `reconcile.test.ts`, `env.test.ts`, and the parity test in `infra/tests/eve-agent.test.ts`.
- **Operator overlays in team installation** (ADR 0194): plan sources and agents declare
  `overlays[]` (`cli/src/team/plan.ts`: DNS ids, credential-free commit-pinned sources, private
  overlays with both a planning credential and a build Secret, skill capabilities with an
  acceptance scenario, `skillPolicy.approvals` required). `cli/src/team/overlays.ts` fetches each
  overlay with the skills fetcher, hashes and merges it into a copy of the source by importing
  the build container's `overlay-apply.mjs` (manifest-owned skill names passed as protected), and
  derives the approval fingerprint (entries, content hashes, skill capabilities; not the source
  commit) and the pod digest. `hg team overlays prepare` stages content, the merged `agent/` tree
  and `review.json` in a new directory outside every Git checkout (symlinks resolved);
  `hg team overlays approve` re-hashes the staged content and the staged merged tree and records a
  named human's decision in the source's approvals file (`recordApproval`, shared with skills).
  The approval binds the entries and content hashes; the merged tree is what the human reads.
  Overridden or removed local skills leave the merged runtime view, and a flat markdown skill
  overlay cannot require executables. `plan`,
  `apply`, `resume` and `publish` refuse unapproved overlays, run the runtime checks and the
  production-image startup on the merged tree, pass `--overlays-file` to the emitter, and
  readiness requires the running template's overlay digest to equal the approved one. Gate:
  `cli/tests/team-overlays.test.ts` (including the production emitter). Not proven against a live
  cluster, and no `eve build` over a merged tree runs outside the production-startup preflight.
- **Pinned installation revisions** (ADR 0190): a version 2 plan pins each source to
  `refs/tags/<tag>` or a full commit and names a bootstrap-relative installation lock.
  `hg team compile` resolves every ref and writes the lock (`cli/src/team/lock.ts`: plan digest
  plus `ref` and `commit` per source, deterministic bytes, written through an exclusively
  created temporary file; tag names follow git's ref-name rules). `plan`, `apply`, `resume` and
  `publish` refuse a missing or stale lock (changed plan, different sources or refs) and a tag
  that now resolves to a different commit; the lock joins the stage-evidence input, so a
  version 1 installation's evidence is unchanged. An owner's app chart revision is its locked
  source commit, and version 2 refuses a separately declared one. Version 1 plans are still
  accepted everywhere (`apply`, `resume` and `publish` only warn), and the lock records no
  platform revision. Gate: `cli/tests/team-lock.test.ts` (including a real local repository
  whose tag is moved).
- **Per-agent runtime pins** (ADR 0192): a version 2 plan may give one agent
  `runtime: {image, eveVersion}`. `assertAllowedRuntimes` (`cli/src/team/runtime.ts`) refuses any
  pair absent from `versions.json` `runtimes.eve.allowed` once per command, before anything
  resolves, renders or locks; `effectiveRuntime` then resolves pin-or-default everywhere the
  installation default was read — the emitter's `--expect-eve-version`, the production startup
  container and its `HG_EXPECT_EVE`, the source lockfile check, the readiness image comparison,
  the unattended report (`pinned: true`) and the rendered `runtimeImage`. The lock is **version 2**
  and records the effective image and Eve release for every agent; `verifyLock` refuses one whose
  runtimes differ from the plan. A version 1 lock still verifies an unpinned plan (with a recompile
  warning) and is refused only for a plan that pins, so upgrading the CLI never stops an existing
  installation. Recovery resolves the workload's own image (`workloadRuntimeImage`), so a canary
  stays recoverable. A pinned agent renders
  `runtimeImage.eveVersion`, which the chart passes to the build container as
  `EXPECTED_EVE_VERSION`; an unpinned one renders exactly as before. **The shipped allowed list is
  empty**, so no agent can pin until the platform publishes and records a second runtime, and
  promotion is editing the default and deleting the pin. Gates: `cli/tests/team-lock.test.ts`
  (allowed-pair refusals, lock coverage), `cli/tests/team.test.ts` (one agent canaried, its
  neighbour byte-identical), `cli/tests/versions.test.ts` (every allowed entry digest-pinned),
  `infra/scripts/render-test.sh` (the variable reaches the build container only), and
  `make eve-boot-test` (Docker: a mismatched image refuses before any clone).
- **The platform revision an installation runs** (ADR 0193): a version 2 plan may declare
  `platform: {repository, ref, credentialEnv?}` (credential-free URL, tag or commit, never a
  branch; a token reference requires an HTTPS GitHub URL). A platform revision requires
  `credentials.configFile` — provisioning carries the revision through the encrypted bootstrap
  baseline, and without one it would silently never reach the cluster, so the plan is refused;
  `hg team compile` resolves it into the lock as `platform{ref, revision, previousRevision?}`,
  where `previousRevision` is the revision the lock replaced — what a rollback returns to.
  `bootstrapConfig` (`cli/src/team/providers.ts`) then sets `hermesGitopsRepoUrl` and
  `chartRevision` from the lock before every `pulumi preview`/`up`, so the compiler that
  publishes and the charts Argo CD syncs are the same revision. The team watcher materializes
  that revision as a detached worktree from one bare clone under
  `$HG_HOME/reconcile[/instances/<n>]/platform.git`, runs `bun install --frozen-lockfile` in its
  `cli` and `infra` workspaces once per revision, and execs **that** checkout's
  `cli/src/main.ts team resume`; worktrees the lock no longer names are pruned after a clean
  tick, so a host keeps one checkout per revision in use. The watcher reads the plan and lock by
  reading only the fields it needs (`planLockFile`, `planPlatform`, `lockPlatformRevisions`) with
  the same YAML parser the rest of the system uses, so a launcher at an older revision understands
  a newer plan and can never disagree with it about whether a platform is declared. The plan and
  lock are resolved through `checkoutFile`, which refuses an absolute path, a `..` segment or any
  symlink before anything decides which code runs. A worktree is used only when a
  `.hg-platform-ready` stamp names its revision — written after both installs succeed, so a run
  killed midway rebuilds instead of executing a half-installed checkout — and only after the
  checkout is verified detached at that revision with a clean tree. A bare clone whose `origin`
  no longer matches the plan is re-pointed and re-verified. Pruning runs on every tick whose keep
  set is known, whatever the resume did, so retention follows the lock, not success. A plan
  without `platform`, or a lock without one, keeps running the installed hg. Not built: the
  emitter still seeds the bootstrap files that name the platform revision rather than managing
  them, and nothing yet
  refuses a branch revision in the Pulumi program, so `hg gitops doctor` cannot report a
  destination whose platform-sourced Applications disagree. Gates:
  `cli/tests/team-lock.test.ts` (resolution, `previousRevision` across a move and a rollback,
  document strictness), `cli/tests/reconcile.test.ts` (a real bare platform repository: the
  worktree IS the hg that resumes, reuse, a moved revision, pruning, an absent revision, a lock
  whose revision no plan attributes).
- **Live installation status** (ADR 0195): `hg team status` observes the cluster instead of
  replaying the operator-local ledger. `cli/src/team/health.ts` splits observation from judgement:
  `observeAgent` reads the Argo CD Application, the StatefulSet, the owned pod (including the build
  receipt the init container published through its termination message) and the smoke hook Job with
  read-only `kubectl get` in the plan's own context, never throwing — anything unreadable
  becomes a recorded problem; `observeWatcher` finds the reconciliation-status ConfigMap for this
  installation by label, cluster-wide, so status need not know the control-plane namespace; and the
  pure `classifyAgent` compares each field against what the **lock** intends (never the ledger),
  and only after `verifyLock` proves that lock describes this plan — an unverified one would let a
  stale deployment pass. A pass requires evidence actually read: the pod must be owned by the
  StatefulSet that was read (matched by UID, unambiguous, not terminating), readiness needs both
  revisions, "declares no overlays" needs the workload and the receipt, and the image is compared
  by the digest the pod reports running (`containerStatuses[].imageID`), falling back to the spec
  image only when a digest is missing. A smoke result counts when a live hook Job's own
  `source-sha` label is this sync's and its condition is terminal; once the Job has deleted itself
  on success, the hook result Argo CD recorded on the Application (`operationState.syncResult`)
  counts instead, but only when that operation synced exactly the revisions the Application is
  synced to now. The watcher document must identify itself as a `ReconciliationStatus` (a
  ConfigMap is hand-editable), with the newest of several publishers winning and a tie
  withholding the phase; a lookup that succeeds and finds none makes the watcher
  `not-applicable`, left out of the verdict, while a lookup that fails stays `unknown`.
  Columns: ARGO, READY, SOURCE, OVERLAY, EVE, IMAGE, SMOKE, WATCHER. Every non-pass carries its
  reason, and evidence that could not be read is `unknown` — a missing receipt, a hook result from
  an earlier sync or a lock that records nothing to compare against are never passes and never
  failures. Exit 0 all pass, 1 anything failed, 2 unknown-only. `--json` emits
  `team-status/v1alpha1` beside the ledger. Status never recovers and never takes the installation
  lock, so it is safe while a resume is in flight. Not built: `--prove`, which would add the live
  runtime-version and configuration-drift legs from `hg agent prove`. Gates:
  `cli/tests/team-status.test.ts` (the classifier per field, exec-stubbed observation asserted
  read-only, the watcher match, the rendered table), the contract's own fixtures, and
  `cli/e2e-local.sh` steps 13 and 14 against a k3d cluster.
- **What steps 13 and 14 prove, and what they do not** (`cli/e2e-local.sh`, on a real Eve agent,
  the `greeter` example): against a real cluster with Argo CD, step 13's `kind: team` watcher
  refuses a plan whose credential names are absent (naming only the names, and still naming its
  installation), materializes the locked platform revision as a real worktree and runs *that*
  checkout's `hg` (the ledger records that revision's own exit code and output), blocks the failing
  resume while scrubbing the credential it echoes from the ledger, the host log and the published
  status, keeps the replaced revision's checkout when the lock moves, and publishes a labelled
  `v1alpha2` status document into the cluster. Step 14 runs `hg team status` against the running
  agent: it proves every field — the receipt the pod wrote, the image digest the pod runs, the
  smoke hook result Argo CD recorded — and exits 0; after the source moves without the lock it
  exits 1 naming both commits; re-locked it exits 0; after the content is rolled back (a new
  commit carrying the pre-drift tree) the agent rebuilds and it exits 0 again. What they do not
  prove: a real `hg team resume` publishing through a pull request (the publisher calls the
  GitHub API, so step 14 sets the lock's commit directly and moves the source through the local
  loop), and drift, self-heal or decommission against a cluster.
- **The team watcher** (ADR 0191): `hg team resume --unattended` (version 2 plans only) exits
  `0` complete, `75` pending, `1` failed, and prints one JSON document with a `report`
  (installation, stage, pending reason and link, per-source and per-agent desired and declared
  revisions, readiness). Pending is any stage that halted on `unknown`: a missing skill or
  overlay approval (`ApprovalRequired`, raised by `requireApproval`), a publication whose PR
  awaits review or a check (`merged: false` or a 405 from the forge), a missing authorization
  or signing-secret reference, an activation gate not already enabled (checked before
  provisioning too, since a committed baseline carries gates through `pulumi up`), a write
  acceptance scenario without `unattended: true`, or convergence still in flight. An unknown
  that names no reason exits 1, and an acceptance scenario that ran and did not pass is `fail`.
  Unattended, nothing approves, merges, flips a gate or runs an un-opted write scenario. The
  parent forwards the child's stdout and writes a minimal report itself when the child wrote
  none (a held lock, a preflight failure). A reconciler of `kind: team`
  (`cli/src/reconcile/index.ts`; environment `infra.reconcile[.instances.<n>]` with `team.plan`
  and an optional 0600 `environmentFile` the unit loads) checks out the bootstrap commit,
  refuses the tick (naming the missing NAMES only) when the plan's credential environment is
  not covered by bootstrap inputs, Secret inputs, integration outputs, the environment file or
  the service environment, runs `bun install --frozen-lockfile` in the plan's bootstrap
  directory and the installed hg's resume; exit 75 becomes ledger state `pending` with capped
  exponential backoff (120 s doubling to 30 min), re-attempted early by `hg reconcile sync` and
  cleared by a new commit, never a blocked sha (a retry that turns pending drops the block, and
  a pending wait on an already applied commit is still re-attempted). The host log and the
  stored report are scrubbed with the environment file's values. The published record is
  `runtime-overlay/v1alpha2/reconciliation-status` with a `harness-hg.factorylevel.dev/phase`
  label; command-kind watchers keep v1alpha1 and Nexus reads both, rendering pending as
  degraded with its reason, link and next attempt. `hg reconcile prove` RECON009 audits a
  pending wait (reason present, bounded, gate holding). Not built: the watcher still runs the
  installed hg (the platform revision is not yet locked, ADR 0193) and no live watcher has run
  this path. Gates: `cli/tests/reconcile.test.ts` (team ticks against a real bare repository
  with a stubbed resume), `cli/tests/team.test.ts`, `infra/tests/config.test.ts`,
  `plugin/tests/test_nexus_plugin_api.py`, the v1alpha2 fixtures.

- **Installable authoring guidance**: `skills/hg-team-onboard/` configures arbitrary Eve team
  compositions through a repo-aware user survey and the existing scaffold and contracts.
  Survey answers and configuration decisions persist in the target's team document for
  revisions and resumed onboarding. Its references cover additive
  onboarding, per-agent skills.sh packages, runtime capability requirements, and source/build
  validation. `skills/hg-loops/` routes team authoring to it. This is coding-agent guidance,
  not another CLI command or an automated integration provisioner; generated teams require
  their own validation evidence and runtime evaluations.
- **Named repository reconciliation** (ADR 0182): `hg reconcile --instance <name>` selects
  isolated state under `reconcile/instances/<name>`, named systemd units, and a named status
  ConfigMap. The default instance keeps its existing paths. All instances share the original
  `reconcile/lock`, so their check/apply cycles cannot race on one environment. The factory
  stack can declare additional watchers through `reconcile.instances`; each retains its own
  failure/retry and crash-recovery history. CLI reconciliation tests cover independent ticks
  and shared-lock behavior; infra configuration tests cover invalid and nested instances.
  Named watcher status is inspected through the CLI and Nexus reconciliation reasons. Nexus
  combines labelled watcher ConfigMaps and surfaces the worst observed state, including stale
  named sources; retry instructions name the corresponding instance.

- **The manifest everything derives from**: `cli/src/commands.ts` holds every command,
  subcommand, and flag as data, and three consumers render it — `main.ts` (now ~1.2k lines, the
  dispatch only) derives `VALUE_FLAGS`/`JSON_COMMANDS` and its usage output, so an undocumented
  value flag fails to *parse*; `infra/scripts/generate-cli-docs.py` renders
  `_docs/wiki/reference/cli/` and cross-checks the dispatch switch in both directions
  (`make cli-docs`, `cli-docs-drift` in `make test`); `hg help <command>` renders one command's
  detail.
- **One directory per subject** (#657): `cli/src/` holds `agent/`, `auth/`, `backup/`,
  `communication/`, `connection/`, `cron/`, `dash/`, `debug/`, `edge/`, `eval/`,
  `eve/`, `gitops/`, `grafana/`, `harness/`, `launch/`, `local/`, `nexus/`, `observability/`,
  `platform/`, `reconcile/`, `server/`, `topology/`, `validate/`, `workspace/`, plus the shared
  `commands.ts`, `proof.ts`, `lib.ts`, `main.ts`.
- **The grammar is data and it is enforced** ([ADR 0161](../adr/0161-cli-grammar.md)): the
  `VERBS` register in `commands.ts` pins one meaning per verb (a sub's verb is the last word of
  its name), `loops:` tags every command with its journeys, and both are enforced bidirectionally
  by `cli/tests/commands-grammar.test.ts` plus the cli-docs coverage check. The kill list is
  executed: no `bundle` command and no `dash load` exist in the manifest. The three renames
  (`event publish`, `chatops tail`, `platform backup prove`) are canonical-only — the warning
  aliases were deleted by [#672](https://github.com/factory-level/harness-hg/issues/672) and
  `make retired-paths` keeps them dead. ADR 0177 hard-renamed `hg eve prove|evals` to
  `hg agent prove|evals` (no alias, by decision), made `cron` engine-neutral (Hermes
  depth, honest refusals on Eve), added `hg harness list`, and renamed `--hermes-home` to
  `--harness-home` (the stored `hermesHome` config key is still read); `hg launch prove` now
  registers the `agent` subject for any non-empty fleet — previously a Hermes-only fleet's
  agent runtime was proven by nothing.
- **The prove convention**: every `prove` verb returns a `ProofResult` (`cli/src/proof.ts`) —
  numbered findings, each `pass | fail | unknown`, and **unknown is never a pass**.
  `hg launch prove` (`cli/src/launch/prove.ts` `proveLaunch()`) aggregates every subject's
  matrix and adds no checks of its own; a subject that cannot run reports `LAUNCH001 unknown`,
  not a pass.
- **The loop front doors, as they stand today**: `hg dev` exists and anchors the dev loop
  (`onboard → up → dev → validate/test/eval → logs/prompt/debug/dash → down/reset`,
  walkable from step ②). `hg env` is now the ENVIRONMENT subject (#674): `plan/apply/import`
  over `infra/environments/<name>.yaml`, generating both stacks' `Pulumi.<name>.yaml`
  projections (drift gated in `make test`); the profile dotenv group moved to `hg envfile`.
  **`hg env new` exists** (#676): preflight (ENV001..ENV006, ProofResult shape, the
  root-of-trust probes riding the same ADC credential pulumi uses) then six probe-idempotent
  steps — state stack init'd in the root backend with the assembled `gcpkms://` provider,
  config generated, `pulumi up`, then the infra stack in its own backend impersonating the
  deploy SA, config + up — each narrating the exact command (env prefixes included;
  `--dry-run` prints the whole hand-executable sequence). Failure names the step; re-run
  resumes by probe. **`hg bundle init` exists** (#673, ADR 0172, ADR 0178): scaffolds a TEAM in
  the agent-team tree (`cli/src/agent-bundle/`, templates in-dir) — `harness-hg/{team,
  destination,workspaces}.yaml`, per Eve agent (`--agent`, or `--agents eve:a,eve:b`)
  `agents/eve/<name>/harness-hg/{agent,backup,test,dashboard}.yaml` + `src/`, `evals/suite.yaml`,
  a README listing every omitted `harness-hg/*.yaml` — omits bundles/apps/communication/
  connections/capabilities/topology/endpoints (absent = honestly off), refuses `hermes:<x>` with
  a copy-from-`examples/` pointer, generates the `npm ci` lockfile, and proves its own output with
  `hg validate --dir` before printing the loop. `examples/agent-team/` is exactly its output for
  two Eve agents and rides `make e2e-offline`; `eve-agent`, `communication-plane` and
  `distributed-profile` stay on the legacy layout as the dual-reader regression guard. `hg --help` leads with the three doors
  (manifest `frontDoor` markers; the docs index derives the same list).
- **The executable walkthroughs** ([ADR 0170](../adr/0170-loop-walkthroughs-executable.md)):
  `cli/loops/{dev,agent-bundle,ops}-loop.sh` run the three loops as real `hg` invocations with
  asserted outcomes, fronted by `make loop-dev` (= `make e2e`, the 12-step `cli/e2e-local.sh`
  chain on a throwaway k3d cluster), `make loop-agent-bundle` (cluster-free, rides `make test`
  via e2e-offline), and `make loop-ops` (the live environment). The scripts, not the design
  prose, are the acceptance surface.
- **The Phase-4 proof surface**:
  - `hg validate --dir <repo>` — the one-shot no-cluster contract gate over a single repo
    (`commands.ts` `validate`), used by e2e-offline over every reference authoring, including
    the leg that must fail.
  - `infra/scripts/e2e-offline.sh` (#669, in `make test`) — source → emit → destination
    with no docker and no network: validate the examples (clean pass + `distributed-profile` FAILS),
    compile the persona checkout, seed a token-less `file://` destination and `hg topology
    emit` into it, `hg gitops doctor` to zero findings, `hg nexus validate`, then the persona
    repo's own `evals/topology-check.sh` against this checkout's `hg` — the cross-repo loop no
    CI runs anywhere. Persona legs skip loudly when the sibling checkout is absent.
  - `infra/scripts/record-cmp.sh <ref-a> <ref-b>` (`make record-cmp`) — deployment-neutrality
    as a command: renders every persona profile's record from two git refs of this repo and
    byte-compares; a non-identical record is enumerated with a diff.
- **The test surface**: ~40 bun suites in `cli/tests/` (`cd cli && bun run typecheck && bun
  test`), including the bidirectional nets `main-flags.test.ts` and `commands-grammar.test.ts`,
  the versions pin sweep, and per-subject suites.

## What does not exist yet

The loop-quickstart docs
([#675](https://github.com/factory-level/harness-hg/issues/675)); the Nexus plugin-id and
control-plane chart-name renames ([#745](https://github.com/factory-level/harness-hg/issues/745),
blocked on fleet convergence #703).

## Known defects

- **`hg auth prove`, `hg grafana prove`, and (by aggregation) `hg launch prove` are
  local-loop-shaped** ([#740](https://github.com/factory-level/harness-hg/issues/740)): they
  assume k3d naming and kubeconfig writes a real environment does not have. `ops-loop.sh` skips
  them against a non-local context with a stated reason, never silently — three of the eight
  ops SOP steps assert nothing against a real environment today.
- **CI is manually disabled repo-wide** (`.github/workflows/DISABLED.md`,
  [#737](https://github.com/factory-level/harness-hg/issues/737)): the cli/infra/state bun
  suites and the nightly `loop-dev` run only when a developer runs them. `make test` reaches
  the CLI end-to-end via `e2e-offline` but none of the unit suites — a green `make test` after
  a `cli/` change is necessary, not sufficient.

The `env-drift` build gate compares environment specifications with their generated stack files
without requiring deployment credentials. Public examples retain unset secret placeholders.
`hg env plan` and `hg env apply` separately reject missing credentials, including when the
projection itself matches; `hg env apply` and `hg env new` then write no stack file at all, so
the placeholder never reaches a stack through them (ADR 0196). The team watcher refuses a stack
file that still holds one. The gate uses the same generator and never writes stack files.

Reconciler command replacement uninstalls the old systemd units before installing the new
generation because both own the same paths. Replacement cannot erase the replacement timer.
Nexus treats configured telemetry as current, distinguishes unconfigured sources from stale
ones, and labels failed HTTP refreshes separately from outdated source reports.
# Per-agent startup credentials

Team installation agents can map runtime environment names to distinct operator environment
references using `environmentBindings`. Production startup checks apply those mappings per
container and include the referenced inputs in credential fingerprints and diagnostic scrubbing.
This prevents shared names such as SLACK_BOT_TOKEN from selecting another agent's credential.

Bootstrap `credentials.inputs` resolves existing encrypted configuration through `pulumi config
get` into named process inputs before source resolution. Values remain in memory; repeated
references share one lookup. This also supplies credentials to named reconciliation processes.
Projection refusal diagnostics include the observed revision so adoption can be reviewed through
Hg without manually inspecting the generated repository.

For credentials delivered by existing providers directly to Kubernetes, `credentials.secretInputs`
names the namespace, Secret and key. The loader reads only named Secrets in the plan's context,
caches each response for the invocation and decodes selected values into named process inputs.

Team application value bindings replace explicit secret markers from managed input names
without mutating the plan. The emitter accepts `--app-values -` over stdin and preview diffs
withhold credential-bearing profile sections, including prior values. Legacy chart literal-value behavior remains; no secret-store
migration is implied. Dashboard source provenance retains the versioned object envelope.

Production startup validation mounts a read-only checkout of the complete source repository,
copies it into disposable container storage, and builds in the declared agent subdirectory.
This retains sibling/shared modules exactly as deployed; host checkouts outside that source
are not mounted. The project path travels as a quoted environment value.

Argo core-mode desired-manifest reads use a mode-0600 temporary kubeconfig inside the controller,
referencing its mounted service-account token and CA. The wrapper removes the file on exit;
no token bytes are copied and no additional RBAC is granted. This supports uncached rendering
at exact source revisions as well as cached manifest reads.

The factory workshop baseline acceptance probes distinguish successful `turn.completed` from
session completion: Eve can park a successful turn in `waiting` for the next user message.
A failed session or a response without an explicit successful-turn event does not pass.

Scaffold repository allowlists include the platformRepo.url declared in preserved cluster
values as well as the current scaffold platform source. Both emitter and CLI paths validate
and deduplicate this URL, so a source transition does not disable existing local-app sync.

Bootstrap's scaffold command tracks the installed plugin revision in its Pulumi triggers,
matching stage-1 installation. Emitter/template source updates rerun hash-owned scaffold
reconciliation even when environment configuration is unchanged.
