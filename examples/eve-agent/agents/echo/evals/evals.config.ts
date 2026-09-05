// Eve's own eval runner configuration (docs/evals). Every evals/ directory
// needs exactly one of these at its root. No judge model: the echo agent's
// evals are fully deterministic, and the platform runs them against the
// DEPLOYED agent (`hg agent evals` -> `eve eval --url` from inside the pod),
// where a judge would need a second model credential.
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  maxConcurrency: 2,
  timeoutMs: 120_000,
});
