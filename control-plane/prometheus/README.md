# control-plane/prometheus/

**Purpose.** Metrics collection and rule evaluation.

**Chart / machinery.** deployed by the monitoring stack (kube-prometheus-stack).

**Signals.** scrape configs live in the monitoring stack; the plane-label scheme arrives with #660. Coverage is inventoried per component in #662.
