# control-plane/alertmanager/

**Purpose.** Alert routing for cluster-level rules.

**Chart / machinery.** deployed by the monitoring stack; per-profile `AlertmanagerConfig` objects come from `control-plane/monitoring/chart`.

**Signals.** path 3 of the alert model (`_docs/wiki/platform/alerts.md`). Coverage is inventoried per component in #662.
