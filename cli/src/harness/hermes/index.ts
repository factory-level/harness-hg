// The Hermes harness driver: everything `hg` does to a RUNNING Hermes
// agent (ADR-153). A Hermes pod ships the `hermes` CLI and its venv, so
// the driver's whole contract is `kubectl exec` - the opposite of the Eve
// driver next door, which has no binary to exec and drives a session API.
//
// What is NOT here, deliberately: the agent IMAGE plumbing for the local
// k3d loop (agentImagePresent/importAgentImage) and the Hermes dashboard's
// OIDC env, which are cluster and identity plumbing rather than "drive the
// agent", and stay in ../../platform.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import { KCTX, appOf, kubectl, nsOf, type ProfileCtx } from "../../lib.ts";
import { looksLikePlaceholder } from "../../platform/index.ts";
import type { AgentExecResult, AgentSnapshot, HarnessDriver, TurnResult } from "../types.ts";


/** Run `hermes <argv>` inside a profile's agent container.
 *
 * The pod name is COMPUTED (`hermes-<persona>-0`) rather than looked up,
 * which is sound only because the chart deploys a single-replica
 * StatefulSet under that exact name - the same assumption `hg env
 * --restart` makes when it rolls `statefulset/hermes-<persona>`.
 *
 * Capture, never stream: every caller wants the whole answer as data, and
 * `Bun.spawnSync` cannot interleave anyway. That does mean a long `hermes`
 * run prints nothing until it exits, so give slow verbs a real timeout.
 *
 * Never throws. A failure is data (`ok: false`) because the callers differ
 * on what a failure means - `hg agent apply` reports it per profile and
 * carries on, `hg prompt` turns it into a nonzero exit. */
export function execInAgent(
  ctx: ProfileCtx,
  argv: string[],
  timeoutSec: number,
): AgentExecResult {
  return execRawInAgent(ctx, [HERMES_BIN, ...argv], timeoutSec);
}

/** Absolute paths: the agent container's PATH carries neither. */
const HERMES_BIN = "/opt/hermes/bin/hermes";
const HERMES_PY = "/opt/hermes/.venv/bin/python3";

/** Run any command inside a profile's agent container. */
export function execRawInAgent(
  ctx: ProfileCtx,
  argv: string[],
  timeoutSec: number,
): AgentExecResult {
  const proc = Bun.spawnSync(
    ["kubectl", "--context", KCTX, "-n", nsOf(ctx.name), "exec", `${appOf(ctx.name)}-0`,
      "-c", "hermes-agent", "--", ...argv],
    { stdout: "pipe", stderr: "pipe", timeout: timeoutSec * 1000 },
  );
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode,
  };
}

/** Run ONE prompt against a deployed profile's agent, in its own pod,
 * with its own env and workspace - the same `hermes -p <persona> -z` a
 * human would run, wrapped so the local loop can exercise agent
 * BEHAVIOUR and not just deployment. */
export function promptAgent(
  ctx: ProfileCtx,
  prompt: string,
  timeoutSec: number,
): TurnResult {
  const ns = nsOf(ctx.name);

  // Refuse before spending a call if the credential is a dev placeholder.
  const key = kubectl(
    ["-n", ns, "get", "secret", `${appOf(ctx.name)}-env`,
      "-o", "jsonpath={.data.ANTHROPIC_API_KEY}"],
    { allowFail: true, quiet: true },
  ).trim();
  const decoded = key ? Buffer.from(key, "base64").toString("utf8") : "";
  if (!decoded || looksLikePlaceholder(decoded)) {
    return {
      ok: false,
      output: "",
      error:
        `${ctx.name}: ANTHROPIC_API_KEY is ${decoded ? "a dev placeholder" : "unset"} - the agent ` +
        "cannot reach a model provider. Supply a real key for this profile:\n" +
        `  hg envfile set ANTHROPIC_API_KEY=<key> --profile ${ctx.name} --restart\n` +
        "(the value goes to an uncommitted .env overlay and the pod's env Secret, never to Git)",
    };
  }

  const r = execInAgent(ctx, ["-p", ctx.name, "-z", prompt], timeoutSec);
  if (!r.ok) {
    return { ok: false, output: r.stdout, error: r.stderr || `hermes exited ${r.exitCode}` };
  }
  return { ok: true, output: r.stdout, ...(r.stderr ? { error: r.stderr } : {}) };
}


/** Names of the skills this distribution ships, from the local source. */
function declaredSkillsOf(ctx: ProfileCtx): string[] {
  const dir = path.join(ctx.dir, "skills");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/** Read the profile's on-disk state in ONE exec.
 *
 * Deliberately reads files rather than asking `hermes config get` key by
 * key: that would be a dozen round trips through kubectl, each paying
 * Hermes' import cost, to rebuild something a single `config.yaml` already
 * says. It also shows what the profile *declares* rather than what the
 * defaults would fill in, which is the question being asked.
 *
 * Runs under the venv interpreter because it needs PyYAML, and is passed
 * as one argv element so no shell ever sees it - no quoting hazard. */
const SNAPSHOT_PY = `
import json, os, sys
try:
    import yaml
except Exception:
    yaml = None

name = sys.argv[1]
home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
d = os.path.join(home, "profiles", name)

# A file that cannot be read is NOT the same as a file that says nothing.
# Reporting a corrupt config.yaml as "no configuration" would be this
# command asserting the precise falsehood it exists to catch, so every
# read failure is collected and surfaced instead of defaulted away.
problems = []

if not os.path.isdir(d):
    problems.append(
        "no profile directory at " + d + " - reporting on " + home + " instead; "
        "the profile may not be installed under this name"
    )
    d = home

def read_yaml(p):
    if not os.path.isfile(p):
        return {}
    if yaml is None:
        problems.append("cannot parse " + os.path.basename(p) + ": PyYAML unavailable")
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception as exc:
        problems.append(os.path.basename(p) + " is unreadable: " + str(exc))
        return {}

def read_json(p, default):
    if not os.path.isfile(p):
        return default
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        problems.append(os.path.basename(p) + " is unreadable: " + str(exc))
        return default

def listdir(p):
    if not os.path.isdir(p):
        return []
    try:
        return sorted(e for e in os.listdir(p) if not e.startswith("."))
    except Exception as exc:
        problems.append("cannot list " + p + ": " + str(exc))
        return []

cfg = read_yaml(os.path.join(d, "config.yaml"))
dist = read_yaml(os.path.join(d, "distribution.yaml"))
model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
plugins = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
mcp = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
platforms = cfg.get("platforms") if isinstance(cfg.get("platforms"), dict) else {}
webhook = platforms.get("webhook") if isinstance(platforms.get("webhook"), dict) else {}
routes = (webhook.get("extra") or {}).get("routes") if isinstance(webhook.get("extra"), dict) else {}

# The store is a {"jobs": [...]} envelope, but older stores were a bare
# list - accept both rather than silently reporting "no cron jobs", which
# is exactly the wrong answer for a command whose whole job is to notice
# when something declared is not running.
jobs = read_json(os.path.join(d, "cron", "jobs.json"), [])
if isinstance(jobs, dict):
    jobs = jobs.get("jobs") or []
if not isinstance(jobs, list):
    jobs = []
cron = [
    {
        "name": j.get("name"),
        "schedule": j.get("schedule_display") or "",
        "state": j.get("state") or ("scheduled" if j.get("enabled", True) else "paused"),
        "enabled": bool(j.get("enabled", True)),
        "nextRun": j.get("next_run_at"),
        "declaredBy": j.get("distribution_source"),
    }
    for j in jobs
    if isinstance(j, dict)
]
declarations = [
    f for f in listdir(os.path.join(d, "cron"))
    if f != "jobs.json" and os.path.splitext(f)[1].lower() in (".yaml", ".yml", ".json")
]
subs = read_json(os.path.join(d, "webhook_subscriptions.json"), {})

print(json.dumps({
    "problems": problems,
    "profileDir": d,
    "distribution": {"name": dist.get("name"), "version": dist.get("version")},
    "model": {"provider": model.get("provider"), "name": model.get("default") or model.get("name")},
    "skills": listdir(os.path.join(d, "skills")),
    "plugins": sorted(plugins.get("enabled") or []),
    "mcpServers": sorted(mcp.keys()),
    "platforms": {
        k: bool(v.get("enabled")) for k, v in platforms.items() if isinstance(v, dict)
    },
    "webhookEnabled": bool(webhook.get("enabled")),
    "webhookRoutes": sorted((routes or {}).keys()),
    "webhookSubscriptions": sorted(subs.keys()) if isinstance(subs, dict) else [],
    "cron": cron,
    "cronDeclarations": declarations,
    "sessions": len(listdir(os.path.join(d, "sessions"))),
}))
`;

/** What a profile's agent is actually configured with, right now.
 *
 * Env var NAMES are reported, never values - knowing DISCORD_BOT_TOKEN is
 * present is the whole diagnostic (a channel adapter enables itself off
 * the token), and printing the value would put a live credential in a
 * terminal and a CI log. */
export function agentShow(ctx: ProfileCtx, timeoutSec = 60): AgentSnapshot {
  const probe = execRawInAgent(ctx, [HERMES_PY, "-c", SNAPSHOT_PY, ctx.name], timeoutSec);
  if (!probe.ok) {
    return {
      profile: ctx.name,
      ok: false,
      engine: "hermes",
      error: probe.stderr || probe.stdout || `probe exited ${probe.exitCode}`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(probe.stdout) as Record<string, unknown>;
  } catch {
    return { profile: ctx.name, ok: false, engine: "hermes", error: `probe emitted unparseable output: ${probe.stdout.slice(0, 200)}` };
  }

  const secretJson = kubectl(
    ["-n", nsOf(ctx.name), "get", "secret", `${appOf(ctx.name)}-env`, "-o", "jsonpath={.data}"],
    { allowFail: true, quiet: true },
  ).trim();
  let envKeys: string[] = [];
  if (secretJson) {
    try {
      envKeys = Object.keys(JSON.parse(secretJson) as Record<string, string>).sort();
    } catch {
      envKeys = [];
    }
  }

  const snapshot: AgentSnapshot = {
    profile: ctx.name,
    ok: true,
    engine: "hermes",
    instance: appOf(ctx.name),
    envKeys,
    ...(parsed as Partial<AgentSnapshot>),
  };
  const declaredSkills = declaredSkillsOf(ctx);
  const present = new Set(snapshot.skills ?? []);
  snapshot.declaredSkills = declaredSkills;
  snapshot.missingSkills = declaredSkills.filter((s) => !present.has(s));
  return snapshot;
}

/** Converge this profile's declared cron jobs into its running agent.
 *
 * Runs the SAME command the chart's boot script runs, which is the point:
 * the local loop proves the production activation path rather than a
 * local imitation of it. */
export function agentApply(
  ctx: ProfileCtx,
  dryRun: boolean,
  timeoutSec = 120,
): { profile: string; ok: boolean; report?: unknown; error?: string } {
  const r = execInAgent(
    ctx,
    ["-p", ctx.name, "cron", "sync", "--json", ...(dryRun ? ["--dry-run"] : [])],
    timeoutSec,
  );
  // A pod built from an agent image predating `cron sync` fails here, and
  // that is the single most likely cause - so say it, rather than leaving
  // an argparse usage dump as the whole explanation.
  if (!r.ok && /invalid choice|unknown cron command|Usage: hermes cron/i.test(`${r.stderr}\n${r.stdout}`)) {
    return {
      profile: ctx.name,
      ok: false,
      error:
        "this agent image predates `hermes cron sync`, so declared cron jobs cannot be " +
        "activated. Rebuild the image from the fork and re-import it:\n" +
        "  docker build -t hermes-agent:hermes-gitops-dev <fork checkout>\n" +
        "  hg up",
    };
  }
  if (!r.ok) {
    return { profile: ctx.name, ok: false, error: r.stderr || r.stdout || `cron sync exited ${r.exitCode}` };
  }
  let report: unknown;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    return { profile: ctx.name, ok: false, error: `cron sync emitted unparseable JSON: ${r.stdout.slice(0, 200)}` };
  }
  // Validate the shape here rather than letting the caller assume it. A
  // runtime whose report format moved should surface as one profile's
  // structured failure, not as a TypeError halfway through a fleet run.
  const REPORT_KEYS = ["created", "updated", "pruned", "unchanged"] as const;
  const asRecord = report as Record<string, unknown> | null;
  const bad =
    !asRecord ||
    typeof asRecord !== "object" ||
    REPORT_KEYS.some((k) => !Array.isArray(asRecord[k]));
  if (bad) {
    return {
      profile: ctx.name,
      ok: false,
      error:
        `cron sync returned JSON without ${REPORT_KEYS.join("/")} arrays - the agent image's ` +
        `report format does not match this CLI: ${r.stdout.slice(0, 200)}`,
    };
  }
  return { profile: ctx.name, ok: true, report };
}

/** The Hermes harness, as the registry consumes it (../index.ts). The
 * functions above stay exported: `hg cron`, `hg bundle` and the ADR-28
 * preview call them directly, and there is no gain in routing a
 * Hermes-only command through a runtime switch. */
export const hermesDriver: HarnessDriver = {
  runtime: "hermes",
  invoke: async (ctx, prompt, timeoutSec) => promptAgent(ctx, prompt, timeoutSec),
  show: async (ctx, timeoutSec) => agentShow(ctx, timeoutSec),
  exec: async (ctx, argv, timeoutSec) => execInAgent(ctx, argv, timeoutSec),
};
