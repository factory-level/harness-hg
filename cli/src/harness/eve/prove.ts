// The Eve acceptance matrix: EVE001.. as `hg agent prove` reports it and
// `hg launch prove` aggregates it, plus the agent's own `eve eval` runner.
// A leg that could not run reports `unknown` - never a pass.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { instanceNameOf, KCTX, kubectl, loadState, log, ok, PLATFORM_ROOT, type ProfileCtx, VERSIONS } from "../../lib.ts";
import { appStatusOf, renderRecordArgv } from "../../platform/index.ts";
import { archivedClaims, clusterClaims, protectedStateLedger, type ProofFinding, type ProofResult } from "../../backup/platform.ts";
import { discoverRoutines, exportArtifact, restoreArtifact, runRoutine } from "../../backup/routines.ts";
import { desiredWorkspaces, workspaceVerify } from "../../workspace/index.ts";
import { loadEnvironment } from "../../topology/environment.ts";
import { validateRuntimeManifest, type RuntimeManifest } from "../manifest.ts";
import { resolveRuntimeManifest } from "../resolve.ts";
import {
  EVE_PORT,
  EVE_ROUTE_AUTH_USERNAME,
  TURN_BOUNDARY,
  WORKFLOW_FLOW_PATH,
  parseStreamLines,
  reduceTurn,
  runTurn,
  sessionApi,
  type StreamEvent,
} from "./protocol.ts";
import {
  declaredSurface,
  effectiveEnv,
  eveShow,
  eveSmoke,
  evePlacement,
  manifestConfigMapName,
  mountedManifest,
  placeholderModelCredential,
  routeAuthPassword,
  withEveForward,
} from "./driver.ts";

/** The agent's OWN evals (eve's `evals/` directory beside `agent/`,
 * docs/evals), run with `eve eval --url` against the deployed agent - from
 * INSIDE its pod, where the project's node_modules and evals/ already are,
 * against 127.0.0.1:3000, so no local toolchain is needed and the target is
 * exactly the process users reach. eve authenticates a remote target with
 * EVE_EVAL_AUTH_TOKEN as a bearer; the platform's default channel accepts
 * the minted password under that scheme too. Exit code is eve's own
 * contract: 0 every gate passed, 1 a failure, 2 a configuration error. */
export interface EveEvalsResult {
  ok: boolean;
  exitCode: number;
  /** eve eval --json output, parsed when parseable. */
  report: unknown;
  raw: string;
}

/** One line per eval from `eve eval --json` (0.42.0: `results[]` with
 * `id` and `verdict`, plus the verdict counts). Pure. */
export function summarizeEvalReport(report: unknown): { lines: string[]; counts: Record<string, number> } {
  const r = (report ?? {}) as {
    results?: { id?: string; verdict?: string; error?: string; assertions?: { name?: string; passed?: boolean; severity?: string }[] }[];
    passed?: number;
    failed?: number;
    scored?: number;
    skipped?: number;
    errored?: number;
  };
  const lines: string[] = [];
  for (const e of r.results ?? []) {
    const mark = e.verdict === "passed" ? "✓" : e.verdict === "failed" || e.verdict === "errored" ? "✗" : "?";
    lines.push(`${mark} ${e.id ?? "?"}: ${e.verdict ?? "?"}${e.error ? ` (${e.error})` : ""}`);
    for (const a of e.assertions ?? []) {
      lines.push(`    ${a.passed ? "✓" : "✗"} ${a.name ?? "?"}${a.severity ? ` [${a.severity}]` : ""}`);
    }
  }
  const counts: Record<string, number> = {};
  for (const k of ["passed", "failed", "scored", "skipped", "errored"] as const) {
    if (typeof r[k] === "number") counts[k] = r[k] as number;
  }
  return { lines, counts };
}

export function runAgentEvals(
  ctx: ProfileCtx,
  opts: { strict?: boolean; ids?: string[]; tags?: string[]; timeoutSec?: number } = {},
): EveEvalsResult {
  const where = evePlacement(ctx);
  const script =
    'set -eu; cd "$EVE_PROJECT_DIR"; ' +
    'if [ ! -d evals ]; then echo "no evals/ directory in the project - eve discovers evals under <project>/evals/ (docs/evals)" >&2; exit 2; fi; ' +
    'export EVE_EVAL_AUTH_TOKEN="$(cat "$ROUTE_AUTH_BASIC_PASSWORD_FILE")"; ' +
    `exec ./node_modules/.bin/eve eval --url http://127.0.0.1:${where.port} --json --skip-report` +
    (opts.strict ? " --strict" : "") +
    (opts.tags?.length ? opts.tags.map((t) => ` --tag '${t.replace(/'/g, "")}'`).join("") : "") +
    (opts.ids?.length ? " " + opts.ids.map((i) => `'${i.replace(/'/g, "")}'`).join(" ") : "");
  const proc = Bun.spawnSync(
    ["kubectl", "--context", KCTX, "-n", where.namespace, "exec", where.pod, "-c", where.container, "--", "sh", "-c", script],
    { stdout: "pipe", stderr: "pipe", timeout: (opts.timeoutSec ?? 600) * 1000 },
  );
  const out = proc.stdout.toString();
  const err = proc.stderr.toString();
  let report: unknown = null;
  // eve prints the JSON document last; tolerate log lines before it.
  const start = out.indexOf("{");
  if (start >= 0) {
    try {
      report = JSON.parse(out.slice(start));
    } catch {
      report = null;
    }
  }
  return { ok: proc.exitCode === 0, exitCode: proc.exitCode ?? -1, report, raw: (out + (err ? "\n" + err : "")).trim() };
}

/** Every field where two runtime manifests disagree, named. A boolean
 * would make EVE022 useless: "they differ" is not a diagnosis. */
export function manifestDiff(expected: RuntimeManifest, actual: RuntimeManifest): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, at: string): void => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    // Descend into arrays AND objects before reporting: the two producers
    // agree on VALUES, not on key order (Helm's toJson sorts keys,
    // JSON.stringify keeps insertion order), so a stringify comparison at
    // any level above a leaf reports differences that do not exist.
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((item, i) => walk(item, b[i], `${at}[${i}]`));
      return;
    }
    const bothObjects = a && b && typeof a === "object" && typeof b === "object" &&
      !Array.isArray(a) && !Array.isArray(b);
    if (bothObjects) {
      for (const k of [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort()) {
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k);
      }
      return;
    }
    out.push(`${at}: resolved ${JSON.stringify(a) ?? "absent"} != mounted ${JSON.stringify(b) ?? "absent"}`);
  };
  walk(expected, actual, "");
  return out;
}

/** Render the record for a ctx exactly as `hg up` would, for EVE005. */
function renderForIdempotency(ctx: ProfileCtx, sourceUrl: string, sha: string): string {
  const proc = Bun.spawnSync(renderRecordArgv(ctx, ctx.dir, sourceUrl, sha, {}), {
    cwd: PLATFORM_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString().trim() || `exit ${proc.exitCode}`);
  return proc.stdout.toString();
}

/** EVE006..011 - the documented eve channel contract (docs/channels/eve.mdx,
 * docs/concepts/sessions-runs-and-streaming.md), proven against the running
 * agent. Pure over the session client so it is unit-tested offline; none of
 * these legs needs a model credential - a session whose turn fails at the
 * model still exercises the documented routes, envelopes and event
 * vocabulary, and the model result is EVE004's business. */
export async function proveSessionContract(
  api: ReturnType<typeof sessionApi>,
  agentName: string,
  expectedEveVersion: string,
  add: (id: string, status: ProofFinding["status"], message: string) => void,
): Promise<void> {
  // EVE006 GET /eve/v1/info: 401 anonymous, 200 with the agent snapshot
  try {
    const anon = await api.info(true);
    const info = await api.info();
    const agentBlock = info.body?.agent ?? {};
    const name = agentBlock.name ?? agentBlock.id;
    const modelRaw = agentBlock.model ?? info.body?.model;
    const model = typeof modelRaw === "object" && modelRaw ? modelRaw.id : modelRaw;
    const good = anon.status === 401 && info.status === 200 && info.body?.tools !== undefined && info.body?.channels !== undefined;
    add("EVE006", good ? "pass" : "fail", `GET /eve/v1/info -> anonymous ${anon.status}, authenticated ${info.status}` +
      (good ? ` (agent ${JSON.stringify(name ?? "?")}, model ${JSON.stringify(model ?? "?")}, ${Object.keys(info.body?.tools ?? {}).length} tool group(s))` : " - expected 401 then 200 with tools/channels"));
  } catch (e) {
    add("EVE006", "fail", `info route failed: ${(e as Error).message}`);
  }

  // EVE007 create-once: the same operationId returns the same session
  let sessionId: string | undefined;
  try {
    const op = `hg-eve-prove-${Date.now()}`;
    const a = await api.create({ message: "hg agent prove: protocol check", operationId: op });
    const b = await api.create({ message: "hg agent prove: protocol check", operationId: op });
    sessionId = a.body?.sessionId;
    const good = a.status === 202 && a.body?.ok === true && a.body?.status === "accepted" && !!sessionId && b.body?.sessionId === sessionId;
    add("EVE007", good ? "pass" : "fail", good
      ? `POST /eve/v1/session -> 202 accepted; a retry with the same operationId returned the same session (${sessionId})`
      : `create -> ${a.status} ${JSON.stringify(a.body)}; retry -> ${b.status} ${JSON.stringify(b.body)}`);
  } catch (e) {
    add("EVE007", "fail", `session create failed: ${(e as Error).message}`);
  }

  // EVE008 the stream speaks the documented vocabulary, and the runtime
  // that answers is the pinned eve release
  if (sessionId) {
    try {
      const anon = await api.stream(sessionId, true);
      const s = await api.stream(sessionId);
      const types = s.events.map((e) => e.type);
      const started = s.events.find((e) => e.type === "session.started");
      const runtime = (started?.data as { runtime?: { agentName?: string; eveVersion?: string } } | undefined)?.runtime;
      const received = s.events.find((e) => e.type === "message.received");
      const boundary = types.find((t) => TURN_BOUNDARY.has(t));
      const vocab = !!started && types.includes("turn.started") && !!received && !!boundary;
      add("EVE008", anon.status === 401 && vocab ? "pass" : "fail",
        `stream -> anonymous ${anon.status}; authenticated ${s.status}: ${types.join(" → ") || "no events"}` +
          (vocab ? "" : " - expected session.started, turn.started, message.received and a turn boundary"));
      const pinOk = runtime?.eveVersion === expectedEveVersion && runtime?.agentName === agentName;
      add("EVE009", started ? (pinOk ? "pass" : "fail") : "unknown",
        started
          ? `session.started reports agent ${JSON.stringify(runtime?.agentName)} on eve ${JSON.stringify(runtime?.eveVersion)}` +
            (pinOk ? ` (== versions.json pin ${expectedEveVersion})` : ` - expected ${agentName} on ${expectedEveVersion}`)
          : "no session.started event to read the runtime from");
    } catch (e) {
      add("EVE008", "fail", `stream failed: ${(e as Error).message}`);
      add("EVE009", "unknown", "runtime version not read - the stream failed");
    }

    // EVE010 controls and terminal semantics: cancel/clear answer ok:true
    // with a documented status; reset retires the id; a follow-up to a
    // retired or unknown session is 409 session_not_active
    try {
      const cancel = await api.cancel(sessionId);
      const clear = await api.clear(sessionId);
      const reset = await api.reset(sessionId);
      const after = await api.followUp(sessionId, { message: "after reset" });
      const unknown = await api.followUp("wrun_hg_eve_prove_does_not_exist", { message: "x" });
      const okStatus = (r: { status: number; body: any }, allowed: string[]) =>
        (r.status === 200 || r.status === 202) && r.body?.ok === true && allowed.includes(r.body?.status);
      const good =
        okStatus(cancel, ["accepted", "no_active_turn"]) &&
        okStatus(clear, ["accepted", "no_active_session"]) &&
        okStatus(reset, ["accepted", "reset", "no_active_session"]) &&
        after.status === 409 && after.body?.code === "session_not_active" &&
        unknown.status === 409 && unknown.body?.code === "session_not_active";
      add("EVE010", good ? "pass" : "fail",
        `cancel ${cancel.status} ${cancel.body?.status}; clear ${clear.status} ${clear.body?.status}; reset ${reset.status} ${reset.body?.status}; ` +
          `follow-up after reset ${after.status} ${after.body?.code}; unknown id ${unknown.status} ${unknown.body?.code}`);
    } catch (e) {
      add("EVE010", "fail", `session controls failed: ${(e as Error).message}`);
    }
  } else {
    for (const id of ["EVE008", "EVE009", "EVE010"]) add(id, "unknown", "no session could be created (EVE007)");
  }

  // EVE011 every session route refuses anonymous callers; a create
  // without a message is a 400, not a session
  try {
    const legs = await Promise.all([
      api.followUp("wrun_x", { message: "x" }, true),
      api.cancel("wrun_x", true),
      api.reset("wrun_x", true),
    ]);
    const noMessage = await api.create({});
    const allRefused = legs.every((r) => r.status === 401);
    const good = allRefused && noMessage.status === 400 && noMessage.body?.ok === false;
    add("EVE011", good ? "pass" : "fail",
      `anonymous follow-up/cancel/reset -> ${legs.map((r) => r.status).join("/")}; create without message -> ${noMessage.status}` +
        (good ? "" : " - expected 401/401/401 and 400"));
  } catch (e) {
    add("EVE011", "fail", `route refusal probe failed: ${(e as Error).message}`);
  }
}


/** Seconds a schedule needs before its absence means anything: twice the
 * cron's shortest interval for the `*\/N` minute form, else ten minutes. */
export function scheduleWindowSeconds(cron: string | null): number {
  const m = cron?.match(/^\*\/(\d+)\s/);
  if (m) return 2 * Number(m[1]) * 60;
  return 600;
}

/** Whether the stream of a cancelled turn confirms the cancellation the way
 * the docs state it: turn.cancelled, then the session parks (session.waiting)
 * or the turn had already ended. Pure, for the unit test. */
export function cancelOutcome(events: StreamEvent[]): "confirmed" | "completed-first" | "unconfirmed" {
  const types = events.map((e) => e.type);
  const cancelled = types.indexOf("turn.cancelled");
  if (cancelled >= 0) {
    // Confirmed only when the session PARKS after the cancel (or the
    // recording ends there): a turn.failed / session.failed after it is a
    // cancel that broke something, not the documented semantics.
    const after = types.slice(cancelled + 1);
    const bad = after.some((t) => t === "turn.failed" || t === "session.failed" || t === "turn.completed");
    return !bad && (after.includes("session.waiting") || after.length === 0) ? "confirmed" : "unconfirmed";
  }
  if (types.includes("turn.completed")) return "completed-first";
  return "unconfirmed";
}

export interface ProveEveOptions {
  /** Run the legs that disturb the deployment (EVE013 pod restart, EVE018
   * restore round-trip). Off by default: they take minutes and re-roll the
   * pod. */
  deep?: boolean;
}

/** EVE001..020 for every Eve agent in the catalogue. */
export async function proveEve(ctxs: ProfileCtx[], opts: ProveEveOptions = {}): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });
  for (const ctx of ctxs.filter((c) => c.runtime === "eve")) {
    const component = ctx.name;
    const where = evePlacement(ctx);
    const surface = declaredSurface(ctx);
    await withEveForward(ctx, async (base) => {
      // EVE001 health
      try {
        const h = await fetch(`${base}/eve/v1/health`);
        add("EVE001", h.status === 200 ? "pass" : "fail", component, `GET /eve/v1/health -> ${h.status}`);
      } catch (e) {
        add("EVE001", "fail", component, `GET /eve/v1/health unreachable: ${(e as Error).message}`);
      }
      // EVE002 the Workflow callback handler is mounted under
      // /.well-known/workflow/ (eve's self-hosting guide: a proxy that
      // forwards only /eve/ starts sessions that then stall). The flow
      // route answers an empty POST with 400 "Missing request body" -
      // distinct from the 404 every unmounted path returns - so a 404 or
      // a 5xx here is a fail, not "served".
      try {
        const w = await fetch(`${base}${WORKFLOW_FLOW_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "",
        });
        // Exactly the handler's own answer to an empty body. An unmounted
        // path is 404; a proxy or a stalled app is 5xx; anything else is
        // not this handler.
        const mounted = w.status === 400;
        add(
          "EVE002",
          mounted ? "pass" : "fail",
          component,
          `POST ${WORKFLOW_FLOW_PATH} (empty body) -> ${w.status} (${mounted ? "the Workflow callback handler answered" : "expected the handler's 400"}; the Ingress must forward /.well-known/workflow/ too)`,
        );
      } catch (e) {
        add("EVE002", "fail", component, `${WORKFLOW_FLOW_PATH} unreachable: ${(e as Error).message}`);
      }
      // EVE003 anonymous session refused with a Basic challenge
      try {
        const a = await fetch(`${base}/eve/v1/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "ping" }),
        });
        const challenge = a.headers.get("www-authenticate") ?? "";
        const good = a.status === 401 && /basic/i.test(challenge);
        add("EVE003", good ? "pass" : "fail", component, `anonymous POST /eve/v1/session -> ${a.status} (WWW-Authenticate: ${challenge || "none"})`);
      } catch (e) {
        add("EVE003", "fail", component, `anonymous session probe failed: ${(e as Error).message}`);
      }
      // EVE004 an authenticated real turn
      const missing = placeholderModelCredential(ctx);
      const password = routeAuthPassword(ctx);
      if (!password) {
        add("EVE004", "fail", component, `route-auth Secret ${evePlacement(ctx).routeAuthSecret} has no password`);
      } else if (missing) {
        add("EVE004", "unknown", component, `${missing} is a dev placeholder - no model turn attempted (hg envfile set ${missing}=<value> --profile ${ctx.name} --restart)`);
      } else {
        const t = await runTurn(base, password, "Reply with the single word: pong", 120_000);
        add("EVE004", t.ok ? "pass" : "fail", component, t.ok ? `authenticated turn completed (${JSON.stringify(t.output.slice(0, 60))})` : `authenticated turn failed: ${t.error}`);
      }
      // EVE006..011 the documented channel contract
      if (password) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 60_000);
        try {
          await proveSessionContract(
            sessionApi(base, password, fetch, ctl.signal),
            ctx.name,
            VERSIONS.runtimes.eve.version,
            (id, status, message) => add(id, status, component, message),
          );
        } finally {
          clearTimeout(timer);
        }
      } else {
        for (const id of ["EVE006", "EVE007", "EVE008", "EVE009", "EVE010", "EVE011"]) {
          add(id, "unknown", component, "no route-auth credential to exercise the session API with");
        }
      }

      // ---- ADR-150: the documented behaviours beyond the route contract ----
      const api = password ? sessionApi(base, password) : null;
      const modelReady = !!api && !missing;

      // EVE012 cancel confirmed on the stream: a long turn, cancelled at
      // once, must show turn.cancelled (docs: cooperative cancel, then the
      // session parks). A model that finished before the cancel landed is
      // reported as such - not a pass.
      if (!modelReady) {
        add("EVE012", "unknown", component, missing ? `${missing} is a dev placeholder - no turn to cancel` : "no route-auth credential");
      } else {
        try {
          const c = await api!.create({ message: "Count slowly from 1 to 300, one number per line, no other text." });
          const sid = c.body?.sessionId as string | undefined;
          if (!sid) throw new Error(`create -> ${c.status} ${JSON.stringify(c.body)}`);
          await Bun.sleep(800);
          const cancel = await api!.cancel(sid);
          const s = await api!.streamFrom(sid, 0);
          const outcome = cancelOutcome(s.events);
          add("EVE012", outcome === "confirmed" ? "pass" : outcome === "completed-first" ? "unknown" : "fail", component,
            `cancel -> ${cancel.status} ${cancel.body?.status}; stream: ${s.events.map((e) => e.type).filter((t) => /turn\.|session\./.test(t)).join(" → ")}` +
              (outcome === "confirmed" ? " (turn.cancelled confirmed)" : outcome === "completed-first" ? " - the turn completed before the cancel landed; nothing to confirm" : " - no turn.cancelled on the stream"));
          await api!.reset(sid).catch(() => undefined);
        } catch (e) {
          add("EVE012", "fail", component, `cancel probe failed: ${(e as Error).message}`);
        }
      }

      // EVE014 compaction: the route answers, and the stream shows the
      // compaction pair when the context was large enough to compact.
      if (!api) {
        add("EVE014", "unknown", component, "no route-auth credential");
      } else {
        try {
          const c = await api.create({ message: "hg agent prove: compaction probe" });
          const sid = c.body?.sessionId as string | undefined;
          if (!sid) throw new Error(`create -> ${c.status}`);
          await api.stream(sid).catch(() => undefined);
          const compact = await api.compact(sid);
          const okRoute = (compact.status === 200 || compact.status === 202) && compact.body?.ok === true;
          const s = await api.streamFrom(sid, 0);
          const types = s.events.map((e) => e.type);
          const requested = types.includes("compaction.requested");
          const completed = types.includes("compaction.completed");
          add("EVE014", okRoute ? (completed ? "pass" : "unknown") : "fail", component,
            `POST .../compact -> ${compact.status} ${JSON.stringify(compact.body?.status ?? compact.body)}` +
              (completed ? "; compaction.requested → compaction.completed on the stream" : requested ? "; compaction.requested seen, no completion yet" : okRoute ? "; no compaction events - the context was below the threshold (not a pass)" : " - expected ok:true"));
          await api.reset(sid).catch(() => undefined);
        } catch (e) {
          add("EVE014", "fail", component, `compaction probe failed: ${(e as Error).message}`);
        }
      }

      // EVE016 subagent delegation: the declared subagents are on the
      // agent's model-visible surface, and if the project ships evals
      // tagged `composition` they pass against the deployment.
      if (surface.subagents.length === 0) {
        add("EVE016", "unknown", component, "no agent/subagents/ declared - nothing to delegate to");
      } else if (!api) {
        add("EVE016", "unknown", component, "no route-auth credential");
      } else {
        try {
          const info = await api.info();
          const toolsBlob = JSON.stringify(info.body?.tools ?? {}) + JSON.stringify(info.body?.subagents ?? {});
          const missingSub = surface.subagents.filter((s) => !toolsBlob.includes(`"${s}"`) && !toolsBlob.includes(`${s}`));
          const hasCompositionEval = fs.existsSync(path.join(ctx.dir, "evals")) &&
            fs.readdirSync(path.join(ctx.dir, "evals")).some((f) => f.endsWith(".eval.ts") && /composition/.test(fs.readFileSync(path.join(ctx.dir, "evals", f), "utf8")));
          if (missingSub.length > 0) {
            add("EVE016", "fail", component, `declared subagent(s) ${missingSub.join(", ")} absent from GET /eve/v1/info`);
          } else if (!modelReady) {
            add("EVE016", "unknown", component, `subagent(s) ${surface.subagents.join(", ")} on the info surface; no model credential to delegate with`);
          } else if (!hasCompositionEval) {
            add("EVE016", "unknown", component, `subagent(s) ${surface.subagents.join(", ")} on the info surface; no eval tagged composition to prove a delegation`);
          } else {
            const r = runAgentEvals(ctx, { tags: ["composition"] });
            const { counts } = summarizeEvalReport(r.report);
            add("EVE016", r.ok ? "pass" : "fail", component,
              `subagent(s) ${surface.subagents.join(", ")} on the info surface; composition eval(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || `exit ${r.exitCode}`}`);
          }
        } catch (e) {
          add("EVE016", "fail", component, `subagent probe failed: ${(e as Error).message}`);
        }
      }

      // EVE013 durability (--deep): after the pod is deleted and comes
      // back, a session created before replays from index 0 and accepts
      // a follow-up. Steps completed before the restart never re-run.
      if (!opts.deep) {
        add("EVE013", "unknown", component, "pod-restart durability leg runs with --deep");
      } else if (!api) {
        add("EVE013", "unknown", component, "no route-auth credential");
      } else {
        try {
          const c = await api.create({ message: "hg agent prove: durability marker" });
          const sid = c.body?.sessionId as string | undefined;
          if (!sid) throw new Error(`create -> ${c.status}`);
          const before = await api.stream(sid);
          kubectl(["-n", where.namespace, "delete", "pod", where.pod, "--wait=false"], { quiet: true });
          await Bun.sleep(5_000);
          kubectl(["-n", where.namespace, "rollout", "status", `statefulset/${where.service}`, "--timeout=600s"], { quiet: true });
          // A fresh forward: the old one died with the pod.
          const replay = await withEveForward(ctx, async (b2) => {
            const api2 = sessionApi(b2, password!);
            const s = await api2.streamFrom(sid, 0);
            const f = await api2.followUp(sid, { message: "still here?" });
            return { s, f };
          });
          const good = replay.s.events.length >= before.events.length && before.events.length > 0 && (replay.f.status === 202 || replay.f.status === 200);
          add("EVE013", good ? "pass" : "fail", component,
            `pod ${where.pod} deleted and back; session ${sid} replays ${replay.s.events.length} event(s) (${before.events.length} before); follow-up -> ${replay.f.status} ${replay.f.body?.status ?? replay.f.body?.code ?? ""}`);
        } catch (e) {
          add("EVE013", "fail", component, `durability probe failed: ${(e as Error).message}`);
        }
      }
    });

    // EVE015 schedules fire in-process: the world store holds a run whose
    // input is the schedule's prompt, once the pod has been up for two
    // intervals. Read from the pod, never from the dev dispatch route
    // (dev-only, not mounted in production).
    if (surface.schedules.length === 0) {
      add("EVE015", "unknown", component, "no agent/schedules/ declared");
    } else {
      try {
        const started = kubectl(["-n", where.namespace, "get", "pod", where.pod, "-o", "jsonpath={.status.startTime}"], { allowFail: true, quiet: true }).trim();
        const upSeconds = started ? (Date.now() - Date.parse(started)) / 1000 : 0;
        const results: string[] = [];
        let status: ProofFinding["status"] = "pass";
        for (const s of surface.schedules) {
          // The needle is repository-authored text: it travels as an argv
          // environment assignment (never interpolated into the shell
          // string) and grep matches it as a fixed string.
          const count = Number(kubectl(
            ["-n", where.namespace, "exec", where.pod, "-c", where.container, "--", "env", `HG_NEEDLE=${s.needle}`, "sh", "-c",
              'grep -lF -- "$HG_NEEDLE" "$EVE_PROJECT_DIR"/.eve/.workflow-data/runs/*.json 2>/dev/null | wc -l'],
            { allowFail: true, quiet: true },
          ).trim() || "0");
          const window = scheduleWindowSeconds(s.cron);
          if (count > 0) results.push(`${s.id} (${s.cron ?? "?"}): ${count} run(s)`);
          else if (upSeconds < window) { results.push(`${s.id}: none yet (pod up ${Math.round(upSeconds)}s < ${window}s window)`); if (status === "pass") status = "unknown"; }
          else { results.push(`${s.id} (${s.cron ?? "?"}): NO run after ${Math.round(upSeconds)}s`); status = "fail"; }
        }
        add("EVE015", status, component, results.join("; "));
      } catch (e) {
        add("EVE015", "fail", component, `schedule probe failed: ${(e as Error).message}`);
      }
    }

    // EVE017 the data claim is accounted for in the platform's ledger: a
    // routine archives it (or a declared exemption excuses it). UNACCOUNTED
    // is PLAT007's failure, reported here per agent.
    try {
      const claim = `data-${where.service}-0`;
      const entry = protectedStateLedger(clusterClaims(), archivedClaims()).find((e) => e.claim === claim && e.namespace === where.namespace);
      if (!entry) add("EVE017", "unknown", component, `claim ${claim} not found in ${where.namespace}`);
      else add("EVE017", entry.status === "UNACCOUNTED" ? "fail" : "pass", component,
        `${where.namespace}/${claim}: ${entry.status}${entry.status === "UNACCOUNTED" ? " - declare backup (schedule + retention) so the world store is archived" : where.bundle ? " (the bundle's routine)" : ""}`);
    } catch (e) {
      add("EVE017", "unknown", component, `ledger not read: ${(e as Error).message}`);
    }

    // EVE019 workspace bindings: every repository bound to this agent is
    // checked out at the resolved sha, with the declared access.
    try {
      const hgState = loadState();
      const desired = desiredWorkspaces(hgState);
      const mine = desired.bindings.filter((b) => b.targetProfiles.includes(ctx.name));
      if (mine.length === 0) add("EVE019", "unknown", component, "no workspace binding targets this agent");
      else {
        const v = workspaceVerify(hgState, desired, { profile: ctx.name });
        const rows = v.rows.filter((r) => r.profile === ctx.name);
        const bad = rows.filter((r) => !r.ok);
        add("EVE019", v.unreachable.includes(ctx.name) ? "unknown" : bad.length === 0 ? "pass" : "fail", component,
          rows.map((r) => `${r.repository}: ${r.ok ? `${r.probe?.revision?.slice(0, 12) ?? "?"} ${r.access}` : r.problems.join(", ")}`).join("; ") || "no rows");
      }
    } catch (e) {
      add("EVE019", "unknown", component, `workspace verify not run: ${(e as Error).message}`);
    }

    // EVE020 child apps: one Synced+Healthy Application per spec.apps[]
    // (standalone; a bundled member's apps deploy from the compiled
    // deployments/apps tree, outside this chart).
    if (surface.apps.length === 0) add("EVE020", "unknown", component, "no apps declared");
    else if (where.bundle) add("EVE020", "unknown", component, `bundled in ${where.bundle}: apps deploy from deployments/apps (hg topology emit), not from the bundle chart`);
    else {
      const states = surface.apps.map((a) => {
        const st = appStatusOf(`${instanceNameOf(ctx.name, "eve")}-${a}`);
        return { a, ok: st.sync === "Synced" && st.health === "Healthy", st };
      });
      add("EVE020", states.every((s) => s.ok) ? "pass" : "fail", component,
        states.map((s) => `${instanceNameOf(ctx.name, "eve")}-${s.a}: ${s.st.sync || "?"}/${s.st.health || "?"}`).join("; "));
    }

    // EVE018 restore round-trip (--deep): a session created before a fresh
    // backup replays after wipe+restore, and the rebuilt pod answers.
    if (!opts.deep) {
      add("EVE018", "unknown", component, "backup/restore round-trip runs with --deep");
    } else {
      try {
        const password = routeAuthPassword(ctx);
        if (!password) throw new Error("no route-auth credential");
        const sid = await withEveForward(ctx, async (b) => {
          const c = await sessionApi(b, password).create({ message: "hg agent prove: restore marker" });
          const id = c.body?.sessionId as string | undefined;
          if (!id) throw new Error(`create -> ${c.status}`);
          await sessionApi(b, password).stream(id).catch(() => undefined);
          return id;
        });
        const routines = discoverRoutines(ctx);
        if (routines.length === 0) throw new Error("no backup routine - declare backup first");
        const routine = routines[0]!;
        const run = runRoutine(ctx, routine, 600);
        if (!run.ok) throw new Error(`routine ${routine.name} did not complete`);
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-eve-restore-"));
        const report = exportArtifact(ctx, routine, tmp);
        restoreArtifact(ctx, routine, report.file, 900);
        kubectl(["-n", where.namespace, "rollout", "status", `statefulset/${where.service}`, "--timeout=900s"], { quiet: true });
        const replay = await withEveForward(ctx, async (b) => sessionApi(b, password).streamFrom(sid, 0));
        const health = await withEveForward(ctx, async (b) => (await fetch(`${b}/eve/v1/health`)).status);
        const good = replay.events.length > 0 && health === 200;
        add("EVE018", good ? "pass" : "fail", component,
          `${routine.name}: fresh archive ${path.basename(report.file)} exported, restored into ${routine.dataPvc}; session ${sid} replays ${replay.events.length} event(s); health ${health}`);
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (e) {
        add("EVE018", "fail", component, `restore round-trip failed: ${(e as Error).message}`);
      }
    }
    const env = effectiveEnv(ctx, mountedManifest(ctx));

    // EVE024 the chat conversation transport (ADR-154). A Chat SDK
    // EVE022 the runtime manifest the pod GOT equals the one this CLI
    // resolves offline from the same value documents. Two independent
    // producers - a Helm template and cli/src/harness/manifest.ts - so a
    // disagreement means one of them is lying about the deployment, and
    // this leg says which field. Parsed, not byte-compared: Helm's toJson
    // sorts keys and JSON.stringify does not.
    try {
      const mounted = mountedManifest(ctx);
      const resolved = resolveRuntimeManifest(loadState(), ctx);
      if (!mounted && !resolved) {
        add("EVE022", "unknown", component, `neither ${manifestConfigMapName(ctx)} nor an emitted record exists - nothing to compare`);
      } else if (!mounted) {
        add("EVE022", "unknown", component, `no ${manifestConfigMapName(ctx)} ConfigMap in ${where.namespace} - the deployment predates the runtime manifest (hg up)`);
      } else if (!resolved) {
        add("EVE022", "fail", component, "the pod carries a runtime manifest but no record resolves for this profile");
      } else {
        // Validate the MOUNTED copy against the frozen contract first: a
        // manifest that matches the offline resolve and violates the
        // schema means both producers are wrong together, which a
        // comparison alone would report as a pass.
        const invalid = validateRuntimeManifest(mounted);
        const diffs = manifestDiff(resolved.manifest, mounted);
        if (invalid.length) {
          add("EVE022", "fail", component, `the mounted manifest violates agent-runtime/v1alpha1: ${invalid.join("; ")}`);
        } else {
          add("EVE022", diffs.length === 0 ? "pass" : "fail", component, diffs.length === 0
            ? `runtime manifest at /hg is valid agent-runtime/v1alpha1 and matches the offline resolve ` +
              `(${mounted.spec.workspaces.length} workspace(s), ${mounted.spec.requiredSecrets.length} required ` +
              `secret name(s), ${mounted.spec.connections.length} connection(s))`
            : `mounted manifest differs from the offline resolve: ${diffs.join("; ")}`);
        }
      }
    } catch (e) {
      add("EVE022", "fail", component, `runtime manifest comparison failed: ${(e as Error).message}`);
    }

    // EVE023 `hg agent show` answers for an Eve agent at all - the
    // engine-neutral snapshot, with the deployed revision and the agent's
    // own declared surface. It exists because `hg agent show` assumed
    // Hermes until ADR-153 and simply failed here.
    try {
      const snap = await eveShow(ctx, 60);
      const revisionOk = !!snap.runtimeRevision && /^[0-9a-f]{40}$/.test(snap.runtimeRevision);
      const missing: string[] = [];
      if (snap.engine !== "eve") missing.push("engine");
      if (!revisionOk) missing.push("runtimeRevision");
      if (!snap.channels?.length) missing.push("channels");
      if (!snap.envKeys?.length) missing.push("envKeys");
      add("EVE023", missing.length === 0 ? "pass" : "fail", component, missing.length === 0
        ? `agent show: engine eve at ${snap.runtimeRevision!.slice(0, 12)}, channel(s) ${snap.channels!.join(", ")}, ` +
          `${snap.envKeys!.length} env name(s)${snap.problems?.length ? `; problems: ${snap.problems.join("; ")}` : ""}`
        : `agent show did not report ${missing.join(", ")}${snap.problems?.length ? ` (${snap.problems.join("; ")})` : ""}`);
    } catch (e) {
      add("EVE023", "fail", component, `agent show failed: ${(e as Error).message}`);
    }

    // EVE005 the record is a pure function of its inputs
    try {
      const src = "http://prove.invalid/profile-source.git";
      const sha = "0".repeat(40);
      const a = renderForIdempotency(ctx, src, sha);
      const b = renderForIdempotency(ctx, src, sha);
      add("EVE005", a === b ? "pass" : "fail", component, a === b ? `record renders byte-identically twice (eve ${VERSIONS.runtimes.eve.version} pin honoured)` : "two renders of the same inputs differ");
    } catch (e) {
      add("EVE005", "fail", component, `record render failed: ${(e as Error).message}`);
    }
  }
  const summary = {
    pass: findings.filter((f) => f.status === "pass").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "hg agent prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    findings,
    summary,
  };
}
