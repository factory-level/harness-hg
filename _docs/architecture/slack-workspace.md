# Slack workspace (as built)

Present tense, defects included. Decisions: [ADR 0174](../adr/0174-slack-workspace.md),
[ADR 0175](../adr/0175-slack-app-secrets-in-state.md).

## What runs

- Ready Slack manifests enable interactivity at the same signed webhook URL as
  Events API callbacks. This is required for Eve approval buttons and question
  controls; registering message events alone does not enable those callbacks.
  `infra/tests/slack.test.ts` covers both the ready and withheld manifests.

- `infra/src/components/slack-workspace/index.ts` — stage-3 component, gated by
  `slack.enabled`, constructed **before** `AgentSecrets` in
  `control-flow/control-plane.ts` (its outputs feed it). Host-side only; it
  creates no Kubernetes resources itself.
- **Per non-adopted app, a provision Command** (`slack-app-provision-<agent>`,
  ADR 0175) shells `python -m gitops_emitter.slack_cli provision-app`
  (`plugin/gitops_emitter/slack.py`): CREATE = `apps.manifest.create` with
  `settings.event_subscriptions` **stripped** (captures the signing secret,
  returned only at creation) → `apps.developerInstall` with the shape the Slack
  CLI itself sends (JSON `{app_id, bot_scopes, outgoing_domains}`, no `team_id`
  off-Enterprise — derived from slack-cli `internal/api/app.go`) → the bot
  token from `api_access_tokens.bot`. UPDATE = `apps.manifest.update` (full
  manifest) + a fresh install, the signing secret carried forward from
  `PULUMI_COMMAND_STDOUT`; a prior record missing it refuses by name. Stdout
  `{app_id, signing_secret, bot_token, superseded_app_id}` is secret-marked
  (`additionalSecretOutputs: ["stdout"]`) — **encrypted Pulumi state is the
  durable home of both credentials.** The Command also maintains the
  CLI-compatible project record
  (`$HERMES_GITOPS_HOME/slack-apps/<agent>/{manifest.json,.slack/*}`) so
  `slack api` calls keep resolving their token.
- The component's `secrets` output feeds `AgentSecrets` as `extraSecrets`
  (merged over config `agentSecrets`; resource output wins), landing in the
  twin's `<ns>-env` Secret; the `agent-secrets-roll-<instance>` digest is
  computed over the resolved merged values, so a rotated token rolls the pod.
- **Events attach in a second Command** (`wireEvents` → `slack-app-events-<agent>`
  → `slack_cli apply-manifest`, full manifest), `dependsOn` the agent's roll AND
  gated on the events endpoint answering 401-unsigned (bounded wait,
  `SLACK_EVENTS_PROBE_TIMEOUT` default 180s — the roll passes on an absent
  StatefulSet at first install, so ordering alone cannot guarantee a running
  pod): Slack's `url_verification` challenge always meets a pod that is serving
  and holding the new signing secret. Rendered only when
  `eventsReady && botEvents && eventsUrl`. The provision Command logs
  `stderr` only (`logging: "stderr"`) — stdout holds the credentials.
- `bot-identity` (`slack api auth.test --app <id>`, as the bot) and pinned-channel
  self-joins (`conversations.join`, `channels:join`, public channels only) are
  unchanged from 0174; unpinned channels go through `@pulumi/slack`
  `Conversation` under `slack.adminUserToken` (none configured today).
- Config: `parseSlack` in `infra/src/control-flow/config.ts` (closed keys,
  preview-time `ConfigError`s) plus the ADR-0175 cross-check — a provisioned
  app with config-sourced `SLACK_*` in `agentSecrets` is refused at preview.
  Gates: `infra/tests/slack.test.ts`, `infra/tests/config.test.ts`,
  `plugin/tests/test_slack_cli.py`, and live: **`hg slack prove <env>`**
  (SLK001 Secret keys, SLK002 auth.test identity, SLK003 channel membership,
  SLK004 events edge refuses unsigned).

## Live state (factory)

The operator's workspace. **All three apps are
state-provisioned through the ADR 0175 path** (migration completed
2026-08-29): Eve Manager `A0BTH5X99S9` (bot `U0BT5U079FH`), Eve Research
`A0BT5ULAWNB` (`U0BTP7B9YHF`), Eve SRE `A0BUFLUC3G8` (`U0BTM940QBU`) — created
by their provision Commands inside `pulumi up`, credentials captured into
encrypted state, zero pasted secrets. All three bots are members of `#social`
(the pinned channel) and events are applied. The 2026-08-27 CLI-created apps
were deleted after the proofs.
Proven live 2026-08-29: `hg slack prove factory` SLK001..004 all pass, and all
three twins — **the manager for the first time ever** — answer an @mention
in-thread (~10–20s). The old bot user ids' mention references and DM threads
are orphaned, as the ADR's cost section says.

## The webhook edge (built, live)

`controlPlaneIngress.webhookEndpoints` publishes a Cloudflare hostname per
provider webhook **without an Access application** — the provider's request
signature is the auth, verified at eve's channel. One hostname per app (eve's
fixed `/eve/v1/slack` path can't be shared). `validatePrerequisites`
cross-checks each events URL's host against the published endpoints.

## Defects and gaps, plainly

- **`apps.developerInstall` is undocumented.** The shape is read from the CLI's
  source, not a contract; Slack can change it. Refusals name the settings-page
  fallback + the `appId` adopt slot (`sync-bot-token` serves adopted apps).
  Enterprise Grid is unsupported (the grant-id `team_id` variant).
- **State loss loses the signing secret** — unfetchable after creation;
  recovery is recreation (new app + bot ids; old threads orphan).
- The CLI login (`~/.slack/credentials.json`) and project directories remain
  host state outside Pulumi and Git; `slack api` acts as whoever ran
  `slack login`, and nothing prevents an unattended run except the documented
  instruction not to.
- An adopted app (`appId` set) gets no manifest reconciliation at all.
- A manifest change may rotate the bot token on re-install (benign: the digest
  rolls the pod). During recreation there is a window with no event
  subscriptions; the events attach waits bounded for the endpoint and a
  timeout names the re-run.
- `hg slack prove` SLK003 reads only the first page of `conversations.members`.

Provisioned app renames use `previousName` aliases. Provisioning ignores legacy
Command replacement triggers: manifest and project-path changes update through the
environment inputs, carrying the prior signing secret and app ID forward.

Independent workspace projections accept an explicit terminal directory from their
operator caller. Multiple repositories still fail closed when none is provided, and
an unbound terminal directory is rejected. The factory projection chooses the content
workspace and resolves strategy clone credentials in each role's namespace.
