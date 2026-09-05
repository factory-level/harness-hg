// A declared subagent: its own agent root, inheriting nothing from the
// parent. The parent reads `description` to decide when to delegate.
// Delegation shows on the parent's stream as subagent.called /
// subagent.completed, which `hg agent prove` (EVE016) and the delegation
// eval assert.
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  description: "Turns a short text into its upper-case shouted form. Use it when the user asks to shout something.",
  model: anthropic("claude-haiku-4-5"),
});
