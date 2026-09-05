<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/panel-catalog/v1alpha2/panel-catalog.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Panel catalog

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

The closed set of Grafana panels Nexus is allowed to embed. It exists because the browser must never be able to name a dashboard: every embed URL is built on the server from an entry in this file, and an identifier that is not here does not resolve.

Schema: `agent-bundle-contracts/panel-catalog/v1alpha2/panel-catalog.schema.json` — **Embedded Grafana panel catalog**

## (root)

The closed set of Grafana panels Nexus is allowed to embed. It exists because the browser must never be able to name a dashboard: every embed URL is built on the server from an entry in this file, and an identifier that is not here does not resolve. The catalog is PLATFORM-owned in v1alpha1 - repository-declared panels need a hermesprofile version that carries them, and are a named cut. Nothing here may promise data the dashboard does not actually contain: the withdrawn embed this contract replaces rendered a COST dashboard under a tab named Uptime, which is why every entry names its dashboard uid and numeric panel id explicitly and a test asserts both exist in the provisioned dashboards.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `nexus.hermes.ai/panel-catalog/v1alpha2` | **yes** | — | — |
| `kind` | const `PanelCatalog` | **yes** | — | — |
| `panels` | array of object | **yes** | — | — |

### `panels[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | pattern: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`; maxLength: 60 | Stable logical name a surface asks for. Duplicates fail compilation. |
| `surface` | any | **yes** | enum: `system`, `communication`, `backup`, `agent`, `application`, `uptime`, `eval` | Which Nexus surface may render it. A closed enum: a panel cannot appear somewhere the platform has not placed it. |
| `title` | string | **yes** | minLength: 3; maxLength: 80 | What Nexus labels it. Must describe what the PANEL shows, not what the surface wishes it showed. |
| `dashboard` | string | **yes** | pattern: `^(\{instance\}|[a-zA-Z0-9-]{1,64})$` | Either a literal dashboard uid, or the token `{instance}` meaning the plan's per-instance grafanaDashboardUid. No other substitution exists. |
| `panelId` | integer | **yes** | minimum: 1; maximum: 10000 | — |
| `size` | any | **yes** | enum: `compact`, `standard`, `wide`, `tall` | A closed preset. Repositories and surfaces choose a preset, never pixels, CSS or aspect ratios - Nexus maps the preset to trusted host styles. |
| `range` | any | no | enum: `1h`, `6h`, `24h`, `7d`, `30d` | Allowlisted relative time range. Absent = the dashboard's own default. |
| `note` | string | no | maxLength: 200 | Why this panel is here, when that is not obvious. Rendered nowhere; read by the next person deciding whether it still belongs. |
| `variables` | object | no | — | Context-aware embedding (#420): Grafana template-variable name -> the Nexus context that may fill it. The server builds `var-<name>=<value>` from a validated context value; a variable not declared here can never be set from the browser, and a context kind not in the enum does not exist. The dashboard must actually declare the variable (with a safe default) - Grafana ignores unknown var- params silently, which is why `hg grafana prove` checks the declaration against the LIVE dashboard, not this file. |

## Example

`agent-bundle-contracts/panel-catalog/v1alpha2/examples/catalog/valid-platform-catalog.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# The shipped catalog's shape: a literal platform dashboard uid, and the
# {instance} token for a per-agent dashboard.
apiVersion: nexus.hermes.ai/panel-catalog/v1alpha2
kind: PanelCatalog
panels:
  - id: system-firing-alerts
    surface: system
    title: Firing alerts
    dashboard: hg-control-plane-overview
    panelId: 1
    size: compact
  - id: agent-ready-pods
    surface: agent
    title: Agent ready pods
    dashboard: "{instance}"
    panelId: 3
    size: compact
    range: 24h
  # v1alpha2: a context-aware entry - the namespace template
  # variable may be filled from the Nexus `target` context, and nothing
  # else may reach it.
  - id: backup-history-target
    surface: backup
    title: Backup runs for the selected component
    dashboard: hg-backup-history
    panelId: 3
    size: wide
    range: 7d
    variables:
      namespace: target
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/panel-catalog/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).

