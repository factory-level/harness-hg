// The agent's runtime config - the Eve project the pod builds and runs.
// The one credential it needs is ANTHROPIC_API_KEY, declared in
// ../harness-hg/agent.yaml envRequires and delivered by the env Secret,
// never written here. Bound limits keep the data volume (and its backup
// archive) sized by intent.
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-haiku-4-5"),
  limits: {
    maxInputTokensPerSession: 2_000_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
