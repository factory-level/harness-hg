// The CLI's one proof contract: every `prove` verb returns a ProofResult
// (numbered findings, each pass | fail | unknown - and unknown is NEVER a
// pass). Hoisted out of platform-backup.ts (final-pass wave 1) so the
// subject that happened to define it first no longer owns the type every
// other prove implementation imports.

export interface ProofFinding {
  id: string;
  status: "pass" | "fail" | "unknown";
  component: string;
  message: string;
}

export interface ProofResult {
  apiVersion: "cli.hermes.dev/v1alpha1";
  kind: "ProofResult";
  command: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  findings: ProofFinding[];
  summary: { pass: number; fail: number; unknown: number };
}
