// Runtime config for the greeter agent - same model and credential story as
// echo (agents/echo/agent/agent.ts). No agent/channels/eve.ts is authored
// here on purpose: the platform installs its default route-auth channel at
// build time, and this project proves that path.
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-haiku-4-5"),
});
