// Agent inputs and content-only commits (ADR 0198).
//
// A team source can be both the code an agent is built from and the content store the agents
// commit to. Content reaches a running agent through its tracked workspace (ADR 0197), never
// through a rollout, so a commit that changes only content must not restart pods or pay for
// acceptance again.
//
// The decision is made from what a deployment is actually built from, per source:
//   - the agent-inputs digest below covers everything the pod's build and Argo CD fetch BY
//     COMMIT from the source repository (the agent subdirectory, what its code reaches outside
//     it, the declarations, the charts), plus the plan and the platform revision;
//   - everything the compiler reads is covered a second time, by construction: a carried
//     source still compiles from the NEW tree, only labelled with the commit already deployed,
//     so any rendered difference changes the projection fingerprint and therefore the stage
//     input, and the run proceeds.
// A source whose digest is unchanged keeps the commit its workload already declares (the
// effective commit). A resume whose recomputed stage input equals the last complete run's is
// then a no-op: the new commit is recorded as applied, with its reason, and nothing rolls.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import versions from "../../../versions.json";
import { PLATFORM_ROOT } from "../lib.ts";
import { digest, type TeamPlan, type TeamSource } from "./plan.ts";
import type { InstallationLock } from "./lock.ts";
import type { ResolvedSource } from "./compiler.ts";
import { executeStages, readLedger, saveLedger, type Ledger, type Stage, type StageOperation } from "./ledger.ts";

/** Bumped whenever the input rules change: a recorded digest from other rules never matches. */
export const AGENT_INPUTS_VERSION = "agent-inputs/v1";

/** Repository-root declaration trees the platform reads, included whenever present. */
export const DECLARATION_ROOTS = ["harness-hg", "environment", "dashboard", "topologies", "schemas", "charts"] as const;
/** Files that change how a directory's code installs, builds or checks out, included from every
 * ancestor directory of an input (the repository root included). */
export const ANCESTOR_MANIFESTS = [".gitattributes", ".gitmodules", ".npmrc", ".nvmrc", ".node-version", "bunfig.toml", "jsconfig.json",
  "npm-shrinkwrap.json", "package-lock.json", "package.json", "pnpm-workspace.yaml", "tsconfig.json", ".yarnrc.yml"] as const;
/** Files scanned for relative specifiers and relative path literals. */
const SCANNED = /\.(?:[cm]?[jt]sx?|json)$/;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".node"];

export interface PlatformIdentity { revision: string; changes: string; versions: string }
export interface AgentInputs { digest: string; paths: string[]; notes: string[] }
type Entry = { mode: string; type: string; oid: string };

const sha = /^[a-f0-9]{40}$/, sha256 = /^[a-f0-9]{64}$/;
const git = (root: string, args: string[], input?: string): Buffer =>
  execFileSync("git", ["-C", root, ...args], { input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/** The platform this hg runs from: its commit, a digest of any uncommitted tracked change and the
 * version pins. Throws when the platform is not a Git checkout - no identity, no skip. */
export function platformIdentity(root: string = PLATFORM_ROOT): PlatformIdentity {
  const revision = git(root, ["rev-parse", "HEAD"]).toString().trim();
  if (!sha.test(revision)) throw new Error(`platform checkout ${root} has no resolvable commit`);
  const changes = git(root, ["diff", "--binary", "HEAD"]);
  return { revision, changes: changes.length ? digest(changes.toString("base64")) : "", versions: digest(versions) };
}

function listTree(root: string, commit: string): Map<string, Entry> {
  if (!sha.test(commit)) throw new Error(`${commit} is not a full commit`);
  const entries = new Map<string, Entry>();
  for (const record of git(root, ["ls-tree", "-r", "-z", "--full-tree", commit]).toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), { mode: mode!, type: type!, oid: oid! });
  }
  return entries;
}

function readBlobs(root: string, oids: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const unique = [...new Set(oids)];
  if (!unique.length) return out;
  const raw = git(root, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  let at = 0;
  for (let i = 0; i < unique.length; i++) {
    const newline = raw.indexOf(0x0a, at);
    const [oid, type, size] = raw.subarray(at, newline).toString("utf8").split(" ");
    if (type === "missing" || size === undefined) throw new Error(`object ${oid} is missing from the source clone`);
    const start = newline + 1, end = start + Number(size);
    out.set(oid!, raw.subarray(start, end));
    at = end + 1;
  }
  return out;
}

const ancestors = (file: string): string[] => {
  const dirs = [""];
  const parts = file.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
};
const within = (file: string, dir: string): boolean => dir === "" || file === dir || file.startsWith(`${dir}/`);

/** Every repository-relative path literal a file names: module specifiers (`import`, `export
 * from`, dynamic `import()`, `require()`), `new URL(..., import.meta.url)`, path strings handed to
 * fs calls, and `file:`/`link:` dependency specifiers. A superset by design - a literal that is
 * not really a path only ever adds an input. */
export function relativeLiterals(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(["'`])(\.{1,2}\/[^"'`\r\n]*?)\1/g)) found.push(match[2]!);
  for (const match of text.matchAll(/(["'`])(?:file|link|portal):([^"'`\r\n]+?)\1/g)) found.push(match[2]!);
  return found;
}

/** The digest of one source's agent inputs at one commit. Deterministic: the same commit, plan and
 * platform always give the same digest, and only tracked content contributes. Throws when an
 * input cannot be established (a missing commit, a path that leaves the repository) - the caller
 * turns that into a full run, never a skip. */
export function agentInputs(root: string, commit: string, source: TeamSource, context: { plan: TeamPlan; lock?: InstallationLock; platform: PlatformIdentity; bootstrapRoot?: string }): AgentInputs {
  const entries = listTree(root, commit);
  const dirsOfBlobs = new Set<string>();
  for (const file of entries.keys()) for (const dir of ancestors(file)) dirsOfBlobs.add(dir);
  const dirs = new Set<string>(), files = new Set<string>(), notes: string[] = [];
  const inDirs = (file: string) => [...dirs].some(dir => within(file, dir));
  const included = (file: string) => files.has(file) || inDirs(file);
  const scanQueue: string[] = [];
  const scannable = (file: string) => SCANNED.test(file) || entries.get(file)?.mode === "120000";
  const addDir = (dir: string) => {
    if (inDirs(dir)) return;
    dirs.add(dir);
    for (const file of entries.keys()) if (within(file, dir) && scannable(file)) scanQueue.push(file);
  };
  const addFile = (file: string) => {
    if (included(file)) return;
    files.add(file);
    if (scannable(file)) scanQueue.push(file);
  };
  /** A resolved path: an exact blob, a module resolution of it, a directory, or - when nothing
   * exists there - its nearest existing ancestor, so whatever appears later changes the digest. */
  const include = (from: string, target: string, literal: string) => {
    if (target === ".." || target.startsWith("../")) throw new Error(`${from} names ${literal}, which leaves the repository`);
    const clean = target === "." ? "" : target.replace(/\/$/, "");
    const candidates = [clean, ...RESOLVE_EXTENSIONS.map(ext => `${clean}${ext}`), ...RESOLVE_EXTENSIONS.map(ext => `${clean}/index${ext}`),
      ...(/\.[cm]?js$/.test(clean) ? [".ts", ".tsx", ".mts", ".cts"].map(ext => clean.replace(/\.[cm]?js$/, ext)) : [])];
    const blob = candidates.find(candidate => candidate && entries.has(candidate));
    if (blob !== undefined) return addFile(blob);
    if (dirsOfBlobs.has(clean)) return addDir(clean);
    const nearest = ancestors(`${clean}/x`).reverse().find(dir => dirsOfBlobs.has(dir)) ?? "";
    if (inDirs(nearest)) return; // already an input: whatever appears there changes the digest
    notes.push(`${from} names ${literal}, which does not exist; ${nearest || "the whole repository"} is an input instead`);
    addDir(nearest);
  };

  for (const root of DECLARATION_ROOTS) addDir(root);
  for (const agent of source.agents) {
    addDir(agent.subdir);
    addDir(path.posix.join(path.posix.dirname(agent.subdir), "harness-hg"));
  }
  // Charts the team's apps name by repository path (an OCI chart name matches nothing here).
  const apps = entries.get("harness-hg/apps.yaml");
  if (apps) {
    const charts: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        if (key === "chart" && typeof child === "string") charts.push(child); else walk(child);
      }
    };
    walk(parse(readBlobs(root, [apps.oid]).get(apps.oid)!.toString("utf8")));
    for (const chart of charts) {
      const clean = path.posix.normalize(chart).replace(/\/$/, "");
      if (clean.startsWith("..") || path.posix.isAbsolute(clean)) continue;
      if (entries.has(clean)) addFile(clean); else if (dirsOfBlobs.has(clean)) addDir(clean);
    }
  }
  // The transitive closure of what input code names outside itself.
  const scanned = new Set<string>();
  while (scanQueue.length) {
    const batch = [...new Set(scanQueue.splice(0))].filter(file => !scanned.has(file) && entries.has(file));
    batch.forEach(file => scanned.add(file));
    const blobs = readBlobs(root, batch.map(file => entries.get(file)!.oid));
    for (const file of batch) {
      const entry = entries.get(file)!, text = blobs.get(entry.oid)!.toString("utf8");
      const literals = entry.mode === "120000" ? [text] : relativeLiterals(text);
      for (const literal of literals) {
        const bare = entry.mode === "120000" ? literal : literal.split(/[?#]/)[0]!;
        if (entry.mode === "120000" && path.posix.isAbsolute(bare)) throw new Error(`${file} is a symbolic link to an absolute path`);
        include(file, path.posix.normalize(path.posix.join(path.posix.dirname(file), bare)), literal);
      }
    }
  }
  const selected = [...entries.keys()].filter(included);
  for (const file of selected) for (const dir of ancestors(file)) {
    for (const name of ANCESTOR_MANIFESTS) {
      const manifest = dir ? `${dir}/${name}` : name;
      if (entries.has(manifest)) files.add(manifest);
    }
  }
  const inputs = [...entries.entries()].filter(([file]) => included(file)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Refs are not artifacts: what a ref renders into is caught by the projection. Commits in the
  // lock are exactly what this digest judges, so they are left out of it too.
  const plan = { ...context.plan, sources: context.plan.sources.map(s => ({ ...s, ref: null })) };
  const lock = context.lock && { ...context.lock, sources: Object.fromEntries(Object.keys(context.lock.sources).sort().map(id => [id, null])) };
  const bootstrap = context.bootstrapRoot ? bootstrapFiles(context.plan, context.bootstrapRoot) : [];
  return {
    digest: digest({ version: AGENT_INPUTS_VERSION, source: source.id, plan, lock: lock ?? null, platform: context.platform, bootstrap,
      files: inputs.map(([file, entry]) => [file, entry.mode, entry.oid]) }),
    paths: inputs.map(([file]) => file), notes,
  };
}

/** The bootstrap-side files a plan names, by content. A missing file is recorded as missing. */
export function bootstrapFiles(plan: TeamPlan, root: string): [string, string | null][] {
  const named = [plan.environment, plan.workloadEndpoints, plan.credentials?.configFile, ...(plan.integrations ?? []).map(i => i.configFile),
    ...plan.sources.map(s => s.skillPolicy?.approvals)].filter((file): file is string => Boolean(file));
  return [...new Set(named)].sort().map(file => {
    const full = path.resolve(root, file);
    return [file, fs.existsSync(full) && fs.statSync(full).isFile() ? digest(fs.readFileSync(full).toString("base64")) : null];
  });
}

// ---------------------------------------------------------------------------
// The recorded state and the decision.

/** What the destination declares per source, recorded whenever a run's publication stands. */
export interface AppliedSource {
  /** The commit the source's ref named. */
  desiredSha: string;
  /** The commit the deployment declares (records, pod labels, EVE_DIST_SHA). Equal to desiredSha
   * after a rollout; an earlier commit when no agent input changed since it. */
  effectiveSha: string;
  /** The agent-inputs digest, identical at desiredSha and effectiveSha. */
  inputs: string;
  /** Why desiredSha is applied without a rollout. */
  reason?: string;
}
export interface AppliedRecord { input: string; credentials: string; recordedAt: string; sources: Record<string, AppliedSource> }
export interface SourceDecision { id: string; desiredSha: string; effectiveSha: string; inputs?: string; carried: boolean; reason: string }

/** A recorded state, or undefined when it is absent or does not have exactly the recorded shape. */
export function readApplied(value: unknown): AppliedRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as AppliedRecord;
  if (typeof record.input !== "string" || !sha256.test(record.input) || typeof record.credentials !== "string" || !sha256.test(record.credentials)) return undefined;
  if (typeof record.recordedAt !== "string" || !record.sources || typeof record.sources !== "object" || Array.isArray(record.sources)) return undefined;
  for (const entry of Object.values(record.sources)) {
    if (!entry || typeof entry !== "object" || !sha.test(String(entry.desiredSha)) || !sha.test(String(entry.effectiveSha)) || !sha256.test(String(entry.inputs))) return undefined;
    if (entry.reason !== undefined && typeof entry.reason !== "string") return undefined;
  }
  return record;
}

const short = (commit: string) => commit.slice(0, 12);
export const noInputChangeReason = (effectiveSha: string) => `no agent input changed since ${short(effectiveSha)}`;

/** One source's decision: carry the deployed commit forward only when its recorded digest matches
 * this commit's, the digest could be computed, and the deployed commit is still in this commit's
 * history (a rewritten history is a rollout: the build container must be able to fetch it). */
export function decideSource(resolved: ResolvedSource, applied: AppliedRecord | undefined, computed: { inputs: string } | { error: string }, reachable: (from: string) => boolean): SourceDecision {
  const id = resolved.definition.id, desiredSha = resolved.sha;
  const full = (reason: string, inputs?: string): SourceDecision => ({ id, desiredSha, effectiveSha: desiredSha, ...(inputs ? { inputs } : {}), carried: false, reason });
  if ("error" in computed) return full(`agent inputs could not be computed (${computed.error}); a full run at ${short(desiredSha)}`);
  const entry = applied?.sources[id];
  if (!entry) return full(`no agent inputs are recorded for this source; a full run at ${short(desiredSha)}`, computed.inputs);
  if (entry.inputs !== computed.inputs) return full(`agent inputs changed since ${short(entry.effectiveSha)}; a full run at ${short(desiredSha)}`, computed.inputs);
  if (entry.effectiveSha === desiredSha) return full(`${short(desiredSha)} is the deployed commit`, computed.inputs);
  if (!reachable(entry.effectiveSha)) return full(`the deployed commit ${short(entry.effectiveSha)} is not in the history of ${short(desiredSha)}; a full run`, computed.inputs);
  return { id, desiredSha, effectiveSha: entry.effectiveSha, inputs: computed.inputs, carried: true, reason: noInputChangeReason(entry.effectiveSha) };
}

/** Resolve every source's effective commit. A source that carries keeps its new tree (so the
 * compiler still judges it) under the commit its workload already declares. */
export function carryForward(plan: TeamPlan, sources: ResolvedSource[], appliedValue: unknown, context: { lock?: InstallationLock; bootstrapRoot?: string; platform?: () => PlatformIdentity; log?: (line: string) => void } = {}): { sources: ResolvedSource[]; decisions: SourceDecision[] } {
  const log = context.log ?? (() => {});
  const applied = readApplied(appliedValue);
  if (appliedValue !== undefined && !applied) log("the recorded agent inputs are unreadable; every source runs in full");
  let platform: PlatformIdentity | { error: string };
  try { platform = (context.platform ?? platformIdentity)(); }
  catch (error) { platform = { error: `platform identity: ${error instanceof Error ? error.message : String(error)}` }; }
  const decisions: SourceDecision[] = [];
  const carried = sources.map(resolved => {
    let computed: { inputs: string } | { error: string };
    if ("error" in platform) computed = platform;
    else {
      try {
        const result = agentInputs(resolved.root, resolved.sha, resolved.definition, { plan, lock: context.lock, platform, bootstrapRoot: context.bootstrapRoot });
        for (const note of result.notes) log(`source ${resolved.definition.id}: ${note}`);
        computed = { inputs: result.digest };
      } catch (error) { computed = { error: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : String(error) }; }
    }
    const reachable = (from: string) => {
      try { git(resolved.root, ["merge-base", "--is-ancestor", from, resolved.sha]); return true; } catch { return false; }
    };
    const decision = decideSource(resolved, applied, computed, reachable);
    decisions.push(decision);
    log(`source ${decision.id}: ${decision.reason}`);
    return decision.carried ? { ...resolved, sha: decision.effectiveSha } : resolved;
  });
  return { sources: carried, decisions };
}

/** Why a resume has nothing to do, or undefined. Every condition is required: the last run
 * completed, at exactly this stage input and these credentials, and at least one source moved
 * to a commit whose agent inputs are the deployed ones. A resume with nothing carried keeps
 * today's behaviour - it re-observes and re-verifies. */
export function skipReason(prior: Partial<Ledger> | undefined, input: string, credentials: string, decisions: SourceDecision[]): string | undefined {
  if (!prior || prior.complete !== true || prior.input !== input) return undefined;
  const applied = readApplied(prior.applied);
  if (!applied || applied.input !== input || applied.credentials !== credentials) return undefined;
  const carried = decisions.filter(d => d.carried);
  if (!carried.length) return undefined;
  return carried.map(d => `source ${d.id} ${short(d.desiredSha)}: ${d.reason}`).join("; ");
}

/** Record what the destination now declares per source. Sources without a digest are left out,
 * so their next run is a full one. */
export function recordApplied(ledger: Ledger, input: string, credentials: string, decisions: SourceDecision[], at: string = new Date().toISOString()): void {
  ledger.applied = { input, credentials, recordedAt: at, sources: Object.fromEntries(decisions.filter(d => d.inputs).map(d => [d.id, {
    desiredSha: d.desiredSha, effectiveSha: d.effectiveSha, inputs: d.inputs!, ...(d.carried ? { reason: d.reason } : {}) }])) };
}

/** Resume's tail: skip when nothing an agent is built from changed, otherwise run the stages as
 * before. The stage machine is never entered on a skip, so nothing provisions, publishes, rolls
 * or runs acceptance. */
export async function runOrSkip(options: { ledgerFile: string; installation: string; input: string; credentials: string; prior?: Partial<Ledger>;
  decisions: SourceDecision[]; operations: Record<Stage, StageOperation>; allowSkip: boolean; report?: (stage: Stage) => void; now?: () => string }): Promise<{ ledger: Ledger; skipped?: string }> {
  const now = options.now ?? (() => new Date().toISOString());
  const reason = options.allowSkip ? skipReason(options.prior, options.input, options.credentials, options.decisions) : undefined;
  if (reason) {
    const ledger = { ...(options.prior as Ledger), complete: true, running: undefined, updatedAt: now() };
    recordApplied(ledger, options.input, options.credentials, options.decisions, ledger.updatedAt);
    ledger.skipped = { reason, at: ledger.updatedAt };
    saveLedger(options.ledgerFile, ledger);
    return { ledger, skipped: reason };
  }
  const ledger = await executeStages(options.ledgerFile, readLedger(options.ledgerFile, options.installation, options.input), options.operations, options.report);
  // The destination declares these commits once publication stands at this input, whether or not
  // later stages completed: that is what the next run carries forward from.
  const published = ledger.stages.published;
  if (published?.verdict === "pass" && published.input === options.input) recordApplied(ledger, options.input, options.credentials, options.decisions, now());
  ledger.skipped = undefined;
  saveLedger(options.ledgerFile, ledger);
  return { ledger };
}
