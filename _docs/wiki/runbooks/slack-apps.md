# Slack apps

**Outcome:** an agent has a Slack presence: app, credentials, channel membership and inbound
events, all from the environment spec. Nothing is copied from a Slack settings page.

## Prerequisites

- `slack login` (the official Slack CLI) run once on the operator host, signed into the
  target workspace. It is per-user, so this never runs unattended.
- A no-Access webhook hostname for the agent, declared under
  `controlPlaneIngress.webhookEndpoints`. See [Webhooks](../platform/webhooks.md).

## 1. Declare the app

In `infra/environments/<env>.yaml`:

```yaml
slack:
  enabled: true
  teamId: T0123456789
  eventsReady: true
  apps:
    my-agent:
      displayName: My Agent
      botScopes: [app_mentions:read, channels:join, chat:write, channels:read]
      botEvents: [app_mention]
      eventsUrl: https://slack-my-agent.example.dev/eve/v1/slack
  channels:
    - name: social
      channelId: C0123456789
      agents: [my-agent]
```

Do not add `SLACK_*` to the agent's secrets. A provisioned app's credentials live in state,
and a config-sourced copy is refused.

## 2. Apply

```bash
hg env apply <env>
cd infra && pulumi up -s <env>
```

The run creates the app, installs it, writes both credentials into the agent's env Secret,
restarts the pod, joins the pinned channels, and only then attaches the event subscription,
so Slack's URL challenge meets a pod that can answer it.

## Add a bot to a channel

Append the agent to the channel's `agents:` list, then apply again. Self-join works on public
channels only. A private channel needs `slack.adminUserToken` or a human `/invite`.

## Repair or rotate an app's credentials

Taint the provision step and apply. The run mints a fresh app with fresh credentials.

```bash
cd infra
pulumi stack --show-urns -s <env> | grep slack-app-provision-<agent>
pulumi state taint -s <env> '<that urn>'
pulumi up -s <env>
```

The old app is never deleted for you. Retire it with `slack app delete` once the new one is
proven. Recreation changes the bot id, so old mentions and DM threads orphan.

## Proof

```bash
hg slack prove <env> --agent my-agent     # SLK001..004
```

**Done when** it passes and an `@mention` of the bot in a pinned channel gets a threaded
reply.

## Operational alert delivery

The event router supports Slack bot-token delivery. Bind a ChatOps alias to `provider: slack`,
reference the token through `credentialRef`, and address a channel by its Slack channel ID.
Grafana sends JSON to the compiled producer webhook; the router delivers the logical alert.
A delivery succeeds only when Slack returns `ok: true` and a message timestamp. The router
classifies API errors even when Slack returns HTTP 200. Payloads do not activate automatic
mentions or link unfurls.

Host lifecycle notifications use `HG_SLACK_BOT_TOKEN` or `SLACK_BOT_TOKEN` and a Slack
registration made with `hg server register --channel <channel-id>`. Old provider registrations
must be registered again. The delivery receipt records provider acceptance, not human reading.

Prove the selected destination with `hg chatops test <alias>#<channel-id>`, then inspect its
receipt and the message in Slack.
