import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "../lib.ts";
import type { AppliedRecord } from "./inputs.ts";

export const STAGES = ["validated", "runtime-verified", "provisioned", "published", "ready", "transport-verified", "active", "acceptance-verified"] as const;
export type Stage = typeof STAGES[number];
/** Why an unattended run stopped without failing: a decision or event only a human, a merge or
 * time can supply (ADR 0191). Present only on `unknown` evidence. */
export type PendingReason = "approval-required" | "merge-pending" | "authorization" | "activation-change" | "acceptance-opt-in" | "in-flight";
export interface Pending { reason: PendingReason; link?: string }
export interface Evidence { verdict: "pass" | "fail" | "unknown"; summary: string; receipts?: string[]; pending?: Pending }
export interface StageRecord extends Evidence { stage: Stage; input: string; startedAt: string; finishedAt: string }
export interface Ledger {
  version: 1;
  installation: string;
  input: string;
  startedAt: string;
  updatedAt: string;
  running?: { stage: Stage; startedAt: string; pid: number };
  stages: Partial<Record<Stage, StageRecord>>;
  history: StageRecord[];
  complete: boolean;
  /** What the destination declares per source and the agent-inputs digest behind it (ADR 0198):
   * what a later run carries forward from. Absent until a publication stands. */
  applied?: AppliedRecord;
  /** Set when THIS run applied new commits without a rollout, and why; cleared by any other run. */
  skipped?: { reason: string; at: string };
}
export function readLedger(file: string, installation: string, input: string): Ledger {
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as Ledger;
    if (existing.version !== 1 || existing.installation !== installation) throw new Error("Installation ledger identity/version mismatch");
    if (existing.input !== input) return { ...existing, input, stages: {}, running: undefined, complete: false };
    return existing;
  }
  const now = new Date().toISOString();
  return { version: 1, installation, input, startedAt: now, updatedAt: now, stages: {}, history: [], complete: false };
}
export function saveLedger(file: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export interface StageOperation {
  /** Evidence of a pure check over immutable inputs may be reused at the same fingerprint. */
  immutable?: boolean;
  /** Re-observe external state; a past successful action alone is insufficient. */
  probe?: () => Promise<Evidence>;
  apply: () => Promise<Evidence>;
}
export async function executeStages(file: string, ledger: Ledger, operations: Record<Stage, StageOperation>, report: (stage: Stage) => void = () => {}): Promise<Ledger> {
  ledger.complete = false;
  for (const stage of STAGES) {
    const operation = operations[stage];
    const previous = ledger.stages[stage];
    if (previous?.verdict === "pass" && previous.input === ledger.input && operation.immutable) continue;
    if (previous?.verdict === "pass" && previous.input === ledger.input && operation.probe) {
      let observed: Evidence;
      try { observed = await operation.probe(); }
      catch (error) {
        const failed: StageRecord = { stage, input: ledger.input, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), verdict: "unknown",
          summary: error instanceof CliError ? error.message : `Could not re-observe ${stage}; no mutation attempted` };
        ledger.stages[stage] = failed; ledger.history.push(failed); ledger.running = undefined;
        saveLedger(file, ledger); return ledger;
      }
      if (observed.verdict === "pass") continue;
    }
    // Downstream evidence depends on this stage, including after an interrupted run.
    for (const downstream of STAGES.slice(STAGES.indexOf(stage))) delete ledger.stages[downstream];
    const startedAt = new Date().toISOString();
    ledger.running = { stage, startedAt, pid: process.pid }; saveLedger(file, ledger); report(stage);
    let evidence: Evidence;
    try { evidence = await operation.apply(); }
    catch (error) { evidence = { verdict: "fail", summary: error instanceof CliError ? error.message : `Stage ${stage} failed; inspect private provider diagnostics and resume after repairing its declared prerequisites` }; }
    const record: StageRecord = { ...evidence, stage, input: ledger.input, startedAt, finishedAt: new Date().toISOString() };
    ledger.stages[stage] = record; ledger.history.push(record); ledger.updatedAt = record.finishedAt;
    ledger.running = undefined; saveLedger(file, ledger);
    if (evidence.verdict !== "pass") return ledger;
  }
  ledger.complete = STAGES.every(stage => ledger.stages[stage]?.verdict === "pass");
  saveLedger(file, ledger); return ledger;
}
