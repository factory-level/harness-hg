# control-plane/grafana/

**Purpose.** Dashboards + alert rules UI for both planes.

**Chart / machinery.** no chart of its own yet — deployed by the monitoring stack (`infra/gitops-template/bootstrap/monitoring-stack.yaml`, kube-prometheus-stack).

**Signals.** its own health is asserted by `hg grafana prove`; dashboards land via the sidecar convention (`grafana_dashboard: "1"`). Coverage is inventoried per component in #662.
