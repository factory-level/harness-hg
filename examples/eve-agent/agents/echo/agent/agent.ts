// Runtime config for the echo agent. The model is Anthropic's, called
// DIRECTLY through its AI SDK provider (not the Vercel AI Gateway), so the
// one credential the pod needs is ANTHROPIC_API_KEY - the same variable the
// platform's Hermes agents use - declared in hermes-gitops.yaml
// runtime.envRequires and delivered by the env Secret, never written here.
// Direct provider ids use the provider's native hyphenated form.
//
// limits (ADR-150 platform guidance): eve's local Workflow world is a
// file store on the agent's data volume that eve never garbage-collects,
// and a session's default lifetime is 30 days with a 40M-input-token
// budget. Bounding both keeps the volume - and the backup archive - sized
// by intent rather than by accident.
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-haiku-4-5"),
  limits: {
    maxInputTokensPerSession: 2_000_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
