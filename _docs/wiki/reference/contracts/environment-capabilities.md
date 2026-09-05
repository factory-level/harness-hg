<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/environment-capabilities/v1alpha1/capabilities.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Environment capabilities

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Written by the **operator** as `environment/capabilities.yaml`: the capabilities the environment provides, bound to implementations. An agent's `requires[]` names a capability; a provider is either a peer agent's endpoint or an entry here.

Schema: `agent-bundle-contracts/environment-capabilities/v1alpha1/capabilities.schema.json` — **EnvironmentCapabilities**

## (root)

Operator-authored environment/capabilities.yaml (#144): capabilities the ENVIRONMENT provides, bound to implementations it provisioned. The other half of the capability model - a profile's requires[] names a capability; a provider is either a peer profile's endpoint (provides:) or an entry here. A capability satisfied by BOTH is TOPO005 (ambiguous), never a precedence rule: two sources of truth for one URL is a conflict to resolve, not to rank. Consumed by the topology compiler; the resolved URL materializes through the same injection path as endpoint-provided capabilities. In an agent-team repository this file lives at `harness-hg/capabilities.yaml`; the legacy path stays readable for repositories not yet migrated.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | const `1` | **yes** | — | Environment capabilities contract version. |
| `bindings` | object | **yes** | — | Capability name -> the implementation serving it. The name is the whole contract: consumers cite it in requires[] and never learn what implements it. |

## Example

`agent-bundle-contracts/environment-capabilities/v1alpha1/examples/valid-minimal.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# The smallest useful file: one globally-reachable environment-provided
# capability. Consumers declare `requires: [{capability: sentiment-feed, ...}]`
# and never learn what implements it.
version: 1
bindings:
  sentiment-feed:
    implementation: external-sentiment-api
    url: https://sentiment.example.net/v1
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/environment-capabilities/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).

