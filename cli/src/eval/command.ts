// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as path from "node:path";
import { CliError, HG_HOME, jsonOut, loadState, log, ok } from "../lib.ts";
import { runEval } from "./index.ts";
import { fetchEvalResults, latestReport, proveEvalPublishing, publishEvalReport } from "./publish.ts";

// ---------------------------------------------------------------------------
// eval - the fourth claim: run the repo's OPTIONAL deterministic eval suite
// against the deployed profiles. Discovery, schema validation and the run
// loop live in eval.ts; this is only flag plumbing + the JSON/exit contract.

export async function cmdEval(
  json: boolean,
  args: string[],
  dir: string | undefined,
  onlyProfile: string | undefined,
  onlyScenario: string | undefined,
  repeatOverride: number | undefined,
  timeoutOverride: number | undefined,
  allowRepoScripts: boolean,
  opts: {
    controlPlane?: string;
    component?: string;
    report?: string;
    tokenFile?: string;
    suite?: string;
    scenario?: string;
    limit?: number;
  } = {},
): Promise<void> {
  // publish/results/prove operate on a REPORT and a control plane, not on
  // a suite directory - they are handled before --dir is required.
  if (args[0] === "publish" || args[0] === "results" || args[0] === "prove") {
    await cmdEvalPublisher(json, args, opts);
    return;
  }
  // --dir is required and the ONLY way to name the suite - a positional
  // path would be ambiguous with future subcommands.
  if (!dir) {
    throw new CliError(
      "eval requires --dir <repo-or-evals-directory> (positional paths are not accepted)",
    );
  }
  if (args.length > 0) {
    throw new CliError(
      `eval takes no positional arguments (got ${JSON.stringify(args[0])}) - use --dir/--profile/--scenario`,
    );
  }
  const state = loadState();
  const report = await runEval({
    state,
    dir,
    onlyProfile,
    onlyScenario,
    repeatOverride,
    timeoutOverride,
    allowRepoScripts,
  });
  // Emit the JSON document BEFORE any throw so a --json consumer gets its
  // document on a failing run too; the throw only sets the exit code.
  if (json) jsonOut(report);
  if (!report.ok) {
    throw new CliError(
      report.schemaErrors?.length
        ? `eval: ${report.schemaErrors.length} validation error(s) - nothing was run`
        : `eval: ${report.failed.length} required scenario(s) FAILED`,
    );
  }
  if (!json && report.root !== null) {
    ok(`eval: ${report.summary.passed}/${report.summary.total} scenario(s) passed`);
  }
}

export async function cmdEvalPublisher(
  json: boolean,
  args: string[],
  opts: {
    controlPlane?: string;
    component?: string;
    report?: string;
    tokenFile?: string;
    suite?: string;
    scenario?: string;
    limit?: number;
  },
): Promise<void> {
  const sub = args[0];
  const controlPlane = opts.controlPlane;
  if (sub === "prove") {
    const result = await proveEvalPublishing({ controlPlane, component: opts.component });
    if (json) jsonOut(result);
    else {
      for (const f of result.findings) {
        const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
        console.log(`  ${mark} ${f.id} ${f.message}`);
      }
    }
    if (!result.ok) throw new CliError(`eval prove: ${result.summary.fail} check(s) FAILED`);
    return;
  }
  if (!controlPlane) {
    throw new CliError(`eval ${sub} requires --control-plane <url>`);
  }
  if (sub === "results") {
    const component = args[1] ?? opts.component;
    if (!component) throw new CliError("eval results requires a component id");
    const doc = await fetchEvalResults({
      controlPlane,
      component,
      suite: opts.suite,
      scenario: opts.scenario,
      limit: opts.limit,
    });
    if (json) jsonOut(doc);
    else {
      log(`${doc.total} result(s) for ${component}`);
      for (const r of doc.records) {
        console.log(`  ${r.status.padEnd(16)} ${r.suite}/${r.scenario}  ${r.ranAt}`);
      }
    }
    return;
  }
  // publish
  const reportPath = opts.report ?? latestReport(path.join(HG_HOME, "eval-runs"));
  if (!reportPath) {
    throw new CliError("eval publish requires --report <report.json> (no run found under $HG_HOME/eval-runs)");
  }
  const out = await publishEvalReport({
    reportPath,
    controlPlane,
    component: opts.component,
    tokenFile: opts.tokenFile,
  });
  if (json) jsonOut({ command: "eval-publish", ...out });
  else ok(`published ${out.written} result(s) (${out.deduped} already present, ${out.dropped} rotated out)`);
}
