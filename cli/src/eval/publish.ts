// `hg eval publish|results|prove` (#280, ADR-57): the reference client for
// the eval publisher contract.
//
// The token never appears in argv. It comes from HG_EVAL_TOKEN or a file,
// because argv is visible to every process on the box via /proc and shows
// up in shell history - the same rule the reconciler follows for its git
// credential.

import * as fs from "node:fs";
import * as path from "node:path";
import type { EvalReport, RunStatus } from "./index.ts";
import { secretScan } from "../nexus/prove.ts";
import type { ProofFinding, ProofResult } from "../backup/platform.ts";

export const EVAL_RESULT_API_VERSION = "hermes.dev/eval-result/v1alpha1";

export interface EvalRecord {
  runId: string;
  componentId: string;
  suite: string;
  scenario: string;
  status: RunStatus;
  harness: string;
  ranAt: string;
  durationMs?: number;
  score?: number;
}

/** Resolve the bearer token WITHOUT ever touching argv. */
export function readToken(tokenFile?: string): string {
  if (tokenFile) {
    const raw = fs.readFileSync(tokenFile, "utf8").trim();
    if (!raw) throw new Error(`token file ${tokenFile} is empty`);
    return raw;
  }
  const env = process.env["HG_EVAL_TOKEN"]?.trim();
  if (!env) {
    throw new Error(
      "no publish token: set HG_EVAL_TOKEN or pass --token-file <path> " +
        "(a token is never accepted on the command line - argv is world-readable)",
    );
  }
  return env;
}

/** EvalReport -> publish envelope.
 *
 * The runId is derived, not random: `<stamp>/<scenario>/run-<n>` is the
 * run's own artifact-directory identity, so re-publishing the same report
 * is a no-op on the server rather than a duplicate result. That is what
 * makes a failed publish safe to simply retry. */
export function recordsFromReport(report: EvalReport, componentOverride?: string): EvalRecord[] {
  const stamp = report.stamp;
  const suite = report.suite;
  if (!stamp || !suite) {
    throw new Error("this report has no suite/stamp - it never ran (schema errors stop everything)");
  }
  const records: EvalRecord[] = [];
  for (const scenario of report.scenarios) {
    scenario.runs.forEach((run, i) => {
      records.push({
        runId: `${stamp}/${scenario.name}/run-${run.run ?? i + 1}`,
        componentId: componentOverride ?? scenario.profile,
        suite,
        scenario: scenario.name,
        status: run.status,
        harness: "hg eval",
        ranAt: new Date().toISOString(),
        durationMs: run.durationMs,
      });
    });
  }
  if (records.length === 0) throw new Error("this report contains no runs to publish");
  return records;
}

/** Cloudflare Access service-token headers, or {} when unconfigured.
 *
 * The factory Nexus sits behind an Access app, and a browser login cannot
 * be replayed by a CLI - the eval-publisher service token (minted by the
 * bootstrap, exported as stack outputs) is what lets `hg eval
 * publish|results|prove` traverse that edge. Env-only, same argv rule as
 * the bearer token; half a credential fails loudly instead of sending an
 * anonymous request that dies as an HTML login page. */
export function accessHeaders(): Record<string, string> {
  const id = process.env["HG_CF_ACCESS_CLIENT_ID"]?.trim();
  const secret = process.env["HG_CF_ACCESS_CLIENT_SECRET"]?.trim();
  if (!id && !secret) return {};
  if (!id || !secret) {
    throw new Error(
      "half an Access credential: set BOTH HG_CF_ACCESS_CLIENT_ID and HG_CF_ACCESS_CLIENT_SECRET (or neither)",
    );
  }
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

async function post(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...accessHeaders() },
    body: JSON.stringify(body),
  });
}

function base(controlPlane: string): string {
  return `${controlPlane.replace(/\/+$/, "")}/api/plugins/hermes-gitops`;
}

export async function publishEvalReport(inputs: {
  reportPath: string;
  controlPlane: string;
  component?: string;
  tokenFile?: string;
}): Promise<{ ok: boolean; written: number; deduped: number; dropped: number }> {
  const report = JSON.parse(fs.readFileSync(inputs.reportPath, "utf8")) as EvalReport;
  const records = recordsFromReport(report, inputs.component);
  const token = readToken(inputs.tokenFile);
  const resp = await post(`${base(inputs.controlPlane)}/nexus/evals/publish`, token, {
    apiVersion: EVAL_RESULT_API_VERSION,
    records,
  });
  const text = await resp.text();
  if (!resp.ok) {
    // Surface the server's reason verbatim: a 403 names the component it
    // refused, which is exactly what the operator needs to fix a scope.
    throw new Error(`publish failed (${resp.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

export async function fetchEvalResults(inputs: {
  controlPlane: string;
  component: string;
  suite?: string;
  scenario?: string;
  limit?: number;
}): Promise<{ component: string; total: number; records: EvalRecord[] }> {
  const params = new URLSearchParams({ component: inputs.component });
  if (inputs.suite) params.set("suite", inputs.suite);
  if (inputs.scenario) params.set("scenario", inputs.scenario);
  if (inputs.limit) params.set("limit", String(inputs.limit));
  const resp = await fetch(`${base(inputs.controlPlane)}/nexus/evals/results?${params}`, {
    headers: accessHeaders(),
  });
  if (!resp.ok) throw new Error(`results unavailable (${resp.status})`);
  return (await resp.json()) as { component: string; total: number; records: EvalRecord[] };
}

/** EVALPUB001..004. Every leg is about the publisher being safe, not about
 * it being convenient: unauthenticated writes are refused, forged tokens
 * are refused, the served document matches the frozen contract, and what
 * comes back carries no credential material. */
export async function proveEvalPublishing(inputs: {
  controlPlane?: string;
  component?: string;
}): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });

  if (!inputs.controlPlane) {
    for (const id of ["EVALPUB001", "EVALPUB002", "EVALPUB003", "EVALPUB004"]) {
      add(id, "unknown", "evals", "no --control-plane; the publisher was not checked");
    }
    return envelope(startedAt, findings);
  }
  const url = `${base(inputs.controlPlane)}/nexus/evals/publish`;
  const batch = {
    apiVersion: EVAL_RESULT_API_VERSION,
    records: [
      {
        runId: "prove-should-never-be-stored",
        componentId: "prove-nonexistent",
        suite: "prove",
        scenario: "prove",
        status: "pass",
        harness: "hg eval prove",
        ranAt: new Date().toISOString(),
      },
    ],
  };

  try {
    // "Anonymous" means no BEARER - the Access headers still ride, because
    // the check is about the app's 401, not about Cloudflare's login page.
    const anon = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...accessHeaders() },
      body: JSON.stringify(batch),
    });
    add(
      "EVALPUB001",
      anon.status === 401 ? "pass" : "fail",
      "evals",
      `unauthenticated publish returned ${anon.status} (want 401)`,
    );
  } catch (err) {
    add("EVALPUB001", "fail", "evals", `publisher unreachable: ${(err as Error).message}`);
  }

  try {
    const forged = await post(url, "hgev_definitely-not-a-real-token", batch);
    add(
      "EVALPUB002",
      forged.status === 401 ? "pass" : "fail",
      "evals",
      `forged bearer returned ${forged.status} (want 401)`,
    );
  } catch (err) {
    add("EVALPUB002", "fail", "evals", `publisher unreachable: ${(err as Error).message}`);
  }

  const component = inputs.component;
  if (!component) {
    add("EVALPUB003", "unknown", "evals", "no --component; readback not checked");
    add("EVALPUB004", "unknown", "evals", "no --component; results not scanned");
    return envelope(startedAt, findings);
  }
  try {
    const doc = await fetchEvalResults({ controlPlane: inputs.controlPlane, component });
    const bad = doc.records.filter(
      (r) => !r.runId || !r.componentId || !r.suite || !r.scenario || !r.status || !r.harness,
    );
    add(
      "EVALPUB003",
      bad.length === 0 ? "pass" : "fail",
      "evals",
      bad.length === 0
        ? `${doc.total} record(s) carry every required field`
        : `${bad.length} record(s) are missing required fields`,
    );
    const leaks = secretScan("eval results", JSON.stringify(doc));
    add(
      "EVALPUB004",
      leaks.length === 0 ? "pass" : "fail",
      "evals",
      leaks.length === 0
        ? "no credential-shaped material in the served results"
        : `credential-shaped material: ${leaks.map((l) => l.pattern).join(", ")}`,
    );
  } catch (err) {
    add("EVALPUB003", "fail", "evals", `readback failed: ${(err as Error).message}`);
    add("EVALPUB004", "unknown", "evals", "readback failed; results not scanned");
  }
  return envelope(startedAt, findings);
}

function envelope(startedAt: string, findings: ProofFinding[]): ProofResult {
  const summary = {
    pass: findings.filter((f) => f.status === "pass").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "eval prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    findings,
    summary,
  };
}

/** Newest report under $HG_HOME/eval-runs, for the no-argument case. */
export function latestReport(evalRunsDir: string): string | undefined {
  if (!fs.existsSync(evalRunsDir)) return undefined;
  const stamps = fs
    .readdirSync(evalRunsDir)
    .filter((d) => fs.existsSync(path.join(evalRunsDir, d, "report.json")))
    .sort();
  const newest = stamps[stamps.length - 1];
  return newest ? path.join(evalRunsDir, newest, "report.json") : undefined;
}
