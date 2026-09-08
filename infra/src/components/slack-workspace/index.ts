// Slack workspace provisioning (stage 3): one Slack app per declared eve
// agent, provisioned STATEFULLY through the raw manifest API (ADR 0175),
// and channels with declaratively managed membership via @pulumi/slack.
//
// Design decisions, in the order they surprise people:
//
//   - Each non-adopted app is a PROVISION Command whose secret-marked
//     stdout carries {app_id, signing_secret, bot_token}: the signing
//     secret is returned by Slack exactly once, at apps.manifest.create,
//     and the encrypted Pulumi state is its durable home. The bot token
//     comes from apps.developerInstall with the arg shape the Slack CLI
//     itself sends (slack-cli internal/api/app.go — the earlier guess drew
//     invalid_argument). On UPDATE runs @pulumi/command injects the prior
//     stdout as PULUMI_COMMAND_STDOUT, so the signing secret carries
//     forward while the manifest updates and the bot token refreshes.
//     `secrets` feeds AgentSecrets directly — nothing rides stack config
//     (ADR 0174's objection was mutating stack config mid-`up`; resource
//     outputs do not), and nothing is ever hand-pasted.
//   - EVENTS ATTACH IN A SECOND COMMAND (`wireEvents`), ordered after the
//     agent's secret roll: Slack challenges the events request_url at
//     manifest apply and the pod must already hold the new app's signing
//     secret to answer url_verification. The provision CREATE therefore
//     strips event_subscriptions (python side); the events Command applies
//     the full manifest once the roll completed.
//   - The per-app PROJECT DIRECTORY ($HERMES_GITOPS_HOME/slack-apps/<agent>)
//     is maintained as a Slack-CLI-compatible record so `slack api ...
//     --app <id>` (bot-identity, channel joins) keeps resolving its token
//     through the CLI's stored login. State loss loses the signing secret
//     (unrecoverable by design — Slack returns it once); recovery is
//     recreation, and the `appId` config slot ADOPTS a hand-made app
//     instead (adopted apps keep config-sourced secrets + no manifest
//     reconciliation; hand-made apps stay hand-managed).
//   - Channels authenticate as `slack.adminUserToken` (a USER token):
//     a bot cannot invite itself (cant_invite_self), and adopting an
//     archived channel is user-token-only. Channels are adopted rather than
//     created when they exist (#social), archived — never deleted — on
//     destroy, and membership updates only ever ADD (a human who joined by
//     hand is never kicked by a config diff).

import * as pulumi from "@pulumi/pulumi";
import * as slack from "@pulumi/slack";
import { local } from "@pulumi/command";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePluginPath, shellQuote } from "../harness/hermes-install/index.ts";
import type { BootstrapConfig, SlackAppSpec, SlackConfig } from "../../control-flow/config.ts";

export interface SlackWorkspaceArgs {
  config: BootstrapConfig;
}

/** The per-app Slack CLI project directory — the on-host idempotency
 * record (`.slack/apps.json`). Under the same root the `hg` CLI uses. */
export function slackProjectDir(agent: string, home?: string): string {
  const root = home ?? process.env["HERMES_GITOPS_HOME"] ?? path.join(os.homedir(), ".hermes-gitops");
  return path.join(root, "slack-apps", agent);
}

/** The app manifest, pure — the SAME JSON string is the ensure Command's
 * trigger, so no manifest field can change without a re-run. Events are
 * rendered only when the endpoint is ready to be challenged. */
export function buildSlackManifest(cfg: SlackConfig, app: SlackAppSpec): object {
  const withEvents = cfg.eventsReady && app.botEvents.length > 0 && app.eventsUrl !== "";
  return {
    display_information: {
      name: app.displayName,
      ...(app.description ? { description: app.description } : {}),
      background_color: "#1a1822",
    },
    features: {
      bot_user: {
        // The bot handle users type after @ — the kebab display name.
        display_name: app.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        always_online: true,
      },
    },
    oauth_config: {
      scopes: { bot: [...app.botScopes].sort() },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      ...(withEvents
        ? {
            event_subscriptions: {
              request_url: app.eventsUrl,
              bot_events: [...app.botEvents].sort(),
            },
            interactivity: {
              is_enabled: true,
              request_url: app.eventsUrl,
            },
          }
        : {}),
    },
  };
}

/** The provision Command's stdout, parsed and shape-checked. Pure — the
 * bun tests exercise it offline. Never log the input: it holds secrets. */
export function parseProvisionStdout(agent: string, out: string): {
  app_id: string;
  signing_secret: string;
  bot_token: string;
} {
  const parsed = JSON.parse(out.trim()) as {
    app_id?: string;
    signing_secret?: string;
    bot_token?: string;
  };
  if (!parsed.app_id || !parsed.signing_secret || !parsed.bot_token) {
    // Name the missing keys, never the values.
    const missing = (["app_id", "signing_secret", "bot_token"] as const)
      .filter((k) => !parsed[k])
      .join(", ");
    throw new Error(`slack-app-provision-${agent}: stdout is missing ${missing}`);
  }
  return { app_id: parsed.app_id, signing_secret: parsed.signing_secret, bot_token: parsed.bot_token };
}

/** Whether the app's manifest carries event subscriptions at all. */
export function manifestHasEvents(cfg: SlackConfig, app: SlackAppSpec): boolean {
  return cfg.eventsReady && app.botEvents.length > 0 && app.eventsUrl !== "";
}

export class SlackWorkspace extends pulumi.ComponentResource {
  /** agent instance name -> app id (config-adopted or provisioned). */
  readonly appIds: Record<string, pulumi.Output<string>> = {};
  /** agent instance name -> the bot's Slack user id (U…). */
  readonly botUserIds: Record<string, pulumi.Output<string>> = {};
  /** agent instance name -> pod credentials, secret-tainted from the
   * provision Command's stdout. Consumed by AgentSecrets as extraSecrets.
   * Adopted apps are absent here — their secrets stay in stack config. */
  readonly secrets: Record<
    string,
    { SLACK_BOT_TOKEN: pulumi.Output<string>; SLACK_SIGNING_SECRET: pulumi.Output<string> }
  > = {};
  readonly channels: slack.Conversation[] = [];
  private readonly runner: string;
  private readonly cfg: SlackConfig;

  constructor(name: string, args: SlackWorkspaceArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:SlackWorkspace", name, {}, opts);
    const cfg = args.config;
    const sl = cfg.slack;
    this.cfg = sl;
    const pluginPath = resolvePluginPath(cfg);
    const runner = `uv run --project ${shellQuote(pluginPath)} python -m gitops_emitter.slack_cli`;
    this.runner = runner;

    for (const [agent, app] of Object.entries(sl.apps)) {
      const projectDir = slackProjectDir(agent);
      const manifestJson = JSON.stringify(buildSlackManifest(sl, app));

      if (app.appId !== "") {
        // Adopt-existing: creation is skipped outright; the id is config.
        // (Manifest reconciliation of an adopted app is deliberately not
        // attempted, and its pod secrets stay on the agentSecrets config
        // channel — hand-made apps stay hand-managed.)
        this.appIds[agent] = pulumi.output(app.appId);
      } else {
        const provision = new local.Command(
          `slack-app-provision-${agent}`,
          {
            create: `${runner} provision-app`,
            update: `${runner} provision-app`,
            // Apps deliberately survive `pulumi destroy` unless opted in:
            // deletion irreversibly invalidates every token in circulation.
            // (delete-app reads the app id from PULUMI_COMMAND_STDOUT.)
            ...(sl.deleteAppsOnDestroy ? { delete: `${runner} delete-app` } : {}),
            environment: {
              SLACK_CLI_BIN: sl.cliBin,
              SLACK_TEAM_ID: sl.teamId,
              SLACK_PROJECT_DIR: projectDir,
              SLACK_MANIFEST_JSON: manifestJson,
            },
            // The reconciler idiom: every field that must re-run the
            // provision on change, in one JSON blob — nothing drifts
            // silently. (The python side strips events on CREATE only.)
            triggers: [manifestJson, sl.teamId, pluginPath],
            // BOTH halves of the no-leak contract (Codex catch): stderr
            // may carry prose, but stdout holds the credentials, and the
            // provider's default is to LOG both streams live — secret
            // marking protects state and renders, not the log line.
            logging: "stderr",
          },
          {
            parent: this,
            // Load-bearing: stdout carries the signing secret + bot token.
            // Secret-marking encrypts it in state and masks every render.
            additionalSecretOutputs: ["stdout"],
            // Command triggers force replacement, which loses previous stdout and
            // would create a new Slack app. Manifest/project changes already live
            // in environment and use update, preserving the signing secret.
            ignoreChanges: ["triggers"],
            ...(app.previousName ? { aliases: [{ name: `slack-app-provision-${app.previousName}` }] } : {}),
          },
        );
        const parsed = provision.stdout.apply((out) => parseProvisionStdout(agent, out));
        // App ids are not secret; unsecret keeps join commands + triggers
        // readable in previews. The credentials stay tainted.
        this.appIds[agent] = pulumi.unsecret(parsed.apply((p) => p.app_id));
        this.secrets[agent] = {
          SLACK_BOT_TOKEN: pulumi.secret(parsed.apply((p) => p.bot_token)),
          SLACK_SIGNING_SECRET: pulumi.secret(parsed.apply((p) => p.signing_secret)),
        };
      }

      const identity = new local.Command(
        `slack-bot-identity-${agent}`,
        {
          create: `${runner} bot-identity`,
          update: `${runner} bot-identity`,
          environment: {
            SLACK_CLI_BIN: sl.cliBin,
            SLACK_TEAM_ID: sl.teamId,
            SLACK_PROJECT_DIR: projectDir,
            SLACK_APP_ID: this.appIds[agent],
          },
          triggers: [this.appIds[agent], sl.teamId],
        },
        { parent: this,
          ...(app.previousName ? { aliases: [{ name: `slack-bot-identity-${app.previousName}` }] } : {}),
        },
      );
      this.botUserIds[agent] = identity.stdout.apply((out) => {
        const parsed = JSON.parse(out.trim()) as { user_id?: string };
        if (!parsed.user_id) {
          throw new Error(`slack-bot-identity-${agent}: no user_id in response`);
        }
        return parsed.user_id;
      });
    }

    // Channels split into two layers by whether the id is pinned:
    //   - channelId set -> each referenced bot JOINS the (public) channel
    //     itself via conversations.join, authenticated AS the bot through
    //     the CLI - no admin token anywhere. validatePrerequisites already
    //     guaranteed channels:join is in the app's scopes.
    //   - channelId unset -> @pulumi/slack Conversation (create/adopt,
    //     topic, human membership), authenticated as adminUserToken.
    for (const ch of sl.channels) {
      if (ch.channelId === "") continue;
      for (const agent of ch.agents) {
        new local.Command(
          `slack-join-${ch.name}-${agent}`,
          {
            // conversations.join is idempotent: joining a channel the bot
            // is already in returns ok with "already_in_channel".
            create: pulumi.interpolate`${shellQuote(sl.cliBin)} api conversations.join channel=${ch.channelId} --app ${this.appIds[agent]!} --team ${sl.teamId} --skip-update --force`,
            update: pulumi.interpolate`${shellQuote(sl.cliBin)} api conversations.join channel=${ch.channelId} --app ${this.appIds[agent]!} --team ${sl.teamId} --skip-update --force`,
            dir: slackProjectDir(agent),
            triggers: [ch.channelId, this.appIds[agent]!, sl.teamId],
          },
          { parent: this },
        );
      }
    }
    const managed = sl.channels.filter((ch) => ch.channelId === "");
    if (managed.length > 0) {
      // parseSlack/validatePrerequisites guarantee adminUserToken here.
      const provider = new slack.Provider(
        "slack",
        { token: pulumi.secret(sl.adminUserToken) },
        { parent: this },
      );
      for (const ch of managed) {
        const botMembers = ch.agents.map((a) => this.botUserIds[a]!);
        this.channels.push(
          new slack.Conversation(
            `slack-channel-${ch.name}`,
            {
              name: ch.name,
              ...(ch.topic ? { topic: ch.topic } : {}),
              isPrivate: ch.isPrivate,
              permanentMembers: pulumi.all(botMembers).apply((ids) => [...ch.users, ...ids]),
              adoptExistingChannel: true,
              actionOnDestroy: "archive",
              actionOnUpdatePermanentMembers: "none",
            },
            { parent: this, provider },
          ),
        );
      }
    }

    this.registerOutputs({});
  }

  /** Attach event subscriptions AFTER each agent's secret roll (ADR 0175
   * two-phase rule): the full manifest — events included — applies only
   * once the pod holds the app's signing secret, so Slack's
   * url_verification challenge verifies. *rolls* maps agent instance name
   * to its `agent-secrets-roll` Command (AgentSecrets.rolls). Adopted apps
   * are skipped (no manifest reconciliation, unchanged stance). */
  wireEvents(rolls: Record<string, pulumi.Resource>): void {
    const sl = this.cfg;
    for (const [agent, app] of Object.entries(sl.apps)) {
      if (app.appId !== "" || !manifestHasEvents(sl, app)) continue;
      const manifestJson = JSON.stringify(buildSlackManifest(sl, app));
      const roll = rolls[agent];
      new local.Command(
        `slack-app-events-${agent}`,
        {
          create: `${this.runner} apply-manifest`,
          update: `${this.runner} apply-manifest`,
          environment: {
            SLACK_TEAM_ID: sl.teamId,
            SLACK_PROJECT_DIR: slackProjectDir(agent),
            SLACK_APP_ID: this.appIds[agent]!,
            SLACK_MANIFEST_JSON: manifestJson,
          },
          triggers: [manifestJson, this.appIds[agent]!, sl.teamId],
        },
        { parent: this, ...(roll ? { dependsOn: [roll] } : {}) },
      );
    }
  }
}
