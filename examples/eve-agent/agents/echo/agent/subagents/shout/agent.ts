// A declared subagent (docs/subagents): its own agent root, inheriting
// NOTHING from echo - model, instructions and tools are all its own. The
// parent reads `description` to decide when to delegate; eve's compiler
// refuses a subagent without one. Delegation shows on the parent's stream
// as subagent.called / subagent.completed with a childSessionId (the
// platform's EVE016 proof and the delegation eval assert exactly that).
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Turns a short text into its upper-case shouted form. Use it when the user asks to shout something.",
  model: anthropic("claude-haiku-4-5"),
});
