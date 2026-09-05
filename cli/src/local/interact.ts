// Extracted from main.ts (final-pass #657): see the subject directory contract.
import { invokeAgent } from "../harness/index.ts";
import { CliError, jsonOut, loadState, log, profileCtxs } from "../lib.ts";
import { appConditions, appStatus, appStatusOf, applicationOf, collectLogs } from "../platform/index.ts";
import { envTargets } from "./shared.ts";

// ---------------------------------------------------------------------------
// logs - the review surface: container logs for the agent and its apps,
// the PREVIOUS container on a restart (where the crash actually is), and
// Argo CD's own conditions (allowlist/chart/revision failures never
// reach a pod).
// ---------------------------------------------------------------------------

export function cmdLogs(
  json: boolean,
  onlyProfile: string | undefined,
  app: string | undefined,
  tail: number,
): void {
  const state = loadState();
  const ctxs = onlyProfile
    ? envTargets(state, onlyProfile, "logs")
    : profileCtxs(state);
  const report = ctxs.map((ctx) => {
    const { sync, health } = appStatus(ctx.name);
    return {
      profile: ctx.name,
      sync,
      health,
      conditions: appConditions(ctx.name),
      containers: collectLogs(ctx, { app, tail }),
    };
  });
  if (json) {
    jsonOut({ command: "logs", tail, profiles: report });
    return;
  }
  for (const r of report) {
    log(`[${r.profile}] sync=${r.sync || "<absent>"} health=${r.health || "<absent>"}`);
    for (const c of r.conditions) console.log(`  ! argo ${c.type}: ${c.message}`);
    for (const c of r.containers) {
      const flag = c.ready ? "✓" : "✗";
      console.log(
        `  ${flag} ${c.pod}/${c.container}` +
          `${c.restarts ? ` restarts=${c.restarts}` : ""}${c.reason ? ` (${c.reason})` : ""}`,
      );
      if (c.previous) {
        console.log("      --- previous container (the crash) ---");
        for (const l of c.previous.split("\n")) console.log(`      ${l}`);
      }
      for (const l of c.lines) console.log(`      ${l}`);
    }
  }
}

// ---------------------------------------------------------------------------
// prompt - run one prompt against a deployed profile's agent, in its own
// pod with its own env and workspace. The loop's only surface that
// exercises agent BEHAVIOUR rather than deployment - the behavioural
// test tier remains a stub, and this is the manual stand-in.
// ---------------------------------------------------------------------------

export async function cmdPrompt(
  args: string[],
  json: boolean,
  onlyProfile: string | undefined,
  timeoutSec: number,
): Promise<void> {
  const state = loadState();
  const prompt = args.join(" ").trim();
  if (!prompt) {
    throw new CliError('usage: hermes-gitops prompt "<text>" [--profile <name>] [--timeout N]');
  }
  const ctxs = envTargets(state, onlyProfile, "prompt");
  if (ctxs.length > 1) {
    throw new CliError(
      `this catalogue has ${ctxs.length} profiles - name one: ` +
        `hermes-gitops prompt "..." --profile <${ctxs.map((c) => c.name).join("|")}>`,
    );
  }
  const ctx = ctxs[0]!;
  const { application } = applicationOf(state, ctx.name);
  const { sync, health } = appStatusOf(application);
  if (health !== "Healthy") {
    log(`warning: ${application} is sync=${sync || "?"} health=${health || "?"} - prompting anyway`);
  }
  const result = await invokeAgent(ctx, prompt, timeoutSec);
  if (json) {
    jsonOut({ command: "prompt", profile: ctx.name, ...result });
  } else if (result.ok) {
    console.log(result.output);
    if (result.error) console.error(result.error);
  } else {
    console.error(result.error ?? "prompt failed");
    if (result.output) console.error(result.output);
  }
  if (!result.ok) throw new CliError(`prompt failed for ${ctx.name}`);
}
