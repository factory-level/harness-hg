# ADR 0166 — Dashboards unmistakably distinct, by provisioning

2026-08-25 · executes [#663](https://github.com/factory-level/harness-hg/issues/663), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646). Built on
the plane labels ([ADR 0164](0164-plane-separation.md)).

## Decision

- **Grafana folders are derived, not chosen**: the dashboards sidecar gains
  `folderAnnotation: grafana_folder`, and every dashboard ConfigMap carries the annotation
  as a function of its plane label — `control-plane` → **Control Plane**, `workload` →
  **Workloads**. The mapping is validation-owned:
  `test_plane_labels.py::test_dashboard_folders_follow_the_plane` fails any dashboard
  whose folder disagrees with (or omits) its plane, over the committed goldens.
- **`hg dash list` carries the plane** per declared dashboard (from the ConfigMap label),
  so declared-vs-imported reads per plane without opening Grafana.
- **Nexus-side visibility is deliberately deferred to the rebuild**: a plane badge on the
  retiring `dashboard/src` would mean regenerating the committed projections twice; it is
  filed as a requirement riding the #665 design-system spec instead (the fan-out issue).

## Reason

"Which plane is this dashboard?" was convention-only. Folders driven by an annotation that
a test derives from the plane label make the answer structural: a dashboard cannot land in
the wrong folder without failing `make test`, and an operator answers "platform or app?"
from the folder name without opening anything.

## Cost

- The live factory Grafana shows the folders only after the seed's sidecar block reaches
  it ([#703](https://github.com/factory-level/harness-hg/issues/703)); until then folders
  exist in the charts but not on screen.
- Two English folder names are now contract-ish strings in seven templates and a test —
  renaming them is a coordinated change.
- The alerts sidecar has no folder mechanism; alert rules stay flat (their plane is still
  queryable by label, not by folder).
