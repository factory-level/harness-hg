<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/harness-declaration/v1alpha1/harness.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Harness declaration

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

What a harness declares about itself, one file per harness at `harness/<name>/harness.yaml`. The gateway declaration is mandatory: the platform ships no universal gateway, so every harness states how its agents reach a model. `hg validate` fails a registered harness with no declaration.

Schema: `agent-bundle-contracts/harness-declaration/v1alpha1/harness.schema.json` — **HarnessDeclaration**

## (root)

What a harness declares about itself to the platform. One file per harness at harness/<name>/harness.yaml. The gateway declaration is mandatory: the platform ships no universal gateway, so every harness must state how its agents are reached for model connectivity — natively (the harness ships its own), through an external service, or not at all. Descriptive and validated, never a second configuration language.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `contract` | const `harness-declaration/v1alpha1` | **yes** | — | — |
| `spec` | object | **yes** | — | — |

### `spec`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z][a-z0-9-]{0,30}$` | The harness's registry name — must match its directory under harness/ and the runtime key the CLI dispatches on. |
| `status` | string | no | enum: `active`, `frozen-legacy` | frozen-legacy: works, gains nothing; see the harness's README for the freeze terms. |
| `gateway` | object | **yes** | — | — |

#### `spec.gateway`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `kind` | string | **yes** | enum: `native`, `external-service`, `none` | native: the harness ships its own gateway. external-service: model connectivity resolves through a named external gateway. none: the harness makes no model connections. |
| `provider` | object | no | — | — |

##### `spec.gateway.provider`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | minLength: 1 | The external gateway, e.g. vercel-ai-gateway. |
| `notes` | string | no | — | How selection/config flows through it — prose, for the reader. |

## Example

`agent-bundle-contracts/harness-declaration/v1alpha1/examples/valid-eve.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# The Eve harness: model connectivity resolves through the Vercel AI
# Gateway.
contract: harness-declaration/v1alpha1
spec:
  name: eve
  status: active
  gateway:
    kind: external-service
    provider:
      name: vercel-ai-gateway
      notes: model/provider selection flows through gateway config via the AI SDK, not hand-rolled plumbing.
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/harness-declaration/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [validate](../cli/validate.md)

