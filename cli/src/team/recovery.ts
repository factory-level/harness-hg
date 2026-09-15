import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseAllDocuments } from "yaml";
import { run, type Run } from "./process.ts";
import { digest, type TeamPlan } from "./plan.ts";
import { workloadRuntimeImage } from "./runtime.ts";

/** Core-mode rendering can miss Argo's cache and needs an explicit client config.
 * Reference mounted service-account files; never copy token bytes or change RBAC. */
export async function argoDesiredManifests(plan: TeamPlan, name: string, stateRoot: string,
  exec: Run = run, revisions: string[] = []): Promise<string> {
  const serviceAccount = "/var/run/secrets/kubernetes.io/serviceaccount";
  const config = JSON.stringify({ apiVersion: "v1", kind: "Config",
    clusters: [{ name: "in-cluster", cluster: { server: "https://kubernetes.default.svc",
      "certificate-authority": `${serviceAccount}/ca.crt` } }],
    users: [{ name: "controller", user: { tokenFile: `${serviceAccount}/token` } }],
    contexts: [{ name: "controller", context: { cluster: "in-cluster", user: "controller", namespace: "argocd" } }],
    "current-context": "controller",
  });
  const script = `set -eu
umask 077
hg_kubeconfig="$(mktemp /tmp/hg-argo-kubeconfig.XXXXXX)"
trap 'rm -f "$hg_kubeconfig"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$hg_kubeconfig"
KUBECONFIG="$hg_kubeconfig" argocd "$@"`;
  return exec(["kubectl", "--context", plan.kubeContext, "-n", "argocd", "exec", "-i",
    "statefulset/argocd-application-controller", "--", "sh", "-c", script, "hg-argo-manifests",
    "app", "manifests", name, "--core",
    ...revisions.flatMap((r, i) => ["--revisions", r, "--source-positions", String(i + 1)])],
  stateRoot, undefined, 120_000, config);
}

function normalizedClaim(value: any) {
  const claim = structuredClone(value);
  delete claim.apiVersion; delete claim.kind; delete claim.status;
  if (claim.metadata.creationTimestamp === null) delete claim.metadata.creationTimestamp;
  claim.spec.volumeMode ??= "Filesystem";
  return claim;
}

function recordedWorkspaceMigrations(pod: any, stateRoot: string): any[] {
  if (!fs.existsSync(stateRoot)) return [];
  return fs.readdirSync(stateRoot).filter(f => /^workspace-recovery-[a-f0-9]{64}\.json$/.test(f))
    .map(f => JSON.parse(fs.readFileSync(path.join(stateRoot, f), "utf8")))
    .filter(r => r.state === "accepted" && r.namespace === pod.metadata?.namespace &&
      `${r.name}-0` === pod.metadata?.name && r.podUid === pod.metadata?.uid);
}

/** Argo does not automatically repeat every exhausted sync. Re-drive only the
 * missing controller from an accepted migration, at the exact rendered revisions. */
export async function resumeWorkspaceController(plan: TeamPlan, sourceSha: string, pod: any,
  stateRoot: string, exec: Run = run): Promise<boolean> {
  const namespace = pod?.metadata?.namespace, name = namespace;
  if (!plan.authorizations.includes("recover") || !namespace || !/^[a-z0-9-]+$/.test(namespace) ||
    !plan.sources.some(s => s.agents.some(a => name === `ag-eve-${a.name}`)) ||
    pod.metadata.name !== `${name}-0` || pod.metadata.deletionTimestamp ||
    pod.metadata.ownerReferences?.some((o: any) => o.controller)) return false;
  const receipts = recordedWorkspaceMigrations(pod, stateRoot);
  if (receipts.length !== 1) return false;
  const prior = receipts[0];
  if ((await exec(["kubectl", "--context", plan.kubeContext, "-n", namespace, "get", "statefulset", name, "--ignore-not-found", "-o", "json"], stateRoot)).trim()) return false;
  const application = JSON.parse(await exec(["kubectl", "--context", plan.kubeContext, "-n", "argocd", "get", "application", name, "-o", "json"], stateRoot));
  const revisions = application.status?.sync?.revisions, sources = application.spec?.sources;
  if (application.metadata?.name !== name || application.metadata?.namespace !== "argocd" || !application.metadata.uid || !application.metadata.resourceVersion ||
    application.operation || ["Running", "Terminating"].includes(application.status?.operationState?.phase) ||
    !Array.isArray(sources) || !isDeepStrictEqual(application.status?.sync?.comparedTo?.sources, sources) ||
    !Array.isArray(revisions) || revisions.length !== sources.length || !revisions.length ||
    revisions.some(r => typeof r !== "string" || !/^[a-f0-9]{40}$/.test(r))) return false;
  const output = await argoDesiredManifests(plan, name, stateRoot, exec, revisions);
  const manifests = parseAllDocuments(output).map(doc => { if (doc.errors.length) throw new Error("Invalid Argo desired manifest response"); return doc.toJSON(); });
  const candidates = manifests.filter(d => d?.apiVersion === "apps/v1" && d.kind === "StatefulSet" && d.metadata?.name === name && (!d.metadata.namespace || d.metadata.namespace === namespace));
  if (candidates.length !== 1) return false;
  const desired = candidates[0];
  const declaredSha = desired.spec?.template?.spec?.initContainers?.flatMap((c: any) => c.env ?? []).find((e: any) => e.name === "EVE_DIST_SHA")?.value;
  if (digest(desired.spec) !== prior.desiredHash || declaredSha !== sourceSha ||
    desired.spec?.template?.spec?.containers?.find((c: any) => c.name === "eve-agent")?.image !== workloadRuntimeImage(plan, name)) return false;
  const data = JSON.parse(await exec(["kubectl", "--context", plan.kubeContext, "-n", namespace, "get", "pvc", prior.dataClaim, "-o", "json"], stateRoot));
  if (data.metadata?.uid !== prior.dataClaimUid || data.metadata.deletionTimestamp || data.status?.phase !== "Bound" ||
    data.metadata.ownerReferences?.some((o: any) => o.uid === pod.metadata.uid) ||
    !pod.spec?.volumes?.some((v: any) => v.name === "data" && v.persistentVolumeClaim?.claimName === data.metadata.name)) return false;
  const key = digest({ appUid: application.metadata.uid, controllerUid: prior.controllerUid, desiredHash: prior.desiredHash, revisions });
  const receipt = path.join(stateRoot, `workspace-controller-sync-${key}.json`);
  const previous = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : undefined;
  if (previous?.state === "accepted" && !(application.status?.operationState?.phase === "Failed" &&
    application.status.operationState.operation?.info?.some((i: any) => i.name === "hg-workspace-recovery" && i.value === key))) return false;
  const attempt = (previous?.attempt ?? 0) + 1;
  if (attempt > 3) throw new Error(`Workspace controller sync for ${name} exhausted three verified attempts`);
  const evidence = { name, appUid: application.metadata.uid, dataClaimUid: data.metadata.uid, revisions, attempt };
  fs.writeFileSync(receipt, JSON.stringify({ ...evidence, state: "requested" }), { mode: 0o600 });
  const patch = path.join(stateRoot, `workspace-controller-sync-patch-${key}.json`);
  fs.writeFileSync(patch, JSON.stringify([
    { op: "test", path: "/metadata/uid", value: application.metadata.uid },
    { op: "test", path: "/metadata/resourceVersion", value: application.metadata.resourceVersion },
    { op: "add", path: "/operation", value: {
      initiatedBy: { username: "hg-team-recovery" }, info: [{ name: "hg-workspace-recovery", value: key }],
      sync: { sources, revisions, prune: false, syncOptions: application.spec.syncPolicy?.syncOptions ?? [],
        resources: [{ group: "apps", kind: "StatefulSet", name, namespace }] },
    } },
  ]), { mode: 0o600 });
  try {
    await exec(["kubectl", "--context", plan.kubeContext, "-n", "argocd", "patch", "application", name, "--type=json", "--patch-file", patch, "-o", "name"], stateRoot);
    fs.writeFileSync(receipt, JSON.stringify({ ...evidence, state: "accepted" }), { mode: 0o600 });
    return true;
  } finally { fs.rmSync(patch, { force: true }); }
}

/** The only supported immutable migration: add the first workspace claim while
 * retaining an identical data claim and every other immutable StatefulSet field. */
export function workspaceClaimAddition(live: any, desired: any): boolean {
  if (live?.spec?.replicas !== 1 || desired?.spec?.replicas !== 1 || live.metadata?.deletionTimestamp ||
    (live.spec.ordinals?.start ?? 0) !== 0 || (desired.spec.ordinals?.start ?? 0) !== 0) return false;
  const oldClaims = live.spec.volumeClaimTemplates, newClaims = desired.spec.volumeClaimTemplates;
  if (!Array.isArray(oldClaims) || !Array.isArray(newClaims) || oldClaims.length !== 1 || newClaims.length !== 2 ||
    oldClaims[0]?.metadata?.name !== "data" || newClaims[0]?.metadata?.name !== "data" || newClaims[1]?.metadata?.name !== "workspaces") return false;
  const immutable = (workload: any) => {
    const spec = structuredClone(workload.spec);
    for (const field of ["template", "replicas", "updateStrategy", "revisionHistoryLimit", "persistentVolumeClaimRetentionPolicy", "minReadySeconds", "ordinals"]) delete spec[field];
    spec.podManagementPolicy ??= "OrderedReady";
    spec.volumeClaimTemplates = spec.volumeClaimTemplates.slice(0, 1).map(normalizedClaim);
    return spec;
  };
  return isDeepStrictEqual(immutable(live), immutable(desired));
}

/** Complete a recorded controller migration by gracefully replacing its adopted old
 * pod. Kubernetes cannot update an existing pod's volume list in place. Healthy pods
 * outside an accepted workspace migration never qualify for this recovery. */
export async function recoverWorkspacePod(plan: TeamPlan, sourceSha: string, pod: any, workload: any,
  application: any, stateRoot: string, exec: Run = run): Promise<boolean> {
  const { name, namespace, uid } = workload.metadata ?? {};
  if (!plan.authorizations.includes("recover") || !name || name !== namespace || !/^[a-z0-9-]+$/.test(name) ||
    !plan.sources.some(s => s.agents.some(a => name === `ag-eve-${a.name}`)) || workload.metadata.deletionTimestamp ||
    workload.spec?.replicas !== 1 || (workload.spec.ordinals?.start ?? 0) !== 0 ||
    application.metadata?.name !== name || application.metadata?.namespace !== "argocd" || application.status?.sync?.status !== "Synced" ||
    pod.metadata?.namespace !== namespace || pod.metadata?.name !== `${name}-0` || !pod.metadata?.uid || !pod.metadata?.resourceVersion ||
    pod.metadata.deletionTimestamp || !pod.metadata.ownerReferences?.some((o: any) => o.kind === "StatefulSet" && o.uid === uid) ||
    !workload.status?.updateRevision || !pod.metadata.labels?.["controller-revision-hash"] ||
    pod.metadata.labels["controller-revision-hash"] === workload.status.updateRevision ||
    pod.spec?.volumes?.some((v: any) => v.name === "workspaces") || !fs.existsSync(stateRoot)) return false;
  const receipts = recordedWorkspaceMigrations(pod, stateRoot).filter(r => r.controllerUid !== uid);
  if (receipts.length !== 1) return false;
  const prior = receipts[0];
  const manifests = parseAllDocuments(await argoDesiredManifests(plan, name, stateRoot, exec))
    .map(doc => { if (doc.errors.length) throw new Error("Invalid Argo desired manifest response"); return doc.toJSON(); });
  const candidates = manifests.filter(d => d?.apiVersion === "apps/v1" && d.kind === "StatefulSet" &&
    d.metadata?.name === name && (!d.metadata.namespace || d.metadata.namespace === namespace));
  if (candidates.length !== 1) return false;
  const desired = candidates[0], claims = workload.spec.volumeClaimTemplates;
  const declaredSha = desired.spec?.template?.spec?.initContainers?.flatMap((c: any) => c.env ?? []).find((e: any) => e.name === "EVE_DIST_SHA")?.value;
  if (digest(desired.spec) !== prior.desiredHash || declaredSha !== sourceSha ||
    desired.spec?.template?.spec?.containers?.find((c: any) => c.name === "eve-agent")?.image !== workloadRuntimeImage(plan, name) ||
    !Array.isArray(claims) || claims.length !== 2 || claims[0]?.metadata?.name !== "data" || claims[1]?.metadata?.name !== "workspaces" ||
    !isDeepStrictEqual(claims.map(normalizedClaim), desired.spec.volumeClaimTemplates.map(normalizedClaim)) ||
    !isDeepStrictEqual(workload.spec.selector, desired.spec.selector)) return false;
  const pvcs = JSON.parse(await exec(["kubectl", "--context", plan.kubeContext, "-n", namespace, "get", "pvc", "-o", "json"], stateRoot));
  const data = pvcs.items?.find((p: any) => p.metadata?.name === prior.dataClaim);
  const workspace = pvcs.items?.find((p: any) => p.metadata?.name === `workspaces-${name}-0`);
  if (!data || data.metadata.uid !== prior.dataClaimUid || data.status?.phase !== "Bound" || !workspace?.metadata?.uid ||
    !pod.spec?.volumes?.some((v: any) => v.name === "data" && v.persistentVolumeClaim?.claimName === data.metadata.name) ||
    [data, workspace].some(p => p.metadata.deletionTimestamp || p.metadata.ownerReferences?.some((o: any) => o.uid === pod.metadata.uid) ||
      !p.metadata.ownerReferences?.some((o: any) => o.kind === "StatefulSet" && o.uid === uid))) return false;
  const current = JSON.parse(await exec(["kubectl", "--context", plan.kubeContext, "-n", "argocd", "get", "application", name, "-o", "json"], stateRoot));
  if (current.metadata?.uid !== application.metadata.uid || !isDeepStrictEqual(current.spec, application.spec) || current.status?.sync?.status !== "Synced") return false;
  const key = digest({ podUid: pod.metadata.uid, controllerUid: uid, desiredRevision: workload.status.updateRevision });
  const receipt = path.join(stateRoot, `workspace-pod-recovery-${key}.json`);
  const previous = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : undefined;
  if (previous?.state === "accepted") return false;
  const attempt = (previous?.attempt ?? 0) + 1;
  if (attempt > 3) throw new Error(`Workspace pod rollout for ${name} exhausted three preconditioned attempts`);
  const evidence = { name, namespace, podUid: pod.metadata.uid, controllerUid: uid, dataClaimUid: data.metadata.uid, workspaceClaimUid: workspace.metadata.uid, attempt };
  fs.writeFileSync(receipt, JSON.stringify({ ...evidence, state: "requested" }), { mode: 0o600 });
  const request = path.join(stateRoot, `workspace-pod-delete-${key}.json`);
  fs.writeFileSync(request, JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background",
    preconditions: { uid: pod.metadata.uid, resourceVersion: pod.metadata.resourceVersion } }), { mode: 0o600 });
  try {
    await exec(["kubectl", "--context", plan.kubeContext, "delete", `--raw=/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}`, "-f", request], stateRoot);
    fs.writeFileSync(receipt, JSON.stringify({ ...evidence, state: "accepted" }), { mode: 0o600 });
    return true;
  } finally { fs.rmSync(request, { force: true }); }
}

/** Read desired state through Argo's API, then orphan only the verified controller.
 * UID/resourceVersion preconditions and an intent receipt bound the operation. The
 * existing pod and bound data PVC remain; Argo recreates and rolls the controller. */
export async function recoverWorkspaceClaim(plan: TeamPlan, sourceSha: string, pod: any, workload: any,
  application: any, stateRoot: string, exec: Run = run): Promise<boolean> {
  if (!plan.authorizations.includes("recover")) return false;
  const { name, namespace, uid, resourceVersion } = workload.metadata ?? {};
  if (!name || name !== namespace || !/^[a-z0-9-]+$/.test(name) || !uid || !resourceVersion ||
    !plan.sources.some(s => s.agents.some(a => name === `ag-eve-${a.name}`)) ||
    application.metadata?.name !== name || application.metadata?.namespace !== "argocd" ||
    pod.metadata?.namespace !== namespace || pod.metadata?.name !== `${name}-0` || pod.metadata?.deletionTimestamp ||
    !pod.metadata?.ownerReferences?.some((o: any) => o.kind === "StatefulSet" && o.uid === uid) ||
    !pod.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True")) return false;
  const failures = application.status?.operationState?.syncResult?.resources ?? [];
  if (!Array.isArray(application.spec?.sources)) return false;
  if (!failures.some((r: any) => r.kind === "StatefulSet" && r.name === name && r.namespace === namespace &&
    r.status === "SyncFailed" && /Forbidden: updates to statefulset spec/.test(r.message ?? ""))) return false;
  const output = await argoDesiredManifests(plan, name, stateRoot, exec);
  const manifests = parseAllDocuments(output).map(doc => { if (doc.errors.length) throw new Error("Invalid Argo desired manifest response"); return doc.toJSON(); });
  const candidates = manifests.filter(d => d?.apiVersion === "apps/v1" && d.kind === "StatefulSet" &&
    d.metadata?.name === name && (!d.metadata.namespace || d.metadata.namespace === namespace));
  if (candidates.length !== 1) return false;
  const desired = candidates[0];
  const declaredSha = desired.spec?.template?.spec?.initContainers?.flatMap((c: any) => c.env ?? []).find((e: any) => e.name === "EVE_DIST_SHA")?.value;
  if (declaredSha !== sourceSha || desired.spec?.template?.spec?.containers?.find((c: any) => c.name === "eve-agent")?.image !== workloadRuntimeImage(plan, name) ||
    !workspaceClaimAddition(workload, desired)) return false;
  const pvcs = JSON.parse(await exec(["kubectl", "--context", plan.kubeContext, "-n", namespace, "get", "pvc", "-o", "json"], stateRoot));
  const data = pvcs.items?.find((p: any) => p.metadata?.name === `data-${name}-0`);
  if (!data?.metadata?.uid || data.metadata.deletionTimestamp || data.status?.phase !== "Bound" ||
    !pod.spec?.volumes?.some((v: any) => v.name === "data" && v.persistentVolumeClaim?.claimName === data.metadata.name) ||
    pvcs.items.some((p: any) => p.metadata?.name === `workspaces-${name}-0`)) return false;
  // Ensure the Application did not change while Argo rendered its desired state.
  const current = JSON.parse(await exec(["kubectl", "--context", plan.kubeContext, "-n", "argocd", "get", "application", name, "-o", "json"], stateRoot));
  if (current.metadata?.uid !== application.metadata.uid || !isDeepStrictEqual(current.spec, application.spec)) return false;
  if (!isDeepStrictEqual(current.status?.operationState, application.status?.operationState)) return false;
  if (!isDeepStrictEqual(current.status.operationState.syncResult.sources, current.spec.sources)) {
    // Argo termination is the OperationState phase transition used by its own API.
    // The JSON tests bind it to this exact still-running stale operation. Stop it
    // before orphaning anything; the next pass verifies the current-source sync.
    const operation = current.status.operationState;
    if (!current.operation || operation.phase !== "Running" || !operation.startedAt || !current.metadata.resourceVersion) return false;
    const key = digest({ appUid: current.metadata.uid, startedAt: operation.startedAt, sources: current.spec.sources });
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const receipt = path.join(stateRoot, `workspace-sync-recovery-${key}.json`);
    const previous = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : undefined;
    if (previous?.state === "accepted") return false;
    const attempt = (previous?.attempt ?? 0) + 1;
    if (attempt > 3) throw new Error(`Stale workspace sync for ${name} exhausted three preconditioned attempts`);
    const evidence = { appUid: current.metadata.uid, name, startedAt: operation.startedAt, attempt };
    fs.writeFileSync(receipt, JSON.stringify({ ...evidence, state: "requested" }), { mode: 0o600 });
    const patch = path.join(stateRoot, `terminate-${key}.json`);
    fs.writeFileSync(patch, JSON.stringify([
      { op: "test", path: "/metadata/uid", value: current.metadata.uid },
      { op: "test", path: "/metadata/resourceVersion", value: current.metadata.resourceVersion },
      { op: "test", path: "/status/operationState/startedAt", value: operation.startedAt },
      { op: "test", path: "/status/operationState/phase", value: "Running" },
      { op: "replace", path: "/status/operationState/phase", value: "Terminating" },
    ]), { mode: 0o600 });
    try {
      await exec(["kubectl", "--context", plan.kubeContext, "-n", "argocd", "patch", "application", name, "--type=json", "--patch-file", patch, "-o", "name"], stateRoot);
      fs.writeFileSync(receipt, JSON.stringify({ ...evidence, state: "accepted" }), { mode: 0o600 });
      return true;
    } finally { fs.rmSync(patch, { force: true }); }
  }
  const key = digest({ uid, desired: desired.spec });
  const receipt = path.join(stateRoot, `workspace-recovery-${key}.json`);
  const evidence = { namespace, name, controllerUid: uid, podUid: pod.metadata.uid,
    dataClaim: data.metadata.name, dataClaimUid: data.metadata.uid, desiredHash: digest(desired.spec) };
  const previous = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : undefined;
  if (previous?.state === "accepted") return false;
  if (previous && (previous.state !== "requested" || previous.controllerUid !== uid ||
    previous.podUid !== evidence.podUid || previous.dataClaimUid !== evidence.dataClaimUid ||
    previous.desiredHash !== evidence.desiredHash)) throw new Error("Workspace migration receipt does not match fresh live evidence");
  const attempt = (previous?.attempt ?? 0) + 1;
  if (attempt > 3) throw new Error(`Workspace migration for ${name} exhausted three preconditioned attempts; inspect its private recovery receipt`);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  // A previous uncertain request is retried only after all fresh checks above show
  // the same healthy pod/data/controller, with no deletion in progress. An accepted
  // delete changes the controller resourceVersion and marks it for deletion.
  fs.writeFileSync(receipt, JSON.stringify({ ...evidence, attempt, resourceVersion, state: "requested", at: new Date().toISOString() }), { flag: previous ? "w" : "wx", mode: 0o600 });
  const request = path.join(stateRoot, `orphan-${key}.json`);
  fs.writeFileSync(request, JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions",
    preconditions: { uid, resourceVersion }, propagationPolicy: "Orphan" }), { mode: 0o600 });
  try {
    await exec(["kubectl", "--context", plan.kubeContext, "delete", `--raw=/apis/apps/v1/namespaces/${namespace}/statefulsets/${name}`, "-f", request], stateRoot);
    fs.writeFileSync(receipt, JSON.stringify({ ...evidence, attempt, resourceVersion, state: "accepted", at: new Date().toISOString() }), { mode: 0o600 });
    return true;
  } finally { fs.rmSync(request, { force: true }); }
}

export function failedOldPod(pod: any, workload: any): boolean {
  return Boolean(workload.metadata?.uid && workload.status?.updateRevision && pod.metadata?.uid &&
    pod.metadata.ownerReferences?.some((owner: any) => owner.kind === "StatefulSet" && owner.uid === workload.metadata.uid) &&
    pod.metadata.labels?.["controller-revision-hash"] && pod.metadata.labels["controller-revision-hash"] !== workload.status.updateRevision &&
    !pod.metadata.deletionTimestamp && !pod.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True") &&
    [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].some((c: any) =>
      ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError"].includes(c.state?.waiting?.reason) || (c.state?.terminated?.exitCode ?? 0) !== 0));
}
/** One graceful, UID-preconditioned delete per old pod and desired revision. Never deletes a
 * StatefulSet/PVC, never force deletes, and records intent before sending the request. */
export async function recoverOldPod(plan: TeamPlan, pod: any, workload: any, stateRoot: string, exec: Run = run): Promise<boolean> {
  if (!plan.authorizations.includes("recover") || !failedOldPod(pod, workload)) return false;
  // A failed workspace safety check must not fall through to generic pod deletion.
  if (recordedWorkspaceMigrations(pod, stateRoot).length) return false;
  const namespace = pod.metadata.namespace, name = pod.metadata.name;
  if (!plan.sources.some(s => s.agents.some(a => namespace === `ag-eve-${a.name}`)) || !/^[a-z0-9-]+$/.test(name)) return false;
  const key = `${pod.metadata.uid}-${workload.status.updateRevision}`;
  if (!/^[a-zA-Z0-9-]+$/.test(key)) throw new Error("Invalid recovery identity");
  const receipt = path.join(stateRoot, `recovery-${key}.json`);
  if (fs.existsSync(receipt)) return false;
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(receipt, JSON.stringify({ namespace, name, podUid: pod.metadata.uid, desiredRevision: workload.status.updateRevision, state: "requested", at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  const request = path.join(stateRoot, `delete-${key}.json`);
  fs.writeFileSync(request, JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: pod.metadata.uid }, propagationPolicy: "Background" }), { mode: 0o600 });
  try {
    await exec(["kubectl", "--context", plan.kubeContext, "delete", `--raw=/api/v1/namespaces/${namespace}/pods/${name}`, "-f", request], stateRoot);
    fs.writeFileSync(receipt, JSON.stringify({ namespace, name, podUid: pod.metadata.uid, desiredRevision: workload.status.updateRevision, state: "accepted", at: new Date().toISOString() }), { mode: 0o600 });
    return true;
  } finally { fs.rmSync(request, { force: true }); }
}
