// The AI harness registry (ADR-153): ONE directory holds every agent
// runtime driver, and this file is the only place `hg` branches on which
// runtime a profile is on.
//
//   harness/
//     types.ts    the shapes both drivers produce
//     manifest.ts the runtime manifest, computed offline from declarations
//     eve/        the Eve driver (session API over a port-forward)
//     hermes/     the Hermes driver (`kubectl exec hermes` in the pod)
//
// What is deliberately NOT behind this interface: deployment, backup and
// the acceptance matrices. The engines differ in how they build, how they
// persist and what "proven" means for them, and a lowest-common-
// denominator interface over those would be a lie with a type signature.
// Those live in each engine's chart, its emitter driver and its own
// module - findable, because they are all under one directory now.

import type { AgentRuntime, ProfileCtx } from "../lib.ts";
import { eveDriver } from "./eve/index.ts";
import { hermesDriver } from "./hermes/index.ts";
import type { AgentSnapshot, HarnessDriver, TurnResult } from "./types.ts";

export * from "./types.ts";

/** Every harness the platform can deploy an agent onto. Adding a third
 * means adding a directory beside eve/ and hermes/ and one line here. */
export const DRIVERS: Record<AgentRuntime, HarnessDriver> = {
  eve: eveDriver,
  hermes: hermesDriver,
};

/** The driver for a profile's runtime. */
export function driverFor(ctx: ProfileCtx): HarnessDriver {
  return DRIVERS[ctx.runtime];
}

/** ONE prompt against a deployed agent, whichever runtime it runs on: the
 * Hermes path execs `hermes -p <name> -z` in the pod, the Eve path drives
 * the session API. Every caller that used to call `promptAgent` directly
 * (`hg prompt`, the eval runner) goes through here. */
export function invokeAgent(ctx: ProfileCtx, prompt: string, timeoutSec: number): Promise<TurnResult> {
  return driverFor(ctx).invoke(ctx, prompt, timeoutSec);
}

/** What the deployed agent is configured with, in one shape for both
 * engines (`hg agent show`). */
export function showAgent(ctx: ProfileCtx, timeoutSec?: number): Promise<AgentSnapshot> {
  return driverFor(ctx).show(ctx, timeoutSec);
}
