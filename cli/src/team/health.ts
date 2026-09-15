// Live agent health at the intended version (ADR 0195).
//
// `hg team status` used to print an operator-local ledger: what the last apply
// on THIS machine decided. That says nothing about the cluster, and nothing at
// all on a machine that never ran the apply. This observes the cluster instead,
// and classifies each agent field by field against what the installation
// intends - the lock, not the ledger.
//
// Two rules hold everywhere here:
//   - Observation NEVER recovers, never writes, and never takes the
//     installation lock. Status is safe to run while a resume is in flight.
//   - Evidence that could not be read is `unknown` WITH ITS REASON, never a
//     pass and never a failure. A missing receipt is not a broken agent; it is
//     an agent we cannot yet vouch for.
import type { InstallationLock } from "./lock.ts";
import type { TeamPlan, TeamSource } from "./plan.ts";
import { effectiveRuntime } from "./runtime.ts";
import { run, type Run } from "./process.ts";

export type Verdict = "pass" | "fail" | "unknown";
/** A field may also be not-applicable: evidence that was looked for and does not exist for this
 * installation. It never counts toward a verdict, and never stands in for a failed lookup. */
export type FieldVerdict = Verdict | "not-applicable";

export interface FieldStatus {
  desired?: string;
  running?: string;
  verdict: FieldVerdict;
  /** Why this is unknown, or what differs. Always set unless the field passed. */
  reason?: string;
}

export interface ObservedAgent {
  name: string;
  namespace: string;
  /** `syncedRevisions` is what the Application is synced to now; `smokeHook` is the PostSync hook
   * result Argo CD recorded for its last operation, and the revisions that operation synced. */
  argo?: { sync?: string; health?: string; syncedRevisions?: string[] | undefined;
    smokeHook?: { phase: string; revisions: string[] } };
  /** `imageID` is the digest-qualified image Kubernetes reports the container is running. */
  pod?: { ready: boolean; revision?: string; image?: string; imageID?: string; phase?: string };
  updateRevision?: string;
  /** The build receipt the init container published through its termination message. */
  receipt?: Record<string, unknown>;
  /** The overlay digest the rendered workload carries, when it declares overlays. */
  deployedOverlayDigest?: string;
  smoke?: { state: "succeeded" | "failed" | "running" | "absent" | "unreadable"; reason?: string; sourceSha?: string };
  /** Whether the StatefulSet itself was read: absence of a fact is only a fact if we looked. */
  workloadRead?: boolean;
  /** `absent` means the lookup succeeded and no watcher publishes for this installation. An
   * undefined watcher means the lookup itself could not be made. */
  watcher?: { phase?: string; appliedSha?: string; observedAt?: string; reason?: string; absent?: boolean };
  /** Anything that could not be read at all - each becomes an `unknown` field. */
  problems: string[];
}

export interface DesiredAgent {
  sourceSha?: string;
  eveVersion?: string;
  image?: string;
  overlayDigest?: string;
}

/** The columns `hg team status` prints, in order. */
export const STATUS_FIELDS = ["argo", "ready", "source", "overlay", "eve", "image", "smoke", "watcher"] as const;
export type StatusField = (typeof STATUS_FIELDS)[number];

export interface AgentStatus {
  agent: string;
  source: string;
  namespace: string;
  fields: Record<StatusField, FieldStatus>;
  verdict: Verdict;
}

/** The contract bounds a reason at 500 characters; a reason built from cluster text must obey it. */
const bounded = (reason: string): string => (reason.length > 500 ? `${reason.slice(0, 497)}...` : reason);
const unknown = (reason: string, desired?: string, running?: string): FieldStatus =>
  ({ verdict: "unknown", reason: bounded(reason), ...(desired ? { desired } : {}), ...(running ? { running } : {}) });
const pass = (desired?: string, running?: string): FieldStatus =>
  ({ verdict: "pass", ...(desired ? { desired } : {}), ...(running ? { running } : {}) });
const notApplicable = (reason: string): FieldStatus => ({ verdict: "not-applicable", reason: bounded(reason) });
const fail = (reason: string, desired?: string, running?: string): FieldStatus =>
  ({ verdict: "fail", reason: bounded(reason), ...(desired ? { desired } : {}), ...(running ? { running } : {}) });

/** What the installation intends for one agent: the lock is the authority, never the ledger. */
export function desiredAgent(plan: TeamPlan, source: TeamSource, agent: TeamSource["agents"][number],
  lock?: InstallationLock, deployedOverlayDigest?: string, applied?: { desiredSha: string; effectiveSha: string }): DesiredAgent {
  const runtime = effectiveRuntime(plan, agent);
  const locked = lock?.sources[source.id]?.commit;
  return {
    // The lock stays the authority. The one exception is a locked commit applied without a
    // rollout (ADR 0198): its agent inputs equal the deployed commit's, so that earlier commit is
    // what the workload should have built. Only a record naming exactly the locked commit counts.
    sourceSha: locked && applied?.desiredSha === locked ? applied.effectiveSha : locked,
    eveVersion: lock?.agents?.[agent.name]?.eveVersion ?? runtime.eveVersion,
    image: lock?.agents?.[agent.name]?.image ?? runtime.image,
    // The approved overlay digest only exists once the workload renders it; an
    // installation with no overlays has none, which is not missing evidence.
    overlayDigest: deployedOverlayDigest,
  };
}

/** Pure: observed facts against intended values. No I/O, so every verdict is testable. */
export function classifyAgent(observed: ObservedAgent, desired: DesiredAgent): AgentStatus["fields"] {
  const receipt = observed.receipt;
  const built = (field: string): string | undefined => {
    const value = receipt?.[field];
    return typeof value === "string" && value ? value : undefined;
  };
  const versus = (label: string, want: string | undefined, got: string | undefined, missing: string): FieldStatus => {
    if (!want) return unknown(`no intended ${label} to compare against; the installation lock records none`, want, got);
    if (!got) return unknown(missing, want, got);
    return want === got ? pass(want, got) : fail(`the intended ${label} is not what this agent built`, want, got);
  };
  const noReceipt = "the build container published no receipt; this agent cannot prove what it built";

  const argo = observed.argo?.sync
    ? observed.argo.sync === "Synced"
      ? pass(undefined, `${observed.argo.sync}/${observed.argo.health ?? "?"}`)
      : fail("Argo CD has not synchronized the desired workload", "Synced", `${observed.argo.sync}/${observed.argo.health ?? "?"}`)
    : unknown("no Argo CD Application for this agent could be read");

  let ready: FieldStatus;
  if (!observed.pod) ready = unknown("no pod owned by this agent's workload could be read");
  // Both revisions or neither: a Ready pod whose workload could not be read proves nothing
  // about whether it is the revision this installation wants.
  else if (!observed.updateRevision || !observed.pod.revision) {
    ready = unknown("the workload's update revision could not be read, so a Ready pod proves nothing about which revision it runs",
      observed.updateRevision, observed.pod.revision);
  } else if (observed.pod.revision !== observed.updateRevision) {
    ready = fail("the running pod is not the revision the workload wants", observed.updateRevision, observed.pod.revision);
  } else ready = observed.pod.ready ? pass(undefined, "Ready") : fail("the pod is not ready", undefined, observed.pod.phase ?? "NotReady");

  // An overlay digest is intended only where the workload declares overlays - but "declares
  // none" is a fact that has to be READ. An unreadable workload, or a build we have no receipt
  // for, cannot establish the absence of overlays.
  let overlay: FieldStatus;
  if (!observed.workloadRead) overlay = unknown("the workload could not be read, so whether it declares operator overlays is unknown");
  else if (!receipt) overlay = unknown(noReceipt, desired.overlayDigest ?? "none");
  else if (desired.overlayDigest) overlay = versus("overlay digest", desired.overlayDigest, built("overlayDigest"), noReceipt);
  else if (built("overlayDigest")) overlay = fail("this agent built operator overlays the workload does not declare", "none", built("overlayDigest"));
  else overlay = pass("none", "none");

  let smoke: FieldStatus;
  const hook = observed.argo?.smokeHook, synced = observed.argo?.syncedRevisions;
  if (!observed.smoke || observed.smoke.state === "unreadable") {
    smoke = unknown(observed.smoke?.reason ?? "the smoke hook Job could not be read");
  } else if (observed.smoke.state === "absent") {
    // The hook Job deletes itself on success, so its absence alone is ambiguous. Argo CD keeps
    // the hook's result on the Application - but it only speaks for THIS sync when the operation
    // that ran it synced exactly the revisions the Application is synced to now.
    const sameSync = Boolean(hook && synced?.length && hook.revisions.length === synced.length &&
      hook.revisions.every((r, i) => r === synced[i]));
    if (!hook) smoke = unknown(observed.smoke?.reason ?? "no smoke hook Job is present and Argo CD recorded no hook result; this proves nothing either way");
    else if (!sameSync) smoke = unknown("the smoke hook result Argo CD recorded is from an earlier sync, not the revision synced now", synced?.join(","), hook.revisions.join(","));
    else if (hook.phase === "Succeeded") smoke = pass(undefined, "Succeeded");
    else if (hook.phase === "Failed" || hook.phase === "Error") smoke = fail("the PostSync smoke check failed this sync", undefined, hook.phase);
    else smoke = unknown("the smoke check has not finished", undefined, hook.phase);
  } else if (desired.sourceSha && observed.smoke.sourceSha && observed.smoke.sourceSha !== desired.sourceSha) {
    // A retained Job from an earlier sync says nothing about this one.
    smoke = unknown(`the smoke hook present is from an earlier sync (${observed.smoke.sourceSha.slice(0, 12)}), not this one`,
      desired.sourceSha, observed.smoke.sourceSha);
  } else if (observed.smoke.state === "succeeded") smoke = pass(undefined, "Succeeded");
  else if (observed.smoke.state === "failed") smoke = fail("the PostSync smoke check failed this sync", undefined, "Failed");
  else smoke = unknown("the smoke check has not finished", undefined, "Running");

  const watcher = !observed.watcher
    ? unknown("the watcher status lookup could not be made, so whether a watcher runs is unknown")
    : observed.watcher.absent
      ? notApplicable("no watcher publishes a status for this installation; the verdict does not wait for one")
    : observed.watcher.phase === "failed" || observed.watcher.phase === "degraded"
      ? fail(observed.watcher.reason ?? `the watcher reports ${observed.watcher.phase}`, undefined, observed.watcher.phase)
      : observed.watcher.phase === "synced"
        // `appliedSha` is the BOOTSTRAP commit the watcher applied, not this agent's source
        // commit: reported as context, never compared against the source lock.
        ? pass(undefined, `synced at ${observed.watcher.appliedSha?.slice(0, 12) ?? "an unrecorded commit"}`)
        : unknown(observed.watcher.reason ?? `the watcher reports ${observed.watcher.phase ?? "no phase"}`, undefined, observed.watcher.phase);

  return {
    argo, ready, overlay, smoke, watcher,
    source: versus("source commit", desired.sourceSha, built("sourceSha"), noReceipt),
    eve: versus("Eve release", desired.eveVersion, built("eveVersion"), noReceipt),
    image: runtimeImage(desired.image, observed.pod),
  };
}

/** The image is what the pod actually runs, not what the receipt claims - and "runs" means the
 * digest Kubernetes reports, since a tag (a local build name, or a moved registry tag) names
 * nothing immutable. Falls back to the spec image only when either digest is unknown. */
function runtimeImage(desired: string | undefined, pod: ObservedAgent["pod"]): FieldStatus {
  if (!desired) return unknown("no intended runtime image to compare against; the installation lock records none");
  const want = desired.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  const id = pod?.imageID;
  if (want && id) {
    // `repo@sha256:` (with or without a docker-pullable:// prefix) is the registry digest the
    // lock names: equal proves it, different disproves it.
    const registry = id.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
    if (registry) return registry === want ? pass(want, registry) : fail("the pod is running a different image digest than the lock records", want, registry);
    // A bare `sha256:` (or containerd://sha256:) is an image id. Equal to the locked digest it
    // names the same bytes; different, it may just be a different KIND of digest - unknown.
    const bare = id.match(/^(?:[a-z-]+:\/\/)?(sha256:[a-f0-9]{64})$/)?.[1];
    if (bare === want) return pass(want, bare);
    if (bare) return unknown("the runtime reports an image id rather than a registry digest, so it cannot be compared with the lock", want, bare);
    // An imageID we cannot parse is still evidence: never fall back past it to the spec string.
    return unknown("the running image id is in a form that cannot be compared with the lock", want, id);
  }
  if (!pod?.image) return unknown("no pod image could be read", desired);
  return desired === pod.image ? pass(desired, pod.image) : fail("the intended runtime image is not what this agent runs", desired, pod.image);
}

/** One agent's verdict: any failure fails, else any unknown is unknown. Not-applicable fields
 * are evidence that does not exist for this installation, so they never count. */
export function agentVerdict(fields: AgentStatus["fields"]): Verdict {
  const values = Object.values(fields).filter((f) => f.verdict !== "not-applicable");
  if (values.some((f) => f.verdict === "fail")) return "fail";
  return values.some((f) => f.verdict === "unknown") ? "unknown" : "pass";
}

/** 0 everything passes, 1 anything failed, 2 nothing failed but something is unknown. */
export function statusExitCode(agents: AgentStatus[]): 0 | 1 | 2 {
  if (!agents.length) return 2;
  if (agents.some((a) => a.verdict === "fail")) return 1;
  return agents.some((a) => a.verdict === "unknown") ? 2 : 0;
}

/** Anything read from the cluster is untrusted input: only bounded strings reach a verdict. */
const text = (value: unknown, limit = 200): string | undefined =>
  typeof value === "string" && value ? value.slice(0, limit) : undefined;

const json = async (exec: Run, argv: string[]): Promise<any | undefined> => {
  try {
    return JSON.parse(await exec(argv, process.cwd()));
  } catch {
    return undefined;
  }
};

/** Read one agent's live facts. Never throws: what cannot be read becomes a problem note,
 * and every problem becomes an `unknown` field rather than an error. */
export async function observeAgent(plan: TeamPlan, agent: TeamSource["agents"][number], exec: Run = run): Promise<ObservedAgent> {
  const namespace = `ag-eve-${agent.name}`;
  const kubectl = (...args: string[]) => ["kubectl", "--context", plan.kubeContext, ...args];
  const observed: ObservedAgent = { name: agent.name, namespace, problems: [] };

  const application = await json(exec, kubectl("-n", "argocd", "get", "application", namespace, "-o", "json"));
  if (application) {
    // Whole lists or nothing: filtering out an unreadable entry would change the list's length
    // and let ["A", ""] match ["A"]. Any entry that is not a revision makes the list unusable.
    const revisions = (v: any): string[] | undefined => {
      const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : undefined;
      if (!list || !list.length) return undefined;
      const read = list.map((r: unknown) => text(r));
      return read.every((r): r is string => Boolean(r)) ? read : undefined;
    };
    const operation = application.status?.operationState;
    const hook = (operation?.syncResult?.resources ?? []).find((r: any) =>
      r?.kind === "Job" && r?.name === `${namespace}-smoke` && (r?.namespace ?? namespace) === namespace && r?.hookType === "PostSync");
    observed.argo = {
      sync: text(application.status?.sync?.status),
      health: text(application.status?.health?.status),
      syncedRevisions: revisions(application.status?.sync?.revisions ?? application.status?.sync?.revision),
      ...(hook && text(hook.hookPhase) ? { smokeHook: { phase: text(hook.hookPhase)!,
        revisions: revisions(operation?.syncResult?.revisions ?? operation?.syncResult?.revision) ?? [] } } : {}),
    };
  }
  else observed.problems.push(`no Argo CD Application ${namespace}`);

  const statefulSet = await json(exec, kubectl("-n", namespace, "get", "statefulset", namespace, "-o", "json"));
  if (statefulSet) {
    observed.workloadRead = true;
    observed.updateRevision = text(statefulSet.status?.updateRevision);
    observed.deployedOverlayDigest = text(statefulSet.spec?.template?.metadata?.annotations?.["harness-hg.factorylevel.dev/overlay-digest"]);
  } else observed.problems.push(`no StatefulSet ${namespace}`);

  const pods = await json(exec, kubectl("-n", namespace, "get", "pods", "-o", "json"));
  // Owned by the StatefulSet we actually read, by UID: a pod left by a deleted and recreated
  // controller carries the same name and would otherwise supply this agent's evidence.
  const uid = text(statefulSet?.metadata?.uid);
  const candidates = (pods?.items ?? []).filter((p: any) =>
    !p.metadata?.deletionTimestamp &&
    p.metadata?.ownerReferences?.some((o: any) => o.kind === "StatefulSet" && o.name === namespace && (!uid || o.uid === uid)));
  if (candidates.length > 1) observed.problems.push(`more than one live pod claims to be ${namespace}; none of them is evidence`);
  const pod = candidates.length === 1 ? candidates[0] : undefined;
  if (pod) {
    observed.pod = {
      ready: Boolean(pod.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True")),
      revision: text(pod.metadata?.labels?.["controller-revision-hash"]),
      image: text(pod.spec?.containers?.find((c: any) => c.name === "eve-agent")?.image, 500),
      imageID: text(pod.status?.containerStatuses?.find((c: any) => c.name === "eve-agent")?.imageID, 500),
      phase: text(pod.status?.phase),
    };
    // The build receipt rides the init container's termination message (ADR 0195),
    // so reading it needs no exec into the pod and no volume access.
    const build = (pod.status?.initContainerStatuses ?? []).find((c: any) => String(c.name).startsWith("build"));
    const message = build?.state?.terminated?.message ?? build?.lastState?.terminated?.message;
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) observed.receipt = parsed;
    } catch { /* no receipt: every receipt-backed field reports unknown with its reason */ }
  } else observed.problems.push(`no pod owned by StatefulSet ${namespace}`);

  const jobs = await json(exec, kubectl("-n", namespace, "get", "jobs", "-o", "json"));
  // A failed read is not an observed absence: a same-revision hook might still be running or
  // failing, so only a successful read that finds no Job lets Argo's record stand in for it.
  const smokeJob = Array.isArray(jobs?.items) ? jobs.items.find((j: any) => j.metadata?.name === `${namespace}-smoke`) : undefined;
  if (!Array.isArray(jobs?.items)) observed.smoke = { state: "unreadable", reason: "the smoke hook Job could not be read" };
  else if (!smokeJob) observed.smoke = { state: "absent" };
  else {
    // Terminal CONDITIONS, not attempt counters: `status.failed` counts attempts, so a Job
    // still retrying under backoffLimit would read as failed.
    const condition = (type: string) => (smokeJob.status?.conditions ?? []).some((c: any) => c.type === type && c.status === "True");
    const state = condition("Complete") ? "succeeded" : condition("Failed") ? "failed" : "running";
    // The sync a result belongs to: the hook carries the same version label the workload does.
    observed.smoke = { state, sourceSha: text(smokeJob.metadata?.labels?.["harness-hg.factorylevel.dev/source-sha"]) };
  }

  return observed;
}

/** The watcher's published reconciliation status for this installation, wherever it lives.
 * Labelled ConfigMaps are found cluster-wide so status does not need to know the
 * control-plane namespace. */
export async function observeWatcher(plan: TeamPlan, exec: Run = run): Promise<ObservedAgent["watcher"] | undefined> {
  const maps = await json(exec, ["kubectl", "--context", plan.kubeContext, "get", "configmap", "-A",
    "-l", "harness-hg.factorylevel.dev/phase", "-o", "json"]);
  // A lookup that could not be made is unknown; one that worked and found nothing is a fact.
  if (!maps || !Array.isArray(maps.items)) return undefined;
  const found: NonNullable<ObservedAgent["watcher"]>[] = [];
  let unreadable = 0;
  for (const item of maps.items) {
    let document: any;
    try {
      document = JSON.parse(item.data?.["status.json"] ?? "");
    } catch { unreadable++; continue; }
    // It must say what it is: a ConfigMap is hand-editable, and a document that only happens
    // to carry a matching installation name is not this watcher's status.
    if (!document || typeof document !== "object") continue;
    if (document.kind !== "ReconciliationStatus" || !String(document.apiVersion ?? "").startsWith("nexus.hermes.ai/")) continue;
    if (document.installation !== plan.id) continue;
    found.push({
      phase: text(document.phase),
      appliedSha: text(document.appliedSha),
      observedAt: text(document.observedAt),
      ...(text(document.pending?.reason) ? { reason: `pending (${text(document.pending.reason)})` } : {}),
    });
  }
  // A labelled record we could not read might be this installation's, so absence is unproven.
  if (!found.length && unreadable) return { reason: `${unreadable} watcher status record(s) could not be read, so whether one belongs to this installation is unknown` };
  if (!found.length) return { absent: true };
  if (found.length > 1) {
    // Two publishers for one installation: the newest is the only one that can be current,
    // and a tie is not something to pick a winner from.
    found.sort((a, b) => String(b.observedAt ?? "").localeCompare(String(a.observedAt ?? "")));
    if (!found[0]!.observedAt || found[0]!.observedAt === found[1]!.observedAt) {
      return { ...found[0]!, phase: undefined, reason: `${found.length} watchers publish a status for this installation and none is clearly newest` };
    }
  }
  return found[0];
}

/** Fixed-width table, one row per agent. Verdicts read as words, never colour alone. */
export function renderStatusTable(agents: AgentStatus[]): string {
  const mark = (f: FieldStatus) => (f.verdict === "pass" ? "ok" : f.verdict === "fail" ? "FAIL" : f.verdict === "not-applicable" ? "n/a" : "?");
  const header = ["AGENT", "ARGO", "READY", "SOURCE", "OVERLAY", "EVE", "IMAGE", "SMOKE", "WATCHER"];
  const rows = agents.map((a) => [a.agent, ...STATUS_FIELDS.map((f) => mark(a.fields[f]))]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const out = [line(header), ...rows.map(line)];
  // Every non-pass gets its reason spelled out: a table of "?" nobody can act on is worse
  // than no table.
  for (const agent of agents) {
    for (const field of STATUS_FIELDS) {
      const status = agent.fields[field];
      if (status.verdict === "pass") continue;
      out.push(`  ${agent.agent} ${field}: ${status.reason ?? "no reason recorded"}` +
        (status.desired || status.running ? ` (intended ${status.desired ?? "?"}, running ${status.running ?? "?"})` : ""));
    }
  }
  return out.join("\n");
}
