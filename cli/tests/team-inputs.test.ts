// Content-only commits (ADR 0198): a commit that changes nothing an agent is built from is
// applied without a rollout and without acceptance; anything else runs as before.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stringify } from "yaml";
import { agentInputs, carryForward, platformIdentity, readApplied, relativeLiterals, runOrSkip, skipReason, type PlatformIdentity } from "../src/team/inputs.ts";
import { STAGES, type Evidence, type Ledger, type Stage, type StageOperation } from "../src/team/ledger.ts";
import { digest, type TeamPlan } from "../src/team/plan.ts";
import { compileTeam, type ResolvedSource } from "../src/team/compiler.ts";
import { reportedAppliedSha } from "../src/team/command.ts";
import { desiredAgent } from "../src/team/health.ts";
import { scaffoldBundle } from "../src/agent-bundle/scaffold.ts";
import versions from "../../versions.json";

const temporary: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-inputs-")); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
const write = (root: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const commit = (root: string, message: string) => { git(root, "add", "--all", "."); git(root, "commit", "-q", "--allow-empty", "-m", message); return git(root, "rev-parse", "HEAD"); };

const PLATFORM: PlatformIdentity = { revision: "c".repeat(40), changes: "", versions: "v1" };
const CREDENTIALS = "d".repeat(64);
const agent = (name: string) => ({ name, subdir: `agents/eve/${name}/src`, environment: [], tools: [], writablePaths: [], skills: [] });
function planFor(): TeamPlan {
  return { version: 1, id: "factory", sources: [{ id: "social", repository: "https://github.com/example/social", ref: "main", private: false, agents: [agent("research"), agent("manager")] }],
    destination: { repository: "https://github.com/example/generated", branch: "main", credentialEnv: "GITOPS_TOKEN", autoMerge: false },
    environment: "environment.yaml", argoDestinations: ["in-cluster"], bootstrap: { directory: "infra", stack: "test" }, kubeContext: "test",
    runtime: { image: `example/eve@sha256:${"a".repeat(64)}`, platform: "linux/amd64" }, authorizations: [],
    acceptance: [{ id: "verify-research", source: "social", agent: "research", argv: ["node", "verify.mjs"], effect: "read" }] };
}

/** A persona-shaped source: agent code reaching `lib/` through relative imports (three levels
 * deep for research), declarations, a chart, and the content the agents write. */
function persona() {
  const root = temp();
  git(root, "init", "-q", "-b", "main");
  for (const name of ["research", "manager"]) {
    write(root, `agents/eve/${name}/src/package.json`, JSON.stringify({ name, type: "module" }));
    write(root, `agents/eve/${name}/harness-hg/agent.yaml`, "harness: eve\n");
  }
  write(root, "agents/eve/research/src/agent/tools/claim_task.ts", `import { workflow } from "../../../../../../lib/eve/operations.mjs";\nexport default workflow;\n`);
  write(root, "agents/eve/manager/src/agent/agent.ts", `import { route } from "../../../../../lib/eve/model-routing.mjs";\nexport default route;\n`);
  write(root, "lib/eve/operations.mjs", `import { route } from "./model-routing.mjs";\nexport const workflow = route;\n`);
  write(root, "lib/eve/model-routing.mjs", `import { table } from "./tables/index.mjs";\nexport const route = () => table;\n`);
  write(root, "lib/eve/tables/index.mjs", `export const table = "sonnet";\n`);
  write(root, "lib/unrelated.mjs", "export const unused = 1;\n");
  write(root, "harness-hg/team.yaml", "name: marketing\n");
  write(root, "charts/postiz/Chart.yaml", "name: postiz\nversion: 0.1.0\n");
  write(root, "content/topics/2026-09-14.md", "# topics\n");
  const first = commit(root, "persona");
  return { root, first, ledgerFile: path.join(temp(), "state.json") };
}

type Persona = ReturnType<typeof persona>;
const readPrior = (f: Persona): Partial<Ledger> | undefined => fs.existsSync(f.ledgerFile) ? JSON.parse(fs.readFileSync(f.ledgerFile, "utf8")) : undefined;

/** One resume, the way `hg team resume` runs it: resolve, carry forward, compute the stage input
 * (the projection names every effective commit), then skip or run the stage machine. Every stage
 * operation records that it ran - provisioning, publication (the rollout) and acceptance included. */
async function resume(f: Persona, options: { plan?: TeamPlan; platform?: () => PlatformIdentity; credentials?: string; prior?: Partial<Ledger>; outcome?: Partial<Record<Stage, Evidence>> } = {}) {
  const plan = options.plan ?? planFor();
  const prior = options.prior ?? readPrior(f);
  const head = git(f.root, "rev-parse", "HEAD");
  const logs: string[] = [];
  const { sources, decisions } = carryForward(plan, [{ definition: plan.sources[0]!, root: f.root, sha: head }], prior?.applied,
    { platform: options.platform ?? (() => PLATFORM), log: line => logs.push(line) });
  const input = digest({ plan, projection: sources.map(s => [s.definition.id, s.sha]) });
  const ran: Stage[] = [];
  const operations = Object.fromEntries(STAGES.map(stage => [stage, { apply: async (): Promise<Evidence> => {
    ran.push(stage);
    return options.outcome?.[stage] ?? { verdict: "pass", summary: stage };
  } }])) as Record<Stage, StageOperation>;
  const settled = await runOrSkip({ ledgerFile: f.ledgerFile, installation: "factory", input, credentials: options.credentials ?? CREDENTIALS,
    prior, decisions, operations, allowSkip: true });
  return { ...settled, ran, head, deployed: sources[0]!.sha, decision: decisions[0]!, logs };
}

describe("agent inputs", () => {
  test("the digest is deterministic, ignores content, and follows relative imports transitively", () => {
    const f = persona(), plan = planFor();
    const at = (sha: string) => agentInputs(f.root, sha, plan.sources[0]!, { plan, platform: PLATFORM });
    const first = at(f.first);
    expect(at(f.first).digest).toBe(first.digest);
    expect(first.paths).toContain("lib/eve/operations.mjs");
    expect(first.paths).toContain("lib/eve/model-routing.mjs");
    expect(first.paths).toContain("lib/eve/tables/index.mjs");
    expect(first.paths).toContain("agents/eve/research/harness-hg/agent.yaml");
    expect(first.paths).toContain("harness-hg/team.yaml");
    expect(first.paths).toContain("charts/postiz/Chart.yaml");
    expect(first.paths).not.toContain("lib/unrelated.mjs");
    expect(first.paths.some(p => p.startsWith("content/"))).toBe(false);
    write(f.root, "content/topics/2026-09-14.md", "# topics, revised\n");
    expect(at(commit(f.root, "content")).digest).toBe(first.digest);
  });

  test("relative literals: module specifiers, URLs and dependency specifiers; bare packages are not paths", () => {
    const text = `import a from "./a.js"; export * from '../b'; await import(\`../../c.mjs\`); require("./d.json");\n` +
      `new URL("../assets/x.png", import.meta.url); import z from "zod"; const dep = { "local": "file:../lib" };`;
    expect(relativeLiterals(text)).toEqual(["./a.js", "../b", "../../c.mjs", "./d.json", "../assets/x.png", "../lib"]);
  });

  test("a missing import target widens to its nearest existing directory, and a path leaving the repository refuses", () => {
    const f = persona(), plan = planFor();
    write(f.root, "agents/eve/research/src/agent/tools/extra.ts", `import x from "../../../../../../lib/eve/generated/table.mjs";\n`);
    const widened = agentInputs(f.root, commit(f.root, "missing"), plan.sources[0]!, { plan, platform: PLATFORM });
    expect(widened.notes.join("\n")).toContain("lib/eve is an input instead");
    write(f.root, "agents/eve/research/src/agent/tools/extra.ts", `import x from "../../../../../../../../outside.mjs";\n`);
    expect(() => agentInputs(f.root, commit(f.root, "escape"), plan.sources[0]!, { plan, platform: PLATFORM })).toThrow("leaves the repository");
  });

  test("the platform identity is this checkout's commit", () => {
    const identity = platformIdentity();
    expect(identity.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(identity.versions).toBe(digest(versions));
    expect(() => platformIdentity(temp())).toThrow();
  });
});

describe("content-only commits (ADR 0198)", () => {
  test("a content-only commit is applied with no rollout and no acceptance, and the ledger records why", async () => {
    const f = persona();
    const first = await resume(f);
    expect(first.ran).toEqual([...STAGES]);
    expect(first.ledger.applied?.sources["social"]).toMatchObject({ desiredSha: f.first, effectiveSha: f.first });

    write(f.root, "content/angle-options/2026-09-14-selection.md", "- angle one\n");
    const content = commit(f.root, "feat(content): update selection");
    const second = await resume(f);
    expect(second.ran).toEqual([]); // nothing provisioned, published, rolled out or accepted
    expect(second.deployed).toBe(f.first); // the workload keeps declaring the deployed commit
    expect(second.skipped).toContain(`no agent input changed since ${f.first.slice(0, 12)}`);
    const saved = readPrior(f)!;
    expect(saved.complete).toBe(true);
    expect(saved.skipped?.reason).toBe(second.skipped!);
    expect(saved.applied?.sources["social"]).toEqual({ desiredSha: content, effectiveSha: f.first, inputs: first.ledger.applied!.sources["social"]!.inputs,
      reason: `no agent input changed since ${f.first.slice(0, 12)}` });
    expect(saved.stages).toEqual(first.ledger.stages);
  });

  test("a manual resume on a content-only change is a no-op, again and again", async () => {
    const f = persona();
    await resume(f);
    write(f.root, "content/topics/next.md", "# next\n");
    commit(f.root, "content");
    const once = await resume(f), twice = await resume(f);
    expect(once.ran).toEqual([]);
    expect(twice.ran).toEqual([]);
    expect(twice.deployed).toBe(f.first);
    expect(readPrior(f)!.applied!.sources["social"]!.effectiveSha).toBe(f.first);
  });

  test("a resume with nothing to carry keeps today's behaviour: it re-verifies", async () => {
    const f = persona();
    await resume(f);
    const again = await resume(f);
    expect(again.skipped).toBeUndefined();
    expect(again.ran).toEqual([...STAGES]);
  });

  test("a change in an agent subdirectory rolls out", async () => {
    const f = persona();
    await resume(f);
    write(f.root, "agents/eve/manager/src/agent/agent.ts", `import { route } from "../../../../../lib/eve/model-routing.mjs";\nexport default () => route();\n`);
    const changed = commit(f.root, "agent change");
    const next = await resume(f);
    expect(next.skipped).toBeUndefined();
    expect(next.decision.carried).toBe(false);
    expect(next.decision.reason).toContain("agent inputs changed");
    expect(next.deployed).toBe(changed);
    expect(next.ran).toEqual([...STAGES]);
    expect(next.ledger.applied!.sources["social"]).toMatchObject({ desiredSha: changed, effectiveSha: changed });
  });

  test("a change only in a transitively imported lib file rolls out; an unreferenced one does not", async () => {
    const f = persona();
    await resume(f);
    write(f.root, "lib/unrelated.mjs", "export const unused = 2;\n");
    commit(f.root, "unrelated");
    expect((await resume(f)).ran).toEqual([]);
    write(f.root, "lib/eve/tables/index.mjs", `export const table = "haiku";\n`);
    const changed = commit(f.root, "routing table");
    const next = await resume(f);
    expect(next.deployed).toBe(changed);
    expect(next.ran).toEqual([...STAGES]);
  });

  test("a declaration or chart change rolls out", async () => {
    for (const [file, text] of [["agents/eve/research/harness-hg/agent.yaml", "harness: eve\n# changed\n"], ["harness-hg/team.yaml", "name: marketing-two\n"], ["charts/postiz/Chart.yaml", "name: postiz\nversion: 0.2.0\n"]] as const) {
      const f = persona();
      await resume(f);
      write(f.root, file, text);
      const changed = commit(f.root, file);
      const next = await resume(f);
      expect({ file, deployed: next.deployed }).toEqual({ file, deployed: changed });
      expect(next.ran).toEqual([...STAGES]);
    }
  });

  test("a plan change rolls out even when the source only changed content", async () => {
    const f = persona();
    await resume(f);
    write(f.root, "content/topics/next.md", "# next\n");
    const content = commit(f.root, "content");
    const plan = planFor();
    plan.sources[0]!.agents[0]!.environment = ["ANTHROPIC_API_KEY"];
    const next = await resume(f, { plan });
    expect(next.deployed).toBe(content);
    expect(next.ran).toEqual([...STAGES]);
  });

  test("a platform revision or version change rolls out", async () => {
    for (const platform of [{ ...PLATFORM, revision: "e".repeat(40) }, { ...PLATFORM, versions: "v2" }, { ...PLATFORM, changes: "f".repeat(64) }]) {
      const f = persona();
      await resume(f);
      write(f.root, "content/topics/next.md", "# next\n");
      const content = commit(f.root, "content");
      const next = await resume(f, { platform: () => platform });
      expect(next.deployed).toBe(content);
      expect(next.ran).toEqual([...STAGES]);
    }
  });

  test("changed credentials are not skipped", async () => {
    const f = persona();
    await resume(f);
    write(f.root, "content/topics/next.md", "# next\n");
    commit(f.root, "content");
    const next = await resume(f, { credentials: "9".repeat(64) });
    expect(next.skipped).toBeUndefined();
    expect(next.ran).toEqual([...STAGES]);
  });

  test("a missing, corrupt or uncomputable digest is a full run", async () => {
    const setup = async () => {
      const f = persona();
      await resume(f);
      write(f.root, "content/topics/next.md", "# next\n");
      return { f, content: commit(f.root, "content") };
    };
    {
      const { f, content } = await setup();
      const prior = readPrior(f)!;
      delete prior.applied; // a ledger written before this platform recorded agent inputs
      const next = await resume(f, { prior });
      expect([next.deployed, next.ran.length, next.decision.reason]).toEqual([content, STAGES.length, `no agent inputs are recorded for this source; a full run at ${content.slice(0, 12)}`]);
    }
    {
      const { f, content } = await setup();
      const prior = readPrior(f)!;
      (prior.applied as any).sources.social.inputs = "not-a-digest";
      const next = await resume(f, { prior });
      expect([next.deployed, next.ran.length]).toEqual([content, STAGES.length]);
      expect(next.logs).toContain("the recorded agent inputs are unreadable; every source runs in full");
      expect(readApplied(prior.applied)).toBeUndefined();
    }
    {
      const { f, content } = await setup();
      const next = await resume(f, { platform: () => { throw new Error("not a git checkout"); } });
      expect([next.deployed, next.ran.length]).toEqual([content, STAGES.length]);
      expect(next.decision.reason).toContain("agent inputs could not be computed");
    }
    {
      const { f, content } = await setup();
      write(f.root, "agents/eve/research/src/agent/tools/escape.ts", `import x from "../../../../../../../../../outside.mjs";\n`);
      const escaped = commit(f.root, "escape");
      const next = await resume(f);
      expect(escaped).not.toBe(content);
      expect([next.deployed, next.ran.length]).toEqual([escaped, STAGES.length]);
      expect(next.decision.reason).toContain("leaves the repository");
    }
  });

  test("a rewritten history is a full run: the build container could not fetch the deployed commit", async () => {
    const f = persona();
    await resume(f);
    git(f.root, "checkout", "-q", "--orphan", "rewritten");
    const rewritten = commit(f.root, "same tree, new history");
    const next = await resume(f);
    expect(next.decision.reason).toContain("is not in the history of");
    expect([next.deployed, next.ran.length]).toEqual([rewritten, STAGES.length]);
  });

  test("an incomplete run still records what it published, and the next content-only commit does not roll pods", async () => {
    const f = persona();
    const pending = await resume(f, { outcome: { "acceptance-verified": { verdict: "unknown", summary: "in flight", pending: { reason: "in-flight" } } } });
    expect(pending.ledger.complete).toBe(false);
    expect(pending.ledger.applied!.sources["social"]!.effectiveSha).toBe(f.first);
    write(f.root, "content/topics/next.md", "# next\n");
    commit(f.root, "content");
    const next = await resume(f);
    expect(next.deployed).toBe(f.first); // publication stays byte-identical: nothing rolls
    expect(next.skipped).toBeUndefined(); // but the unfinished installation still finishes
    expect(next.ran).toEqual([...STAGES]);
  });

  test("skipReason needs a complete run at exactly this input and these credentials, with something carried", () => {
    const decisions = [{ id: "social", desiredSha: "b".repeat(40), effectiveSha: "a".repeat(40), inputs: "1".repeat(64), carried: true, reason: "no agent input changed since aaaaaaaaaaaa" }];
    const applied = { input: "2".repeat(64), credentials: CREDENTIALS, recordedAt: "t", sources: { social: { desiredSha: "a".repeat(40), effectiveSha: "a".repeat(40), inputs: "1".repeat(64) } } };
    const prior = { complete: true, input: "2".repeat(64), applied };
    expect(skipReason(prior, "2".repeat(64), CREDENTIALS, decisions)).toContain("source social bbbbbbbbbbbb");
    expect(skipReason({ ...prior, complete: false }, "2".repeat(64), CREDENTIALS, decisions)).toBeUndefined();
    expect(skipReason(prior, "3".repeat(64), CREDENTIALS, decisions)).toBeUndefined();
    expect(skipReason(prior, "2".repeat(64), "4".repeat(64), decisions)).toBeUndefined();
    expect(skipReason(prior, "2".repeat(64), CREDENTIALS, [{ ...decisions[0]!, carried: false }])).toBeUndefined();
    expect(skipReason(undefined, "2".repeat(64), CREDENTIALS, decisions)).toBeUndefined();
  });

  test("a carried source renders the projection its deployed commit rendered, from the new tree", () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "environment.yaml"), stringify({ version: 1, layout: "single", sovereignty: { mode: "permissive" }, regions: [{ name: "local", jurisdiction: "local", targets: [{ name: "local", argoDestination: "in-cluster", primary: true }] }] }));
    const sourceRoot = path.join(root, "team-0");
    scaffoldBundle({ dir: sourceRoot, team: "team-0", agents: [{ name: "research", harness: "eve" }], gitopsRepoUrl: "https://github.com/example/generated" });
    git(sourceRoot, "init", "-q", "-b", "main");
    const deployed = commit(sourceRoot, "scaffold");
    const plan = { ...planFor(), sources: [{ id: "team-0", repository: "https://github.com/example/team-0", ref: "main", private: false, agents: [agent("research")] }],
      acceptance: [{ id: "verify-research", source: "team-0", agent: "research", argv: ["node", "verify.mjs"], effect: "read" as const }] };
    const render = (s: ResolvedSource, a: TeamPlan["sources"][number]["agents"][number]) => stringify({ spec: { persona: a.name, runtime: "eve", source: s.definition.repository, sha: s.sha, sourceSubdir: a.subdir } });
    const before = compileTeam(plan, root, [{ definition: plan.sources[0]!, root: sourceRoot, sha: deployed }], render);
    fs.mkdirSync(path.join(sourceRoot, "content/topics"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "content/topics/today.md"), "# today\n");
    const content = commit(sourceRoot, "content");
    const applied = { input: "2".repeat(64), credentials: CREDENTIALS, recordedAt: "t", sources: { "team-0": { desiredSha: deployed, effectiveSha: deployed,
      inputs: agentInputs(sourceRoot, deployed, plan.sources[0]!, { plan, platform: PLATFORM }).digest } } };
    const carried = carryForward(plan, [{ definition: plan.sources[0]!, root: sourceRoot, sha: content }], applied, { platform: () => PLATFORM });
    expect(carried.decisions[0]!.carried).toBe(true);
    const after = compileTeam(plan, root, carried.sources, render);
    expect(after.fingerprint).toBe(before.fingerprint);
  });
});

describe("what a skipped commit reports", () => {
  const decision = { id: "social", desiredSha: "b".repeat(40), effectiveSha: "a".repeat(40), inputs: "1".repeat(64), carried: true, reason: "no agent input changed since aaaaaaaaaaaa" };
  test("the desired commit is applied when the run skipped, or when the workload declares the carried commit", () => {
    expect(reportedAppliedSha(decision, undefined, true)).toBe("b".repeat(40));
    expect(reportedAppliedSha(decision, "a".repeat(40), false)).toBe("b".repeat(40));
    expect(reportedAppliedSha(decision, "c".repeat(40), false)).toBe("c".repeat(40));
    expect(reportedAppliedSha({ ...decision, carried: false, effectiveSha: decision.desiredSha }, "a".repeat(40), false)).toBe("a".repeat(40));
    expect(reportedAppliedSha(undefined, "a".repeat(40), false)).toBe("a".repeat(40));
  });
  test("team status compares a build with the carried commit only when the record names exactly the locked commit", () => {
    const plan = planFor(), source = plan.sources[0]!;
    const lock = { version: 2 as const, installation: "factory", planDigest: "0".repeat(64), sources: { social: { ref: "refs/tags/v2", commit: "b".repeat(40) } }, agents: {} };
    expect(desiredAgent(plan, source, source.agents[0]!, lock, undefined, { desiredSha: "b".repeat(40), effectiveSha: "a".repeat(40) }).sourceSha).toBe("a".repeat(40));
    expect(desiredAgent(plan, source, source.agents[0]!, lock, undefined, { desiredSha: "c".repeat(40), effectiveSha: "a".repeat(40) }).sourceSha).toBe("b".repeat(40));
    expect(desiredAgent(plan, source, source.agents[0]!, lock).sourceSha).toBe("b".repeat(40));
  });
});
