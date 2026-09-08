<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/agent-team/v1alpha1/team.schema.json
       agent-bundle-contracts/agent-team/v1alpha1/agent.schema.json
       agent-bundle-contracts/agent-team/v1alpha1/apps.schema.json
       agent-bundle-contracts/agent-team/v1alpha1/endpoints.schema.json
       agent-bundle-contracts/agent-team/v1alpha1/backup.schema.json
       agent-bundle-contracts/agent-team/v1alpha1/test.schema.json
       agent-bundle-contracts/agent-team/v1alpha1/topology.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Agent team

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

> This frozen contract includes historical Discord syntax. Current loaders and runtimes reject Discord integrations; they are roadmap-only. Schema acceptance alone does not establish current provider support.

Written by the **team** as `harness-hg/*.yaml` at the root and `agents/<harness>/<name>/harness-hg/*.yaml` per agent. `harness-hg/` at any level is exactly what the platform reads. This family holds the shapes that are new: the team identity, the per-agent declaration, the team's apps with their routes, the agent's endpoints with its inbound routes, backup, the test config, and the target-free topology whose cluster half is the environment spec's `grants`.

## `team` (v1alpha1)

Schema: `agent-bundle-contracts/agent-team/v1alpha1/team.schema.json` — **Agent team (harness-hg/team.yaml)**

### (root)

`harness-hg/team.yaml` at an agent-team repository's root - the team's identity, the harnesses it uses, and the contract version every other `harness-hg/*.yaml` in the repo is read under. Written by the team. Read first by `hg validate --dir`, `hg topology plan|emit`, `hg onboard` and the emitter: its presence is what makes a directory an agent-team repository, and `name` is the ONE operational category every agent record, backup, alarm and event route of this repo groups under on Nexus. Absent: the repository is read as the legacy layout (`hermes-gitops.yaml` beside each agent, `environment/` at the root), never as a broken team.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-team/v1alpha1` | **yes** | — | Pins the agent-team contract this document is read under; the CLI refuses versions it does not implement. |
| `kind` | const `AgentTeam` | **yes** | — | Document kind - always AgentTeam. |
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | The team's machine name - the distribution identity every record of this repository carries. DNS-1123 label, at most 40 characters. Supersedes `bundles.yaml` v1alpha4's `distribution.name`; a repo declaring both must agree. |
| `displayName` | string | **yes** | minLength: 1 | The human-facing name Nexus renders for this team. Presentation only - every join uses `name`. |
| `harnesses` | array of string | **yes** | minItems: 1; uniqueItems | Every harness this repository has agents for. Each entry names a directory `agents/<harness>/`; a harness directory not listed here, or a listed harness with no directory, is a validation finding. The values are the platform's declared harness names (`harness/<name>/harness.yaml`). |

## `agent` (v1alpha1)

Schema: `agent-bundle-contracts/agent-team/v1alpha1/agent.schema.json` — **Agent (agents/<harness>/<name>/harness-hg/agent.yaml)**

### (root)

`agents/<harness>/<name>/harness-hg/agent.yaml` - what one agent is to the platform: the harness it runs on (must equal the `<harness>` path segment), the environment variables it requires by name, the capabilities it requires, the layouts it supports, and its pod knobs. Written by the team. Read by the emitter (env contract; the payload it installs is the sibling `src/` directory, which becomes the record's `sourceSubdir`) and the topology compiler (requires, supported layouts). The agent's identity is the `<name>` directory and must equal the payload's own name (`src/package.json` `name` for Eve, `src/distribution.yaml` `name` for Hermes). Absent: the directory is not an agent and is reported as a finding, never deployed half-configured.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-team/v1alpha1` | **yes** | — | Pins the agent-team contract this document is read under; the CLI refuses versions it does not implement. |
| `kind` | const `Agent` | **yes** | — | Document kind - always Agent. |
| `harness` | string | **yes** | enum: `eve`, `hermes` | The harness this agent runs on. A positive declaration (the legacy `runtime.kind` selected Hermes by absence): must equal the `agents/<harness>/` path segment, and must be one of the platform's declared harnesses (`harness/<name>/harness.yaml`). `eve` is the active harness; `hermes` is frozen legacy. |
| `envRequires` | array of any | no | — | Every environment variable the agent needs, including its model credential, by NAME - values are delivered by the platform's env Secret and never written here. Same entry shape as the HermesProfile record's envRequires: a bare string means required and secret. REQUIRED for an Eve agent (there is no other manifest); FORBIDDEN for a Hermes agent, whose `src/distribution.yaml` `env_requires` is the source. |
| `requires` | array of object | no | uniqueItems | Capabilities this profile consumes, by name. The compiler fails on a missing provider (TOPO004) and on an ambiguous one (TOPO005); hardcoded cross-profile URLs are the thing this block deletes. |
| `topology` | object | no | — | What this agent supports, never where it runs - placement is the union of the team's `harness-hg/topology.yaml` and the bootstrap's grants, constrained by these declarations. |
| `deployment` | object | no | — | Agent pod knobs - pod-compute only. baseImageTag is the Hermes image tag (a Hermes profile); runtimeImageTag is the eve-runtime image tag (an Eve agent). Naming the other runtime's tag fails the record validation that follows, never silently. |
| `gitAuthSecretRef` | string | no | minLength: 1 | Name of a Kubernetes Secret in the instance's own namespace holding the credential to clone a PRIVATE spec.source (unchanged from v1). |

#### `requires[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `capability` | any | **yes** | — | Name of the capability this entry consumes. The compiler resolves it against the compiled catalogue - a profile endpoint's provides or an environment-declared binding - and injects the resolved URL. |
| `locality` | string | no | enum: `same-target`, `same-region`, `global` | Where the provider must be relative to this consumer. Default: global. A same-region requirement that resolves outside the region is a compile error - never a silent fallback. |
| `inject` | object | **yes** | — | Exactly one destination for the resolved URL: an agent environment variable, or a dot-path into a declared app's values (resolved after placement, before values are emitted). |
| `optional` | boolean | no | — | An unsatisfied optional requirement is NOT a compile error: the binding simply does not happen and the injection is absent, reported as an info finding rather than TOPO004. Absent means REQUIRED - the same conservative default envRequires applies. The consuming application must tolerate the variable being unset; declaring optional is a claim about the consumer, not the provider. |

##### `requires[].inject`

Exactly one destination for the resolved URL: an agent environment variable, or a dot-path into a declared app's values (resolved after placement, before values are emitted).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `env` | string | no | pattern: `^[A-Z][A-Z0-9_]*$` | Agent environment variable name (convention: HERMES_CAP_<NAME>_URL). Collisions with declared envRequires or another injection are a compile error (TOPO014). |
| `appValue` | object | no | — | A declared app's merged values as the injection destination: the app to target and the dot-path where the resolved URL lands. |

###### `requires[].inject.appValue`

A declared app's merged values as the injection destination: the app to target and the dot-path where the resolved URL lands.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `app` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | Name of an app declared in THIS profile's apps[] (TOPO015 rejects an undeclared app). |
| `path` | string | **yes** | pattern: `^[^.\s]+(\.[^.\s]+)*$` | Dot-path into the app's merged values where the resolved URL lands. |

#### `topology`

What this agent supports, never where it runs - placement is the union of the team's `harness-hg/topology.yaml` and the bootstrap's grants, constrained by these declarations.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `supportedLayouts` | array of string | no | minItems: 1; uniqueItems | Layouts this profile has been designed and validated for. An environment cannot deploy the profile into a layout not listed here (TOPO001). Default when absent: [single]. |
| `agent` | object | no | — | Topology of the agent itself: how many physical instances the compiler creates and the boundary its data may leave. |

##### `topology.agent`

Topology of the agent itself: how many physical instances the compiler creates and the boundary its data may leave.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `multiplicity` | string | no | enum: `singleton`, `per-region`, `per-target` | How many physical agent instances the compiler creates. per-agent is meaningless for the agent itself and is rejected here. Default: singleton. |
| `dataBoundary` | any | no | — | Default: target. |

#### `deployment`

Agent pod knobs - pod-compute only. baseImageTag is the Hermes image tag (a Hermes profile); runtimeImageTag is the eve-runtime image tag (an Eve agent). Naming the other runtime's tag fails the record validation that follows, never silently.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `baseImageTag` | string | no | minLength: 1 | Tag of the Hermes agent container image this instance runs; overrides the platform's image tag for both the bootstrap initContainer and the main container. |
| `runtimeImageTag` | string | no | minLength: 1 | Eve agents only: tag of the eve-runtime container image (Node + the pinned eve CLI) this instance builds and runs with; overrides the platform's pinned tag. |
| `diskSizeGb` | integer | no | minimum: 10 | Size in GiB of the instance's data volume claim. Default when absent: 10. |

## `apps` (v1alpha1)

Schema: `agent-bundle-contracts/agent-team/v1alpha1/apps.schema.json` — **Team apps (harness-hg/apps.yaml)**

### (root)

`harness-hg/apps.yaml` - the team's supporting workloads: one Helm chart each, with the agent that owns it, its typed outputs, and the routes from those outputs. Written by the team. Replaces the per-agent `apps[]` block of `hermes-gitops.yaml`, so a shared singleton (a board, a publisher) is declared once with one owner instead of once per agent. Read by the emitter (folded into `spec.apps` of the owning agent's record) and the topology compiler (app deployment records, chart-source policy, the communication plane). Absent: the team deploys no supporting workloads. Top-level keys starting with `x-` are anchor scratch space, ignored by every reader.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-team/v1alpha1` | **yes** | — | Pins the agent-team contract this document is read under; the CLI refuses versions it does not implement. |
| `kind` | const `Apps` | **yes** | — | Document kind - always Apps. |
| `apps` | array of object | **yes** | uniqueItems | The team's apps, in author order. Each entry becomes one physical app instance per its multiplicity, deployed beside its owning agent. |

#### `apps[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | DNS-label app name, unique across the whole team (two agents cannot each declare the same singleton). |
| `agent` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | The agent that owns and launches this app: a `<name>` directory under `agents/<harness>/`. The app deploys beside that agent's instance, its child Application hangs off that agent's record, and `requires[].inject.appValue.app` in that agent's agent.yaml may target it. |
| `chart` | string | **yes** | minLength: 1 | Chart name in the remote helm repo, or (for `repo: local`) the chart's path inside the platform/GitOps chart tree. |
| `repo` | string | **yes** | pattern: `^(local|https://\S+|oci://\S+)$` | Helm repo URL (https:// or oci://), or the RESERVED WORD `local`. |
| `version` | string | no | minLength: 1 | Chart version. REQUIRED for remote repos; FORBIDDEN for `repo: local`. |
| `values` | object | no | — | Inline chart values - the author's defaults. Fleet defaults and per-instance overrides deep-merge on top; capability injections land last. |
| `valuesRequired` | array of string | no | minItems: 1; uniqueItems | Dot-paths into the merged values the OPERATOR must supply. Validated pre-render. |
| `topology` | object | no | — | This app's instance topology: multiplicity and data boundary. Absent means v1's implicit behaviour (per-agent, target). |
| `endpoints` | array of any | no | uniqueItems | Endpoints this app provides, each backed by a named Kubernetes Service the chart renders. |
| `outputs` | array of any | no | uniqueItems | Typed events this app produces. The compiler generates one publisher-ingest URL per output and injects it at the declared appValue path; communication.routes decide what consumes the event - the app never knows its subscribers. |
| `routes` | array of object | no | uniqueItems | Routes whose source is one of this app's outputs. The compiler folds them into the owning agent's communication routes; a route not declared here does not exist. |

##### `apps[].topology`

This app's instance topology: multiplicity and data boundary. Absent means v1's implicit behaviour (per-agent, target).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `multiplicity` | string | no | enum: `singleton`, `per-region`, `per-target`, `per-agent` | Default: per-agent (one instance paired with every physical agent instance - v1's implicit behaviour). |
| `dataBoundary` | any | no | — | Default: target. |

##### `apps[].routes[]`

One route from an output of THIS app: optional equality filters, a delivery default, and one or more destinations. Routes from external inputs live in the receiving agent's endpoints.yaml, never here.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | DNS-label route name, unique within the file. |
| `from` | object | **yes** | — | The route's single event source - an output of the app this route is declared under. |
| `filter` | object | no | — | Equality filters over declared normalized fields (`subject` or data dot-paths). A route delivers only events matching every entry. Filters select among declared routes - a payload can never CREATE a route. |
| `delivery` | any | no | — | The route's delivery default; individual outputs may override. |
| `outputs` | array of any | **yes** | minItems: 1 | The destinations this route delivers to; each entry is an independent delivery edge. |

###### `apps[].routes[].from`

The route's single event source - an output of the app this route is declared under.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `app` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | Must equal the enclosing app's `name` (the compiler refuses a mismatch). |
| `output` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | An output declared on that app. |

## `endpoints` (v1alpha1)

Schema: `agent-bundle-contracts/agent-team/v1alpha1/endpoints.schema.json` — **Agent endpoints (agents/<harness>/<name>/harness-hg/endpoints.yaml)**

### (root)

`agents/<harness>/<name>/harness-hg/endpoints.yaml` - what this agent makes reachable and what it receives: its typed endpoints (name, port, path, who may consume it), the verified external webhook inputs it accepts, and the routes from those inputs to agent handlers and ChatOps spaces. Written by the team. Read by the topology compiler (endpoint deployment records, capability providers, the communication plane) and the emitter (the Hermes-only `expose` block). Absent: the agent exposes nothing, provides no capability and receives no external input. Top-level keys starting with `x-` are anchor scratch space, ignored by every reader.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-team/v1alpha1` | **yes** | — | Pins the agent-team contract this document is read under; the CLI refuses versions it does not implement. |
| `kind` | const `Endpoints` | **yes** | — | Document kind - always Endpoints. |
| `endpoints` | array of any | no | uniqueItems | The agent's own endpoints (backed by the agent pod - no service field). Replaces v1's expose.services with typed entries; a v1 file's expose block is projected onto this shape during adaptation. |
| `externalInputs` | array of any | no | uniqueItems | Verified external webhook bindings this profile declares. Routes consume them via from.externalInput. |
| `routes` | array of object | no | uniqueItems | Routes whose source is one of this file's externalInputs. The compiler folds them into this agent's communication routes; a route not declared here does not exist. |
| `expose` | object | no | — | HERMES AGENTS ONLY, and only while the destination still deploys agent Service ports from the record's expose block (the endpoints ApplicationSet generator is staged, not promoted): the services the agent pod publishes and the access policy the tunnel ingress applies. Folded verbatim into the HermesProfile record so the rendered record is byte-identical to the legacy contract-v3 authoring. The compiler refuses this block on an Eve agent. Retired together with the legacy generator. |

#### `routes[]`

One route from an external input THIS agent receives: optional equality filters, a delivery default, and one or more destinations. Routes from app outputs live in harness-hg/apps.yaml under the producing app, never here.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | DNS-label route name, unique within the file. |
| `from` | object | **yes** | — | The route's single event source - an entry in this file's externalInputs. |
| `filter` | object | no | — | Equality filters over declared normalized fields (`subject` or data dot-paths). A route delivers only events matching every entry. Filters select among declared routes - a payload can never CREATE a route. |
| `delivery` | any | no | — | The route's delivery default; individual outputs may override. |
| `outputs` | array of any | **yes** | minItems: 1 | The destinations this route delivers to; each entry is an independent delivery edge. |

##### `routes[].from`

The route's single event source - an entry in this file's externalInputs.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `externalInput` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | An entry in externalInputs of THIS file. |

#### `expose`

HERMES AGENTS ONLY, and only while the destination still deploys agent Service ports from the record's expose block (the endpoints ApplicationSet generator is staged, not promoted): the services the agent pod publishes and the access policy the tunnel ingress applies. Folded verbatim into the HermesProfile record so the rendered record is byte-identical to the legacy contract-v3 authoring. The compiler refuses this block on an Eve agent. Retired together with the legacy generator.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `services` | array of object | **yes** | minItems: 1 | The exposed services. Each becomes a named port on the instance's Service and a routing rule on the configured ingress provider. |
| `access` | object | no | — | Access control for the exposed services under the Cloudflare tunnel ingress. |

##### `expose.services[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$` | DNS-label service name; becomes the port's name on the instance's Kubernetes Service. |
| `port` | integer | **yes** | minimum: 1; maximum: 65535 | TCP port on the agent pod this service targets. |
| `path` | string | no | pattern: `^/` | HTTP path prefix routed to this service. Default when absent: /. |

##### `expose.access`

Access control for the exposed services under the Cloudflare tunnel ingress.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `policy` | string | no | enum: `service-token`, `idp`, `mixed` | Who may reach the exposed services: service-token = named machine clients, idp = people via the identity provider, mixed = both. Default when absent: service-token. |

## `backup` (v1alpha1)

Schema: `agent-bundle-contracts/agent-team/v1alpha1/backup.schema.json` — **Agent backup (agents/<harness>/<name>/harness-hg/backup.yaml)**

### (root)

`agents/<harness>/<name>/harness-hg/backup.yaml` - the agent's archive intent: schedule and retention only; the destination is the platform's. Written by the team. Read by the emitter into the record's `spec.backup` and realized as the instance's backup CronJob; `hg backup verify` and `hg platform backup prove` discover it from there. Absent: nothing of this agent's data volume is backed up, and the backup proofs say so.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-team/v1alpha1` | **yes** | — | Pins the agent-team contract this document is read under; the CLI refuses versions it does not implement. |
| `kind` | const `Backup` | **yes** | — | Document kind - always Backup. |
| `schedule` | string | **yes** | minLength: 1 | Cron expression for the CronJob that archives the instance's data volume. |
| `retention` | integer | no | minimum: 1 | How many of the newest archives are kept; older ones are pruned. Default when absent: 7. |

## `test` (v1alpha1)

Schema: `agent-bundle-contracts/agent-team/v1alpha1/test.schema.json` — **Agent dev-loop test config (agents/<harness>/<name>/harness-hg/test.yaml)**

### (root)

`agents/<harness>/<name>/harness-hg/test.yaml` - the dev-loop configuration `hg test` runs the LOCAL loop with: placeholder secret values (never production credentials), app value overrides, deterministic smoke checks, and what `hg reset` may delete. Written by the team. Read by `hg test`, `hg up` and `hg reset` only; nothing in the cluster ever sees it. A placeholder is loudly skipped by proofs, never silently green. Absent: `hg test` runs the harness's built-in tier with no agent-specific checks and no local secret values.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-team/v1alpha1` | **yes** | — | Pins the agent-team contract this document is read under; the CLI refuses versions it does not implement. |
| `kind` | const `AgentTest` | **yes** | — | Document kind - always AgentTest. |
| `appValues` | object | no | — | Per-app value overrides for the local loop, keyed by app name; deep-merged over the declared values exactly as the platform's appValues chain does. |
| `secrets` | object | no | — | LOCAL DEV values for the agent's envRequires, by variable name. Never production credentials; a placeholder is refused by any proof that would call a real service with it. |
| `smoke` | array of object | no | — | Deterministic HTTP smoke checks `hg test` runs after the loop is up. An Eve agent needs none - its smoke tier (pods Ready, /eve/v1/health, one real turn) is built in. |
| `behavioral` | array of any | no | — | Reserved: behavioral cases were declared here before any runner existed and none is implemented. Kept so an authored list is not an unknown-key error; `hg test` ignores it. |
| `pyeval` | string \| null | no | — | Optional path to a Python eval script the local loop runs after smoke. |
| `reset` | object | no | — | What `hg reset` may delete for this agent. |
| `agents` | object | no | — | Reserved for mock agent/MCP declarations. Any `<agent>.mcps` block is REFUSED by `hg test` (mock MCP serving is not implemented) - the key is allowed here so the refusal is loud rather than an unknown-key error. |

#### `smoke[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `service` | string | **yes** | minLength: 1 | The Kubernetes Service to GET, by its real rendered name. |
| `port` | integer | **yes** | minimum: 1; maximum: 65535 | — |
| `path` | string | **yes** | pattern: `^/` | — |
| `expect_contains` | string | **yes** | — | A substring the response body must contain. |

#### `reset`

What `hg reset` may delete for this agent.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `delete_pvcs` | array of string | no | — | PVCs `hg reset` deletes, named so the command is honest about what dies with the namespace. |
| `wipe_namespaces` | array of string | no | — | — |
| `preserve` | array of string | no | — | — |
| `script` | string \| null | no | — | Optional script `hg reset` runs after deleting. |

## `topology` (v1alpha1)

Schema: `agent-bundle-contracts/agent-team/v1alpha1/topology.schema.json` — **Team topology (harness-hg/topology.yaml)**

### (root)

`harness-hg/topology.yaml` - the layout the team is BUILT for, with no cluster names: the selected layout, the sovereignty mode, the regions it expects and which one is the hub. Written by the team. Targets, Argo CD destinations, DNS and policy are the bootstrap's half (`infra/environments/<env>.yaml` `grants`); the topology compiler unions the two and refuses a region granted no target or a grant for an undeclared region (TOPO019). Absent: the team runs the default single layout on the one target the bootstrap grants.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-team/v1alpha1` | **yes** | — | Pins the agent-team contract this document is read under; the CLI refuses versions it does not implement. |
| `kind` | const `Topology` | **yes** | — | Document kind - always Topology. |
| `layout` | string | **yes** | enum: `single`, `replicated`, `hub-spoke` | The selected layout. Must be within every deployed profile's supportedLayouts (TOPO001). single collapses every multiplicity to one instance on the sole target. |
| `sovereignty` | object | no | — | How strictly the compiler polices cross-region data movement and jurisdictions. |
| `hubRegion` | string | no | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | The region whose primary target hosts singleton components (the hub in hub-spoke). Must name a declared region; the bootstrap may override the exact target with `grants.globalTarget`. Required by the compiler whenever any deployed component is a singleton (TOPO002). |
| `regions` | array of object | **yes** | minItems: 1 | The regions the team is designed to fan out across. A region is a jurisdiction boundary; its deployment targets are granted by the bootstrap, never named here. |

#### `sovereignty`

How strictly the compiler polices cross-region data movement and jurisdictions.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `mode` | string | no | enum: `permissive`, `strict` | permissive: cross-region bindings allowed but every one is labelled in the plan. strict: any cross-region dependency, stretched regional data boundary, or disallowed jurisdiction is a compile ERROR (TOPO006/TOPO007/TOPO012). Default: permissive. |

#### `regions[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | DNS-label region name; becomes the <scope> of per-region instances. |
| `jurisdiction` | string | **yes** | minLength: 2 | Legal jurisdiction of every target the bootstrap grants this region (e.g. CA, EU). Checked against the bootstrap's policy allowedJurisdictions (TOPO007). |

## Example

`agent-bundle-contracts/agent-team/v1alpha1/examples/team/valid-two-harnesses.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# A team mid-migration: Hermes personas beside their Eve twins.
apiVersion: hermes-gitops.factorylevel.dev/agent-team/v1alpha1
kind: AgentTeam
name: marketing
displayName: Marketing Team
harnesses: [eve, hermes]
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/agent-team/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [bundle](../cli/bundle.md)
- [topology](../cli/topology.md)
- [validate](../cli/validate.md)
- [repo scaffolds](../repo-scaffolds.md)

