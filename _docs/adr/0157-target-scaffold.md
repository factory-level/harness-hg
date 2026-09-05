# ADR 0157 — The target scaffold

2026-08-25 · executes [#648](https://github.com/factory-level/harness-hg/issues/648), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646). First ADR
under the per-file convention; `CHANGES.md` is the frozen pre-reorg ledger (0156 is reserved
for the Eve shared-tunnel decision riding the unmerged `feat/eve-agents-stack-config` branch).

## Decision

The repository converges on this top-level tree. The README's scaffold block is the
authoritative outline; this ADR binds it, places what the README left unplaced, and states
the migration map the phase-1/2 moves execute from.

```
_docs/                      adr/ + design/ + architecture/ + wiki/          (already done)
.harness-hg/                the agent bundle for testing (Eve-based) — and the convention:
                            every agent-bundle repo carries a .harness-hg/ dir holding its
                            destination config (succeeds the retired .hermes-dist format)
agent-bundle-contracts/     frozen versioned schemas + topology contracts + event envelope
bootstrap/state-bucket-kms/ state bucket + KMS keys for Pulumi state       (today's state/)
bootstrap/platform-infra/   the Pulumi for Kubernetes + gitops-template + the emitter,
                            which moves INTO the Pulumi code; a shim gates agent launch
control-plane/              one directory per platform-owned component, each owning its
                            chart and signals: grafana/ prometheus/ alertmanager/ loki/
                            event-router/ alert-router/ nexus/ wiki/ argocd/
                            external-secrets/ dex-sso/ tunnel/
cli/                        hg — one directory per subject; cli/test-env/ launches the
                            platform + Nexus into an ephemeral test environment and homes
                            the test-fixture workloads
harness/_startup-shim/      shim container gating agent startup on readiness + config gates
harness/eve/                Docker, filesystem, emitter path, chart, gateway declaration
harness/hermes/             frozen legacy — works, gains nothing
harness/index.md            harnesses are drivers for the platform-infra options
landing/                    the promotional landing page + devlog
nexus-ui/                   the rebuilt (Astryx) frontend
examples/                   reference authorings + the negative invalid-* proof fixtures
maintainers/                the unpublished honesty ledgers
```

Two placements decided 2026-08-25 that the filed issues predate (bodies amended):

- The frozen contracts root is **`agent-bundle-contracts/`**, not `contracts/` — the name
  says who the contracts serve: the agent-bundle loop, external repos authoring against the
  platform ([#651](https://github.com/factory-level/harness-hg/issues/651)).
- **No `charts/` tree survives. Application charts leave the platform repo entirely** —
  postiz-class charts live only in the persona repos. Platform charts land under
  `control-plane/`; the two test-fixture workloads land under `cli/test-env/`. The CI
  boundary gate becomes "the platform repo carries zero application charts"
  ([#659](https://github.com/factory-level/harness-hg/issues/659)).

### Ownership rules per root

| Root | Owns | New work goes here when… |
|---|---|---|
| `agent-bundle-contracts/` | Every contract an external repo authors against. Frozen version dirs never mutate; change arrives only as a new version dir. | it changes what an agent bundle may declare. |
| `bootstrap/` | Everything that runs **before** the cluster serves traffic: state backend, Pulumi program, gitops-template, the emitter, the launch shim. | it provisions, emits, or gates — and nothing at runtime depends on it staying up. |
| `control-plane/` | One directory per platform-owned component; each owns its chart, dashboards, alerts, and logs. Components talk through declared dependencies only. | the platform (not a persona, not a harness) must run it for every environment. |
| `cli/` | `hg` — one directory per subject, grammar per the loop SOP. `cli/test-env/` owns the ephemeral environment and its fixture workloads. | an operator loop (ops / dev / agent-bundle) needs a verb. No loop, no merge. |
| `harness/` | One directory per harness: emitter path, runtime, image, chart, gateway declaration. Hermes is frozen. Nothing outside imports harness internals. | it drives a specific runtime; the platform stays harness-agnostic. |
| `nexus-ui/` | The rebuilt frontend, own bun workspace + CI job. | it renders; data stays behind the plugin-API / canvas-plan seams. |
| `_docs/` / `landing/` / `examples/` / `maintainers/` | Docs system · marketing · reference + negative fixtures · honesty ledgers. | per their existing contracts (`_docs/README.md`). |

## Migration map

Every current top-level path, exactly once. "Dies" is gated on the signed-off kill list
([#647](https://github.com/factory-level/harness-hg/issues/647)); frozen dirs move
byte-identical; every move is proven deployment-neutral (render records before/after, `cmp`).

| Current path | Disposition |
|---|---|
| `cli/` | Stays; restructured one-dir-per-subject ([#657](https://github.com/factory-level/harness-hg/issues/657)), grammar normalized ([#656](https://github.com/factory-level/harness-hg/issues/656)); gains `test-env/`. |
| `plugin/schemas/` | → `agent-bundle-contracts/`, byte-identical ([#651](https://github.com/factory-level/harness-hg/issues/651)). |
| `plugin/gitops_emitter/` | Splits: harness-specific emitters (`harness/`, Eve `emit_cli.py`) → `harness/<h>/`; generic scaffold/render/forge → `bootstrap/platform-infra/` ([#681](https://github.com/factory-level/harness-hg/issues/681)). |
| `plugin/tests/` | Follows its subjects; the pytest root disposition is settled in [#651](https://github.com/factory-level/harness-hg/issues/651). |
| `infra/src/` + `infra/pulumi/` | → `bootstrap/platform-infra/`. |
| `infra/gitops-template/` | → `bootstrap/platform-infra/`. |
| `infra/charts/` | Splits: `eve-agent`, `eve-bundle` → `harness/eve/`; `hermes-*` → `harness/hermes/` ([#652](https://github.com/factory-level/harness-hg/issues/652)). |
| `infra/images/` | `eve-runtime` → `harness/eve/`; `event-router` → `control-plane/event-router/`. |
| `infra/scripts/` | Splits by subject: chart/render proof machinery follows the tree it proves; repo-wide generators and gates → `bootstrap/platform-infra/scripts/`; the Makefile stays the index. |
| `state/` | → `bootstrap/state-bucket-kms/`. |
| `charts/nexus` | → `control-plane/nexus/` (its `files/` stays a committed projection until [#666](https://github.com/factory-level/harness-hg/issues/666) retires it). |
| `charts/monitoring` + `charts/control-plane-observability` | → `control-plane/` (merge decided in [#658](https://github.com/factory-level/harness-hg/issues/658)). |
| `charts/hermes-alerting` | → `control-plane/alert-router/` (renamed per the vocabulary, [#649](https://github.com/factory-level/harness-hg/issues/649)). |
| `charts/fleet-dashboard` | → `control-plane/`. |
| `charts/secret-tester` + `charts/test-page` | → `cli/test-env/`. `test-page` is referenced from frozen schema examples — the frozen references keep resolving (compatibility decided in [#651](https://github.com/factory-level/harness-hg/issues/651), deleted only via [#672](https://github.com/factory-level/harness-hg/issues/672)). |
| `dashboard/src/` + `dashboard/browser/` | Rebuilt as `nexus-ui/` ([#665](https://github.com/factory-level/harness-hg/issues/665)–[#668](https://github.com/factory-level/harness-hg/issues/668)), then deleted — never ported file-wise. |
| `dashboard/nexus/` | → `control-plane/nexus/` (manifest, committed `dist/`, `plugin_api.py`, `avatars/`). |
| `_docs/` | Stays (the four-tree reorg is done). |
| `landing/` | Stays, untouched. |
| `examples/` | Stays; `quickstart-pulumi` dies when [#676](https://github.com/factory-level/harness-hg/issues/676) lands. |
| `maintainers/` | Stays; refresh pass in [#671](https://github.com/factory-level/harness-hg/issues/671). |
| `.hermes/` | → `harness/hermes/` ([#652](https://github.com/factory-level/harness-hg/issues/652)). |
| `.claude/` | Stays — the Claude Code workspace surface (skills, workflows). |
| `.impeccable/` + `DESIGN.md` + `PRODUCT.md` | The UI design-system source — feeds the extraction ([#665](https://github.com/factory-level/harness-hg/issues/665)); re-homes under `nexus-ui/` when that tree exists. |
| `.github/` | Stays; CI jobs re-point as trees move. |
| `factory-system-reference.md` | → `maintainers/` (live-environment reference; unpublished). |
| Root files (`CLAUDE.md`, `README.md`, `LICENSE`, `CODEOWNERS`, `Makefile`, `pyproject.toml`, `uv.lock`, `versions.json`, `.gitignore`) | Stay at root. |

Already gone before this ADR (first cuts, 2026-08-25): `claude-plugins/`, `uptime/`,
`docs/` (vendored superpowers), `site/` (was never tracked), and `.hermes-dist/` — whose
role (persona destination config) is succeeded by the `.harness-hg/` dotdir convention.

### Nothing is named "plugin" anymore

Three unrelated systems shared the word. After the map above: `plugin/` dissolves into
`agent-bundle-contracts/` + `harness/` + `bootstrap/platform-infra/`; `claude-plugins/` is
already deleted; `dashboard/` splits into `nexus-ui/` and `control-plane/nexus/`. No
top-level path carries the word "plugin", and the collision cannot re-form because none of
the ownership rules above admit one.

### Sibling-checkout assumptions — preserved

Both validation loops keep the sibling layout: the persona repo's gate runs the platform CLI
as `../harness-hg/cli/src/main.ts`, and the platform's cross-repo proof reads
`../<persona>.harness-hg`. Internal paths move; the workspace contract and the `hg`
entrypoint do not.

## Reason

The tree was vibe-coded into shape; its boundaries exist only in folklore. Making them
structural — contracts, harnesses, control plane, CLI, UI, bootstrap — gives every future
change an obvious home before it is implemented, which is the internal-clean bar the epic
sets. The two 2026-08-25 decisions follow the same logic: contracts are named for the loop
they serve, and application workloads belong to the repos that deploy them.

## Cost

- **Every importer, CI job, and doc path in the repo changes.** The big-bang
  `refactor/final-pass` branch carries weeks of churn and merges once, proven — a long-lived
  branch with real conflict risk against anything else in flight.
- Committed projections (`charts/nexus/files/`, `dashboard/nexus/dist/`) must be regenerated,
  not moved, and stay hand-edit-forbidden throughout.
- Frozen schema examples pin paths that the map moves (`test-page`); compatibility shims must
  exist until [#672](https://github.com/factory-level/harness-hg/issues/672) deletes them —
  a window where old and new paths are both live.
- The persona repos take the application charts and their lifecycle burden; the platform
  gives up the convenience of hosting them next to the machinery that deploys them.
- Old in-repo GitHub paths break for external deep links (repo-level redirects survive,
  path-level ones do not).
