// The Eve harness driver: where a deployed agent actually is, how `hg`
// reaches it (a port-forward to the session API - an Eve pod has no
// `hermes` binary to exec), one prompt, and the smoke tier.
//
// Every network call goes through ./protocol.ts so the wire handling stays
// unit-testable offline; only the port-forward and the kubectl reads here
// touch a cluster.

import * as fs from "node:fs";
import { readAgentDeclaration } from "../../layout.ts";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  KCTX,
  loadState,
  VERSIONS,
  instanceNameOf,
  freePort,
  kubectl,
  log,
  ok,
  type ProfileCtx,
} from "../../lib.ts";
import { appStatusOf, looksLikePlaceholder } from "../../platform/index.ts";
import { projectedSecretName } from "../../connection/compile.ts";
import { bundleCoordinatesFor, loadEnvironment, type BundledProfile } from "../../topology/environment.ts";
import { EVE_PORT, EVE_ROUTE_AUTH_USERNAME, runTurn, sessionApi, WORKFLOW_FLOW_PATH } from "./protocol.ts";
import type { AgentExecResult, AgentSnapshot, HarnessDriver } from "../types.ts";
import type { RuntimeManifest } from "../manifest.ts";

// ---------------------------------------------------------------------------
// Cluster plumbing

/** Where a deployed Eve agent actually is (ADR-150). Standalone: its own
 * namespace, Service and StatefulSet pod, port 3000, Secrets named after
 * it. Bundled (environment/bundles.yaml names it, AND the bundle namespace
 * exists - the deployed-reality check backup.ts's backupNsOf makes, for
 * the same reason): the bundle's namespace/Service/pod, the member's own
 * port and route-auth Secret, the member container. Every placement-
 * dependent call in this module goes through here - the "bundle-blindness"
 * class of bug (five surfaces addressing a bundled member by its retired
 * standalone names) is not getting a sixth member. */
export interface EvePlacement {
  namespace: string;
  service: string;
  port: number;
  pod: string;
  container: string;
  routeAuthSecret: string;
  envSecret: string;
  bundle?: string;
}

export function evePlacement(ctx: ProfileCtx): EvePlacement {
  const root = ctx.subdir ? path.resolve(ctx.dir, ...ctx.subdir.split("/").map(() => "..")) : ctx.dir;
  let placement: BundledProfile | undefined;
  try {
    placement = loadEnvironment(root).environment.bundledProfiles?.[ctx.name];
  } catch {
    placement = undefined;
  }
  const deployed = placement
    ? kubectl(["get", "namespace", bundleCoordinatesFor(placement, "eve").namespace, "-o", "name"], { allowFail: true, quiet: true }).trim() !== ""
    : false;
  return resolvePlacement(ctx.name, placement, deployed);
}

/** The pure half of evePlacement: the declaration (if any) and whether the
 * bundle namespace exists in the cluster decide the coordinates. */
export function resolvePlacement(name: string, placement: BundledProfile | undefined, bundleDeployed: boolean): EvePlacement {
  // ADR-151: an Eve agent is `ag-eve-<name>`. Named from the runtime this
  // driver IS, not from the state-file lookup behind nsOf/appOf - that
  // defaults to "hermes" for any name the local state has not onboarded,
  // which is how a standalone Eve agent got hermes-* coordinates.
  const app = instanceNameOf(name, "eve");
  if (placement && bundleDeployed) {
    const { namespace, service } = bundleCoordinatesFor(placement, "eve");
    return {
      namespace,
      service,
      port: placement.apiServerPort ?? EVE_PORT + placement.memberIndex,
      pod: `${service}-0`,
      container: name,
      routeAuthSecret: `${service}-${name}-route-auth`,
      envSecret: placement.envSecretRef ?? `${app}-env`,
      bundle: placement.bundle,
    };
  }
  return {
    namespace: app,
    service: app,
    port: EVE_PORT,
    pod: `${app}-0`,
    container: "eve-agent",
    routeAuthSecret: `${app}-route-auth`,
    envSecret: `${app}-env`,
  };
}

/** The minted route-auth password (Secret hermes-<name>-route-auth, or the
 * member's hermes-<bundle>-<name>-route-auth). */
export function routeAuthPassword(ctx: ProfileCtx): string {
  const where = evePlacement(ctx);
  const b64 = kubectl(
    ["-n", where.namespace, "get", "secret", where.routeAuthSecret, "-o", "jsonpath={.data.password}"],
    { allowFail: true, quiet: true },
  ).trim();
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
}

/** The model credential check the Hermes path does for ANTHROPIC_API_KEY,
 * for the Eve env contract: every required secret in the v5 file must be a
 * non-placeholder value in the env Secret, else a turn would fail for a
 * reason that is not the agent's. Returns the first offending name. */
export function placeholderModelCredential(ctx: ProfileCtx): string | null {
  const ext = readAgentDeclaration(ctx.dir).raw as {
    runtime?: { envRequires?: (string | { name?: string; required?: boolean; secret?: boolean })[] };
  };
  for (const e of ext?.runtime?.envRequires ?? []) {
    const name = typeof e === "string" ? e : e?.name;
    const required = typeof e === "string" ? true : e?.required !== false;
    const secret = typeof e === "string" ? true : e?.secret !== false;
    if (!name || !required || !secret) continue;
    const where = evePlacement(ctx);
    const b64 = kubectl(
      ["-n", where.namespace, "get", "secret", where.envSecret, "-o", `jsonpath={.data.${name}}`],
      { allowFail: true, quiet: true },
    ).trim();
    const value = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
    if (!value || looksLikePlaceholder(value)) return name;
  }
  return null;
}

/** Run `fn` against the agent's Service through a short-lived port-forward. */
export async function withEveForward<T>(ctx: ProfileCtx, fn: (base: string) => Promise<T>): Promise<T> {
  const local = freePort();
  const where = evePlacement(ctx);
  const pf = Bun.spawn(
    ["kubectl", "--context", KCTX, "-n", where.namespace, "port-forward", `svc/${where.service}`, `${local}:${where.port}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    const base = `http://127.0.0.1:${local}`;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        if ((await fetch(`${base}/eve/v1/health`)).ok) break;
      } catch {
        /* not yet */
      }
      await Bun.sleep(1000);
    }
    return await fn(base);
  } finally {
    pf.kill();
  }
}

/** One prompt against a deployed Eve agent over its session API - the
 * Eve counterpart of platform.promptAgent, same result shape. */
export async function eveTurn(
  ctx: ProfileCtx,
  prompt: string,
  timeoutSec: number,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const missing = placeholderModelCredential(ctx);
  if (missing) {
    return {
      ok: false,
      output: "",
      error:
        `${ctx.name}: ${missing} is unset or a dev placeholder - the agent cannot reach a model ` +
        `provider. Supply a real value for this profile:\n` +
        `  hg envfile set ${missing}=<value> --profile ${ctx.name} --restart\n` +
        "(the value goes to an uncommitted .env overlay and the pod's env Secret, never to Git)",
    };
  }
  const password = routeAuthPassword(ctx);
  if (!password) {
    return { ok: false, output: "", error: `${ctx.name}: route-auth Secret ${evePlacement(ctx).routeAuthSecret} has no password yet` };
  }
  return withEveForward(ctx, (base) => runTurn(base, password, prompt, timeoutSec * 1000));
}


/** The smoke tier for an Eve agent: pods Ready, health 200, and one real
 * authenticated turn (skipped - not failed - when the model credential is a
 * placeholder, which is reported). */
export async function eveSmoke(ctx: ProfileCtx): Promise<boolean> {
  const where = evePlacement(ctx);
  log(`tier smoke [${ctx.name}]: Eve runtime checks${where.bundle ? ` (bundled in ${where.bundle})` : ""}`);
  const ns = where.namespace;
  let pass = true;
  const notReady = kubectl(
    ["-n", ns, "get", "pods", "--field-selector=status.phase!=Succeeded", "-o",
      'jsonpath={range .items[*]}{.metadata.name}={.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}'],
    { allowFail: true, quiet: true },
  )
    .split("\n")
    .filter((l) => l.trim() && !l.endsWith("=True"));
  if (notReady.length === 0) ok(`all pods Ready in ${ns}`);
  else {
    console.error(`  ✗ pods not Ready: ${notReady.join(", ")}`);
    pass = false;
  }
  const result = await withEveForward(ctx, async (base) => {
    let health = 0;
    try {
      health = (await fetch(`${base}/eve/v1/health`)).status;
    } catch {
      /* unreachable */
    }
    if (health === 200) ok(`GET /eve/v1/health -> 200`);
    else {
      console.error(`  ✗ GET /eve/v1/health -> ${health || "unreachable"}`);
      return false;
    }
    // The documented inspection route, with the minted credential: the
    // agent that answers must be THIS agent.
    const password = routeAuthPassword(ctx);
    const info = await sessionApi(base, password).info();
    const infoName = info.body?.agent?.name ?? info.body?.agent?.id;
    if (info.status === 200 && infoName === ctx.name) ok(`GET /eve/v1/info -> 200 (agent ${JSON.stringify(infoName)})`);
    else {
      console.error(`  ✗ GET /eve/v1/info -> ${info.status} (agent ${JSON.stringify(infoName ?? null)}, expected ${JSON.stringify(ctx.name)})`);
      return false;
    }
    const missing = placeholderModelCredential(ctx);
    if (missing) {
      log(`  (real turn skipped: ${missing} is a dev placeholder - hg envfile set ${missing}=<value> --profile ${ctx.name} --restart)`);
      return true;
    }
    const turn = await runTurn(base, password, "Reply with the single word: pong", 120_000);
    if (turn.ok) ok(`authenticated turn completed: ${JSON.stringify(turn.output.slice(0, 80))}`);
    else console.error(`  ✗ authenticated turn failed: ${turn.error}`);
    return turn.ok;
  });
  return pass && result;
}

/** What the project declares, read off its files - the legs that need it
 * (schedules, subagents, workspaces, apps) say "unknown: none declared"
 * rather than passing vacuously. */
export function declaredSurface(ctx: ProfileCtx): {
  schedules: { id: string; cron: string | null; needle: string }[];
  subagents: string[];
  apps: string[];
} {
  const out = { schedules: [] as { id: string; cron: string | null; needle: string }[], subagents: [] as string[], apps: [] as string[] };
  const schedDir = path.join(ctx.dir, "agent", "schedules");
  if (fs.existsSync(schedDir)) {
    for (const f of fs.readdirSync(schedDir).sort()) {
      if (!/\.(md|ts|js|mjs)$/.test(f)) continue;
      const text = fs.readFileSync(path.join(schedDir, f), "utf8");
      const cron = (text.match(/cron:\s*["']?([^"'\n]+)["']?/) ?? [])[1]?.trim() ?? null;
      const id = f.replace(/\.(md|ts|js|mjs)$/, "");
      // A markdown schedule's prompt is its body; that text is what the
      // world store records as the run's input. A handler schedule has no
      // fixed prompt - its id is the best needle.
      let needle = id;
      if (f.endsWith(".md")) {
        const body = text.replace(/^---[\s\S]*?---\s*/, "").trim().split("\n")[0]?.trim();
        if (body) needle = body;
      }
      out.schedules.push({ id, cron, needle });
    }
  }
  const subDir = path.join(ctx.dir, "agent", "subagents");
  if (fs.existsSync(subDir)) {
    for (const d of fs.readdirSync(subDir, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(subDir, d.name, "agent.ts"))) out.subagents.push(d.name);
    }
  }
  {
    const ext = readAgentDeclaration(ctx.dir).raw as { apps?: { name?: string }[] };
    for (const a of ext?.apps ?? []) if (a?.name) out.apps.push(a.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// `hg agent show` / `hg agent exec` for an Eve agent

/** What the deployed Eve agent is configured with (ADR-153).
 *
 * Two independent legs, and a failure in one must not erase the other: the
 * DECLARED half (schedules, subagents, workspaces, the record's sha) reads
 * the repository and the cluster's objects and works while the pod is down;
 * the LIVE half is `GET /eve/v1/info` through a port-forward. A snapshot
 * that could not reach the pod still reports what was deployed, and says
 * so in `problems` rather than returning nothing. */
export async function eveShow(ctx: ProfileCtx, timeoutSec = 60): Promise<AgentSnapshot> {
  const where = evePlacement(ctx);
  const surface = declaredSurface(ctx);
  const snapshot: AgentSnapshot = {
    profile: ctx.name,
    ok: true,
    engine: "eve",
    instance: where.bundle ? `${where.pod.replace(/-0$/, "")}/${ctx.name}` : instanceNameOf(ctx.name, "eve"),
    profileDir: ctx.dir,
    subagents: surface.subagents,
    schedules: surface.schedules.map((s) => ({ id: s.id, cron: s.cron })),
    problems: [],
  };



  // The runtime manifest the chart mounted at /hg (ADR-153), read from the
  // API server rather than the pod: it answers while the pod is down, which
  // is when "what did this agent get" is most often the question.
  const mounted = mountedManifest(ctx);
  if (mounted) {
    snapshot.runtimeRevision = mounted.spec.source.revision;
    snapshot.workspaces = mounted.spec.workspaces.map((w) => ({
      name: w.name, path: w.path, access: w.access, revision: w.revision,
    }));
    snapshot.connections = mounted.spec.connections;
  } else {
    snapshot.problems!.push(`no ${manifestConfigMapName(ctx)} ConfigMap in ${where.namespace} - redeploy (hg up) to mount the runtime manifest`);
    const revision = kubectl(
      ["-n", where.namespace, "get", "statefulset", where.pod.replace(/-0$/, ""), "-o",
        `jsonpath={.spec.template.spec.initContainers[*].env[?(@.name=="EVE_DIST_SHA")].value}`],
      { allowFail: true, quiet: true },
    ).trim().split(/\s+/).filter(Boolean)[0];
    if (revision) snapshot.runtimeRevision = revision;
  }

  const env = effectiveEnv(ctx, mounted);
  snapshot.problems!.push(...env.problems);
  if (env.keys.size) {
    snapshot.envKeys = [...env.keys.keys()].sort();
    snapshot.emptyEnvKeys = [...env.keys.entries()].filter(([, has]) => !has).map(([k]) => k).sort();
  }

  try {
    const info = await withEveForward(ctx, async (base) => {
      const api = sessionApi(base, routeAuthPassword(ctx), fetch, AbortSignal.timeout(timeoutSec * 1000));
      return api.info();
    });
    if (info.status !== 200 || !info.body) {
      snapshot.problems!.push(`GET /eve/v1/info returned ${info.status}`);
    } else {
      // The info body's shape (eve 0.42.0, `kind: eve-agent-info`): every
      // surface is grouped by ORIGIN - `authored` is what the persona
      // wrote, `framework` what eve mounts for every agent. Reporting the
      // group names ("authored, framework") instead of the members is the
      // obvious wrong reading of this body, so map it explicitly.
      const body = info.body as Record<string, any>;
      const agent = (body.agent ?? {}) as Record<string, any>;
      const modelRaw = agent.model ?? body.model;
      const model = typeof modelRaw === "object" && modelRaw ? modelRaw.id : modelRaw;
      if (typeof model === "string") snapshot.model = { name: model };
      const authored = (body.channels?.authored ?? []) as { name?: string; adapterKind?: string }[];
      snapshot.channels = [...new Set(authored.map((c) => `${c.name}${c.adapterKind ? ` (${c.adapterKind})` : ""}`))].sort();
      // The tools the agent can actually call, not the framework's whole
      // catalogue: `available` is what survived its own configuration.
      snapshot.tools = ((body.tools?.available ?? []) as { name?: string }[])
        .map((x) => x.name).filter((n): n is string => !!n).sort();
      const local = (body.subagents?.local ?? []) as { name?: string }[];
      if (local.length) snapshot.subagents = local.map((s) => s.name!).filter(Boolean).sort();
      const sched = (body.schedules ?? []) as { name?: string; cron?: string | null }[];
      if (sched.length) snapshot.schedules = sched.map((s) => ({ id: s.name ?? "?", cron: s.cron ?? null }));
      const skills = [...((body.skills?.static ?? []) as { name?: string }[]), ...((body.skills?.dynamic ?? []) as { name?: string }[])];
      snapshot.skills = skills.map((s) => s.name).filter((n): n is string => !!n).sort();
      const errs = body.diagnostics?.discoveryErrors ?? 0;
      const warns = body.diagnostics?.discoveryWarnings ?? 0;
      if (errs || warns) snapshot.problems!.push(`eve discovery reported ${errs} error(s), ${warns} warning(s)`);
    }
  } catch (e) {
    snapshot.problems!.push(`could not reach the agent: ${(e as Error).message}`);
  }

  if (snapshot.problems!.length === 0) delete snapshot.problems;
  return snapshot;
}

/** What the pod's environment ACTUALLY holds, and which of it is empty.
 *
 * Every Secret the pod's `envFrom` names, IN THAT ORDER: the agent's own
 * env Secret first, then one per bound connection. Order is the whole
 * point - a later envFrom wins in Kubernetes, so a connection's real
 * credential overrides an empty placeholder of the same name in the env
 * overlay. Reading only the first Secret shows the placeholder and hides
 * the credential, which is the exact failure this function exists to
 * prevent: `agent show` and the channel proof disagreed about whether a provider key
 * was present the moment the credential moved into its connection.
 *
 * The VALUES are read only to ask "is this empty" and are never kept,
 * printed or returned. A connection projection writes every key of its
 * provider's set, unset ones as empty strings, so a name list alone
 * reports an unsupplied token as configured. */
export function effectiveEnv(
  ctx: ProfileCtx,
  mounted: RuntimeManifest | null,
): { keys: Map<string, boolean>; problems: string[] } {
  const where = evePlacement(ctx);
  const keys = new Map<string, boolean>();
  const problems: string[] = [];
  const read = (name: string): boolean => {
    const raw = kubectl(
      ["-n", where.namespace, "get", "secret", name, "-o", "jsonpath={.data}"],
      { allowFail: true, quiet: true },
    ).trim();
    if (!raw) return false;
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
        keys.set(k, Buffer.from(v ?? "", "base64").length > 0);
      }
      return true;
    } catch {
      problems.push(`could not parse ${name}`);
      return false;
    }
  };
  read(where.envSecret);
  const instance = where.bundle ? `${where.pod.replace(/-0$/, "")}-${ctx.name}` : instanceNameOf(ctx.name, "eve");
  for (const c of mounted?.spec.connections ?? []) {
    const secret = projectedSecretName(instance, c.name);
    if (!read(secret)) problems.push(`connection ${c.name} is bound but ${secret} is absent in ${where.namespace}`);
  }
  return { keys, problems };
}

/** The debug escape hatch for an Eve agent: the engine's own CLI, in the
 * pod, in the project directory. The eve-runtime image installs `eve`
 * globally (harness/eve/image/Dockerfile), so this is the Eve
 * counterpart of `hermes <argv>` - a diagnostic, never a runtime path. */
export function eveExec(ctx: ProfileCtx, argv: string[], timeoutSec: number): AgentExecResult {
  const where = evePlacement(ctx);
  const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const proc = Bun.spawnSync(
    ["kubectl", "--context", KCTX, "-n", where.namespace, "exec", where.pod, "-c", where.container, "--",
      "sh", "-lc", `cd "\${EVE_PROJECT_DIR:-/app/src}" && eve ${quoted}`],
    { stdout: "pipe", stderr: "pipe", timeout: timeoutSec * 1000 },
  );
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

/** The name of the ConfigMap the chart renders the runtime manifest into:
 * `<instance>-runtime-manifest` standalone, `<bundle>-<member>-runtime-
 * manifest` for a bundled member (the charts' own naming). */
export function manifestConfigMapName(ctx: ProfileCtx): string {
  const where = evePlacement(ctx);
  return where.bundle
    ? `${where.pod.replace(/-0$/, "")}-${ctx.name}-runtime-manifest`
    : `${instanceNameOf(ctx.name, "eve")}-runtime-manifest`;
}

/** The runtime manifest as DEPLOYED, from the ConfigMap. null when the
 * object is absent or unparseable - never a partially-filled manifest,
 * which would read as a deployment that carried nothing. */
export function mountedManifest(ctx: ProfileCtx): RuntimeManifest | null {
  const where = evePlacement(ctx);
  const raw = kubectl(
    ["-n", where.namespace, "get", "configmap", manifestConfigMapName(ctx), "-o",
      "jsonpath={.data.runtime-manifest\\.json}"],
    { allowFail: true, quiet: true },
  ).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RuntimeManifest;
  } catch {
    return null;
  }
}

/** The Eve harness, as the registry consumes it (../index.ts). */
export const eveDriver: HarnessDriver = {
  runtime: "eve",
  invoke: (ctx, prompt, timeoutSec) => eveTurn(ctx, prompt, timeoutSec),
  show: (ctx, timeoutSec) => eveShow(ctx, timeoutSec),
  exec: async (ctx, argv, timeoutSec) => eveExec(ctx, argv, timeoutSec),
};
