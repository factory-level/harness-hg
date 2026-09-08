# communication-plane — the ADR-39 reference fixture

The smallest repository that exercises the whole communication plane, and the
harness `hg communication prove` runs against. Two personas:

- **platform-sre** — subscribes: `observability.alert/v1` from its monitoring
  app fans out to its own gateway handler (`/webhooks/alerts`, durable FIFO by
  subject, keyed incident session) and to two ChatOps spaces
  (`company_chat#channel-1`, `#channel-2`). Also declares one external
  webhook binding (`demo-alert-source`, HMAC-verified) on the shared gateway.
- **unrelated-sre** — the isolation control: same shape, same gateway surface,
  **no subscription**. The proof asserts it receives nothing.

Environments:

- `environment/communication.yaml` — the local default: `company_chat`
  rebound to the **recording** provider (messages are captured, never sent),
  durable transport `redis-streams`.
- `environments/slack-sandbox/` — the same routes with `company_chat`
  bound to the **real Slack plugin**; the bot token comes from the
  `HG_SLACK_BOT_TOKEN` env var (a reference — never committed).

The quick tour (after the full stack has landed):

```bash
hg onboard examples/communication-plane && hg up
hg event plan observability.alert --json
hg event publish observability.alert --from platform-sre/monitoring#alerts \
  --payload examples/communication-plane/fixtures/alert-firing.json --json
hg chatops tail company_chat#channel-1 --json
hg event queue test observability.alert --ordering-key incident-42 --count 3 --json
hg event ingress test demo-alert-source \
  --payload examples/communication-plane/fixtures/external-alert.json --signature valid --json
hg communication prove --dir examples/communication-plane --json
```

The communication plane delivers events **to** each profile's own Hermes
gateway — it is not a replacement for the gateway, and no profile's webhook is
ever publicly exposed (external senders hit the one shared `/v1/hooks/<id>`
surface).
