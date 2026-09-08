<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/environment-communication/v1alpha2/communication.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Environment communication

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

> This frozen contract includes historical Discord syntax. Current loaders and runtimes reject Discord integrations; they are roadmap-only. Schema acceptance alone does not establish current provider support.

Written by the **operator** as `environment/communication.yaml`: binds the agents' communication intent to real providers and durable transport. Credential references only; the schema forbids values. In v1alpha2 an absent `inbound` block means deny.

Schema: `agent-bundle-contracts/environment-communication/v1alpha2/communication.schema.json` — **Environment communication configuration (environment/communication.yaml)**

## (root)

The environment-owned half of the communication plane, authored beside environment/topology.yaml. Profiles declare logical intent (outputs, routes, spaces as alias#destination); this file binds it physically: which provider plugin backs each ChatOps connection alias, where its credentials live, and which durable transport carries queued routes. Absent file = communication feature off for the environment; a profile declaring queued routes or ChatOps outputs then fails compilation loudly instead of guessing. Secrets never appear here - only references. In an agent-team repository this file lives at `harness-hg/communication.yaml`; the legacy path stays readable for repositories not yet migrated.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | const `1` | **yes** | — | Environment communication contract version. |
| `chatopsConnections` | object | no | — | Connection aliases routes reference as <alias>#<destination>. The alias is the whole ChatOps configuration surface - no provider-specific fields leak into profile contracts. |
| `durableProvider` | object | no | — | The environment's durable transport. Profiles say only `delivery: {mode: queued}`; this says what physically carries it. |

### `durableProvider`

The environment's durable transport. Profiles say only `delivery: {mode: queued}`; this says what physically carries it.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `plugin` | string | **yes** | pattern: `^[a-z0-9]([-.a-z0-9]*[a-z0-9])?$` | The durable transport plugin backing queued delivery (e.g. redis-streams). The compiler holds each plugin's capability table (queued/fifo/dlq/replay) and refuses a route requiring a capability the plugin lacks - a guarantee is never silently weakened. |
| `config` | object | no | — | Plugin-specific, secret-free configuration (host, stream prefix, retention). Credentials, if any, ride a credentialRef-shaped entry inside - never a literal. |

## Example

`agent-bundle-contracts/environment-communication/v1alpha2/examples/valid-discord-sandbox.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# A sandbox environment binding the alias to the real Discord plugin.
# Two credential forms: an operator-host env var (CLI-side delivery) and
# an in-cluster Secret reference. Values never appear here.
version: 1

chatopsConnections:
  company_discord:
    provider: discord
    credentialRef:
      env: HG_DISCORD_BOT_TOKEN
  company_slack:
    provider: slack
    credentialRef:
      name: company-slack
      key: bot-token

durableProvider:
  plugin: redis-streams
  config:
    streamPrefix: hermes-events
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/environment-communication/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [event](../cli/event.md)
- [chatops](../cli/chatops.md)

