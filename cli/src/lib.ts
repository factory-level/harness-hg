// Shared plumbing for the hermes-gitops local-testing CLI (spec §27):
// shell execution, the state file, paths, and the test-config loader.
// The CLI is a developer tool - state lives under ~/.hermes-gitops, never
// in the profile repo or the platform repo.

import * as fs from "node:fs";
import { agentLayout } from "./layout.ts";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import versions from "../../versions.json" with { type: "json" };

export const CLUSTER_NAME = "hermes-gitops-cli";
// The kube context every cluster-facing verb pins. Defaults to the local
// loop's k3d cluster; a DESTINATION SERVER (real k3s, context "default")
// sets HG_KUBE_CONTEXT once in its unit/session env - without this every
// backup and platform verb is structurally local-loop-only.
export const KCTX = process.env["HG_KUBE_CONTEXT"] || `k3d-${CLUSTER_NAME}`;
export const AGENT_IMAGE = "hermes-agent:hermes-gitops-dev";
// The Eve runtime image for the local loop, built by `hg up` from
// harness/eve/image at the versions.json pin (ADR-149).
export const EVE_RUNTIME_IMAGE = "eve-runtime:hermes-gitops-dev";
// Pinned in versions.json - the one resolved-versions surface (ADR-63).
export const ARGOCD_CHART_VERSION = versions.charts.argocd;
export const VERSIONS = versions;

// Overridable for isolated runs (the CLI's own e2e uses a temp home so
// it never touches your real ~/.hermes-gitops state).
export const HG_HOME =
  process.env["HERMES_GITOPS_HOME"] || path.join(os.homedir(), ".hermes-gitops");
export const STATE_FILE = path.join(HG_HOME, "state.json");
// git daemon base-path (git:// protocol: gitops.git + platform.git).
export const SERVE_GIT = path.join(HG_HOME, "serve-git");
// dumb-http root (profile-source.git - the agent boot clones this, and
// the chart's gitCloneURL helper rejects git:// for spec.source).
export const SERVE_HTTP = path.join(HG_HOME, "serve-http");
export const STAGING = path.join(HG_HOME, "staging");
export const SINK_LOG = path.join(HG_HOME, "alert-sink.jsonl");

// The platform repo this CLI ships inside - the source of the
// hermes-profile chart, the local charts tree, and the bootstrap's
// monitoring values (single source of truth, parsed at runtime).
export const PLATFORM_ROOT = path.resolve(import.meta.dir, "..", "..");
// The frozen contract tree. ONE spelling: every schema load in cli/src goes
// through this constant, so the #651 tree move is a one-line change here.
export const CONTRACTS_ROOT = path.join(PLATFORM_ROOT, "agent-bundle-contracts");

export interface HgState {
  // The ONBOARD ROOT: either a single profile directory (distribution.yaml
  // at its top) or a catalogue root whose profiles live in subdirectories.
  profileDir: string;
  // Display name: the single profile's name, or the catalogue root's
  // basename. Per-profile identity lives in `profiles`.
  profileName: string;
  // The catalogue members (design 02: an application repository ships
  // many profiles). A single-profile onboard is a catalogue of one with
  // subdir "". `up` boots ALL of them unless onboard's --profile flag
  // narrowed the set. `runtime` (ADR-149) is absent on states written
  // before Eve existed and means hermes.
  profiles?: { name: string; subdir: string; runtime?: AgentRuntime }[];
  // Local-path onboarding is trusted; a cloned URL is not (repo-shipped
  // reset scripts need explicit consent - spec §27's trust boundary).
  trusted: boolean;
  sourceUrl?: string;
  ports?: { git: number; http: number; sink: number; router?: number; identity?: number; registry?: number };
  pids?: { gitDaemon?: number; httpServer?: number; sink?: number; routerPf?: number; identityPf?: number };
  gatewayIp?: string;
  platformSha?: string;
  // Contract-driven port-forwards: one stable local port per
  // expose.services entry, keyed "<profile>:<service>" (spec §27; the
  // local stand-in for the tunnel's per-service hostnames - #183).
  expose?: Record<string, { localPort: number; pid?: number }>;
  // charts/nexus value overrides for the local loop, set by
  // `hg nexus set <key=value>`. ADR-53's reciprocal rule: every knob the
  // Pulumi bootstrap can turn must also be reachable from the CLI, or the
  // local loop quietly becomes a weaker environment than the real one.
  // Applied as --set on top of the values `up` derives.
  nexusValues?: Record<string, string>;
  // Explicit env-file path (`hg envfile use <path>`); unset = default
  // resolution (see envOverlayFile).
  envFile?: string;
  // Local external-webhook binding secrets (ADR-39), generated per
  // binding id at `up` and shared with the router's Secret - what
  // `hg event ingress test` signs with. LOCAL loop only; production
  // bindings reference operator-provisioned Secrets.
  commExtSecrets?: Record<string, string>;
  // Whether THIS loop's `hg up` installed anonymous Grafana Viewer
  // (#447, ADR-85 amendment). AUTH008 blesses anonymous only when this
  // environment's own install recorded doing it (or the operator sets
  // the env var explicitly) - never merely because a default exists, so
  // an anonymous Grafana on a cluster this loop did NOT configure still
  // fails the proof as drift.
  grafanaAnonViewer?: boolean;
}

/** The agent runtime a catalogue member runs on (ADR-149). */
export type AgentRuntime = "hermes" | "eve";

/** One catalogue member resolved to an absolute directory. */
export interface ProfileCtx {
  name: string;
  subdir: string;
  dir: string;
  runtime: AgentRuntime;
}

export function profileCtxs(state: HgState): ProfileCtx[] {
  const list = state.profiles?.length
    ? state.profiles
    : [{ name: state.profileName, subdir: "" }];
  return list.map((p) => ({
    name: p.name,
    subdir: p.subdir,
    runtime: p.runtime ?? "hermes",
    dir: p.subdir ? path.join(state.profileDir, p.subdir) : state.profileDir,
  }));
}

/** The instance-name prefix per runtime (ADR-151): a Hermes profile is
 * `hermes-<name>`, an Eve agent or bundle is `ag-eve-<name>` - namespace,
 * Application, Service, StatefulSet and every derived Secret. One table,
 * mirrored by the charts (eve.fullname / eve-bundle.fullname), the topology
 * compiler, the Pulumi secrets component and the bootstrap ApplicationSets. */
export const RUNTIME_PREFIX: Record<AgentRuntime, string> = { hermes: "hermes-", eve: "ag-eve-" };

export function instanceNameOf(name: string, runtime: AgentRuntime): string {
  return `${RUNTIME_PREFIX[runtime]}${name}`;
}

// The runtime of every onboarded profile, read once per process from the
// state file (saveState refreshes it). Names the state does not know -
// control-plane pseudo-profiles, Hermes-era callers - resolve to hermes,
// which is the prefix they always had.
let runtimeIndex: Map<string, AgentRuntime> | null = null;
function runtimeOf(name: string): AgentRuntime {
  if (runtimeIndex === null) {
    runtimeIndex = new Map();
    try {
      if (fs.existsSync(STATE_FILE)) {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as HgState;
        for (const p of s.profiles ?? []) runtimeIndex.set(p.name, p.runtime ?? "hermes");
      }
    } catch {
      /* an unreadable state is loadState's error to raise, not naming's */
    }
  }
  return runtimeIndex.get(name) ?? "hermes";
}

/** The local loop's bundle Application name: `<prefix>bundle-<name>`
 * (`hermes-bundle-team` / `ag-eve-bundle-team`). The compiled record's own
 * `spec.application` is what the bundles ApplicationSet uses; the local
 * loop has always named its hand-applied bundle Application this way. */
export function bundleAppOf(name: string, runtime: AgentRuntime): string {
  return `${RUNTIME_PREFIX[runtime]}bundle-${name}`;
}

/** Namespace of an onboarded profile: `hermes-<name>` or, for an Eve
 * agent, `ag-eve-<name>` (the state says which). */
export function nsOf(name: string): string {
  return instanceNameOf(name, runtimeOf(name));
}
/** Application / Service / StatefulSet name - identical to the namespace. */
export function appOf(name: string): string {
  return instanceNameOf(name, runtimeOf(name));
}

export class CliError extends Error {}

/** §27 trust boundary, in ONE place: repo-shipped executables (reset hooks,
 * pyeval suites, eval scenarios) run only when the profile was onboarded
 * from a local path, or the operator consented with --allow-repo-scripts. */
export function repoScriptsAllowed(state: HgState, allowFlag: boolean): boolean {
  return state.trusted || allowFlag;
}

// JSON mode (--json): stdout carries EXACTLY one JSON document, so the
// human narration goes to stderr instead. Machine consumers (the
// hermes-dev Claude skills) parse stdout; humans still see progress.
let jsonMode = false;
export function setJsonMode(on: boolean): void {
  jsonMode = on;
}
export function jsonOut(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

export function log(msg: string): void {
  if (jsonMode) console.error(`[hg] ${msg}`);
  else console.log(`[hg] ${msg}`);
}
export function ok(msg: string): void {
  if (jsonMode) console.error(`  ✓ ${msg}`);
  else console.log(`  ✓ ${msg}`);
}

/** A condition that will break something later, said now. Always to
 * stderr: a warning that scrolls past inside piped stdout is a warning
 * nobody reads. */
export function warn(msg: string): void {
  console.error(`  ! ${msg}`);
}

/** Second-precision RFC 3339 with a literal Z - the format every status
 * record this CLI publishes uses, and what the schemas' timestamp pattern
 * accepts. `toISOString()` alone emits milliseconds, which the readers
 * treat as an unparseable timestamp. */
export function toRfc3339(iso: string = new Date().toISOString()): string {
  return iso.replace(/\.\d+Z$/, "Z");
}

export interface ShOptions {
  cwd?: string;
  allowFail?: boolean;
  quiet?: boolean;
  input?: string;
}

/** Run a command synchronously; throw (with stderr) on failure unless
 * allowFail. Returns stdout. */
export function sh(cmd: string[], opts: ShOptions = {}): string {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0 && !opts.allowFail) {
    throw new CliError(
      `command failed (${proc.exitCode}): ${cmd.join(" ")}\n${stderr || stdout}`,
    );
  }
  if (!opts.quiet && stderr.trim() && proc.exitCode !== 0) {
    console.error(stderr.trim());
  }
  return stdout;
}

export function kubectl(args: string[], opts: ShOptions = {}): string {
  return sh(["kubectl", "--context", KCTX, ...args], opts);
}

/** Spawn a long-lived helper detached from this process; returns pid. */
export function spawnDetached(cmd: string[], logFile: string, cwd?: string): number {
  const out = fs.openSync(logFile, "a");
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: out,
    stderr: out,
    stdin: "ignore",
  });
  proc.unref();
  return proc.pid;
}

/** Does anything actually accept a TCP connection on this local port?
 *
 * A `kubectl port-forward` process OUTLIVES the pod it was pinned to, so
 * `pidAlive` alone reports a forward as healthy long after the pod it
 * targeted was replaced - and every record change rolls the pod. Probing
 * the port is the only honest liveness check. Synchronous on purpose:
 * the callers are sync, and this is one connect() to loopback. */
export function portAccepts(port: number): boolean {
  return (
    Bun.spawnSync(["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function freePort(): number {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = srv.port;
  srv.stop(true);
  return port;
}

export function loadState(): HgState {
  if (!fs.existsSync(STATE_FILE)) {
    throw new CliError(
      "no profile onboarded yet - run: hg onboard <./path | repo-url>",
    );
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as HgState;
}

/** Atomic JSON write: beside, then rename - a crash never leaves a torn
 * file. Lifted from platform-backup's manifest pattern now that unattended
 * writers (the reconcile timer) share these files with interactive runs. */
export function writeJsonAtomic(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function saveState(state: HgState): void {
  writeJsonAtomic(STATE_FILE, state);
  runtimeIndex = null;
}

export function namespaceOf(state: HgState): string {
  return instanceNameOf(state.profileName, state.profiles?.find((p) => p.name === state.profileName)?.runtime ?? "hermes");
}
export function appNameOf(state: HgState): string {
  return namespaceOf(state);
}

// ---------------------------------------------------------------------------
// Per-profile env overlay - the local mirror of the bootstrap's
// `pulumi config set --secret --path 'agentSecrets.<name>.<VAR>'` channel.
// hermes-gitops.test.yaml `secrets:` holds the COMMITTED local-dev
// defaults; the overlay holds the operator's own values (real API keys,
// personal tokens) in UNCOMMITTED dotenv files, merged on top when the
// env Secret is applied. Merge order per profile (later wins):
//   1. <onboard-root>/.env - catalogue-shared values (fleet defaults)
//   2. <profile dir>/.env if present, else the CLI's own store
//      $HG_HOME/env/<profileName>.env (what `hg envfile set` creates)
//   3. the path pinned by `hg envfile use <path>` (applies to every profile)
// Values never print - `hg envfile list` shows names and sources only.
// ---------------------------------------------------------------------------

/** The per-profile WRITE target for `hg envfile set/unset`. */
export function envOverlayFile(state: HgState, ctx: ProfileCtx): string {
  if (state.envFile) return state.envFile;
  const profileDotenv = path.join(ctx.dir, ".env");
  if (fs.existsSync(profileDotenv)) return profileDotenv;
  return path.join(HG_HOME, "env", `${ctx.name}.env`);
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length).trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

function readDotenvIf(file: string): Record<string, string> {
  return fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
}

export function loadEnvOverlay(state: HgState, ctx: ProfileCtx): Record<string, string> {
  const isCatalogue = Boolean(state.profiles?.length && ctx.subdir);
  const perProfile = fs.existsSync(path.join(ctx.dir, ".env"))
    ? path.join(ctx.dir, ".env")
    : path.join(HG_HOME, "env", `${ctx.name}.env`);
  return {
    ...(isCatalogue ? readDotenvIf(path.join(state.profileDir, ".env")) : {}),
    ...readDotenvIf(perProfile),
    ...(state.envFile ? readDotenvIf(state.envFile) : {}),
  };
}

export function saveEnvOverlay(
  state: HgState,
  ctx: ProfileCtx,
  overlay: Record<string, string>,
): void {
  const file = envOverlayFile(state, ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Object.keys(overlay)
    .sort()
    .map((k) => `${k}=${overlay[k]}`)
    .join("\n");
  fs.writeFileSync(file, body ? `${body}\n` : "", { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// hermes-gitops.test.yaml - the profile's versioned test config (§27).
// ---------------------------------------------------------------------------

export interface SmokeCheck {
  service: string;
  port: number;
  path: string;
  expect_contains: string;
}

export interface TestConfig {
  version: number;
  appValues: Record<string, unknown>;
  secrets: Record<string, string>;
  smoke: SmokeCheck[];
  behavioral: unknown[];
  pyeval: string | null;
  reset: {
    delete_pvcs: string[];
    wipe_namespaces: string[];
    preserve: string[];
    script: string | null;
  };
  mcpsDeclared: boolean;
}

const TEST_CONFIG_KEYS = [
  "version",
  "profile",
  "appValues",
  "secrets",
  "agents",
  "smoke",
  "behavioral",
  "pyeval",
  "reset",
];
const RESET_KEYS = ["delete_pvcs", "wipe_namespaces", "preserve", "script"];

export function loadTestConfig(profileDir: string): TestConfig {
  const defaults: TestConfig = {
    version: 1,
    appValues: {},
    secrets: {},
    smoke: [],
    behavioral: [],
    pyeval: null,
    reset: { delete_pvcs: [], wipe_namespaces: [], preserve: [], script: null },
    mcpsDeclared: false,
  };
  const layout = agentLayout(profileDir);
  const file = layout.testFile;
  // The agent-team test.yaml carries apiVersion + kind (ADR 0178); the
  // legacy file never did and still refuses them.
  const allowedKeys = layout.legacy ? TEST_CONFIG_KEYS : ["apiVersion", "kind", ...TEST_CONFIG_KEYS];
  if (!fs.existsSync(file)) return defaults;
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
  if (raw === null || raw === undefined) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError(`${file} must be a YAML mapping`);
  }
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) {
      throw new CliError(
        `${file}: unknown key ${JSON.stringify(key)} (allowed: ${allowedKeys.join(", ")})`,
      );
    }
  }
  const cfg = { ...defaults };
  if (raw["appValues"]) cfg.appValues = raw["appValues"] as Record<string, unknown>;
  if (raw["secrets"]) cfg.secrets = raw["secrets"] as Record<string, string>;
  if (raw["pyeval"]) cfg.pyeval = String(raw["pyeval"]);
  if (Array.isArray(raw["behavioral"])) cfg.behavioral = raw["behavioral"] as unknown[];
  if (Array.isArray(raw["smoke"])) {
    cfg.smoke = (raw["smoke"] as Record<string, unknown>[]).map((entry, i) => {
      for (const field of ["service", "port", "path", "expect_contains"]) {
        if (entry[field] === undefined) {
          throw new CliError(
            `${file}: smoke[${i}].${field} is required ` +
              "(entries are {service, port, path, expect_contains})",
          );
        }
      }
      return {
        service: String(entry["service"]),
        port: Number(entry["port"]),
        path: String(entry["path"]),
        expect_contains: String(entry["expect_contains"]),
      };
    });
  }
  const reset = raw["reset"] as Record<string, unknown> | undefined;
  if (reset) {
    for (const key of Object.keys(reset)) {
      if (!RESET_KEYS.includes(key)) {
        throw new CliError(
          `${file}: reset.${key} is not recognized (allowed: ${RESET_KEYS.join(", ")})`,
        );
      }
    }
    cfg.reset = {
      delete_pvcs: (reset["delete_pvcs"] as string[]) ?? [],
      wipe_namespaces: (reset["wipe_namespaces"] as string[]) ?? [],
      preserve: (reset["preserve"] as string[]) ?? [],
      script: reset["script"] ? String(reset["script"]) : null,
    };
  }
  // Mock MCP serving is not implemented yet - declaring one must fail
  // loudly rather than silently test nothing (repo rule: loud beats
  // silent). Detection: any agents.<name>.mcps block.
  const agents = raw["agents"] as Record<string, Record<string, unknown>> | undefined;
  if (agents) {
    for (const [agentName, spec] of Object.entries(agents)) {
      if (spec && typeof spec === "object" && (spec as Record<string, unknown>)["mcps"]) {
        throw new CliError(
          `${file}: agents.${agentName}.mcps declares mock MCPs, which this CLI ` +
            "does not serve yet - remove the block or run against real MCPs " +
            "(see _docs/wiki/reference/cli/index.md, Scope and caveats)",
        );
      }
    }
  }
  return cfg;
}

/** Deep-merge b onto a (mappings merge, everything else replaced) - the
 * same semantics as the platform's appValues chain. */
export function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key];
    if (
      prev !== null &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
