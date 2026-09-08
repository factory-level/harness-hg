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
  The boot script refuses a project whose resolved eve differs from the pin. Gates: the
  `chart-test` goldens, `make eve-boot-test` (Docker: image, boot convergence, route contract,
  credential rotation), `cli/tests/versions.test.ts` pin parity.
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
- Gateway capability is deliberately non-uniform: what Eve's gateway offers (provider fallback,
  usage accounting) Hermes agents do not get — permanent until a harness changes its own
  declaration (ADR 0162 Cost, accepted).
