// hg reconcile (#271, ADR-54): production GitOps reconciliation on the
// destination host. A systemd user timer fires `hg reconcile run` about
// once a minute; that one command is the whole reconciler - poll the
// deployment repository, and only when the desired commit changes (or an
// operator forces it) check out the EXACT commit, run the configured
// checks, run the configured apply, wait for Argo CD, and rewrite the
// ledger plus the in-cluster status record.
//
// The load-bearing choices, each deliberately the shortest one that
// holds:
//   - Serialization is flock(1). The kernel releases an flock when its
//     process dies, so there is no stale-lock protocol to write. Crash
//     recovery is LEDGER repair, not lock repair.
//   - The retry gate is one field. A failed commit is never re-attempted
//     until the desired SHA changes or an operator runs `retry` -
//     stronger than backoff, and one field shorter.
//   - checks/apply are host CONFIG, never read from the cloned repo -
//     the same trust posture as repoScriptsAllowed, and the reason this
//     can process repo-supplied content unattended at 3am.
//   - The credential reaches git through a 0600 credential-store file.
//     It never appears in argv, env dumps, unit files, logs, the ledger,
//     or the published record - and RECON004 re-checks that with
//     secretScan rather than trusting this comment.

import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, log, ok, parseDotenv, toRfc3339, writeJsonAtomic } from "../lib.ts";
import { parse as parseYaml } from "yaml";
import { SECRET_PATTERNS } from "../nexus/prove.ts";
import { loadPlan, secretEnvironmentNames } from "../team/plan.ts";
import { unsetMarkerFindings } from "../team/delivery.ts";
import { deriveBackend } from "../team/backend.ts";
import * as os from "node:os";

// Paths are RESOLVED PER CALL, not bound at import: bun runs the whole
// test suite in one process, so a module-level const would freeze
// whichever HERMES_GITOPS_HOME was set when the FIRST test file imported
// lib.ts - which is exactly how this module's own tests once wrote a
// ledger into the operator's real home.
function hgHome(): string {
  return process.env["HERMES_GITOPS_HOME"] ?? path.join(os.homedir(), ".hermes-gitops");
}
let selectedInstance: string | undefined;
export function selectInstance(value?: string): void {
  if (value !== undefined && !/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value)) {
    throw new CliError("reconcile instance must start with a lowercase letter, end with a letter or digit, and contain at most 40 lowercase letters, digits or hyphens");
  }
  selectedInstance = value;
}
export const instanceName = (): string | undefined => selectedInstance;
export const unitName = (): string => `hermes-reconcile${instanceName() ? `-${instanceName()}` : ""}`;
export const statusName = (): string => `hermes-reconciliation-status${instanceName() ? `-${instanceName()}` : ""}`;
export const reconcileDir = (): string => instanceName()
  ? path.join(hgHome(), "reconcile", "instances", instanceName()!)
  : path.join(hgHome(), "reconcile");
export const configFile = (): string => path.join(reconcileDir(), "config.json");
export const ledgerFile = (): string => path.join(reconcileDir(), "state.json");
// Keep the old lock path so old and new timers cannot overlap a shared stack apply.
export const lockFile = (): string => path.join(hgHome(), "reconcile", "lock");
export const checkoutDir = (): string => path.join(reconcileDir(), "checkout");
export const logsDir = (): string => path.join(reconcileDir(), "logs");
/** The platform revisions this watcher runs from (ADR 0193): one bare clone, one worktree per
 * revision in use. Kept beside the bootstrap checkout, never inside it. */
export const platformGitDir = (): string => path.join(reconcileDir(), "platform.git");
export const platformDir = (): string => path.join(reconcileDir(), "platform");
const credentialsFile = (): string => path.join(reconcileDir(), "git-credentials");
const HISTORY_KEEP = 10;
const LOGS_KEEP = 20;

// ---------------------------------------------------------------------------
// Shapes

export type ReconcileState =
  | "synced"
  | "change-detected"
  | "validating"
  | "applying"
  | "waiting-for-argocd"
  | "degraded"
  | "failed"
  | "pending"
  | "authentication-required";

export interface ReconcileRun {
  sha: string;
  startedAt: string;
  finishedAt?: string;
  trigger: "timer" | "manual";
  phase: "poll" | "check" | "apply" | "argocd" | "done";
  step?: string;
  result?: "success" | "failure" | "pending";
  failure?: { phase: string; step?: string; exitCode?: number; summary: string };
  /** Why a successful apply rolled nothing out (ADR 0198): `hg team` names it as `skipped.reason`. */
  note?: string;
}

/** A team-kind tick that stopped on a decision only a human, a merge or time can supply
 * (ADR 0191): retried with capped backoff, never counted as a failure, cleared by a new commit. */
export interface ReconcilePending {
  sha: string;
  attempts: number;
  lastAt: string;
  nextAttemptAt: string;
  reason: string;
  link?: string;
  stage?: string;
}
/** What `hg team resume --unattended --json` reported on its last run; published to Nexus. */
export type TeamReport = Record<string, unknown>;

export interface ReconcileLedger {
  apiVersion: "cli.hermes.dev/v1alpha1";
  kind: "ReconcileState";
  version: string;
  repo: string; // userinfo stripped - display only
  branch: string;
  state: ReconcileState;
  observedAt: string;
  desiredSha?: string;
  attemptedSha?: string;
  /** The last commit applied SUCCESSFULLY. A failed apply never advances it. */
  appliedSha?: string;
  appliedAt?: string;
  run?: ReconcileRun;
  blocked?: { sha: string; attempts: number; lastAt: string; summary: string };
  pending?: ReconcilePending;
  report?: TeamReport;
  /** The installation a team-kind watcher watches. Recorded from the plan every tick, so a run
   * that fails before writing a report still publishes an attributable status. */
  installation?: string;
  history: ReconcileRun[];
}

export interface ReconcileConfig {
  version: string;
  repoUrl: string;
  branch: string;
  intervalSeconds: number;
  /** Preflights, run in order with cwd = the checkout. Any nonzero exit
   * blocks the commit BEFORE mutation. Host config, never repo content. */
  checks: string[];
  /** The one mutation command. Configuration, not a provider abstraction:
   * production is `pulumi up`, the local-loop proof is `hg up`. */
  apply: string;
  hermesHome: string;
  argocdTimeoutSec: number;
  kubeContext?: string;
  /** Where the status ConfigMap is published - the namespace Nexus runs
   * in (its reader defaults to its own). hermes-nexus in the local loop,
   * hermes-gitops in-cluster. */
  statusNamespace?: string;
  /** `command` (default) runs `checks` then `apply`. `team` (ADR 0191) watches a BOOTSTRAP
   * repository and runs `hg team resume --unattended` against `team.plan` inside the checkout;
   * checks/apply are unused. */
  kind?: "command" | "team";
  team?: { plan: string };
  /** A 0600 dotenv file the unit loads (`EnvironmentFile=`): the plan's credential names. */
  environmentFile?: string;
}
export const PENDING_BACKOFF = { baseSeconds: 120, capSeconds: 1800 };
export function pendingBackoffSeconds(attempts: number): number {
  return Math.min(PENDING_BACKOFF.capSeconds, PENDING_BACKOFF.baseSeconds * 2 ** Math.max(0, attempts - 1));
}

// ---------------------------------------------------------------------------
// Config + ledger IO

export function readConfig(): ReconcileConfig {
  if (!fs.existsSync(configFile())) {
    throw new CliError("reconcile is not installed - run: hermes-gitops reconcile install --repo <url>");
  }
  return JSON.parse(fs.readFileSync(configFile(), "utf8")) as ReconcileConfig;
}

export function writeConfig(cfg: ReconcileConfig): void {
  writeJsonAtomic(configFile(), cfg);
  fs.chmodSync(configFile(), 0o600);
}

export function emptyLedger(cfg: ReconcileConfig): ReconcileLedger {
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ReconcileState",
    version: cfg.version,
    repo: stripUserinfo(cfg.repoUrl),
    branch: cfg.branch,
    state: "change-detected",
    observedAt: new Date().toISOString(),
    history: [],
  };
}

export function readLedger(cfg: ReconcileConfig): ReconcileLedger {
  if (!fs.existsSync(ledgerFile())) return emptyLedger(cfg);
  try {
    return JSON.parse(fs.readFileSync(ledgerFile(), "utf8")) as ReconcileLedger;
  } catch {
    return emptyLedger(cfg); // a torn/hand-mangled ledger restarts clean, not crashed
  }
}

export function saveLedger(ledger: ReconcileLedger): void {
  writeJsonAtomic(ledgerFile(), ledger);
}

// ---------------------------------------------------------------------------
// Pure logic - everything the unit tests exercise without a host.

/** A run with no result means the previous process died mid-flight.
 *
 * WHERE it died decides what that means. Before the apply (poll/check/
 * apply phases): the commit's attempt failed - mark it, count it, gate
 * it, so a crash-looping commit blocks like a cleanly-failing one. But a
 * crash during the ARGO WAIT is after a SUCCESSFUL apply (appliedSha has
 * already advanced): the commit IS what runs, and blocking it would
 * freeze the reconciler on a commit that needs no retry - found live,
 * when a killed tick nearly blocked its own applied sha. That case is
 * `degraded`: the next tick re-checks convergence without re-applying. */
export function recoverLedger(ledger: ReconcileLedger): ReconcileLedger {
  const run = ledger.run;
  if (!run || run.result) return ledger;
  const finishedAt = new Date().toISOString();
  if (run.phase === "argocd" && ledger.appliedSha === run.sha) {
    const interrupted: ReconcileRun = {
      ...run,
      finishedAt,
      result: "success",
      failure: undefined,
    };
    return {
      ...ledger,
      state: "degraded",
      run: undefined,
      history: pushHistory(ledger.history, interrupted),
    };
  }
  const failed: ReconcileRun = {
    ...run,
    finishedAt,
    result: "failure",
    failure: { phase: run.phase, summary: "interrupted (process died mid-run)" },
  };
  return {
    ...ledger,
    state: "failed",
    run: undefined,
    history: pushHistory(ledger.history, failed),
    blocked: {
      sha: run.sha,
      attempts: (ledger.blocked?.sha === run.sha ? ledger.blocked.attempts : 0) + 1,
      lastAt: failed.finishedAt!,
      summary: failed.failure!.summary,
    },
  };
}

/** The whole retry policy. No backoff, no timer arithmetic: a blocked SHA
 * is never re-attempted until it CHANGES or a human says so - which is
 * stronger than backoff, and what "do not rerun the same failed commit
 * every minute forever" actually asks for. */
export function shouldApply(
  ledger: ReconcileLedger,
  desiredSha: string,
  trigger: { manual: boolean; retry: boolean },
  now: number = Date.now(),
): { act: boolean; reason: string } {
  if (trigger.retry) return { act: true, reason: "operator retry" };
  if (ledger.blocked?.sha === desiredSha) {
    return {
      act: false,
      reason:
        `commit ${desiredSha.slice(0, 12)} already failed ${ledger.blocked.attempts}x - ` +
        "push a fix or run `hg reconcile retry`",
    };
  }
  // Pending is not failure: the same commit is re-attempted on a capped backoff, sooner on
  // `sync`, and immediately once the commit changes.
  if (ledger.pending?.sha === desiredSha) {
    if (!trigger.manual && now < Date.parse(ledger.pending.nextAttemptAt)) {
      return {
        act: false,
        reason: `commit ${desiredSha.slice(0, 12)} is pending (${ledger.pending.reason}) - next attempt at ${ledger.pending.nextAttemptAt}`,
      };
    }
    return { act: true, reason: `pending commit ${desiredSha.slice(0, 12)} is due for another attempt` };
  }
  if (desiredSha !== ledger.appliedSha) return { act: true, reason: "desired commit differs from applied" };
  if (trigger.manual) return { act: true, reason: "operator sync (sha unchanged)" };
  return { act: false, reason: "already at the desired commit" };
}

function pushHistory(history: ReconcileRun[], run: ReconcileRun): ReconcileRun[] {
  return [...history, run].slice(-HISTORY_KEEP);
}

function stripUserinfo(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

/** Redact everything credential-shaped: the literal token, URL userinfo,
 * and every SECRET_PATTERNS match. Applied to ANY text that leaves the
 * full log file - ledger summaries and the published record both ride
 * through here, and RECON004 re-scans the result instead of trusting it. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("«redacted»");
  }
  out = out.replace(/(https?:\/\/)[^@/\s]+@/g, "$1«redacted»@");
  for (const [, re] of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "«redacted»");
  }
  return out;
}

/** Scrub -> last lines -> hard cap. What reaches the ledger and the
 * overlay; the full output stays in the 0600 host log. */
export function summarize(text: string, secrets: string[], maxChars = 2000): string {
  const scrubbed = scrub(text, secrets);
  const lines = scrubbed.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-20).join("\n");
  return tail.length <= maxChars ? tail : tail.slice(-maxChars);
}

/** The allowlist projection published into the cluster (the M02
 * handshake: ConfigMap hermes-reconciliation-status, schema
 * runtime-overlay/v1alpha1/reconciliation-status.schema.json). A ledger
 * field not named here does not leave the host. */
export function nexusRecord(ledger: ReconcileLedger, kind: "command" | "team" = "command"): Record<string, unknown> {
  const phase: Record<ReconcileState, string> = {
    "synced": "synced",
    "change-detected": "change-detected",
    "validating": "validating",
    "applying": "applying",
    "waiting-for-argocd": "waiting-for-argocd",
    "degraded": "degraded",
    "failed": "failed",
    "pending": "pending",
    "authentication-required": "authentication-required",
  };
  // A command-kind watcher keeps the v1alpha1 record (no pending, no report); a team-kind
  // watcher publishes v1alpha2 with the installation's per-source and per-agent facts.
  const out: Record<string, unknown> = {
    apiVersion: kind === "team" ? "nexus.hermes.ai/v1alpha2" : "nexus.hermes.ai/v1alpha1",
    kind: "ReconciliationStatus",
    observedAt: toRfc3339(ledger.observedAt),
    phase: phase[ledger.state],
    retryable: ledger.state === "failed",
    version: ledger.version,
  };
  if (kind === "team") {
    const report = ledger.report ?? {};
    const label = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    // The report names it when there is one; the ledger names it even when the run failed
    // before writing one. An anonymous failed watcher is one nobody can attribute.
    const installation = typeof report["installation"] === "string" ? report["installation"] : ledger.installation;
    if (typeof installation === "string" && label.test(installation)) out["installation"] = installation;
    if (typeof report["stage"] === "string" && /^[a-z-]{1,40}$/.test(report["stage"])) out["stage"] = report["stage"];
    if (ledger.pending) {
      out["pending"] = {
        reason: ledger.pending.reason,
        ...(ledger.pending.link && /^https:\/\/[^\s@]+$/.test(ledger.pending.link) ? { link: ledger.pending.link } : {}),
        since: toRfc3339(ledger.pending.lastAt),
        nextAttemptAt: toRfc3339(ledger.pending.nextAttemptAt),
      };
    }
    const sources = Array.isArray(report["sources"]) ? report["sources"] : [];
    out["sources"] = sources.filter((s: any) => s && label.test(String(s.id))).map((s: any) => ({
      id: s.id, ...(typeof s.ref === "string" ? { ref: String(s.ref).slice(0, 200) } : {}),
      ...(isSha(s.desiredSha) ? { desiredSha: s.desiredSha } : {}), ...(isSha(s.appliedSha) ? { appliedSha: s.appliedSha } : {}),
    }));
    const agents = Array.isArray(report["agents"]) ? report["agents"] : [];
    out["agents"] = agents.filter((a: any) => a && label.test(String(a.name))).map((a: any) => ({
      name: a.name, ...(label.test(String(a.source)) ? { source: a.source } : {}),
      ...(isSha(a.desiredSha) ? { desiredSha: a.desiredSha } : {}), ...(isSha(a.appliedSha) ? { appliedSha: a.appliedSha } : {}),
      ...(typeof a.runtimeDigest === "string" && /^\S{1,300}$/.test(a.runtimeDigest) ? { runtimeDigest: a.runtimeDigest } : {}),
      ...(typeof a.eveVersion === "string" && /^[A-Za-z0-9.+-]{1,40}$/.test(a.eveVersion) ? { eveVersion: a.eveVersion } : {}),
      ...(typeof a.ready === "boolean" ? { ready: a.ready } : {}),
    }));
  }
  if (isSha(ledger.desiredSha)) out["desiredSha"] = ledger.desiredSha;
  if (isSha(ledger.attemptedSha)) out["attemptedSha"] = ledger.attemptedSha;
  if (isSha(ledger.appliedSha)) out["appliedSha"] = ledger.appliedSha;
  if (ledger.appliedAt) out["appliedAt"] = toRfc3339(ledger.appliedAt);
  if (ledger.run?.startedAt) out["startedAt"] = toRfc3339(ledger.run.startedAt);
  if (ledger.run?.finishedAt) out["finishedAt"] = toRfc3339(ledger.run.finishedAt);
  if (ledger.blocked) {
    out["attempts"] = ledger.blocked.attempts;
    out["summary"] = ledger.blocked.summary.slice(0, 200);
  }
  return out;
}

function isSha(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
}

// ---------------------------------------------------------------------------
// The lock: flock(1) via re-exec. The kernel drops the lock when the
// process dies - crashed runs leave nothing to reap, so there is no
// stale-lock protocol at all. -E 75 distinguishes "someone else holds
// it" from the child's own failures.

export function withLock(argv: string[]): void {
  if (process.env["HG_RECONCILE_LOCK"] === "held") return;
  fs.mkdirSync(reconcileDir(), { recursive: true });
  const proc = Bun.spawnSync(
    ["flock", "-n", "-E", "75", lockFile(), process.execPath, ...argv],
    {
      env: { ...process.env, HG_RECONCILE_LOCK: "held" },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    },
  );
  if (proc.exitCode === 75) {
    throw new CliError("another reconciliation is in flight (flock held) - this tick is skipped");
  }
  process.exit(proc.exitCode ?? 1);
}

// ---------------------------------------------------------------------------
// Git. The token comes from the operator host's $HERMES_HOME/.env
// (GITOPS_GIT_TOKEN - stage 1 already writes it; zero new credential
// plumbing) and reaches git ONLY through a 0600 credential-store file.

export function readToken(hermesHome: string): string | undefined {
  const envFile = path.join(hermesHome, ".env");
  if (!fs.existsSync(envFile)) return undefined;
  return parseDotenv(fs.readFileSync(envFile, "utf8"))["GITOPS_GIT_TOKEN"];
}

/** The plan's credential names for a team-kind tick: a 0600 dotenv file (`EnvironmentFile=`).
 * Values are handed to the child by name and scrubbed from everything that leaves the host. */
export function readEnvironmentFile(file: string | undefined): Record<string, string> {
  if (!file || !fs.existsSync(file)) return {};
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new CliError(`environment file ${file} has mode ${mode.toString(8)} (want 600) - it carries credentials`);
  return parseDotenv(fs.readFileSync(file, "utf8"));
}

/** The bootstrap directory named by a plan: where the team tick runs `bun install` before the
 * installed hg validates the rest. Parsed, not pattern-matched - a plan written as a flow
 * mapping is the same document, and a launcher that reads it differently from the parser the
 * rest of the system uses would run in the wrong place, or refuse a valid plan. */
export function planBootstrapDirectory(planFile: string): string {
  const bootstrap = document(planFile)["bootstrap"];
  const dir = bootstrap && typeof bootstrap === "object" && !Array.isArray(bootstrap)
    ? (bootstrap as Record<string, unknown>)["directory"] : undefined;
  if (typeof dir !== "string" || !dir || path.isAbsolute(dir) || dir.split(/[\\/]/).some((p) => p === "..")) {
    throw new CliError(`${planFile}: bootstrap.directory must be a relative path inside the checkout`);
  }
  return dir;
}

/** The lock a plan names and the platform it declares, read with the real YAML parser but
 * WITHOUT the plan's schema: a launcher at an older revision must understand a newer plan, and
 * must never disagree with the parser the rest of the system uses about whether a platform is
 * declared at all. Only these fields are read; everything else is ignored. */
function document(file: string): Record<string, unknown> {
  const parsed = parseYaml(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CliError(`${file}: expected a YAML mapping`);
  return parsed as Record<string, unknown>;
}
/** A checkout-relative file that is really inside the checkout: no absolute path, no `..`, and
 * no symlink anywhere on the way - the same boundary `lockPath` enforces, applied BEFORE the
 * launcher reads anything that decides which code runs. */
export function checkoutFile(checkout: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === "..")) {
    throw new CliError(`${relative}: must be a relative path inside the checkout`);
  }
  const root = fs.realpathSync(checkout), target = path.resolve(root, relative);
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new CliError(`${relative}: resolves outside the checkout`);
  const file = path.join(parent, path.basename(target));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new CliError(`${relative}: must not be a symbolic link`);
  return file;
}
/** The installation a plan declares, for attributing a status document. */
export function planInstallation(planFile: string): string | undefined {
  const id = document(planFile)["id"];
  return typeof id === "string" && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(id) ? id : undefined;
}
export function planLockFile(planFile: string): string | undefined {
  const value = document(planFile)["lock"];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value) throw new CliError(`${planFile}: lock must be a path`);
  return value;
}
export function planPlatform(planFile: string): { repository: string; credentialEnv?: string } | undefined {
  const value = document(planFile)["platform"];
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${planFile}: platform must be a mapping`);
  const { repository, credentialEnv } = value as Record<string, unknown>;
  // The same credential-free shapes the plan itself validates, re-checked before git sees it.
  if (typeof repository !== "string" || (!/^https:\/\/[^/@\s]+\/[^\s?#]+$/.test(repository) && !/^git@[^:\s]+:[^\s]+$/.test(repository))) {
    throw new CliError(`${planFile}: platform.repository must be a credential-free https:// or git@ URL`);
  }
  if (credentialEnv !== undefined && (typeof credentialEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(credentialEnv))) {
    throw new CliError(`${planFile}: platform.credentialEnv must be an environment name`);
  }
  return { repository, ...(typeof credentialEnv === "string" ? { credentialEnv } : {}) };
}
/** The platform revisions a lock records: what to run, and what a rollback returns to. */
export function lockPlatformRevisions(lockFile: string): { revision: string; previousRevision?: string } | undefined {
  const value = document(lockFile)["platform"];
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${lockFile}: platform must be a mapping`);
  const { revision, previousRevision } = value as Record<string, unknown>;
  const full = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v) && !/^0+$/.test(v);
  if (!full(revision)) throw new CliError(`${lockFile}: platform.revision must be a full 40-character commit`);
  if (previousRevision !== undefined && previousRevision !== null && !full(previousRevision)) throw new CliError(`${lockFile}: platform.previousRevision must be a full 40-character commit`);
  return { revision, ...(full(previousRevision) ? { previousRevision } : {}) };
}

/** Every credential name the plan needs that the plan itself cannot resolve (bootstrap config
 * inputs, managed Secret inputs and integration outputs are read at run time; the rest must be
 * in the environment). Names only. */
export function missingCredentialNames(planFile: string, env: NodeJS.ProcessEnv): string[] {
  const plan = loadPlan(planFile);
  const provided = new Set([
    ...Object.keys(plan.credentials?.inputs ?? {}),
    ...Object.keys(plan.credentials?.secretInputs ?? {}),
    ...(plan.integrations ?? []).flatMap((i) => Object.keys(i.outputs)),
  ]);
  return [...secretEnvironmentNames(plan)].filter((name) => !provided.has(name) && !env[name]).sort();
}

/** Scrub every string inside a JSON-ish value. */
export function scrubValues(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return scrub(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrubValues(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubValues(v, secrets)]));
  return value;
}

/** The last JSON document on a stream: the unattended run's report. */
export function lastJsonDocument(stdout: string): Record<string, unknown> | undefined {
  const start = stdout.lastIndexOf("\n{");
  const candidate = start >= 0 ? stdout.slice(start + 1) : stdout.trim().startsWith("{") ? stdout.trim() : "";
  try {
    const doc = JSON.parse(candidate) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Why an apply changed nothing that deploys, when the apply was `hg team` and said so (ADR 0198):
 * the new commit is still applied, and the host ledger records the reason beside it. */
export function skippedNote(stdout: string, secrets: string[]): string | undefined {
  const skipped = lastJsonDocument(stdout)?.["skipped"];
  const reason = skipped && typeof skipped === "object" ? (skipped as Record<string, unknown>)["reason"] : undefined;
  return typeof reason === "string" && reason ? scrub(reason, secrets).slice(0, 500) : undefined;
}

export function gitArgs(cfg: ReconcileConfig, token: string | undefined, sub: string[]): string[] {
  const base = ["git"];
  if (token && cfg.repoUrl.startsWith("http")) {
    base.push("-c", `credential.helper=store --file=${credentialsFile()}`);
  }
  return [...base, ...sub];
}

function writeCredentials(cfg: ReconcileConfig, token: string): void {
  const host = new URL(cfg.repoUrl).host;
  fs.mkdirSync(reconcileDir(), { recursive: true });
  fs.writeFileSync(credentialsFile(), `https://x-access-token:${token}@${host}\n`, { mode: 0o600 });
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Exec = (argv: string[], opts?: { cwd?: string }) => ExecResult;

const realExec: Exec = (argv, opts) => {
  const proc = Bun.spawnSync(argv, {
    cwd: opts?.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0", // a bad token fails fast, never hangs a timer
      // Under systemd --user, bash -l does not reach the interactive rc
      // that puts ~/.bun/bin on PATH - so a bun-invoking check died with
      // "bun: command not found" on the FIRST real timer tick. The
      // runtime that is running this reconciler is always a valid bun;
      // its own directory rides along for every spawned command.
      PATH: `${path.dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
};

const AUTH_STDERR = /authentication|could not read Username|invalid credentials|403|401/i;

// ---------------------------------------------------------------------------
// One tick.

export interface TickDeps {
  exec?: Exec;
  /** Argo gates, injected so the state machine tests run hostless. */
  argocdReady?: () => boolean;
  argocdConverged?: (timeoutSec: number) => Promise<boolean>;
  publish?: (record: Record<string, unknown>) => void;
  /** The team-kind apply: `hg team resume --unattended --json` in the checkout. Injected so the
   * watcher's state machine is testable without a bootstrap, a cluster or Pulumi. */
  teamResume?: (checkout: string, planFile: string, env: Record<string, string>, main?: string) => ExecResult;
  now?: () => number;
}

/** Materialize the locked platform revision as a detached worktree and return its `hg` entry
 * point, installing dependencies once per revision. One bare clone serves every revision, so a
 * rollback to the previous one costs a checkout, not a clone. */
export function preparePlatformWorktree(cfg: ReconcileConfig, token: string | undefined, repository: string, revision: string,
  exec: Exec, log: (label: string, r: ExecResult) => void): { main: string; worktree: string } | ExecResult {
  const bare = platformGitDir(), worktree = path.join(platformDir(), revision);
  const ready = path.join(worktree, ".hg-platform-ready");
  if (!fs.existsSync(path.join(bare, "HEAD"))) {
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    const cloned = exec(gitArgs(cfg, token, ["clone", "--bare", "--", repository, bare]));
    log("git clone --bare (platform)", cloned);
    if (cloned.exitCode !== 0) { fs.rmSync(bare, { recursive: true, force: true }); return cloned; }
  } else {
    // A plan that moved to another platform repository must not be served from the old cache.
    const origin = exec(["git", "remote", "get-url", "origin"], { cwd: bare });
    if (origin.exitCode !== 0 || origin.stdout.trim() !== repository) {
      const repointed = exec(["git", "remote", "set-url", "origin", repository], { cwd: bare });
      log("git remote set-url (platform)", repointed);
      if (repointed.exitCode !== 0) return repointed;
      fs.rmSync(ready, { force: true }); // the revision must be proven against the new origin
    }
  }
  const present = () => exec(["git", "cat-file", "-e", `${revision}^{commit}`], { cwd: bare }).exitCode === 0;
  if (!present()) {
    // Fetch refs, not the bare sha: a server that refuses an unadvertised object still serves this.
    const fetched = exec(gitArgs(cfg, token, ["fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/heads/*"]), { cwd: bare });
    log("git fetch (platform)", fetched);
    if (fetched.exitCode !== 0) return fetched;
    if (!present()) return { exitCode: 1, stdout: "", stderr: `platform revision ${revision.slice(0, 12)} is not in ${repository}` };
  }
  // The stamp is written LAST and names the revision: a run killed mid-install leaves no stamp,
  // so the next tick rebuilds the worktree instead of executing a half-installed checkout.
  const stamped = fs.existsSync(ready) && fs.readFileSync(ready, "utf8").trim() === revision;
  if (!stamped) {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.mkdirSync(platformDir(), { recursive: true });
    exec(["git", "worktree", "prune"], { cwd: bare });
    const added = exec(["git", "worktree", "add", "--detach", "--force", worktree, revision], { cwd: bare });
    log("git worktree add (platform)", added);
    if (added.exitCode !== 0) return added;
    const head = exec(["git", "rev-parse", "HEAD"], { cwd: worktree });
    if (head.exitCode !== 0 || head.stdout.trim() !== revision) {
      fs.rmSync(worktree, { recursive: true, force: true });
      return { exitCode: 1, stdout: "", stderr: `platform worktree did not land on ${revision.slice(0, 12)}` };
    }
    const dirty = exec(["git", "status", "--porcelain"], { cwd: worktree });
    if (dirty.exitCode !== 0 || dirty.stdout.trim()) {
      fs.rmSync(worktree, { recursive: true, force: true });
      return { exitCode: 1, stdout: "", stderr: `platform worktree at ${revision.slice(0, 12)} is not a clean checkout` };
    }
    const entry = path.join(worktree, "cli", "src", "main.ts");
    if (!fs.existsSync(entry) || fs.lstatSync(entry).isSymbolicLink()) {
      fs.rmSync(worktree, { recursive: true, force: true });
      return { exitCode: 1, stdout: "", stderr: `platform revision ${revision.slice(0, 12)} has no cli/src/main.ts` };
    }
    for (const workspace of ["cli", "infra"]) {
      const installed = exec([process.execPath, "install", "--frozen-lockfile"], { cwd: path.join(worktree, workspace) });
      log(`bun install (platform ${workspace})`, installed);
      if (installed.exitCode !== 0) { fs.rmSync(worktree, { recursive: true, force: true }); return installed; }
    }
    fs.writeFileSync(ready, `${revision}\n`, { mode: 0o600 });
  }
  return { main: path.join(worktree, "cli", "src", "main.ts"), worktree };
}

/** Drop every platform worktree but the ones the lock still names, so a host keeps one checkout
 * per revision IN USE rather than one per revision ever seen. */
export function prunePlatformWorktrees(keep: string[], exec: Exec): string[] {
  if (!fs.existsSync(platformDir())) return [];
  const removed: string[] = [];
  for (const entry of fs.readdirSync(platformDir())) {
    if (keep.includes(entry)) continue;
    fs.rmSync(path.join(platformDir(), entry), { recursive: true, force: true });
    removed.push(entry);
  }
  if (removed.length && fs.existsSync(path.join(platformGitDir(), "HEAD"))) exec(["git", "worktree", "prune"], { cwd: platformGitDir() });
  return removed;
}

function realTeamResume(exec: Exec): NonNullable<TickDeps["teamResume"]> {
  return (checkout, planFile, env, main = path.resolve(import.meta.dir, "..", "main.ts")) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      return exec([process.execPath, main, "team", "resume", "--unattended", "--json", "--plan", planFile, "--dir", checkout], { cwd: checkout });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

export async function reconcileOnce(
  trigger: { manual: boolean; retry: boolean },
  deps: TickDeps = {},
): Promise<ReconcileLedger> {
  const cfg = readConfig();
  const exec = deps.exec ?? realExec;
  const now = deps.now ?? Date.now;
  const token = readToken(cfg.hermesHome);
  const environment = readEnvironmentFile(cfg.environmentFile);
  const secrets = [...(token ? [token] : []), ...Object.values(environment).filter(Boolean)];
  if (token && cfg.repoUrl.startsWith("http")) writeCredentials(cfg, token);

  let ledger = recoverLedger(readLedger(cfg));
  // A watcher re-pointed at another repository or branch starts a fresh ledger: its applied
  // and blocked commits describe a history this configuration never had.
  if (ledger.repo !== stripUserinfo(cfg.repoUrl) || ledger.branch !== cfg.branch) ledger = emptyLedger(cfg);
  ledger.observedAt = new Date().toISOString();
  ledger.version = cfg.version;

  const finish = (l: ReconcileLedger): ReconcileLedger => {
    saveLedger(l);
    try {
      deps.publish?.(nexusRecord(l, cfg.kind ?? "command"));
    } catch {
      // Publication is reporting, not reconciliation - a cluster that
      // cannot accept the record must not fail the tick that fixed it.
    }
    return l;
  };

  // 1. poll
  const lsRemote = exec(gitArgs(cfg, token, ["ls-remote", cfg.repoUrl, `refs/heads/${cfg.branch}`]));
  if (lsRemote.exitCode !== 0) {
    const authy = AUTH_STDERR.test(lsRemote.stderr) || (!token && cfg.repoUrl.startsWith("http"));
    ledger.state = authy ? "authentication-required" : "degraded";
    log(`poll failed (${ledger.state})`);
    return finish(ledger);
  }
  const desired = lsRemote.stdout.split(/\s/)[0] ?? "";
  if (!isSha(desired)) {
    ledger.state = "degraded";
    return finish(ledger);
  }
  ledger.desiredSha = desired;

  // Blocked or pending SHA replaced by a new push? The gate clears itself.
  if (ledger.blocked && ledger.blocked.sha !== desired) ledger.blocked = undefined;
  if (ledger.pending && ledger.pending.sha !== desired) ledger.pending = undefined;

  const verdict = shouldApply(ledger, desired, trigger, now());
  if (!verdict.act) {
    if (ledger.state !== "failed" && ledger.state !== "degraded" && ledger.state !== "pending") ledger.state = "synced";
    log(verdict.reason);
    // A degraded state re-checks Argo convergence without touching git.
    if (ledger.state === "degraded" && deps.argocdConverged && (await deps.argocdConverged(30))) {
      ledger.state = "synced";
    }
    return finish(ledger);
  }
  if (trigger.retry && ledger.blocked) {
    ledger.blocked = { ...ledger.blocked, attempts: ledger.blocked.attempts }; // attempts bump on failure, not on retry intent
  }

  // Readiness gate BEFORE any mutation: reconciliation begins only after
  // the control plane is proven ready.
  if (deps.argocdReady && !deps.argocdReady()) {
    ledger.state = "degraded";
    log("Argo CD control plane not ready - no checkout, no apply");
    return finish(ledger);
  }

  ledger.state = "change-detected";
  const run: ReconcileRun = {
    sha: desired,
    startedAt: new Date().toISOString(),
    trigger: trigger.manual || trigger.retry ? "manual" : "timer",
    phase: "poll",
  };
  ledger.attemptedSha = desired;
  ledger.run = run;
  saveLedger(ledger);

  const logFile = path.join(logsDir(), `${desired.slice(0, 12)}-${Date.now()}.log`);
  fs.mkdirSync(logsDir(), { recursive: true });
  // Even the 0600 host log is scrubbed: a credential the child echoed must not outlive the run.
  const appendLog = (label: string, r: ExecResult) => {
    fs.appendFileSync(logFile, scrub(`\n===== ${label} (exit ${r.exitCode}) =====\n${r.stdout}\n${r.stderr}\n`, secrets), {
      mode: 0o600,
    });
    fs.chmodSync(logFile, 0o600);
  };
  pruneLogs();

  // Everything ledger-bound is scrubbed, INCLUDING the step: a check or
  // apply command is host config, and an operator who inlined a token in
  // one must not find it serialized in the ledger or the record.
  const redact = (s: string): string => scrub(s, secrets);
  const failRun = (phase: ReconcileRun["phase"], step: string, r: ExecResult): ReconcileLedger => {
    // A command can fail SILENTLY (`test -f x` says nothing) - the audit
    // record must still say what happened, or RECON007 rightly calls the
    // failure unauditable.
    const summary =
      summarize(`${r.stdout}\n${r.stderr}`, secrets) ||
      `${redact(step)} exited ${r.exitCode} with no output`;
    const done: ReconcileRun = {
      ...run,
      phase,
      step: redact(step),
      finishedAt: new Date().toISOString(),
      result: "failure",
      failure: { phase, step: redact(step), exitCode: r.exitCode, summary },
    };
    ledger.run = undefined;
    ledger.history = pushHistory(ledger.history, done);
    ledger.state = "failed";
    ledger.blocked = {
      sha: desired,
      attempts: (ledger.blocked?.sha === desired ? ledger.blocked.attempts : 0) + 1,
      lastAt: done.finishedAt!,
      summary: summary.slice(0, 500),
    };
    log(`FAILED at ${phase} (${step}) - commit ${desired.slice(0, 12)} is blocked`);
    return finish(ledger);
  };

  // 2. checkout the EXACT commit - never a branch tip that can move mid-run.
  const fresh = !fs.existsSync(path.join(checkoutDir(), ".git"));
  if (fresh) {
    const clone = exec(gitArgs(cfg, token, ["clone", "--no-checkout", cfg.repoUrl, checkoutDir()]));
    appendLog("git clone", clone);
    if (clone.exitCode !== 0) return failRun("poll", "git clone", clone);
  } else {
    const fetch = exec(gitArgs(cfg, token, ["fetch", "origin"]), { cwd: checkoutDir() });
    appendLog("git fetch", fetch);
    if (fetch.exitCode !== 0) return failRun("poll", "git fetch", fetch);
  }
  const co = exec(["git", "checkout", "--force", "--detach", desired], { cwd: checkoutDir() });
  appendLog("git checkout", co);
  if (co.exitCode !== 0) return failRun("poll", "git checkout", co);
  // The two mutation-guarding invariants, asserted rather than assumed:
  // the exact commit, and never an unfixed working tree.
  const head = exec(["git", "rev-parse", "HEAD"], { cwd: checkoutDir() });
  const status = exec(["git", "status", "--porcelain"], { cwd: checkoutDir() });
  if (head.stdout.trim() !== desired || status.stdout.trim() !== "") {
    return failRun("poll", "checkout-verify", {
      exitCode: 1,
      stdout: head.stdout,
      stderr: "checkout did not land exactly on the desired commit with a clean tree",
    });
  }

  if (cfg.kind === "team") {
    // The team kind (ADR 0191): the checkout is a bootstrap repository; the installed hg resumes
    // the installation it names, unattended. Exit 0 completes, 75 is pending, else failed.
    if (!cfg.team?.plan) return failRun("check", "team plan", { exitCode: 1, stdout: "", stderr: "reconcile config kind=team names no team.plan" });
    ledger.state = "validating";
    run.phase = "check";
    run.step = "bun install";
    saveLedger(ledger);
    let bootstrapDir: string;
    try {
      bootstrapDir = planBootstrapDirectory(path.join(checkoutDir(), cfg.team.plan));
      // Attributed before any gate can fail the run: a watcher missing its credentials still
      // publishes WHICH installation it could not reconcile, never an anonymous failure.
      ledger.installation = planInstallation(path.join(checkoutDir(), cfg.team.plan));
    } catch (err) { return failRun("check", "team plan", { exitCode: 1, stdout: "", stderr: (err as Error).message }); }
    // The plan's credential NAMES must all be present (environment file or service environment)
    // before anything runs; the values never appear here, only the names that are missing.
    try {
      const missing = missingCredentialNames(path.join(checkoutDir(), cfg.team.plan), { ...process.env, ...environment });
      if (missing.length) return failRun("check", "credentials", { exitCode: 1, stdout: "", stderr: `missing credential environment names: ${missing.join(", ")} - add them to the watcher's environment file` });
    } catch (err) {
      return failRun("check", "team plan", { exitCode: 1, stdout: "", stderr: (err as Error).message });
    }
    // A stack file still holding the generator's unset placeholder is one Pulumi rejects whole,
    // without naming the path (ADR 0196): name each path and its fix before anything runs.
    try {
      const teamPlan = loadPlan(path.join(checkoutDir(), cfg.team.plan));
      const unset = unsetMarkerFindings(teamPlan, checkoutDir(), deriveBackend(teamPlan, checkoutDir(), undefined).derived);
      if (unset.length) {
        return failRun("check", "credentials", { exitCode: 1, stdout: "", stderr: unset.map((f) => `unset secret placeholder at ${f.pulumiPath} in ${f.configFile} - set it: ${f.fix[0]}`).join("\n") });
      }
    } catch (err) {
      return failRun("check", "team plan", { exitCode: 1, stdout: "", stderr: (err as Error).message });
    }
    const installed = exec([process.execPath, "install", "--frozen-lockfile"], { cwd: path.join(checkoutDir(), bootstrapDir) });
    appendLog("bun install", installed);
    if (installed.exitCode !== 0) return failRun("check", "bun install --frozen-lockfile", installed);
    // The platform revision the lock records (ADR 0193) decides which `hg` resumes: the compiler
    // that publishes is then the same revision as the charts Argo CD syncs. A lock that names
    // none - or a plan with no platform - keeps running the installed hg, as before.
    let platformMain: string | undefined, keepRevisions: string[] | undefined;
    try {
      const planFile = checkoutFile(checkoutDir(), cfg.team.plan);
      const lockRelative = planLockFile(planFile), platform = planPlatform(planFile);
      const lockFile = lockRelative ? checkoutFile(checkoutDir(), lockRelative) : undefined;
      const revisions = lockFile && fs.existsSync(lockFile) ? lockPlatformRevisions(lockFile) : undefined;
      if (revisions && !platform) throw new CliError(`${planFile}: the lock records a platform revision but the plan declares no platform.repository`);
      // Known either way: a plan with no platform prunes every worktree a previous one left.
      keepRevisions = revisions ? [revisions.revision, ...(revisions.previousRevision ? [revisions.previousRevision] : [])] : [];
      if (revisions && platform) {
        run.step = `platform revision ${revisions.revision.slice(0, 12)}`;
        saveLedger(ledger);
        const platformToken = platform.credentialEnv ? environment[platform.credentialEnv] ?? process.env[platform.credentialEnv] : token;
        const prepared = preparePlatformWorktree(cfg, platformToken, platform.repository, revisions.revision, exec, appendLog);
        if ("exitCode" in prepared) return failRun("check", "platform revision", prepared);
        platformMain = prepared.main;
        log(`platform revision ${revisions.revision.slice(0, 12)}`);
      }
    } catch (err) {
      return failRun("check", "platform revision", { exitCode: 1, stdout: "", stderr: (err as Error).message });
    }
    // Prune as soon as the keep set is known, not only after a clean resume: a tick that fails or
    // goes pending must not leave a checkout per revision ever tried behind.
    const removed = prunePlatformWorktrees(keepRevisions, exec);
    if (removed.length) log(`pruned ${removed.length} platform worktree(s) no longer named by the lock`);
    ledger.state = "applying";
    run.phase = "apply";
    run.step = "hg team resume --unattended";
    saveLedger(ledger);
    const resumed = (deps.teamResume ?? realTeamResume(exec))(checkoutDir(), cfg.team.plan, environment, platformMain);
    appendLog("hg team resume --unattended", resumed);
    // The report is this run's, never a previous run's: absent means absent.
    const report = lastJsonDocument(resumed.stdout)?.["report"];
    ledger.report = report && typeof report === "object" ? (scrubValues(report, secrets) as TeamReport) : undefined;
    if (resumed.exitCode === 75) {
      const previous = ledger.pending?.sha === desired ? ledger.pending.attempts : 0;
      const at = new Date(now());
      const pendingInfo = (report as any)?.pending ?? {};
      const done: ReconcileRun = { ...run, finishedAt: at.toISOString(), result: "pending" };
      ledger.run = undefined;
      ledger.history = pushHistory(ledger.history, done);
      ledger.state = "pending";
      ledger.blocked = undefined; // a retry that turned pending must keep retrying on its own
      ledger.pending = {
        sha: desired,
        attempts: previous + 1,
        lastAt: at.toISOString(),
        nextAttemptAt: new Date(at.getTime() + pendingBackoffSeconds(previous + 1) * 1000).toISOString(),
        reason: typeof pendingInfo.reason === "string" ? pendingInfo.reason : "in-flight",
        ...(typeof pendingInfo.link === "string" ? { link: redact(pendingInfo.link) } : {}),
        ...(typeof (report as any)?.stage === "string" ? { stage: (report as any).stage } : {}),
      };
      log(`PENDING at ${ledger.pending.stage ?? "?"} (${ledger.pending.reason}) - next attempt ${ledger.pending.nextAttemptAt}`);
      return finish(ledger);
    }
    if (resumed.exitCode !== 0) return failRun("apply", "hg team resume --unattended", resumed);
    ledger.pending = undefined;
    run.note = skippedNote(resumed.stdout, secrets);
  } else {
  // 3. checks - host-configured preflights, before any mutation.
  ledger.state = "validating";
  run.phase = "check";
  saveLedger(ledger);
  for (const check of cfg.checks) {
    run.step = redact(check);
    saveLedger(ledger);
    const r = exec(["bash", "-lc", check], { cwd: checkoutDir() });
    appendLog(`check: ${check}`, r);
    if (r.exitCode !== 0) return failRun("check", check, r);
  }

  // 4. apply
  ledger.state = "applying";
  run.phase = "apply";
  run.step = redact(cfg.apply);
  saveLedger(ledger);
  const applied = exec(["bash", "-lc", cfg.apply], { cwd: checkoutDir() });
  appendLog(`apply: ${cfg.apply}`, applied);
  if (applied.exitCode !== 0) return failRun("apply", cfg.apply, applied);
  run.note = skippedNote(applied.stdout, secrets);
  }
  if (run.note) log(`applied without a rollout: ${run.note}`);

  // The apply SUCCEEDED: appliedSha advances now, whatever Argo does next.
  ledger.appliedSha = desired;
  ledger.appliedAt = new Date().toISOString();
  ledger.blocked = undefined;

  // 5. wait for Argo CD convergence. A timeout is degraded, not failed -
  // the apply did succeed, and the next tick re-checks without re-applying.
  ledger.state = "waiting-for-argocd";
  run.phase = "argocd";
  saveLedger(ledger);
  let converged = true;
  if (deps.argocdConverged) converged = await deps.argocdConverged(cfg.argocdTimeoutSec);
  const done: ReconcileRun = {
    ...run,
    phase: "done",
    finishedAt: new Date().toISOString(),
    result: "success",
  };
  ledger.run = undefined;
  ledger.history = pushHistory(ledger.history, done);
  ledger.state = converged ? "synced" : "degraded";
  ok(`applied ${desired.slice(0, 12)} (${ledger.state})`);
  return finish(ledger);
}

function pruneLogs(): void {
  try {
    const entries = fs
      .readdirSync(logsDir())
      .filter((f) => f.endsWith(".log"))
      .sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - LOGS_KEEP))) {
      fs.unlinkSync(path.join(logsDir(), stale));
    }
  } catch {
    // best-effort housekeeping
  }
}

// ---------------------------------------------------------------------------
// Real Argo gates (host-side kubectl through the configured context).

function kubectlJson(cfg: ReconcileConfig, args: string[]): unknown {
  const cmd = ["kubectl"];
  if (cfg.kubeContext) cmd.push("--context", cfg.kubeContext);
  const proc = Bun.spawnSync([...cmd, ...args, "-o", "json"], { stdout: "pipe", stderr: "pipe" });
  if ((proc.exitCode ?? 1) !== 0) throw new Error("kubectl failed");
  return JSON.parse(proc.stdout.toString());
}

/** Gate 1, BEFORE mutation: the Argo control plane must be provably
 * ready or the tick stops at degraded with no checkout and no apply. */
export function argocdReady(cfg: ReconcileConfig): boolean {
  try {
    // By LABEL, not name: the local loop installs `argocd-server`, the
    // bootstrap's helm release prefixes its release name
    // (`argocd-<hash>-server`) - a by-name get held a healthy real
    // cluster at degraded forever (found live on a destination server).
    for (const name of ["argocd-server", "argocd-repo-server"]) {
      const deploys = kubectlJson(cfg, ["-n", "argocd", "get", "deploy", "-l", `app.kubernetes.io/name=${name}`]) as {
        items?: { status?: { readyReplicas?: number } }[];
      };
      const items = deploys.items ?? [];
      if (items.length === 0 || !items.every((d) => (d.status?.readyReplicas ?? 0) > 0)) return false;
    }
    kubectlJson(cfg, ["get", "crd", "applications.argoproj.io"]);
    return true;
  } catch {
    return false;
  }
}

/** Gate 2, AFTER apply: every Application Synced+Healthy - the same
 * source the overlay reads, polled with a bounded wait. */
export async function argocdConverged(cfg: ReconcileConfig, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    try {
      const apps = kubectlJson(cfg, ["get", "applications.argoproj.io", "-A"]) as {
        items?: { status?: { sync?: { status?: string }; health?: { status?: string } } }[];
      };
      const all = apps.items ?? [];
      if (all.every((a) => a.status?.sync?.status === "Synced" && a.status?.health?.status === "Healthy")) {
        return true;
      }
    } catch {
      // transient API failure - keep polling until the deadline
    }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(5000);
  }
}

/** Publish the allowlisted record as ConfigMap
 * hermes-reconciliation-status (the M02 handshake). A ConfigMap and NOT
 * a Git commit: the deployment repository is this reconciler's own
 * input, so committing status there would change the desired SHA and
 * re-trigger reconciliation forever. Server-side apply via kubectl -
 * the same transport everything host-side already uses. */
export function publishRecord(cfg: ReconcileConfig, record: Record<string, unknown>): void {
  const ns = cfg.statusNamespace ?? "hermes-gitops";
  const manifest = JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: statusName(),
      namespace: ns,
      // The phase label lets alerting select degraded/pending watchers with kube-state-metrics.
      labels: { "hermes.dev/overlay-source": "reconciliation", "harness-hg.factorylevel.dev/phase": String(record["phase"] ?? "unknown") },
    },
    data: { "status.json": JSON.stringify(record, null, 2) + "\n" },
  });
  const cmd = ["kubectl"];
  if (cfg.kubeContext) cmd.push("--context", cfg.kubeContext);
  cmd.push("apply", "--server-side", "--force-conflicts", "-f", "-");
  const proc = Bun.spawnSync(cmd, { stdin: Buffer.from(manifest), stdout: "pipe", stderr: "pipe" });
  if ((proc.exitCode ?? 1) !== 0) {
    throw new Error("publish failed"); // callers treat publication as best-effort
  }
}

export function realDeps(cfg: ReconcileConfig): TickDeps {
  return {
    argocdReady: () => argocdReady(cfg),
    argocdConverged: (t) => argocdConverged(cfg, t),
    publish: (record) => publishRecord(cfg, record),
  };
}

// ---------------------------------------------------------------------------
// Install: systemd USER units, generated here and golden-asserted in the
// tests - four interpolations in a static file are how templates drift.
// User units (not system): the service inherits the operator's
// kubeconfig, $HERMES_HOME and pulumi login, and needs no root.

export function unitFiles(cfg: ReconcileConfig, hgEntry: { bun: string; main: string }): {
  service: string;
  timer: string;
} {
  // A user unit starts with a nearly empty environment. The tick's
  // children (pulumi, gcloud, git, uv-installed hermes) live in
  // ~/.local/bin, and on a destination server the apply needs the GCP
  // credential, the state backend and the kube context - baked from the
  // INSTALLING session, the same discipline as the backup timers.
  const binDir = path.dirname(hgEntry.bun);
  const passthrough = [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "PULUMI_BACKEND_URL",
    "HG_KUBE_CONTEXT",
    "HG_BACKUP_WRITER_SA",
    "HG_RESTORE_READER_SA",
  ]
    .map((k) => (process.env[k] ? `\nEnvironment=${k}=${process.env[k]}` : ""))
    .join("");
  // A team-kind watcher's plan credentials come from a 0600 dotenv file, never from the unit:
  // `-` tolerates a missing file (the tick then reports the missing names itself).
  const environmentFile = cfg.environmentFile ? `\nEnvironmentFile=-${cfg.environmentFile}` : "";
  const service = `# Generated by \`hg reconcile install\` - edit the config, not this file.
[Unit]
Description=Harness Hg reconciliation (version ${cfg.version})

[Service]
Type=oneshot
Environment=HERMES_GITOPS_HOME=${hgHome()}
Environment=HERMES_HOME=${cfg.hermesHome}
Environment=PATH=${binDir}:/usr/local/bin:/usr/bin:/bin${passthrough}${environmentFile}
ExecStart=${hgEntry.bun} ${hgEntry.main} reconcile run${instanceName() ? ` --instance ${instanceName()}` : ""}
# The tick's own Argo wait plus generous apply headroom - systemd kills
# a hung run rather than letting it hold the flock forever.
TimeoutStartSec=${cfg.argocdTimeoutSec + 600}
`;
  const timer = `# Generated by \`hg reconcile install\`.
[Unit]
Description=Harness Hg reconciliation tick

[Timer]
OnBootSec=2min
# From the END of the last run - a ten-minute pulumi up can never queue
# a burst of overlapping ticks (flock is the second, free layer).
OnUnitInactiveSec=${cfg.intervalSeconds}s
AccuracySec=5s
Unit=${unitName()}.service

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

function userUnitDir(): string {
  return path.join(os.homedir(), ".config", "systemd", "user");
}

export function installReconcile(cfg: ReconcileConfig, opts: { enable: boolean }): void {
  // Fail at install, not at 3am: the runtime must exist before a timer
  // depends on it.
  const bun = Bun.which("bun");
  if (!bun) throw new CliError("bun not found on PATH - the timer would fail on every tick");
  if (cfg.kind === "team" && !cfg.team?.plan) throw new CliError("kind=team needs --team-plan <bootstrap-relative installation.yaml>");
  if (cfg.kind === "team" && (cfg.checks.length || cfg.apply)) throw new CliError("kind=team runs `hg team resume --unattended`; --checks and --apply do not apply");
  readEnvironmentFile(cfg.environmentFile); // refuses a world-readable credential file at install, not at 3am
  writeConfig(cfg);
  const main = path.resolve(import.meta.dir, "..", "main.ts");
  const units = unitFiles(cfg, { bun, main });
  const dir = userUnitDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${unitName()}.service`), units.service);
  fs.writeFileSync(path.join(dir, `${unitName()}.timer`), units.timer);
  ok(`wrote ${dir}/${unitName()}.{service,timer} (version ${cfg.version})`);
  const sysd = (args: string[], allowFail = false) => {
    const r = Bun.spawnSync(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
    if ((r.exitCode ?? 1) !== 0 && !allowFail) {
      throw new CliError(`systemctl --user ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
    }
    return r;
  };
  sysd(["daemon-reload"]);
  if (opts.enable) {
    sysd(["enable", "--now", `${unitName()}.timer`]);
    // Best-effort: without linger the timer dies with the login session.
    const linger = Bun.spawnSync(["loginctl", "enable-linger"], { stdout: "pipe", stderr: "pipe" });
    if ((linger.exitCode ?? 1) !== 0) {
      log("warning: loginctl enable-linger failed - the timer stops when this user logs out");
    }
    ok(`timer enabled (systemctl --user list-timers ${unitName()}.timer)`);
  } else {
    log(`units written but not enabled - rerun with --now, or: systemctl --user enable --now ${unitName()}.timer`);
  }
}

export function uninstallReconcile(): void {
  const sysd = (args: string[]) =>
    Bun.spawnSync(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  sysd(["disable", "--now", `${unitName()}.timer`]);
  const dir = userUnitDir();
  for (const f of [`${unitName()}.service`, `${unitName()}.timer`]) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
  sysd(["daemon-reload"]);
  // The ledger and logs stay: an uninstall is not an amnesty for history.
  ok("timer disabled and units removed (config/ledger/logs kept under $HG_HOME/reconcile)");
}

// ---------------------------------------------------------------------------
// hg reconcile prove: RECON001..RECON008 in the design-16 ProofResult
// envelope. `unknown` findings are honest non-checks (no systemd, no
// cluster, nothing installed) - never silent passes.

import type { ProofFinding, ProofResult } from "../backup/platform.ts";
import { secretScan } from "../nexus/prove.ts";

export function proveReconcile(): ProofResult {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });

  let cfg: ReconcileConfig | null = null;
  try {
    cfg = readConfig();
  } catch (err) {
    add("RECON001", "fail", "install", (err as Error).message);
  }

  if (cfg) {
    // RECON001 - the timer is installed, enabled, and pinned to the
    // configured version.
    const enabled = Bun.spawnSync(["systemctl", "--user", "is-enabled", `${unitName()}.timer`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((enabled.exitCode ?? 1) !== 0) {
      add("RECON001", "unknown", "install", "timer not enabled under systemd --user (hand-run mode?)");
    } else {
      const unit = path.join(os.homedir(), ".config", "systemd", "user", `${unitName()}.service`);
      const pinned = fs.existsSync(unit) && fs.readFileSync(unit, "utf8").includes(`(version ${cfg.version})`);
      add(
        "RECON001",
        pinned ? "pass" : "fail",
        "install",
        pinned ? `timer enabled, unit pinned to ${cfg.version}` : "unit version does not match config - rerun install",
      );
    }

    // RECON002 - credential posture. `unknown`, never `pass`, for a
    // non-https remote: the proof does not lie about what it checked.
    if (!cfg.repoUrl.startsWith("http")) {
      add("RECON002", "unknown", "credentials", "non-http remote - no token path to check");
    } else {
      const token = readToken(cfg.hermesHome);
      const credFile = path.join(reconcileDir(), "git-credentials");
      const mode = fs.existsSync(credFile) ? fs.statSync(credFile).mode & 0o777 : null;
      const okCred = Boolean(token) && mode === 0o600;
      add(
        "RECON002",
        okCred ? "pass" : "fail",
        "credentials",
        okCred
          ? "token present, credential file 0600"
          : token
            ? `credential file mode ${mode?.toString(8) ?? "missing"} (want 600)`
            : "GITOPS_GIT_TOKEN missing from $HERMES_HOME/.env",
      );
    }

    // RECON003 - the lock is a live flock: free now, or held by a run.
    const probe = Bun.spawnSync(["flock", "-n", "-E", "75", lockFile(), "true"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    add(
      "RECON003",
      probe.exitCode === 0 || probe.exitCode === 75 ? "pass" : "fail",
      "lock",
      probe.exitCode === 0 ? "lock free" : probe.exitCode === 75 ? "lock held by a run in flight" : "flock probe failed",
    );

    // RECON004 - the serialized ledger survives secretScan. Checked, not
    // asserted: this is the guarantee the scrubbing pipeline exists for.
    const ledger = readLedger(cfg);
    const hits = secretScan("ledger", JSON.stringify(ledger));
    add(
      "RECON004",
      hits.length === 0 ? "pass" : "fail",
      "ledger",
      hits.length === 0 ? "ledger parses; nothing secret-shaped" : `secret-shaped content: ${hits.map((h) => h.pattern).join(", ")}`,
    );

    // RECON005 - converged: desired == applied and state synced.
    if (!ledger.desiredSha) {
      add("RECON005", "unknown", "convergence", "no tick has run yet");
    } else {
      const converged = ledger.state === "synced" && ledger.desiredSha === ledger.appliedSha;
      add(
        "RECON005",
        converged ? "pass" : "fail",
        "convergence",
        converged
          ? `synced at ${ledger.appliedSha!.slice(0, 12)}`
          : `state=${ledger.state}, desired=${ledger.desiredSha.slice(0, 12)}, applied=${ledger.appliedSha?.slice(0, 12) ?? "-"}`,
      );
    }

    // RECON006 - every Argo Application Synced+Healthy.
    try {
      const apps = kubectlJson(cfg, ["get", "applications.argoproj.io", "-A"]) as {
        items?: { metadata?: { name?: string }; status?: { sync?: { status?: string }; health?: { status?: string } } }[];
      };
      const bad = (apps.items ?? []).filter(
        (a) => a.status?.sync?.status !== "Synced" || a.status?.health?.status !== "Healthy",
      );
      add(
        "RECON006",
        bad.length === 0 ? "pass" : "fail",
        "argocd",
        bad.length === 0
          ? `${apps.items?.length ?? 0} Application(s) Synced+Healthy`
          : `not converged: ${bad.map((a) => a.metadata?.name).join(", ")}`,
      );
    } catch {
      add("RECON006", "unknown", "argocd", "cluster unreachable; Applications not checked");
    }

    // RECON007 - when failed, the failure is AUDITABLE: blocked sha,
    // attempts, a non-empty sanitized summary, and the gate engaged.
    if (ledger.state !== "failed") {
      add("RECON007", "unknown", "failure-audit", `state is ${ledger.state} - nothing to audit`);
    } else {
      const b = ledger.blocked;
      const auditable = Boolean(b && b.sha && b.attempts >= 1 && b.summary.trim().length > 0);
      const gateHolds = Boolean(b && !shouldApply(ledger, b.sha, { manual: false, retry: false }).act);
      add(
        "RECON007",
        auditable && gateHolds ? "pass" : "fail",
        "failure-audit",
        auditable && gateHolds
          ? `blocked ${b!.sha.slice(0, 12)} after ${b!.attempts} attempt(s), gate engaged`
          : "failed state without a complete, gate-backed audit record",
      );
    }

    // RECON009 - when pending, the wait is auditable AND bounded: a reason,
    // a next attempt in the future (or due now), and the gate holding until
    // then. A pending record nothing could ever retry is a stall.
    if (ledger.state !== "pending") {
      add("RECON009", "unknown", "pending-audit", `state is ${ledger.state} - nothing pending`);
    } else {
      const p = ledger.pending;
      const parsed = p ? Date.parse(p.nextAttemptAt) : NaN;
      const bounded = Boolean(p && p.reason && Number.isFinite(parsed) && parsed - Date.parse(p.lastAt) <= PENDING_BACKOFF.capSeconds * 1000);
      const gateHolds = Boolean(p && !shouldApply(ledger, p.sha, { manual: false, retry: false }, Date.parse(p.lastAt)).act);
      add(
        "RECON009",
        bounded && gateHolds ? "pass" : "fail",
        "pending-audit",
        bounded && gateHolds
          ? `pending ${p!.sha.slice(0, 12)} (${p!.reason}), attempt ${p!.attempts}, next at ${p!.nextAttemptAt}`
          : "pending state without a bounded, gate-backed record",
      );
    }

    // RECON008 - the published record matches the ledger and carries no
    // secrets. The record is what Nexus renders; a drifted one is a lie
    // in the UI even when the host ledger is honest.
    try {
      const ns = cfg.statusNamespace ?? "hermes-gitops";
      const cm = kubectlJson(cfg, ["-n", ns, "get", "configmap", statusName()]) as {
        data?: { "status.json"?: string };
      };
      const record = JSON.parse(cm.data?.["status.json"] ?? "{}") as Record<string, unknown>;
      const shasMatch =
        (record["appliedSha"] ?? undefined) === (ledger.appliedSha ?? undefined) &&
        (record["desiredSha"] ?? undefined) === (ledger.desiredSha ?? undefined);
      const clean = secretScan("record", JSON.stringify(record)).length === 0;
      add(
        "RECON008",
        shasMatch && clean ? "pass" : "fail",
        "published-record",
        shasMatch && clean
          ? "ConfigMap matches the ledger; nothing secret-shaped"
          : !shasMatch
            ? "published SHAs drifted from the ledger"
            : "secret-shaped content in the published record",
      );
    } catch {
      add("RECON008", "unknown", "published-record", "ConfigMap unreadable (no cluster, or not yet published)");
    }
  } else {
    for (const id of ["RECON002", "RECON003", "RECON004", "RECON005", "RECON006", "RECON007", "RECON008", "RECON009"]) {
      add(id, "unknown", "install", "reconcile is not installed");
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
    command: "reconcile prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    findings,
    summary,
  };
}
