// The front-door step-runner (#673/#676): the three loop entrypoints
// orchestrate EXISTING verbs, and every step announces the command it
// delegates to - the entrypoint teaches the loop it fronts. Steps are
// probe-idempotent (the `hg server register` standard: read, then
// early-return), a dry run prints the exact commands without applying
// (the escape hatch - complete enough to hand-execute), and a failure
// names the step and how to resume (re-run: completed steps skip by
// probe, never by persisted wizard state).
import { CliError, log, ok } from "./lib.ts";

export interface FrontDoorStep {
  /** What this step accomplishes, one line. */
  title: string;
  /** The command line this step delegates to - printed verbatim, both
   * in the narration and in --dry-run. Env prefixes included, so the
   * dry-run transcript is hand-executable. */
  command: string;
  /** Idempotency probe: a string = "already done" with that reason
   * (step skips); undefined/false = run. Probes must be read-only. */
  probe?: () => string | false | undefined;
  /** Do the work. Throw (CliError preferred) on failure. */
  run: () => void;
}

export function runFrontDoor(
  door: string,
  steps: FrontDoorStep[],
  opts: { dryRun: boolean },
): void {
  if (opts.dryRun) {
    log(`${door}: dry run - the exact sequence, apply nothing:`);
    for (const [i, s] of steps.entries()) {
      console.log(`  ${i + 1}. ${s.title}`);
      console.log(`     ${s.command}`);
    }
    return;
  }
  for (const [i, s] of steps.entries()) {
    const n = `${i + 1}/${steps.length}`;
    const done = s.probe?.();
    if (done) {
      ok(`[${n}] ${s.title} - already done (${done})`);
      continue;
    }
    log(`[${n}] ${s.title}`);
    log(`  → ${s.command}`);
    try {
      s.run();
    } catch (err) {
      throw new CliError(
        `${door} stopped at step ${n} (${s.title}): ${err instanceof Error ? err.message : String(err)}\n` +
          `  fix the cause and re-run - completed steps skip by probe, nothing is half-configured.`,
      );
    }
  }
}
