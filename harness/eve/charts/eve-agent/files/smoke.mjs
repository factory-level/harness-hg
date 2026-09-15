// harness/eve/charts/eve-agent/files/smoke.mjs - the PostSync smoke check (ADR 0195).
// harness/eve/charts/eve-bundle/files/smoke.mjs is a byte-identical copy
// (render-test cmp-gates it); edit this one and copy.
//
// The startup gate (files/verify-build.mjs) keeps a wrong build from becoming
// ready. This runs once per sync, from outside the pod, and answers the other
// question: did THIS sync land? It fails the Argo CD sync when it did not, so a
// bad revision is visible in the Application rather than only in a pod that
// quietly never went ready.
//
// It reads the cluster through the ServiceAccount this chart binds (pods and
// statefulsets, get/list) - no kubectl in the image, no cluster-wide rights.
const API = "https://kubernetes.default.svc";
const TOKEN_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const CA_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

import { readFileSync } from "node:fs";

const failures = [];
const fail = (reason) => failures.push(reason);
const ok = (what) => console.log(`[smoke] OK   ${what}`);

const namespace = process.env.HG_NAMESPACE;
const workload = process.env.HG_WORKLOAD;
if (!namespace || !workload || !(process.env.HG_AGENT_URL || process.env.HG_AGENT_HOST)) {
  console.error("[smoke] HG_NAMESPACE, HG_WORKLOAD and HG_AGENT_URL (or HG_AGENT_HOST) are required");
  process.exit(1);
}

// The API server's certificate is the cluster's own. The Job sets
// NODE_EXTRA_CA_CERTS to the mounted CA, which is the dependency-free way to
// trust exactly that one - the runtime image ships no HTTP client library.
if (process.env.NODE_EXTRA_CA_CERTS !== CA_FILE) {
  console.error(`[smoke] NODE_EXTRA_CA_CERTS must be ${CA_FILE}; the chart sets it`);
  process.exit(1);
}
const token = readFileSync(TOKEN_FILE, "utf8").trim();
const api = async (path) => {
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
};

// ---- 1. the rollout finished: the pod runs the revision the sync produced ----
let statefulSet, pod;
try {
  statefulSet = await api(`/apis/apps/v1/namespaces/${namespace}/statefulsets/${workload}`);
  const pods = await api(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/instance=${workload}`)}`);
  pod = (pods.items ?? []).find((p) => p.metadata?.ownerReferences?.some((o) => o.kind === "StatefulSet" && o.name === workload));
} catch (error) {
  console.error(`[smoke] cannot read the workload: ${error.message}`);
  process.exit(1);
}
if (!pod) {
  console.error(`[smoke] no pod owned by StatefulSet ${workload}`);
  process.exit(1);
}
const updateRevision = statefulSet.status?.updateRevision;
const podRevision = pod.metadata?.labels?.["controller-revision-hash"];
if (updateRevision && podRevision === updateRevision) ok(`pod runs the updated revision (${podRevision})`);
else fail(`pod revision ${podRevision ?? "unknown"} is not the StatefulSet's update revision ${updateRevision ?? "unknown"}`);

// ---- 2 & 3. per agent: what it built, and that it answers as itself ----
// One workload may host many agents (the bundle chart). HG_MEMBERS lists them as
// name:port:sha:runtimeDigest, and its PRESENCE - never the member count - is what
// selects bundle mode: a one-member bundle must still be checked as a bundle.
const bundled = Boolean(process.env.HG_MEMBERS);
const members = bundled
  ? process.env.HG_MEMBERS.split(",").filter(Boolean).map((entry) => {
      const [name, port, sha, runtimeDigest] = entry.split(":");
      return { label: name, initContainer: `build-${name}`,
        url: `http://${process.env.HG_AGENT_HOST}:${port}`,
        manifest: `/hg/${name}/runtime-manifest.json`,
        password: `/run/secrets/route-auth/${name}/password`,
        // A bundle member's build key IS its source sha: members carry no overlays.
        expected: { sourceSha: sha, buildKey: sha, runtimeDigest,
          eveVersion: process.env.HG_EXPECTED_EVE_VERSION } };
    })
  : [{ label: workload, initContainer: "build-agent",
      url: process.env.HG_AGENT_URL, manifest: "/hg/runtime-manifest.json",
      password: "/run/secrets/route-auth/password",
      expected: { sourceSha: process.env.HG_EXPECTED_SOURCE_SHA,
        overlayDigest: process.env.HG_EXPECTED_OVERLAY_DIGEST,
        buildKey: process.env.HG_EXPECTED_BUILD_KEY,
        runtimeDigest: process.env.HG_EXPECTED_RUNTIME_DIGEST,
        eveVersion: process.env.HG_EXPECTED_EVE_VERSION } }];

for (const member of members) {
  const at = bundled ? `${member.label}: ` : "";

  // The build container publishes its receipt through the termination message,
  // so this needs no exec and no volume access.
  const buildStatus = (pod.status?.initContainerStatuses ?? []).find((c) => c.name === member.initContainer);
  const message = buildStatus?.state?.terminated?.message ?? buildStatus?.lastState?.terminated?.message;
  let receipt;
  try {
    const parsed = JSON.parse(message);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    receipt = parsed;
  } catch {
    fail(`${at}the build container published no readable build receipt; this pod cannot prove what it built`);
  }
  if (receipt) {
    for (const [field, label] of [["sourceSha", "source commit"], ["overlayDigest", "operator overlay digest"],
      ["buildKey", "build key"], ["runtimeDigest", "runtime manifest digest"], ["eveVersion", "Eve release"]]) {
      const expected = member.expected[field];
      if (!expected) continue;
      if (receipt[field] === expected) ok(`${at}${label} matches (${expected})`);
      else fail(`${at}${label}: this sync deployed ${expected} but the build receipt says ${receipt[field] || "nothing"}`);
    }
  }

  // It answers, and answers as the agent its runtime manifest declares.
  let expectedName;
  try {
    expectedName = JSON.parse(readFileSync(member.manifest, "utf8")).spec?.name;
  } catch (error) {
    fail(`${at}cannot read the runtime manifest (${error.message})`);
  }
  try {
    const health = await fetch(`${member.url}/eve/v1/health`);
    if (health.ok) ok(`${at}GET /eve/v1/health -> 200`);
    else fail(`${at}GET /eve/v1/health -> ${health.status}`);
  } catch (error) {
    fail(`${at}GET /eve/v1/health did not answer (${error.cause?.code ?? error.message})`);
  }
  try {
    // Route auth is the contract, not a detail: an agent reachable anonymously
    // is a failed sync even when every version matches.
    const anonymous = await fetch(`${member.url}/eve/v1/info`);
    if (anonymous.status === 401) ok(`${at}GET /eve/v1/info is 401 without credentials`);
    else fail(`${at}GET /eve/v1/info answered ${anonymous.status} anonymously; route auth is not in force`);

    const password = readFileSync(member.password, "utf8");
    const authorization = `Basic ${Buffer.from(`${process.env.HG_ROUTE_AUTH_USERNAME || "agent"}:${password}`).toString("base64")}`;
    const info = await fetch(`${member.url}/eve/v1/info`, { headers: { authorization } });
    if (!info.ok) {
      fail(`${at}GET /eve/v1/info with the minted credential answered ${info.status}`);
    } else {
      const body = await info.json();
      const name = body?.agent?.name ?? body?.agent?.id;
      // Unknown is never a pass (ADR 0195): a manifest that declares no identity is
      // missing evidence, not permission to accept whatever answered.
      if (!expectedName) fail(`${at}the runtime manifest declares no agent name; this sync cannot prove which agent answered`);
      else if (name === expectedName) ok(`${at}the agent identifies as ${JSON.stringify(name)}`);
      else fail(`${at}the agent identifies as ${JSON.stringify(name ?? null)}, but its runtime manifest declares ${JSON.stringify(expectedName)}`);
      if (body?.tools === undefined || body?.channels === undefined) fail(`${at}GET /eve/v1/info carries no tools/channels block`);
    }
  } catch (error) {
    fail(`${at}GET /eve/v1/info did not answer (${error.cause?.code ?? error.message})`);
  }
}

if (failures.length) {
  for (const reason of failures) console.error(`[smoke] FAIL ${reason}`);
  console.error(`[smoke] ${failures.length} check(s) failed for ${workload}`);
  process.exit(1);
}
console.log(`[smoke] ${workload}: every check passed`);
