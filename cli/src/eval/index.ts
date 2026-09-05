// hg eval - run an OPTIONAL, schema-driven eval suite against deployed
// profiles. The suite (evals/suite.yaml + scenarios/*/scenario.yaml,
// schemas in cli/schemas/evals/v1alpha1/) is an eval-AUTHORING contract
// for this command alone: profile installation, rendering, reconciliation
// and `hg validate` never read evals/, and a repo without one is fully
// valid and deployable.
//
// The evaluator's exit code is the whole assertion protocol - 0 pass,
// 1 assertion failure, anything else evaluator/harness error - so a
// broken evaluator is never reported as a misbehaving agent, and a
// provider outage (agent-error) is never reported as a failing one.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import {
  CliError,
  HG_HOME,
  KCTX,
  appOf,
  log,
  nsOf,
  ok,
  profileCtxs,
  repoScriptsAllowed,
  type HgState,
  type ProfileCtx,
} from "../lib.ts";
import { invokeAgent } from "../harness/index.ts";

// ---------------------------------------------------------------------------
// The authoring contract. The published schema IS the runtime validator -
// there is no hand-rolled twin to drift from it.

// Two authoring versions, dispatched on the suite's apiVersion: v1alpha1
// (prompt + evaluator) and v1alpha2 (adds typed communication invocation
// + runner-checked expectations). The runner refuses versions it does
// not implement instead of guessing.
const SCHEMAS_ROOT = path.resolve(import.meta.dir, "..", "..", "schemas", "evals");

const ajv = new Ajv2020({ allErrors: true });
function compileSchema(version: string, name: string): ValidateFunction {
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, version, name), "utf8")));
}
const VALIDATORS: Record<string, { suite: ValidateFunction; scenario: ValidateFunction }> = {
  v1alpha1: { suite: compileSchema("v1alpha1", "suite.schema.json"), scenario: compileSchema("v1alpha1", "scenario.schema.json") },
  v1alpha2: { suite: compileSchema("v1alpha2", "suite.schema.json"), scenario: compileSchema("v1alpha2", "scenario.schema.json") },
};

function schemaErrorLines(file: string, errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    // Ajv's message for additionalProperties omits the offending key -
    // the one thing an author actually needs.
    const detail =
      "additionalProperty" in e.params
        ? ` (${JSON.stringify(e.params["additionalProperty"])})`
        : "";
    return `${file}: ${e.instancePath || "/"} ${e.message ?? "invalid"}${detail}`;
  });
}

export interface EvalSuite {
  apiVersion: string;
  name: string;
  scenarios?: string;
  defaults?: { timeout?: number; repeat?: number };
}

export interface EvalScenario {
  name: string;
  profile: string;
  description?: string;
  prompt?: string;
  /** Optional in v1alpha2 when `expect` carries the whole assertion. */
  evaluate?: string;
  invoke?: import("../communication/index.ts").EvalInvokeSpec;
  expect?: { outputs?: ({ agent?: { profile: string } } | { chatops?: string })[]; rejected?: { reason: string } };
  timeout?: number;
  repeat?: number;
  required?: boolean;
  setup?: string[];
  cleanup?: string[];
}

export interface LoadedScenario {
  spec: EvalScenario;
  /** Absolute scenario directory - cwd for setup/evaluate/cleanup. */
  dir: string;
}

export type RunStatus = "pass" | "fail" | "timeout" | "agent-error" | "evaluator-error";

export interface RunReport {
  run: number;
  status: RunStatus;
  durationMs: number;
  artifacts: string;
  /** Failure reason - for timeouts, the evaluator's final observation. */
  reason?: string;
}

export interface ScenarioReport {
  name: string;
  profile: string;
  required: boolean;
  /** Worst status across runs - "pass" only when every run passed. */
  status: RunStatus;
  runs: RunReport[];
}

export interface EvalReport {
  command: "eval";
  dir: string;
  /** Resolved suite root, or null when no suite was found (not a failure). */
  root: string | null;
  ok: boolean;
  /** Set when validation stopped everything before any run. */
  schemaErrors?: string[];
  scenarios: ScenarioReport[];
  failed: ScenarioReport[];
  summary: { total: number; passed: number; failed: number };
  /** Set once the suite actually ran - the publisher needs both to build
   * a stable runId, and neither exists when validation stopped early. */
  suite?: string;
  stamp?: string;
}

// ---------------------------------------------------------------------------
// Discovery + validation. Everything here runs BEFORE any model call: a
// schema typo, an unknown profile or a missing evaluator aborts the whole
// suite with every error reported at once, and nothing executes.

/** `--dir X` -> X if X/suite.yaml exists, else X/evals if that does. */
export function resolveEvalRoot(dir: string): string | null {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new CliError(`--dir ${JSON.stringify(dir)} does not exist`);
  if (fs.existsSync(path.join(abs, "suite.yaml"))) return abs;
  const nested = path.join(abs, "evals");
  if (fs.existsSync(path.join(nested, "suite.yaml"))) return nested;
  return null;
}

function parseYamlFile(file: string, errors: string[]): unknown {
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${file}: not parseable YAML - ${(err as Error).message}`);
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${file}: must be a YAML mapping`);
    return undefined;
  }
  return raw;
}

function versionOf(apiVersion: unknown): string | undefined {
  if (typeof apiVersion !== "string") return undefined;
  const m = apiVersion.match(/^hermes-gitops\.factorylevel\.dev\/evals\/(v1alpha[12])$/);
  return m?.[1];
}

export function loadSuite(root: string, errors: string[]): { suite: EvalSuite; version: string } | undefined {
  const file = path.join(root, "suite.yaml");
  const raw = parseYamlFile(file, errors);
  if (raw === undefined) return undefined;
  const version = versionOf((raw as { apiVersion?: unknown }).apiVersion);
  if (!version) {
    errors.push(
      `${file}: apiVersion ${JSON.stringify((raw as { apiVersion?: unknown }).apiVersion)} is not a version ` +
        `this runner implements (known: v1alpha1, v1alpha2)`,
    );
    return undefined;
  }
  const validator = VALIDATORS[version]!.suite;
  if (!validator(raw)) {
    errors.push(...schemaErrorLines(file, validator.errors));
    return undefined;
  }
  return { suite: raw as EvalSuite, version };
}

/** Every scenarios/<x>/scenario.yaml, validated, names unique, referenced
 * files present. Directories without a scenario.yaml (shared scripts,
 * fixtures) are not scenarios and are skipped. */
export function discoverScenarios(
  root: string,
  suite: EvalSuite,
  errors: string[],
  version = "v1alpha1",
): LoadedScenario[] {
  const validateScenarioDoc = VALIDATORS[version]!.scenario;
  const scenariosDir = path.join(root, suite.scenarios ?? "scenarios");
  if (!fs.existsSync(scenariosDir)) {
    errors.push(`${scenariosDir}: scenarios directory not found`);
    return [];
  }
  const out: LoadedScenario[] = [];
  const seen = new Map<string, string>();
  const entries = fs.readdirSync(scenariosDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(scenariosDir, entry.name);
    const file = path.join(dir, "scenario.yaml");
    if (!fs.existsSync(file)) continue;
    const raw = parseYamlFile(file, errors);
    if (raw === undefined) continue;
    if (!validateScenarioDoc(raw)) {
      errors.push(...schemaErrorLines(file, validateScenarioDoc.errors));
      continue;
    }
    const spec = raw as EvalScenario;
    const prior = seen.get(spec.name);
    if (prior) {
      errors.push(`${file}: duplicate scenario name ${JSON.stringify(spec.name)} (also ${prior})`);
      continue;
    }
    seen.set(spec.name, file);
    for (const ref of [...(spec.evaluate ? [spec.evaluate] : []), ...(spec.prompt ? [spec.prompt] : [])]) {
      const target = path.join(dir, ref);
      if (!fs.existsSync(target)) {
        errors.push(`${file}: references ${JSON.stringify(ref)}, which does not exist`);
        continue;
      }
      // The schema's traversal pattern is lexical; a symlink can still
      // point outside the scenario. Resolve and require real containment.
      // (Validation-time only - the §27 trust gate is what actually
      // authorises running this code; this check catches mistakes.)
      try {
        const real = fs.realpathSync(target);
        const realDir = fs.realpathSync(dir) + path.sep;
        if (!real.startsWith(realDir)) {
          errors.push(
            `${file}: ${JSON.stringify(ref)} resolves outside the scenario directory (${real})`,
          );
        }
      } catch (err) {
        // A broken symlink is a validation finding, not a crash.
        errors.push(
          `${file}: ${JSON.stringify(ref)} cannot be resolved - ${(err as Error).message}`,
        );
      }
    }
    out.push({ spec, dir });
  }
  if (out.length === 0 && errors.length === 0) {
    errors.push(`${scenariosDir}: no scenario.yaml found in any subdirectory`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Execution.

function bashRun(
  cmd: string,
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): { ok: boolean; detail: string } {
  const proc = Bun.spawnSync(["bash", "-c", cmd], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const detail = (proc.stderr.toString().trim() || proc.stdout.toString().trim()).slice(-500);
  return { ok: proc.exitCode === 0, detail };
}

/** Last non-empty line the evaluator wrote - stderr preferred. This is what
 * a timeout reports instead of a generic "timed out". */
function lastObservation(stdout: string, stderr: string): string | undefined {
  for (const text of [stderr, stdout]) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  return undefined;
}

interface RunInputs {
  suite: EvalSuite;
  root: string;
  sc: LoadedScenario;
  ctx: ProfileCtx;
  timeoutSec: number;
  runNo: number;
  artifacts: string;
  /** The onboarded repository root - what typed invocation compiles. */
  repoRoot: string;
}

async function runOne(inp: RunInputs): Promise<RunReport> {
  const { sc, ctx, artifacts } = inp;
  fs.mkdirSync(artifacts, { recursive: true });
  const started = Date.now();
  const deadline = started + inp.timeoutSec * 1000;
  const remainingMs = (): number => Math.max(1, deadline - Date.now());
  const timedOut = (): boolean => Date.now() >= deadline;

  const env: Record<string, string | undefined> = {
    ...process.env,
    HG_EVAL_PROFILE: ctx.name,
    HG_EVAL_NAMESPACE: nsOf(ctx.name),
    HG_EVAL_POD: `${appOf(ctx.name)}-0`,
    HG_EVAL_KUBE_CONTEXT: KCTX,
    HG_EVAL_SUITE_DIR: inp.root,
    HG_EVAL_SCENARIO_DIR: sc.dir,
    HG_EVAL_FIXTURES: path.join(sc.dir, "fixtures"),
    HG_EVAL_ARTIFACTS: artifacts,
    HG_EVAL_DEADLINE: String(Math.floor(deadline / 1000)),
    HG_EVAL_RUN: String(inp.runNo),
  };

  const finish = (status: RunStatus, reason?: string): RunReport => ({
    run: inp.runNo,
    status,
    durationMs: Date.now() - started,
    artifacts,
    ...(reason ? { reason } : {}),
  });

  // Cleanup ALWAYS runs - timeout, crash and unexpected throw included -
  // each command on its own small budget so a hung cleanup cannot wedge
  // the suite, and each guarded so one failure never stops the rest.
  // A failed cleanup on an otherwise PASSING run downgrades it to
  // evaluator-error (green over a dirty board is how the next scenario
  // fails mysteriously); on an already-failing run the real verdict is
  // kept - the failure happened before cleanup ran, and hiding a genuine
  // fail behind evaluator-error would misreport the agent - but the
  // cleanup failure is appended to the reason so it is never silent.
  let report: RunReport;
  try {
    report = await runBody();
  } catch (err) {
    report = finish("evaluator-error", `unexpected harness failure: ${(err as Error).message}`);
  }
  const cleanupFailures: string[] = [];
  for (const cmd of sc.spec.cleanup ?? []) {
    try {
      const r = bashRun(cmd, sc.dir, env, 60_000);
      if (!r.ok) {
        cleanupFailures.push(cmd);
        console.error(`  ! cleanup failed (${sc.spec.name}): ${cmd}\n    ${r.detail}`);
      }
    } catch (err) {
      cleanupFailures.push(cmd);
      console.error(`  ! cleanup threw (${sc.spec.name}): ${cmd}\n    ${(err as Error).message}`);
    }
  }
  if (cleanupFailures.length > 0) {
    const note = `cleanup failed: ${cleanupFailures.join("; ")}`;
    report =
      report.status === "pass"
        ? { ...report, status: "evaluator-error", reason: `run passed but ${note}` }
        : { ...report, reason: report.reason ? `${report.reason} (also: ${note})` : note };
  }
  return report;

  async function runBody(): Promise<RunReport> {
    for (const cmd of sc.spec.setup ?? []) {
      const r = bashRun(cmd, sc.dir, env, remainingMs());
      if (!r.ok) {
        return finish(
          timedOut() ? "timeout" : "evaluator-error",
          `setup failed: ${cmd}${r.detail ? ` - ${r.detail}` : ""}`,
        );
      }
    }

    if (sc.spec.invoke) {
      // Typed invocation (v1alpha2): the runner drives the SAME engine
      // hg event uses - producer resolution, schema gate, signing, the
      // real router, terminal receipts. Artifacts land beside the
      // evaluator's; the evaluator reads them through HG_EVAL_* env.
      const { invokeForEval, checkExpectations } = await import("../communication/index.ts");
      let result: Awaited<ReturnType<typeof invokeForEval>>;
      try {
        result = await invokeForEval(sc.spec.invoke, { dir: inp.repoRoot, scenarioDir: sc.dir });
      } catch (err) {
        // Router unreachable, unknown producer, missing secret: the
        // HARNESS could not invoke - never reported as agent behaviour.
        return finish("evaluator-error", `invocation failed: ${(err as Error).message}`);
      }
      const invDir = path.join(artifacts, "invocation");
      fs.mkdirSync(invDir, { recursive: true });
      fs.writeFileSync(path.join(invDir, "receipts.json"), JSON.stringify(result.receipts, null, 2));
      fs.writeFileSync(path.join(invDir, "responses.json"), JSON.stringify(result.responses, null, 2));
      fs.writeFileSync(
        path.join(invDir, "invocation.json"),
        JSON.stringify(
          { kind: result.kind, eventIds: result.eventIds, correlationIds: result.correlationIds, deliveryIds: result.deliveryIds, rejectedReason: result.rejectedReason },
          null,
          2,
        ),
      );
      env["HG_EVAL_INVOCATION_TYPE"] = result.kind;
      env["HG_EVAL_INVOCATION_DIR"] = invDir;
      env["HG_EVAL_EVENT_IDS"] = result.eventIds.join(",");
      env["HG_EVAL_CORRELATION_ID"] = result.correlationIds[0] ?? "";
      env["HG_EVAL_CORRELATION_IDS"] = result.correlationIds.join(",");
      env["HG_EVAL_DELIVERY_IDS"] = result.deliveryIds.join(",");
      env["HG_EVAL_RECEIPTS"] = path.join(invDir, "receipts.json");
      if (!result.ok) {
        return finish("fail", `invocation not clean: ${result.error ?? "deliveries failed"}`);
      }
      if (sc.spec.expect) {
        const failures = checkExpectations(result, sc.spec.expect);
        if (failures.length > 0) return finish("fail", failures.join("; "));
      }
      if (!sc.spec.evaluate) return finish("pass");
    }

    if (sc.spec.prompt) {
      const text = fs.readFileSync(path.join(sc.dir, sc.spec.prompt), "utf8");
      const result = await invokeAgent(ctx, text, Math.ceil(remainingMs() / 1000));
      const responseFile = path.join(artifacts, "response.txt");
      fs.writeFileSync(responseFile, result.output ?? "");
      if (!result.ok) {
        // The agent/provider failed to answer at all - distinct from the
        // evaluator judging a real answer wrong.
        return finish(
          timedOut() ? "timeout" : "agent-error",
          result.error ?? "prompt failed",
        );
      }
      env["HG_EVAL_RESPONSE"] = responseFile;
    }

    let proc: ReturnType<typeof Bun.spawnSync>;
    try {
      proc = Bun.spawnSync([path.join(sc.dir, sc.spec.evaluate!)], {
        cwd: sc.dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: remainingMs(),
      });
    } catch (err) {
      return finish(
        "evaluator-error",
        `could not execute ${sc.spec.evaluate}: ${(err as Error).message} ` +
          "(does it exist with a shebang and the executable bit?)",
      );
    }
    // stdout/stderr are always piped above; the broad ReturnType just can't see it.
    const stdout = proc.stdout!.toString();
    const stderr = proc.stderr!.toString();
    fs.writeFileSync(path.join(artifacts, "evaluator.stdout.txt"), stdout);
    fs.writeFileSync(path.join(artifacts, "evaluator.stderr.txt"), stderr);
    const observation = lastObservation(stdout, stderr);

    if (proc.exitCode === 0) return finish("pass");
    if (proc.exitCode === null) {
      // Killed by signal - a timeout when the deadline passed, otherwise an
      // external kill, which is a harness problem either way.
      return finish(
        timedOut() ? "timeout" : "evaluator-error",
        observation ?? `evaluator killed (${proc.signalCode ?? "signal"})`,
      );
    }
    if (proc.exitCode === 1) return finish("fail", observation);
    return finish(
      "evaluator-error",
      `evaluator exited ${proc.exitCode}${observation ? ` - ${observation}` : ""}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The command.

export interface EvalOptions {
  state: HgState;
  dir: string;
  onlyProfile?: string;
  onlyScenario?: string;
  /** CLI --repeat / --timeout override scenario and suite values. */
  repeatOverride?: number;
  timeoutOverride?: number;
  allowRepoScripts: boolean;
  /** Test seam: artifact root instead of $HG_HOME/eval-runs. */
  artifactRoot?: string;
}

const worst: RunStatus[] = ["evaluator-error", "agent-error", "timeout", "fail", "pass"];

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const empty = {
    command: "eval" as const,
    dir: opts.dir,
    scenarios: [] as ScenarioReport[],
    failed: [] as ScenarioReport[],
    summary: { total: 0, passed: 0, failed: 0 },
  };

  const root = resolveEvalRoot(opts.dir);
  if (root === null) {
    // Explicitly NOT a failure: evals are optional and outside the
    // deployment contract.
    log(`no eval suite found at ${opts.dir} (looked for suite.yaml and evals/suite.yaml)`);
    return { ...empty, root: null, ok: true };
  }

  // §27 trust boundary: an eval root inside a cloned (untrusted) onboard
  // needs explicit consent, because evaluators/setup/cleanup are arbitrary
  // repo code and running them IS this command. A --dir elsewhere is a
  // path the operator typed - trusted, same rule as onboard itself.
  const rel = path.relative(path.resolve(opts.state.profileDir), root);
  const insideOnboarded = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (insideOnboarded && !repoScriptsAllowed(opts.state, opts.allowRepoScripts)) {
    throw new CliError(
      "this profile was onboarded from a URL and eval scripts are untrusted " +
        "repo code - re-run with --allow-repo-scripts to consent",
    );
  }

  const schemaErrors: string[] = [];
  const loaded = loadSuite(root, schemaErrors);
  const suite = loaded?.suite;
  const all = loaded ? discoverScenarios(root, loaded.suite, schemaErrors, loaded.version) : [];
  // expect: judges invocation receipts - without an invocation there is
  // nothing to judge (schema cannot see this pairing).
  for (const s of all) {
    if (s.spec.expect && !s.spec.invoke) {
      schemaErrors.push(`${s.spec.name}: expect: requires invoke: (there are no receipts to check otherwise)`);
    }
  }

  // Selection - before the schema gate so an unknown filter is its own
  // clear error rather than drowning in unrelated findings.
  let selected = all;
  if (opts.onlyScenario) {
    selected = selected.filter((s) => s.spec.name === opts.onlyScenario);
    if (selected.length === 0 && schemaErrors.length === 0) {
      throw new CliError(
        `--scenario ${JSON.stringify(opts.onlyScenario)} matches nothing ` +
          `(known: ${all.map((s) => s.spec.name).join(", ") || "none"})`,
      );
    }
  }
  if (opts.onlyProfile) {
    selected = selected.filter((s) => s.spec.profile === opts.onlyProfile);
    if (selected.length === 0 && schemaErrors.length === 0) {
      throw new CliError(
        `--profile ${JSON.stringify(opts.onlyProfile)} matches no scenario ` +
          `(profiles in suite: ${[...new Set(all.map((s) => s.spec.profile))].join(", ") || "none"})`,
      );
    }
  }

  // Address the deployed agent by the scenario's declared profile - never
  // an implicit global one. Unknown profiles are schema-class errors.
  const ctxs = new Map(profileCtxs(opts.state).map((c) => [c.name, c]));
  for (const s of selected) {
    if (!ctxs.has(s.spec.profile)) {
      schemaErrors.push(
        `${s.spec.name}: profile ${JSON.stringify(s.spec.profile)} is not onboarded ` +
          `(known: ${[...ctxs.keys()].join(", ")})`,
      );
    }
  }

  if (schemaErrors.length > 0) {
    for (const e of schemaErrors) console.error(`  ✗ ${e}`);
    return { ...empty, root, ok: false, schemaErrors };
  }
  if (!suite) return { ...empty, root, ok: false, schemaErrors: ["suite.yaml unreadable"] };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactRoot = opts.artifactRoot ?? path.join(HG_HOME, "eval-runs");
  log(`suite ${suite.name}: ${selected.length} scenario(s), artifacts under ${path.join(artifactRoot, stamp)}`);

  const reports: ScenarioReport[] = [];
  for (const sc of selected) {
    const ctx = ctxs.get(sc.spec.profile)!;
    const timeoutSec =
      opts.timeoutOverride ?? sc.spec.timeout ?? suite.defaults?.timeout ?? 300;
    const repeat = opts.repeatOverride ?? sc.spec.repeat ?? suite.defaults?.repeat ?? 1;
    const required = sc.spec.required ?? true;
    log(`scenario ${sc.spec.name} [${sc.spec.profile}]${repeat > 1 ? ` x${repeat}` : ""}`);
    const runs: RunReport[] = [];
    for (let n = 1; n <= repeat; n++) {
      const artifacts = path.join(artifactRoot, stamp, sc.spec.name, `run-${n}`);
      const r = await runOne({
        suite,
        root,
        sc,
        ctx,
        timeoutSec,
        runNo: n,
        artifacts,
        repoRoot: opts.state.profileDir,
      });
      runs.push(r);
      if (r.status === "pass") ok(`run ${n}/${repeat}: pass (${Math.round(r.durationMs / 1000)}s)`);
      else console.error(`  ✗ run ${n}/${repeat}: ${r.status}${r.reason ? ` - ${r.reason}` : ""}`);
    }
    const status = worst.find((w) => runs.some((r) => r.status === w)) ?? "pass";
    reports.push({ name: sc.spec.name, profile: sc.spec.profile, required, status, runs });
  }

  // Only REQUIRED scenarios gate; informational ones report and move on.
  const failed = reports.filter((r) => r.status !== "pass" && r.required);
  const report: EvalReport = {
    command: "eval",
    dir: opts.dir,
    root,
    ok: failed.length === 0,
    scenarios: reports,
    failed,
    summary: {
      total: reports.length,
      passed: reports.filter((r) => r.status === "pass").length,
      failed: failed.length,
    },
    suite: suite.name,
    stamp,
  };
  // The report goes beside its artifacts so `hg eval publish` can retry a
  // failed publish WITHOUT re-running the suite - re-running would produce
  // different runIds and a second set of results for one execution.
  try {
    fs.writeFileSync(
      path.join(artifactRoot, stamp, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  } catch {
    /* the run itself succeeded; an unwritable artifact dir must not fail it */
  }
  return report;
}
