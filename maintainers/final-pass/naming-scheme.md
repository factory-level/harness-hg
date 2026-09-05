# Final-pass naming scheme (#649)

Decisions made 2026-08-25 with Calvin; this file is the disposition ledger the
deep rename executes from.

## Decided names

| Concept | Old | New |
|---|---|---|
| Platform repo | `factory-level/hermes-gitops-plugin` | `factory-level/harness-hg` |
| Product / site | Hermes Mercury | **Harness Hg** |
| Persona repos | `<persona>.hermes-gitops` | `<persona>.harness-hg` |
| Persona instance | `social-media.hermes-gitops` | `social-media.harness-hg` |
| Workspace dir | `~/Projects/hermes-gitops/` | renames with the pattern — **pending, manual** (live session paths) |

## Executed 2026-08-25 (refactor-preliminary)

- GitHub renames, both repos (old URLs redirect; **Pages URLs do not** — the
  wiki republishes under /harness-hg/).
- Checkout dirs + remotes; venv rebuilt (stale shebangs).
- Repo-slug URLs, sibling paths, product name across docs, landing, examples,
  scripts, self-contained tests. `make test` + cli/infra bun suites green.
- Persona repo: tooling only (`evals/topology-check.sh`, `suite.yaml`,
  `CLAUDE.md`) on branch `rename/harness-hg`.

## Deferred — the deep rename (execute on refactor/final-pass)

Each entry = disposition when its owning issue lands:

| Identifier | Where | Disposition |
|---|---|---|
| Frozen schema dirs + examples (`hermesprofile`, `hermes-gitops-extension`, …) | `agent-bundle-contracts/` (moved from `plugin/schemas/` 2026-08-25) | **Never mutate.** New names arrive only as new version dirs (#651). |
| Test world: chart fixtures, goldens, render-test URL assertions | `plugin/tests/`, `infra/scripts/render-test.sh` | Rename together in one commit with `--update`, after #651 settles the contract names. |
| Committed projections (`control-plane/nexus/chart/files/`, `control-plane/nexus/dist/`) | control-plane/nexus | **Done 2026-08-26**: regenerated from `nexus-ui/` at the #668 flip; `dashboard/src/data.ts` died with its tree. |
| Pulumi project names (`hermes-gitops-bootstrap`, `hermes-gitops-state`) | `infra/`, `state/` | Live state migration — plan under #676/#674; factory stack config `hermesGitopsRepoUrl` value updated then. |
| Nexus plugin id (`hermes-gitops`, `/api/plugins/hermes-gitops`) | control-plane/nexus, nexus-ui/src/api.ts | **#672 → dated follow-up #745** (2026-08-26): Calvin chose execute-not-park, but the gate — the fleet running the re-homed unit — verifiably fails until the factory converges on post-refactor main (#703). #745 carries the full execution design. |
| Platform chart names (`hermes-profile`, `hermes-event-router`, `hermes-alerting`, …) | `harness/*/charts/`, `control-plane/*/chart` | The moves (#652/#658) landed without the renames: `hermes-event-router` + the `hermes-alerting` subchart copies still carry the prefix outside `harness/hermes/`. **Dated follow-up #745** (live release-name churn; rides the same fleet-convergence gate). |
| `.live` thin repo (`hermes-gitops-plugin.live`) | factory | Rename to `harness-hg.live` when the factory migration runs (#159 territory). |
| Persona deployment truth (`distributions/`, chart cronjobs) | persona repo | #51's PR, with the four-profile record `cmp` proof. |
| Env var `HERMES_GITOPS_PLUGIN`, `.hermes/skills/hermes-gitops-template` id | cli docs, .hermes | With the loop SOP / harness moves (#650/#652). |
| Declaration file `hermes-gitops.yaml` + `.harness-hg/` home | agent-bundle repos, frozen schema examples | **Executed 2026-09-02 (ADR 0178)**: the bundle declaration is the repo's `harness-hg/` directories (`agent-team/v1alpha1`); `hermes-gitops.yaml` is the frozen legacy filename, still read; `.harness-hg/` was never built. |
| Prometheus metric prefixes (`hermes_cost`, `hermes_usage`, `hermes_event`, `hermes_tokens`, `hermes_observer`, `hermes_router`, `hermes_chatops`, …) | event-router, observer, dashboards, alerts | Rename with the observability inventory (#662) under the plane-label scheme (#660) — dashboards/alerts move in the same commit; breaks saved external queries. |
| Namespaces `hermes-system`, `hermes-monitoring` | gitops-template, goldens, live clusters | Plane-separation issue #660 owns the namespace scheme; live-cluster migration planned there. |
| Design-system name "Hermes Nexus" (`DESIGN.md` title, `.impeccable/design.json`) | repo root → `nexus-ui/` | Renamed to **Nexus** in the extracted spec (ADR 0168); files corrected at their #666 re-home — spec outranks them until then. |
| ADR ledger narrative | `_docs/adr/CHANGES.md` | **Never** — history stays written as it happened. |
