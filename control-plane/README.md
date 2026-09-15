# control-plane/

One directory per platform component, each with its own `chart/` and README: Argo CD, Dex,
External Secrets, Prometheus, Grafana, Loki, Alertmanager, the event and alert routers, the
tunnel, the fleet dashboard, and Nexus. `planes.yaml` names which plane each belongs to.

Gate: `make chart-test` (lint + golden renders) and `make chart-boundary` (every chart homed
in its declared class; cross-component references need a declared dependency).
`control-plane/nexus/chart/files/` is a committed projection of `control-plane/nexus/`; never
edit it directly.

Manual: https://factory-level.github.io/harness-hg/docs/platform/
