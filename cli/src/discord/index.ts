// `hg discord` - the native Hermes Discord gateway, observed from outside
// (ADR-74). The gateway itself is the Hermes agent's own bundled adapter;
// the platform adds NO delivery path here - this command only answers "is
// the deployed profile's adapter declared, bound and connected", the
// pre-flight an operator runs before typing at the bot.
//
// Read-only by construction: env-var NAMES only (never values), the
// authored config.yaml declaration, and the adapter's own log lines from
// the pod's gateway.log (which lives on the profile volume, NOT container
// stdout - the same trap hg-eval documented).

import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import {
  CliError,
  KCTX,
  type ProfileCtx,
  jsonOut,
  kubectl,
  loadState,
  log,
  ok,
  profileCtxs,
  warn,
} from "../lib.ts";
import { backupNsOf } from "../backup/routines.ts";

interface DiscordStatus {
  profile: string;
  namespace: string;
  pod: string;
  declared: boolean | "unknown";
  tokenBound: boolean;
  authzVars: string[];
  connected: boolean | "unknown";
  gatewayLines: string[];
}

/** Discord bot tokens are three dot-joined base64url chunks; scrub that
 * shape (and any Bot-header remnant) from verbatim log lines before they
 * reach a terminal or JSON output - the log is the adapter's own text and
 * this command promises "never values". */
function scrub(l: string): string {
  return l
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, "[redacted-token]")
    .replace(/Bot\s+\S{20,}/g, "Bot [redacted-token]");
}

/** The agent pod in the profile's (bundle-aware) namespace. */
function agentPodIn(ns: string): string {
  const raw = kubectl(["-n", ns, "get", "pods", "-o", "jsonpath={.items[*].metadata.name}"], {
    allowFail: true,
    quiet: true,
  }).trim();
  const pods = raw.split(/\s+/).filter((p) => p.startsWith("hermes-"));
  return pods[0] ?? "";
}

/** platforms.discord.enabled from the authored config.yaml - the repo's
 * own declaration, so "the manager is on Discord" is answerable without
 * a running container (the persona repo states this on purpose). */
function declaredEnabled(ctx: ProfileCtx): boolean | "unknown" {
  const file = path.join(ctx.dir, "config.yaml");
  try {
    const doc = parse(fs.readFileSync(file, "utf8")) as {
      platforms?: { discord?: { enabled?: boolean } };
    };
    return doc?.platforms?.discord?.enabled ?? "unknown";
  } catch {
    return "unknown";
  }
}

function statusOf(ctx: ProfileCtx): DiscordStatus {
  const ns = backupNsOf(ctx);
  const pod = agentPodIn(ns);
  const base: DiscordStatus = {
    profile: ctx.name,
    namespace: ns,
    pod: pod || "<none>",
    declared: declaredEnabled(ctx),
    tokenBound: false,
    authzVars: [],
    connected: "unknown",
    gatewayLines: [],
  };
  if (!pod) return base;
  // Env-var NAMES only. `env` in the agent container, filtered to the
  // adapter's own namespace of knobs - a value has no path into this
  // output.
  const envNames = kubectl(
    ["-n", ns, "exec", pod, "-c", "hermes-agent", "--", "sh", "-c", "env | cut -d= -f1 | grep '^DISCORD_' | sort"],
    { allowFail: true, quiet: true },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  base.tokenBound = envNames.includes("DISCORD_BOT_TOKEN");
  base.authzVars = envNames.filter((n) => n !== "DISCORD_BOT_TOKEN");
  // The adapter's own account of itself. gateway.log is on the profile
  // volume; grep for discord lines and let the operator see the last few
  // verbatim (connection, ready, auth rejections).
  const glob = `/opt/data/profiles/${ctx.name}/logs/gateway.log`;
  const lines = kubectl(
    ["-n", ns, "exec", pod, "-c", "hermes-agent", "--", "sh", "-c", `grep -i discord ${glob} 2>/dev/null | tail -8`],
    { allowFail: true, quiet: true },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  base.gatewayLines = lines.map(scrub);
  // Newest conclusive transition wins, and the negative test runs first -
  // "disconnected" contains "connected", so a joined-blob positive match
  // reported dead gateways as up (codex catch).
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (/disconnect|error|failed|unauthorized|invalid token/i.test(l)) {
      base.connected = false;
      break;
    }
    if (/\bready\b|\bconnected\b|logged in/i.test(l)) {
      base.connected = true;
      break;
    }
  }
  return base;
}

export function cmdDiscord(json: boolean, args: string[], onlyProfile: string | undefined): void {
  const [sub] = args;
  if ((sub ?? "status") !== "status") {
    throw new CliError(
      `hg discord ${sub}: only "status" exists today - the live round-trip proof runs through a real ` +
        "guild message (the Wave-5 conformance tier owns the self-driving harness).",
    );
  }
  const state = loadState();
  const ctxs = profileCtxs(state).filter((c) => !onlyProfile || c.name === onlyProfile || path.basename(c.subdir) === onlyProfile);
  if (!ctxs.length) {
    throw new CliError(
      `--profile ${JSON.stringify(onlyProfile ?? "")} matches nothing (known: ${profileCtxs(state)
        .map((c) => c.name)
        .join(", ")})`,
    );
  }
  const eve = ctxs.filter((c) => c.runtime === "eve");
  const hermes = ctxs.filter((c) => c.runtime !== "eve");
  if (hermes.length === 0) {
    throw new CliError(
      `discord status observes the Hermes-native gateway; ${eve.map((c) => c.name).join(", ")} run on Eve, ` +
        "whose Discord is the connection gateway's - see `hg connection prove` and `hg agent prove` " +
        "legs EVE021/EVE024",
    );
  }
  if (eve.length) log(`skipping Eve agent(s) ${eve.map((c) => c.name).join(", ")} - Discord there is the connection gateway's`);
  const report = hermes.map(statusOf);
  if (json) {
    jsonOut({ command: "discord-status", context: KCTX, profiles: report });
    return;
  }
  for (const r of report) {
    log(`[${r.profile}] ns=${r.namespace} pod=${r.pod}`);
    log(`  declared: ${r.declared}   token: ${r.tokenBound ? "bound" : "MISSING"}   connected: ${r.connected}`);
    log(`  authz env: ${r.authzVars.length ? r.authzVars.join(", ") : "<none - adapter policy defaults apply>"}`);
    for (const l of r.gatewayLines.slice(-4)) log(`  | ${l}`);
    if (r.tokenBound && r.connected === true) ok(`${r.profile}: Discord gateway up`);
    else warn(`${r.profile}: not proven up - check token binding and gateway.log above`);
  }
}
