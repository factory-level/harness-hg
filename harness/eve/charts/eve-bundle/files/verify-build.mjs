// harness/eve/charts/eve-agent/files/verify-build.mjs - the startup gate (ADR 0195).
// harness/eve/charts/eve-bundle/files/verify-build.mjs is a byte-identical copy
// (render-test cmp-gates it); edit this one and copy.
//
// Argo CD "Healthy" only means the process answered a liveness probe. This runs
// as the startup probe INSTEAD of the health GET: it first compares what the
// build container actually built - the receipt on the data volume - with what
// this pod was rendered to run, and only then checks health. A pod that built
// something else never becomes ready, so a mismatch takes the agent out of
// service rather than serving the wrong version quietly.
//
// Every expected value is optional: an unset HG_EXPECTED_* is a field this
// deployment does not pin, and is skipped rather than failed. That keeps the
// probe usable on a pod whose record predates the field.
import { readFileSync } from "node:fs";

const fail = (reason) => { console.error(`[verify-build] ${reason}`); process.exit(1); };

const receiptPath = process.env.HG_BUILD_RECEIPT;
if (!receiptPath) fail("HG_BUILD_RECEIPT is unset; the chart must name the receipt path");

let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
} catch (error) {
  // No receipt at all is a build that never completed, or a pod that predates
  // receipts and has not rebuilt since. Either way this pod cannot prove what
  // it is running.
  fail(`no readable build receipt at ${receiptPath} (${error.code ?? error.message}); the build has not completed on this volume`);
}

const checks = [
  ["sourceSha", "HG_EXPECTED_SOURCE_SHA", "source commit"],
  ["overlayDigest", "HG_EXPECTED_OVERLAY_DIGEST", "operator overlay digest"],
  ["buildKey", "HG_EXPECTED_BUILD_KEY", "build key"],
  ["runtimeDigest", "HG_EXPECTED_RUNTIME_DIGEST", "runtime manifest digest"],
  ["eveVersion", "HG_EXPECTED_EVE_VERSION", "Eve release"],
];
for (const [field, variable, label] of checks) {
  const expected = process.env[variable];
  if (!expected) continue;
  const built = receipt[field];
  if (built !== expected) {
    fail(`${label}: this pod is rendered for ${expected} but the build receipt says ${built || "nothing"}`);
  }
}

// Only once the build is the intended one does readiness depend on the process.
const port = process.env.PORT || "3000";
try {
  const response = await fetch(`http://127.0.0.1:${port}/eve/v1/health`);
  if (!response.ok) fail(`build matches, but /eve/v1/health answered ${response.status}`);
} catch (error) {
  fail(`build matches, but /eve/v1/health is not answering yet (${error.cause?.code ?? error.message})`);
}
