// Eve's own eval runner configuration. Every evals/ directory needs exactly
// one at its root. No judge model: these evals are deterministic, and the
// platform runs them against the DEPLOYED agent (`hg agent evals` runs
// `eve eval --url` from inside the pod).
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  maxConcurrency: 2,
  timeoutMs: 120_000,
});
