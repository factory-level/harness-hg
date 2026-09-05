<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/environment-connections/v1alpha1/connections.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Environment connections

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Written by the **team** as `harness-hg/connections.yaml` (`kind: Connections`): one third-party app registration per connection, declared once and bound to agents. No secret is in the file. The keys live in one platform Secret, `hermes-secrets/connection-<name>`, projected into every bound agent and mounted by the event router, whose gateway verifies the provider's signature on `/v1/connect/<provider>/<name>`.

Schema: `agent-bundle-contracts/environment-connections/v1alpha1/connections.schema.json` — **Platform connections**

## (root)

Operator-authored, deployment-neutral catalogue of third-party app registrations (a Discord application + bot, a GitHub App) and the profiles they are granted to. A connection is declared ONCE; its secret material lives in one platform Secret `hermes-secrets/connection-<name>` (never in this file), projected into every bound profile's namespace as `<instance>-connection-<name>` and mounted by the event router, whose gateway verifies the provider's signature on `POST /v1/connect/<provider>/<name>` and forwards the request verbatim to the bound profile chosen by the binding's match rule. A profile bound to no connection receives nothing. In an agent-team repository this file lives at `harness-hg/connections.yaml`; the legacy path stays readable for repositories not yet migrated.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes.gitops/v1alpha1` | **yes** | — | Contract identifier this document is validated against; unknown versions are refused loudly. |
| `kind` | const `Connections` | **yes** | — | Document kind - always Connections. |
| `connections` | array of object | **yes** | minItems: 1 | The catalogue. Declaring a connection grants nothing: a profile receives its credentials and its inbound traffic only through a binding. |

### `connections[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | any | **yes** | — | The connection's identity: the platform Secret is connection-<name>, the gateway route is /v1/connect/<provider>/<name>, the projected Secret is <instance>-connection-<name>. |
| `provider` | string | **yes** | enum: `discord`, `github` | Which provider the connection is an app registration with. Decides the secret keys the platform Secret must carry (discord: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY; github: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_APP_SLUG), the gateway's verification scheme (discord: Ed25519 over timestamp+body; github: HMAC-SHA256 X-Hub-Signature-256), the agent route the gateway forwards to (/eve/v1/<provider>), and the match vocabulary. |
| `bindings` | array of object | **yes** | minItems: 1 | Which profiles receive this connection, and which inbound traffic each one is routed. A profile may appear once per connection. Order matters only when match rules overlap: the first match wins. |

#### `connections[].bindings[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `profile` | any | **yes** | — | The bound profile (an installed record's name). |
| `match` | object | no | — | The inbound routing rule. Absent or empty = catch-all (every inbound request the gateway verifies for this connection that no earlier binding matched). discord: guilds and/or channels by snowflake id; github: repositories by owner/name. |

##### `connections[].bindings[].match`

The inbound routing rule. Absent or empty = catch-all (every inbound request the gateway verifies for this connection that no earlier binding matched). discord: guilds and/or channels by snowflake id; github: repositories by owner/name.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `guilds` | array of any | no | minItems: 1; uniqueItems | — |
| `channels` | array of any | no | minItems: 1; uniqueItems | — |
| `repositories` | array of any | no | minItems: 1; uniqueItems | — |

## Example

`agent-bundle-contracts/environment-connections/v1alpha1/examples/connections/valid-full.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# Two connections, routed: the Discord bot's interactions from one guild go
# to echo and everything else to greeter; the GitHub App's webhooks from one
# repository go to echo.
apiVersion: hermes.gitops/v1alpha1
kind: Connections

connections:
  - name: company-discord
    provider: discord
    bindings:
      - profile: echo
        match:
          guilds: ["123456789012345678"]
      - profile: greeter
  - name: platform-github
    provider: github
    bindings:
      - profile: echo
        match:
          repositories: ["factory-level/hermes-gitops-plugin"]
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/environment-connections/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [connection](../cli/connection.md)

