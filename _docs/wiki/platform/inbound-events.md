# Inbound events

**What this page tells you:** the three ways an event enters the platform, and what checks
each one.

## The three doors

| Door | For | Declared as | Checked by |
|---|---|---|---|
| `/v1/events/<slug>` | a workload inside the platform publishing its own output | an `outputs[]` entry on an app | in-cluster only |
| `/v1/hooks/<slug>` | something outside pushing in | `communication.externalInputs[]` | HMAC-SHA256, or GitHub's header shape |
| `/v1/connect/<provider>/<name>` | a third-party app calling back (GitHub App today) | `harness-hg/connections.yaml` | the provider's own signature |

All three are routes on the event router. The first two enter the queue. The third is
synchronous: it verifies, routes and forwards to the agent, and returns the agent's answer.

## The path

```text
provider or workload → webhook (tunnel, no-Access hostname) → event router → queue → agent
```

External callers reach the router over a published hostname that has no access policy in
front of it, because a machine cannot sign in. The request signature verified at the origin
is the whole authentication. See [Webhooks](webhooks.md).

## External inputs

Each external input declares a signature scheme and a `secretRef` naming the credential. A
request that fails verification is refused, and nothing of the payload is echoed back. Give
each input its own secret. Two inputs on one secret means revoking either revokes both.

## Connections

A **connection** is one third-party app registration, declared once and bound to agents:

```yaml
apiVersion: hermes.gitops/v1alpha1
kind: Connections
connections:
  - name: platform-github
    provider: github
    bindings:
      - profile: echo
        match: { repositories: ["factory-level/harness-hg"] }
```

No secret is in the file. The keys live in one platform Secret,
`hermes-secrets/connection-<name>`, written with `hg connection set` (see
[Secrets](secrets.md)). Each bound agent gets the keys projected into its environment.

The gateway route for a connection:

1. verifies the provider's signature and refuses forged requests;
2. answers the provider's liveness ping itself;
3. routes by the binding's match rule, first match wins, empty match is the catch-all;
4. forwards the raw bytes to the agent's channel route and returns the agent's response.

The agent verifies the signature again with its own copy of the key. No trust is placed in
the hop.

## Proof

```bash
hg connection prove     # CONN001..004
hg event ingress test   # a signed push through /v1/hooks
```

## Where to go next

- [Event routing](webhooks-events.md), routes and durability
- [Outbound events](outbound-events.md), how a delivery leaves
- [Webhooks](webhooks.md), the hostnames that let a provider in
