<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/environment-bundles/v1alpha4/bundles.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Environment bundles

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Written by the **team** as `harness-hg/bundles.yaml`: which agents share one pod. The bundles generator matches nothing until this file exists.

Schema: `agent-bundle-contracts/environment-bundles/v1alpha4/bundles.schema.json` — **Hermes profile bundle declarations**

## (root)

Operator-authored grouping of installed profile records into shared Hermes runtime pods. Profile distributions remain independent harnesses; the bundle owns compute, the shared HERMES_HOME volume, and placement. v1alpha4 adds the top-level `distribution` identity - the installed distribution this repository IS, the category every operational surface groups by beside the Harness Hg control plane - and makes `bundles` optional (a per-profile topology declares only its distribution). v1alpha3 added per-bundle displayName; the #365 repository-field retirement carries forward. In an agent-team repository this file lives at `harness-hg/bundles.yaml`; the legacy path stays readable for repositories not yet migrated.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | const `4` | **yes** | — | Environment bundles contract version. A document names its own version and is validated against exactly that contract; this schema pins version 4. |
| `bundles` | array of object | no | minItems: 1 | Shared-pod bundle declarations. Optional since v4: a per-profile topology declares only its distribution identity and ships no bundles. |
| `distribution` | object | no | — | The installed distribution's identity (the "agent bundle distribution bootstrap contract"): the ONE category this repository's agents, backups, alarms and event routes group under on operational surfaces, beside the Harness Hg control plane. `name` is the stable machine id (defaults to the repository stem); `displayName` is the human-facing title ("Marketing Team"). Compiled into every agent deployment record. |

### `bundles[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | any | **yes** | — | The bundle's machine identity - the join key everywhere, and the stem of its default namespace and Application names (hermes-<name>). |
| `displayName` | string | no | pattern: `\S`; minLength: 1; maxLength: 80 | Human-facing Bundle title (e.g. "Marketing Team"). Presentation only - never a join key; the machine identity stays `name`. |
| `profiles` | array of object | **yes** | minItems: 1 | The installed profile records sharing this bundle's pod. Each stays an independent Hermes harness; a profile may belong to at most one bundle. |
| `placement` | object | no | — | Where the bundle deploys. Every field defaults to the single-cluster case; a non-global scope yields the instance id <name>@<scope>. |
| `deployment` | object | no | — | Compute and storage sizing for the shared bundle pod. |
| `dashboard` | object | no | — | The optional shared web dashboard container served from the bundle pod. |

#### `bundles[].profiles[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | any | **yes** | — | Name of an installed profile record (profiles/<name>/profile.yaml). default is reserved by Hermes and refused. |
| `envSecretRef` | any | no | — | Kubernetes Secret in the bundle's namespace carrying this profile's environment variables. The compiler requires it when the record declares envRequires - the old per-profile Secret cannot be mounted across namespaces. |
| `gitAuthSecretRef` | any | no | — | Kubernetes Secret in the bundle's namespace carrying the Git credential for this profile's private distribution - the record's gitAuthSecretRef Secret copied into the bundle namespace. |
| `gatewayEnabled` | boolean | no | — | Whether the bundle pod runs this profile's Hermes gateway container. The compiler requires at least one enabled gateway or the shared dashboard per bundle. |
| `apiServerPort` | integer | no | minimum: 1; maximum: 65535 | Port this profile's Hermes API server listens on inside the shared pod, published through the bundle Service. Setting it enables the API server at boot and requires an envSecretRef carrying API_SERVER_KEY; ports must be unique across the bundle. |
| `webhookPort` | integer | no | minimum: 1; maximum: 65535 | The port this profile's Hermes gateway serves its declared webhook endpoints on. Required for a bundled profile that any communication route TARGETS: bundling retires the per-profile namespace and Service the router would otherwise address, so without this the edge has nowhere to send. Fail-closed - a route to a bundled profile with no webhookPort refuses to compile rather than silently resolving to a dead URL. |
| `terminalCwd` | string | no | pattern: `^/` | Absolute working directory the profile's terminal opens in, applied at boot via hermes config set terminal.cwd. |

#### `bundles[].placement`

Where the bundle deploys. Every field defaults to the single-cluster case; a non-global scope yields the instance id <name>@<scope>.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `scope` | string | no | minLength: 1 | Placement scope of the bundle instance; global (the default) yields the bare bundle name as its id. |
| `target` | string | no | minLength: 1 | Declared topology target the bundle lands on. |
| `argoDestination` | string | no | minLength: 1 | Name of the registered Argo CD cluster the bundle's Application deploys to (in-cluster for the control-plane cluster). |
| `namespace` | string | no | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 63 | Namespace the bundle pod and its Secrets live in. Defaults to hermes-<name>. |
| `application` | string | no | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 63 | Name of the bundle's Argo CD Application. Defaults to hermes-<name>. |

#### `bundles[].deployment`

Compute and storage sizing for the shared bundle pod.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `baseImageTag` | string | no | minLength: 1 | Overrides the platform's Hermes agent image tag for this bundle's pod. |
| `diskSizeGb` | integer | no | minimum: 10 | Size in GiB of the bundle's shared HERMES_HOME volume claim. |
| `workspaceSizeGb` | integer | no | minimum: 1 | Size in GiB of the bundle's shared workspaces volume claim. |

#### `bundles[].dashboard`

The optional shared web dashboard container served from the bundle pod.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `enabled` | boolean | no | — | Whether the bundle pod runs the shared dashboard container. |
| `port` | integer | no | minimum: 1; maximum: 65535 | Port the dashboard listens on inside the pod, published through the bundle Service. |
| `envSecretRef` | any | no | — | Kubernetes Secret in the bundle's namespace carrying the dashboard's environment, including its authentication provider's credentials. Required when enabled. |

### `distribution`

The installed distribution's identity (the "agent bundle distribution bootstrap contract"): the ONE category this repository's agents, backups, alarms and event routes group under on operational surfaces, beside the Harness Hg control plane. `name` is the stable machine id (defaults to the repository stem); `displayName` is the human-facing title ("Marketing Team"). Compiled into every agent deployment record.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | any | no | — | Stable machine id of the distribution. Defaults to the repository stem when absent. |
| `displayName` | string | **yes** | pattern: `\S`; minLength: 1; maxLength: 80 | Human-facing distribution title (e.g. Marketing Team). Presentation only - grouping joins on name. |

## Example

`agent-bundle-contracts/environment-bundles/v1alpha4/examples/bundles/valid-distribution-and-bundle.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# Distribution identity beside a runtime pod bundle: the two are
# different concepts - the distribution is the installed unit's identity,
# the bundle a compute decision inside it.
version: 4
distribution:
  displayName: Marketing Team
bundles:
  - name: marketing-core
    displayName: Marketing Core
    profiles:
      - name: manager
        envSecretRef: hermes-marketing-manager-env
        apiServerPort: 8642
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/environment-bundles/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).

