// The "up" machinery: everything that stands up (idempotently) the lite
// local platform - cluster, Argo CD, Grafana+Prometheus, the host git
// remotes, the rendered record, and the profile's Application. Ported
// from the proven mechanics of infra/scripts/smoke-local.sh: the docker
// bridge gateway IP is the one address reachable from both the host and
// every k3d pod, so a single URL string works on both sides.

import * as crypto from "node:crypto";
import { registryHost } from "./registry.ts";
import { agentLayout, readAgentDeclaration, teamDir } from "../layout.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  AGENT_IMAGE,
  EVE_RUNTIME_IMAGE,
  instanceNameOf,
  bundleAppOf,
  ARGOCD_CHART_VERSION,
  CLUSTER_NAME,
  CliError,
  HG_HOME,
  HgState,
  KCTX,
  PLATFORM_ROOT,
  VERSIONS,
  SERVE_GIT,
  SERVE_HTTP,
  SINK_LOG,
  STAGING,
  TestConfig,
  appNameOf,
  deepMerge,
  appOf,
  freePort,
  kubectl,
  loadEnvOverlay,
  loadTestConfig,
  log,
  namespaceOf,
  nsOf,
  ok,
  warn,
  pidAlive,
  portAccepts,
  profileCtxs,
  type ProfileCtx,
  saveState,
  sh,
  spawnDetached,
} from "../lib.ts";
import {
  CONNECTIONS_SECRET_NAMESPACE,
  PROVIDER_KEYS,
  compileConnections,
  connectionFiles,
  loadConnectionDeclarations,
  platformSecretName,
  type NormalizedConnectionBinding,
} from "../connection/compile.ts";
import { bundleCoordinatesFor } from "../topology/environment.ts";
import { grafanaCredentials } from "../dash/index.ts";

// Topology modules: their platform.ts references are type-only (erased),
// so these runtime imports create no cycle.
import { loadContracts, type Contract } from "../topology/contract.ts";
import { loadEnvironment, type Environment } from "../topology/environment.ts";
import { compile, type TopologyPlan } from "../topology/compile.ts";
import { renderTree } from "../topology/emit.ts";

const GIT_ENV_ID = [
  "-c",
  "user.email=hg@hermes-gitops.local",
  "-c",
  "user.name=hermes-gitops-cli",
];

export function ensureTools(): void {
  // Report EVERY missing tool at once (the validate philosophy, #673) -
  // a gate that reports one miss at a time turns a five-minute install
  // into five round trips.
  const missing = ["k3d", "kubectl", "helm", "git", "docker", "uv", "python3"]
    .filter((tool) => Bun.which(tool) === null);
  if (missing.length > 0) {
    throw new CliError(`required tool(s) not on PATH: ${missing.join(", ")}`);
  }
  sh(["docker", "info"], { quiet: true });
}

export function ensureCluster(): void {
  const clusters = sh(["k3d", "cluster", "list", "--no-headers"], { allowFail: true });
  if (!clusters.split("\n").some((l) => l.trim().split(/\s+/)[0] === CLUSTER_NAME)) {
    log(`creating k3d cluster ${CLUSTER_NAME}...`);
    sh(["k3d", "cluster", "create", CLUSTER_NAME, "--wait"]);
  } else {
    ok(`cluster ${CLUSTER_NAME} exists`);
  }
  sh(["k3d", "kubeconfig", "merge", CLUSTER_NAME, "--kubeconfig-switch-context"]);
}

export function gatewayIp(): string {
  const out = sh([
    "docker",
    "network",
    "inspect",
    `k3d-${CLUSTER_NAME}`,
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]).trim();
  if (!out) throw new CliError(`could not determine gateway IP for k3d-${CLUSTER_NAME}`);
  return out;
}

// ---------------------------------------------------------------------------
// Host-side servers (git daemon, dumb-http, alert sink), detached +
// idempotent: alive pids are reused, dead ones respawned.
// ---------------------------------------------------------------------------

/** One host server: reused when genuinely serving, reaped and respawned
 * when not, and VERIFIED before the caller is told it is up.
 *
 * The same discipline `ensureForward` applies to port-forwards, for the
 * same reason: **a live pid is not proof that anything is listening.** A
 * pid recorded in state can be recycled to an unrelated process, and a
 * daemon can die while its pid lingers - both report healthy under
 * `pidAlive` alone while the port is dead.
 *
 * The verification matters more than the reaping. These servers are
 * consumed by things that are NOWHERE NEAR this process: the agent pod's
 * init container clones `git://<gatewayIp>:<port>`, and Nexus's clones the
 * GitOps repo the same way. A `git daemon` that fails to bind used to be
 * silent here - `ok("host servers up")` printed regardless - and surfaced
 * an hour later as an unrelated pod stuck in Init:CrashLoopBackOff in
 * another namespace. Fail here, where the log file is one line away. */
function ensureHostServer(
  state: HgState,
  key: "gitDaemon" | "httpServer" | "sink",
  label: string,
  port: number,
  logFile: string,
  spawn: () => number,
): void {
  const pid = state.pids![key];
  if (pidAlive(pid) && portAccepts(port)) return;
  if (pidAlive(pid)) {
    // Alive but not serving: reap before rebinding, or the respawn races
    // a process still holding the port and dies on "address already in use".
    try {
      process.kill(pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  state.pids![key] = spawn();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (portAccepts(port)) return;
    Bun.sleepSync(100);
  }
  throw new CliError(
    `${label} did not start listening on 127.0.0.1:${port} within 10s.\n` +
      `  log: ${logFile}\n` +
      "  Nothing in the cluster can clone or call back to the host until this is up.",
  );
}

/** Host-side servers, idempotent and verified. Safe to call on every
 * command that needs them - a warm loop is three port probes. */
export function ensureServers(state: HgState): void {
  fs.mkdirSync(SERVE_GIT, { recursive: true });
  fs.mkdirSync(SERVE_HTTP, { recursive: true });
  state.ports = state.ports ?? { git: freePort(), http: freePort(), sink: freePort() };
  state.pids = state.pids ?? {};

  const gitLog = path.join(HG_HOME, "git-daemon.log");
  ensureHostServer(state, "gitDaemon", "git daemon", state.ports.git, gitLog, () =>
    spawnDetached(
      [
        "git",
        "daemon",
        `--base-path=${SERVE_GIT}`,
        "--export-all",
        "--enable=receive-pack",
        `--port=${state.ports!.git}`,
        "--reuseaddr",
      ],
      gitLog,
    ),
  );

  const httpLog = path.join(HG_HOME, "http-server.log");
  ensureHostServer(state, "httpServer", "profile-source http server", state.ports.http, httpLog, () =>
    spawnDetached(
      ["python3", "-m", "http.server", String(state.ports!.http), "--bind", "0.0.0.0"],
      httpLog,
      SERVE_HTTP,
    ),
  );

  ensureSink(state);

  saveState(state);
  ok(`host servers up (git:${state.ports.git} http:${state.ports.http} sink:${state.ports.sink})`);
}

/** The webhook sink alone - the debug observer's storage half (ADR-74).
 * `hg debug webhook enable` runs THIS without dragging up the whole local
 * loop's git/http servers; ensureServers still calls it for the loop. */
export function ensureSink(state: HgState): void {
  state.ports = state.ports ?? { git: freePort(), http: freePort(), sink: freePort() };
  state.pids = state.pids ?? {};
  const sinkLog = path.join(HG_HOME, "sink.log");
  ensureHostServer(state, "sink", "alert sink", state.ports.sink, sinkLog, () =>
    spawnDetached(
      [
        "python3",
        path.join(PLATFORM_ROOT, "infra", "scripts", "lib", "webhook-sink.py"),
        String(state.ports!.sink),
        SINK_LOG,
      ],
      sinkLog,
    ),
  );
  saveState(state);
}

/** SIGTERM the sink only, port-verified like stopServers. */
export function stopSink(state: HgState): void {
  const pid = state.pids?.sink;
  if (pidAlive(pid)) {
    try {
      process.kill(pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
    const port = state.ports?.sink;
    if (port !== undefined) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && portAccepts(port)) Bun.sleepSync(100);
      if (portAccepts(port)) {
        log(`! alert sink (pid ${pid}) still holds 127.0.0.1:${port} after SIGTERM`);
        return;
      }
    }
    ok("stopped alert sink");
  }
  if (state.pids) delete state.pids.sink;
  saveState(state);
}

/** The counterpart to ensureServers, and the thing that did not exist:
 * NOTHING stopped these. Not `expose --stop`, not `reset --nuclear`. They
 * outlived every session, and their stale pids in state were exactly what
 * made a dead daemon look alive to the old `pidAlive`-only check.
 *
 * SIGTERM, then confirm the port actually closed - a server that ignores
 * the signal must be reported, not silently assumed dead, or the next
 * `up` fails to bind and blames itself. */
export function stopServers(state: HgState, announce = true): void {
  const targets: [keyof NonNullable<HgState["pids"]>, string, number | undefined][] = [
    ["gitDaemon", "git daemon", state.ports?.git],
    ["httpServer", "profile-source http server", state.ports?.http],
    ["sink", "alert sink", state.ports?.sink],
    // Not a server, but a host-side process recorded in the same place and
    // leaked by the same omission - `down` means every one of them.
    ["routerPf", "event-router port-forward", state.ports?.router],
  ];
  for (const [key, label, port] of targets) {
    const pid = state.pids?.[key];
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
    if (port !== undefined) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && portAccepts(port)) Bun.sleepSync(100);
      if (portAccepts(port)) {
        log(`! ${label} (pid ${pid}) still holds 127.0.0.1:${port} after SIGTERM`);
        continue;
      }
    }
    if (announce) ok(`stopped ${label}`);
  }
  if (state.pids) {
    delete state.pids.gitDaemon;
    delete state.pids.httpServer;
    delete state.pids.sink;
    delete state.pids.routerPf;
  }
  saveState(state);
}

export function sinkUrl(state: HgState): string {
  return `http://${state.gatewayIp}:${state.ports!.sink}/alerts`;
}

// ---------------------------------------------------------------------------
// Repos: platform mirror (charts + hermes-profile chart), synthetic
// profile-source repo (dumb http; the agent boot clones it), gitops repo
// (cluster-values + the rendered record).
// ---------------------------------------------------------------------------

export function ensurePlatformMirror(state: HgState): void {
  const bare = path.join(SERVE_GIT, "platform.git");
  if (!fs.existsSync(bare)) {
    sh(["git", "clone", "--bare", PLATFORM_ROOT, bare]);
  } else {
    sh(["git", "--git-dir", bare, "fetch", PLATFORM_ROOT, "+refs/heads/*:refs/heads/*"]);
  }
  state.platformSha = sh(["git", "-C", PLATFORM_ROOT, "rev-parse", "HEAD"]).trim();
  saveState(state);
  ok(`platform mirror @ ${state.platformSha.slice(0, 12)}`);
}

/** Copy the profile's files into the synthetic profile repo, commit if
 * anything changed, push to the dumb-http mirror. Returns the HEAD sha.
 * The synthetic repo's ROOT is the profile dir's contents (root-layout
 * distribution), so spec.source needs no subdir. */
export function syncProfile(state: HgState): { sha: string; changed: boolean } {
  const work = path.join(STAGING, "profile");
  const bare = path.join(SERVE_HTTP, "profile-source.git");
  fs.mkdirSync(work, { recursive: true });
  if (!fs.existsSync(path.join(work, ".git"))) {
    sh(["git", "init", "-q", "-b", "main"], { cwd: work });
  }
  if (!fs.existsSync(bare)) {
    sh(["git", "init", "-q", "--bare", "-b", "main", bare]);
  }
  // rsync-like refresh: clear tracked content, copy fresh (excluding any
  // .git the profile dir itself may contain).
  for (const entry of fs.readdirSync(work)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(work, entry), { recursive: true, force: true });
  }
  sh([
    "sh",
    "-c",
    `cd ${JSON.stringify(state.profileDir)} && tar --exclude=.git -cf - . | tar -xf - -C ${JSON.stringify(work)}`,
  ]);
  sh(["git", "add", "-A"], { cwd: work });
  const dirty = sh(["git", "status", "--porcelain"], { cwd: work }).trim() !== "";
  if (dirty) {
    sh(["git", ...GIT_ENV_ID, "commit", "-q", "-m", "hg: profile sync"], { cwd: work });
  }
  sh(["git", "push", "-q", bare, "main:main", "--force"], { cwd: work });
  // Dumb HTTP needs the server-info refs regenerated after every update.
  sh(["git", "--git-dir", bare, "update-server-info"]);
  const sha = sh(["git", "rev-parse", "HEAD"], { cwd: work }).trim();
  return { sha, changed: dirty };
}

/** Effective appValues: the CLI's auto-defaults (monitoring's required
 * webhookUrl -> the local sink) under the profile's own test-config
 * overrides. */
export function effectiveAppValues(
  state: HgState,
  testCfg: TestConfig,
  profileDeclaresMonitoring: boolean,
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  // The local alert sink exists only once `hg up` has started the host
  // servers; `hg validate` runs before that (and on a checkout with no
  // loop at all), where there is no URL to inject.
  if (profileDeclaresMonitoring && state.ports?.sink) {
    base = { monitoring: { alert: { webhookUrl: sinkUrl(state) } } };
  }
  return deepMerge(base, testCfg.appValues);
}

export function profileDeclaresApp(profileDir: string, appName: string): boolean {
  const { raw } = readAgentDeclaration(profileDir);
  const apps = raw["apps"] as { name?: string }[] | undefined;
  return Boolean(apps?.some((a) => a?.name === appName));
}

/** The argv that renders ONE record through the real emitter pipeline -
 * the Hermes path (cli/render_record.py) or the Eve path (the push-driven
 * emit_cli with --render-only, ADR-149). One function so `up` and
 * `validate` can never render through different code. */
export function renderRecordArgv(
  ctx: ProfileCtx,
  profileDir: string,
  sourceUrl: string,
  sha: string,
  appValues: Record<string, unknown>,
): string[] {
  // The agent-team layout keeps the contract beside the payload, not in it:
  // the emitter is told where (P3 of ADR 0178 teaches it the flag).
  const layout = agentLayout(profileDir);
  const contractDir = layout.legacy ? [] : ["--contract-dir", layout.contractDir];
  if (ctx.runtime === "eve") {
    return [
      "uv", "run", "python", "-m", "gitops_emitter.emit_cli",
      "--runtime", "eve",
      "--agent-dir", profileDir,
      ...contractDir,
      "--name", ctx.name,
      "--source", sourceUrl,
      "--sha", sha,
      ...(ctx.subdir ? ["--subdir", ctx.subdir] : []),
      "--expect-eve-version", VERSIONS.runtimes.eve.version,
      "--app-values", JSON.stringify(appValues),
      "--render-only",
    ];
  }
  return [
    "uv", "run", "python", path.join(PLATFORM_ROOT, "cli", "render_record.py"),
    "--profile", profileDir,
    ...contractDir,
    "--name", ctx.name,
    "--source", sourceUrl,
    "--sha", sha,
    ...(ctx.subdir ? ["--subdir", ctx.subdir] : []),
    "--app-values", JSON.stringify(appValues),
  ];
}

export function renderRecord(
  state: HgState,
  ctx: ProfileCtx,
  profileSha: string,
  appValues: Record<string, unknown>,
): string {
  const sourceUrl = `http://${state.gatewayIp}:${state.ports!.http}/profile-source.git`;
  return sh(
    renderRecordArgv(ctx, path.join(STAGING, "profile", ctx.subdir), sourceUrl, profileSha, appValues),
    { cwd: PLATFORM_ROOT },
  );
}

/** One contract violation, in the shape `hg validate` reports and the
 * hermes-dev skills consume: what broke, where, and how to fix it. */
export interface ValidationFinding {
  profile: string;
  severity: "error" | "warning";
  check: string;
  message: string;
  file?: string;
  fix?: string;
}

const VALIDATE_SOURCE = "http://validate.invalid/profile-source.git";
const VALIDATE_SHA = "0".repeat(40);

/** Contract validation for ONE profile, WITHOUT a cluster or a git
 * remote: run the real emitter pipeline (render_record.py -> schema) on
 * the profile directory in place, then the checks the fleet would apply
 * at install time. Collects every finding instead of throwing on the
 * first - a gate that reports one error at a time turns a five-minute
 * fix into five round trips (design 08). */
export function validateProfile(
  state: HgState,
  ctx: ProfileCtx,
  testCfg: TestConfig,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const add = (f: Omit<ValidationFinding, "profile">) =>
    findings.push({ profile: ctx.name, ...f });

  // 1. The real render pipeline: load_extension_file -> resolve_apps
  // (appValues merge, valuesRequired enforcement) -> build_record ->
  // schema validate. Its stderr IS the actionable message.
  const proc = Bun.spawnSync(
    renderRecordArgv(ctx, ctx.dir, VALIDATE_SOURCE, VALIDATE_SHA, effectiveAppValues(state, testCfg, true)),
    { cwd: PLATFORM_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const renderOk = proc.exitCode === 0;
  const layout = agentLayout(ctx.dir);
  const agentFileRel = path.relative(state.profileDir, layout.agentFile);
  const testFileRel = path.relative(state.profileDir, layout.testFile);
  if (!renderOk) {
    add({
      severity: "error",
      check: "record-render",
      message: (proc.stderr.toString() || proc.stdout.toString()).trim(),
      file: agentFileRel,
      fix:
        ctx.runtime === "eve"
          ? `the emitter message names the field; fix it in ${path.basename(layout.agentFile)}, package.json or package-lock.json`
          : `the emitter message names the field; fix it in ${path.basename(layout.agentFile)} or distribution.yaml`,
    });
  }

  // 2. The env contract, exactly as the fleet enforces it at install
  // time (_check_required_secrets): every required: true env var needs a
  // value. Locally that means test.yaml `secrets:` or the .env overlay.
  // The declaration lives in distribution.yaml (Hermes) or the v5 file's
  // runtime.envRequires (Eve, ADR-149).
  type EnvEntry = { name?: string; required?: boolean } | string;
  let envRequires: EnvEntry[] = [];
  if (ctx.runtime === "eve") {
    if (!fs.existsSync(layout.agentFile)) {
      add({
        severity: "error",
        check: "manifest",
        message: `${path.basename(layout.agentFile)} is missing - an Eve agent's contract`,
        file: agentFileRel,
      });
      return findings;
    }
    const ext = readAgentDeclaration(ctx.dir).raw as { runtime?: { envRequires?: EnvEntry[] } };
    envRequires = ext?.runtime?.envRequires ?? [];
  } else {
    const manifestPath = path.join(ctx.dir, "distribution.yaml");
    if (!fs.existsSync(manifestPath)) {
      add({
        severity: "error",
        check: "manifest",
        message: "distribution.yaml is missing - a profile's ONE required file",
        file: path.join(ctx.subdir || ".", "distribution.yaml"),
      });
      return findings;
    }
    const manifest = parseYaml(fs.readFileSync(manifestPath, "utf8")) as {
      name?: string;
      env_requires?: EnvEntry[];
    } | null;
    envRequires = manifest?.env_requires ?? [];
  }
  const available = new Set([
    ...Object.keys(testCfg.secrets),
    ...Object.keys(loadEnvOverlay(state, ctx)),
  ]);
  for (const entry of envRequires) {
    const name = typeof entry === "string" ? entry : entry?.name;
    const required = typeof entry === "string" ? true : entry?.required !== false;
    if (!name || !required || available.has(name)) continue;
    add({
      severity: "error",
      check: "env-contract",
      message: `required env var ${name} has no local value - the fleet install fails the same way`,
      file: testFileRel,
      fix: `add it under secrets: in ${path.basename(layout.testFile)} (dev value), or run: hg envfile set ${name}=<value> --profile ${ctx.name}`,
    });
  }

  // 3. Smoke checks address Services by name; the chart names them
  // hermes-<persona>[-<app>-<component>]. A check naming another
  // profile's release can never pass - catch the typo here, not after a
  // 900s converge.
  for (const check of testCfg.smoke) {
    // The prefix must end at a delimiter: profile `foo` must not accept
    // `hermes-foobar-app-web`.
    const release = appOf(ctx.name);
    if (check.service !== release && !check.service.startsWith(`${release}-`)) {
      add({
        severity: "warning",
        check: "smoke-service-name",
        message:
          `smoke check targets Service ${check.service}, which is outside this profile's ` +
          `release prefix ${appOf(ctx.name)}-`,
        file: testFileRel,
        fix: `Services render as ${appOf(ctx.name)}-<app>-<component> (or ${appOf(ctx.name)} for the agent itself)`,
      });
    }
  }

  // 4. An oci:// app whose chart cannot be resolved is a sync failure
  // waiting to happen; flag when nothing local could have published it.
  {
    const ext = readAgentDeclaration(ctx.dir).raw as {
      apps?: { name?: string; chart?: string; repo?: string; version?: string }[];
    };
    for (const app of ext?.apps ?? []) {
      if (!app?.repo?.startsWith("oci://")) continue;
      const localChart = path.join(state.profileDir, "charts", app.chart ?? "");
      if (!fs.existsSync(path.join(localChart, "Chart.yaml"))) {
        add({
          severity: "warning",
          check: "oci-chart-source",
          message:
            `app ${app.name} pulls chart ${app.chart} from ${app.repo}, but this repo has no ` +
            `charts/${app.chart}/ - the registry copy must already be published`,
          file: agentFileRel,
          fix: "persona-owned charts live in this repo's charts/ and publish as OCI (hg dev pushes -dev.N builds)",
        });
      }
    }
  }

  // 6. Cron declarations. `hermes cron sync` runs unattended in the boot
  //    script, where a malformed declaration degrades to a log line nobody
  //    reads - so the real gate is here, before it ever reaches a cluster.
  const cronDir = path.join(ctx.dir, "cron");
  if (fs.existsSync(cronDir)) {
    // Names identify jobs across syncs, so a duplicate is not a style
    // question: two declarations claiming one name make convergence
    // ambiguous, and `cron sync` refuses the whole batch.
    const seenJobNames = new Map<string, string>();
    for (const entry of fs.readdirSync(cronDir)) {
      if (entry.startsWith(".") || entry === "jobs.json") continue;
      if (!/\.(ya?ml|json)$/i.test(entry)) continue;
      const rel = path.join(ctx.subdir || ".", "cron", entry);
      let docs: unknown;
      try {
        docs = parseYaml(fs.readFileSync(path.join(cronDir, entry), "utf8"));
      } catch (err) {
        add({
          severity: "error",
          check: "cron-declaration",
          message: `${entry} is not parseable: ${err instanceof Error ? err.message : String(err)}`,
          file: rel,
          fix: "a cron declaration is one job mapping, a list of them, or a jobs: list",
        });
        continue;
      }
      const raw = docs as { jobs?: unknown } | unknown[] | null;
      const jobs: unknown[] = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown[] }).jobs)
          ? (raw as { jobs: unknown[] }).jobs
          : raw
            ? [raw]
            : [];
      for (const job of jobs) {
        const j = job as { name?: unknown; schedule?: unknown; prompt?: unknown; skills?: unknown; no_agent?: unknown; script?: unknown } | null;
        if (!j || typeof j !== "object") {
          add({ severity: "error", check: "cron-declaration", message: `${entry}: every entry must be a mapping`, file: rel });
          continue;
        }
        if (typeof j.name !== "string" || !j.name.trim()) {
          add({
            severity: "error",
            check: "cron-declaration",
            message: `${entry}: 'name' is required - it is how sync identifies the job across syncs`,
            file: rel,
          });
        } else {
          const prior = seenJobNames.get(j.name.trim());
          if (prior) {
            add({
              severity: "error",
              check: "cron-declaration",
              message: `${entry}: job name ${JSON.stringify(j.name.trim())} is already declared in ${prior} - names identify jobs, so they must be unique`,
              file: rel,
              fix: "rename one of them; sync refuses the whole batch on a duplicate",
            });
          }
          seenJobNames.set(j.name.trim(), entry);
        }
        if (j.skills !== undefined) {
          const bad = !Array.isArray(j.skills) || j.skills.some((s) => typeof s !== "string");
          if (bad) {
            add({
              severity: "error",
              check: "cron-declaration",
              message: `${entry}: 'skills' must be a list of skill names`,
              file: rel,
            });
          }
        }
        if (typeof j.schedule !== "string" || !j.schedule.trim()) {
          add({
            severity: "error",
            check: "cron-declaration",
            message: `${entry}: 'schedule' is required (e.g. 'every 2h', '0 6 * * 1')`,
            file: rel,
          });
        }
        const hasWork =
          (typeof j.prompt === "string" && j.prompt.trim()) ||
          (Array.isArray(j.skills) && j.skills.length) ||
          (j.no_agent === true && typeof j.script === "string" && j.script.trim());
        if (!hasWork) {
          add({
            severity: "error",
            check: "cron-declaration",
            message: `${entry}: needs a self-contained 'prompt' (or skills, or no_agent + script) - a cron run has no chat history to lean on`,
            file: rel,
          });
        }
      }
    }
  }

  // 7. mcp.json is a trap: `hermes profile install` treats it as
  //    distribution-owned and faithfully copies it onto every agent, but
  //    the runtime reads MCP servers from config.yaml's mcp_servers. A
  //    profile shipping one looks configured and has no MCP at all.
  const mcpJson = path.join(ctx.dir, "mcp.json");
  if (fs.existsSync(mcpJson)) {
    // Severity depends on whether anything is actually being lost. An
    // mcp.json with servers in it, and no mcp_servers in config.yaml, is a
    // definite defect - those servers will never exist. An mcp.json that is
    // empty, or duplicated correctly in config.yaml, is only clutter.
    let declaresServers = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpJson, "utf8")) as Record<string, unknown> | null;
      const servers = (parsed?.["mcpServers"] ?? parsed) as Record<string, unknown> | null;
      declaresServers = Boolean(servers && typeof servers === "object" && Object.keys(servers).length);
    } catch {
      declaresServers = true; // unreadable: assume it was meant to do something
    }
    let configHasServers = false;
    const cfgPath = path.join(ctx.dir, "config.yaml");
    if (fs.existsSync(cfgPath)) {
      const cfg = parseYaml(fs.readFileSync(cfgPath, "utf8")) as { mcp_servers?: Record<string, unknown> } | null;
      configHasServers = Boolean(cfg?.mcp_servers && Object.keys(cfg.mcp_servers).length);
    }
    const lost = declaresServers && !configHasServers;
    add({
      severity: lost ? "error" : "warning",
      check: "mcp-json-inert",
      message: lost
        ? "mcp.json declares MCP servers that will NEVER be created - it is copied onto the agent " +
          "and read by nothing, and config.yaml declares no mcp_servers"
        : "mcp.json is copied onto the agent but read by nothing - the runtime resolves MCP servers " +
          "from config.yaml's mcp_servers",
      file: path.join(ctx.subdir || ".", "mcp.json"),
      fix: "move the servers into config.yaml under mcp_servers: and delete mcp.json",
    });
  }

  return findings;
}

/** Logs + failure context for one profile: the agent pod's containers
 * and every app pod, plus the previous container on a restart and the
 * pod's own not-Ready reason. The review surface the hermes-dev skills
 * read (#161's sibling: you cannot fix what you cannot see). */
export interface PodLogs {
  profile: string;
  pod: string;
  container: string;
  ready: boolean;
  restarts: number;
  reason?: string;
  previous?: string;
  lines: string[];
}

interface ContainerState {
  reason?: string;
  message?: string;
  exitCode?: number;
}
interface K8sContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  state?: Record<string, ContainerState>;
  lastState?: Record<string, ContainerState>;
}

/** Why a container is not running, from every field that carries it:
 * the current state's reason+message, then the LAST terminated state
 * (a CrashLoopBackOff's current state says only "CrashLoopBackOff" -
 * the exit code and message live in lastState), then the pod phase. */
function containerReason(cs: K8sContainerStatus, phase?: string): string | undefined {
  const parts: string[] = [];
  const cur = Object.values(cs.state ?? {})[0];
  if (cur?.reason) parts.push(cur.reason);
  if (cur?.message) parts.push(cur.message.trim());
  const last = cs.lastState?.["terminated"];
  if (last?.reason || last?.exitCode !== undefined) {
    parts.push(
      `last termination: ${last.reason ?? "?"}` +
        (last.exitCode !== undefined ? ` (exit ${last.exitCode})` : "") +
        (last.message ? ` ${last.message.trim()}` : ""),
    );
  }
  if (parts.length === 0 && phase && phase !== "Running") parts.push(phase);
  return parts.length > 0 ? parts.join(" — ") : undefined;
}

/** True when `pod` belongs to app `app` of this profile: the release
 * prefix must end at a delimiter, so `--app post` does NOT match
 * `postiz`. */
function podBelongsToApp(pod: string, persona: string, app: string): boolean {
  return pod.startsWith(`${appOf(persona)}-${app}-`) || pod === `${appOf(persona)}-${app}`;
}

export function collectLogs(
  ctx: ProfileCtx,
  opts: { app?: string; tail: number },
): PodLogs[] {
  const ns = nsOf(ctx.name);
  const proc = Bun.spawnSync(
    ["kubectl", "--context", KCTX, "-n", ns, "get", "pods", "-o", "json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    // Distinguish "cannot look" from "nothing there" - a silent [] here
    // sends a diagnosing agent hunting for a workload bug that is really
    // a missing cluster, namespace or credential.
    return [
      {
        profile: ctx.name,
        pod: "<none>",
        container: "<kubectl>",
        ready: false,
        restarts: 0,
        reason: `could not list pods in ${ns}: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}`,
        lines: [],
      },
    ];
  }
  let pods: {
    metadata?: { name?: string };
    status?: {
      phase?: string;
      containerStatuses?: K8sContainerStatus[];
      initContainerStatuses?: K8sContainerStatus[];
    };
  }[] = [];
  try {
    pods = (JSON.parse(proc.stdout.toString()) as { items?: typeof pods }).items ?? [];
  } catch {
    return [];
  }
  const out: PodLogs[] = [];
  for (const pod of pods) {
    const podName = pod.metadata?.name ?? "";
    if (!podName) continue;
    if (opts.app && !podBelongsToApp(podName, ctx.name, opts.app)) continue;
    // INIT containers first: a failed bootstrap-distribution means the
    // main containers never ran, so their (empty) logs explain nothing.
    const statuses: [K8sContainerStatus, boolean][] = [
      ...(pod.status?.initContainerStatuses ?? []).map(
        (cs) => [cs, true] as [K8sContainerStatus, boolean],
      ),
      ...(pod.status?.containerStatuses ?? []).map(
        (cs) => [cs, false] as [K8sContainerStatus, boolean],
      ),
    ];
    for (const [cs, isInit] of statuses) {
      const container = cs.name ?? "";
      const lines = kubectl(
        ["-n", ns, "logs", podName, "-c", container, `--tail=${opts.tail}`],
        { allowFail: true, quiet: true },
      )
        .split("\n")
        .filter((l) => l.length > 0);
      // A restarted container's PREVIOUS logs hold the actual crash.
      let previous: string | undefined;
      if ((cs.restartCount ?? 0) > 0) {
        const prev = kubectl(
          ["-n", ns, "logs", podName, "-c", container, "--previous", `--tail=${opts.tail}`],
          { allowFail: true, quiet: true },
        ).trim();
        if (prev) previous = prev;
      }
      out.push({
        profile: ctx.name,
        pod: podName,
        container: isInit ? `${container} (init)` : container,
        ready: Boolean(cs.ready),
        restarts: cs.restartCount ?? 0,
        reason: containerReason(cs, pod.status?.phase),
        previous,
        lines,
      });
    }
  }
  return out;
}

/** Values that are obviously not a real provider credential - the local
 * loop's committed dev defaults. Prompting with one of these burns a
 * round trip to get an opaque auth error, so `hg prompt` refuses first
 * and says exactly how to fix it (the platform's fail-loudly rule). */
const PLACEHOLDER_MARKERS = ["local-dev", "placeholder", "replace-me", "changeme", "dummy"];

export function looksLikePlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "" || PLACEHOLDER_MARKERS.some((m) => v.includes(m));
}

/** Argo CD's own verdict on a profile: sync/health plus any condition
 * messages (the allowlist guard, a missing chart, an unresolvable
 * revision all land here rather than in pod logs). */
export function appConditions(name: string): { type: string; message: string }[] {
  const proc = Bun.spawnSync(
    ["kubectl", "--context", KCTX, "-n", "argocd", "get", "application", appOf(name),
      "-o", "jsonpath={.status.conditions}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    // Not the same as "no conditions": the Application may not exist, or
    // the cluster may be unreachable. Say which.
    return [
      {
        type: "LookupFailed",
        message: `could not read Application ${appOf(name)}: ${
          proc.stderr.toString().trim() || `exit ${proc.exitCode}`
        }`,
      },
    ];
  }
  const raw = proc.stdout.toString().trim();
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as { type?: string; message?: string }[]).map((c) => ({
      type: c.type ?? "",
      message: c.message ?? "",
    }));
  } catch {
    return [];
  }
}

/** Remote helm repos the profile's apps pull from - needed on both the
 * cluster-values allowlist (chart-side guard) and the AppProject
 * (server-side enforcement). */
export function remoteAppRepos(recordYaml: string): string[] {
  const record = parseYaml(recordYaml) as {
    spec?: { apps?: { repo?: string }[] };
  };
  const repos = (record.spec?.apps ?? [])
    .map((a) => a.repo ?? "")
    .filter((r) => r.startsWith("https://") || r.startsWith("oci://"));
  return [...new Set(repos)];
}

export function publishGitops(
  state: HgState,
  records: { name: string; yaml: string }[],
  /** Called with the staged working copy before commit, so callers can add
   * generated trees (the Nexus plan) to the SAME commit as the records.
   * A throw is the caller's problem, not this function's. */
  extraTrees?: (workDir: string) => void,
): void {
  const work = path.join(STAGING, "gitops");
  const bare = path.join(SERVE_GIT, "gitops.git");
  fs.mkdirSync(work, { recursive: true });
  if (!fs.existsSync(path.join(work, ".git"))) {
    sh(["git", "init", "-q", "-b", "main"], { cwd: work });
  }
  if (!fs.existsSync(bare)) {
    sh(["git", "init", "-q", "--bare", "-b", "main", bare]);
  }

  // cluster-values: the canonical scaffold template with the CLI's own
  // token substitution (same alphabet, same rules as the emitter's
  // scaffold step - infra/gitops-template/README.md). The allowlist is
  // the UNION across every record - one fleet, one environment file.
  const template = fs.readFileSync(
    path.join(PLATFORM_ROOT, "infra", "gitops-template", "bootstrap", "values", "cluster-values.yaml"),
    "utf8",
  );
  const platformUrl = `git://${state.gatewayIp}:${state.ports!.git}/platform.git`;
  let clusterValuesText = template
    .replace(/__HERMES_GITOPS_REPO_URL__/g, platformUrl)
    .replace(/__CHART_REVISION__/g, state.platformSha!)
    .replace(/__IMAGE_REPOSITORY__/g, "hermes-agent")
    .replace(/__IMAGE_TAG__/g, "hermes-gitops-dev");
  const clusterValues = parseYaml(clusterValuesText) as Record<string, unknown>;
  const repos = [...new Set(records.flatMap((r) => remoteAppRepos(r.yaml)))];
  (clusterValues["appProject"] as Record<string, unknown>)["sourceRepos"] = repos;
  fs.mkdirSync(path.join(work, "bootstrap", "values"), { recursive: true });
  fs.writeFileSync(
    path.join(work, "bootstrap", "values", "cluster-values.yaml"),
    stringifyYaml(clusterValues),
  );
  for (const record of records) {
    fs.mkdirSync(path.join(work, "profiles", record.name), { recursive: true });
    fs.writeFileSync(path.join(work, "profiles", record.name, "profile.yaml"), record.yaml);
  }

  extraTrees?.(work);
  sh(["git", "add", "-A"], { cwd: work });
  if (sh(["git", "status", "--porcelain"], { cwd: work }).trim() !== "") {
    sh(["git", ...GIT_ENV_ID, "commit", "-q", "-m", "hg: gitops sync"], { cwd: work });
  }
  sh(["git", "push", "-q", bare, "main:main", "--force"], { cwd: work });
}

// ---------------------------------------------------------------------------
// Cluster-side installs (helm, image, project, Application).
// ---------------------------------------------------------------------------

function helmInstalled(release: string, ns: string): boolean {
  const out = sh(["helm", "status", release, "-n", ns, "--kube-context", KCTX], {
    allowFail: true,
    quiet: true,
  });
  return out.includes("STATUS: deployed");
}

/** Is the deployed Argo CD actually carrying an OIDC config? One cheap
 * read per tick, and the difference between a milestone that applies and
 * one that quietly does not. */
export function argocdOidcConfigured(): boolean {
  return kubectl(
    ["-n", "argocd", "get", "cm", "argocd-cm", "-o", "jsonpath={.data.oidc\\.config}"],
    { allowFail: true, quiet: true },
  ).trim().length > 0;
}

/** Development-only anonymous Grafana viewing (#422, #447).
 *
 * ON by default in the local loop: #447 checked whether the embed proofs
 * were still being run after #422 made this an opt-in, and they had gone
 * quiet - the manual step nobody remembers was exactly the risk the
 * issue named, so the loop now sets the flag for itself. The loop is by
 * definition a development environment; `HG_GRAFANA_ANON_VIEWER=0` opts
 * out for an operator who wants Grafana auth locally. Only the exact
 * negative spellings ("0", "false") count as opting out.
 *
 * Read at CALL time rather than captured at import, so flipping it is
 * `HG_GRAFANA_ANON_VIEWER=0 hg up` with no reinstall of anything else -
 * the same convention `uptimePushConfig` uses for its push credentials.
 *
 * This exists because a cold development cluster has nobody logged in,
 * so every Nexus Grafana embed renders a login page and iterating on the
 * embeds means re-authenticating constantly. It is a velocity tool. The
 * trusted edge in front of a development environment is NOT a substitute
 * for Grafana authorization in production, and nothing here should ever
 * be set for a deployed environment - which is why it is an operator-host
 * environment variable read only by the LOCAL loop (`hg up` and
 * `hg auth prove`), never a chart value that could ride into Git, and
 * never anything the Pulumi/deployed path consults.
 */
export function grafanaAnonymousViewerRequested(): boolean {
  const raw = (process.env.HG_GRAFANA_ANON_VIEWER ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/** The override that keeps anonymous Viewer on even once an issuer is
 * configured. Merged LAST, because grafanaOidcValues deliberately turns
 * anonymous off and would otherwise win.
 *
 * Note what this does NOT touch: `role_attribute_strict` stays true,
 * `allow_assign_grafana_admin` stays false, and the login form stays.
 * Anonymous gets Viewer and nothing else, so an unmapped identity is
 * still denied and no anonymous visitor can edit a dashboard, a
 * datasource, an alert rule or a user. */
export function devAnonymousGrafanaValues(): Record<string, unknown> {
  if (!grafanaAnonymousViewerRequested()) return {};
  return {
    grafana: {
      "grafana.ini": { "auth.anonymous": { enabled: true, org_role: "Viewer" } },
    },
  };
}

/** Whether the LIVE Grafana is actually running anonymous access - the
 * warm-cluster guard. `helmInstalled` alone is why a values change never
 * reaches a running cluster, so the flag has to be part of what "already
 * configured" means or flipping it would be a silent no-op. */
export function grafanaAnonConfigured(): boolean {
  const out = kubectl(
    ["-n", "hermes-monitoring", "get", "secret", "monitoring-grafana",
      "-o", "jsonpath={.data.grafana\\.ini}"],
    { allowFail: true, quiet: true },
  ).trim();
  if (!out) return false;
  const ini = Buffer.from(out, "base64").toString("utf8");
  const section = ini.split("[auth.anonymous]")[1] ?? "";
  return /^\s*enabled\s*=\s*true/m.test(section.split("[")[0] ?? "");
}

export function grafanaOidcConfigured(): boolean {
  const out = kubectl(
    ["-n", "hermes-monitoring", "get", "secret", "monitoring-grafana",
      "-o", "jsonpath={.data.grafana\\.ini}"],
    { allowFail: true, quiet: true },
  ).trim();
  if (!out) return false;
  return Buffer.from(out, "base64").toString("utf8").includes("[auth.generic_oauth]");
}

export function ensureArgoCd(state?: HgState): void {
  // `helmInstalled` alone is why a values change never reaches a warm
  // cluster - documented as a trap, and it would have silently swallowed
  // this entire milestone's RBAC. So the guard now asks whether the
  // DESIRED configuration is actually present, not merely whether
  // something is installed.
  if (helmInstalled("argocd", "argocd") && argocdOidcConfigured() === Boolean(state?.ports?.identity)) {
    ok("argocd installed");
    return;
  }
  log("installing Argo CD...");
  // Same resource customization the bootstrap's argocd component applies
  // (infra/src/components/argocd): the API server injects
  // apiVersion/kind/status into spec.volumeClaimTemplates entries, so
  // every hermes-profile StatefulSet is otherwise stuck OutOfSync
  // forever - selfHeal can't fix what the server keeps re-adding.
  const values: Record<string, any> = {
    configs: {
      // LOCAL ONLY, and not in the bootstrap's argocd component: serve
      // plain HTTP. argocd-server otherwise 307s every request to
      // https://<same host:port>, and both Service ports land on the same
      // container port - so a port-forward gives you a URL that redirects
      // to a scheme nothing is listening on. `hg open` would print an
      // Argo CD address no browser can open. In production TLS is
      // terminated at the tunnel, which is why this is a local concern.
      params: { "server.insecure": "true" },
      // RBAC (#284). This replaces Argo CD's default, which is
      // `role:readonly` for every authenticated user and was recorded as
      // a standing Security defect in gaps.md.
      //
      // `policy.default: ""` is DENY. Not role:readonly - a default that
      // grants anything means an identity nobody has placed in a role
      // still sees the whole fleet, and "unbound is denied" is then
      // false everywhere it is claimed.
      rbac: {
        "policy.default": "",
        // Every write grant is NAMED. An operator may sync and refresh -
        // the normal operational actions - and may not delete, alter
        // repositories/clusters/accounts, or change RBAC itself. Owner
        // gets the whole surface. Viewer reads.
        "policy.csv": [
          "p, role:hg-viewer, applications, get, */*, allow",
          "p, role:hg-viewer, projects, get, *, allow",
          "p, role:hg-viewer, repositories, get, *, allow",
          "p, role:hg-viewer, logs, get, */*, allow",
          "",
          "p, role:hg-operator, applications, get, */*, allow",
          "p, role:hg-operator, applications, sync, */*, allow",
          "p, role:hg-operator, applications, action/*, */*, allow",
          "p, role:hg-operator, projects, get, *, allow",
          "p, role:hg-operator, repositories, get, *, allow",
          "p, role:hg-operator, logs, get, */*, allow",
          "p, role:hg-operator, exec, create, */*, deny",
          "",
          "p, role:hg-owner, *, *, */*, allow",
          "",
          `g, ${OIDC_USERS.owner}, role:hg-owner`,
          `g, ${OIDC_USERS.operator}, role:hg-operator`,
          `g, ${OIDC_USERS.viewer}, role:hg-viewer`,
          "# unbound@hermes.local is mapped to NOTHING, deliberately: it",
          "# authenticates and every surface refuses it, which is the only",
          "# way that denial is provable rather than assumed.",
        ].join("\n"),
        scopes: "[email,groups]",
      },
      cm: {
        "resource.customizations.ignoreDifferences.apps_StatefulSet": [
          "jqPathExpressions:",
          "- .spec.volumeClaimTemplates[].apiVersion",
          "- .spec.volumeClaimTemplates[].kind",
          "- .spec.volumeClaimTemplates[].status",
          '- .spec.template.metadata.annotations."kubectl.kubernetes.io/restartedAt"',
        ].join("\n"),
      },
    },
  };
  if (state?.ports?.identity) {
    const secrets = identitySecrets();
    values["configs"]["cm"]["oidc.config"] = stringifyYaml({
      name: "Harness Hg",
      issuer: issuerUrl(state),
      clientID: "argocd",
      clientSecret: "$argocd-oidc:clientSecret",
      requestedScopes: ["openid", "profile", "email", "groups"],
    });
    // Local admin OFF once a real issuer exists. Break-glass is the
    // Kubernetes API, which survives an IdP outage - leaving a shared
    // password enabled beside SSO means the RBAC matrix proves nothing.
    values["configs"]["cm"]["admin.enabled"] = "false";
    kubectl(["create", "namespace", "argocd"], { allowFail: true, quiet: true });
    sh(["kubectl", "--context", KCTX, "apply", "-f", "-"], {
      input: JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: "argocd-oidc",
          namespace: "argocd",
          labels: { "app.kubernetes.io/part-of": "argocd" },
        },
        type: "Opaque",
        stringData: { clientSecret: secrets.clients.argocd! },
      }),
      quiet: true,
    });
  }
  const valuesFile = path.join(HG_HOME, "argocd-values.yaml");
  fs.writeFileSync(valuesFile, stringifyYaml(values));
  sh(["helm", "repo", "add", "argo", "https://argoproj.github.io/argo-helm", "--force-update"], { quiet: true });
  sh(["helm", "repo", "update", "argo"], { quiet: true });
  sh([
    "helm", "upgrade", "--install", "argocd", "argo/argo-cd",
    "--version", ARGOCD_CHART_VERSION,
    "-n", "argocd", "--create-namespace",
    "-f", valuesFile,
    "--kube-context", KCTX,
    "--wait", "--timeout", "5m",
  ]);
  ok("argocd installed");
}

/** External Secrets Operator - the hermes-profile chart renders an
 * ExternalSecret + Password generator for the agent API key (the same
 * dependency the bootstrap's stage 3 always installs), so the lite
 * platform needs the ESO controller + CRDs too. Same pinned chart as
 * the bootstrap (config.ts DEFAULT_ESO_CHART_VERSION). */
export function ensureEso(): void {
  if (helmInstalled("external-secrets", "external-secrets")) {
    ok("external-secrets installed");
    return;
  }
  log("installing External Secrets Operator...");
  sh(["helm", "repo", "add", "external-secrets", "https://charts.external-secrets.io", "--force-update"], { quiet: true });
  sh(["helm", "repo", "update", "external-secrets"], { quiet: true });
  sh([
    "helm", "upgrade", "--install", "external-secrets", "external-secrets/external-secrets",
    "--version", VERSIONS.charts.eso,
    "-n", "external-secrets", "--create-namespace",
    "--set", "installCRDs=true",
    "--kube-context", KCTX,
    "--wait", "--timeout", "5m",
  ]);
  ok("external-secrets installed");
}

/** The ONE local divergence in the monitoring pair, deliberately not in
 * the bootstrap file: anonymous Viewer.
 *
 * `allow_embedding` is fleet-wide (bootstrap/monitoring-stack.yaml) -
 * it only drops a framing header. Anonymous read access is a different
 * thing entirely and would be a real regression in production, where the
 * framing page would carry its own Access-gated session (ADR-44). Locally
 * it earns its place: a cold cluster has nobody logged in, so without it
 * every embedded dashboard renders as a login page and the loop cannot
 * prove the embed at all. */
export const LOCAL_ONLY_VALUES: Record<string, Record<string, unknown>> = {
  // Anonymous Viewer USED to live here, applied unconditionally to every
  // local install. #422 made it an explicit opt-in
  // (devAnonymousGrafanaValues, HG_GRAFANA_ANON_VIEWER) because the
  // ticket requires an absent flag to fail closed to the secure
  // configuration - and an unconditional divergence is the opposite of
  // an opt-in.
  //
  // It was also incoherent with the warm-cluster guard the flag needs: a
  // local cluster with no identity had anonymous ON while the flag read
  // OFF, so `grafanaAnonConfigured() === grafanaAnonymousViewerRequested()`
  // could never hold and every `hg up` reinstalled the monitoring stack.
  //
  // The cost is real and is warned about at install time: without the
  // flag, a cold local cluster renders every Grafana embed as a login
  // page. One env var buys it back.
  "monitoring-stack": {},
};

/** The Secret Grafana's OIDC client secret rides in - referenced by
 * envValueFrom, never written into values. */
export function ensureGrafanaOidcSecret(): void {
  const secrets = identitySecrets();
  kubectl(["create", "namespace", "hermes-monitoring"], { allowFail: true, quiet: true });
  sh(["kubectl", "--context", KCTX, "apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "grafana-oidc", namespace: "hermes-monitoring" },
      type: "Opaque",
      stringData: { "client-secret": secrets.clients.grafana! },
    }),
    quiet: true,
  });
}

/** Grafana's half of the SSO matrix (#284).
 *
 * `role_attribute_path` is a JMESPath over the token's claims, evaluated
 * by Grafana itself - so the mapping lives in Grafana's own vocabulary
 * (Admin/Editor/Viewer) exactly as ADR-50 requires: SSO shares identity,
 * each service keeps its own authorization.
 *
 * The path ends without a fallback on purpose. Grafana's documented
 * escape hatch is a trailing literal - `|| 'Viewer'` - which would hand
 * every unmapped identity a working read-only login, and there goes
 * "unbound is denied". No match means no role, which Grafana treats as a
 * failed login when `role_attribute_strict` is on. */
export function grafanaOidcValues(state: HgState): Record<string, unknown> {
  if (!state.ports?.identity) return {};
  const u = OIDC_USERS;
  return {
    grafana: {
      // The client secret arrives as an ENV VAR from a Secret, never as
      // a values field. The Grafana subchart refuses a literal
      // `client_secret` outright (`assertNoLeakedSecrets`), which is a
      // better guard than the comment I first wrote apologising for the
      // plaintext - and it means nothing sensitive passes through a
      // values file on the operator host at all.
      envValueFrom: {
        GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET: {
          secretKeyRef: { name: "grafana-oidc", key: "client-secret" },
        },
      },
      "grafana.ini": {
        // Anonymous access OFF once a real issuer exists: design 14 is
        // explicit that the MVP does not run anonymous Grafana, and an
        // anonymous Viewer would make every "denied" assertion vacuous.
        "auth.anonymous": { enabled: false },
        auth: { disable_login_form: false, oauth_auto_login: false },
        "auth.generic_oauth": {
          enabled: true,
          name: "Harness Hg",
          client_id: "grafana",
          scopes: "openid email profile groups",
          auth_url: `${issuerUrl(state)}/auth`,
          token_url: `${issuerUrl(state)}/token`,
          api_url: `${issuerUrl(state)}/userinfo`,
          email_attribute_path: "email",
          role_attribute_path:
            `contains(['${u.owner}'], email) && 'Admin' ` +
            `|| contains(['${u.operator}'], email) && 'Editor' ` +
            `|| contains(['${u.viewer}'], email) && 'Viewer'`,
          // No fallback role, and strict: an identity the operator has
          // not mapped cannot sign in at all.
          role_attribute_strict: true,
          allow_assign_grafana_admin: false,
        },
      },
    },
  };
}

/** The chart's admin.existingSecret (ADR-45): generate once, persist the
 * password under HG_HOME so a warm re-`up` reuses it, apply the Secret
 * before the stack installs - Grafana's pod cannot start without it. */
export function ensureGrafanaAdminSecret(): void {
  const pwFile = path.join(HG_HOME, "grafana-admin-password");
  if (!fs.existsSync(pwFile)) {
    fs.writeFileSync(pwFile, crypto.randomBytes(18).toString("base64url"), { mode: 0o600 });
  }
  const password = fs.readFileSync(pwFile, "utf8").trim();
  kubectl(["create", "namespace", "hermes-monitoring"], { allowFail: true, quiet: true });
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "monitoring-grafana-admin", namespace: "hermes-monitoring" },
    type: "Opaque",
    stringData: { "admin-user": "admin", "admin-password": password },
  };
  sh(["kubectl", "--context", KCTX, "apply", "-f", "-"], {
    input: JSON.stringify(secret),
    quiet: true,
  });
}


// ---------------------------------------------------------------------------
// identity (ADR-50, #284): the one OIDC issuer, on the local loop.
//
// The whole difficulty is ONE string. `issuer` lands in every token's
// `iss` claim and is the base every client fetches discovery and JWKS
// from, so it has to resolve to the same Dex from a browser on this host
// AND from inside a pod. An in-cluster Service URL fails the first; a
// 127.0.0.1 port-forward fails the second.
//
// The host gateway address satisfies both: pods already reach this host
// there (the agent boot clones `http://<gatewayIp>:<httpPort>` today), and
// a browser on this machine can too. So the loop's issuer is
// `http://<gatewayIp>:<port>/dex` and the forward BINDS TO THAT INTERFACE
// ONLY - not 0.0.0.0, which would publish a dev issuer with static
// passwords to the whole LAN.

export const IDENTITY_NS = "hermes-identity";

/** The loop's four accounts, named ONCE. Every service's role mapping
 * reads them from here - four copies of a literal email is how a matrix
 * silently disagrees with itself. */
export const OIDC_USERS = {
  owner: "owner@hermes.local",
  operator: "operator@hermes.local",
  viewer: "viewer@hermes.local",
  unbound: "unbound@hermes.local",
} as const;
export const IDENTITY_USERS = ["owner", "operator", "viewer", "unbound"] as const;
export type IdentityUser = (typeof IDENTITY_USERS)[number];

/** Where the loop's issuer lives. One function, because a mismatch
 * between what Dex is told and what a client is configured with fails as
 * an opaque `oidc: issuer did not match` deep inside a redirect. */
export function issuerUrl(state: HgState): string {
  return `http://${state.gatewayIp}:${state.ports!.identity}/dex`;
}

interface IdentitySecrets {
  clients: Record<string, string>;
  passwords: Record<IdentityUser, string>;
}

/** Generate once, persist under HG_HOME at 0600, reuse on a warm re-up -
 * the same discipline ensureGrafanaAdminSecret follows. Regenerating
 * would invalidate every service's configured client secret on every
 * `hg up`, which presents as "SSO broke by itself". */
export function identitySecrets(): IdentitySecrets {
  const file = path.join(HG_HOME, "identity-secrets.json");
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as IdentitySecrets;
  }
  const rand = () => crypto.randomBytes(24).toString("base64url");
  const doc: IdentitySecrets = {
    clients: { nexus: rand(), argocd: rand(), grafana: rand(), hermes: rand(), proof: rand() },
    passwords: Object.fromEntries(IDENTITY_USERS.map((u) => [u, rand()])) as Record<IdentityUser, string>,
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
  return doc;
}

/** The Secret Dex reads its client secrets and password hashes from.
 * Bcrypt because that is what Dex's password DB verifies; cost 10 is
 * Dex's own documented example and this is a loop credential. */
export function ensureIdentitySecret(secrets: IdentitySecrets): void {
  kubectl(["create", "namespace", IDENTITY_NS], { allowFail: true, quiet: true });
  const stringData: Record<string, string> = {
    DEX_NEXUS_SECRET: secrets.clients.nexus!,
    DEX_ARGOCD_SECRET: secrets.clients.argocd!,
    DEX_GRAFANA_SECRET: secrets.clients.grafana!,
    DEX_HERMES_SECRET: secrets.clients.hermes!,
    DEX_PROOF_SECRET: secrets.clients.proof!,
  };
  for (const user of IDENTITY_USERS) {
    stringData[`DEX_${user.toUpperCase()}_HASH`] = Bun.password.hashSync(secrets.passwords[user], {
      algorithm: "bcrypt",
      cost: 10,
    });
  }
  sh(["kubectl", "--context", KCTX, "apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "identity-clients", namespace: IDENTITY_NS },
      type: "Opaque",
      stringData,
    }),
    quiet: true,
  });
}

/** Install Dex from the SAME pinned chart and values the scaffolded
 * bootstrap uses (parsed from bootstrap/identity.yaml - one source of
 * truth), with the loop's issuer layered on top, then hold a forward
 * bound to the host gateway so that issuer resolves from both sides. */
export function ensureIdentity(state: HgState): void {
  const secrets = identitySecrets();
  ensureIdentitySecret(secrets);
  state.ports!.identity ??= freePort();
  const manifest = parseYaml(
    fs.readFileSync(
      path.join(PLATFORM_ROOT, "infra", "gitops-template", "bootstrap", "identity.yaml"),
      "utf8",
    ),
  ) as { spec: { source: { chart: string; targetRevision: string; helm: { valuesObject: Record<string, unknown> } } } };
  const src = manifest.spec.source;
  const values = deepMerge(src.helm.valuesObject, {
    config: {
      issuer: issuerUrl(state),
      // The loop's redirect URIs, replacing the committed placeholders.
      // Each service is reached through its own host forward, so these
      // are the only URLs a browser here can actually come back to.
      staticClients: (src.helm.valuesObject["config"] as Record<string, unknown>)["staticClients"],
    },
  });
  const cfg = values["config"] as Record<string, unknown>;
  cfg["staticClients"] = (cfg["staticClients"] as Record<string, unknown>[]).map((c) => ({
    ...c,
    redirectURIs: localRedirectUris(state, String(c["id"])),
  }));
  const valuesFile = path.join(HG_HOME, "identity-values.yaml");
  fs.writeFileSync(valuesFile, stringifyYaml(values));
  log(`installing identity (${src.chart} ${src.targetRevision}) issuer=${issuerUrl(state)}...`);
  sh(["helm", "repo", "add", "dex", "https://charts.dexidp.io", "--force-update"], { quiet: true });
  sh(["helm", "repo", "update", "dex"], { quiet: true });
  sh([
    "helm", "upgrade", "--install", "identity", "dex/dex",
    "--version", src.targetRevision,
    "-n", IDENTITY_NS, "--create-namespace",
    "--kube-context", KCTX,
    "-f", valuesFile,
  ]);
  // force: the upgrade just rolled the pod, so any existing forward is
  // pointed at a corpse by definition. A port-forward outlives its pod
  // and keeps accepting connections, so "still healthy" is not a signal
  // here - the same failure the router forward documents.
  ensureIdentityForward(state, { force: true });
}

/** The redirect URIs a browser on THIS host can return to. Empty for the
 * proof client, which has no browser leg at all. */
export function localRedirectUris(state: HgState, clientId: string): string[] {
  const nexus = state.expose?.["nexus"]?.localPort;
  switch (clientId) {
    case "nexus":
      return nexus ? [`http://127.0.0.1:${nexus}/api/plugins/hermes-gitops/nexus/auth/callback`] : [];
    case "argocd":
      return [`http://127.0.0.1:${state.ports!.http}/auth/callback`];
    case "grafana":
      return [`http://127.0.0.1:${state.ports!.http}/login/generic_oauth`];
    case "hermes":
      // EVERY agent dashboard, not one URL. Each profile runs its own
      // Hermes instance behind its own forward, and they all share this
      // client - so the client has to accept every one of them or the
      // sign-in fails at the callback for all but the first.
      //
      // ponytail: the loop's forwards get fresh ports on each `up`, so
      // this list is rebuilt every time. A published fleet has stable
      // hostnames and this becomes static.
      return Object.entries(state.expose ?? {})
        .filter(([key]) => key.endsWith(":dashboard"))
        .map(([, v]) => `http://127.0.0.1:${v.localPort}/auth/callback`);
    default:
      return [];
  }
}

/** A forward bound to the host-gateway interface ONLY.
 *
 * `--address` is the load-bearing flag: without it kubectl binds
 * 127.0.0.1, which pods cannot reach, and the issuer would only work from
 * a browser. With 0.0.0.0 it would work everywhere including the LAN,
 * which is not a thing to do to an issuer holding static passwords. */
export function ensureIdentityForward(state: HgState, opts: { force?: boolean } = {}): void {
  const port = state.ports!.identity!;
  const healthy = (): boolean =>
    Bun.spawnSync([
      "curl", "-sf", "-m", "2", "-o", "/dev/null",
      `${issuerUrl(state)}/.well-known/openid-configuration`,
    ]).exitCode === 0;
  const pf = state.pids?.identityPf;
  if (!opts.force && pf && pidAlive(pf) && healthy()) return;
  if (pf && pidAlive(pf)) {
    try {
      process.kill(pf, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Wait for a Ready pod BEFORE forwarding. kubectl port-forward against
  // a Pending pod exits immediately ("unable to forward port because pod
  // is not running"), and a detached process that died on spawn presents
  // later as a silent unreachable issuer.
  sh(["kubectl", "--context", KCTX, "-n", IDENTITY_NS, "rollout", "status",
      "deploy/identity-dex", "--timeout=180s"], { allowFail: true, quiet: true });
  state.pids ??= {};
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (!(state.pids.identityPf && pidAlive(state.pids.identityPf) && state.pids.identityPf !== pf)) {
      state.pids.identityPf = spawnDetached(
        ["kubectl", "--context", KCTX, "-n", IDENTITY_NS, "port-forward",
          "--address", state.gatewayIp!, "svc/identity-dex", `${port}:5556`],
        path.join(HG_HOME, "identity-pf.log"),
      );
      saveState(state);
    }
    if (healthy()) {
      ok(`identity up: ${issuerUrl(state)}`);
      return;
    }
    Bun.sleepSync(1000);
  }
  throw new CliError(
    `identity issuer never answered discovery at ${issuerUrl(state)} ` +
      `(see ${path.join(HG_HOME, "identity-pf.log")})`,
  );
}

/** kube-prometheus-stack from the SAME pinned chart and values the
 * scaffolded bootstrap uses (parsed from the canonical Application
 * manifest - one source of truth, no drift), plus LOCAL_ONLY_VALUES
 * layered on top (ADR-45: one stack, Alertmanager on, operator CRDs). */
export function ensureMonitoringPair(state?: HgState): void {
  ensureGrafanaAdminSecret();
  if (state?.ports?.identity) ensureGrafanaOidcSecret();
  const name = "monitoring-stack";
  // Record what THIS environment decided about anonymous Viewer, so the
  // proof side (AUTH008) can distinguish "this loop installed it" from
  // "some cluster happens to have it on" (#447 - the default must never
  // bless a foreign cluster's drift).
  if (state) {
    state.grafanaAnonViewer = grafanaAnonymousViewerRequested();
    saveState(state);
  }
  // Same reasoning as ensureArgoCd: installed is not configured.
  if (
    helmInstalled(name, "hermes-monitoring") &&
    grafanaOidcConfigured() === Boolean(state?.ports?.identity) &&
    // Installed is not configured, and the anonymous flag is part of the
    // configuration: without this, flipping it on a warm cluster is a
    // silent no-op and the operator concludes the flag does not work.
    grafanaAnonConfigured() === grafanaAnonymousViewerRequested()
  ) {
    ok(`${name} installed`);
    return;
  }
  const manifest = parseYaml(
    fs.readFileSync(
      path.join(PLATFORM_ROOT, "infra", "gitops-template", "bootstrap", `${name}.yaml`),
      "utf8",
    ),
  ) as { spec: { source: { chart: string; targetRevision: string; helm: { valuesObject: unknown } } } };
  const src = manifest.spec.source;
  const valuesFile = path.join(HG_HOME, `${name}-values.yaml`);
  const values = deepMerge(
    deepMerge(
      deepMerge(src.helm.valuesObject as Record<string, unknown>, LOCAL_ONLY_VALUES[name] ?? {}),
      state ? grafanaOidcValues(state) : {},
    ),
    // LAST on purpose (#422): grafanaOidcValues turns anonymous OFF, and
    // the whole point of the development flag is to keep it on WITH an
    // issuer configured. Empty unless the flag is set, so the production
    // posture is what you get by doing nothing.
    devAnonymousGrafanaValues(),
  );
  if (grafanaAnonymousViewerRequested()) {
    warn(
      "grafana: anonymous Viewer access is ENABLED (the local loop's default, #447) - " +
        "development only, never a deployed environment. HG_GRAFANA_ANON_VIEWER=0 opts out.",
    );
  } else {
    // The ergonomics this costs, said out loud rather than discovered as
    // a login page in an iframe (#422).
    log(
      "grafana: anonymous access is off (HG_GRAFANA_ANON_VIEWER=0) - embedded " +
        "dashboards will ask for a login. Unset it to restore the loop's default.",
    );
  }
  fs.writeFileSync(valuesFile, stringifyYaml(values));
  log(`installing ${name} (${src.chart} ${src.targetRevision})...`);
  sh(["helm", "repo", "add", "prometheus-community", "https://prometheus-community.github.io/helm-charts", "--force-update"], { quiet: true });
  sh(["helm", "repo", "update", "prometheus-community"], { quiet: true });
  sh([
    "helm", "upgrade", "--install", name, "prometheus-community/kube-prometheus-stack",
    "--version", src.targetRevision,
    "-n", "hermes-monitoring", "--create-namespace",
    "-f", valuesFile,
    "--kube-context", KCTX,
    "--wait", "--timeout", "10m",
  ]);
  ok(`${name} installed`);
}

/** Fleet budget/TCO dashboard from the LOCAL chart, with the same
 * valuesObject the scaffolded bootstrap ships (parsed from the
 * canonical Application manifest - one source of truth, no drift).
 * Unlike the grafana/prometheus pair this is a repo-local chart, so
 * there is no `helm repo add` - install straight from the working
 * tree. Also unlike the pair it is NOT guarded by helmInstalled():
 * upgrade of a pure-ConfigMap chart is cheap, and re-applying on every
 * `up` is how budget edits to the bootstrap file reach a warm cluster.
 * The manifest's __TOKENS__ live only under spec.source.repoURL /
 * targetRevision, which this function never reads. The monitoring
 * chart's auto-default applies here too: the local alert sink becomes
 * the webhook receiver, so demo budgets added to the bootstrap file
 * don't trip the chart's receivers guard. */
/** The in-cluster Nexus service (ADR-48): the plugin router + standalone
 * shell from charts/nexus, its overlay state on a PVC with a labelled
 * backup routine. Re-applied on every up (pure-manifest chart, upgrades
 * are cheap) so plugin/dist changes reach a warm cluster. */
/** The browser-reachable base URL for a control-plane UI, or "" when its
 * forward is not up. IN-CLUSTER addresses are wrong here on purpose: this
 * value is handed to a BROWSER, which cannot resolve
 * monitoring-grafana.hermes-monitoring.svc. The only URL that works from
 * both sides of the local loop is the host port-forward. */
function browserBaseUrl(state: HgState, key: string): string {
  const entry = state.expose?.[key];
  return entry ? `http://127.0.0.1:${entry.localPort}` : "";
}

/** The owner stamped on the Nexus Deployment by whoever installed it
 * (charts/nexus values.owner). The Pulumi bootstrap sets "pulumi"; the CLI
 * sets nothing. ADR-53 splits the two: the bootstrap owns the release in a
 * real environment, the CLI owns it on a laptop, and neither may quietly
 * overwrite the other's configuration. */
export type NexusOwnership =
  | { state: "absent" }
  | { state: "owned"; owner: string }
  | { state: "unknown"; reason: string };

export function nexusOwner(): NexusOwnership {
  // Deliberately NOT sh({allowFail}): that returns "" for every failure, so
  // an expired credential, an RBAC denial or an API timeout would be
  // indistinguishable from "no Deployment" - and the caller would then
  // reinstall over a Pulumi-owned release, replacing published URLs with
  // port-forwards. Exactly the drift ADR-53 exists to prevent, caused by
  // the check meant to prevent it.
  const proc = Bun.spawnSync([
    "kubectl", "--context", KCTX, "-n", "hermes-nexus",
    "get", "deploy/nexus", "-o", "jsonpath={.metadata.labels.hermes\\.dev/owner}",
  ]);
  if (proc.exitCode === 0) {
    return { state: "owned", owner: proc.stdout.toString().trim() };
  }
  const stderr = proc.stderr.toString();
  // The one failure that genuinely means "nothing is installed".
  if (/\bnot ?found\b/i.test(stderr)) return { state: "absent" };
  return { state: "unknown", reason: stderr.trim() || `kubectl exited ${proc.exitCode}` };
}

/** `hg nexus set` overrides as a nested values document (ADR-53).
 *
 * Dotted keys expand into objects, and the three literals helm's --set
 * would have inferred are preserved. Written as JSON - valid YAML - and
 * passed with `-f` rather than `--set`, because --set splits on commas
 * and coerces types: a webhook URL containing a comma, or a chart version
 * like "1.0", could not otherwise be expressed. Exported so the
 * expansion is testable without a cluster. */
export function nexusValuesDoc(overrides: Record<string, string>): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const [dotted, raw] of Object.entries(overrides)) {
    const parts = dotted.split(".");
    let node = doc;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    const key = parts[parts.length - 1]!;
    // INTEGERS only. A decimal is a chart or image version ("1.0") far
    // more often than a number here, and coercing it would render
    // `tag: 1` - a wrong image reference that looks like a typo in the
    // manifest rather than a CLI bug.
    node[key] = raw === "true" ? true
      : raw === "false" ? false
      : /^-?\d+$/.test(raw) ? Number(raw)
      : raw;
  }
  return doc;
}

/**
 * The Nexus helm argv, split out so the value-precedence rule is testable
 * rather than merely believed.
 *
 * The rule: NOTHING here may use `--set`. helm ranks `--set` above every
 * `-f` regardless of argument order, so a single `--set` for a key the
 * operator can also set would make `hg nexus set <that key>` silently do
 * nothing - which is precisely the parity ADR-53 exists to guarantee.
 * Between `-f` files the later wins, so `valueFiles` must arrive
 * derived-first, operator-last.
 */
export function nexusHelmArgs(valueFiles: string[]): string[] {
  return [
    "helm", "upgrade", "--install", "nexus",
    path.join(PLATFORM_ROOT, "control-plane", "nexus", "chart"),
    "-n", "hermes-nexus", "--create-namespace",
    ...valueFiles,
    "--kube-context", KCTX,
  ];
}


const NEXUS_DIST_FILES = ["index.js", "standalone.js", "style.css"];
const NEXUS_CODE_FILES = ["plugin_api.py", "standalone.py", "features.json", "inventory.json", "panels.json"];

function nexusDistData(): Record<string, string> {
  const distDir = path.join(PLATFORM_ROOT, "control-plane", "nexus", "dist");
  const data: Record<string, string> = {};
  for (const name of NEXUS_DIST_FILES) {
    const file = path.join(distDir, name);
    if (!fs.existsSync(file)) {
      throw new CliError(`control-plane/nexus/dist/${name} is missing - rebuild nexus-ui (bun run build && bun run build:standalone)`);
    }
    data[name] = fs.readFileSync(file, "utf8");
  }
  return data;
}

/** What rolls the Nexus pod in the local loop: the chart's projected code
 * files AND the bundles, which are no longer chart files (so the chart's
 * own render-time fallback cannot see them). Same inputs as the bootstrap's
 * projectedCodeChecksum, minus the templates helm already diffs. */
export function nexusCodeChecksum(): string {
  const h = crypto.createHash("sha256");
  for (const name of NEXUS_CODE_FILES) {
    const file = path.join(PLATFORM_ROOT, "control-plane", "nexus", "chart", "files", name);
    h.update(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0));
  }
  for (const text of Object.values(nexusDistData())) h.update(text);
  return h.digest("hex");
}

/** The UI bundles as the `nexus-ui-dist` ConfigMap the chart mounts by
 * name. Provisioned here, never as chart files: embedding them put the
 * Helm release Secret over its 1MiB cap (#804), and the bundle set is what
 * the Pulumi bootstrap provisions on a real cluster (NEXUS_DIST_FILES).
 * Server-side apply on purpose: a client-side apply copies the ~800KB
 * object into the last-applied annotation, past the 256KiB annotation
 * limit. */
export function ensureNexusDistConfigMap(): void {
  kubectl(["create", "namespace", "hermes-nexus"], { allowFail: true, quiet: true });
  sh(["kubectl", "--context", KCTX, "apply", "--server-side", "--force-conflicts", "--field-manager=hg", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "nexus-ui-dist",
        namespace: "hermes-nexus",
        labels: { "app.kubernetes.io/name": "nexus", "hermes-gitops.factorylevel.dev/component": "nexus" },
      },
      data: nexusDistData(),
    }),
    quiet: true,
  });
}

/** The Secret the chart's clientSecretRef names. Separate from the
 * values above so the values stay PURE - a config builder that has to
 * reach a cluster cannot be unit-tested, and this one carries the role
 * map that decides who may write. */
export function ensureNexusOidcSecret(): void {
  const secrets = identitySecrets();
  kubectl(["create", "namespace", "hermes-nexus"], { allowFail: true, quiet: true });
  sh(["kubectl", "--context", KCTX, "apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "nexus-oidc", namespace: "hermes-nexus" },
      type: "Opaque",
      stringData: { "client-secret": secrets.clients.nexus! },
    }),
    quiet: true,
  });
}

/** The OIDC half of the nexus values (ADR-50, #284). Pure.
 *
 * The role map is the loop's four users. It lives HERE rather than in the
 * chart's defaults because it is environment data: a real fleet maps
 * groups from its own IdP, and shipping `owner@hermes.local` as a chart
 * default would put a fake account in every installation's values. */
export function nexusOidcValues(state: HgState): Record<string, unknown> {
  if (!state.ports?.identity) return {};
  return {
    oidc: {
      issuer: issuerUrl(state),
      clientId: "nexus",
      // `email`, not `groups`: Dex's password DB has no group support
      // (ADR-50 Cost), so the loop's users carry their role in the
      // account. A real connector flips this to `groups` and nothing
      // else about the mapping changes.
      roleClaim: "email",
      roles: {
        owner: [OIDC_USERS.owner],
        operator: [OIDC_USERS.operator],
        viewer: [OIDC_USERS.viewer],
        // unbound@hermes.local is deliberately in NO list. It signs in
        // successfully and every surface refuses it, which is the only
        // way "unbound is denied" is provable at all.
      },
    },
  };
}

export function ensureNexus(state: HgState): void {
  // Pulumi-owned release: re-running the CLI's install here would replace
  // the bootstrap's real published URLs with host port-forwards - exactly
  // the drift ADR-53 exists to stop. Leave it alone; the port-forwards
  // ensurePlatformExposures set up still work for local browsing.
  const ownership = nexusOwner();
  if (ownership.state === "owned" && ownership.owner !== "") {
    ok(`nexus is ${ownership.owner}-owned - skipping CLI install (ADR-53), port-forward only`);
    return;
  }
  if (ownership.state === "unknown") {
    // Fail loudly rather than guess: installing on an unreadable cluster is
    // how the CLI would silently clobber a bootstrap-owned release.
    throw new CliError(
      "cannot determine who owns the nexus release - refusing to install over a possibly " +
        `bootstrap-owned deployment (ADR-53).\n${ownership.reason}\n` +
        "Fix cluster access and re-run, or `helm uninstall nexus -n hermes-nexus` if you " +
        "intend the CLI to own it.",
    );
  }
  ensureNexusImage();
  const gitopsUrl = `git://${state.gatewayIp}:${state.ports!.git}/gitops.git`;
  // Must already be up - ensurePlatformExposures runs before this in `up`.
  const argocdBaseUrl = browserBaseUrl(state, "argocd");
  const grafanaBaseUrl = browserBaseUrl(state, "grafana");
  // No helm --wait: the backups PVC is WaitForFirstConsumer and stays
  // Pending until the first backup job mounts it - helm would wait on it
  // forever. The deployment rollout is the readiness that matters.
  // Operator overrides last, so `hg nexus set` can reach any chart value
  // the bootstrap can set (ADR-53) - including the ones it derives above.
  //
  // Through a FILE, not --set: helm's --set splits on commas and coerces
  // types, so a webhook URL with a comma or a value that merely looks
  // numeric could not be expressed. JSON is valid YAML, so writing the
  // nested object as JSON needs no YAML writer and no quoting rules.
  // BOTH layers go through files, and the order is load-bearing.
  //
  // helm gives `--set` higher precedence than ANY `-f`, regardless of
  // argument order - so the derived values below cannot be expressed with
  // `--set` without making `hg nexus set` silently ineffective for exactly
  // the four keys it most needs to reach. Between two `-f` files the LATER
  // one wins, which is the precedence this needs: derived first, operator
  // second.
  //
  // Files rather than `--set` for a second reason: `--set` splits on commas
  // and coerces types, so a webhook URL containing a comma or a value that
  // merely looks numeric could not be expressed at all. JSON is valid YAML,
  // so writing these as JSON needs no YAML writer and no quoting rules.
  if (state.ports?.identity) ensureNexusOidcSecret();
  const derivedFile = path.join(HG_HOME, "nexus-derived.json");
  fs.writeFileSync(
    derivedFile,
    `${JSON.stringify(
      {
        gitopsUrl,
        gitopsBranch: "main",
        argocdBaseUrl,
        grafanaBaseUrl,
        // #618: the pod reads Grafana's ALERTING api now, and grafanaBaseUrl
        // is a 127.0.0.1 URL meant for the browser - unreachable from inside
        // the cluster. Give the probe the in-cluster Service, which is the
        // same value the deployed path already sets.
        grafanaProbeBaseUrl: "http://monitoring-grafana.hermes-monitoring.svc",
        // Bundle-only changes must roll the pod too (the bundles are a
        // separate ConfigMap now, invisible to the chart's fallback hash).
        codeChecksum: nexusCodeChecksum(),
        ...nexusOidcValues(state),
      },
      null,
      2,
    )}\n`,
  );
  const valueFiles: string[] = ["-f", derivedFile];
  const nexusValues = state.nexusValues ?? {};
  if (Object.keys(nexusValues).length > 0) {
    const valuesFile = path.join(HG_HOME, "nexus-values.json");
    fs.writeFileSync(valuesFile, `${JSON.stringify(nexusValuesDoc(nexusValues), null, 2)}\n`);
    valueFiles.push("-f", valuesFile);
  }
  ensureNexusDistConfigMap();
  sh(nexusHelmArgs(valueFiles));
  sh([
    "kubectl", "--context", KCTX, "-n", "hermes-nexus",
    "rollout", "status", "deploy/nexus", "--timeout=180s",
  ], { quiet: true });
  ok(
    `nexus installed (in-cluster, state on PVC)` +
      (grafanaBaseUrl ? "" : " - WITHOUT integration URLs; Grafana/Argo links will be dead"),
  );
}

/** Loki + promtail (#661, ADR 0165) - the same local-chart path as the
 * other control-plane singletons. Static chart, no values to layer. */
export function ensureLoki(): void {
  log("installing loki (local chart)...");
  sh([
    "helm", "upgrade", "--install", "loki",
    path.join(PLATFORM_ROOT, "control-plane", "loki", "chart"),
    "-n", "hermes-monitoring", "--create-namespace",
    "--kube-context", KCTX,
  ]);
  ok("loki installed");
}

export function ensureFleetDashboard(state: HgState): void {
  const manifest = parseYaml(
    fs.readFileSync(
      path.join(PLATFORM_ROOT, "infra", "gitops-template", "bootstrap", "fleet-dashboard.yaml"),
      "utf8",
    ),
  ) as { spec: { source: { helm: { valuesObject: Record<string, unknown> } } } };
  const values = manifest.spec.source.helm.valuesObject ?? {};
  const alert = (values["alert"] ?? {}) as Record<string, unknown>;
  values["alert"] = alert;
  if (!alert["webhookUrl"] && !alert["discordUrl"]) {
    alert["webhookUrl"] = sinkUrl(state);
  }
  const valuesFile = path.join(HG_HOME, "fleet-dashboard-values.yaml");
  fs.writeFileSync(valuesFile, stringifyYaml(values));
  log("installing fleet-dashboard (local chart)...");
  sh([
    "helm", "upgrade", "--install", "fleet-dashboard",
    path.join(PLATFORM_ROOT, "control-plane", "fleet-dashboard", "chart"),
    "-n", "hermes-monitoring", "--create-namespace",
    "-f", valuesFile,
    "--kube-context", KCTX,
    // No --wait: the DLQ backup PVC is WaitForFirstConsumer and stays
    // Pending until the first backup pod mounts it, so helm would block
    // on a resource whose Pending IS its steady state. The same reason
    // ensureNexus omits it - and redundant here anyway, because the
    // /healthz probe below is the readiness that actually matters.
  ]);
  ok("fleet-dashboard installed");
  // The control plane's own dashboards (design 15, ADR-55) ride the same
  // local-chart path. No values to layer - the chart is static.
  log("installing control-plane-observability (local chart)...");
  sh([
    "helm", "upgrade", "--install", "control-plane-observability",
    path.join(PLATFORM_ROOT, "control-plane", "observability", "chart"),
    "-n", "hermes-monitoring", "--create-namespace",
    "--kube-context", KCTX,
    "--wait", "--timeout", "2m",
  ]);
  ok("control-plane-observability installed");
}

// ---------------------------------------------------------------------------
// The event router (ADR-39): the communication plane's one runtime
// component. Installed only when the onboarded repository compiles with a
// communication plan; the chart consumes the EMITTED
// deployments/communication/<id>/values.yaml record verbatim (rendered
// in memory here - the local loop's stand-in for the ApplicationSet
// path). The router delivers TO each profile's own agent gateway; it is
// not a replacement for the gateway.
// ---------------------------------------------------------------------------

export interface CompiledCommunication {
  contracts: Contract[];
  environment: Environment;
  plan: TopologyPlan;
}

/** Compile the onboarded repository's communication plane, or undefined
 * when it declares none (feature off - `up` proceeds untouched). */
export function compiledCommunication(state: HgState): CompiledCommunication | undefined {
  const loaded = loadContracts(state.profileDir);
  const env = loadEnvironment(state.profileDir);
  const plan = compile(loaded.contracts, env.environment, {
    priorFindings: [...loaded.findings, ...env.findings],
  });
  if (!plan.communication) return undefined;
  return { contracts: loaded.contracts, environment: env.environment, plan };
}

/** The producer-URL injections for ONE profile's record render: the
 * compiled ingest URL at each output's declared appValue path - the same
 * value `topology emit` writes into deployments/apps values. */
export function producerAppValues(
  compiled: CompiledCommunication | undefined,
  profile: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of compiled?.plan.communication?.producers ?? []) {
    if (p.profile !== profile || !p.inject) continue;
    const segs = p.inject.path.split(".");
    let cursor = ((out[p.inject.app] ??= {}) as Record<string, unknown>);
    for (const seg of segs.slice(0, -1)) {
      cursor = (cursor[seg] ??= {}) as Record<string, unknown>;
    }
    cursor[segs[segs.length - 1]!] = p.ingestUrl;
  }
  return out;
}


/** helm-install the router chart from a values file and keep a healthy
 * local port-forward to it (shared by the communication plane and the
 * connections-only router, ADR-152). */
function installEventRouterChart(state: HgState, namespace: string, valuesFile: string, service = "hermes-event-router"): void {
  log("installing hermes-event-router (local chart)...");
  sh([
    "helm", "upgrade", "--install", "hermes-event-router",
    path.join(PLATFORM_ROOT, "control-plane", "event-router", "chart"),
    "-n", namespace,
    "-f", valuesFile,
    "--set", `recordingBase=http://${state.gatewayIp}:${state.ports!.sink}`,
    "--set", "environment=local",
    "--kube-context", KCTX,
    // No --wait: the DLQ backup PVC is WaitForFirstConsumer and stays
    // Pending until the first backup pod mounts it, so helm would block
    // on a resource whose Pending IS its steady state (the same reason
    // ensureNexus omits it). Redundant here anyway - the /healthz probe
    // below is the readiness that actually matters, and it catches a
    // forward pointed at a corpse, which --wait never would.
  ]);

  // A stable local forward for hg event publish/status and hg chatops test.
  // The probe is a REAL /healthz round-trip, not a TCP accept: a kubectl
  // port-forward outlives its pod AND keeps accepting connections while
  // forwarding to a corpse, so portAccepts alone reports a dead forward
  // healthy (observed live in communication prove's restart stage).
  const routerHealthy = (p: number): boolean =>
    Bun.spawnSync(["curl", "-sf", "-m", "2", "-o", "/dev/null", `http://127.0.0.1:${p}/healthz`]).exitCode === 0;
  const pf = state.pids?.routerPf;
  const port = state.ports!.router;
  if (!(pf && pidAlive(pf) && port && routerHealthy(port))) {
    if (pf && pidAlive(pf)) {
      try {
        process.kill(pf, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    state.ports!.router = port ?? freePort();
    const until = (cond: () => boolean, ms: number): boolean => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (cond()) return true;
        Bun.sleepSync(250);
      }
      return cond();
    };
    until(() => !portAccepts(state.ports!.router!), 5_000); // old forward gone
    state.pids ??= {};
    state.pids.routerPf = spawnDetached(
      ["kubectl", "--context", KCTX, "-n", namespace, "port-forward",
        `svc/${service}`, `${state.ports!.router}:80`],
      path.join(HG_HOME, "event-router-pf.log"),
    );
    saveState(state);
    if (!until(() => routerHealthy(state.ports!.router!), 20_000)) {
      throw new CliError(
        `event-router port-forward never became healthy on 127.0.0.1:${state.ports!.router} ` +
          `(see ${path.join(HG_HOME, "event-router-pf.log")})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Connections (ADR-152): the local loop's half of the shared resource.
//
// The cluster-scoped `hermes-gitops` ClusterSecretStore is what the charts'
// ExternalSecrets read through; the bootstrap creates it (secret-store
// component) and the local loop mirrors it here - same name, same
// remoteNamespace, same ServiceAccount/Role shape - so a chart rendered
// locally and on the factory reads the same store by the same name.

export const CONNECTION_STORE = "hermes-gitops";
const CONNECTION_STORE_SA = "hermes-gitops-secretstore";

export function ensureSecretStore(): void {
  kubectl(["create", "namespace", CONNECTIONS_SECRET_NAMESPACE], { allowFail: true, quiet: true });
  const docs = [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: CONNECTION_STORE_SA, namespace: CONNECTIONS_SECRET_NAMESPACE } },
    {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role",
      metadata: { name: `${CONNECTION_STORE_SA}-reader`, namespace: CONNECTIONS_SECRET_NAMESPACE },
      rules: [
        { apiGroups: [""], resources: ["secrets"], verbs: ["get", "list", "watch"] },
        { apiGroups: ["authorization.k8s.io"], resources: ["selfsubjectrulesreviews"], verbs: ["create"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding",
      metadata: { name: `${CONNECTION_STORE_SA}-reader`, namespace: CONNECTIONS_SECRET_NAMESPACE },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: `${CONNECTION_STORE_SA}-reader` },
      subjects: [{ kind: "ServiceAccount", name: CONNECTION_STORE_SA, namespace: CONNECTIONS_SECRET_NAMESPACE }],
    },
    {
      apiVersion: "external-secrets.io/v1", kind: "ClusterSecretStore",
      metadata: { name: CONNECTION_STORE },
      spec: {
        provider: {
          kubernetes: {
            remoteNamespace: CONNECTIONS_SECRET_NAMESPACE,
            server: { caProvider: { type: "ConfigMap", name: "kube-root-ca.crt", key: "ca.crt", namespace: CONNECTIONS_SECRET_NAMESPACE } },
            auth: { serviceAccount: { name: CONNECTION_STORE_SA, namespace: CONNECTIONS_SECRET_NAMESPACE } },
          },
        },
      },
    },
  ];
  kubectl(["apply", "-f", "-"], { input: docs.map((d) => stringifyYaml(d)).join("---\n"), quiet: true });
  ok(`ClusterSecretStore ${CONNECTION_STORE} -> ${CONNECTIONS_SECRET_NAMESPACE}`);
}

/** Where the local loop keeps a connection's values: one 0600 JSON file
 * per connection under $HG_HOME/connections/, written by `hg connection
 * set`. JSON, not dotenv: a GitHub App private key is a multi-line PEM,
 * and a dotenv line would keep its first line and silently project an
 * unusable key. Never the repository, never the state file, never printed. */
export function connectionValuesFile(name: string): string {
  return path.join(HG_HOME, "connections", `${name}.json`);
}

export function loadConnectionValues(name: string): Record<string, string> {
  const file = connectionValuesFile(name);
  if (!fs.existsSync(file)) return {};
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

export function saveConnectionValues(name: string, values: Record<string, string>): void {
  const file = connectionValuesFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const sorted = Object.fromEntries(Object.keys(values).sort().map((k) => [k, values[k]!]));
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n", { mode: 0o600 });
}

/** The compiled connections for this onboarding, or an empty result when
 * nothing is declared. Bundle-aware like the up hook. */
export function compiledConnections(state: HgState): ReturnType<typeof compileConnections> {
  const file = connectionDeclarationFile(state);
  if (!file) return { bindings: [], findings: [] };
  const declarations = loadConnectionDeclarations(file);
  const bundledTargets = new Map<string, { namespace: string; service: string; port: number }>();
  const ctxs = profileCtxs(state);
  for (const [name, p] of Object.entries(loadEnvironment(state.profileDir).environment.bundledProfiles ?? {})) {
    const ctx = ctxs.find((c) => c.name === name);
    const coords = bundleCoordinatesFor(p, ctx?.runtime === "eve" ? "eve" : "hermes");
    bundledTargets.set(name, { ...coords, port: p.apiServerPort ?? (ctx?.runtime === "eve" ? 3000 + p.memberIndex : 8644) });
  }
  return compileConnections(declarations, connectionTargets(ctxs, bundledTargets));
}

/** Write every declared connection's platform Secret (hermes-secrets/
 * connection-<name>): the provider's FULL key set, unset keys as empty
 * strings, so a projection never blocks a pod on a key the operator has
 * not supplied. Names are logged; values never. */
/** The env overlay of every profile bound to a connection, merged.
 *
 * A connection is a shared resource, so seeding it from "the" overlay
 * needs a definition of which: the union over its bound profiles, later
 * binding wins. Two bound profiles that disagree about a key are reported
 * rather than silently resolved - a credential quietly taking one of two
 * values is the failure the connection existed to remove.
 *
 * Values are never printed; only key names appear in the conflict line. */
export function boundEnvOverlay(
  state: HgState,
  connection: string,
  bindings: NormalizedConnectionBinding[],
): { values: Record<string, string>; conflicts: string[] } {
  const byProfile = new Map<string, ProfileCtx>(profileCtxs(state).map((c) => [c.name, c]));
  const values: Record<string, string> = {};
  const from: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const b of bindings.filter((x) => x.connection === connection)) {
    const ctx = byProfile.get(b.profile);
    if (!ctx) continue;
    for (const [k, v] of Object.entries(loadEnvOverlay(state, ctx))) {
      if (v === "") continue;
      if (k in values && values[k] !== v) conflicts.push(`${k} (${from[k]} and ${b.profile} disagree)`);
      values[k] = v;
      from[k] = b.profile;
    }
  }
  return { values, conflicts };
}

export function ensureConnectionSecrets(state: HgState): void {
  const { bindings } = compiledConnections(state);
  const seen = new Set<string>();
  for (const b of bindings) {
    if (seen.has(b.connection)) continue;
    seen.add(b.connection);
    const stored = loadConnectionValues(b.connection);
    const keys = PROVIDER_KEYS[b.provider];
    // The env overlay SEEDS a key the connection store has not set. The
    // .env file stays the one place an operator edits, and the connection
    // still owns what deploys - the pod reads the projection, which
    // overrides the env Secret (envFrom order), so the two can never
    // disagree in the pod. `hg connection set` is the stronger statement
    // and is never overwritten by a file.
    const { values: overlay, conflicts } = boundEnvOverlay(state, b.connection, bindings);
    for (const c of conflicts) {
      warn(`connection ${b.connection}: ${c} - the connection takes the last binding's value`);
    }
    const values: Record<string, string> = {};
    const seeded: string[] = [];
    for (const k of keys) {
      if ((stored[k] ?? "") !== "") {
        values[k] = stored[k]!;
      } else if ((overlay[k] ?? "") !== "") {
        values[k] = overlay[k]!;
        seeded.push(k);
      } else {
        values[k] = "";
      }
    }
    // The manifest goes over stdin, never argv: a value on a command line
    // is visible to every process on the host and lands verbatim in the
    // failure message of a kubectl that errors.
    const manifest = stringifyYaml({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: platformSecretName(b.connection), namespace: CONNECTIONS_SECRET_NAMESPACE, labels: { "hermes-gitops.factorylevel.dev/connection": b.connection } },
      type: "Opaque",
      stringData: values,
    });
    kubectl(["apply", "-f", "-"], { input: manifest, quiet: true });
    const set = keys.filter((k) => values[k] !== "");
    ok(`connection ${b.connection} (${b.provider}): Secret ${platformSecretName(b.connection)} applied (${set.length}/${keys.length} key(s) set${set.length ? ": " + set.join(", ") : ""}${seeded.length ? `; ${seeded.join(", ")} seeded from the env overlay` : ""})`);
  }
}

/** The gateway spec the router chart consumes (spec.connections), parsed
 * back out of the compiler's own gateway record so the local loop and the
 * emitted tree can never disagree. */
export function gatewayConnections(state: HgState): unknown[] {
  const { bindings } = compiledConnections(state);
  if (bindings.length === 0) return [];
  const bundled = new Set(Object.keys(loadEnvironment(state.profileDir).environment.bundledProfiles ?? {}));
  const gateway = connectionFiles(bindings, bundled).get("deployments/connections/gateway.yaml");
  const doc = gateway ? (parseYaml(gateway) as { spec?: { connections?: unknown[] } }) : null;
  return doc?.spec?.connections ?? [];
}

export function ensureEventRouter(state: HgState, compiled = compiledCommunication(state)): void {
  const connections = gatewayConnections(state);
  if (!compiled && connections.length === 0) return; // no communication plane, no connections - nothing to run
  if (!compiled) {
    // Connections alone bring the router up (ADR-152): the gateway IS the
    // router. A minimal values document - one router, no producers, no
    // edges - plus the gateway spec.
    ensureSecretStore();
    ensureConnectionSecrets(state);
    const valuesFile = path.join(HG_HOME, "event-router-values.yaml");
    fs.writeFileSync(valuesFile, stringifyYaml({
      spec: {
        router: { id: "router", scope: "global", namespace: "hermes-system", service: "hermes-event-router" },
        chatopsConnections: {},
        producers: [],
        externalInputs: [],
        edges: [],
        connections,
      },
    }));
    kubectl(["create", "namespace", "hermes-system"], { allowFail: true, quiet: true });
    installEventRouterChart(state, "hermes-system", valuesFile);
    return;
  }
  const { plan, contracts, environment } = compiled;
  if (!plan.ok) {
    const n = plan.findings.filter((f) => f.severity === "error").length;
    throw new CliError(
      `the communication plane has ${n} compile error(s) - fix them before up (hg topology plan --dir ${state.profileDir})`,
    );
  }
  const comm = plan.communication!;
  const router = comm.routers[0];
  if (!router) return; // outputs declared but nothing placed - EVENT001 already warned
  const tree = renderTree(state.profileDir, contracts, plan, environment, {
    sourceSha: state.platformSha ?? "0".repeat(40),
  });
  const valuesRel = `deployments/communication/${router.id.replace(/[@/]/g, "-")}/values.yaml`;
  const valuesContent = tree.get(valuesRel);
  if (!valuesContent) throw new CliError(`internal: emitted tree lacks ${valuesRel}`);
  const valuesFile = path.join(HG_HOME, "event-router-values.yaml");
  // The gateway spec rides in the same values document (ADR-152).
  const valuesDoc = parseYaml(valuesContent) as { spec: Record<string, unknown> };
  if (connections.length > 0) {
    valuesDoc.spec["connections"] = connections;
    ensureSecretStore();
    ensureConnectionSecrets(state);
  }
  fs.writeFileSync(valuesFile, stringifyYaml(valuesDoc));

  kubectl(["create", "namespace", router.namespace], { allowFail: true, quiet: true });

  // Per-target signing secrets: one key per agent-edge secretName, valued
  // from the same test-config + env-overlay layering the profile's own
  // env Secret uses. The router only ever holds secrets for profiles that
  // DECLARED themselves delivery targets.
  const secretEntries = new Map<string, string>();
  for (const edge of comm.edges) {
    if (!edge.agent || secretEntries.has(edge.agent.secretName)) continue;
    const ctx = profileCtxs(state).find((c) => c.name === edge.agent!.profile);
    if (!ctx) continue;
    const secrets = { ...loadTestConfig(ctx.dir).secrets, ...loadEnvOverlay(state, ctx) };
    const secret = secrets["WEBHOOK_SECRET"];
    if (secret) secretEntries.set(edge.agent.secretName, secret);
    else {
      // Silently skipping here produced a route that compiled, deployed,
      // and then failed EVERY delivery with `no-secret` at runtime -
      // found live the first time a fan-out targeted a profile that had
      // never been a delivery target before. The router cannot sign for
      // a profile whose WEBHOOK_SECRET it does not have, so say so here,
      // where the fix is still cheap.
      warn(
        `[${edge.agent.profile}] is a delivery target but declares no WEBHOOK_SECRET - ` +
          `every delivery on route ${edge.route} will fail with no-secret. ` +
          `Add WEBHOOK_ENABLED and WEBHOOK_SECRET to its env (distribution.yaml env_requires ` +
          `+ its test config), which is also what starts the gateway's webhook platform.`,
      );
    }
  }
  // External-input binding secrets: generated once per binding, persisted
  // in state (hg event ingress test signs with them), shared with the
  // router under the binding's declared secretRef NAME. Values never
  // touch Git or the emitted tree.
  if (comm.externalInputs.length > 0) {
    state.commExtSecrets ??= {};
    for (const input of comm.externalInputs) {
      state.commExtSecrets[input.id] ??= crypto.randomBytes(24).toString("hex");
      secretEntries.set(input.verification.secretRef.name, state.commExtSecrets[input.id]!);
    }
    saveState(state);
  }
  if (secretEntries.size > 0) {
    const literals = [...secretEntries.entries()].map(([k, v]) => `--from-literal=${k}=${v}`);
    const manifest = sh([
      "kubectl", "--context", KCTX,
      "create", "secret", "generic", "hermes-event-router-secrets", "-n", router.namespace,
      ...literals, "--dry-run=client", "-o", "yaml",
    ]);
    kubectl(["apply", "-f", "-"], { input: manifest });
  }

  installEventRouterChart(state, router.namespace, valuesFile, router.service);
  ok(
    `event router up: ${comm.producers.length} producer(s), ${comm.edges.length} edge(s) -> ` +
      `http://127.0.0.1:${state.ports!.router} (in-cluster: ${router.service}.${router.namespace})`,
  );
}

/** Is the Hermes agent image in the local docker daemon? By exit code:
 * `docker image inspect` prints `[]` on stdout for a MISSING image, so a
 * non-empty-stdout test reads absence as presence. */
export function agentImagePresent(): boolean {
  return Bun.spawnSync(["docker", "image", "inspect", AGENT_IMAGE], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

export function importAgentImage(): void {
  if (!agentImagePresent()) {
    throw new CliError(
      `${AGENT_IMAGE} not found in the local docker daemon - build or tag it first ` +
        "(the platform e2e uses the same image)",
    );
  }
  sh(["k3d", "image", "import", AGENT_IMAGE, "-c", CLUSTER_NAME]);
  ok(`${AGENT_IMAGE} imported into the cluster`);
}

/** The Eve runtime image for the local loop (ADR-149). Unlike the Hermes
 * agent image (built elsewhere, merely imported), this Dockerfile is ours:
 * build it here at the versions.json pin - harness/eve/image/build.sh
 * reads the pin itself - then import it into k3d. Idempotent: docker's
 * layer cache makes a rebuild seconds once the image exists. */
export function ensureEveRuntimeImage(): void {
  sh(
    ["bash", path.join(PLATFORM_ROOT, "harness", "eve", "image", "build.sh"), EVE_RUNTIME_IMAGE],
    { cwd: PLATFORM_ROOT },
  );
  sh(["k3d", "image", "import", EVE_RUNTIME_IMAGE, "-c", CLUSTER_NAME]);
  ok(`${EVE_RUNTIME_IMAGE} (eve ${VERSIONS.runtimes.eve.version}) built and imported into the cluster`);
}

/** The in-cluster manual (#664, ADR 0167): build the wiki image at THIS
 * checkout's revision (docker layer cache makes reruns cheap), import it,
 * install the chart. The /version probe then reports this revision. */
export function ensureWiki(): void {
  const image = VERSIONS.wiki.image;
  sh(["bash", path.join(PLATFORM_ROOT, "control-plane", "wiki", "image", "build.sh"), image], { cwd: PLATFORM_ROOT });
  sh(["k3d", "image", "import", image, "-c", CLUSTER_NAME]);
  log("installing wiki (local chart)...");
  sh([
    "helm", "upgrade", "--install", "wiki",
    path.join(PLATFORM_ROOT, "control-plane", "wiki", "chart"),
    "-n", "hermes-system", "--create-namespace",
    "--set", `image=${image}`,
    "--kube-context", KCTX,
  ]);
  ok("wiki installed (in-cluster manual)");
}

/** The Nexus UI host image (#845): build it at this checkout, import it, so
 * the local loop runs Nexus without the legacy agent image. Docker's layer
 * cache makes reruns cheap; the tag is versions.json's pin, which the
 * chart's default names, so no --set is needed. */
export function ensureNexusImage(): void {
  const image = VERSIONS.nexus.image;
  sh(["bash", path.join(PLATFORM_ROOT, "control-plane", "nexus", "image", "build.sh"), image], { cwd: PLATFORM_ROOT });
  sh(["k3d", "image", "import", image, "-c", CLUSTER_NAME]);
  ok(`${image} built and imported into the cluster`);
}

export function ensureAppProject(state: HgState, recordsYaml: string[]): void {
  const template = fs.readFileSync(
    path.join(PLATFORM_ROOT, "infra", "gitops-template", "bootstrap", "project.yaml"),
    "utf8",
  )
    .replace(/__GITOPS_REPO_URL__/g, `git://${state.gatewayIp}:${state.ports!.git}/gitops.git`)
    .replace(/__GITOPS_BRANCH__/g, "main")
    .replace(/__HERMES_GITOPS_REPO_URL__/g, `git://${state.gatewayIp}:${state.ports!.git}/platform.git`)
    .replace(/__CHART_REVISION__/g, state.platformSha!)
    .replace(/__IMAGE_REPOSITORY__/g, "hermes-agent")
    .replace(/__IMAGE_TAG__/g, "hermes-gitops-dev")
    // The scaffold's operator-allowlist slot; the local loop unions the
    // records' remote repos programmatically below instead.
    .replace(/^__OPERATOR_SOURCE_REPOS__\n/m, "");
  const project = parseYaml(template) as {
    spec: { sourceRepos?: string[] };
  };
  const repos = new Set(project.spec.sourceRepos ?? []);
  // The profile source (agent boot clone) + every record's remote repos.
  repos.add(`http://${state.gatewayIp}:${state.ports!.http}/profile-source.git`);
  for (const recordYaml of recordsYaml) {
    for (const repo of remoteAppRepos(recordYaml)) {
      repos.add(repo);
      // oci:// repos render into the child Application SCHEME-LESS (Argo's
      // helm-OCI contract, #187) - the server-side allowlist must permit
      // the form the Application actually carries, so add the twin.
      if (repo.startsWith("oci://")) repos.add(repo.slice("oci://".length));
    }
  }
  project.spec.sourceRepos = [...repos];
  kubectl(["apply", "-f", "-"], { input: stringifyYaml(project) });
  ok("AppProject applied");
}

/** Argo CD repository Secrets for the record's oci:// helm registries.
 *
 * Helm-OCI repos need a repository Secret carrying enableOCI - Argo CD
 * will not pull a chart from a bare scheme-less repoURL without one
 * (#187). The local loop mints one per registry, with insecure: "true"
 * because dev registries (a k3d-network container with a self-signed
 * cert) have no trustable CA - a knob production configures deliberately,
 * never inherits from here. */
/** Stable, collision-free DNS-label slug for a scheme-less OCI registry
 * URL - readable prefix + 8-hex sha256 suffix. Deliberately duplicated
 * from infra/src/components/argocd/index.ts (`ociRegistrySlug`); keep
 * the two in sync. */
function ociRegistrySlug(host: string): string {
  const readable = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const hash = new Bun.CryptoHasher("sha256").update(host).digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

export function ensureOciRepoSecrets(recordYaml: string): void {
  for (const repo of remoteAppRepos(recordYaml)) {
    if (!repo.startsWith("oci://")) continue;
    const host = repo.slice("oci://".length);
    const slug = ociRegistrySlug(host);
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: `hg-oci-repo-${slug}`,
        namespace: "argocd",
        labels: { "argocd.argoproj.io/secret-type": "repository" },
      },
      stringData: {
        name: `hg-oci-${slug}`.slice(0, 63),
        url: host,
        type: "helm",
        enableOCI: "true",
        insecure: "true",
      },
    };
    kubectl(["apply", "-f", "-"], { input: stringifyYaml(secret), quiet: true });
    ok(`helm-OCI repository Secret applied for ${repo}`);
  }
}

/** The profile's Application - the ApplicationSet template's shape, as a
 * single Application (chart source + gitops values source). */
/** Retire a profile's own Application because a bundle now owns it.
 *
 * Deliberately destructive: the Application has `prune: true`, so deleting
 * it removes the StatefulSet, Service and namespace-local workloads that
 * were running that persona. That is the point - the alternative is the
 * same persona running twice, in two namespaces, against one identity and
 * one set of external credentials. ADR-28's precondition (the credentials
 * exist in the bundle namespace) is satisfied before this is called.
 *
 * Idempotent: nothing to retire is the normal case on every run after the
 * first. */
export function retirePerProfileApplication(ctx: ProfileCtx): void {
  const app = appOf(ctx.name);
  const exists = kubectl(
    ["-n", "argocd", "get", "application", app, "-o", "name"],
    { allowFail: true, quiet: true },
  ).trim();
  if (!exists) {
    log(`${ctx.name} runs inside a bundle - no per-profile Application to retire`);
    return;
  }
  log(`${ctx.name} moved into a bundle - retiring its per-profile Application ${app}`);
  kubectl(["-n", "argocd", "delete", "application", app, "--wait=true"], { allowFail: true });
  ok(`retired ${app} (its namespace-local workloads are pruned; the bundle now owns this profile)`);
}

export function applyApplication(state: HgState, ctx: ProfileCtx): void {
  const gitopsUrl = `git://${state.gatewayIp}:${state.ports!.git}/gitops.git`;
  const platformUrl = `git://${state.gatewayIp}:${state.ports!.git}/platform.git`;
  const app = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: appOf(ctx.name),
      namespace: "argocd",
      labels: {
        "hermes-gitops.factorylevel.dev/persona": ctx.name,
        "hermes-gitops.factorylevel.dev/managed": "true",
        "hermes.dev/cli": "true",
      },
      finalizers: ["resources-finalizer.argocd.argoproj.io"],
    },
    spec: {
      project: "hermes-gitops",
      sources: [
        {
          repoURL: platformUrl,
          targetRevision: state.platformSha!,
          // The record's runtime picks the chart (ADR-149) - the same
          // choice the agents ApplicationSet makes from spec.chart.
          path: ctx.runtime === "eve" ? "harness/eve/charts/eve-agent" : "harness/hermes/charts/hermes-profile",
          helm: {
            releaseName: appOf(ctx.name),
            // The workspace values file exists only for bound profiles.
            ignoreMissingValueFiles: true,
            valueFiles: [
              "$gitops/bootstrap/values/cluster-values.yaml",
              `$gitops/profiles/${ctx.name}/profile.yaml`,
              `$gitops/deployments/workspaces/profiles/${ctx.name}.yaml`,
              // Connection projections (ADR-152) - present only for profiles
              // a Connections declaration binds.
              `$gitops/deployments/connections/profiles/${ctx.name}.yaml`,
            ],
            // The one local-only divergence for Eve (the same class as
            // the Hermes image's cluster-values rewrite): the runtime
            // image is the locally built eve-runtime:hermes-gitops-dev,
            // not the registry pin.
            ...(ctx.runtime === "eve"
              ? {
                  valuesObject: {
                    runtimeImage: {
                      repository: EVE_RUNTIME_IMAGE.split(":")[0],
                      tag: EVE_RUNTIME_IMAGE.split(":")[1],
                      pullPolicy: "Never",
                    },
                  },
                }
              : {}),
          },
        },
        { repoURL: gitopsUrl, targetRevision: "main", ref: "gitops" },
      ],
      destination: { name: "in-cluster", namespace: nsOf(ctx.name) },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        syncOptions: ["CreateNamespace=true", "ServerSideApply=true"],
        retry: { limit: 5, backoff: { duration: "30s", factor: 2, maxDuration: "5m" } },
      },
    },
  };
  kubectl(["apply", "-f", "-"], { input: stringifyYaml(app) });
  ok(`Application ${appOf(ctx.name)} applied`);
}

/** Where a bundle declaration lives for the local loop: alongside the
 * onboarded repository, the same place the operator would put it in a real
 * GitOps repo. Absent is the normal case - bundles are opt-in during the
 * ADR-28 migration, and the per-profile path stays the default. */
export function bundleDeclarationFile(state: HgState): string | null {
  const candidate = path.join(teamDir(state.profileDir), "bundles.yaml");
  return fs.existsSync(candidate) ? candidate : null;
}

/** Where the workspace-bindings declaration lives (issue #361): alongside
 * the onboarded repository, exactly like the bundle declaration above.
 * Absent is the normal case - workspace repositories are opt-in. */
export function workspaceDeclarationFile(state: HgState): string | null {
  const candidate = path.join(teamDir(state.profileDir), "workspaces.yaml");
  return fs.existsSync(candidate) ? candidate : null;
}

/** Where the connections declaration lives (ADR-152): beside the other
 * environment declarations. Absent is the normal case. */
export function connectionDeclarationFile(state: HgState): string | null {
  const candidate = path.join(teamDir(state.profileDir), "connections.yaml");
  return fs.existsSync(candidate) ? candidate : null;
}

/** The deployed coordinates the connections compiler needs per profile
 * (ADR-152): runtime, instance name, namespace/Service/port - standalone
 * defaults, or the bundle's when `bundled` names the member's placement.
 * Pure over its inputs so `hg validate` can call it with no cluster. */
export function connectionTargets(
  ctxs: ProfileCtx[],
  bundled: Map<string, { namespace: string; service: string; port: number }> = new Map(),
): Record<string, import("../connection/compile").ProfileTarget> {
  const out: Record<string, import("../connection/compile").ProfileTarget> = {};
  for (const ctx of ctxs) {
    const runtime = ctx.runtime === "eve" ? "eve" : "hermes";
    const instance = instanceNameOf(ctx.name, runtime);
    const b = bundled.get(ctx.name);
    out[ctx.name] = b
      ? { runtime, instance: `${b.service}-${ctx.name}`, namespace: b.namespace, service: b.service, port: b.port }
      : { runtime, instance, namespace: instance, service: instance, port: runtime === "eve" ? EVE_PORT_DEFAULT : 8644 };
  }
  return out;
}
const EVE_PORT_DEFAULT = 3000;

/** The bundle Application, shaped exactly like the dormant
 * `hermes-gitops-bundles` ApplicationSet renders it (two sources, chart
 * from the platform mirror, values from $gitops) - so booting one locally
 * exercises the production shape rather than a local imitation. */
export function applyBundleApplication(state: HgState, bundle: { name: string; namespace: string; application: string; chart: "hermes-bundle" | "eve-bundle" }): void {
  const gitopsUrl = `git://${state.gatewayIp}:${state.ports!.git}/gitops.git`;
  const platformUrl = `git://${state.gatewayIp}:${state.ports!.git}/platform.git`;
  const app = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: bundleAppOf(bundle.name, bundle.chart === "eve-bundle" ? "eve" : "hermes"),
      namespace: "argocd",
      labels: {
        "hermes-gitops.factorylevel.dev/bundle": bundle.name,
        "hermes-gitops.factorylevel.dev/managed": "true",
        "hermes.dev/cli": "true",
      },
      finalizers: ["resources-finalizer.argocd.argoproj.io"],
    },
    spec: {
      project: "hermes-gitops",
      sources: [
        {
          repoURL: platformUrl,
          targetRevision: state.platformSha!,
          path: bundle.chart === "eve-bundle" ? "harness/eve/charts/eve-bundle" : "harness/hermes/charts/hermes-bundle",
          helm: {
            releaseName: bundleAppOf(bundle.name, bundle.chart === "eve-bundle" ? "eve" : "hermes"),
            // An Eve bundle runs every member on the local-loop runtime
            // image, exactly as applyApplication does for a standalone
            // Eve agent (the cluster cannot pull the ghcr.io default).
            ...(bundle.chart === "eve-bundle"
              ? { valuesObject: { runtimeImage: { repository: EVE_RUNTIME_IMAGE.split(":")[0], tag: EVE_RUNTIME_IMAGE.split(":")[1], pullPolicy: "Never" } } }
              : {}),
            // cluster-values FIRST, exactly as the profile Application
            // layers it: environment (WHERE) then bundle (WHAT). Without it
            // a bundle inherits the chart's ghcr.io default image and a
            // local cluster cannot pull it - Init:ImagePullBackOff, with
            // the per-profile path working fine beside it.
            valueFiles: [
              "$gitops/bootstrap/values/cluster-values.yaml",
              `$gitops/deployments/bundles/${bundle.name}/values.yaml`,
            ],
          },
        },
        { repoURL: gitopsUrl, targetRevision: "main", ref: "gitops" },
      ],
      destination: { name: "in-cluster", namespace: bundle.namespace },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        syncOptions: ["CreateNamespace=true", "ServerSideApply=true"],
        retry: { limit: 5, backoff: { duration: "30s", factor: 2, maxDuration: "5m" } },
      },
    },
  };
  kubectl(["apply", "-f", "-"], { input: stringifyYaml(app) });
  ok(`Application ${bundleAppOf(bundle.name, bundle.chart === "eve-bundle" ? "eve" : "hermes")} applied`);
}


/** Deploy a bundled profile's apps (#301).
 *
 * Bundling retires the per-profile StatefulSet, and the bundle chart
 * ships no child Applications - so a bundled profile's `spec.apps[]`
 * were emitted into deployments/apps/ and then deployed by nothing.
 * Two agents ran for a milestone with no monitoring chart, which meant
 * no Grafana dashboard, which is how the plan came to promise a uid
 * Grafana returned 404 for.
 *
 * The records already exist and already carry everything an Application
 * needs - the production path (ADR-36's apps ApplicationSet) consumes
 * exactly these. This is the loop's imperative stand-in for it, shaped
 * like `applyBundleApplication` so both bundle-owned Applications are
 * built the same way.
 *
 * The namespace comes from the BUNDLE, not the record: the record still
 * carries the profile's own namespace, which bundling retired. */
export function applyBundleChildApps(
  state: HgState,
  bundle: { name: string; namespace: string; profiles: string[] },
): void {
  const gitopsUrl = `git://${state.gatewayIp}:${state.ports!.git}/gitops.git`;
  const platformUrl = `git://${state.gatewayIp}:${state.ports!.git}/platform.git`;
  const root = path.join(STAGING, "gitops", "deployments", "apps");
  if (!fs.existsSync(root)) return;
  let applied = 0;
  // One release per APP, not per member. The monitoring chart derives its
  // dashboard uid from `.Release.Namespace`, which was unique per profile
  // until bundling put two members in one namespace - deploying both
  // monitoring releases produced two dashboards claiming
  // `hermes-marketing-core-dash`, and the sidecar imports the second over
  // the first. Deduping is also the honest granularity: bundled members
  // share a POD, so they share availability, memory and freshness. Two
  // dashboards would show the same numbers under two names.
  const seenApps = new Set<string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "deployment.yaml");
    if (!fs.existsSync(file)) continue;
    const rec = (parseYaml(fs.readFileSync(file, "utf8")) as {
      spec?: { profile?: string; app?: string; application?: string; source?: { repo?: string; path?: string; chart?: string; repoURL?: string; targetRevision?: string } };
    })?.spec;
    if (!rec?.profile || !bundle.profiles.includes(rec.profile)) continue;
    if (!rec.application || !rec.source) continue;
    if (rec.app && seenApps.has(rec.app)) {
      log(`bundle ${bundle.name}: ${rec.app} already deployed for another member - one release per app`);
      continue;
    }
    // The two source shapes the fleet's apps ApplicationSet renders
    // (infra/gitops-template/bootstrap/applicationsets/apps.yaml):
    // `repo: local` is a chart inside the platform repo; anything else is
    // a versioned chart from a registry. Locally the registry is the
    // mirror `hg up` published the chart to (redirectOciRepos does the
    // same for a standalone profile's record).
    const helm = {
      releaseName: rec.application,
      ignoreMissingValueFiles: true,
      // Only the app's own values. `cluster-values.yaml` was layered here
      // once: its top-level `image` map is the AGENT image and breaks any
      // app chart whose `image` is a string (test-page went
      // InvalidImageName). The profile chart's child Applications never
      // layered it either.
      valueFiles: [`$gitops/deployments/apps/${entry.name}/values.yaml`],
    };
    let chartSource: Record<string, unknown>;
    if (rec.source.repo === "local" && rec.source.path) {
      chartSource = { repoURL: platformUrl, targetRevision: state.platformSha!, path: rec.source.path, helm };
    } else if (rec.source.chart && rec.source.targetRevision) {
      chartSource = { repoURL: `${registryHost(state)}/charts`, chart: rec.source.chart, targetRevision: rec.source.targetRevision, helm };
    } else {
      warn(`bundle ${bundle.name}: app ${rec.application} has neither a local path nor chart+version - skipped`);
      continue;
    }
    const app = {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Application",
      metadata: {
        name: rec.application,
        namespace: "argocd",
        labels: {
          "hermes-gitops.factorylevel.dev/bundle": bundle.name,
          "hermes-gitops.factorylevel.dev/profile": rec.profile,
          "hermes-gitops.factorylevel.dev/app": rec.app ?? "",
          "hermes-gitops.factorylevel.dev/managed": "true",
          "hermes.dev/cli": "true",
        },
        finalizers: ["resources-finalizer.argocd.argoproj.io"],
      },
      spec: {
        project: "hermes-gitops",
        sources: [chartSource, { repoURL: gitopsUrl, targetRevision: "main", ref: "gitops" }],
        destination: { name: "in-cluster", namespace: bundle.namespace },
        syncPolicy: {
          automated: { prune: true, selfHeal: true },
          syncOptions: ["CreateNamespace=true", "ServerSideApply=true"],
          retry: { limit: 5, backoff: { duration: "30s", factor: 2, maxDuration: "5m" } },
        },
      },
    };
    kubectl(["apply", "-f", "-"], { input: stringifyYaml(app) });
    if (rec.app) seenApps.add(rec.app);
    applied += 1;
  }
  if (applied > 0) ok(`${applied} bundled app Application(s) applied into ${bundle.namespace}`);
}

/** Hermes Classic's OIDC settings, as the env vars its self-hosted
 * dashboard-auth provider documents. Empty when no issuer exists, so a
 * fleet without identity keeps whatever auth it had. */
export function hermesOidcEnv(state: HgState): Record<string, string> {
  if (!state.ports?.identity) return {};
  const secrets = identitySecrets();
  return {
    HERMES_DASHBOARD: "1",
    HERMES_DASHBOARD_OIDC_ISSUER: issuerUrl(state),
    HERMES_DASHBOARD_OIDC_CLIENT_ID: "hermes",
    HERMES_DASHBOARD_OIDC_CLIENT_SECRET: secrets.clients.hermes!,
    // `groups` matters here: the provider carries a groups claim into
    // the session, which is what a role mapping reads. Dex's password DB
    // has none (ADR-50 Cost), so the loop proves the plumbing and #298's
    // real connector is what makes group-driven roles testable.
    HERMES_DASHBOARD_OIDC_SCOPES: "openid profile email groups",
  };
}

export function ensureEnvSecret(
  state: HgState,
  ctx: ProfileCtx,
  testCfg: TestConfig,
  /** Bundled profiles live in the BUNDLE's namespace under the name the
   * declaration gave, not in their own namespace under the derived one. */
  target?: { namespace: string; name: string },
): void {
  // test.yaml carries the COMMITTED local-dev defaults; the hg env
  // overlay (uncommitted dotenv files - see lib.ts) wins per key - the
  // same layering the bootstrap gives agentSecrets over nothing.
  const overlay = loadEnvOverlay(state, ctx);
  // The agent dashboard's OIDC config rides the SAME env Secret the
  // chart already delivers dashboard-auth vars through (see the
  // `dashboard` container in statefulset.yaml) - so Hermes Classic joins
  // the SSO matrix with no chart change and no new provider code. The
  // fork already ships a conformant self-hosted OIDC provider
  // (`plugins/dashboard_auth/self_hosted`); this configures it.
  //
  // The overlay still wins: an operator pointing one agent at a
  // different issuer is a deliberate act, not a mistake to overwrite.
  const secrets = { ...testCfg.secrets, ...hermesOidcEnv(state), ...overlay };
  if (Object.keys(secrets).length === 0) return;
  const ns = target?.namespace ?? nsOf(ctx.name);
  const secretName = target?.name ?? `${nsOf(ctx.name)}-env`;
  kubectl(["create", "namespace", ns], { allowFail: true, quiet: true });
  const literals = Object.entries(secrets).flatMap(([k, v]) => [
    `--from-literal=${k}=${v}`,
  ]);
  const manifest = sh([
    "kubectl", "--context", KCTX,
    "create", "secret", "generic", secretName, "-n", ns,
    ...literals, "--dry-run=client", "-o", "yaml",
  ]);
  kubectl(["apply", "-f", "-"], { input: manifest });
  const names = Object.keys(secrets)
    .map((k) => (k in overlay ? `${k}*` : k))
    .join(", ");
  ok(`env Secret ${secretName} applied in ${ns} (${names}${Object.keys(overlay).length ? "; * = hg envfile overlay" : ""})`);
}

/** The profile's `expose.services` declarations (hermes-gitops.yaml) -
 * what the tunnel would publish per-service hostnames for in production,
 * and what the local loop port-forwards (#183's pragmatic core; the
 * tunnel chart templates themselves are still not exercised locally). */
export function exposeServicesOf(profileDir: string): { name: string; port: number; path: string }[] {
  const doc = readAgentDeclaration(profileDir).raw as {
    expose?: { services?: { name?: string; port?: number; path?: string }[] };
  };
  return (doc?.expose?.services ?? [])
    .filter((s) => s?.name && s?.port)
    .map((s) => ({ name: String(s.name), port: Number(s.port), path: s.path ?? "/" }));
}

/** The control plane's OWN web UIs. Unlike `expose.services` these are
 * not contract-driven - fixed namespaces and Service names the loop
 * installs itself - but they ride exactly the same forward lifecycle,
 * state entries and reaping, so there is one forwarder, not two.
 *
 * Prometheus is here for the local loop only: it has no `hostnames`
 * entry to publish through the tunnel, and Grafana proxies it in-cluster
 * anyway. It earns its port because when a panel renders empty, "is the
 * metric there at all" is the first question. */
export const PLATFORM_EXPOSURES: { key: string; ns: string; svc: string; port: number }[] = [
  { key: "argocd", ns: "argocd", svc: "argocd-server", port: 80 },
  { key: "grafana", ns: "hermes-monitoring", svc: "monitoring-grafana", port: 80 },
  { key: "prometheus", ns: "hermes-monitoring", svc: "monitoring-prometheus", port: 9090 },
  { key: "nexus", ns: "hermes-nexus", svc: "nexus", port: 80 },
];

/** One persistent `kubectl port-forward` on a STABLE local port recorded
 * in state, reused when alive and respawned when not. Returns the local
 * port, and whether state changed so the caller can batch the save.
 *
 * A live PID is NOT proof of a live forward: kubectl port-forward
 * outlives the pod it was pinned to, and every record change rolls the
 * pod. Probe the port and reap a stale forward before reusing. A respawn
 * racing a not-yet-Ready pod just dies and is retried on the next
 * touchpoint. */
/** A forward that ANSWERS, not one that merely accepts a socket.
 *
 * `portAccepts` is not enough for anything behind a rolling pod. kubectl
 * port-forward outlives the pod it was pinned to and keeps accepting TCP
 * while forwarding to a corpse - already documented for the event-router
 * below, and the same trap bit the control-plane UIs: a `helm upgrade` that
 * rolls Nexus leaves its forward passing the socket check for the seconds
 * it takes the old pod to terminate, so it gets REUSED and then dies. An
 * HTTP round trip cannot be fooled that way: any status code proves
 * something on the other end replied. */
function httpAnswers(port: number): boolean {
  return (
    Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-m", "3", `http://127.0.0.1:${port}/`])
      .exitCode === 0
  );
}

function ensureForward(
  state: HgState,
  key: string,
  ns: string,
  service: string,
  targetPort: number,
  logName: string,
  healthy: (port: number) => boolean = portAccepts,
): { localPort: number; spawned: boolean } {
  const existing = state.expose![key];
  if (existing && pidAlive(existing.pid)) {
    if (healthy(existing.localPort)) return { localPort: existing.localPort, spawned: false };
    try {
      process.kill(existing.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const localPort = existing?.localPort ?? freePort();
  const pid = spawnDetached(
    ["kubectl", "--context", KCTX, "-n", ns, "port-forward",
      `svc/${service}`, `${localPort}:${targetPort}`],
    path.join(HG_HOME, `${logName}.log`),
  );
  state.expose![key] = { localPort, pid };
  // Give it a moment to bind and answer. Not fatal if it does not - a pod
  // that is still starting gets picked up by the next touchpoint - but
  // waiting here is what stops `up` from PRINTING a URL that is not live.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !healthy(localPort)) Bun.sleepSync(200);
  return { localPort, spawned: true };
}

/** The control-plane UIs only. Split out from `ensureExposures` because
 * it has to run EARLIER than the rest: the in-cluster Nexus is configured
 * with browser-reachable base URLs for Argo CD and Grafana, and those URLs
 * are these forwards' ports. Installing Nexus before they exist is how it
 * ended up deployed with `baseUrl: ""` - every link dead, and the embed
 * debug view reporting "no Grafana base URL configured" on a cluster where
 * Grafana was running fine.
 *
 * Safe to call twice: the second call sees live forwards and reuses them.
 * Returns whether state changed, so callers can batch the save. */
export function ensurePlatformExposures(state: HgState, announce = true): boolean {
  state.expose ??= {};
  let changed = false;
  for (const p of PLATFORM_EXPOSURES) {
    const { localPort, spawned } = ensureForward(state, p.key, p.ns, p.svc, p.port, `expose-platform-${p.key}`, httpAnswers);
    changed ||= spawned;
    if (announce) ok(`${p.key}: http://127.0.0.1:${localPort}`);
  }
  if (changed) saveState(state);
  return changed;
}

/** Contract-driven local exposure: one forward per `expose.services`
 * entry, plus one per control-plane UI (PLATFORM_EXPOSURES). Called
 * automatically by `up`, `dev` (reload + watchdog) and `reset` -
 * declaring a service IS the ask; no separate command required. Quiet
 * unless `announce`. */
export function ensureExposures(state: HgState, announce = true): void {
  state.expose ??= {};
  let changed = false;

  changed = ensurePlatformExposures(state, announce) || changed;

  for (const ctx of profileCtxs(state)) {
    for (const svc of exposeServicesOf(ctx.dir)) {
      const key = `${ctx.name}:${svc.name}`;
      const { localPort, spawned } = ensureForward(
        state, key, nsOf(ctx.name), appOf(ctx.name), svc.port, `expose-${ctx.name}-${svc.name}`,
      );
      changed ||= spawned;
      if (announce) {
        const note = spawned
          ? `  (production: the tunnel's ${svc.name} hostname; no Access enforcement locally)`
          : "";
        ok(`${key}: http://127.0.0.1:${localPort}${svc.path}${note}`);
      }
    }
  }
  if (changed) saveState(state);
}

/** The control plane's local credentials, for a human about to open a
 * browser. Both are dev credentials on a throwaway cluster - Grafana's
 * is committed in the bootstrap values, Argo CD's is generated per
 * install - and neither is ever written to Git.
 *
 * Argo CD's Secret is DELETED after first login, which is not an error:
 * it means somebody already changed the password. Report null and say
 * so rather than failing the command. */
export function platformCredentials(): Record<string, { user: string; password: string } | null> {
  const argoRaw = kubectl(
    ["-n", "argocd", "get", "secret", "argocd-initial-admin-secret",
      "-o", "jsonpath={.data.password}"],
    { quiet: true, allowFail: true },
  ).trim();
  return {
    argocd: argoRaw ? { user: "admin", password: Buffer.from(argoRaw, "base64").toString("utf8") } : null,
    grafana: (() => {
      try {
        return grafanaCredentials();
      } catch {
        return null;
      }
    })(),
    prometheus: null,
  };
}

/** Dev-loop chart hot-reload (spec §27 REPL): package the changed
 * agent-application chart as a unique -dev.N prerelease and push it to
 * the oci:// repo the profiles already declare for it (locally, the dev
 * registry; self-signed => skip-verify). Returns the pushed version. The
 * caller patches the published records so Argo CD pulls the new bytes -
 * a LOCAL-LOOP-ONLY divergence from the committed version pin,
 * deliberately visible in every record it touches. */
export function pushDevChart(
  chartDir: string,
  chartName: string,
  ociRepo: string,
  seq: number,
): string {
  const version = `0.0.0-dev.${seq}`;
  const outDir = path.join(STAGING, "dev-charts");
  fs.mkdirSync(outDir, { recursive: true });
  sh(["helm", "package", chartDir, "--version", version, "-d", outDir], { quiet: true });
  sh(
    ["helm", "push", path.join(outDir, `${chartName}-${version}.tgz`), ociRepo,
      "--insecure-skip-tls-verify"],
    { quiet: true },
  );
  return version;
}

/** Patch a rendered record's spec.apps[] entries in place: any app whose
 * chart has an active dev version (and pulls from an oci:// repo) gets
 * that version. Local-loop-only - see pushDevChart. */
export function patchRecordDevVersions(
  recordYaml: string,
  devVersions: Record<string, string>,
): string {
  if (Object.keys(devVersions).length === 0) return recordYaml;
  const record = parseYaml(recordYaml) as {
    spec?: { apps?: { chart?: string; repo?: string; version?: string }[] };
  };
  let touched = false;
  for (const app of record.spec?.apps ?? []) {
    if (app.chart && app.repo?.startsWith("oci://") && devVersions[app.chart]) {
      app.version = devVersions[app.chart];
      touched = true;
    }
  }
  return touched ? stringifyYaml(record) : recordYaml;
}

// A profile that declares spec.gitAuthSecretRef gets a REQUIRED secret
// volume in the chart (missing => the pod never starts; that hard-fail is
// deliberate for the fleet, where agentGitAuth materializes the Secret).
// The local CLI has no agentGitAuth channel and its profile source is the
// host git remote (git:// — .netrc auth material is ignored), so a
// placeholder unblocks the mount without changing clone behavior. Labeled
// hermes.dev/preserve=true so `hg reset` keeps it (the re-created pod
// still needs the mount).
export function ensureGitAuthSecret(
  ctx: ProfileCtx,
  recordYaml: string,
  target?: { namespace: string; name: string },
): void {
  const record = parseYaml(recordYaml) as {
    spec?: { gitAuthSecretRef?: string };
  } | null;
  const ref = target?.name ?? record?.spec?.gitAuthSecretRef;
  if (!ref) return;
  const ns = target?.namespace ?? nsOf(ctx.name);
  kubectl(["create", "namespace", ns], { allowFail: true, quiet: true });
  // NEVER overwrite an existing credential. This used to apply the local
  // placeholder unconditionally, which meant an operator-supplied token
  // for a real private repository survived until the next `hg up` - and
  // the reconciler runs `hg up` every tick, so "until the next one" was
  // minutes. Placeholders are for a namespace that has no credential yet;
  // a secret that already exists is somebody's deliberate act.
  const existing = sh(
    ["kubectl", "--context", KCTX, "get", "secret", ref, "-n", ns, "-o", "name"],
    { allowFail: true, quiet: true },
  ).trim();
  if (existing) {
    kubectl(
      ["label", "--overwrite", "-n", ns, `secret/${ref}`, "hermes.dev/preserve=true"],
      { allowFail: true, quiet: true },
    );
    ok(`git-auth Secret ${ref} left as-is (already present)`);
    return;
  }
  const manifest = sh([
    "kubectl", "--context", KCTX,
    "create", "secret", "generic", ref, "-n", ns,
    "--from-literal=username=local-dev",
    "--from-literal=password=local-dev-placeholder",
    "--dry-run=client", "-o", "yaml",
  ]);
  kubectl(["apply", "-f", "-"], { input: manifest });
  kubectl(
    ["label", "--overwrite", "-n", ns, `secret/${ref}`, "hermes.dev/preserve=true"],
    { allowFail: true, quiet: true },
  );
  ok(`git-auth Secret ${ref} applied (local placeholder; host-remote clone needs no auth)`);
}

// ---------------------------------------------------------------------------
// Waiting + refresh.
// ---------------------------------------------------------------------------

export function appStatus(name: string): { sync: string; health: string } {
  return appStatusOf(appOf(name));
}

/** Status by the Application's OWN name. `appStatus` prefixes a persona
 * name; a bundle Application is not named after a persona. */
export function appStatusOf(application: string): { sync: string; health: string } {
  const out = kubectl(
    [
      "-n", "argocd", "get", "application", application,
      "-o", "jsonpath={.status.sync.status} {.status.health.status}",
    ],
    { allowFail: true, quiet: true },
  ).trim();
  const [sync = "", health = ""] = out.split(/\s+/);
  return { sync, health };
}

/** The compiled bundles present in the published gitops repo, as
 * (name, namespace) - read from the emitted deployment.yaml records so the
 * CLI and the ApplicationSet agree on identity. */
/** The Secret names a bundle declares for one of its profiles. Read from
 * the COMPILED values.yaml, so the CLI creates exactly the names the chart
 * mounts - deriving them independently is how the two drift. */
export function bundleProfileSecretRefs(
  state: HgState,
  bundleName: string,
  profileName: string,
): { envSecretRef?: string; gitAuthSecretRef?: string } {
  void state;
  const file = path.join(STAGING, "gitops", "deployments", "bundles", bundleName, "values.yaml");
  if (!fs.existsSync(file)) return {};
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as
    | { spec?: { profiles?: { name?: string; envSecretRef?: string; gitAuthSecretRef?: string }[] } }
    | null;
  const entry = (doc?.spec?.profiles ?? []).find((p) => p.name === profileName);
  return {
    ...(entry?.envSecretRef ? { envSecretRef: entry.envSecretRef } : {}),
    ...(entry?.gitAuthSecretRef ? { gitAuthSecretRef: entry.gitAuthSecretRef } : {}),
  };
}


/** The bundle's declared external repositories, read from the emitted
 * values the cluster actually applies. */
export interface WorkspaceRepository {
  name: string;
  source?: string;
  gitAuthSecretRef?: string;
}

export function bundleRepositories(
  state: HgState,
  bundleName: string,
): WorkspaceRepository[] {
  void state;
  const file = path.join(STAGING, "gitops", "deployments", "bundles", bundleName, "values.yaml");
  if (!fs.existsSync(file)) return [];
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as
    | { spec?: { repositories?: Partial<WorkspaceRepository>[] } }
    | null;
  return (doc?.spec?.repositories ?? [])
    .filter((r): r is WorkspaceRepository => Boolean(r?.name));
}

/** The workspace repositories bound to one STANDALONE profile, from the
 * compiled record the workspace compiler wrote (the bundle equivalent is
 * bundleRepositories). Empty when the profile has no binding. */
export function profileRepositories(name: string): WorkspaceRepository[] {
  const file = path.join(STAGING, "gitops", "deployments", "workspaces", "profiles", `${name}.yaml`);
  if (!fs.existsSync(file)) return [];
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as
    | { spec?: { workspace?: { repositories?: Partial<WorkspaceRepository>[] } } }
    | null;
  return (doc?.spec?.workspace?.repositories ?? [])
    .filter((r): r is WorkspaceRepository => Boolean(r?.name));
}

/** The keys the bootstrap script reads for a source's scheme:
 * `username`+`password` for https, `ssh-privatekey` for ssh. A token
 * fills the https pair; without one the values are placeholders. */
export function repositoryAuthKeys(source: string | undefined, token?: string): Record<string, string> {
  if (!/^https?:\/\//.test(source ?? "")) return { "ssh-privatekey": "" };
  return token
    ? { username: "x-access-token", password: token }
    : { username: "local-dev", password: "local-dev-placeholder" };
}

/** The label a placeholder credential carries so a later real value can
 * replace it. A Secret WITHOUT it is somebody's deliberate act and is
 * never overwritten. */
const PLACEHOLDER_LABEL = "hermes.dev/placeholder";

/** Ensure a repository credential Secret EXISTS in the shape the
 * bootstrap script reads for the source's scheme: `username`+`password`
 * for https, `ssh-privatekey` for ssh.
 *
 * Locally the declared credential path is `hg envfile`: a `GIT_TOKEN`
 * there fills an https Secret, exactly as the profile's env declares it
 * ("GitHub token able to clone ..."). Without one the placeholder is
 * deliberately useless for a private clone. What it buys is a pod that
 * starts and fails visibly instead of one that sits in `Init:0/1` forever
 * on `MountVolume.SetUp failed ... secret not found`, which is a state
 * nothing surfaces and nobody is watching at 3am.
 *
 * A wrong-shaped placeholder is worse than none: an empty `ssh-privatekey`
 * against an https source fails the boot script's key check, so the
 * checkout stays empty even after the operator supplies a token
 * (found live on the dogfooding loop, #849). */
export function ensureRepositoryAuthSecret(
  namespace: string,
  ref: string,
  repo: { name: string; source?: string },
  token?: string,
): void {
  kubectl(["create", "namespace", namespace], { allowFail: true, quiet: true });
  const existing = sh(
    ["kubectl", "--context", KCTX, "get", "secret", ref, "-n", namespace, "-o", `go-template={{index .metadata.labels "${PLACEHOLDER_LABEL}"}}`],
    { allowFail: true, quiet: true },
  );
  const present = sh(
    ["kubectl", "--context", KCTX, "get", "secret", ref, "-n", namespace, "-o", "name"],
    { allowFail: true, quiet: true },
  ).trim();
  const placeholder = existing.trim() === "true";
  if (present && !(placeholder && token)) {
    kubectl(["label", "--overwrite", "-n", namespace, `secret/${ref}`, "hermes.dev/preserve=true"],
      { allowFail: true, quiet: true });
    return;
  }
  const https = /^https?:\/\//.test(repo.source ?? "");
  const literals = Object.entries(repositoryAuthKeys(repo.source, token)).map(([k, v]) => `--from-literal=${k}=${v}`);
  const manifest = sh([
    "kubectl", "--context", KCTX, "create", "secret", "generic", ref, "-n", namespace,
    ...literals, "--dry-run=client", "-o", "yaml",
  ]);
  kubectl(["apply", "-f", "-"], { input: manifest });
  kubectl(["label", "--overwrite", "-n", namespace, `secret/${ref}`,
    `${PLACEHOLDER_LABEL}=${token ? "false" : "true"}`, "hermes.dev/preserve=true"],
    { allowFail: true, quiet: true });
  if (token) {
    ok(`repository ${repo.name}: ${ref} in ${namespace} filled from GIT_TOKEN (hg envfile)`);
    return;
  }
  warn(
    `repository ${repo.name}: created a placeholder ${ref} in ${namespace} so the pod can start. ` +
      (https
        ? `A private clone will fail until a token is supplied: hg envfile set GIT_TOKEN=<token> --profile <name>, then hg up.`
        : "A private clone will fail until a real ssh-privatekey is supplied through the declared secret path."),
  );
}

export interface BundleApplication {
  name: string;
  namespace: string;
  /** The Argo Application name the compiler stamped (spec.application):
   * hermes-<name> for a Hermes bundle, ag-eve-<name> for an Eve one
   * (ADR-151). The local loop applies exactly that name. */
  application: string;
  profiles: string[];
  /** The chart the compiler stamped (ADR-150); a record from before the
   * key is a Hermes bundle, exactly as the ApplicationSet's `dig` reads it. */
  chart: "hermes-bundle" | "eve-bundle";
}

export function bundleApplications(state: HgState): BundleApplication[] {
  const dir = path.join(STAGING, "gitops", "deployments", "bundles");
  if (!fs.existsSync(dir)) return [];
  const out: BundleApplication[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry, "deployment.yaml");
    if (!fs.existsSync(file)) continue;
    const doc = parseYaml(fs.readFileSync(file, "utf8")) as
      | { spec?: { bundle?: string; namespace?: string; application?: string; profiles?: string[]; chart?: string } }
      | null;
    if (doc?.spec?.bundle && doc.spec.namespace) {
      out.push({
        name: doc.spec.bundle,
        namespace: doc.spec.namespace,
        application: doc.spec.application ?? `hermes-${doc.spec.bundle}`,
        chart: doc.spec.chart === "eve-bundle" ? "eve-bundle" : "hermes-bundle",
        // deployment.yaml carries profile NAMES, not objects - the richer
        // per-profile shape (with its Secret refs) is in values.yaml.
        profiles: (doc.spec.profiles ?? []).filter((n): n is string => typeof n === "string"),
      });
    }
  }
  return out;
}

/** The Argo Application that actually carries a profile, bundle or not.
 *
 * A bundled profile has NO Application of its own - `hg up` retires it and
 * the bundle's Application owns the workload - so looking one up by the
 * profile's name reports `sync=? health=?` for a perfectly healthy agent.
 * That mistake has now been made by five surfaces (ADR-150); this is the
 * one place that knows, derived from what COMPILED, exactly like `up`. */
export function applicationOf(
  state: HgState,
  name: string,
): { application: string; bundle?: string; namespace: string; service: string; apiServerPort?: number } {
  const bundle = bundleApplications(state).find((b) => b.profiles.includes(name));
  if (!bundle) return { application: appOf(name), namespace: nsOf(name), service: appOf(name) };
  // The bundle's Service (the chart's fullname: hermes-<bundle> or
  // ag-eve-<bundle>, NOT the Application's name) is the only one left:
  // bundling retires the member's own, and only a member with an
  // apiServerPort publishes an api port on it.
  const runtime = bundle.chart === "eve-bundle" ? "eve" : "hermes";
  const file = path.join(STAGING, "gitops", "deployments", "bundles", bundle.name, "values.yaml");
  const doc = fs.existsSync(file)
    ? (parseYaml(fs.readFileSync(file, "utf8")) as { spec?: { profiles?: { name?: string; apiServerPort?: number }[] } } | null)
    : null;
  const apiServerPort = doc?.spec?.profiles?.find((p) => p.name === name)?.apiServerPort;
  return {
    application: bundleAppOf(bundle.name, runtime),
    bundle: bundle.name,
    namespace: bundle.namespace,
    service: instanceNameOf(bundle.name, runtime),
    ...(apiServerPort ? { apiServerPort } : {}),
  };
}

export async function waitFor(
  desc: string,
  timeoutSec: number,
  check: () => boolean,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    if (check()) return;
    await Bun.sleep(5000);
    const waited = Math.round((Date.now() - start) / 1000);
    if (waited > 0 && waited % 30 < 5) log(`   ...waiting for ${desc} (${waited}s/${timeoutSec}s)`);
  }
  throw new CliError(`timed out after ${timeoutSec}s waiting for ${desc}`);
}

export function refreshApp(name: string): void {
  kubectl([
    "-n", "argocd", "annotate", "application", appOf(name),
    "argocd.argoproj.io/refresh=normal", "--overwrite",
  ]);
}
