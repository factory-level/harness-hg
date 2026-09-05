# 0174 — Slack apps are bootstrap resources, provisioned through the Slack CLI

**Decision.** The bootstrap gains a `SlackWorkspace` stage-3 component and a `slack:`
environment block: one Slack app per declared eve agent, created and installed
through the **official Slack CLI** (`slack install` from a per-app project
directory), channel membership managed declaratively (bots join pinned public
channels themselves via `conversations.join`; unpinned channels are created/adopted
through `@pulumi/slack` under an operator user token). Pod credentials
(`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`) ride the ordinary `agentSecrets`
channel; the agents adopt eve's first-class Slack channel with **portable (env)
credentials**, not Vercel Connect. The design page this changes is
[`_docs/design/chat-surfaces.md`](../design/chat-surfaces.md) (new).

**Reason.** The eve twins are deliberately mute on Discord because a Discord bot
token supports exactly one live gateway session (ADR-154 — the Hermes originals own
theirs). Slack's Events API is plain HTTP webhooks: a twin holding a Slack token
takes nothing from anyone, so Slack is the one chat surface the twins can gain
without touching the Hermes fleet. Two prior assumptions fell during verification,
and both reshaped the design: (1) the platform docs' claim that eve's Slack channel
is "Vercel-Connect-only" is wrong for eve 0.42.0 — the channel reads
`SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` from the environment as a documented,
typed fallback; (2) the assumed "one browser OAuth click per app to mint the bot
token" is wrong when the Slack CLI drives creation — `slack install --team <T>
--environment deployed` creates *and installs* non-interactively (proven live
2026-08-27: three apps in the operator workspace).
The CLI route also retires the app-config-token machinery: the CLI's own
credential pair (one-time `slack login` handshake, in-workspace, no browser)
self-refreshes, where raw manifest-API config tokens expire 12-hourly and
`tooling.tokens.rotate` invalidates its own refresh token.

**Cost.**

- **A host-state dependency.** The per-app Slack CLI project directory
  (`$HERMES_GITOPS_HOME/slack-apps/<agent>/`, whose `.slack/apps.json` records the
  app id) is the idempotency record, and the CLI login lives in the operator's
  `~/.slack/credentials.json`. Neither is in Pulumi state or Git. Losing both the
  directory and the stack state makes a re-run create a duplicate app; the
  `apps.<n>.appId` config slot is the (join/identity-only) recovery tool — an
  adopted app's manifest is deliberately not reconciled.
- **The six secrets are a page copy today** — three bot tokens, three signing
  secrets — from each app's settings page into `agentSecrets.<n>.SLACK_*` (the env
  generator names the exact commands). Two programmatic paths are BUILT and unit-
  tested but **not proven against live Slack**, kept for when the arg shape is
  known or a fourth app appears:
  - `slack_cli sync-bot-token` — fetch the bot token via `apps.developerInstall`
    under the CLI's stored user token, pipe into `pulumi config set --secret` over
    stdin. **Blocked**: `apps.developerInstall` is undocumented and returned
    `invalid_argument` for `{team_id, app_id, set_active}` in a live probe
    (2026-08-27); the CLI's own successful call carries an extra `source` param
    not yet derived. Its refusal names the settings-page fallback.
  - `slack_cli bootstrap-app` — create through `apps.manifest.create` (**this
    call IS proven live**: it returned a new app *with its signing secret* under
    the user token, settling that the signing secret — returned once, at creation
    — is programmatically capturable), install, persist both secrets, then delete
    the old app only after the new one's secrets are safely in pulumi. Gated on
    the same unproven `developerInstall` step. Because recreating an app to
    capture its signing secret still lands the operator on the settings page for
    the bot token, recreation buys nothing until `developerInstall` is cracked —
    so it stays a capability, not the recommended flow.
  Both are operator-run only, never Pulumi resources: mutating stack config
  mid-`up` is wrong by design.
- **Events wait for the edge to be configured, not built.** A manifest carrying an
  Events `request_url` is challenged by Slack at apply, so `slack.eventsReady` ships
  `false` and event subscriptions are withheld from manifests until an endpoint
  answers `url_verification`. The webhook edge itself IS built in this arc:
  `controlPlaneIngress.webhookEndpoints` publishes a **no-Access** Cloudflare
  hostname per webhook (an Access policy of any kind blocks Slack, which cannot
  present a service token, so the signature is the sole auth, verified at the
  origin). What remains is operator configuration — declare a `webhookEndpoints`
  entry and an `eventsUrl` per agent, flip `eventsReady`, `pulumi up` — or a
  throwaway tunnel for the first proof. One hostname per app is forced by eve
  mounting `/eve/v1/slack` at the same path on every agent.
- **Per-user credentials.** Every CLI call acts as whoever ran `slack login` on
  the operator host. This component must never run unattended in CI.
- **Engagement stays voiceless** by decision, preserving its "never contacts
  Calvin directly" contract; its app is a config addition later.
- **The channel self-join path is public-channels-only** (`cant_invite_self` makes
  a user token mandatory for private channels and for kick-enforcement; membership
  is add-only — a human who joined by hand is never removed by a config diff).
- Inherited unchanged from ADR-152's costs: no OAuth broker, no rate limiting at
  the platform edge; and the future `slack` *connection-gateway* provider (the
  declare-once/bind-many model) remains unbuilt — the `SLACK_*` names chosen here
  are the ones that provider would standardize, so migration needs no rename.
