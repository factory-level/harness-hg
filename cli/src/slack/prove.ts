// hg slack prove (ADR 0175) — the Slack surface acceptance matrix.
//
// The provisioning itself is Pulumi's (SlackWorkspace: provision Command,
// state-carried secrets, events attach after the secret roll); this
// matrix asks whether the RESULT holds, from the outside:
//
//   SLK001  every app's pod Secret carries both SLACK_* keys
//   SLK002  each app answers auth.test AS the bot, in the right workspace
//   SLK003  each bot is a member of every pinned channel that names it
//   SLK004  each events endpoint refuses an UNSIGNED post (401) — the
//           no-Access edge is up and eve is verifying signatures
//
// Every leg that cannot run reports unknown, never a pass (proof.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, HG_HOME } from "../lib.ts";
import type { EnvironmentSpec } from "../env/spec.ts";
import type { ProofFinding, ProofResult } from "../proof.ts";

export interface SlackAppView {
  appId: string;
  botEvents: string[];
  eventsUrl: string;
}

export interface SlackSpecView {
  teamId: string;
  cliBin: string;
  eventsReady: boolean;
  apps: Record<string, SlackAppView>;
  channels: { name: string; channelId: string; agents: string[] }[];
}

/** The slack block out of the environment spec, shaped for the matrix.
 * Loose on purpose: the spec schema + infra parser own strictness. */
export function slackSpecOf(spec: EnvironmentSpec): SlackSpecView {
  const raw = (spec.infra["slack"] ?? {}) as Record<string, unknown>;
  if (raw["enabled"] !== true) {
    throw new CliError(
      "this environment declares no enabled slack block - nothing to prove",
    );
  }
  const apps: Record<string, SlackAppView> = {};
  for (const [agent, a] of Object.entries((raw["apps"] ?? {}) as Record<string, any>)) {
    apps[agent] = {
      appId: String(a?.appId ?? ""),
      botEvents: Array.isArray(a?.botEvents) ? a.botEvents.map(String) : [],
      eventsUrl: String(a?.eventsUrl ?? ""),
    };
  }
  return {
    teamId: String(raw["teamId"] ?? ""),
    cliBin: String(raw["cliBin"] ?? "slack"),
    eventsReady: raw["eventsReady"] === true,
    apps,
    channels: ((raw["channels"] ?? []) as any[]).map((c) => ({
      name: String(c?.name ?? ""),
      channelId: String(c?.channelId ?? ""),
      agents: Array.isArray(c?.agents) ? c.agents.map(String) : [],
    })),
  };
}

/** The provisioned app id from the on-host Slack CLI project record. */
export function recordedAppId(agent: string, teamId: string, home = HG_HOME): string {
  const file = path.join(home, "slack-apps", agent, ".slack", "apps.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
      apps?: Record<string, { app_id?: string }>;
    };
    return String(data.apps?.[teamId]?.app_id ?? "");
  } catch {
    return "";
  }
}

export interface SlackProveDeps {
  spec: SlackSpecView;
  /** Restrict the matrix to one agent (--agent). */
  agent?: string | undefined;
  /** `slack <args>` from an app's project dir; null = binary missing. */
  runSlack: (args: string[], projectDir: string) => { code: number; stdout: string } | null;
  /** Key NAMES of a namespace's env Secret; null = cluster unreachable. */
  secretKeys: (namespace: string) => string[] | null;
  /** Status of an unsigned POST; null = network failure. */
  postStatus: (url: string) => Promise<number | null>;
  /** The provisioned app id fallback when the spec pins none. */
  appIdOf: (agent: string) => string;
  projectDirOf: (agent: string) => string;
}

export async function proveSlack(deps: SlackProveDeps): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], message: string) =>
    findings.push({ id, status, component: "slack", message });
  const sl = deps.spec;
  const agents = Object.keys(sl.apps)
    .filter((a) => !deps.agent || a === deps.agent)
    .sort();
  if (agents.length === 0) {
    throw new CliError(
      deps.agent
        ? `slack.apps declares no app for ${deps.agent}`
        : "slack.apps is empty - nothing to prove",
    );
  }

  // SLK001 — the pod Secret carries both keys. Presence of KEYS only:
  // values never leave the cluster. slack apps are validated eve-only,
  // so the namespace is the eve prefix (ADR-151).
  const missingKeys: string[] = [];
  let unreachable = 0;
  for (const agent of agents) {
    const keys = deps.secretKeys(`ag-eve-${agent}`);
    if (keys === null) {
      unreachable++;
      continue;
    }
    for (const k of ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]) {
      if (!keys.includes(k)) missingKeys.push(`${agent}: ${k}`);
    }
  }
  add(
    "SLK001",
    unreachable > 0 ? "unknown" : missingKeys.length === 0 ? "pass" : "fail",
    unreachable > 0
      ? `${unreachable} namespace(s) unreachable - cannot read Secret keys`
      : missingKeys.length === 0
        ? `every app's env Secret carries both SLACK_* keys (${agents.length} app(s))`
        : `missing keys: ${missingKeys.join("; ")}`,
  );

  // SLK002 — the bot answers as itself, in the right workspace. Also the
  // source of each bot's user id for SLK003.
  const botUserIds: Record<string, string> = {};
  const identityFailures: string[] = [];
  let identityUnknown = 0;
  for (const agent of agents) {
    const appId = sl.apps[agent]!.appId || deps.appIdOf(agent);
    if (!appId) {
      identityUnknown++;
      identityFailures.push(`${agent}: no app id (not provisioned yet?)`);
      continue;
    }
    const out = deps.runSlack(
      ["api", "auth.test", "--app", appId, "--team", sl.teamId, "--skip-update", "--force"],
      deps.projectDirOf(agent),
    );
    if (out === null) {
      identityUnknown++;
      identityFailures.push(`${agent}: slack CLI not runnable`);
      continue;
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(out.stdout.trim().split("\n").at(-1) ?? "");
    } catch {
      /* handled below */
    }
    if (out.code !== 0 || !parsed?.ok) {
      identityFailures.push(`${agent}: auth.test ${parsed?.error ?? `exit ${out.code}`}`);
    } else if (parsed.team_id !== sl.teamId) {
      identityFailures.push(`${agent}: answered for team ${parsed.team_id}, expected ${sl.teamId}`);
    } else {
      botUserIds[agent] = String(parsed.user_id ?? "");
    }
  }
  add(
    "SLK002",
    identityFailures.length === 0 ? "pass" : identityUnknown === identityFailures.length ? "unknown" : "fail",
    identityFailures.length === 0
      ? `every bot answers auth.test in ${sl.teamId}`
      : identityFailures.join("; "),
  );

  // SLK003 — pinned-channel membership, asked AS each bot (channels:read
  // rides every app's scopes). First page only: the factory channels are
  // small; a >100-member channel would need pagination here.
  const membershipFailures: string[] = [];
  let membershipUnknown = 0;
  let membershipChecked = 0;
  for (const ch of sl.channels) {
    if (ch.channelId === "") continue;
    for (const agent of ch.agents) {
      if (!agents.includes(agent)) continue;
      const botId = botUserIds[agent];
      if (!botId) {
        membershipUnknown++;
        continue; // already reported under SLK002
      }
      const appId = sl.apps[agent]!.appId || deps.appIdOf(agent);
      const out = deps.runSlack(
        ["api", "conversations.members", `channel=${ch.channelId}`, "--app", appId, "--team", sl.teamId, "--skip-update", "--force"],
        deps.projectDirOf(agent),
      );
      let members: string[] = [];
      try {
        members = (JSON.parse(out?.stdout.trim().split("\n").at(-1) ?? "") as any)?.members ?? [];
      } catch {
        /* fall through */
      }
      if (out === null || out.code !== 0) {
        membershipUnknown++;
      } else if (!members.includes(botId)) {
        membershipFailures.push(`${agent} is not in #${ch.name}`);
      } else {
        membershipChecked++;
      }
    }
  }
  add(
    "SLK003",
    membershipFailures.length > 0
      ? "fail"
      : membershipUnknown > 0 || membershipChecked === 0
        ? "unknown"
        : "pass",
    membershipFailures.length > 0
      ? membershipFailures.join("; ")
      : membershipChecked === 0
        ? "no pinned-channel membership could be checked"
        : `${membershipChecked} bot-channel membership(s) confirmed`,
  );

  // SLK004 — the events edge is up AND verifying: an unsigned POST must
  // be refused 401 (eve's signature check), never 2xx (would mean the
  // edge accepts forgeries) and never unreachable.
  const eventsAgents = agents.filter(
    (a) => sl.eventsReady && sl.apps[a]!.botEvents.length > 0 && sl.apps[a]!.eventsUrl !== "",
  );
  if (eventsAgents.length === 0) {
    add("SLK004", "unknown", "no app has events configured (eventsReady/botEvents/eventsUrl)");
  } else {
    const edgeFailures: string[] = [];
    let edgeUnknown = 0;
    for (const agent of eventsAgents) {
      const status = await deps.postStatus(sl.apps[agent]!.eventsUrl);
      if (status === null) {
        edgeUnknown++;
        edgeFailures.push(`${agent}: ${sl.apps[agent]!.eventsUrl} unreachable`);
      } else if (status !== 401) {
        edgeFailures.push(`${agent}: unsigned POST answered ${status}, expected 401`);
      }
    }
    add(
      "SLK004",
      edgeFailures.length === 0 ? "pass" : edgeUnknown === edgeFailures.length ? "unknown" : "fail",
      edgeFailures.length === 0
        ? `every events endpoint refuses an unsigned POST (${eventsAgents.length} endpoint(s))`
        : edgeFailures.join("; "),
    );
  }

  const fail = findings.filter((f) => f.status === "fail").length;
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "slack-prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: fail === 0,
    findings,
    summary: {
      pass: findings.filter((f) => f.status === "pass").length,
      fail,
      unknown: findings.filter((f) => f.status === "unknown").length,
    },
  };
}
