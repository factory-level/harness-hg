// `hg agent prove` — the harness-neutral acceptance entry (ADR 0177).
// Subject-level dispatch: each harness keeps its OWN matrix (proveEve for
// Eve, proveHermes below for the frozen legacy harness) and the results
// merge into one ProofResult. The HarnessDriver interface deliberately
// stays {invoke, show, exec} (ADR-153): deployment and acceptance differ
// too much per harness for one interface to be honest.
import { proveEve } from "../harness/eve/index.ts";
import { showAgent } from "../harness/index.ts";
import { type ProfileCtx } from "../lib.ts";
import { tierSmoke } from "../local/test.ts";
import type { ProofFinding, ProofResult } from "../proof.ts";

export interface ProveHermesDeps {
  show: typeof showAgent;
  smoke: typeof tierSmoke;
}

function summarize(findings: ProofFinding[]) {
  return {
    pass: findings.filter((f) => f.status === "pass").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };
}

function result(findings: ProofFinding[], startedAt: string): ProofResult {
  const summary = summarize(findings);
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "hg agent prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    findings,
    summary,
  };
}

/** HRM001..002 for every Hermes profile: the frozen harness is up,
 * readable and converged. Deliberately shallow (ADR 0177) — deep Hermes
 * acceptance stays `hg test`, and the matrix says so rather than
 * pretending breadth it does not have. */
export async function proveHermes(
  ctxs: ProfileCtx[],
  deps: ProveHermesDeps = { show: showAgent, smoke: tierSmoke },
): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });
  for (const ctx of ctxs.filter((c) => c.runtime !== "eve")) {
    // HRM001 — the running pod answers `agent show` with a coherent
    // snapshot. A declared cron job nothing activated is exactly the
    // drift the snapshot exists to surface, so it fails the leg here
    // instead of hiding in prose.
    try {
      const snap = await deps.show(ctx);
      if (!snap.ok) {
        add("HRM001", "unknown", ctx.name, `agent show could not read the pod: ${snap.error ?? "unreachable"}`);
      } else {
        // Declarations are the cron/*.yaml FILE names; activated jobs are
        // NAMED by their stem. Comparing the file name verbatim reported
        // every declared job as never activated on factory (2026-09-03).
        const declared = (snap.cronDeclarations ?? []).map((d) => d.replace(/\.ya?ml$/, ""));
        const active = new Set((snap.cron ?? []).map((j) => j.name));
        const missing = declared.filter((d) => !active.has(d));
        add(
          "HRM001",
          missing.length === 0 ? "pass" : "fail",
          ctx.name,
          missing.length === 0
            ? "snapshot coherent; every declared cron job is activated"
            : `declared cron never activated: ${missing.join(", ")} (converge with hg agent apply)`,
        );
      }
    } catch (e) {
      add("HRM001", "unknown", ctx.name, `agent show failed: ${(e as Error).message}`);
    }
    // HRM002 — the smoke tier, the existing real exercise, reused rather
    // than reimplemented.
    try {
      const pass = await deps.smoke(ctx);
      add("HRM002", pass ? "pass" : "fail", ctx.name, pass ? "smoke tier passed" : "smoke tier failed (see output above)");
    } catch (e) {
      add("HRM002", "unknown", ctx.name, `smoke tier could not run: ${(e as Error).message}`);
    }
  }
  return result(findings, startedAt);
}

/** The harness-neutral matrix: partition the selection by runtime, run
 * each harness's own matrix, merge into one ProofResult (ADR 0177). */
export async function proveAgentRuntime(
  ctxs: ProfileCtx[],
  opts: { deep?: boolean; hermesDeps?: ProveHermesDeps } = {},
): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const eveCtxs = ctxs.filter((c) => c.runtime === "eve");
  const hermesCtxs = ctxs.filter((c) => c.runtime !== "eve");
  const findings: ProofFinding[] = [];
  if (eveCtxs.length) findings.push(...(await proveEve(eveCtxs, { deep: opts.deep })).findings);
  if (hermesCtxs.length) findings.push(...(await proveHermes(hermesCtxs, opts.hermesDeps)).findings);
  return result(findings, startedAt);
}
