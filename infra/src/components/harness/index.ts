// The AI harness components (ADR-153): everything the bootstrap does to
// stand an agent RUNTIME up, in one directory.
//
//   hermes-install/  stage 1 - the Hermes fork CLI + this plugin on the
//                    operator host (Hermes only; an Eve host has none)
//   hermes-agent/    stage 2 - `hermes profile install` per Hermes agent
//   eve-agent/       stage 2 - `python -m gitops_emitter.emit_cli
//                    --runtime eve` per Eve agent
//
// The Pulumi resource TYPE strings are unchanged by this move
// ("hermes-gitops:bootstrap:EveAgents", ...), so no URN moved and no stack
// needs a rename: the directory is for readers, not for Pulumi.
export * from "./hermes-install/index.ts";
export * from "./hermes-agent/index.ts";
export * from "./eve-agent/index.ts";
