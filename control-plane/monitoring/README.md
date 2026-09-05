# control-plane/monitoring/

**Purpose.** Per-profile observability: one release per profile namespace, uids derived from the namespace.

**Chart / machinery.** `chart/` — the canonical copy; the root `charts/monitoring` compat copy stays until persona records stop naming it by path (#672 collects).

**Signals.** profile dashboards, alert rules, and a per-namespace AlertmanagerConfig. Coverage is inventoried per component in #662.
