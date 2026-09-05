<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/dashboard-contribution/v1alpha2/contribution.schema.json
       agent-bundle-contracts/dashboard-contribution/v1alpha2/view.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Dashboard contribution

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Written by the **team**: an agent's `harness-hg/dashboard.yaml` and the repo's `dashboard/` (components, people, groups, relationships, and the default view). Data, never code. Read by `hg nexus compile`.

## `contribution` (v1alpha2)

Schema: `agent-bundle-contracts/dashboard-contribution/v1alpha2/contribution.schema.json` — **Nexus dashboard contribution (dashboard/contribution.yaml and distributions/<p>/dashboard/components.yaml)**

### (root)

The persona-authored half of the Nexus canvas: logical components bound to compiled profiles and apps, plus people, groups and conceptual relationships. Data, never code - no scripts, no environment specifics. v1alpha2's one deliberate widening: a component may declare https reference links (repository, docs, runbook) - the compiler additionally rejects userinfo, query and fragment, and the backend re-sanitizes at serve time before the browser sees them. Physical facts (instances, endpoint URLs, Argo identities) still come from the compiled topology plan. Relationships are conceptual and assert nothing about network connectivity. Cross-file rules (unique component ids across a repository, relationship endpoints existing) are the Nexus compiler's job, not this schema's. In an agent-team repository this file lives at `agents/<harness>/<name>/harness-hg/dashboard.yaml`; the legacy path stays readable for repositories not yet migrated.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `dashboard.hermes-gitops/v1alpha2` | **yes** | — | Pins the contribution contract this document was written against; only this exact value is admitted. |
| `kind` | const `NexusContribution` | **yes** | — | Marks the document as a Nexus contribution, distinguishing it from a NexusView layout file. |
| `metadata` | object | **yes** | — | Identity of the contribution source this file speaks for. |
| `spec` | object | **yes** | — | The contributed declarations. At least one of the four sections must be present and non-empty. |

#### `metadata`

Identity of the contribution source this file speaks for.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | Identity of this contribution source. For the repository-level file, the operation's name; for a per-distribution file, conventionally the profile name. |
| `title` | any | **yes** | — | Human-readable name of this contribution source. |
| `description` | any | no | — | Optional longer text describing what this contribution source covers. |

#### `spec`

The contributed declarations. At least one of the four sections must be present and non-empty.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `components` | array of object | no | — | Logical components to place on the canvas, each bound to a compiled profile or one of its apps. The compiler resolves each bind against the topology plan. |
| `people` | array of object | no | — | The humans of the operation, rendered as person cards and roster rows. Display metadata only - never an identity or IAM surface. |
| `groups` | array of object | no | — | Named groupings that people (via cohorts) and view nodes (via parent) can belong to. |
| `relationships` | array of object | no | — | Conceptual edges drawn between contributed ids. They assert nothing about network connectivity. |

##### `spec.components[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | The component's canvas id, referenced by relationships, people's accessors and view nodes. |
| `kind` | string | **yes** | enum: `agent`, `application` | agent binds a whole profile; application binds one apps[] entry of a profile. |
| `title` | any | **yes** | — | Display name shown on the component's canvas card. |
| `description` | any | no | — | Short text shown with the component and matched by canvas search. |
| `bind` | object | **yes** | — | Which compiled workload this component represents; the compiler resolves it against the topology plan. |
| `display` | object | no | — | Presentation hints for the component's canvas card. |
| `details` | object | no | — | Which optional sections the component's detail modal shows. |
| `observability` | object | no | — | Observability surfaces for the component, named by logical identifier rather than URL. |
| `links` | object | no | — | Reference links for this component - the launchpad rows the modal renders behind the repository-links flag. Components only, by decision. |

###### `spec.components[].bind`

Which compiled workload this component represents; the compiler resolves it against the topology plan.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `profile` | any | **yes** | — | The distribution.yaml name the component binds to. |
| `app` | any | no | — | The apps[] entry name. Required when kind is application, forbidden when kind is agent. |

###### `spec.components[].display`

Presentation hints for the component's canvas card.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `icon` | string | no | pattern: `^[a-z0-9]+(-[a-z0-9]+)*$`; maxLength: 63 | Lucide icon name (kebab-case). Unknown names fall back to a default icon. |
| `providerBadge` | boolean | no | — | Show hosting-provider badges derived from the compiled plan. |

###### `spec.components[].details`

Which optional sections the component's detail modal shows.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `showCrons` | boolean | no | — | Agent modal: show the compile-time cron summary (name and schedule from the declared contract - never prompts). |
| `showConfigSummary` | boolean | no | — | Agent modal: show the allowlisted declared-configuration summary. |
| `showAccessors` | boolean | no | — | Show the people whose accessors list names this component. |
| `showArgoCd` | boolean | no | — | Application modal: show the Argo CD deep link. |
| `endpointNames` | array of any | no | — | Which declared endpoints appear as deployed-URL links, by endpoint name. Omitted: every endpoint with a compiled external URL. |

###### `spec.components[].observability`

Observability surfaces for the component, named by logical identifier rather than URL.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `grafanaDashboard` | string | no | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 63 | Logical Grafana dashboard identifier. The compiler resolves it to a concrete uid; never a URL. |

###### `spec.components[].links`

Reference links for this component - the launchpad rows the modal renders behind the repository-links flag. Components only, by decision.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | any | no | — | Link to the component's source repository. |
| `docs` | any | no | — | Link to the component's documentation. |
| `runbook` | any | no | — | Link to the component's operational runbook. |

##### `spec.people[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | The person's id, referenced by relationships and view nodes. |
| `displayName` | any | **yes** | — | The person's name as shown on their card. |
| `title` | any | no | — | Role or job title, shown alongside the display name. |
| `cohorts` | array of any | no | — | Group ids this person belongs to. |
| `accessors` | array of any | no | — | Component ids this person operates or has access to. Display metadata only - never an IAM assertion. |

##### `spec.groups[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | The group's id, referenced by people's cohorts, relationships and view node parents. |
| `title` | any | **yes** | — | Display name of the group. |
| `kind` | string | no | enum: `department`, `team`, `system` | What sort of grouping this is; shown as the group's subtitle in the roster. |

##### `spec.relationships[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | The relationship's id. |
| `from` | any | **yes** | — | Source endpoint - a component, person or group id contributed by this repository (the compiler rejects unknown ids). |
| `to` | any | **yes** | — | Target endpoint - a component, person or group id contributed by this repository (the compiler rejects unknown ids). |
| `label` | any | **yes** | — | Text drawn along the edge. |

## `view` (v1alpha2)

Schema: `agent-bundle-contracts/dashboard-contribution/v1alpha2/view.schema.json` — **Nexus default view (dashboard/views/<view>.yaml)**

### (root)

The repository-provided default layout: where contributed components sit on the canvas and the initial viewport. Versioned with the persona repository. Operator edits never touch this file - they live in a local overlay on the control-plane host, patched over this default at render time. A node ref naming an unknown component is a compile error.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `dashboard.hermes-gitops/v1alpha2` | **yes** | — | Pins the view contract this document was written against; only this exact value is admitted. |
| `kind` | const `NexusView` | **yes** | — | Marks the document as a Nexus view layout, distinguishing it from a NexusContribution file. |
| `metadata` | object | **yes** | — | Identity of the view. |
| `spec` | object | **yes** | — | The layout itself: node placements and the initial viewport. |

#### `metadata`

Identity of the view.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | any | **yes** | — | View identity; the file is conventionally named <id>.yaml. `default` is the view the canvas opens with. |
| `title` | string | no | minLength: 1; maxLength: 200 | Display name of the view; the canvas falls back to a default name when omitted. |

#### `spec`

The layout itself: node placements and the initial viewport.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `nodes` | array of object | **yes** | minItems: 1 | Placements of contributed components, people and groups on the canvas. |
| `viewport` | object | no | — | The pan and zoom the canvas opens with. When omitted, the canvas opens fitted to the whole map. |

##### `spec.nodes[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `ref` | any | **yes** | — | A component, person or group id from the repository's contributions. |
| `position` | object | **yes** | — | Where the node sits on the canvas. |
| `parent` | any | no | — | Group id this node is placed inside. |

###### `spec.nodes[].position`

Where the node sits on the canvas.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `x` | any | **yes** | — | Horizontal canvas coordinate of the node. |
| `y` | any | **yes** | — | Vertical canvas coordinate of the node. |

##### `spec.viewport`

The pan and zoom the canvas opens with. When omitted, the canvas opens fitted to the whole map.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `x` | any | **yes** | — | Horizontal pan offset of the initial viewport. |
| `y` | any | **yes** | — | Vertical pan offset of the initial viewport. |
| `zoom` | number | **yes** | maximum: 10 | Initial zoom factor; 1 renders the canvas unscaled. |

## Example

`agent-bundle-contracts/dashboard-contribution/v1alpha2/examples/contribution/valid-minimal.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# The smallest useful contribution: one agent card for one profile.
apiVersion: dashboard.hermes-gitops/v1alpha2
kind: NexusContribution
metadata:
  id: marketing-research
  title: Marketing Research
spec:
  components:
    - id: marketing-research
      kind: agent
      title: Marketing Research
      bind:
        profile: marketing-research
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/dashboard-contribution/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [nexus](../cli/nexus.md)

