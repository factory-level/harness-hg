# control-plane/fleet-dashboard/

**Purpose.** Fleet-level budgets and cross-profile panels: cluster singleton.

**Chart / machinery.** `chart/` (was charts/fleet-dashboard); deployed by `bootstrap/fleet-dashboard.yaml`, whose helm.valuesObject is the operator's budget-edit surface.

**Signals.** budgets live fleet-side, one source of truth. Coverage is inventoried per component in #662.
