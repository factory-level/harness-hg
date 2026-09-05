<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/communication-deployment/v1alpha1/deployment.schema.json
       agent-bundle-contracts/communication-deployment/v1alpha3/values.schema.json
       agent-bundle-contracts/communication-deployment/v1alpha1/plan.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Communication deployment

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

**Generated** by `hg topology emit` under `deployments/communication/`: one event-router instance record per scope, its operative `values.yaml` configuration, and the whole-plane summary.

## `deployment` (v1alpha1)

Schema: `agent-bundle-contracts/communication-deployment/v1alpha1/deployment.schema.json` — **Event-router deployment record (deployments/communication/<id>/deployment.yaml)**

### (root)

One physical event-router instance, compiler-written, plain values under a single spec block. The router hosts the publisher adapter, delivery worker, session router, ChatOps adapter, and the shared external webhook gateway for its scope - one process, one record. It delivers events TO Hermes agent gateways; it is not one of them.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `spec` | object | **yes** | — | — |

#### `spec`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | minLength: 1 | router, or router@<scope> in multi-scope layouts. |
| `scope` | string | **yes** | minLength: 1 | — |
| `region` | string | no | — | — |
| `target` | string | **yes** | minLength: 1 | — |
| `argoDestination` | string | **yes** | minLength: 1 | — |
| `namespace` | string | **yes** | minLength: 1 | hermes-system, or hermes-system-<scope>. |
| `application` | string | **yes** | minLength: 1 | — |
| `service` | string | **yes** | minLength: 1 | — |

## `values` (v1alpha3)

Schema: `agent-bundle-contracts/communication-deployment/v1alpha3/values.schema.json` — **Event-router configuration (deployments/communication/<id>/values.yaml)**

### (root)

v1alpha3: v1alpha2 plus an OPTIONAL `spec.connections` - the inbound connection gateway: one entry per platform connection (a Discord application, a GitHub App) with the provider, the name of the platform Secret the router mounts, the key that verifies inbound requests, and the ORDERED routes (match rule -> the bound eve agent's channel URL). The router verifies the provider's signature on POST /v1/connect/<provider>/<name>, picks the first matching route, and forwards the request verbatim. v1alpha2: v1alpha1 plus two OPTIONAL top-level environment knobs the emitter writes only when asked - `image` (an environment-specific router image, e.g. a baseline-CPU bun build) and `recordingBase` (the debug-observer/recording sink base URL; the router posts recording-provider ChatOps captures AND sanitized lifecycle records there). Both are chart values, layered by the ApplicationSet exactly like spec. Everything else is unchanged: the router instance's ENTIRE routing configuration, compiler-written; the compiled graph, not the runtime, is the authority on routing, and a payload can never select a destination this file does not declare. Credential REFERENCES only.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `image` | string | no | minLength: 1 | Optional container image override for the router (environment knob, e.g. a baseline-CPU build for pre-AVX2 hosts). Omitted = the chart default. |
| `recordingBase` | string | no | pattern: `^https?://\S+$`; minLength: 1 | Optional debug-observer / recording sink base URL. A URL, never a credential - the sink authenticates nothing and receives metadata only. |
| `spec` | object | **yes** | — | — |

#### `spec`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `router` | object | **yes** | — | — |
| `durableProvider` | object | no | — | — |
| `chatopsConnections` | object | **yes** | — | — |
| `producers` | array of object | **yes** | — | — |
| `externalInputs` | array of object | **yes** | — | — |
| `edges` | array of object | **yes** | — | — |
| `connections` | array of object | no | — | The connection gateway's configuration, compiler-written from environment/connections.yaml. |

##### `spec.router`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | minLength: 1 | — |
| `scope` | string | **yes** | minLength: 1 | — |
| `namespace` | string | **yes** | minLength: 1 | — |
| `service` | string | **yes** | minLength: 1 | — |

##### `spec.durableProvider`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `plugin` | string | **yes** | minLength: 1 | — |
| `config` | object | no | — | — |

##### `spec.producers[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | minLength: 1 | — |
| `name` | string | **yes** | minLength: 1 | — |
| `profile` | string | **yes** | minLength: 1 | — |
| `app` | string | **yes** | minLength: 1 | — |
| `appInstance` | string | **yes** | minLength: 1 | — |
| `output` | string | **yes** | minLength: 1 | — |
| `event` | string | **yes** | minLength: 1 | — |
| `schema` | string | no | — | — |
| `subject` | string | no | — | Payload dot-path the router extracts envelope.subject from. |
| `ingestPath` | string | **yes** | pattern: `^/v1/events/` | — |
| `routes` | array of string | **yes** | — | — |

##### `spec.externalInputs[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | minLength: 1 | — |
| `profile` | string | **yes** | minLength: 1 | — |
| `name` | string | **yes** | minLength: 1 | — |
| `event` | string | **yes** | minLength: 1 | — |
| `schema` | string | no | — | — |
| `subject` | string | no | — | — |
| `provider` | string | no | — | — |
| `verification` | object | **yes** | — | — |
| `accepts` | array of string | no | — | — |
| `hookPath` | string | **yes** | pattern: `^/v1/hooks/` | — |
| `routes` | array of string | **yes** | — | — |

###### `spec.externalInputs[].verification`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `type` | string | **yes** | minLength: 1 | — |
| `secretRef` | object | **yes** | — | — |

####### `spec.externalInputs[].verification.secretRef`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | minLength: 1 | — |
| `key` | string | **yes** | minLength: 1 | — |

##### `spec.edges[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | minLength: 1 | — |
| `route` | string | **yes** | minLength: 1 | — |
| `profile` | string | **yes** | minLength: 1 | — |
| `from` | object | **yes** | — | — |
| `event` | string | **yes** | minLength: 1 | — |
| `filter` | object | no | — | — |
| `kind` | string | **yes** | enum: `agent`, `chatops` | — |
| `agent` | object | no | — | — |
| `chatops` | object | no | — | — |
| `delivery` | any | **yes** | — | — |

###### `spec.edges[].from`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `producer` | string | no | — | — |
| `externalInput` | string | no | — | — |

###### `spec.edges[].agent`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `profile` | string | **yes** | — | — |
| `handler` | string | **yes** | — | — |
| `instance` | string | **yes** | — | — |
| `namespace` | string | **yes** | — | — |
| `service` | string | **yes** | — | — |
| `port` | integer | **yes** | — | — |
| `path` | string | **yes** | — | — |
| `url` | string | **yes** | — | The in-cluster URL of the handler on the target profile's OWN Hermes gateway - the router delivers here, HMAC-signed, and never hosts the handler itself. |
| `signature` | string | **yes** | — | — |
| `secretName` | string | **yes** | — | The instance's env Secret (WEBHOOK_SECRET lives there). A reference - the value never appears in this tree. |
| `session` | object | **yes** | — | — |

####### `spec.edges[].agent.session`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `mode` | string | **yes** | enum: `per-event`, `keyed`, `route` | — |
| `key` | string | no | — | — |

###### `spec.edges[].chatops`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `space` | string | **yes** | — | — |
| `alias` | string | **yes** | — | — |
| `destination` | string | **yes** | — | — |
| `provider` | string | **yes** | — | — |

##### `spec.connections[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | — |
| `provider` | string | **yes** | enum: `discord`, `github` | — |
| `secretName` | string | **yes** | minLength: 1 | The platform Secret (hermes-secrets/<secretName>) the chart mounts at /secrets/connections/<name>/. |
| `verifyKey` | string | **yes** | pattern: `^[A-Z][A-Z0-9_]*$` | The key inside that Secret the gateway verifies with (DISCORD_PUBLIC_KEY, GITHUB_WEBHOOK_SECRET). |
| `routes` | array of object | **yes** | — | — |

###### `spec.connections[].routes[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `profile` | string | **yes** | — | — |
| `url` | string | **yes** | pattern: `^http://` | The bound agent's channel route (in-cluster Service URL). |
| `match` | object | **yes** | — | — |

####### `spec.connections[].routes[].match`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `guilds` | array of string | no | — | — |
| `channels` | array of string | no | — | — |
| `repositories` | array of string | no | — | — |

## `plan` (v1alpha1)

Schema: `agent-bundle-contracts/communication-deployment/v1alpha1/plan.schema.json` — **Communication plan summary (deployments/communication/plan.yaml)**

### (root)

The whole-plane summary: which routers, producers, external inputs, edges, and ChatOps spaces the compiler emitted, and which durable provider backs queued delivery. Inspection surface for hg and doctors - the per-router values.yaml files are the operative configuration.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | const `1` | **yes** | — | — |
| `routers` | array of string | **yes** | — | — |
| `producers` | array of string | **yes** | — | — |
| `externalInputs` | array of string | **yes** | — | — |
| `edges` | array of string | **yes** | — | — |
| `chatopsSpaces` | array of string | **yes** | — | — |
| `durableProvider` | string | no | — | — |

## Example

`agent-bundle-contracts/communication-deployment/v1alpha1/examples/deployment/valid-router.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
spec:
  id: router
  scope: global
  target: in-cluster
  argoDestination: in-cluster
  namespace: hermes-system
  application: hermes-event-router
  service: hermes-event-router
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/communication-deployment/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [event](../cli/event.md)

