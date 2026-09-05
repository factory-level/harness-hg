# Final-pass surface inventory (#647)

Refreshed 2026-08-25 after the Phase-0 ADRs: destinations bind to
[ADR 0157](../../_docs/adr/0157-target-scaffold.md) (the migration map is the
authoritative copy). Rule: **guilty until proven useful** — nothing moves into
the new scaffold unless something depends on it or it is named as needed. The
kill list below was signed off and (entries 1–3) executed 2026-08-25 in
#686; the Phase-1 gate is open.

Classes: `required` (internal-clean needs it) · `core` (platform core) ·
`harness` (harness-specific) · `ui-conv` (UI convenience) · `exp`
(experimental) · `legacy` (Hermes compatibility) · `cruft` · `TBD`.

Destination column uses the ADR 0157 scaffold; `—` = dies.

## Top level

| Path | Size | Class | Destination | Notes |
|---|---|---|---|---|
| `cli/` | 48M | required | `cli/` | 56 modules, ~31k lines; restructure per #657, grammar per #656. `hg` command surface inventoried separately in the loop SOP (#650). |
| `plugin/gitops_emitter/` | — | core | split | Harness-specific emitters (`harness/`, Eve `emit_cli.py`) → `harness/<h>/`; generic scaffold/render/forge → `bootstrap/platform-infra/` (#681). |
| `plugin/schemas/` | — | core | `agent-bundle-contracts/` | **Moved 2026-08-25 (#651)** — 391 files byte-identical (sha256 sweep). |
| `plugin/tests/` | — | core | follows subject | Only pytest root; disposition decided in #651. |
| `infra/src` + `pulumi/` | — | core | `bootstrap/platform-infra/` | Pulumi program, three config-gated stages. |
| `infra/charts/` | — | core/harness | split | `eve-agent`, `eve-bundle`, `hermes-*` → `harness/<h>/`; nothing here is an application chart. Boundary work is #658. |
| `infra/gitops-template/` | — | core | `bootstrap/platform-infra/` | The destination-repo scaffold; paths update with #658. |
| `infra/images/` | — | split | split | `eve-runtime` → `harness/eve/` (#652); `event-router` → `control-plane/event-router/` (#658). |
| `infra/scripts/` | — | core | mostly stays | Validators + render-test are the proof machinery (#669). Sweep for orphans below. |
| `charts/` | 1.7M | mixed | split | See per-chart table — the misnamed tree: mostly **platform** charts today. |
| `dashboard/src` + `browser/` | — | required | `nexus-ui/` (rebuilt) | The brittle frontend. Rebuilt via #665–#668, then deleted — not ported file-wise. |
| `dashboard/nexus/` | — | core | `control-plane/nexus/` | Installable unit: manifest, committed `dist/`, `plugin_api.py`, `avatars/`. Re-homed, not rebuilt. |
| `state/` | 208K | core | `bootstrap/state-bucket-kms/` | State-backend stack. Day-0 UX replaced by #676/#674; the stack itself is required. |
| `_docs/` | 7.4M | required | `_docs/` | Reorganized 2026-08-25: `adr/` + `architecture/` + `design/` + `wiki/` (self-contained manual, own mkdocs.yml). See `_docs/README.md`. |
| `site/` | 22M | n/a | — | Local build artifact only — already gitignored (`/site/`), zero tracked files. Not a repo concern. |
| `docs/` (superpowers) | — | deleted | — | Cut 2026-08-25 in the deletes pass (with `uptime/`, its main referrer). |
| `maintainers/` | 152K | required | `maintainers/` | Honesty ledgers. Refresh pass in #671. |
| `landing/` | 3.9M | core | stays | Marketing site + devlog. Untouched by the refactor. |
| `examples/` | 1.7M | core | stays | Includes negative `invalid-*` fixtures — part of the proof surface (#669). `quickstart-pulumi` likely superseded by #676/#675 — flag. |
| `.claude/` | — | core | stays | Claude Code workspace surface (skills, workflows). `claude-plugins/` deleted 2026-08-25; `.agents/` is untracked. |
| `.hermes/` | — | harness/legacy | `harness/hermes/` | Hermes agent skill format; follows the frozen harness (#652). `.hermes-dist/` deleted 2026-08-25 — its role (persona destination config) is succeeded by the `.harness-hg/` dotdir convention (ADR 0157). |
| `uptime/` | — | deleted | — | Cut 2026-08-25. Orphans `hg uptime-push` + `infra/src/components/external-uptime` (they served its prober) — both now kill-list candidates via #650. |
| Root images (`board-light.png`, `landing-light-1366.png`) | — | deleted | — | Untracked screenshots; deleted 2026-08-25. |
| `.github/` | — | required | stays | CI; jobs re-point as trees move. |
| `.impeccable/` + `DESIGN.md` + `PRODUCT.md` | — | required | `nexus-ui/` (later) | The UI design-system source; feeds the extraction (#665), re-homes when `nexus-ui/` exists. |
| `factory-system-reference.md` | — | required | `maintainers/` | Live-environment reference; unpublished. |

## `charts/` per-chart (the boundary violation, itemized)

| Chart | Class | Destination |
|---|---|---|
| `nexus` | core | `control-plane/nexus/` (its `files/` stays a committed projection) |
| `monitoring` | core | `control-plane/` (grafana/prometheus/alertmanager split per #658) |
| `control-plane-observability` | core | `control-plane/` (merge target with `monitoring` — decide in #658) |
| `hermes-alerting` | core, misnamed | `control-plane/alert-router/` (rename per #649 — generic concept, hermes-* name) |
| `fleet-dashboard` | core | `control-plane/` — live: wired into `cli/src/platform.ts`, gitops-template bootstrap, observer-metrics plugin, golden tests |
| `secret-tester` | core (test fixture) | `cli/test-env/` (ADR 0157) — the smoke-test workload (`smoke-local.sh`, cloudflare-ingress, control-flow config) |
| `test-page` | core (test fixture) | `cli/test-env/` (ADR 0157) — the hello-world app referenced by frozen schema examples, goldens, e2e, render tests. Frozen references keep resolving until #672. |

## The kill list (signed off 2026-08-25 — #647 closed, Phase 1 open)

Entries 1–3 executed in #686; entry 4 executes when #676 lands. Each entry
names what proved it dead:

1. The `uptime-push` helper (`cli/src/uptime-push.ts` — not a command; dead
   heartbeat pushes inside `hg platform` backup / restore-verify paths) + the
   `external-uptime` Pulumi component. **Proof: superseded-by-nothing** — their
   only consumer was the `uptime/` prober config tree, deleted 2026-08-25; no
   other caller (grep), no doc, no test asserts the pushes.
2. CLI `bundle`. **Proof: unmapped in the loop map** (ADR 0159) — an ADR-28
   preview superseded by the real bundle contract; no loop needs it.
3. CLI `dash load`. **Proof: unmapped in the loop map** (ADR 0159).
4. `examples/quickstart-pulumi`. **Proof: superseded-by #676** (`hg env new`
   owns day-0); one doc link (`infra/README.md`) to update at delete time.
   Conditional — dies when #676 lands.

Executed already (pre-sign-off, in the first-cuts pass): root screenshots,
`claude-plugins/`, `uptime/`, `docs/` (superpowers), `.hermes-dist/`.

Cleared by verification (2026-08-25): `site/` is gitignored (not tracked);
`docs/superpowers` is link-referenced from infra code; `fleet-dashboard` is a
live control-plane component; `secret-tester` is the smoke-test workload;
`test-page` is the fixture app embedded in frozen schema examples and goldens
— both reclassify as test fixtures to re-home via #648, not delete.

**Tracked-file hygiene audit (2026-08-25): clean.** No `__pycache__`/`.pyc`,
no `node_modules`, no logs, no keys or `.env` tracked; the only committed
`dist/` is `dashboard/nexus/dist` (intentional projection); no `.bak`/`.orig`/
proof artifacts. Large tracked files are all legitimate assets.

## Open questions (owned, not blocking sign-off)

- `plugin/gitops_emitter` split: decided at module-group level in ADR 0157
  (generic scaffold/render/forge → `bootstrap/platform-infra/`, #681); the
  per-file pass happens at move time.
- `monitoring` vs `control-plane-observability` overlap (one chart or two):
  decided in #658.
