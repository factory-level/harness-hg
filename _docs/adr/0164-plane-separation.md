# ADR 0164 — Plane separation: namespaces, labels, and PLANE001

2026-08-25 · executes [#660](https://github.com/factory-level/harness-hg/issues/660), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646).
Prerequisite for Loki ([#661](https://github.com/factory-level/harness-hg/issues/661)) and
the dashboard separation ([#663](https://github.com/factory-level/harness-hg/issues/663)).

## Decision

- **The convention is data**: `control-plane/planes.yaml` names the control-plane
  namespaces (`argocd`, `external-secrets`, `hermes-secrets`, `hermes-system`(+`-<scope>`),
  `hermes-monitoring`), the workload namespace prefixes (`hermes-`, `ag-eve-`, exact
  control-plane names winning), and the label keys
  (`hermes-gitops.factorylevel.dev/plane` = `control-plane` | `workload`, plus
  `…/component`). The CLI (`cli/src/platform/planes.ts`) and the tests read the same file,
  so nothing can disagree about which plane a namespace is.
- **Every platform-rendered resource carries the labels**, applied at the resource level
  (never in pod templates) across all ten canonical charts.
  `plugin/tests/test_plane_labels.py` asserts it over the committed goldens — a new
  template that forgets the labels fails `make test`.
- **PLANE001**: `hg validate` errors when a profile's derived namespace lands in the
  control-plane set — the concrete hazard being a profile named `system`, whose Hermes
  namespace derives `hermes-system`.
- **Migration is converge-on-next-sync**: labels arrive when a destination repo flips to
  the canonical charts (they ride the same pending factory.gitops#131 roll — the boot
  checksums already churned there, so labeling costs no extra restart). The deployed
  monitoring stack's scrape/relabel configs live in seeded-then-operator-owned bootstrap
  files; propagating the plane label into stored series is
  [#662](https://github.com/factory-level/harness-hg/issues/662)'s PromQL demonstration,
  using the namespace sets in `planes.yaml` until then.

## Reason

Loki, the dashboard split, and every "is this the platform or the app?" question need one
authoritative answer per resource. Labels-by-convention rot; labels asserted over goldens
and a namespace list read by both the CLI and the tests cannot drift silently. The
resource-level-only rule exists because pod-template labels roll pods — this ADR buys the
whole scheme for zero restarts beyond the one already declared.

## Cost

- The label is on resources, not (yet) on stored log/metric series: a PromQL split today
  goes through namespace sets, not a `plane` series label — honest until #661/#662 land
  collection that carries it.
- `planes.yaml` is a second registry a new control-plane namespace must remember to join
  (PLANE001 and the tests only know what it lists).
- Compat-copy charts render unlabeled until they die — mixed-label fleets are the
  transition state, ending with the factory flip + #672.
