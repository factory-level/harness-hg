# harness/ — drivers for the platform-infra options

A harness is a **driver**: it packages how one agent runtime is built, launched, emitted
for, and reached — never a second control plane. Each harness directory owns (or explicitly
declares) its runtime image, its emitter path, its charts, and its gateway declaration
([#653](https://github.com/factory-level/harness-hg/issues/653)). Nothing outside
`harness/` imports harness internals; everything goes through the contract
(`agent-bundle-contracts/`).

| Harness | Status | Holds today |
|---|---|---|
| [`eve/`](eve/) | the agent runtime | `image/` (eve-runtime, built by `image/build.sh` at the `versions.json` pin) |
| [`hermes/`](hermes/) | **frozen legacy** — see its README | `identity/` (this repo's own Hermes-facing assets, was `.hermes/`) |
| `_startup-shim/` | arrives with [#681](https://github.com/factory-level/harness-hg/issues/681) | the container gating agent startup on readiness + config/secret gates |

Charts and the Eve emitter path join these directories in the chart-migration step of
[#652](https://github.com/factory-level/harness-hg/issues/652) and the emitter move of
[#681](https://github.com/factory-level/harness-hg/issues/681); until those land, the
charts live under `harness/<name>/charts/` and the emitter under `plugin/gitops_emitter/`.
