# Harness — as built

The `harness/` root as it actually stands: harnesses are drivers for the platform-infra
options, never a second control plane. The desired state is the `harness/` section of
[`../design/platform.md`](../design/platform.md); the diff is the gap list.

## What exists

- **`harness/eve/` — the agent runtime.** `charts/eve-agent` + `charts/eve-bundle` (moved here
  by [ADR 0160](../adr/0160-harness-chart-migration.md); homes enforced by the chart-boundary
  gate, class `harness`), and `image/` — the eve-runtime Dockerfile + `build.sh`, tagged
  `<runtimes.eve.imageRepository>:<runtimes.eve.version>` from `versions.json`
  (`ghcr.io/example/eve-runtime`; the ghcr name was never published).
  The boot script refuses a project whose resolved eve differs from the pin, and — when the
  record was rendered for a pinned runtime (ADR 0192) — refuses an image shipping an Eve other
  than `EXPECTED_EVE_VERSION` before it clones or installs anything. Each build writes a
  **build receipt** beside the stamp (`$STAMP_DIR/build-receipt.json`: source sha, overlay
  digest, build key, the project's and the image's Eve versions, runtime-manifest digest and
  build time), removed with the stamp so a failed rebuild leaves none, **rewritten on every boot**
  because the runtime-manifest digest follows configuration and moves without a rebuild (a
  receipt left describing the previous configuration would wedge the gate forever), and copied to
  `/dev/termination-log` so pod status carries it without new permissions. On the skip path the
  installed Eve version is read rather than asserted, so missing evidence stays missing. The
  backup routine protects it. The **startup probe execs
  `files/verify-build.mjs`** (both charts ship the same bytes): it compares every
  `HG_EXPECTED_*` the record pins against the receipt and only then checks
  `/eve/v1/health`, so a pod that built something else never becomes ready — an unset expectation
  is a field this deployment does not pin and is skipped. Liveness and readiness stay HTTP.
  The expected release is `runtimeImage.eveVersion`, falling back to a record's
  `runtimeImageTag`, then the image tag — so the local loop, whose image tag
  (`hermes-gitops-dev`) is a build name, states the release it ships
  (`localEveRuntimeImage` in `cli/src/platform/index.ts`) for both the agent and bundle charts.
  Desired versions ride the StatefulSet and pod template as
  `harness-hg.factorylevel.dev/{source-sha,eve-version}` labels and
  `{build-key,runtime-digest,overlay-digest}` annotations, never selectors; a bundle has no single
  source commit, so its members' desired values ride as `source-sha.<member>` and
  `runtime-digest.<member>` annotations (ADR 0195). `eve.envGuard` owns every gate variable, so a
  compiled overlay cannot disable a check or repoint the receipt. A **PostSync hook Job**
  (`templates/smoke-job.yaml`, `smoke.enabled` default true) runs `files/smoke.mjs` once per sync
  with its own namespaced ServiceAccount (pods and statefulsets, get/list — no kubectl in the
  image, no cluster-wide rights): the pod must run the StatefulSet's update revision, the receipt
  published through the build container's termination message must match the same expectations the
  startup gate uses, `/eve/v1/health` must answer, and `/eve/v1/info` must be 401 anonymously and
  200 under the minted credential, identifying as the runtime manifest's agent. Any failure fails
  the sync. `BeforeHookCreation,HookSucceeded` means a FAILED Job is what stays behind to read.
  The Job's pod deliberately does not carry the workload's labels: those are the Service's
  selector, and a smoke pod has no listener. The bundle runs one Job over every member
  (`HG_MEMBERS`, whose presence — not the member count — selects bundle mode, so a one-member
  bundle is still checked as one), carrying each member's full expectation set. Argo CD carries
  `controller.sync.timeout.seconds: "600"` so a wedged hook cannot hold a sync open forever;
  Argo counts it from the start of the operation, so it is a ceiling on a wedged sync, not a
  promise that any cold build fits — gated at twice the hook's own deadline
  (`infra/tests/argocd-sync-timeout.test.ts`), verified against the pinned chart. Gates: the
  `chart-test` goldens, `make eve-boot-test` (Docker: image, boot convergence, route contract,
  credential rotation), `cli/tests/versions.test.ts` pin parity.
- **Operator overlays in the build** (ADR 0194): when a record carries `spec.overlays`, the
  eve-agent chart gives the build container one line per overlay (`EVE_OVERLAYS`), the merged
  tree hash and their digest, plus a read-only credential mount per private overlay, and
  annotates the pod with `harness-hg.factorylevel.dev/overlay-digest`. `files/boot.sh` fetches
  every overlay at its commit from a validated credential-free URL (a failure stops the build,
  and a rebuild clears the stamp first) and `files/overlay-apply.mjs` -
  dependency-free Node in the boot ConfigMap, byte-identical in both charts - verifies each
  content hash, applies the entries in order (a tool removal writes Eve's `disableTool()` stub,
  an instructions append carries a provenance comment) and refuses a merged `agent/` tree whose
  hash differs. Hashes length-prefix every path and body; no symlink is followed on a source or
  target path, though checks and writes are separate pathname operations: a process that can
  change the agent tree during the build can still misdirect a write outside it. Overlay payloads
  never carry package files, `node_modules`, `.eve`, `.output` or `.git`.
  Skill-manifest ownership is enforced only when the caller passes
  the protected skill names, which the build container does not. The rebuild key becomes
  `sha256(spec.sha, digest)`, so an overlay-only change
  rebuilds; a record without overlays keeps `spec.sha` and does not rebuild. The bundle chart
  refuses overlays. Every agent rolls once when these boot files land. Gates: the
  `eve-overlays` golden with render assertions and negatives, `infra/scripts/overlay-apply.test.mjs`
  (`node --test`) and `infra/scripts/overlay-boot-test.sh` (the rendered `boot.sh` against local
  git: merge, digest parity, rebuild key, content-hash and fetch refusals), all run by
  `render-test.sh`. Nothing produces overlays yet (`hg team` has no overlay field, fetch or
  approval), and `make eve-boot-test` has no overlay leg, so `eve build` over a merged tree is
  unproven.
- **Tracked workspaces** ([ADR 0197](../adr/0197-branch-tracked-workspaces.md)): a standalone
  Eve agent's `spec.workspace.repositories[]` entry may carry `tracking: {branch,
  refreshInterval}` instead of `sha` (`environment-workspaces/v1alpha2`, compiled by
  `cli/src/workspace/bindings.ts`, which refuses one reaching a bundled member or a profile on
  another runtime). `eve.workspaceGuard` re-checks the branch rules and the 5m floor; the
  binding line becomes `name source branch access tracked <seconds>`, while pinned lines keep
  their four fields. `files/boot.sh` hands tracked lines to `files/workspace-sync.sh once`, which
  fetches the branch into a full-history mirror (`/app/workspaces/.revs/<name>/.mirror.git`),
  clones the tip as `.revs/<name>/<sha>` (hardlinked objects, `origin` removed, `chmod -R a-w`
  when read-only) and switches the `/app/workspaces/<name>` symlink with one `mv -T`; the
  target is inside the root, so a realpath containment check passes. A `workspace-sync`
  container on the agent's own image runs the same script as a loop (15 s tick, each binding
  when its interval has elapsed since the stamp's last attempt), holds the tracked bindings'
  credential mounts and starts `files/workspace-metrics.mjs` on port 9464; the pod carries
  `prometheus.io/*` annotations and `kubectl.kubernetes.io/default-container: eve-agent`, and
  `networkPolicy.enabled` admits the port. A live tree not at its recorded commit, a modified
  live tree, and a tip the live commit is not an ancestor of (unless the stamp names a different
  branch) are refresh failures: the live tree stays, `.stamps/<name>.json` counts
  `consecutiveFailures` and keeps the sanitized `error`, and the reason goes to stderr. Only a
  workspace with no tree gets `.stamps/<name>.unavailable`. The stamp's `branch` is the branch
  of the tree served, so a failed attempt on a newly declared branch does not turn that branch's
  first success into a rewrite refusal. A retained revision is served again only when it is still
  exactly its commit and unmodified, otherwise it is cloned afresh, and every success reconciles
  the served checkout's mode bits with the binding's access. Two revisions are kept
  (`.revs/<name>/.history`). `templates/workspace-alerts.yaml` provisions `WorkspaceStale` as a
  `grafana_alert` ConfigMap routed to `alerts.contactPoint`, which defaults (empty) to
  `<Release.Namespace>-alerts`, the contact point the monitoring chart provisions in that
  namespace, on `max(time() - hg_workspace_last_success_timestamp_seconds - 2 *
  hg_workspace_refresh_interval_seconds) > 0` in the agent's namespace, with
  `noDataState: Alerting`; the resolved receiver is never empty. The
  agent container's workspaces mount is `readOnly` whenever every binding is read-only (pinned
  agents included), and never carries a repository credential. The runtime manifest names
  `tracked:<branch>`, so a refresh moves neither `HG_RUNTIME_DIGEST` nor `checksum/record`.
  `hg workspace verify` reads the stamp and the pod's clock and fails on a failed or stale
  refresh. `eve-bundle` refuses a tracked repository in its guard. Gates: the
  `eve-workspace-tracked` golden with structural assertions, six guard negatives, the empty
  contact-point refusal and explicit opt-out, the bundle refusal, and
  `infra/scripts/workspace-sync-test.sh` (the rendered scripts against local git: first clone,
  switch, a reader of the previous revision, pruning, rewrite and modification refusals with
  recovery, the unavailable marker, metrics, the loop and TERM, unbind, pin and track again), all
  run by `render-test.sh`.
- **Eve at the Cloudflare edge** ([ADR 0156](../adr/0156-eve-shared-tunnel.md)): the eve-agent
  chart renders its plain Ingress under `providers.ingress: cloudflare` as well as `ingress`
  (`harness/eve/charts/eve-agent/templates/_helpers.tpl` `eve.ingressGuard`,
  `templates/ingress.yaml`), reached over the environment's one shared control-plane tunnel —
  no per-agent tunnel, no cloudflared sidecar. The gate is an **equality**, not a golden: the
  cloudflare render must come out byte-identical to the `ingress` render
  (`infra/scripts/render-test.sh`), which is what fails first if a per-agent Eve tunnel is ever
  built.
- **`harness/hermes/` — frozen legacy, and it says so.** `README.md` states the freeze (fixes
  only where a live environment breaks, no new features) and the three conditions that would
  unblock removal — a separate, later decision. It holds `charts/hermes-profile`,
  `charts/hermes-bundle`, `charts/hermes-endpoint`, and `identity/` (this repo's own
  Hermes-facing assets, was `.hermes/`: `skills/hermes-gitops-template`,
  `skills/higgsfield-brandkit`, `examples/`). The Hermes-native CLI groups (`hg cron`,
  `hg agent apply`) are tagged `harness-legacy` in the loop map and follow the
  freeze.
- **The harness contract** ([ADR 0162](../adr/0162-gateway-in-harness-contract.md)): every
  harness in the `DRIVERS` registry (`cli/src/harness/index.ts`) must carry
  `harness/<name>/harness.yaml`, validated against
  `agent-bundle-contracts/harness-declaration/v1alpha1` by
  `cli/src/harness/declaration.ts` `validateHarnessDeclarations()`, merged into `hg validate`'s
  findings. The gateway block is the point — the platform ships no universal gateway. Both
  declarations validate green: Eve is `status: active`, gateway `external-service` /
  `vercel-ai-gateway`; Hermes is `status: frozen-legacy`, gateway `native`. Negative fixtures
  (`invalid-missing-gateway.yaml`, …) prove the schema rejects.
- **The runtime drivers live in the emitter package**, not under `harness/`:
  `plugin/gitops_emitter/harness/hermes.py` (the side-effecting emit pipeline behind the
  `hermes profile install` hook) and `harness/eve.py` (`build_eve_record`, the pure Eve record
  builder). Eve has no install hook, so the **caller** emits:
  `python -m gitops_emitter.emit_cli` is run by the Pulumi `EveAgents` component
  (`infra/src/components/harness/eve-agent`) and by `hg` with `--render-only`. Both paths
  publish through the same `emitter.publish_record`, so the GitOps repository cannot tell the
  two runtimes apart.
- **On the factory environment**, four Eve twins are declared beside the live Hermes personas
  in `infra/Pulumi.factory.yaml` (`agents[]` entries `marketing-{manager,research,engagement,
  sre}-eve`, `runtime: eve`) — declared, not yet the running fleet (see defects).

## What does not exist yet

- `harness/_startup-shim/` — the container gating agent startup on readiness + config gates
  arrives with [#681](https://github.com/factory-level/harness-hg/issues/681), along with the
  emitter's move out of `plugin/gitops_emitter/`.
- Enforcement that runtime traffic actually flows through the declared gateway — the
  declaration is descriptive ([ADR 0162](../adr/0162-gateway-in-harness-contract.md) Cost);
  Eve's is covered by [#654](https://github.com/factory-level/harness-hg/issues/654)'s
  acceptance, Hermes's native path is taken on faith as frozen legacy.

## Known defects

- **No agent on the factory environment runs on Eve** (`maintainers/gaps.md`, "A second agent runtime
  deploys through the same loop"): Eve is proven on the local k3d loop and in Docker; the
  `dig`-templated ApplicationSet chart paths are sprig-proven only, never rendered by a live
  Argo CD.
- `harness/index.md`'s own status table is stale: it still says the charts live under
  `infra/charts/` "until #652 lands" — they are under `harness/{eve,hermes}/charts/` now and
  `infra/charts/` is deleted.
- **Tracked workspaces are proven against local git only.** No cluster has run the
  `workspace-sync` container, scraped its metrics or evaluated `WorkspaceStale`, and
  `make eve-boot-test` has no tracked leg. The rule names `<namespace>-alerts` by default,
  which exists only where the agent's monitoring app is deployed in the same namespace; Grafana
  refuses a rule whose contact point is missing, so an agent without that app gets no delivery
  unless `alerts.contactPoint` names one that exists, and no render or `hg` check catches it. A
  read-write tracked binding leaves the claim writable by the agent container, so the agent can
  alter its own stamp. A reader that resolved
  the workspace root before a switch and a file after it sees a path outside its root, and a
  pruned revision disappears under a reader still holding its path. `hg team status` and Nexus
  show no freshness, and the bindings record Nexus reads carries an empty `resolvedRevision` for
  a tracked binding.
- Gateway capability is deliberately non-uniform: what Eve's gateway offers (provider fallback,
  usage accounting) Hermes agents do not get — permanent until a harness changes its own
  declaration (ADR 0162 Cost, accepted).


Standalone Eve agent build init containers receive compiled `HERMES_CAP_*` values from
`spec.env`. Eve validates MCP connection URLs at build time;
previously these values existed only on the running agent, so a production-image probe could
pass while the Kubernetes init build failed. The build does not receive agent Secret envFrom
or unrelated runtime env overrides. The render regression checks both init and runtime URL
injection and confirms unrelated values and Secret references stay out of the build.
