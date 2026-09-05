# control-plane/observability/

**Purpose.** Control-plane self-observability: cluster singleton, PROMISED constant uids (`hg-control-plane-*`).

**Chart / machinery.** `chart/` (was charts/control-plane-observability); deployed by `bootstrap/control-plane-observability.yaml` in the destination repo.

**Signals.** fleetRegister and the Nexus panel catalog assert the uids — never derive them. Coverage is inventoried per component in #662.
