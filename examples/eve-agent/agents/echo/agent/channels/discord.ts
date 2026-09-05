// Discord, in the shape people expect from Claude in Slack: the bot is
// ONLINE, you @mention it, it answers in a THREAD under your message, and
// follow-ups in that thread continue the conversation without mentioning
// it again.
//
// ---------------------------------------------------------------------
// Why this is not `discordChannel()`
//
// eve's first-class Discord channel is HTTP Interactions - slash commands,
// components, modals (docs/channels/discord). Discord delivers ordinary
// messages and @mentions ONLY over the Gateway websocket, never to an HTTP
// endpoint, so no configuration of that channel can answer a mention, and
// with no socket open the bot shows offline.
//
// eve's documented answer for a surface its first-class channels do not
// cover is the CHAT SDK channel (docs/channels/chat-sdk): "Use it to reach
// a surface eve does not ship a first-class channel for." That is the
// blessed pattern, and it is what this file uses - `send()` dispatches the
// turn, so sessions, streaming, typing and human-in-the-loop stay eve's.
//
// ---------------------------------------------------------------------
// Why the listener is ours
//
// `@chat-adapter/discord` ships a Gateway listener with two modes, and on
// a resident guild bot BOTH are dead ends. Found on the deployed agent,
// not reasoned about:
//
//   DIRECT (no webhookUrl - what its README recommends for resident apps):
//   the mention arrives correctly and cannot be answered, because eve's
//   `send` requires a webhook request context:
//     "chatSdkChannel().send can only run during a Chat SDK webhook
//      handler for this bridge."
//
//   FORWARDING (webhookUrl set, which gives `send` its context): no guild
//   message is ever forwarded. The adapter JSON.stringify()s the raw
//   Gateway packet, and discord.js has already linked `member.user` back
//   into it:
//     "TypeError: Converting circular structure to JSON
//      property 'member' -> object ... property 'user' closes the circle"
//
// The bug is only in HOW the adapter serializes the packet, so this file
// keeps forwarding mode - the one that lets eve dispatch the turn - and
// does the forwarding itself from a plain discord.js client, sending a
// FLAT payload with no object graph to trip over. Everything downstream
// is the adapter's own webhook handler, unchanged and unpatched: the same
// route, the same `x-discord-gateway-token` authentication, the same
// mention detection and thread creation.
//
// Credentials come from the environment, where the platform CONNECTION
// bound to this agent projects them (environment/connections.yaml,
// ADR-152). Nothing platform-specific is authored here.
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { chatSdkChannel } from "eve/channels/chat-sdk";

const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
const applicationId = process.env.DISCORD_APPLICATION_ID ?? "";
const publicKey = process.env.DISCORD_PUBLIC_KEY ?? "";

// `eve build` EVALUATES this module to discover the channel's routes, and
// it runs in the platform's build initContainer, which deliberately holds
// no credentials - a build must be reproducible from source and a commit,
// not from secrets. createDiscordAdapter validates presence AND format, so
// the placeholders are shaped like the real values. Neither is a secret: a
// public key is public by definition and an application id is visible to
// anyone who can see the bot.
const PLACEHOLDER = {
  botToken: "build-time-placeholder",
  applicationId: "0".repeat(19),
  publicKey: "0".repeat(64),
};
const absent = [
  ["DISCORD_BOT_TOKEN", botToken],
  ["DISCORD_APPLICATION_ID", applicationId],
  ["DISCORD_PUBLIC_KEY", publicKey],
].filter(([, v]) => !v).map(([k]) => k);
if (absent.length) {
  console.warn(
    `[discord] missing ${absent.join(", ")} - the channel is mounted but INERT. ` +
      "At runtime this means the connection projected nothing: check `hg connection list` " +
      "and `hg agent show`. During `eve build` it is expected.",
  );
}
const configured = absent.length === 0;

export const { bot, channel, send } = chatSdkChannel({
  userName: "echo",
  adapters: {
    discord: createDiscordAdapter({
      botToken: botToken || PLACEHOLDER.botToken,
      applicationId: applicationId || PLACEHOLDER.applicationId,
      publicKey: publicKey || PLACEHOLDER.publicKey,
      // Answer an @mention anywhere the bot can see, rather than an
      // allow-list of channel ids: an environment's channels change more
      // often than its agents, and a mention is already an explicit
      // request.
      respondToGlobalMentions: true,
    }),
  },
  state: createMemoryState(),
});

// The conversation contract, stated once so every other chat surface can
// copy it: a mention starts a session, the THREAD is the session, and
// follow-ups in that thread continue it without re-mentioning. A message
// anywhere else is not addressed to the agent and is ignored.
//
// `send` is eve's - the turn, its streaming and its HITL prompts are all
// dispatched by the framework, which is the point of using the blessed
// channel rather than driving the session API by hand.
bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

// ---------------------------------------------------------------------
// The resident forwarder

const PORT = process.env.PORT ?? "3000";
/** The adapter's OWN webhook route, on loopback. The hop never leaves the
 * pod, so nothing has to be exposed and no tunnel is involved - the
 * websocket dials out, the dispatch comes back in through the front door
 * the adapter already owns. */
const WEBHOOK_URL = `http://127.0.0.1:${PORT}/eve/v1/discord`;

/** A Gateway MESSAGE_CREATE flattened to exactly the fields the adapter's
 * forwarded-message handler reads. Built field by field on purpose: the
 * whole reason this forwarder exists is that handing discord.js's live
 * object graph to JSON.stringify throws. */
function flatten(m: any): Record<string, unknown> {
  return {
    id: m.id,
    channel_id: m.channelId,
    ...(m.guildId ? { guild_id: m.guildId } : {}),
    channel_type: m.channel?.type,
    content: m.content ?? "",
    timestamp: (m.createdAt ?? new Date()).toISOString(),
    author: {
      id: m.author?.id,
      username: m.author?.username,
      global_name: m.author?.globalName ?? null,
      bot: m.author?.bot === true,
    },
    // `mentions` is what decides isMentioned; the adapter also reads
    // attachments and it must be ITERABLE - an absent one threw
    // "files is not iterable".
    mentions: [...(m.mentions?.users?.values() ?? [])].map((u: any) => ({
      id: u.id, username: u.username, bot: u.bot === true,
    })),
    mention_roles: [...(m.mentions?.roles?.keys() ?? [])],
    mention_everyone: m.mentions?.everyone === true,
    attachments: [...(m.attachments?.values() ?? [])].map((a: any) => ({
      id: a.id, filename: a.name, url: a.url, content_type: a.contentType, size: a.size,
    })),
    // A message already inside a thread carries its parent, which is how
    // a follow-up resolves to the same conversation instead of opening a
    // second thread.
    ...(m.channel?.isThread?.() && m.channel.parentId
      ? { thread: { id: m.channel.id, parent_id: m.channel.parentId } }
      : {}),
  };
}

// ONE forwarder per PROCESS, not per module evaluation. eve evaluates this
// module more than once in the built server: it opened two Gateway
// sessions on one bot token, which answers every mention twice. The guard
// is process.env because a globalThis symbol did NOT dedupe them - two
// evaluations that do not share a realm do not share globalThis, but every
// module instance in one process shares process.env.
//
// Same hazard as running two replicas, one level down: the chart
// guarantees one pod, this guarantees one listener inside it.
const GUARD = "__HG_DISCORD_GATEWAY_LISTENER";

if (configured && process.env.DISCORD_GATEWAY !== "0" && !process.env[GUARD]) {
  process.env[GUARD] = String(process.pid);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.on("messageCreate", async (m) => {
    // The bot's own messages would otherwise re-enter as new input; the
    // adapter drops them too, but not before creating a thread.
    if (m.author?.id === applicationId) return;
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-discord-gateway-token": botToken },
        body: JSON.stringify({ type: "GATEWAY_MESSAGE_CREATE", timestamp: Date.now(), data: flatten(m) }),
      });
      if (!res.ok) console.error(`[discord] forward returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      console.error("[discord] forward failed:", (e as Error).message);
    }
  });

  client.on("clientReady", () => console.log(`[discord] gateway ready as ${client.user?.tag} (pid ${process.pid})`));
  client.on("error", (e) => console.error("[discord] gateway error:", e.message));

  // discord.js reconnects on its own; a login failure is the one thing it
  // cannot recover from, and it must not become a hot loop against
  // Discord's API.
  void (async () => {
    let backoffMs = 1000;
    for (;;) {
      try {
        await client.login(botToken);
        return;
      } catch (e) {
        console.error(`[discord] login failed (retry in ${backoffMs}ms):`, (e as Error).message);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  })();
}

export default channel;
