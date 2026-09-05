// Offline unit tests for the hg eval runner (cli/src/eval.ts) - no cluster,
// no model calls. The mock is a scenario with no `prompt:` and an evaluator
// that exits with whatever number the test chooses, which drives the whole
// pipeline: discovery -> schema validation -> setup -> evaluate -> cleanup
// -> aggregation.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEvalRoot, runEval, type EvalReport } from "../src/eval/index.ts";
import { CliError, loadTestConfig, repoScriptsAllowed, type HgState } from "../src/lib.ts";

const SUITE_HEADER = "apiVersion: hermes-gitops.factorylevel.dev/evals/v1alpha1\nname: test-suite\n";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hg-eval-test-"));
}

/** A suite root with suite.yaml and an empty scenarios/ dir. */
function mkSuite(suiteYaml: string = SUITE_HEADER): string {
  const root = tmp();
  writeFileSync(join(root, "suite.yaml"), suiteYaml);
  mkdirSync(join(root, "scenarios"));
  return root;
}

function addScenario(
  root: string,
  dirName: string,
  scenarioYaml: string,
  files: Record<string, string> = {},
): string {
  const dir = join(root, "scenarios", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scenario.yaml"), scenarioYaml);
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, content);
    if (content.startsWith("#!")) chmodSync(p, 0o755);
  }
  return dir;
}

/** Evaluator body: bash, exits with `code` after printing a line. */
function evaluator(code: number, body = ""): string {
  return `#!/usr/bin/env bash\n${body}\necho "final observation line"\nexit ${code}\n`;
}

const SCENARIO_MIN = "name: alpha\nprofile: persona-echo\nevaluate: evaluate.sh\n";

function mkState(profileDir: string, trusted = true): HgState {
  return {
    profileDir,
    profileName: "persona-echo",
    profiles: [{ name: "persona-echo", subdir: "" }],
    trusted,
  };
}

function run(root: string, extra: Partial<Parameters<typeof runEval>[0]> = {}): Promise<EvalReport> {
  return runEval({
    state: mkState(root),
    dir: root,
    allowRepoScripts: false,
    artifactRoot: join(tmp(), "artifacts"),
    ...extra,
  });
}

describe("resolveEvalRoot", () => {
  test("a directory holding suite.yaml is the root itself", async () => {
    const root = mkSuite();
    expect(resolveEvalRoot(root)).toBe(root);
  });

  test("a repo root resolves through its evals/ subdirectory", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "evals"));
    writeFileSync(join(repo, "evals", "suite.yaml"), SUITE_HEADER);
    expect(resolveEvalRoot(repo)).toBe(join(repo, "evals"));
  });

  test("no suite anywhere resolves to null, not an error", async () => {
    expect(resolveEvalRoot(tmp())).toBeNull();
  });

  test("a nonexistent --dir is a hard error, not 'no suite found'", async () => {
    expect(() => resolveEvalRoot("/nonexistent/nowhere")).toThrow(CliError);
    expect(() => resolveEvalRoot("/nonexistent/nowhere")).toThrow(/does not exist/);
  });
});

describe("runEval schema gate", () => {
  test("no suite found reports ok with a null root", async () => {
    const root = tmp();
    const report = await run(root, { state: mkState(root) });
    expect(report.ok).toBe(true);
    expect(report.root).toBeNull();
    expect(report.summary.total).toBe(0);
  });

  test("an unknown suite key fails loudly before anything runs", async () => {
    const root = mkSuite(SUITE_HEADER + "judge: llm\n");
    const marker = join(root, "ran");
    addScenario(root, "alpha", SCENARIO_MIN, {
      "evaluate.sh": evaluator(0, `touch ${JSON.stringify(marker)}`),
    });
    const report = await run(root);
    expect(report.ok).toBe(false);
    expect(report.schemaErrors?.join("\n")).toMatch(/judge/);
    expect(existsSync(marker)).toBe(false);
  });

  test("path traversal and missing evaluate are rejected together", async () => {
    const root = mkSuite();
    addScenario(root, "alpha", "name: alpha\nprofile: persona-echo\nevaluate: ../../evil.sh\n");
    addScenario(root, "beta", "name: beta\nprofile: persona-echo\nprompt: prompt.md\n", {
      "prompt.md": "hi",
    });
    const report = await run(root);
    expect(report.ok).toBe(false);
    const all = report.schemaErrors!.join("\n");
    expect(all).toMatch(/evaluate/);
    expect(all).toMatch(/beta/);
  });

  test("duplicate scenario names are rejected", async () => {
    const root = mkSuite();
    addScenario(root, "a-dir", SCENARIO_MIN, { "evaluate.sh": evaluator(0) });
    addScenario(root, "b-dir", SCENARIO_MIN, { "evaluate.sh": evaluator(0) });
    const report = await run(root);
    expect(report.ok).toBe(false);
    expect(report.schemaErrors?.join("\n")).toMatch(/duplicate scenario name/);
  });

  test("a referenced evaluator that does not exist on disk is a validation error", async () => {
    const root = mkSuite();
    addScenario(root, "alpha", SCENARIO_MIN);
    const report = await run(root);
    expect(report.ok).toBe(false);
    expect(report.schemaErrors?.join("\n")).toMatch(/does not exist/);
  });

  test("an unknown profile is a schema-class error naming the known set", async () => {
    const root = mkSuite();
    addScenario(root, "alpha", "name: alpha\nprofile: no-such-agent\nevaluate: evaluate.sh\n", {
      "evaluate.sh": evaluator(0),
    });
    const report = await run(root);
    expect(report.ok).toBe(false);
    expect(report.schemaErrors?.join("\n")).toMatch(/not onboarded/);
    expect(report.schemaErrors?.join("\n")).toMatch(/persona-echo/);
  });
});

describe("runEval execution", () => {
  test("exit 0 is pass, exit 1 is fail, other codes are evaluator-error", async () => {
    const root = mkSuite();
    addScenario(root, "passes", "name: passes\nprofile: persona-echo\nevaluate: evaluate.sh\n", {
      "evaluate.sh": evaluator(0),
    });
    addScenario(root, "fails", "name: fails\nprofile: persona-echo\nevaluate: evaluate.sh\n", {
      "evaluate.sh": evaluator(1),
    });
    addScenario(root, "crashes", "name: crashes\nprofile: persona-echo\nevaluate: evaluate.sh\n", {
      "evaluate.sh": evaluator(3),
    });
    const report = await run(root);
    const byName = Object.fromEntries(report.scenarios.map((s) => [s.name, s]));
    expect(byName["passes"]!.status).toBe("pass");
    expect(byName["fails"]!.status).toBe("fail");
    expect(byName["fails"]!.runs[0]!.reason).toMatch(/final observation line/);
    expect(byName["crashes"]!.status).toBe("evaluator-error");
    expect(report.ok).toBe(false);
    expect(report.summary).toEqual({ total: 3, passed: 1, failed: 2 });
    expect(report.failed.map((f) => f.name).sort()).toEqual(["crashes", "fails"]);
  });

  test("a timeout reports the evaluator's final observation, not a generic message", async () => {
    const root = mkSuite();
    addScenario(root, "slow", "name: slow\nprofile: persona-echo\nevaluate: evaluate.sh\ntimeout: 1\n", {
      "evaluate.sh": "#!/usr/bin/env bash\necho 'polling: board still has 0 cards'\nsleep 30\n",
    });
    const report = await run(root);
    expect(report.scenarios[0]!.status).toBe("timeout");
    expect(report.scenarios[0]!.runs[0]!.reason).toMatch(/board still has 0 cards/);
  });

  test("a passing run with a failing cleanup is downgraded to evaluator-error", async () => {
    const root = mkSuite();
    addScenario(
      root,
      "dirty",
      'name: dirty\nprofile: persona-echo\nevaluate: evaluate.sh\ncleanup:\n  - "false"\n',
      { "evaluate.sh": evaluator(0) },
    );
    const report = await run(root);
    expect(report.scenarios[0]!.status).toBe("evaluator-error");
    expect(report.scenarios[0]!.runs[0]!.reason).toMatch(/cleanup failed/);
    expect(report.ok).toBe(false);
  });

  test("a failing run keeps its verdict when cleanup also fails, with the note appended", async () => {
    const root = mkSuite();
    addScenario(
      root,
      "both-fail",
      'name: both-fail\nprofile: persona-echo\nevaluate: evaluate.sh\ncleanup:\n  - "false"\n',
      { "evaluate.sh": evaluator(1) },
    );
    const report = await run(root);
    // The agent's real failure is not hidden behind evaluator-error...
    expect(report.scenarios[0]!.status).toBe("fail");
    // ...but the dirty cleanup is never silent either.
    expect(report.scenarios[0]!.runs[0]!.reason).toMatch(/also: cleanup failed/);
  });

  test("a broken symlink is a collected validation error, not a crash", async () => {
    const root = mkSuite();
    const dir = addScenario(root, "dangling", SCENARIO_MIN);
    symlinkSync(join(dir, "nowhere-real"), join(dir, "evaluate.sh"));
    const report = await run(root);
    expect(report.ok).toBe(false);
    expect(report.schemaErrors?.join("\n")).toMatch(/does not exist|cannot be resolved/);
  });

  test("a symlinked evaluator escaping the scenario directory is rejected", async () => {
    const root = mkSuite();
    const outside = join(tmp(), "outside.sh");
    writeFileSync(outside, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(outside, 0o755);
    const dir = addScenario(root, "escapee", SCENARIO_MIN);
    symlinkSync(outside, join(dir, "evaluate.sh"));
    const report = await run(root);
    expect(report.ok).toBe(false);
    expect(report.schemaErrors?.join("\n")).toMatch(/resolves outside the scenario directory/);
  });

  test("cleanup runs after failure AND after timeout", async () => {
    const root = mkSuite();
    const failMark = join(root, "cleaned-after-fail");
    const timeoutMark = join(root, "cleaned-after-timeout");
    addScenario(
      root,
      "fails",
      `name: fails\nprofile: persona-echo\nevaluate: evaluate.sh\ncleanup:\n  - touch ${failMark}\n`,
      { "evaluate.sh": evaluator(1) },
    );
    addScenario(
      root,
      "slow",
      `name: slow\nprofile: persona-echo\nevaluate: evaluate.sh\ntimeout: 1\ncleanup:\n  - touch ${timeoutMark}\n`,
      { "evaluate.sh": "#!/usr/bin/env bash\nsleep 30\n" },
    );
    await run(root);
    expect(existsSync(failMark)).toBe(true);
    expect(existsSync(timeoutMark)).toBe(true);
  });

  test("a failing setup command is an evaluator-error, and the evaluator never runs", async () => {
    const root = mkSuite();
    const marker = join(root, "evaluator-ran");
    addScenario(
      root,
      "alpha",
      'name: alpha\nprofile: persona-echo\nevaluate: evaluate.sh\nsetup:\n  - "false"\n',
      { "evaluate.sh": evaluator(0, `touch ${JSON.stringify(marker)}`) },
    );
    const report = await run(root);
    expect(report.scenarios[0]!.status).toBe("evaluator-error");
    expect(report.scenarios[0]!.runs[0]!.reason).toMatch(/setup failed/);
    expect(existsSync(marker)).toBe(false);
  });

  test("the evaluator contract arrives as HG_EVAL_* environment", async () => {
    const root = mkSuite();
    addScenario(root, "alpha", SCENARIO_MIN, {
      "evaluate.sh":
        "#!/usr/bin/env bash\n" +
        'test "$HG_EVAL_PROFILE" = persona-echo || exit 3\n' +
        'test "$HG_EVAL_NAMESPACE" = hermes-persona-echo || exit 3\n' +
        'test "$HG_EVAL_POD" = hermes-persona-echo-0 || exit 3\n' +
        'test -d "$HG_EVAL_ARTIFACTS" || exit 3\n' +
        'test "$HG_EVAL_RUN" = 1 || exit 3\n' +
        'test -n "$HG_EVAL_DEADLINE" || exit 3\n' +
        // No prompt: declared, so no response file is promised.
        'test -z "$HG_EVAL_RESPONSE" || exit 3\n' +
        "exit 0\n",
    });
    const report = await run(root);
    expect(report.scenarios[0]!.status).toBe("pass");
  });

  test("evaluator stdout/stderr land in the artifact directory", async () => {
    const root = mkSuite();
    addScenario(root, "alpha", SCENARIO_MIN, { "evaluate.sh": evaluator(1) });
    const artifactRoot = join(tmp(), "artifacts");
    const report = await run(root, { artifactRoot });
    const dir = report.scenarios[0]!.runs[0]!.artifacts;
    expect(readFileSync(join(dir, "evaluator.stdout.txt"), "utf8")).toMatch(/final observation line/);
    expect(existsSync(join(dir, "evaluator.stderr.txt"))).toBe(true);
  });

  test("--repeat records every run independently and aggregates worst-of", async () => {
    const root = mkSuite();
    // Passes on run 1, fails on later runs (a nondeterminism surfacer).
    addScenario(root, "flaky", "name: flaky\nprofile: persona-echo\nevaluate: evaluate.sh\n", {
      "evaluate.sh": '#!/usr/bin/env bash\ntest "$HG_EVAL_RUN" = 1 && exit 0\nexit 1\n',
    });
    const report = await run(root, { repeatOverride: 3 });
    expect(report.scenarios[0]!.runs.map((r) => r.status)).toEqual(["pass", "fail", "fail"]);
    expect(report.scenarios[0]!.status).toBe("fail");
  });

  test("required: false scenarios report but never gate the suite", async () => {
    const root = mkSuite();
    addScenario(
      root,
      "informational",
      "name: informational\nprofile: persona-echo\nevaluate: evaluate.sh\nrequired: false\n",
      { "evaluate.sh": evaluator(1) },
    );
    const report = await run(root);
    expect(report.scenarios[0]!.status).toBe("fail");
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
  });
});

describe("runEval selection", () => {
  function twoScenarios(): string {
    const root = mkSuite();
    addScenario(root, "alpha", "name: alpha\nprofile: persona-echo\nevaluate: evaluate.sh\n", {
      "evaluate.sh": evaluator(0),
    });
    addScenario(root, "beta", "name: beta\nprofile: persona-echo\nevaluate: evaluate.sh\n", {
      "evaluate.sh": evaluator(0),
    });
    return root;
  }

  test("--scenario narrows to one", async () => {
    const report = await run(twoScenarios(), { onlyScenario: "beta" });
    expect(report.scenarios.map((s) => s.name)).toEqual(["beta"]);
  });

  test("an unknown --scenario names the known set", async () => {
    expect(run(twoScenarios(), { onlyScenario: "nope" })).rejects.toThrow(/alpha, beta/);
  });

  test("an unknown --profile names the suite's profiles", async () => {
    expect(run(twoScenarios(), { onlyProfile: "nope" })).rejects.toThrow(/persona-echo/);
  });
});

describe("the trust boundary", () => {
  test("repoScriptsAllowed is trusted-or-consented", async () => {
    const root = tmp();
    expect(repoScriptsAllowed(mkState(root, true), false)).toBe(true);
    expect(repoScriptsAllowed(mkState(root, false), false)).toBe(false);
    expect(repoScriptsAllowed(mkState(root, false), true)).toBe(true);
  });

  test("an eval root inside an untrusted clone refuses without consent", async () => {
    const root = mkSuite();
    addScenario(root, "alpha", SCENARIO_MIN, { "evaluate.sh": evaluator(0) });
    expect(run(root, { state: mkState(root, false) })).rejects.toThrow(/allow-repo-scripts/);
    const consented = await run(root, { state: mkState(root, false), allowRepoScripts: true });
    expect(consented.ok).toBe(true);
  });

  test("a --dir outside the onboarded clone is operator-typed, i.e. trusted", async () => {
    const root = mkSuite();
    addScenario(root, "alpha", SCENARIO_MIN, { "evaluate.sh": evaluator(0) });
    // Untrusted state, but the suite lives elsewhere on the local disk.
    const report = await run(root, { state: mkState(tmp(), false) });
    expect(report.ok).toBe(true);
  });
});

describe("non-interference with deployment validation", () => {
  test("a corrupt evals/ does not touch hermes-gitops.test.yaml loading", async () => {
    const profileDir = tmp();
    mkdirSync(join(profileDir, "evals"));
    writeFileSync(join(profileDir, "evals", "suite.yaml"), "judge: llm\n:::not yaml at all");
    const cfg = loadTestConfig(profileDir);
    expect(cfg.smoke).toEqual([]);
    expect(cfg.pyeval).toBeNull();
  });
});
