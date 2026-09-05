<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/dashboard-plan/v1alpha2/plan.schema.json
       agent-bundle-contracts/dashboard-plan/v1alpha2/provenance.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Dashboard plan

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

**Generated** by `hg nexus emit`: `deployments/control-plane/nexus-plan.json` is the compiled join of dashboard contributions and the topology plan (deterministic — health is layered on at runtime, never baked in), and `catalog/dashboard/sources/<id>/provenance.yaml` sits beside the verbatim copies of the authored dashboard files.

## `plan` (v1alpha2)

Schema: `agent-bundle-contracts/dashboard-plan/v1alpha2/plan.schema.json` — **Generated Nexus plan (deployments/control-plane/nexus-plan.json)**

### (root)

The compiled join of dashboard contributions and the topology plan: logical components with their physical instances, destination URLs, Argo identities and declared summaries, plus the repository default view. Deterministic - no timestamps, no runtime health (health is layered on by the plugin backend at serve time and never written here). An unresolved binding stays in the plan with resolved: false and no instances; it must render, not disappear.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | const `2` | **yes** | — | — |
| `inputsHash` | string | **yes** | pattern: `^[0-9a-f]{64}$` | sha256 over every input file of THIS plan (contributions, views, the topology plan, workload-endpoint config). Independent of the topology plan's own hash. |
| `sourceSha` | string | **yes** | pattern: `^[0-9a-f]{40}$` | The dashboard source commit the contributions were read at (all zeros for an uncommitted local preview). |
| `components` | array of object | **yes** | — | — |
| `relationships` | array of object | **yes** | — | — |
| `view` | object | **yes** | — | — |

#### `components[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | — |
| `kind` | string | **yes** | enum: `agent`, `application`, `human`, `group` | — |
| `title` | any | **yes** | — | — |
| `description` | any | no | — | — |
| `icon` | string | no | pattern: `^[a-z0-9]+(-[a-z0-9]+)*$`; maxLength: 63 | — |
| `source` | object | no | — | — |
| `bind` | object | no | — | — |
| `resolved` | boolean | **yes** | — | false when the bind names a profile or app the topology plan does not contain; such components render with unknown health. |
| `unresolvedReason` | any | no | — | — |
| `groupKind` | string | no | enum: `department`, `team`, `system` | — |
| `personTitle` | any | no | — | — |
| `cohorts` | array of any | no | — | — |
| `accessors` | array of any | no | — | — |
| `details` | object | no | — | — |
| `crons` | array of object | no | — | Declared crons from the profile contract - name and schedule only, the whole allowlist. Prompts never enter the plan. |
| `configSummary` | object | no | — | The declared-configuration allowlist, closed by additionalProperties: false. Keys, tokens, prompts, webhook secrets and raw documents are structurally unrepresentable here. |
| `instances` | array of object | **yes** | — | — |
| `links` | object | no | — | Authored reference links carried through from the v1alpha2 contribution. Rendered behind the repository-links flag. |

##### `components[].source`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | The catalogue source directory the component came from. |
| `path` | string | **yes** | maxLength: 300 | Repository-relative path of the authoring file. |

##### `components[].bind`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `profile` | any | **yes** | — | — |
| `app` | any | no | — | — |

##### `components[].details`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `showCrons` | boolean | no | — | — |
| `showConfigSummary` | boolean | no | — | — |
| `showAccessors` | boolean | no | — | — |
| `showArgoCd` | boolean | no | — | — |

##### `components[].crons[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | any | **yes** | — | — |
| `schedule` | string | **yes** | maxLength: 100 | — |

##### `components[].configSummary`

The declared-configuration allowlist, closed by additionalProperties: false. Keys, tokens, prompts, webhook secrets and raw documents are structurally unrepresentable here.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `profile` | any | no | — | — |
| `modelProvider` | any | no | — | — |
| `model` | any | no | — | — |
| `platforms` | array of any | no | — | — |
| `skillCount` | integer | no | minimum: 0 | — |
| `cronCount` | integer | no | minimum: 0 | — |

##### `components[].instances[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | maxLength: 130 | The topology plan instance id: <profile>@<scope> or <profile>/<app>@<scope>. |
| `scope` | string | **yes** | maxLength: 63 | — |
| `region` | string | no | maxLength: 63 | — |
| `target` | string | no | maxLength: 63 | — |
| `application` | string | no | maxLength: 100 | The Argo CD Application name from the topology plan. |
| `namespace` | string | no | maxLength: 63 | — |
| `destinations` | object | no | — | — |
| `grafanaDashboardUid` | string | no | maxLength: 63 | The instance's concrete Grafana dashboard uid, resolved by the compiler from the chart release naming (release names carry the scope, so the uid is per-instance). A uid, never a URL - the backend builds links from its configured base. |

###### `components[].instances[].destinations`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `hermesClassic` | any | no | — | The instance's own Hermes dashboard (its compiled `dashboard` endpoint URL). |
| `deployed` | array of object | no | — | — |

####### `components[].instances[].destinations.deployed[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | any | **yes** | — | — |
| `url` | any | **yes** | — | — |

##### `components[].links`

Authored reference links carried through from the v1alpha2 contribution. Rendered behind the repository-links flag.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | any | no | — | — |
| `docs` | any | no | — | — |
| `runbook` | any | no | — | — |

#### `relationships[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | — |
| `from` | any | **yes** | — | — |
| `to` | any | **yes** | — | — |
| `label` | any | **yes** | — | — |

#### `view`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | — |
| `title` | any | no | — | — |
| `nodes` | array of object | **yes** | — | — |
| `viewport` | object | no | — | — |

##### `view.nodes[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `ref` | any | **yes** | — | — |
| `position` | object | **yes** | — | — |
| `parent` | any | no | — | — |

###### `view.nodes[].position`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `x` | any | **yes** | — | — |
| `y` | any | **yes** | — | — |

##### `view.viewport`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `x` | any | **yes** | — | — |
| `y` | any | **yes** | — | — |
| `zoom` | number | **yes** | maximum: 10 | — |

## `provenance` (v1alpha2)

Schema: `agent-bundle-contracts/dashboard-plan/v1alpha2/provenance.schema.json` — **Dashboard catalogue provenance (catalog/dashboard/sources/<id>/provenance.yaml)**

### (root)

Provenance beside the verbatim copies of a repository's authored dashboard files. Like the topology catalogue, the copies themselves are byte-for-byte and validated by the authoring schemas, not here; the record's identity is its directory name. Richer than the frozen two-key topology provenance because a dashboard source spans several authored files: the paths are listed so the compiler can report exactly which file a finding came from.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `sourceSha` | string | **yes** | pattern: `^[0-9a-f]{40}$` | The source commit the dashboard files were read at (all zeros for an uncommitted local preview). |
| `sourcePaths` | array of string | **yes** | minItems: 1 | — |

## Example

`agent-bundle-contracts/dashboard-plan/v1alpha2/examples/plan/valid-plan.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# A compiled plan joining one agent (two regional instances), one application,
# one person, one group and their edges. JSON on disk; YAML here for fixture parity.
version: 2
inputsHash: "1111111111111111111111111111111111111111111111111111111111111111"
sourceSha: "0000000000000000000000000000000000000000"
components:
  - id: marketing-manager
    kind: agent
    title: Marketing Manager
    resolved: true
    bind:
      profile: marketing-manager
    source:
      id: factorylevel-social-media
      path: dashboard/contribution.yaml
    crons:
      - name: research-pass
        schedule: "0 9 * * 1-5"
    configSummary:
      profile: marketing-manager
      modelProvider: anthropic
      model: claude-sonnet-5
      platforms:
        - discord
      cronCount: 1
    instances:
      - id: marketing-manager@ca-west
        scope: ca-west
        region: ca-west
        target: hub
        application: hermes-marketing-manager-ca-west
        namespace: hermes-marketing-manager
        grafanaDashboardUid: hermes-marketing-manager-ca-west-mo
        destinations:
          hermesClassic: https://dashboard.agent-marketing-manager-ca-west.example.dev
      - id: marketing-manager@eu-west
        scope: eu-west
        region: eu-west
        target: spoke-eu
        application: hermes-marketing-manager-eu-west
        namespace: hermes-marketing-manager
        destinations: {}
  - id: content-kanban
    kind: application
    title: Content Kanban
    resolved: true
    bind:
      profile: marketing-manager
      app: content-kanban
    details:
      showArgoCd: true
    instances:
      - id: marketing-manager/content-kanban@global
        scope: global
        target: hub
        application: hermes-marketing-manager-content-kanban-global
        namespace: hermes-marketing-manager
        destinations:
          deployed:
            - name: ui
              url: https://ui.content-kanban.example.dev
  - id: ghost-app
    kind: application
    title: Ghost App
    resolved: false
    unresolvedReason: "bind names app 'ghost' which no profile declares"
    bind:
      profile: marketing-manager
      app: ghost
    instances: []
  - id: calvin
    kind: human
    title: Calvin
    personTitle: Operator
    resolved: true
    cohorts:
      - marketing
    accessors:
      - marketing-manager
    instances: []
  - id: marketing
    kind: group
    title: Marketing
    groupKind: department
    resolved: true
    instances: []
relationships:
  - id: manager-controls-board
    from: marketing-manager
    to: content-kanban
    label: manages
view:
  id: default
  title: Social Media Operation
  nodes:
    - ref: marketing
      position: {x: 120, y: 120}
    - ref: marketing-manager
      position: {x: 520, y: 220}
      parent: marketing
  viewport:
    x: 0
    y: 0
    zoom: 0.85
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/dashboard-plan/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [nexus](../cli/nexus.md)

