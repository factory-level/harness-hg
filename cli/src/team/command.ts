import { parse } from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import versions from "../../../versions.json";
import { ApprovalRequired, ChildFailed, CliError, HG_HOME, PLATFORM_ROOT } from "../lib.ts";
import { digest, credentialFingerprint, loadPlan, secretEnvironmentNames, type TeamPlan, type TeamSource } from "./plan.ts";
import { compileLock, lockedCommit, lockPath, readLock, renderLock, verifyLock, writeLockFile, type InstallationLock, type RefTarget } from "./lock.ts";
import { approveOverlayReview, overlayDocument, overlaidRuntime, resolveAgentOverlays, stageOverlayReview, templateOverlayDigest, verifyOverlayApproval, type ResolvedOverlays } from "./overlays.ts";
import { compileTeam, type ResolvedSource } from "./compiler.ts";
import { run, gitEnvironment, declaredSecrets } from "./process.ts";
import { publishProjection, previewProjection, OWNERSHIP_FILE } from "./publisher.ts";
import { readLedger, saveLedger, STAGES, type Evidence, type Ledger, type Pending, type PendingReason, type StageOperation, type Stage } from "./ledger.ts";
import { carryForward, readApplied, runOrSkip, skipReason, type SourceDecision } from "./inputs.ts";
import { assertAllowedRuntimes, effectiveRuntime, skillContentHash, validateRuntimeSource, verifyProductionRuntime } from "./runtime.ts";
import { agentVerdict, classifyAgent, desiredAgent, observeAgent, observeWatcher, renderStatusTable, statusExitCode, type AgentStatus, type ObservedAgent } from "./health.ts";
import { applyIntegrations, bootstrapConfig, enabled, provisioningGate, recordEnabled, readIntegrationOutputs, readBootstrapInputs } from "./providers.ts";
import { assertRequirementsDelivered, credentialPreflight, CredentialGateError, pulumiEnvironment, type AccessFailure, type CredentialFinding } from "./credentials.ts";
import { StackConfigError } from "./delivery.ts";
import { recoverOldPod, recoverWorkspaceClaim, recoverWorkspacePod, resumeWorkspaceController } from "./recovery.ts";
import { verifySourceApproval } from "../skills/team.ts";
import { scrub } from "../reconcile/index.ts";

const pass = (summary: string, receipts?: string[]): Evidence => ({ verdict: "pass", summary, ...(receipts ? { receipts } : {}) });
const unknown = (summary: string): Evidence => ({ verdict: "unknown", summary });
/** Unknown that names WHY a run stopped: what only a human, a merge or time can supply (ADR 0191). */
const pending = (reason: PendingReason, summary: string, link?: string): Evidence => ({ verdict: "unknown", summary, pending: { reason, ...(link ? { link } : {}) } });
/** What readiness observed per agent, for the unattended report. */
export interface AgentObservation { declaredSha?: string; image?: string; ready: boolean }
/** The unattended run's machine-readable outcome, published by the team watcher (ADR 0191). */
export interface UnattendedReport {
  installation: string;
  stage: Stage | "complete";
  pending?: Pending;
  /** `effectiveSha` and `reason` appear when the desired commit is applied without a rollout
   * (ADR 0198): the workload keeps declaring `effectiveSha`, whose agent inputs are identical. */
  sources: { id: string; ref: string; desiredSha?: string; appliedSha?: string; effectiveSha?: string; reason?: string }[];
  agents: { name: string; source: string; desiredSha?: string; appliedSha?: string; effectiveSha?: string; runtimeDigest: string; eveVersion: string; pinned?: boolean; ready?: boolean }[];
  /** Why this run applied new commits without rolling anything out. */
  skipped?: string;
  /** A credential refusal at `validated` (ADR 0196): every missing value, names and paths only. */
  findings?: CredentialFinding[];
  /** ...or everything this host could not reach, before any value was judged missing. */
  access?: AccessFailure[];
}
/** What an agent runs, for the report: its own pin when it has one, the installation default
 * otherwise. `pinned` is what tells a reader a canary is deliberate rather than drift. */
export function effectiveRuntimeFacts(plan: TeamPlan, agent: TeamSource["agents"][number]): { runtimeDigest: string; eveVersion: string; pinned?: boolean } {
  const runtime = effectiveRuntime(plan, agent);
  return { runtimeDigest: runtime.image, eveVersion: runtime.eveVersion, ...(agent.runtime ? { pinned: true } : {}) };
}
/** The commit a report calls applied (ADR 0198). A skipped run applied the desired commit by
 * definition. Otherwise it is what the workload declares - and a workload declaring the carried
 * effective commit is running the desired commit's agent inputs, so the desired commit is applied. */
export function reportedAppliedSha(decision: SourceDecision | undefined, declared: string | undefined, skipped: boolean): string | undefined {
  if (decision && skipped) return decision.desiredSha;
  if (decision?.carried && declared === decision.effectiveSha) return decision.desiredSha;
  return declared;
}
/** The stage a run halted at and its evidence, from the ledger: the first non-pass in order. */
export function haltedStage(stages: Partial<Record<Stage, Evidence>>): { stage: Stage; evidence: Evidence } | undefined {
  for (const stage of STAGES) {
    const evidence = stages[stage];
    if (evidence && evidence.verdict !== "pass") return { stage, evidence };
  }
  return undefined;
}
/** Exit code for an unattended run: 0 complete, 75 pending (halted on an unknown that NAMES what it
 * waits for), 1 failed. An unknown with no pending reason is something nobody can act on by
 * waiting, so it fails rather than retrying forever. */
export function unattendedExitCode(complete: boolean, halted?: { evidence: Evidence }): 0 | 75 | 1 {
  if (complete) return 0;
  return halted?.evidence.verdict === "unknown" && halted.evidence.pending ? 75 : 1;
}
const localFile = (root: string, relative: string): string => {
  const file = fs.realpathSync(path.resolve(root, relative));
  if (file !== fs.realpathSync(root) && !file.startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new CliError("Installation input resolves outside the bootstrap checkout");
  return file;
};
/** Fetch one source's ref into its own scratch clone and report the commit it names. */
export async function resolveRef(definition: RefTarget, scratch: string) {
  const token = definition.credentialEnv ? process.env[definition.credentialEnv] : undefined;
  if (definition.private && !token) throw new CliError(`Source ${definition.id}: required credential environment reference is unavailable`);
  const root = path.join(scratch, definition.id); fs.mkdirSync(root);
  const env = gitEnvironment(token);
  await run(["git", "clone", "--no-checkout", "--", definition.repository, root], scratch, env);
  await run(["git", "fetch", "origin", definition.ref], root, env);
  const sha = (await run(["git", "rev-parse", "FETCH_HEAD^{commit}"], root, env)).trim();
  return { root, sha, env };
}
export async function resolveSources(plan: TeamPlan, scratch: string, lock?: InstallationLock): Promise<ResolvedSource[]> {
  const resolved: ResolvedSource[] = [];
  for (const definition of plan.sources) {
    const { root, sha, env } = await resolveRef(definition, scratch);
    // A version-2 plan publishes only what its lock recorded: a moved tag refuses.
    if (lock) lockedCommit(lock, definition, sha);
    await run(["git", "checkout", "--detach", sha], root, env);
    resolved.push({ definition, root, sha });
  }
  return resolved;
}
export function resolveAppValues(agent: TeamSource["agents"][number], environment: NodeJS.ProcessEnv = process.env) {
  if (!agent.appValues && !agent.appValueBindings) return undefined;
  const values = structuredClone(agent.appValues ?? {});
  for (const [target, reference] of Object.entries(agent.appValueBindings ?? {})) {
    const value = environment[reference];
    if (!value) throw new CliError(`${agent.name}: missing app value input ${reference}`);
    const keys = target.split(".");
    if (keys.some(key => ["__proto__", "prototype", "constructor"].includes(key))) throw new CliError("Unsafe app value path");
    let parent: any = values;
    for (const key of keys.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) throw new CliError(`${agent.name}: app value binding requires an existing object path`);
      parent = parent[key];
    }
    const key = keys.at(-1)!;
    if (parent[key]?.secret !== true || Object.keys(parent[key]).length !== 1) throw new CliError(`${agent.name}: app value binding must replace a secret marker`);
    parent[key] = value;
  }
  const unresolved = (value: any): boolean => value && typeof value === "object" && ((value.secret === true && Object.keys(value).length === 1) || Object.values(value).some(unresolved));
  if (unresolved(values)) throw new CliError(`${agent.name}: unresolved app value secret marker`);
  return values;
}
export async function compileResolved(plan: TeamPlan, bootstrapRoot: string, sources: ResolvedSource[], overlays: Map<string, ResolvedOverlays> = new Map()) {
  const records = new Map<string, string>();
  for (const source of sources) for (const agent of source.definition.agents) {
    const appValues = resolveAppValues(agent);
    const resolved = overlays.get(agent.name);
    // The approved overlay document travels as a private temporary file: stdin carries app values.
    const overlaysDir = resolved ? fs.mkdtempSync(path.join(os.tmpdir(), "hg-team-overlays-")) : undefined;
    const overlaysFile = overlaysDir ? path.join(overlaysDir, "overlays.json") : undefined;
    if (overlaysFile) fs.writeFileSync(overlaysFile, JSON.stringify(overlayDocument(resolved!)), { mode: 0o600 });
    try {
      const output = await run(["uv", "run", "--directory", PLATFORM_ROOT, "python", "-m", "gitops_emitter.emit_cli",
        "--runtime", "eve", "--render-only", "--agent-dir", path.join(source.root, agent.subdir),
        "--source", source.definition.repository, "--sha", source.sha, "--ref", source.definition.ref,
        "--subdir", agent.subdir, "--name", agent.name, "--expect-eve-version", effectiveRuntime(plan, agent).eveVersion,
        ...(appValues ? ["--app-values", "-"] : []), ...(overlaysFile ? ["--overlays-file", overlaysFile] : [])], PLATFORM_ROOT, process.env, 120_000, appValues ? JSON.stringify(appValues) : undefined);
      records.set(agent.name, output);
    } finally {
      if (overlaysDir) fs.rmSync(overlaysDir, { recursive: true, force: true });
    }
  }
  return compileTeam(plan, bootstrapRoot, sources, (_s, a) => records.get(a.name)!);
}
async function readiness(plan: TeamPlan, sources: ResolvedSource[], recoveryRoot?: string, overlays: Map<string, ResolvedOverlays> = new Map(), observations?: Map<string, AgentObservation>): Promise<Evidence> {
  for (const source of sources) for (const agent of source.definition.agents) {
    const namespace = `ag-eve-${agent.name}`;
    const observe = (facts: Partial<AgentObservation>) => observations?.set(agent.name, { ready: false, ...(observations.get(agent.name) ?? {}), ...facts });
    observe({});
    const pods = JSON.parse(await run(["kubectl", "--context", plan.kubeContext, "-n", namespace, "get", "pods", "-o", "json"], process.cwd()));
    const candidates = pods.items.filter((pod: any) => pod.metadata.ownerReferences?.some((owner: any) => owner.kind === "StatefulSet" && owner.name === namespace));
    if (candidates.length !== 1) {
      const preserved = pods.items.find((pod: any) => pod.metadata.name === `${namespace}-0`);
      if (!candidates.length && recoveryRoot && preserved && await resumeWorkspaceController(plan, source.sha, preserved, recoveryRoot)) return unknown(`${agent.name}: requested exact-revision Argo recreation of the recorded missing controller`);
      return unknown(`${agent.name}: expected exactly one owned workload pod`);
    }
    const pod = candidates[0];
    const statefulSet = JSON.parse(await run(["kubectl", "--context", plan.kubeContext, "-n", namespace, "get", "statefulset", namespace, "-o", "json"], process.cwd()));
    const application = JSON.parse(await run(["kubectl", "--context", plan.kubeContext, "-n", "argocd", "get", "application", namespace, "-o", "json"], process.cwd()));
    if (application.status?.sync?.status !== "Synced") {
      if (recoveryRoot && await recoverWorkspaceClaim(plan, source.sha, pod, statefulSet, application, recoveryRoot)) return unknown(`${agent.name}: requested bounded workspace-claim migration; existing pod and data claim retained`);
      return unknown(`${agent.name}: Argo application has not synchronized the desired workload`);
    }
    const declared = statefulSet.spec.template.spec.initContainers?.flatMap((c: any) => c.env ?? []).find((e: any) => e.name === "EVE_DIST_SHA")?.value;
    observe({ declaredSha: typeof declared === "string" ? declared : undefined, image: statefulSet.spec.template.spec.containers.find((c: any) => c.name === "eve-agent")?.image });
    if (declared !== source.sha) return unknown(`${agent.name}: workload does not declare the resolved source revision`);
    if (statefulSet.spec.template.spec.containers.find((c: any) => c.name === "eve-agent")?.image !== effectiveRuntime(plan, agent).image) return unknown(`${agent.name}: running template image differs from the production-verified digest`);
    if (templateOverlayDigest(statefulSet) !== overlays.get(agent.name)?.digest) return unknown(`${agent.name}: running template's operator overlays differ from the approved overlays`);
    if (pod.metadata.labels?.["controller-revision-hash"] !== statefulSet.status?.updateRevision) {
      if (recoveryRoot && await recoverWorkspacePod(plan, source.sha, pod, statefulSet, application, recoveryRoot)) return unknown(`${agent.name}: requested graceful rollout of the recorded pre-workspace pod; data claims retained`);
      if (recoveryRoot && await recoverOldPod(plan, pod, statefulSet, recoveryRoot)) return unknown(`${agent.name}: requested bounded recovery of failed obsolete pod`);
      return unknown(`${agent.name}: old pod revision blocks the desired rollout; inspect the workload and use scoped recovery`);
    }
    const containers = [...(pod.status.initContainerStatuses ?? []), ...(pod.status.containerStatuses ?? [])];
    if (containers.some((c: any) => ["CrashLoopBackOff", "CreateContainerConfigError"].includes(c.state?.waiting?.reason))) return { verdict: "fail", summary: `${agent.name}: deterministic startup failure at the desired revision; repair source or credentials before resume` };
    if (!pod.status.conditions?.some((c: any) => c.type === "Ready" && c.status === "True")) return unknown(`${agent.name}: workload is not ready`);
    observe({ ready: true });
  }
  return pass("All registered workloads are ready at their desired source and pod revisions");
}
async function waitReady(plan: TeamPlan, sources: ResolvedSource[], stateRoot: string, overlays: Map<string, ResolvedOverlays> = new Map(), observations?: Map<string, AgentObservation>): Promise<Evidence> {
  const deadline = Date.now() + 300_000;
  let evidence: Evidence;
  do {
    evidence = await readiness(plan, sources, stateRoot, overlays, observations);
    if (evidence.verdict !== "unknown") return evidence;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  } while (Date.now() < deadline);
  // Still converging when the deadline hit: the next tick re-observes; nothing is wrong yet.
  return { ...pending("in-flight", `${evidence.summary}; readiness deadline exceeded`) };
}
async function transport(plan: TeamPlan): Promise<Evidence> {
  for (const source of plan.sources) for (const agent of source.agents) {
    if (!agent.slack) continue;
    const secret = process.env[agent.slack.signingSecretEnv];
    if (!secret) return pending("authorization", `${agent.name}: signing-secret reference is unavailable`);
    const challenge = randomUUID(), timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "url_verification", challenge });
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const unsigned = await fetch(agent.slack.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (![401, 403].includes(unsigned.status)) return { verdict: "fail", summary: `${agent.name}: unsigned Slack request was not rejected` };
    const signed = await fetch(agent.slack.url, { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, body, signal: AbortSignal.timeout(10_000), redirect: "error" });
    const answer = await signed.text();
    if (!signed.ok || (answer !== challenge && (() => { try { return JSON.parse(answer).challenge !== challenge; } catch { return true; } })())) return { verdict: "fail", summary: `${agent.name}: signed Slack challenge failed` };
  }
  return pass("Declared Slack transports passed signed challenge and unsigned rejection");
}

export async function cmdTeam(json: boolean, args: string[], opts: { plan?: string; root?: string; stage?: string; review?: string; approvals?: string; approver?: string; fingerprint?: string; unattended?: boolean }): Promise<void> {
  const sub = args[0] ?? "plan";
  const unattended = Boolean(opts.unattended);
  if (unattended && sub !== "resume") throw new CliError("--unattended applies to team resume only: a watcher resumes; a person applies");
  if (sub === "inspect") {
    if (!args[1]) throw new CliError("team inspect requires a skill directory");
    const root = fs.realpathSync(path.resolve(args[1]));
    console.log(JSON.stringify({ path: root, revision: skillContentHash(root) }, null, 2)); return;
  }
  if (sub === "overlays" && args[1] === "approve") {
    if (!opts.review || !opts.approvals || !opts.approver || !opts.fingerprint) throw new CliError("team overlays approve requires --review, --approval-file, --approver and --fingerprint after human review");
    await approveOverlayReview(path.resolve(opts.review), path.resolve(opts.approvals), opts.fingerprint, opts.approver);
    console.log(JSON.stringify({ approved: true, fingerprint: opts.fingerprint })); return;
  }
  if (sub === "overlays" && args[1] !== "prepare") throw new CliError("team overlays supports prepare and approve");
  if (!["compile", "overlays", "plan", "apply", "resume", "status", "publish"].includes(sub)) throw new CliError("team supports compile, overlays, plan, apply, resume, status and publish");
  if (!opts.plan) throw new CliError("team requires --plan <installation.yaml>");
  const root = fs.realpathSync(path.resolve(opts.root ?? process.cwd()));
  const planFile = localFile(root, opts.plan);
  const plan = loadPlan(planFile);
  // Nothing resolves, renders or locks before every runtime pin is one the platform publishes.
  assertAllowedRuntimes(plan);
  if (unattended && plan.version !== 2) throw new CliError(`team ${plan.id}: unattended resume needs installation plan version 2 - a version 1 plan tracks moving branches, so the bootstrap commit does not determine what publishes; migrate with hg team compile and a committed lock`);
  for (const name of secretEnvironmentNames(plan)) declaredSecrets.add(name);
  const stateRoot = path.join(HG_HOME, "teams", plan.id), ledgerFile = path.join(stateRoot, "state.json");
  // The unattended report: one JSON document on stdout whatever the outcome, so the watcher can
  // publish it without parsing prose.
  const observations = new Map<string, AgentObservation>();
  let resolvedSources: ResolvedSource[] = [];
  let decisions: SourceDecision[] = [];
  let skipped: string | undefined;
  const report = (stage: Stage | "complete", pendingInfo?: Pending, gate?: CredentialGateError): UnattendedReport => ({
    installation: plan.id, stage, ...(pendingInfo ? { pending: pendingInfo } : {}),
    sources: plan.sources.map(s => {
      const resolved = resolvedSources.find(r => r.definition.id === s.id), decision = decisions.find(d => d.id === s.id);
      const declared = s.agents.map(a => observations.get(a.name)?.declaredSha).filter((sha): sha is string => Boolean(sha));
      const desiredSha = decision?.desiredSha ?? resolved?.sha;
      const appliedSha = reportedAppliedSha(decision, declared.length && declared.every(sha => sha === declared[0]) ? declared[0] : undefined, Boolean(skipped));
      return { id: s.id, ref: s.ref, ...(desiredSha ? { desiredSha } : {}), ...(appliedSha ? { appliedSha } : {}),
        ...(decision?.carried ? { effectiveSha: decision.effectiveSha, reason: decision.reason } : {}) };
    }),
    agents: plan.sources.flatMap(s => s.agents.map(a => {
      const resolved = resolvedSources.find(r => r.definition.id === s.id), seen = observations.get(a.name), decision = decisions.find(d => d.id === s.id);
      const desiredSha = decision?.desiredSha ?? resolved?.sha, appliedSha = reportedAppliedSha(decision, seen?.declaredSha, Boolean(skipped));
      return { name: a.name, source: s.id, ...(desiredSha ? { desiredSha } : {}), ...(appliedSha ? { appliedSha } : {}),
        ...(decision?.carried ? { effectiveSha: decision.effectiveSha } : {}), ...effectiveRuntimeFacts(plan, a), ...(seen ? { ready: seen.ready } : {}) };
    })),
    ...(skipped ? { skipped } : {}),
    ...(gate?.findings.length ? { findings: gate.findings } : {}), ...(gate?.access.length ? { access: gate.access } : {}),
  });
  const conclude = (ledger: unknown, stage: Stage | "complete", pendingInfo?: Pending, exitCode?: 0 | 75 | 1, gate?: CredentialGateError): void => {
    console.log(JSON.stringify({ ...(ledger as object), report: report(stage, pendingInfo, gate) }, null, 2));
    if (exitCode === 75) throw new CliError(`Team installation is pending (${pendingInfo?.reason ?? "unknown"}) at ${stage}: ${pendingInfo?.link ?? "see the report"}`, 75);
    if (exitCode === 1) throw new CliError("Team installation failed; inspect team status and resume after repairing its reported stage", 1);
  };
  if (sub === "status") {
    const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")) : { complete: false, installation: plan.id, stages: {}, summary: "No apply has run" };
    // Read-only by construction: status observes, never recovers, and never takes the
    // installation lock - it is safe while a resume is in flight (ADR 0195).
    // A lock that does not describe THIS plan is not this installation's intent: an unverified
    // one would let a stale deployment pass. Refusing it leaves every locked field unknown.
    let lock: InstallationLock | undefined, lockProblem: string | undefined;
    try {
      lock = plan.version === 2 && plan.lock ? readLock(lockPath(root, plan.lock)) : undefined;
      if (lock) verifyLock(plan, lock);
    } catch (error) {
      lock = undefined;
      lockProblem = error instanceof Error ? error.message : String(error);
    }
    // Observation only: no diagnostics are written, and no installation lock is taken.
    delete process.env.HG_TEAM_DIAGNOSTICS_DIR;
    const watcher = await observeWatcher(plan).catch(() => undefined);
    const agents: AgentStatus[] = [];
    for (const source of plan.sources) for (const agent of source.agents) {
      const observed = await observeAgent(plan, agent).catch((error): ObservedAgent => ({
        name: agent.name, namespace: `ag-eve-${agent.name}`, problems: [`the cluster could not be read: ${error instanceof Error ? error.message : String(error)}`],
      }));
      observed.watcher = watcher;
      if (lockProblem) observed.problems.push(`the installation lock does not describe this plan (${lockProblem})`);
      const fields = classifyAgent(observed, desiredAgent(plan, source, agent, lock, observed.deployedOverlayDigest, readApplied(ledger.applied)?.sources[source.id]));
      agents.push({ agent: agent.name, source: source.id, namespace: observed.namespace, fields, verdict: agentVerdict(fields) });
    }
    const exitCode = statusExitCode(agents);
    if (json) console.log(JSON.stringify({ apiVersion: "team-status.hermes-gitops.factorylevel.dev/v1alpha1", kind: "TeamStatus",
      installation: plan.id, observedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), verdict: agents.some(a => a.verdict === "fail") ? "fail" : agents.some(a => a.verdict === "unknown") ? "unknown" : "pass", agents, ledger }, null, 2));
    else {
      console.log(JSON.stringify(ledger, null, 2));
      console.log("");
      console.log(renderStatusTable(agents));
    }
    if (exitCode !== 0) throw new CliError(exitCode === 1 ? "Team installation is not running what it intends; inspect the reported fields" : "Team installation cannot be proven at its intended version; evidence is missing", exitCode);
    return;
  }
  if (sub === "compile") {
    if (plan.version !== 2 || !plan.lock) throw new CliError("team compile requires an installation plan version 2 that names its lock");
    await credentialPreflight(plan, root, "compile");
    const file = lockPath(root, plan.lock);
    let previous: InstallationLock | undefined;
    try { previous = fs.existsSync(file) ? readLock(file) : undefined; } catch { previous = undefined; }
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hg-team-lock-"));
    try {
      const lock = await compileLock(plan, async target => (await resolveRef(target, scratch)).sha, previous);
      writeLockFile(file, renderLock(lock));
      console.log(JSON.stringify({ installation: plan.id, lock: path.relative(root, file), planDigest: lock.planDigest,
        sources: plan.sources.map(s => ({ id: s.id, ref: s.ref, commit: lock.sources[s.id]!.commit, changed: previous?.sources[s.id]?.commit !== lock.sources[s.id]!.commit })),
        ...(lock.platform ? { platform: { ...lock.platform, changed: previous?.platform?.revision !== lock.platform.revision } } : {}) }, null, 2));
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    return;
  }
  if (sub === "overlays") {
    // Read-only apart from the new review stage: nothing is approved, published or provisioned here.
    const lock = plan.version === 2 && plan.lock ? readLock(lockPath(root, plan.lock)) : undefined;
    if (lock) verifyLock(plan, lock);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hg-team-overlays-"));
    const stageRoot = path.resolve(opts.stage ?? path.join(HG_HOME, "overlay-reviews", `${plan.id}-${Date.now()}`));
    try {
      const sources = await resolveSources(plan, scratch, lock);
      const reviews: { agent: string; subject: string; fingerprint: string; overlays: number; reviewFile: string }[] = [];
      for (const source of sources) for (const agent of source.definition.agents) {
        const resolved = await resolveAgentOverlays(source, agent, scratch);
        if (!resolved) continue;
        reviews.push({ agent: agent.name, subject: resolved.subject, fingerprint: resolved.fingerprint, overlays: resolved.overlays.length,
          reviewFile: stageOverlayReview(resolved, path.join(stageRoot, agent.name)) });
      }
      console.log(JSON.stringify({ installation: plan.id, stage: stageRoot, reviews }, null, 2));
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    return;
  }
  // The same installation lock covers direct apply and every source watcher.
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  process.env.HG_TEAM_DIAGNOSTICS_DIR = path.join(stateRoot, "diagnostics");
  const lock = path.join(stateRoot, "lock");
  if (sub !== "plan" && process.env.HG_TEAM_LOCK !== lock) {
    if (unattended) {
      // The child's stdout IS the report: forward it, and when the child never wrote one (the lock
      // was held, or it died) write a minimal report so the watcher always gets one document.
      const child = Bun.spawnSync(["flock", "--nonblock", "-E", "75", lock, process.execPath, path.join(PLATFORM_ROOT, "cli/src/main.ts"), "team", sub,
        "--plan", planFile, "--dir", root, "--unattended", ...(json ? ["--json"] : [])], { cwd: root, env: { ...process.env, HG_TEAM_LOCK: lock }, stdout: "pipe", stderr: "inherit", stdin: "ignore", timeout: 3_600_000 });
      const output = child.stdout.toString();
      process.stdout.write(output);
      const code = child.signalCode ? 1 : child.exitCode ?? 1;
      const wrote = /\n?\{[\s\S]*"report"[\s\S]*\}\s*$/.test(output);
      if (!wrote) conclude({ complete: false, installation: plan.id }, "validated", code === 75 ? { reason: "in-flight" } : undefined);
      if (code === 75) throw new CliError(`team ${plan.id}: another run holds the installation lock, or the run is pending`, 75);
      if (code !== 0) throw new CliError(`team ${plan.id}: unattended resume failed (exit ${code})`, 1);
      return;
    }
    const progress = setInterval(() => console.error(`team ${plan.id}: ${sub} is running; inspect team status for current stage`), 45_000);
    try {
      const output = await run(["flock", "--nonblock", lock, process.execPath, path.join(PLATFORM_ROOT, "cli/src/main.ts"), "team", sub,
      "--plan", planFile, "--dir", root, ...(json ? ["--json"] : [])], root, { ...process.env, HG_TEAM_LOCK: lock }, 3_600_000);
      process.stdout.write(output); return;
    } catch (error) {
      if (["apply", "resume"].includes(sub) && fs.existsSync(ledgerFile)) {
        const text = fs.readFileSync(ledgerFile, "utf8");
        process.stdout.write(`${text}\n`);
        // The locked child's stderr went to private diagnostics. A validated refusal's summary is
        // either a named credential failure (ADR 0196, names and paths only) or the generic pointer.
        try {
          const last = JSON.parse(text).history?.at(-1);
          if (last?.stage === "validated" && last.verdict === "fail" && typeof last.summary === "string") console.error(last.summary);
        } catch { /* the ledger printed above is the evidence */ }
      }
      throw error;
    } finally { clearInterval(progress); }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hg-team-"));
  let enteredStages = false;
  // The ledger as the last run left it: what a content-only commit carries forward from (ADR 0198).
  let prior: Partial<Ledger> | undefined;
  if (["plan", "publish"].includes(sub) && fs.existsSync(ledgerFile)) {
    try { prior = JSON.parse(fs.readFileSync(ledgerFile, "utf8")); } catch { prior = undefined; }
  }
  if (["apply", "resume"].includes(sub) && fs.existsSync(ledgerFile)) {
    const previous = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    prior = structuredClone(previous);
    previous.complete = false;
    previous.skipped = undefined;
    previous.running = { stage: "validated", startedAt: new Date().toISOString(), pid: process.pid };
    saveLedger(ledgerFile, previous);
  }
  const heartbeat = setInterval(() => console.error(`team ${plan.id}: ${sub} is running; stage evidence is in ${ledgerFile}`), 45_000);
  try {
    const lock = plan.version === 2 && plan.lock ? readLock(lockPath(root, plan.lock)) : undefined;
    if (lock) verifyLock(plan, lock);
    else if (["apply", "resume", "publish"].includes(sub)) console.error(`team ${plan.id}: version 1 plan - sources track moving refs and publish whatever they resolve to now; migrate to version 2 with a committed installation lock`);
    // Access, then completeness, before any credential is read (ADR 0196).
    await credentialPreflight(plan, root, sub as "plan" | "apply" | "resume" | "publish");
    await readBootstrapInputs(plan, root);
    // A source whose agent inputs are unchanged since its deployed commit keeps that commit
    // (ADR 0198); its new tree still compiles, so anything else it changed still counts.
    const carried = carryForward(plan, await resolveSources(plan, scratch, lock), prior?.applied, { lock, bootstrapRoot: root, log: line => console.error(`team ${plan.id}: ${line}`) });
    const sources = carried.sources;
    resolvedSources = sources;
    decisions = carried.decisions;
    for (const source of sources) for (const agent of source.definition.agents) validateRuntimeSource(source, agent, effectiveRuntime(plan, agent).eveVersion);
    const skillApprovals = sources.flatMap(source => source.definition.agents.map(agent => verifySourceApproval(plan, root, source, agent)));
    // Operator overlays (ADR 0194): fetched, hashed and merged into a copy of each source, checked
    // like authored code, and approved by a named human before anything renders.
    const overlaysByAgent = new Map<string, ResolvedOverlays>();
    const overlayApprovals: string[] = [];
    for (const source of sources) for (const agent of source.definition.agents) {
      const resolved = await resolveAgentOverlays(source, agent, scratch);
      if (!resolved) continue;
      const view = overlaidRuntime(source, agent, resolved);
      validateRuntimeSource(view.source, view.agent, effectiveRuntime(plan, agent).eveVersion);
      overlayApprovals.push(verifyOverlayApproval(root, source, resolved));
      overlaysByAgent.set(agent.name, resolved);
    }
    const projection = await compileResolved(plan, root, sources, overlaysByAgent);
    // Every required envRequires entry of every rendered record reaches its pod Secret (ADR 0196).
    assertRequirementsDelivered(plan, root, sources, projection.files);
    const input = digest({ plan, lock, projection: projection.fingerprint, versions, skillApprovals, ...(overlayApprovals.length ? { overlayApprovals } : {}),
      runtimeValidator: digest(fs.readFileSync(path.join(PLATFORM_ROOT, "cli/src/team/runtime.ts"), "utf8")),
      baselines: [...(plan.credentials ? [plan.credentials.configFile] : []), ...(plan.integrations ?? []).map(i => i.configFile)].map(file => [file, digest(fs.readFileSync(localFile(root, file), "utf8"))]) });
    const credentials = credentialFingerprint(plan);
    // A resume with nothing to roll out stops here: no destination preview, no stage.
    const skipping = sub === "resume" ? skipReason(prior, input, credentials, decisions) : undefined;
    const preview = skipping ? undefined : await previewProjection(plan, projection, fs.mkdtempSync(path.join(scratch, "preview-")), process.env[plan.destination.credentialEnv]);
    const runtimeProofFile = path.join(stateRoot, `runtime-${input}.json`);
    const runtimeEnvironment = () => credentialFingerprint(plan);
    const verifyRuntime = async () => {
      const environment = runtimeEnvironment();
      if (fs.existsSync(runtimeProofFile)) {
        const proof = JSON.parse(fs.readFileSync(runtimeProofFile, "utf8"));
        if (proof.input === input && proof.environment === environment && proof.verdict === "pass") return pass("Reused production startup evidence for identical source, image and environment inputs");
      }
      for (const source of sources) for (const agent of source.definition.agents) {
        const values = projection.files.get(`deployments/agents/${agent.name}/values.yaml`);
        const capabilities = values ? parse(String(values))?.spec?.env ?? {} : {};
        const view = overlaidRuntime(source, agent, overlaysByAgent.get(agent.name));
        await verifyProductionRuntime(plan, view.source, view.agent, undefined, capabilities);
      }
      fs.writeFileSync(runtimeProofFile, JSON.stringify({ input, environment, verdict: "pass", verifiedAt: new Date().toISOString() }), { mode: 0o600 });
      return pass("Every agent built and reached health in the production image/backend");
    };
    if (sub === "plan") {
      console.log(JSON.stringify({ installation: plan.id, input, ...(plan.lock ? { lock: plan.lock } : {}),
        ...(overlaysByAgent.size ? { overlays: [...overlaysByAgent.values()].map(r => ({ agent: r.agent, subject: r.subject, fingerprint: r.fingerprint, digest: r.digest })) } : {}), profiles: projection.profiles,
        sources: sources.map(s => {
          const decision = decisions.find(d => d.id === s.definition.id);
          return { id: s.definition.id, sha: s.sha, ...(decision?.carried ? { desiredSha: decision.desiredSha, reason: decision.reason } : {}) };
        }), destination: { ...preview!, diff: scrub(preview!.diff, [...declaredSecrets].map(key => process.env[key]).filter((value): value is string => Boolean(value))) }, files: [...projection.files.keys()].sort(), authorizations: plan.authorizations }, null, 2)); return;
    }
    const publish = async (): Promise<Evidence> => {
      if (!plan.authorizations.includes("publish")) return pending("authorization", "Publication is outside the recorded authorization");
      const token = process.env[plan.destination.credentialEnv];
      if (!token) return pending("authorization", "Destination credential reference is unavailable");
      await verifyRuntime();
      const checkout = fs.mkdtempSync(path.join(scratch, "destination-"));
      const result = await publishProjection(plan, projection, checkout, token);
      return result.state === "pending" ? pending("merge-pending", `Generated PR awaits required review/checks: ${result.pullRequest}`, result.pullRequest) : pass("Complete projection published", [result.revision, ...(result.pullRequest ? [result.pullRequest] : [])]);
    };
    /** Activation gates a watcher may not flip on its own: any declared gate not already enabled,
     * whether the plan requests it or the committed baseline would carry it through provisioning. */
    const activationPending = (): boolean => {
      const bootstrapDir = localFile(root, plan.bootstrap.directory);
      const already = enabled(stateRoot, bootstrapDir, plan.bootstrap.stack);
      const baseline = plan.credentials ? parse(fs.readFileSync(localFile(root, plan.credentials.configFile), "utf8")) : undefined;
      for (const [key, value] of Object.entries(plan.activeConfig ?? {})) {
        if (already[key]) continue;
        if (value === true || value === "true") return true;
        if (baseline && provisioningGate(baseline, key, false)) return true;
      }
      for (const integration of plan.integrations ?? []) {
        const seen = enabled(stateRoot, localFile(root, integration.directory), integration.stack);
        for (const [key, value] of Object.entries(integration.activate)) if (value && !seen[key]) return true;
      }
      return false;
    };
    const observePublication = async (): Promise<Evidence> => {
      const token = process.env[plan.destination.credentialEnv];
      if (!token) return unknown("Destination credential reference is unavailable");
      const checkout = fs.mkdtempSync(path.join(scratch, "observe-"));
      await run(["git", "clone", "--single-branch", "--branch", plan.destination.branch, "--", plan.destination.repository, checkout], scratch, gitEnvironment(token));
      const manifest = path.join(checkout, OWNERSHIP_FILE);
      if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, "utf8")).fingerprint !== projection.fingerprint) return unknown("Desired projection has not merged");
      for (const [file, content] of projection.files) {
        const target = path.join(checkout, file);
        if (!fs.existsSync(target) || !fs.readFileSync(target).equals(Buffer.from(content))) return unknown(`Generated drift at ${file}`);
      }
      return pass("Destination contains the exact complete projection");
    };
    if (sub === "publish") {
      const result = await publish(); console.log(JSON.stringify(result, null, 2));
      if (result.verdict !== "pass") throw new CliError("Team publication remains incomplete"); return;
    }
    const runPulumiUp = async (active: boolean) => {
      const config = await bootstrapConfig(plan, root, stateRoot, active, lock);
      await run(["pulumi", "up", "--stack", plan.bootstrap.stack, ...(config ? ["--config-file", config] : []), "--yes", "--suppress-outputs"], localFile(root, plan.bootstrap.directory), { ...pulumiEnvironment(plan, root), HG_TEAM_COORDINATED: "1" }, 1_800_000);
    };
    const operations: Record<Stage, StageOperation> = {
      validated: { probe: async () => pass("Source and projection revalidated"), apply: async () => pass("All source, capability and complete projection checks passed") },
      "runtime-verified": { probe: async () => {
        try { await readIntegrationOutputs(plan, root); }
        catch { return unknown("Integration outputs are not ready; provisioning is required"); }
        if (!fs.existsSync(runtimeProofFile)) return unknown("Production startup evidence is missing");
        const proof = JSON.parse(fs.readFileSync(runtimeProofFile, "utf8"));
        return proof.input === input && proof.environment === runtimeEnvironment() && proof.verdict === "pass"
          ? pass("Production startup evidence still matches source, image and runtime environment") : unknown("Runtime inputs changed");
      }, apply: async () => {
        if (plan.integrations?.length) await applyIntegrations(plan, root, stateRoot, "provision");
        return verifyRuntime();
      } },
      provisioned: { probe: async () => {
        // Re-encrypt today's credential values, never yesterday's temporary copy: a rotated
        // secret must show up as a pending change and re-provision rather than stay applied.
        const config = await bootstrapConfig(plan, root, stateRoot, false, lock);
        try {
          await run(["pulumi", "preview", "--stack", plan.bootstrap.stack, ...(config ? ["--config-file", config] : []), "--expect-no-changes", "--suppress-outputs"], localFile(root, plan.bootstrap.directory), { ...pulumiEnvironment(plan, root), HG_TEAM_COORDINATED: "1" }, 900_000);
        } catch (error) {
          return unknown(`Bootstrap preview reports pending changes or could not run; re-provisioning (${error instanceof CliError ? error.message : String(error)})`);
        }
        return pass("Bootstrap preview confirms no pending resource changes");
      }, apply: async () => {
        if (!plan.authorizations.includes("provision")) return pending("authorization", "Provisioning is outside the recorded authorization");
        // Provisioning carries baseline gates forward; unattended, an unrecorded gate waits.
        if (unattended && activationPending()) return pending("activation-change", "Activation inputs changed since the last attended apply; run hg team apply to activate them");
        await runPulumiUp(false);
        return pass("Bootstrap apply succeeded; workload readiness is checked separately");
      } },
      published: { probe: observePublication, apply: publish },
      ready: { probe: () => readiness(plan, sources, undefined, overlaysByAgent, observations), apply: () => waitReady(plan, sources, stateRoot, overlaysByAgent, observations) },
      "transport-verified": { probe: () => transport(plan), apply: () => transport(plan) },
      active: { apply: async () => {
        if (!plan.sources.some(s => s.agents.some(a => a.slack)) && !Object.keys(plan.activeConfig ?? {}).length) return pass("No external channel activation is declared");
        if (!plan.authorizations.includes("activate")) return pending("authorization", "Activation is outside the recorded authorization");
        if (plan.sources.some(s => s.agents.some(a => a.slack)) && !plan.integrations?.some(i => Object.keys(i.activate).length)) return pending("authorization", "Declare the integration owner's subscription activation gates before activation");
        // A watcher never flips an activation gate a person has not already turned on: a changed
        // gate waits for an attended apply (ADR 0191).
        if (unattended && activationPending()) return pending("activation-change", "Activation inputs changed since the last attended apply; run hg team apply to activate them");
        await applyIntegrations(plan, root, stateRoot, "activate");
        await runPulumiUp(true);
        recordEnabled(stateRoot, localFile(root, plan.bootstrap.directory), plan.bootstrap.stack, plan.activeConfig ?? {});
        const health = await waitReady(plan, sources, stateRoot, overlaysByAgent, observations);
        if (health.verdict !== "pass") return health;
        return transport(plan);
      } },
      "acceptance-verified": { apply: async () => {
        if (!plan.authorizations.includes("acceptance")) return pending("authorization", "Live acceptance is outside the recorded authorization");
        const receipts: string[] = [];
        const dependencies = credentialFingerprint(plan);
        for (const scenario of plan.acceptance) {
          const evidenceFile = path.join(stateRoot, `acceptance-${input}-${scenario.id}.json`);
          if (fs.existsSync(evidenceFile)) {
            const saved = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
            if (scenario.effect === "write" && saved.input === input && saved.dependencies === dependencies && saved.verdict === "pass") { receipts.push(saved.receipt); continue; }
          }
          // A write scenario has side effects: unattended, it runs only when the plan opted in.
          if (unattended && scenario.effect === "write" && !scenario.unattended) return pending("acceptance-opt-in", `Scenario ${scenario.id} writes and is not marked unattended: true; run hg team apply, or opt it in`);
          const ns = `ag-eve-${scenario.agent}`;
          const output = await run(["kubectl", "--context", plan.kubeContext, "-n", ns, "exec", `statefulset/${ns}`, "--", "env", `HG_TEAM_ACCEPTANCE_ID=${input}:${scenario.id}`, ...scenario.argv], root, process.env, 300_000);
          const result = JSON.parse(output);
          // The scenario RAN and did not pass: that is a failure of the deployed team, never a wait.
          if (result.ok !== true || !Array.isArray(result.checks) || !result.checks.length || result.checks.some((check: any) => check.verdict !== "pass") || !Array.isArray(result.receipts) || !result.receipts.length) return { verdict: "fail", summary: `Scenario ${scenario.id}: no passing live evidence or receipts` };
          // Store only a digest of provider output; receipts can contain private text.
          const receipt = `${scenario.id}:${digest(result)}`;
          fs.writeFileSync(evidenceFile, JSON.stringify({ input, dependencies, verdict: "pass", receipt }), { mode: 0o600 });
          receipts.push(receipt);
        }
        return pass("Every declared role and skill scenario passed in its deployed workload", receipts);
      } },
    };
    enteredStages = true;
    const settled = await runOrSkip({ ledgerFile, installation: plan.id, input, credentials, prior, decisions, operations,
      allowSkip: sub === "resume", report: stage => console.error(`team ${plan.id}: ${stage}`) });
    const result = settled.ledger;
    skipped = settled.skipped;
    if (skipped) console.error(`team ${plan.id}: nothing to roll out - ${skipped}`);
    if (unattended) {
      const halted = haltedStage(result.stages);
      conclude(result, result.complete ? "complete" : halted!.stage, halted?.evidence.pending, unattendedExitCode(result.complete, halted));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) throw new CliError("Team installation is incomplete; inspect team status and resume after resolving its reported stage");
  } catch (error) {
    if (!enteredStages && ["apply", "resume"].includes(sub)) {
      const previous = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")) : readLedger(ledgerFile, plan.id, digest(plan));
      const now = new Date().toISOString();
      // A missing human approval is a decision, not a defect: unattended, it is pending (exit 75).
      const approval = unattended && error instanceof ApprovalRequired;
      // A named credential failure carries only names, paths and fixes, so it is the evidence;
      // anything else may echo provider output and stays behind the generic pointer.
      const named = error instanceof CredentialGateError || error instanceof StackConfigError || (error instanceof ChildFailed && error.failure) ? (error as Error).message : undefined;
      const failed = approval
        ? { stage: "validated", input: previous.input, startedAt: now, finishedAt: now, verdict: "unknown", summary: `Human approval required for ${error.subject}`, pending: { reason: "approval-required" as const } }
        : { stage: "validated", input: previous.input, startedAt: now, finishedAt: now, verdict: "fail", summary: named ?? "Source or destination preflight failed before provisioning; inspect private diagnostics" };
      // Stage evidence stays: nothing was mutated, so a transient preflight failure must not force
      // provisioning and publication to rerun on resume. The history records the failure.
      previous.complete = false; previous.running = undefined; previous.updatedAt = now; previous.history.push(failed);
      saveLedger(ledgerFile, previous);
      if (approval) conclude(previous, "validated", { reason: "approval-required" }, 75);
      if (unattended && named) console.error(named);
      if (unattended) conclude(previous, "validated", undefined, 1, error instanceof CredentialGateError ? error : undefined);
    }
    if (unattended && !(error instanceof CliError && error.exitCode)) throw new CliError(error instanceof Error ? error.message : String(error), 1);
    throw error;
  } finally { clearInterval(heartbeat); fs.rmSync(scratch, { recursive: true, force: true }); }
}
