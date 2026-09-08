# Chat surfaces

What the system should be: every agent that is meant to converse has a chat
surface whose **identity, credentials, and membership are declared, provisioned,
and reconciled by the platform** — never hand-assembled in a provider console.

Operational teams initiate scheduled check-ins and decision requests through that
surface. The team owns its durable occurrences, task state and approval policy; the
platform owns runtime, declared bindings and provider registration. Delivery health
must include confirmed messages and overdue work, not merely running pods. Interactive
approval callbacks must be provisioned alongside message subscriptions. See ADR 0181.

- **One app registration per agent, per provider.** An agent's chat identity (its
  handle, avatar, scopes) is a platform-provisioned resource keyed to the agent's
  instance name. Provisioning is idempotent and survives re-runs without minting
  duplicates.
- **Slack is the supported chat provider.** Discord, Teams and Telegram are roadmap
  capabilities, not active integrations. GitHub event connections remain a separate
  non-chat capability. A surface is granted per agent by declaration.
- **Operational alerts use the declared chat provider.** Outbound Slack delivery uses a bot
  credential reference and a channel ID, records a provider message ID only after Slack
  confirms acceptance, and retains failed attempts in the delivery policy (ADR 0183). Agent
  webhook signing keys follow the receiving runtime namespace.
- **Membership is declarative.** Which bots sit in which channels is environment
  configuration; reconciliation adds missing members and never removes humans.
- **Credentials are captured at provisioning, never copied.** The platform mints
  the app's credentials in the same motion that creates the app, and their
  durable home is the platform's own encrypted state — a human clipboard never
  carries a signing secret or bot token. They reach the pod through the one
  secret channel (state/config → the per-agent env Secret → `envFrom`), with the
  same names the future connection-gateway provider (ADR-152's third tier) would
  standardize, so graduating a per-agent surface to a declare-once/bind-many
  connection is a migration, not a rename.
- **Inbound events reach the agent over public HTTPS** through a webhook hostname
  whose authentication is the provider's request signature — not an
  identity-gated edge that webhook senders cannot sign into. Event subscriptions
  attach only when the receiving pod already holds the credentials to answer the
  provider's verification challenge.

Decisions: [0174](../adr/0174-slack-workspace.md) (Slack apps as bootstrap
resources), [0175](../adr/0175-slack-app-secrets-in-state.md) (credentials as
provision outputs in encrypted state; supersedes 0174's operator-run secret
copy).
