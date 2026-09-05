# 0175 — Slack app secrets are provision-Command outputs in encrypted Pulumi state

**Decision.** The `SlackWorkspace` component provisions each non-adopted app
through the **raw manifest API inside `pulumi up`**: a per-app provision
`local.Command` (`slack_cli provision-app`) whose CREATE runs
`apps.manifest.create` — the one call that ever returns the **signing secret** —
followed by `apps.developerInstall` for the **bot token**, and whose
secret-marked stdout (`additionalSecretOutputs: ["stdout"]`) makes the
encrypted, GCS-backed Pulumi state the durable home of both credentials. On
UPDATE runs the prior stdout returns as `PULUMI_COMMAND_STDOUT`
(@pulumi/command ≥1.x): the manifest updates in place, the bot token refreshes
from a new install, and the signing secret — unfetchable after creation —
carries forward. `AgentSecrets` consumes the component's `secrets` output as
per-instance `extraSecrets` merged over config `agentSecrets` (resource output
wins), so the credentials flow state → env Secret → `envFrom` → pod with **no
hand-pasted ciphertext anywhere**; the six `agentSecrets.<n>.SLACK_*` config
markers are deleted, and `validatePrerequisites` refuses a config-sourced
`SLACK_*` for a provisioned app (two sources of truth). Event subscriptions
attach in a **second Command** (`wireEvents`, `slack_cli apply-manifest`)
ordered `dependsOn` the agent's `agent-secrets-roll`: the CREATE strips
`settings.event_subscriptions`, and the full manifest applies only once the pod
is running the new signing secret — so Slack's `url_verification` challenge
always meets a pod that can answer it. Acceptance is `hg slack prove`
(SLK001..004). The design page this changes is
[`_docs/design/chat-surfaces.md`](../design/chat-surfaces.md).

**Reason.** ADR 0174 left the six pod credentials as a settings-page copy, and
one week of operating that flow produced three shipped credential faults (#770
empty strings from a non-tty paste, #771/#772 wrong-value pastes — the manager
twin's signing secret was still wrong when this work started). The blocker that
forced hand-copying is gone: the Slack CLI is open source, and its
`DeveloperAppInstall` (slack-cli `internal/api/app.go`) shows the working
`apps.developerInstall` shape — a **JSON body** `{"app_id", "bot_scopes":
[...], "outgoing_domains": [...]}` with `team_id` omitted off-Enterprise and no
`set_active`; the 2026-08-27 probe's `invalid_argument` was our guessed
`{team_id, app_id, set_active}` form encoding, and the response's
`api_access_tokens.bot` **is** the xoxb. That unblocks programmatic capture of
both credentials, and 0174's "operator-run only, never Pulumi resources" stance
does not apply to this shape: its objection was mutating **stack config**
mid-`up`, which resource outputs never do. With capture inside the same
`pulumi up` that delivers the env Secret and rolls the pod, a new twin's entire
Slack surface — app, secrets, channel membership, events — is one spec edit +
one `pulumi up`, and the mispaste failure class is structurally gone.

**Cost.**

- **`pulumi up` now talks to Slack.** Stage-3 slack acquires a network + login
  dependency (`~/.slack/credentials.json`, per-user); the component must still
  never run unattended in CI (0174's constraint, inherited). A Slack outage or
  expired login fails the provision chain loudly (named-fix errors) while the
  rest of stage 3 proceeds.
- **State loss now loses the only signing-secret copy.** Slack returns it once,
  at creation; the documented recovery is **recreation** (taint/replace the
  provision Command), which mints a new app id and bot user id — old @mention
  references and DM threads orphan. The on-host project record keeps
  join/identity continuity; the backup subject covers the state bucket.
- **The carry-forward is load-bearing and must fail loud.** An update run whose
  `PULUMI_COMMAND_STDOUT` lacks the signing secret refuses by name
  (recreation is the fix) — silently re-creating would orphan the live app.
  `additionalSecretOutputs: ["stdout"]` is equally load-bearing: without it the
  provision output would render in previews and rest unencrypted in state.
- **`apps.developerInstall` stays an undocumented surface.** The shape is now
  derived from the CLI's source rather than guessed, but Slack can change it;
  every refusal names the settings-page fallback and the `appId` adopt slot
  (adopted apps keep config-sourced secrets and get no manifest
  reconciliation — that path is the permanent escape hatch, and
  `sync-bot-token` serves it). Enterprise Grid (grant-id `team_id`) is
  explicitly unsupported.
- **A re-install may rotate the bot token on any manifest change**, costing a
  benign secret roll + pod restart per change. The events two-phase leaves a
  short window during recreation where the app exists without subscriptions.
  Ordering alone cannot cover a FRESH deployment (the secret roll passes on an
  absent StatefulSet — Argo CD starts the pod later), so `apply-manifest`
  additionally **waits, bounded** (`SLACK_EVENTS_PROBE_TIMEOUT`, default 180s)
  for the events endpoint to answer 401-unsigned before applying; a timeout
  fails loudly naming the re-run.
- **Retired surface:** `slack_cli ensure-app` and `bootstrap-app` are deleted
  (superseded by `provision-app`); the Slack CLI binary remains only for
  `bot-identity`, channel joins, and `delete-app`.
