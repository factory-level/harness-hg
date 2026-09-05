# ADR 0163 — The control-plane root: every component owns its directory

2026-08-25 · executes [#658](https://github.com/factory-level/harness-hg/issues/658), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646). Follows
[ADR 0160](0160-harness-chart-migration.md)'s choreography where paths are live.

## Decision

Fifteen component directories under `control-plane/`, each with a README naming its
purpose, chart/machinery, and signals. The chart dispositions, by how each deploys:

- **Pure moves** (never an Argo path): `charts/nexus` → `control-plane/nexus/chart` (the
  `dashboard/nexus` → `chart/files` projection repointed; `dashboard/nexus` itself follows
  at #666), and `charts/hermes-alerting` → `control-plane/alert-router/lib` (a library —
  consumers' committed copies regenerate via the rewritten `sync-alerting-lib.sh`).
- **Copies with a hand flip** (deployed by destination-repo bootstrap files that are
  seeded-then-operator-owned, NOT plugin-managed): `charts/control-plane-observability` →
  `control-plane/observability/chart`, `charts/fleet-dashboard` →
  `control-plane/fleet-dashboard/chart`. The factory flip rides the same factory.gitops PR
  as ADR 0160's, preserving the operator-owned budget `valuesObject`.
- **Copies that outlive the flip** (the path is DATA in persona-authored records —
  `apps[].chart` is stamped verbatim into live Argo `path:` fields, and it also feeds
  Grafana uid derivation): `charts/monitoring` → `control-plane/monitoring/chart`,
  `charts/secret-tester` / `charts/test-page` → `cli/test-env/charts/`. The old paths stay
  until every persona record stops naming them
  ([#672](https://github.com/factory-level/harness-hg/issues/672) collects; the persona
  fallout is on social-media.harness-hg#51). No name branch exists for these — the record
  carries the full path.
- **`monitoring` and `observability` stay two charts.** They share only mechanism (sidecar
  ConfigMaps): `monitoring` is one release per profile namespace with namespace-derived
  uids; `observability` is a cluster singleton with PROMISED constant uids that
  `fleetRegister` and the Nexus panel catalog assert. One chart would need every
  control-plane dashboard conditional-on-first-install and the uid promise to survive N
  renders — the split is load-bearing, not accidental. (This closes the "one chart or
  two" question #658 carried; the inventory's grafana/prometheus/alertmanager split idea
  is rejected for the same reason — they deploy as one monitoring stack.)
- Also fixed here: three stale ADR-0160 leftovers still resolving
  `infra/charts/hermes-event-router` (the local-loop install + two router tests), which
  would have broken at ADR 0160 step 3.

## Reason

The `charts/` vs `infra/charts/` split encoded nothing; tree position now states
ownership (ADR 0157). Fifteen READMEs make "which component owns this signal" a lookup
instead of archaeology, and the per-mechanism dispositions above are the honest map of
what actually pins each path — Argo path, record data, or nothing.

## Cost

- **Two more long-lived compat copies** (`charts/monitoring`, `charts/{secret-tester,
  test-page}`) that bit-rot by design: the alerting-lib sync now feeds only the canonical
  copies, so a library fix after this ADR does not reach the old `charts/monitoring`
  render that the fleet still deploys — acceptable only because the freeze window ends at
  #672.
- Renaming a record's `chart:` string later changes its derived Grafana uid — the persona
  migration must treat dashboard continuity as part of its `cmp` story, not a rename
  detail.
- The `wiki/` and `loki/` directories are promissory READMEs for #664/#661 — directories
  that describe nothing deployed yet.
