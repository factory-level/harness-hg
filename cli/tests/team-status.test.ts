// ADR 0195: `hg team status` observes the cluster and classifies each agent against what the
// installation lock intends. The classifier is pure, so every verdict is asserted directly;
// observation is driven by exec stubs that answer per argv, the way team.test.ts drives resume.
import { describe, expect, test } from "bun:test";
import {
  agentVerdict, classifyAgent, desiredAgent, observeAgent, observeWatcher, renderStatusTable,
  statusExitCode, STATUS_FIELDS, type ObservedAgent,
} from "../src/team/health.ts";
import type { InstallationLock } from "../src/team/lock.ts";
import type { TeamPlan, TeamSource } from "../src/team/plan.ts";
import versions from "../../versions.json";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const IMAGE = `example/eve@sha256:${"a".repeat(64)}`;

const agent = (over: Partial<TeamSource["agents"][number]> = {}) => ({
  name: "manager", subdir: "agents/eve/manager/src", environment: [], tools: [], writablePaths: [], skills: [], ...over,
}) as TeamSource["agents"][number];

const plan = (over: Partial<TeamPlan> = {}): TeamPlan => ({
  version: 2, id: "factory-teams", lock: "teams/installation.lock.yaml",
  sources: [{ id: "social", repository: "https://github.com/example/social", ref: `refs/tags/v1`, private: false, agents: [agent()] }],
  destination: { repository: "https://github.com/example/generated", branch: "main", credentialEnv: "T", autoMerge: true },
  environment: "environment.yaml", argoDestinations: ["in-cluster"], bootstrap: { directory: "infra", stack: "s" },
  kubeContext: "test", runtime: { image: IMAGE, platform: "linux/amd64" }, authorizations: [],
  acceptance: [{ id: "verify", source: "social", agent: "manager", argv: ["node", "v.mjs"], effect: "read" }],
  ...over,
} as TeamPlan);

const lock = (over: Partial<InstallationLock> = {}): InstallationLock => ({
  version: 2, installation: "factory-teams", planDigest: "0".repeat(64),
  sources: { social: { ref: "refs/tags/v1", commit: SHA } },
  agents: { manager: { image: IMAGE, eveVersion: versions.runtimes.eve.version } },
  ...over,
} as InstallationLock);

const healthy = (over: Partial<ObservedAgent> = {}): ObservedAgent => ({
  name: "manager", namespace: "ag-eve-manager", problems: [],
  argo: { sync: "Synced", health: "Healthy" },
  pod: { ready: true, revision: "rev-1", image: IMAGE, phase: "Running" },
  updateRevision: "rev-1",
  receipt: { sourceSha: SHA, buildKey: SHA, eveVersion: versions.runtimes.eve.version, runtimeDigest: "d" },
  workloadRead: true,
  smoke: { state: "succeeded", sourceSha: SHA },
  watcher: { phase: "synced", appliedSha: SHA },
  ...over,
});

const intended = (observed: ObservedAgent, over: Partial<TeamPlan> = {}) => {
  const p = plan(over);
  return desiredAgent(p, p.sources[0]!, p.sources[0]!.agents[0]!, lock(), observed.deployedOverlayDigest);
};

describe("classifying one agent against what the installation intends", () => {
  test("an agent running exactly what the lock records passes every field", () => {
    const observed = healthy();
    const fields = classifyAgent(observed, intended(observed));
    for (const field of STATUS_FIELDS) expect([field, fields[field].verdict]).toEqual([field, "pass"]);
    expect(agentVerdict(fields)).toBe("pass");
    expect(statusExitCode([{ agent: "manager", source: "social", namespace: "ns", fields, verdict: "pass" }])).toBe(0);
  });

  test("a build that is not the intended one FAILS, and says both values", () => {
    const observed = healthy({ receipt: { sourceSha: OTHER, eveVersion: versions.runtimes.eve.version } });
    const fields = classifyAgent(observed, intended(observed));
    expect(fields.source).toEqual({ verdict: "fail", desired: SHA, running: OTHER, reason: expect.stringContaining("not what this agent built") });
    expect(agentVerdict(fields)).toBe("fail");
    expect(statusExitCode([{ agent: "manager", source: "social", namespace: "ns", fields, verdict: "fail" }])).toBe(1);
  });

  test("missing evidence is unknown WITH its reason - never a pass, never a failure", () => {
    // No receipt at all: three receipt-backed fields cannot be proven, and nothing else changes.
    const observed = healthy({ receipt: undefined });
    const fields = classifyAgent(observed, intended(observed));
    for (const field of ["source", "eve"] as const) {
      expect(fields[field].verdict).toBe("unknown");
      expect(fields[field].reason).toContain("published no receipt");
    }
    // The image comes from the pod, not the receipt, so it still passes.
    expect(fields.image.verdict).toBe("pass");
    expect(agentVerdict(fields)).toBe("unknown");
    expect(statusExitCode([{ agent: "manager", source: "social", namespace: "ns", fields, verdict: "unknown" }])).toBe(2);
    // Every non-pass field carries a reason: a table of "?" nobody can act on is useless.
    for (const field of STATUS_FIELDS) {
      if (fields[field].verdict !== "pass") expect(fields[field].reason?.length).toBeGreaterThan(10);
    }
  });

  test("a lock that records nothing to compare against is unknown, not a pass", () => {
    const observed = healthy();
    const p = plan();
    const fields = classifyAgent(observed, desiredAgent(p, p.sources[0]!, p.sources[0]!.agents[0]!, undefined, undefined));
    expect(fields.source.verdict).toBe("unknown");
    expect(fields.source.reason).toContain("installation lock records none");
    // The runtime still has a plan-level default, so eve and image remain provable.
    expect(fields.eve.verdict).toBe("pass");
    expect(fields.image.verdict).toBe("pass");
  });

  test("an absent smoke hook proves nothing either way; a failed one fails the agent", () => {
    const absent = classifyAgent(healthy({ smoke: { state: "absent" } }), intended(healthy()));
    expect(absent.smoke.verdict).toBe("unknown");
    expect(absent.smoke.reason).toContain("Argo CD recorded no hook result");
    const failed = classifyAgent(healthy({ smoke: { state: "failed", sourceSha: SHA } }), intended(healthy()));
    expect(failed.smoke.verdict).toBe("fail");
    expect(agentVerdict(failed)).toBe("fail");
    const running = classifyAgent(healthy({ smoke: { state: "running", sourceSha: SHA } }), intended(healthy()));
    expect(running.smoke.verdict).toBe("unknown");
    // A hook retained from an earlier sync says nothing about this one, whatever it says.
    const stale = classifyAgent(healthy({ smoke: { state: "succeeded", sourceSha: OTHER } }), intended(healthy()));
    expect(stale.smoke.verdict).toBe("unknown");
    expect(stale.smoke.reason).toContain("from an earlier sync");
  });

  test("overlays are compared only where the workload declares them, in both directions", () => {
    // Declared and built: a match passes, a difference fails.
    const declared = healthy({ deployedOverlayDigest: "d1", receipt: { sourceSha: SHA, overlayDigest: "d1", eveVersion: versions.runtimes.eve.version } });
    expect(classifyAgent(declared, intended(declared)).overlay.verdict).toBe("pass");
    const drifted = healthy({ deployedOverlayDigest: "d1", receipt: { sourceSha: SHA, overlayDigest: "d2", eveVersion: versions.runtimes.eve.version } });
    expect(classifyAgent(drifted, intended(drifted)).overlay.verdict).toBe("fail");
    // Built overlays the workload does not declare is drift too, not an absence.
    const undeclared = healthy({ receipt: { sourceSha: SHA, overlayDigest: "d3", eveVersion: versions.runtimes.eve.version } });
    const fields = classifyAgent(undeclared, intended(undeclared));
    expect(fields.overlay).toEqual({ verdict: "fail", desired: "none", running: "d3", reason: expect.stringContaining("does not declare") });
    // Neither declared nor built is the ordinary case.
    expect(classifyAgent(healthy(), intended(healthy())).overlay.verdict).toBe("pass");
  });

  test("a pod behind its workload's revision fails even when it is Ready", () => {
    const behind = healthy({ pod: { ready: true, revision: "rev-0", image: IMAGE }, updateRevision: "rev-1" });
    const fields = classifyAgent(behind, intended(behind));
    expect(fields.ready).toEqual({ verdict: "fail", desired: "rev-1", running: "rev-0", reason: expect.stringContaining("not the revision") });
  });

  test("an OutOfSync application and a degraded watcher both fail; a pending watcher is unknown", () => {
    const out = classifyAgent(healthy({ argo: { sync: "OutOfSync", health: "Healthy" } }), intended(healthy()));
    expect(out.argo.verdict).toBe("fail");
    const degraded = classifyAgent(healthy({ watcher: { phase: "degraded", reason: "pending (merge-pending)" } }), intended(healthy()));
    expect(degraded.watcher).toEqual({ verdict: "fail", running: "degraded", reason: "pending (merge-pending)" });
    const pending = classifyAgent(healthy({ watcher: { phase: "pending", reason: "pending (approval-required)" } }), intended(healthy()));
    expect(pending.watcher.verdict).toBe("unknown");
    const none = classifyAgent(healthy({ watcher: undefined }), intended(healthy()));
    expect(none.watcher.verdict).toBe("unknown");
    expect(none.watcher.reason).toContain("lookup could not be made");
  });
});

describe("observing the cluster", () => {
  const responses = (over: Record<string, unknown> = {}) => ({
    application: { status: { sync: { status: "Synced" }, health: { status: "Healthy" } } },
    statefulset: { metadata: { uid: "sts-uid" }, status: { updateRevision: "rev-1" }, spec: { template: { metadata: { annotations: { "harness-hg.factorylevel.dev/overlay-digest": "d1" } } } } },
    pods: { items: [{
      metadata: { name: "ag-eve-manager-0", labels: { "controller-revision-hash": "rev-1" }, ownerReferences: [{ kind: "StatefulSet", name: "ag-eve-manager", uid: "sts-uid" }] },
      spec: { containers: [{ name: "eve-agent", image: IMAGE }] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }],
        initContainerStatuses: [{ name: "build-agent", state: { terminated: { message: JSON.stringify({ sourceSha: SHA, eveVersion: "0.42.0" }) } } }] },
    }] },
    jobs: { items: [{ metadata: { name: "ag-eve-manager-smoke", labels: { "harness-hg.factorylevel.dev/source-sha": SHA } },
      status: { conditions: [{ type: "Complete", status: "True" }] } }] },
    ...over,
  });
  const execFor = (r: Record<string, any>, seen: string[][] = []) => (async (argv: string[]) => {
    seen.push(argv);
    const kind = argv[argv.indexOf("get") + 1]!;
    const body = r[kind === "application" ? "application" : kind];
    if (body === undefined) throw new Error(`not found: ${kind}`);
    return JSON.stringify(body);
  });

  test("reads Argo, the workload, the pod, its receipt and the smoke hook - and never writes", async () => {
    const seen: string[][] = [];
    const observed = await observeAgent(plan(), agent(), execFor(responses(), seen) as any);
    expect(observed.argo).toEqual({ sync: "Synced", health: "Healthy" });
    expect(observed.argo!.syncedRevisions).toBeUndefined();
    expect(observed.pod).toEqual({ ready: true, revision: "rev-1", image: IMAGE, phase: "Running" });
    expect(observed.receipt).toEqual({ sourceSha: SHA, eveVersion: "0.42.0" });
    expect(observed.deployedOverlayDigest).toBe("d1");
    expect(observed.smoke).toEqual({ state: "succeeded", sourceSha: SHA });
    // Read-only, and always in the plan's own context.
    for (const argv of seen) {
      expect(argv.slice(0, 3)).toEqual(["kubectl", "--context", "test"]);
      expect(argv).toContain("get");
      for (const verb of ["apply", "delete", "patch", "create", "exec", "edit"]) expect(argv).not.toContain(verb);
    }
  });

  test("a cluster that answers nothing yields problems, not an exception", async () => {
    const observed = await observeAgent(plan(), agent(), (async () => { throw new Error("connection refused"); }) as any);
    expect(observed.problems.length).toBeGreaterThan(0);
    expect(observed.pod).toBeUndefined();
    // And every field it feeds is unknown rather than a pass.
    const fields = classifyAgent(observed, intended(observed));
    expect(agentVerdict(fields)).toBe("unknown");
    expect(fields.argo.reason).toContain("no Argo CD Application");
  });

  test("a receipt that is not an object is missing evidence, not a receipt", async () => {
    const broken = responses();
    (broken.pods.items[0]!.status.initContainerStatuses[0] as any).state.terminated.message = "null";
    const observed = await observeAgent(plan(), agent(), execFor(broken) as any);
    expect(observed.receipt).toBeUndefined();
  });

  test("the watcher's published status is matched to THIS installation, and must say what it is", async () => {
    const status = (over: Record<string, unknown>) => ({ data: { "status.json": JSON.stringify({
      apiVersion: "nexus.hermes.ai/v1alpha2", kind: "ReconciliationStatus", ...over }) } });
    const watcher = await observeWatcher(plan(), (async () => JSON.stringify({ items: [
      status({ installation: "someone-else", phase: "synced", appliedSha: OTHER }),
      status({ installation: "factory-teams", phase: "pending", appliedSha: SHA, observedAt: "2026-09-11T12:00:00Z", pending: { reason: "merge-pending" } }),
    ] })) as any);
    expect(watcher).toEqual({ phase: "pending", appliedSha: SHA, observedAt: "2026-09-11T12:00:00Z", reason: "pending (merge-pending)" });
    // A ConfigMap is hand-editable: a document that only happens to name the installation is not
    // this watcher's status.
    const impostor = { data: { "status.json": JSON.stringify({ installation: "factory-teams", phase: "synced" }) } };
    // The lookup worked and nothing matched: that is a fact (absent), not a failed lookup.
    expect(await observeWatcher(plan(), (async () => JSON.stringify({ items: [impostor] })) as any)).toEqual({ absent: true });
    // Two publishers and no clear newest: the phase is withheld rather than guessed at.
    const tied = await observeWatcher(plan(), (async () => JSON.stringify({ items: [
      status({ installation: "factory-teams", phase: "synced", observedAt: "2026-09-11T12:00:00Z" }),
      status({ installation: "factory-teams", phase: "degraded", observedAt: "2026-09-11T12:00:00Z" }),
    ] })) as any);
    expect(tied!.phase).toBeUndefined();
    expect(tied!.reason).toContain("none is clearly newest");
    // With a clear newest, the newest wins even when an older one says synced.
    const newest = await observeWatcher(plan(), (async () => JSON.stringify({ items: [
      status({ installation: "factory-teams", phase: "synced", observedAt: "2026-09-11T11:00:00Z" }),
      status({ installation: "factory-teams", phase: "degraded", observedAt: "2026-09-11T12:00:00Z" }),
    ] })) as any);
    expect(newest!.phase).toBe("degraded");
    expect(await observeWatcher(plan(), (async () => JSON.stringify({ items: [] })) as any)).toEqual({ absent: true });
    expect(await observeWatcher(plan(), (async () => { throw new Error("no such resource"); }) as any)).toBeUndefined();
  });

  test("a pod from a controller that no longer exists is not this agent's evidence", async () => {
    const r = responses();
    // Same name, different controller: a StatefulSet deleted and recreated leaves exactly this.
    (r.pods.items[0]!.metadata.ownerReferences[0] as any).uid = "an-older-controller";
    const stale = await observeAgent(plan(), agent(), execFor(r) as any);
    expect(stale.pod).toBeUndefined();
    expect(stale.receipt).toBeUndefined();
    // Two live claimants is not a tie to break; it is evidence nobody should use.
    const two = responses();
    two.pods.items.push(JSON.parse(JSON.stringify(two.pods.items[0])));
    two.pods.items[1]!.metadata.name = "ag-eve-manager-1";
    const ambiguous = await observeAgent(plan(), agent(), execFor(two) as any);
    expect(ambiguous.pod).toBeUndefined();
    expect(ambiguous.problems.join(" ")).toContain("more than one live pod");
    // A terminating pod is on its way out, not the agent.
    const dying = responses();
    (dying.pods.items[0]!.metadata as any).deletionTimestamp = "2026-09-11T12:00:00Z";
    expect((await observeAgent(plan(), agent(), execFor(dying) as any)).pod).toBeUndefined();
  });

  test("a smoke Job still retrying is not a failure, and a workload that could not be read proves nothing", async () => {
    const retrying = responses();
    retrying.jobs.items[0]!.status = { failed: 1 } as any; // an attempt, not a verdict
    const observed = await observeAgent(plan(), agent(), execFor(retrying) as any);
    expect(observed.smoke!.state).toBe("running");
    // Without the StatefulSet, readiness and overlays are unknown however healthy the pod looks.
    const noWorkload = responses();
    delete (noWorkload as any).statefulset;
    const blind = await observeAgent(plan(), agent(), execFor(noWorkload) as any);
    expect(blind.workloadRead).toBeUndefined();
    const fields = classifyAgent(blind, intended(blind));
    expect(fields.ready.verdict).toBe("unknown");
    expect(fields.overlay.verdict).toBe("unknown");
    expect(agentVerdict(fields)).toBe("unknown");
  });
});

describe("proving a healthy agent end to end (ADR 0195)", () => {
  const REV = "c".repeat(40);
  const DIGEST = `sha256:${"d".repeat(64)}`;

  test("a smoke hook deleted on success still passes, from the result Argo CD recorded for this sync", () => {
    const observed = healthy({ smoke: { state: "absent" },
      argo: { sync: "Synced", health: "Healthy", syncedRevisions: [REV], smokeHook: { phase: "Succeeded", revisions: [REV] } } });
    expect(classifyAgent(observed, intended(observed)).smoke).toEqual({ verdict: "pass", running: "Succeeded" });
    const failed = healthy({ smoke: { state: "absent" },
      argo: { sync: "Synced", health: "Healthy", syncedRevisions: [REV], smokeHook: { phase: "Failed", revisions: [REV] } } });
    expect(classifyAgent(failed, intended(failed)).smoke.verdict).toBe("fail");
    // A result recorded for another revision says nothing about what is synced now.
    const stale = healthy({ smoke: { state: "absent" },
      argo: { sync: "Synced", health: "Healthy", syncedRevisions: [REV], smokeHook: { phase: "Succeeded", revisions: ["e".repeat(40)] } } });
    const staleSmoke = classifyAgent(stale, intended(stale)).smoke;
    expect(staleSmoke.verdict).toBe("unknown");
    expect(staleSmoke.reason).toContain("earlier sync");
    // Multi-source applications compare every revision, in order.
    const partial = healthy({ smoke: { state: "absent" },
      argo: { sync: "Synced", health: "Healthy", syncedRevisions: [REV, "f".repeat(40)], smokeHook: { phase: "Succeeded", revisions: [REV] } } });
    expect(classifyAgent(partial, intended(partial)).smoke.verdict).toBe("unknown");
  });

  test("the image is judged by the digest the pod is running, even under a local tag", () => {
    const p = plan({ runtime: { image: `example/eve@${DIGEST}`, platform: "linux/amd64" } });
    const want = desiredAgent(p, p.sources[0]!, p.sources[0]!.agents[0]!, lock({ agents: { manager: { image: `example/eve@${DIGEST}`, eveVersion: versions.runtimes.eve.version } } }));
    const tagged = healthy({ pod: { ready: true, revision: "rev-1", image: "eve-runtime:hermes-gitops-dev", imageID: `docker.io/library/eve-runtime@${DIGEST}` } });
    expect(classifyAgent(tagged, want).image).toEqual({ verdict: "pass", desired: DIGEST, running: DIGEST });
    const other = healthy({ pod: { ready: true, revision: "rev-1", image: `example/eve@${DIGEST}`, imageID: `docker.io/library/eve-runtime@sha256:${"0".repeat(64)}` } });
    expect(classifyAgent(other, want).image.verdict).toBe("fail");
    // Without a running digest, the spec image string is all there is to compare.
    const noDigest = healthy({ pod: { ready: true, revision: "rev-1", image: "eve-runtime:hermes-gitops-dev" } });
    expect(classifyAgent(noDigest, want).image.verdict).toBe("fail");
  });

  test("an installation nobody runs a watcher for can still be proven: exit 0", () => {
    const observed = healthy({ watcher: { absent: true } });
    const fields = classifyAgent(observed, intended(observed));
    expect(fields.watcher.verdict).toBe("not-applicable");
    expect(fields.watcher.reason).toContain("no watcher publishes");
    expect(agentVerdict(fields)).toBe("pass");
    expect(statusExitCode([{ agent: "manager", source: "social", namespace: "ns", fields, verdict: agentVerdict(fields) }])).toBe(0);
    // A lookup that could not be made is still unknown - never quietly not-applicable.
    const blind = classifyAgent(healthy({ watcher: undefined }), intended(healthy()));
    expect(blind.watcher.verdict).toBe("unknown");
    expect(renderStatusTable([{ agent: "manager", source: "social", namespace: "ns", fields, verdict: "pass" }])).toContain("n/a");
  });

  test("observation reads the synced revisions, the recorded hook result and the running digest", async () => {
    const application = { status: {
      sync: { status: "Synced", revisions: [REV, "a".repeat(40)] }, health: { status: "Healthy" },
      operationState: { syncResult: { revisions: [REV, "a".repeat(40)], resources: [
        { kind: "StatefulSet", name: "ag-eve-manager", namespace: "ag-eve-manager", status: "Synced" },
        { group: "batch", kind: "Job", name: "ag-eve-manager-smoke", namespace: "ag-eve-manager", hookType: "PostSync", hookPhase: "Succeeded" },
      ] } } } };
    const pods = { items: [{
      metadata: { name: "ag-eve-manager-0", labels: { "controller-revision-hash": "rev-1" }, ownerReferences: [{ kind: "StatefulSet", name: "ag-eve-manager", uid: "sts-uid" }] },
      spec: { containers: [{ name: "eve-agent", image: "eve-runtime:hermes-gitops-dev" }] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [{ name: "eve-agent", imageID: `docker.io/library/eve-runtime@${DIGEST}` }] },
    }] };
    const answers: Record<string, unknown> = { application, pods, statefulset: { metadata: { uid: "sts-uid" }, status: { updateRevision: "rev-1" } }, jobs: { items: [] } };
    const exec = (async (argv: string[]) => {
      const body = answers[argv[argv.indexOf("get") + 1]!];
      if (body === undefined) throw new Error("not found");
      return JSON.stringify(body);
    }) as any;
    const observed = await observeAgent(plan(), agent(), exec);
    expect(observed.argo).toEqual({ sync: "Synced", health: "Healthy", syncedRevisions: [REV, "a".repeat(40)],
      smokeHook: { phase: "Succeeded", revisions: [REV, "a".repeat(40)] } });
    expect(observed.pod!.imageID).toBe(`docker.io/library/eve-runtime@${DIGEST}`);
    expect(observed.smoke).toEqual({ state: "absent" });
  });
});

describe("evidence that cannot be verified never becomes a pass", () => {
  const REV = "c".repeat(40);
  const DIGEST = `sha256:${"d".repeat(64)}`;
  const want = { sourceSha: SHA, eveVersion: versions.runtimes.eve.version, image: `example/eve@${DIGEST}` };
  const withImage = (imageID: string) => healthy({ pod: { ready: true, revision: "rev-1", image: `example/eve@${DIGEST}`, imageID } });

  test("every imageID form is judged, and a form that cannot be compared is unknown - never the spec string", () => {
    expect(classifyAgent(withImage(`docker-pullable://example/eve@${DIGEST}`), want).image.verdict).toBe("pass");
    expect(classifyAgent(withImage(`example/eve@sha256:${"0".repeat(64)}`), want).image.verdict).toBe("fail");
    // A bare image id equal to the locked digest names the same bytes.
    expect(classifyAgent(withImage(`containerd://${DIGEST}`), want).image.verdict).toBe("pass");
    expect(classifyAgent(withImage(DIGEST), want).image.verdict).toBe("pass");
    // Different, it may be a different KIND of digest: unknown, even though the spec string matches.
    const other = classifyAgent(withImage(`containerd://sha256:${"0".repeat(64)}`), want).image;
    expect(other.verdict).toBe("unknown");
    expect(other.reason).toContain("image id rather than a registry digest");
    expect(classifyAgent(withImage("something-else"), want).image.verdict).toBe("unknown");
  });

  test("a smoke Job that could not be read never lets Argo's record stand in for it", async () => {
    const recorded = { sync: "Synced", health: "Healthy", syncedRevisions: [REV], smokeHook: { phase: "Succeeded", revisions: [REV] } };
    const blind = classifyAgent(healthy({ smoke: { state: "unreadable", reason: "the smoke hook Job could not be read" }, argo: recorded }), want);
    expect(blind.smoke.verdict).toBe("unknown");
    // And observation marks a failed Job read as unreadable, not absent.
    const exec = (async (argv: string[]) => {
      if (argv.includes("jobs")) throw new Error("Forbidden");
      return JSON.stringify({ items: [] });
    }) as any;
    expect((await observeAgent(plan(), agent(), exec)).smoke!.state).toBe("unreadable");
  });

  test("revision lists are compared whole: an unreadable entry is no revision", async () => {
    const application = { status: { sync: { status: "Synced", revisions: [REV, ""] }, health: { status: "Healthy" },
      operationState: { syncResult: { revisions: [REV], resources: [
        { kind: "Job", name: "ag-eve-manager-smoke", namespace: "ag-eve-manager", hookType: "PostSync", hookPhase: "Succeeded" }] } } } };
    const exec = (async (argv: string[]) => {
      if (argv.includes("application")) return JSON.stringify(application);
      if (argv.includes("jobs")) return JSON.stringify({ items: [] });
      throw new Error("not found");
    }) as any;
    const observed = await observeAgent(plan(), agent(), exec);
    expect(observed.argo!.syncedRevisions).toBeUndefined();
    const fields = classifyAgent(observed, want);
    expect(fields.smoke.verdict).toBe("unknown");
  });

  test("an unreadable watcher record is not proof that no watcher publishes", async () => {
    const broken = { items: [{ data: { "status.json": "{not json" } }] };
    const watcher = await observeWatcher(plan(), (async () => JSON.stringify(broken)) as any);
    expect(watcher!.absent).toBeUndefined();
    expect(watcher!.reason).toContain("could not be read");
    // Judged against what healthy() actually runs, so only the watcher can move the verdict.
    const fields = classifyAgent(healthy({ watcher }), intended(healthy()));
    expect(fields.watcher.verdict).toBe("unknown");
    expect(agentVerdict(fields)).toBe("unknown");
  });
});

describe("the printed table", () => {
  test("marks every column and spells out each non-pass reason", () => {
    const observed = healthy({ smoke: { state: "failed" }, receipt: undefined });
    const fields = classifyAgent(observed, intended(observed));
    const table = renderStatusTable([{ agent: "manager", source: "social", namespace: "ns", fields, verdict: agentVerdict(fields) }]);
    expect(table.split("\n")[0]).toContain("AGENT");
    expect(table.split("\n")[0]).toContain("WATCHER");
    expect(table).toContain("FAIL");
    expect(table).toContain("manager smoke:");
    expect(table).toContain("manager source:");
    expect(table).toContain("published no receipt");
  });

  test("an installation with no agents observed cannot be proven", () => {
    expect(statusExitCode([])).toBe(2);
  });
});
