<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/topology-plan/v1alpha1/plan.schema.json
       agent-bundle-contracts/topology-plan/v1alpha3/deployment.schema.json
       agent-bundle-contracts/topology-plan/v1alpha1/provenance.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Topology plan

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

**Generated** by `hg topology emit`. `deployments/plan.yaml` is the fleet summary and carries `inputsHash`, the staleness signal the doctors compare. `deployments/{agents,apps,endpoints}/<id>/deployment.yaml` is one physical instance. `catalog/profiles/<name>/provenance.yaml` sits beside the verbatim contract copy.

## `plan` (v1alpha1)

Schema: `agent-bundle-contracts/topology-plan/v1alpha1/plan.schema.json` — **Whole-fleet plan summary (deployments/plan.yaml)**

### (root)

The compiler's summary of one atomic regeneration, written LAST: instance and binding tables plus inputsHash - sha256 over every input file (authored contracts + environment files), the staleness signal `hg topology doctor` and `hg status` compare against a recomputation. Staleness is detected, never scheduled.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | const `1` | **yes** | — | — |
| `layout` | string | **yes** | enum: `single`, `replicated`, `hub-spoke` | — |
| `sovereignty` | string | **yes** | enum: `permissive`, `strict` | — |
| `inputsHash` | string | **yes** | pattern: `^[0-9a-f]{64}$` | — |
| `agents` | array of string | **yes** | — | — |
| `apps` | array of string | **yes** | — | — |
| `bindings` | array of object | **yes** | — | — |
| `environment` | object | no | — | — |

#### `bindings[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `capability` | string | **yes** | — | — |
| `consumer` | string | **yes** | — | — |
| `provider` | string | **yes** | — | — |
| `url` | string | **yes** | — | — |
| `crossRegion` | boolean | **yes** | — | — |

#### `environment`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `synthesized` | boolean | no | — | — |

## `deployment` (v1alpha3)

Schema: `agent-bundle-contracts/topology-plan/v1alpha3/deployment.schema.json` — **Physical deployment record (deployments/{agents,apps,endpoints}/<id>/deployment.yaml)**

### (root)

One physical instance, compiler-written, plain values under a single spec block (the platform's record convention - no CRD envelope). The three variants share the shape: agents carry no app/source/endpoints; apps carry app + source; endpoint records carry the endpoints list a hermes-endpoint chart release will consume. Names are FINAL here - the compiler owns naming, ApplicationSet templates stay dumb. v1alpha2: agent records may carry the installed distribution identity (`spec.distribution`) - the operational category Nexus groups the agent under beside the Harness Hg control plane, declared in the persona repository's bundles.yaml v4 and stamped by the compiler. v1alpha3: agent records carry the agent runtime (`spec.runtime`) and the platform chart that realizes it (`spec.chart`); the agents ApplicationSet templates its chart path from `spec.chart` and falls back to hermes-profile for records emitted before this version.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `spec` | object | **yes** | — | — |

#### `spec`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | minLength: 1 | Logical instance id (<profile>@<scope>, apps <profile>/<app>@<scope>; elided forms in the single layout). |
| `profile` | string | **yes** | minLength: 1 | — |
| `app` | string | no | — | App instances only. |
| `component` | string | no | — | Endpoint records only: agent, or the app name. |
| `scope` | string | **yes** | minLength: 1 | global | region name | target name |
| `region` | string | no | — | — |
| `target` | string | **yes** | minLength: 1 | — |
| `argoDestination` | string | **yes** | minLength: 1 | Registered Argo CD cluster name - the ApplicationSet destination. Never hardcoded. |
| `namespace` | string | no | — | Agent/app records. |
| `application` | string | no | — | Final Argo Application name (agent/app records). |
| `runtime` | string | no | enum: `hermes`, `eve` | Agent records: the agent runtime this instance runs on. hermes = the legacy runtime (distribution.yaml manifest); eve = an Eve project. |
| `chart` | string | no | enum: `hermes-profile`, `eve-agent` | Agent records: the platform chart under infra/charts/ that realizes the runtime. Stamped by the compiler so the ApplicationSet stays dumb: `infra/charts/{{ .spec.chart }}`. |
| `pairedAgent` | string | no | — | per-agent apps: the owning agent instance id. |
| `source` | object | no | — | App records: Argo-ready chart coordinates, local->platform-path or OCI-scheme-stripped remote. |
| `endpoints` | array of object | no | minItems: 1 | Endpoint records: every endpoint of this component instance. |
| `distribution` | object | no | — | Agent records: the installed distribution's declared identity (bundles.yaml v4). name is the stable machine id; displayName the human-facing category title. |

##### `spec.source`

App records: Argo-ready chart coordinates, local->platform-path or OCI-scheme-stripped remote.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repo` | const `local` | no | — | — |
| `path` | string | no | — | — |
| `repoURL` | string | no | — | — |
| `chart` | string | no | — | — |
| `targetRevision` | string | no | — | — |

##### `spec.endpoints[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | — | — |
| `type` | string | **yes** | enum: `internal`, `private`, `authenticated`, `public`, `webhook`, `external` | — |
| `internalUrl` | string | **yes** | — | — |
| `url` | string | no | — | — |
| `provides` | string | no | — | — |
| `backend` | object | no | — | Explicit backend routing for the hermes-endpoint chart - service + namespace + port + path, never parsed out of a URL. Optional in the schema for records emitted before it existed; the chart REFUSES to render an endpoint without it, naming the fix (regenerate with a current emit). |

###### `spec.endpoints[].backend`

Explicit backend routing for the hermes-endpoint chart - service + namespace + port + path, never parsed out of a URL. Optional in the schema for records emitted before it existed; the chart REFUSES to render an endpoint without it, naming the fix (regenerate with a current emit).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `service` | string | **yes** | minLength: 1 | — |
| `namespace` | string | **yes** | minLength: 1 | — |
| `port` | integer | **yes** | minimum: 1; maximum: 65535 | — |
| `path` | string | **yes** | pattern: `^/` | — |

##### `spec.distribution`

Agent records: the installed distribution's declared identity (bundles.yaml v4). name is the stable machine id; displayName the human-facing category title.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | no | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; minLength: 1; maxLength: 40 | — |
| `displayName` | string | **yes** | pattern: `\S`; minLength: 1; maxLength: 80 | — |

## `provenance` (v1alpha1)

Schema: `agent-bundle-contracts/topology-plan/v1alpha1/provenance.schema.json` — **Catalogue provenance record (catalog/profiles/<name>/provenance.yaml)**

### (root)

Provenance beside the verbatim contract copy. The catalogue is TWO plain files per profile: contract.yaml is the authored hermes-gitops.yaml copied byte-for-byte (comments, line endings, everything - validated by the authoring schemas, not here), and this file records where it came from. No YAML embedding, so the TypeScript and Python emitters produce identical bytes with no shared serializer.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `profile` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | The profile name (distribution.yaml name) - also the directory name, which is the record's identity. |
| `sourceSha` | string | **yes** | pattern: `^[0-9a-f]{40}$` | The source commit the contract was read at (all zeros for an uncommitted local preview). |

## Example

`agent-bundle-contracts/topology-plan/v1alpha1/examples/plan/valid-plan.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
version: 1
layout: hub-spoke
sovereignty: permissive
inputsHash: "0000000000000000000000000000000000000000000000000000000000000000"
agents: [marketing-manager@ca-west]
apps: [marketing-manager/content-kanban@global]
bindings:
  - capability: content-board
    consumer: marketing-manager@ca-west
    provider: marketing-manager/content-kanban@global#api
    url: http://content-kanban.ns.svc.cluster.local:80/api
    crossRegion: false
environment:
  synthesized: false
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/topology-plan/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [topology](../cli/topology.md)

