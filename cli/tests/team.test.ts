import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stringify, parse } from "yaml";
import { scaffoldBundle } from "../src/agent-bundle/scaffold.ts";
import { compileTeam, type ResolvedSource, type Projection } from "../src/team/compiler.ts";
import { digest, credentialFingerprint, secretEnvironmentNames, validatePlan, type TeamPlan } from "../src/team/plan.ts";
import { redactAppValueDiff, stageProjection, transientMergeFailure, OWNERSHIP_FILE, publishProjection, previewProjection, ForgeFailure, type Forge } from "../src/team/publisher.ts";
import { executeStages, readLedger, STAGES, type StageOperation, type Stage } from "../src/team/ledger.ts";
import { compileResolved, effectiveRuntimeFacts, resolveAppValues } from "../src/team/command.ts";
import { isRuntimeCanary, validateRuntimeSource, workloadRuntimeImage } from "../src/team/runtime.ts";
import { skillContentHash, validateRuntimeSource, verifyProductionRuntime } from "../src/team/runtime.ts";
import { argoDesiredManifests, failedOldPod, recoverOldPod, workspaceClaimAddition, recoverWorkspaceClaim, recoverWorkspacePod, resumeWorkspaceController } from "../src/team/recovery.ts";
import { run, declaredSecrets, type Run } from "../src/team/process.ts";
import { provisioningGate, readBootstrapInputs } from "../src/team/providers.ts";
import versions from "../../versions.json";

const temporary: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-test-")); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(rosters: string[][] = [["manager", "research", "engagement", "marketing-sre"], ["support", "pm", "sre"]]) {
  const root = temp();
  fs.writeFileSync(path.join(root, "environment.yaml"), stringify({ version: 1, layout: "single", sovereignty: { mode: "permissive" }, regions: [{ name: "local", jurisdiction: "local", targets: [{ name: "local", argoDestination: "in-cluster", primary: true }] }] }));
  const sources: ResolvedSource[] = rosters.map((names, i) => {
    const id = `team-${i}`, sourceRoot = path.join(root, id);
    scaffoldBundle({ dir: sourceRoot, team: id, agents: names.map(name => ({ name, harness: "eve" })), gitopsRepoUrl: "https://github.com/example/generated" });
    for (const name of names) fs.writeFileSync(path.join(sourceRoot, `agents/eve/${name}/src/package-lock.json`), JSON.stringify({ packages: { "node_modules/eve": { version: versions.runtimes.eve.version }, "node_modules/just-bash": { version: versions.runtimes.eve.sandboxDependency } } }));
    return { root: sourceRoot, sha: (i ? "b" : "a").repeat(40), definition: { id, repository: `https://github.com/example/${id}`, ref: "main", private: false,
      agents: names.map(name => ({ name, subdir: `agents/eve/${name}/src`, environment: [], tools: [], writablePaths: [], skills: [] })) } };
  });
  const plan: TeamPlan = { version: 1, id: "factory", sources: sources.map(s => s.definition),
    destination: { repository: "https://github.com/example/generated", branch: "main", credentialEnv: "GITOPS_TOKEN", autoMerge: false },
    environment: "environment.yaml", argoDestinations: ["in-cluster"], bootstrap: { directory: "infra", stack: "test" }, kubeContext: "test",
    runtime: { image: `example/eve@sha256:${"a".repeat(64)}`, platform: "linux/amd64" }, authorizations: [],
    acceptance: sources.flatMap(s => s.definition.agents.map(a => ({ id: `verify-${a.name}`, source: s.definition.id, agent: a.name, argv: ["node", "verify.mjs"], effect: "read" as const }))) };
  const compile = () => compileTeam(plan, root, sources, (s, a) => stringify({ spec: { persona: a.name, runtime: "eve", source: s.definition.repository, sha: s.sha, sourceSubdir: a.subdir, ...(a.gitAuthSecretRef ? { gitAuthSecretRef: a.gitAuthSecretRef } : {}) } }));
  return { root, sources, plan, compile };
}

describe("team installation", () => {
  test("preview withholds sensitive profile sections including rotated and escaped values", () => {
    const f = fixture([["one"]]);
    f.plan.sources[0]!.agents[0]!.appValueBindings = { "app.auth.password": "HG_APP_PASSWORD" };
    const sensitive = 'diff --git a/profiles/one/profile.yaml b/profiles/one/profile.yaml\n-  password: old-rotated-value\n+  password: "escaped\\nvalue"\n+  multiline: |\n+    private-line\n';
    const ordinary = 'diff --git a/deployments/plan.yaml b/deployments/plan.yaml\n+new: true\n';
    const output = redactAppValueDiff(f.plan, sensitive + ordinary);
    expect(output).not.toContain("old-rotated-value"); expect(output).not.toContain("escaped"); expect(output).not.toContain("private-line");
    expect(output).toContain("withheld"); expect(output).toContain(ordinary);
    expect(redactAppValueDiff(f.plan, sensitive.replaceAll("a/profiles/", "profiles/").replaceAll("b/profiles/", "profiles/"))).not.toContain("old-rotated-value");
  });
  test("managed app values replace only explicit markers without mutating the plan", () => {
    const f = fixture([["one"]]), agent = f.sources[0]!.definition.agents[0]!;
    agent.appValues = { app: { auth: { password: { secret: true } } } };
    agent.appValueBindings = { "app.auth.password": "HG_APP_PASSWORD" };
    validatePlan(f.plan);
    expect(resolveAppValues(agent, { HG_APP_PASSWORD: "existing-fixture" })).toEqual({app:{auth:{password:"existing-fixture"}}});
    expect(agent.appValues.app!.auth).toEqual({password:{secret:true}});
    expect(() => resolveAppValues(agent, {})).toThrow("missing app value input");
    agent.appValueBindings = {};
    expect(() => resolveAppValues(agent)).toThrow("unresolved app value secret marker");
    agent.appValueBindings = { "app.__proto__.password": "HG_APP_PASSWORD" };
    expect(() => validatePlan(f.plan)).toThrow("safe dotted paths");
    expect(() => resolveAppValues(agent, { HG_APP_PASSWORD: "existing-fixture" })).toThrow("Unsafe");
  });
  test("profile inventory preserves sentinel files and still rejects directory symlinks", () => {
    const f = fixture([["one"]]), destination = temp();
    fs.mkdirSync(path.join(destination, "profiles"));
    fs.writeFileSync(path.join(destination, "profiles/.gitkeep"), "");
    stageProjection(destination, f.plan.id, f.compile());
    expect(fs.readFileSync(path.join(destination, "profiles/.gitkeep"), "utf8")).toBe("");
    fs.symlinkSync(temp(), path.join(destination, "profiles/linked"));
    expect(() => stageProjection(destination, f.plan.id, f.compile())).toThrow("symbolic link");
  });
  test("managed Secret inputs read only named resources and reject missing keys", async () => {
    const f = fixture([["one"]]);
    f.plan.credentials = { configFile: "baseline.yaml", bindings: {}, secretInputs: {
      HG_TEST_SECRET: { namespace: "ag-eve-one", secret: "ag-eve-one-env", key: "TOKEN" },
    } };
    validatePlan(f.plan);
    try {
      await readBootstrapInputs(f.plan, f.root, async (argv) => {
        expect(argv).toEqual(["kubectl", "--context", "test", "-n", "ag-eve-one", "get", "secret", "ag-eve-one-env", "-o", "json"]);
        return JSON.stringify({data:{TOKEN:Buffer.from("scoped-fixture").toString("base64")}});
      });
      expect(process.env.HG_TEST_SECRET).toBe("scoped-fixture");
      await expect(readBootstrapInputs(f.plan, f.root, async () => '{"data":{}}')).rejects.toThrow("Missing managed Secret key");
    } finally { delete process.env.HG_TEST_SECRET; }
  });
  test("runtime reuse of a destination credential participates in rotation evidence", () => {
    const f = fixture([["one"]]), agent = f.plan.sources[0]!.agents[0]!;
    agent.environment = ["SERVICE_TOKEN"];
    agent.environmentBindings = { SERVICE_TOKEN: "GITOPS_TOKEN" };
    expect(credentialFingerprint(f.plan, { GITOPS_TOKEN: "old" })).not.toBe(credentialFingerprint(f.plan, { GITOPS_TOKEN: "new" }));
    agent.environmentBindings = { SERVICE_TOKEN: ["GITOPS_TOKEN"] } as any;
    expect(() => validatePlan(f.plan)).toThrow("environment bindings");
  });
  test("bootstrap input references reuse encrypted config through Pulumi without logging values", async () => {
    const f = fixture([["one"]]);
    fs.mkdirSync(path.join(f.root, "infra")); fs.writeFileSync(path.join(f.root, "baseline.yaml"), "encrypted fixture");
    // Pulumi runs only against the backend derived from the stack's environment spec (ADR 0196).
    fs.mkdirSync(path.join(f.root, "infra/environments"));
    fs.writeFileSync(path.join(f.root, "infra/environments/test.yaml"), stringify({ apiVersion: "hermes-gitops.factorylevel.dev/environment/v1alpha2", name: "test", project: "example-project" }));
    f.plan.credentials = { configFile: "baseline.yaml", bindings: {}, inputs: {
      HG_TEST_MANAGED: "factory:agentSecrets.one.TOKEN", HG_TEST_REUSED: "factory:agentSecrets.one.TOKEN",
    } };
    let calls = 0;
    try {
      await readBootstrapInputs(f.plan, f.root, async (argv) => {
        calls++; expect(argv).toContain("--path"); expect(argv.join(" ")).not.toContain("fixture-value");
        return JSON.stringify({ value: "managed-fixture-value", secret: true });
      });
      expect(calls).toBe(1); expect(process.env.HG_TEST_MANAGED).toBe("managed-fixture-value");
      expect(process.env.HG_TEST_REUSED).toBe(process.env.HG_TEST_MANAGED);
      await expect(readBootstrapInputs(f.plan, f.root, async () => "{}")).rejects.toThrow("Missing scalar");
    } finally { delete process.env.HG_TEST_MANAGED; delete process.env.HG_TEST_REUSED; }
  });
  test("startup binds shared runtime variable names independently per agent", async () => {
    const f = fixture([["first", "second"]]);
    process.env.HG_TEST_FIRST = "first-fixture-value";
    process.env.HG_TEST_SECOND = "second-fixture-value";
    const seen: string[] = [];
    const exec: Run = async (argv, _cwd, env) => {
      if (argv[1] === "run") {
        seen.push(env!.SERVICE_TOKEN!);
        expect(argv).toContain(`type=bind,src=${f.sources[0]!.root},dst=/input,readonly`);
        expect(env!.HG_PROJECT_SUBDIR).toMatch(/^agents\/eve\/(first|second)\/src$/);
        expect(argv.join(" ")).not.toContain("fixture-value");
      }
      return "";
    };
    try {
      for (const agent of f.sources[0]!.definition.agents) {
        agent.environment = ["SERVICE_TOKEN"];
        agent.environmentBindings = { SERVICE_TOKEN: `HG_TEST_${agent.name.toUpperCase()}` };
        await verifyProductionRuntime(f.plan, f.sources[0]!, agent, exec);
      }
      expect(seen).toEqual(["first-fixture-value", "second-fixture-value"]);
      expect(secretEnvironmentNames(f.plan).has("HG_TEST_FIRST")).toBe(true);
      delete process.env.HG_TEST_SECOND;
      await expect(verifyProductionRuntime(f.plan, f.sources[0]!, f.sources[0]!.definition.agents[1]!, exec)).rejects.toThrow("missing runtime");
    } finally { delete process.env.HG_TEST_FIRST; delete process.env.HG_TEST_SECOND; }
  });
  test("only the selected owner's local chart source changes", () => {
    const f = fixture([["one", "two"]]);
    f.plan.sources[0]!.private = true;
    f.plan.sources[0]!.credentialEnv = "HG_SOURCE";
    for (const agent of f.plan.sources[0]!.agents) agent.gitAuthSecretRef = `ag-eve-${agent.name}-git-auth`;
    const before = f.compile();
    f.plan.sources[0]!.agents[0]!.appChartSource = { repository: f.plan.sources[0]!.repository, revision: "c".repeat(40) };
    validatePlan(f.plan);
    const after = f.compile();
    expect(after.files.get("profiles/two/profile.yaml")).toBe(before.files.get("profiles/two/profile.yaml"));
    expect(parse(String(after.files.get("deployments/agents/one/values.yaml"))).platformRepo).toEqual({ url: f.plan.sources[0]!.repository, revision: "c".repeat(40) });
  });

  test("a version 2 owner's chart revision is its locked source commit", () => {
    const f = fixture([["one", "two"]]);
    const source = f.plan.sources[0]!;
    f.plan.version = 2;
    f.plan.lock = "installation.lock.yaml";
    source.ref = "refs/tags/v1.0.0";
    source.private = true;
    source.credentialEnv = "HG_SOURCE";
    for (const agent of source.agents) agent.gitAuthSecretRef = `ag-eve-${agent.name}-git-auth`;
    source.agents[0]!.appChartSource = { repository: source.repository };
    validatePlan(f.plan);
    const values = parse(String(f.compile().files.get("deployments/agents/one/values.yaml")));
    expect(values.platformRepo).toEqual({ url: source.repository, revision: f.sources[0]!.sha });
  });
  test("startup receives capability URLs by environment name and refuses credential collisions", async () => {
    const f = fixture([["one"]]);
    const agent = f.plan.sources[0]!.agents[0]!;
    const url = "http://crm.example.svc.cluster.local:3000/mcp";
    let checked = false;
    const exec: Run = async (argv, _cwd, env) => {
      if (argv[1] === "run") {
        checked = true;
        expect(argv).toContain("HERMES_CAP_CRM_URL");
        expect(argv.join(" ")).not.toContain(url);
        expect(env!.HERMES_CAP_CRM_URL).toBe(url);
      }
      return "";
    };
    await verifyProductionRuntime(f.plan, f.sources[0]!, agent, exec, { HERMES_CAP_CRM_URL: url });
    expect(checked).toBe(true);
    agent.environment = ["HERMES_CAP_CRM_URL"];
    await expect(verifyProductionRuntime(f.plan, f.sources[0]!, agent, exec, { HERMES_CAP_CRM_URL: url })).rejects.toThrow("conflicting capability");
  });
  test("compiles four existing plus three new agents, workspaces, Nexus and exact source provenance together", () => {
    const f = fixture(); validatePlan(f.plan);
    const result = f.compile();
    expect(result.profiles).toHaveLength(7);
    for (const name of result.profiles) {
      expect(result.files.has(`profiles/${name}/profile.yaml`)).toBe(true);
      expect(result.files.has(`deployments/agents/${name}/deployment.yaml`)).toBe(true);
      expect(result.files.has(`deployments/workspaces/profiles/${name}.yaml`)).toBe(true);
    }
    const nexus = JSON.parse(String(result.files.get("deployments/control-plane/nexus-plan.json")));
    expect(nexus.components.filter((c: any) => c.kind === "agent")).toHaveLength(7);
    expect(JSON.parse(String(result.files.get("deployments/dashboard/sources.json"))).sources.map((s: any) => s.sha)).toEqual(["a".repeat(40), "b".repeat(40)]);
    expect(f.compile().fingerprint).toBe(result.fingerprint);
    f.sources.reverse(); expect(f.compile().fingerprint).toBe(result.fingerprint);
  });
  test("one arbitrary role works and a missing source or duplicate identity refuses", () => {
    const f = fixture([["librarian"]]); expect(f.compile().profiles).toEqual(["librarian"]);
    f.sources.length = 0; expect(f.compile).toThrow("coverage");
    const duplicates = fixture([["same"], ["same"]]); expect(duplicates.compile).toThrow("Duplicate");
  });
  test("private source requires a workload binding, not just an available token", () => {
    const f = fixture([["one"]]);
    f.plan.sources[0]!.private = true; f.plan.sources[0]!.credentialEnv = "SOURCE_TOKEN";
    expect(() => validatePlan(f.plan)).toThrow("workload Git Secret");
    f.plan.sources[0]!.agents[0]!.gitAuthSecretRef = "one-git-auth";
    expect(() => validatePlan(f.plan)).not.toThrow();
    expect(() => compileTeam(f.plan, f.root, f.sources, (s, a) => stringify({ spec: { sha: s.sha, source: s.definition.repository, sourceSubdir: a.subdir } }))).toThrow("not bound");
  });
  test("source requirements catch missing production sandbox and missing skill references", () => {
    const f = fixture([["one"]]), source = f.sources[0]!, agent = source.definition.agents[0]!;
    validateRuntimeSource(source, agent);
    const project = path.join(source.root, agent.subdir), pkg = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
    delete pkg.dependencies["just-bash"]; fs.writeFileSync(path.join(project, "package.json"), JSON.stringify(pkg));
    expect(() => validateRuntimeSource(source, agent)).toThrow("sandbox");
    pkg.dependencies["just-bash"] = versions.runtimes.eve.sandboxDependency; fs.writeFileSync(path.join(project, "package.json"), JSON.stringify(pkg));
    const skillDir = path.join(project, "agent/skills/reader"); fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "[missing](references/missing.md)");
    agent.skills.push({ path: "agent/skills/reader", revision: skillContentHash(skillDir), tools: [], files: [], executables: [], writes: [], scenario: "verify-one" });
    expect(() => validateRuntimeSource(source, agent)).toThrow();
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "changed package");
    expect(() => validateRuntimeSource(source, agent)).toThrow("SHA-256");
  });
});

describe("generated publication ownership", () => {
  test("repeat is a no-op and adding a second team preserves existing files and unrelated bootstrap", () => {
    const f = fixture([["first"], ["second"]]), destination = temp();
    fs.mkdirSync(path.join(destination, "bootstrap")); fs.writeFileSync(path.join(destination, "bootstrap/operator.yaml"), "preserve");
    const projection = f.compile();
    expect(stageProjection(destination, f.plan.id, projection).length).toBeGreaterThan(0);
    expect(stageProjection(destination, f.plan.id, projection)).toEqual([]);
    expect(fs.readFileSync(path.join(destination, "bootstrap/operator.yaml"), "utf8")).toBe("preserve");
    expect(fs.existsSync(path.join(destination, OWNERSHIP_FILE))).toBe(true);
  });
  test("rejects profiles-only publication and drift before changing any other file", () => {
    const f = fixture([["one"]]), destination = temp(), projection = f.compile();
    const broken = { ...projection, files: new Map(projection.files) };
    broken.files.delete("deployments/agents/one/deployment.yaml");
    expect(() => stageProjection(destination, f.plan.id, broken)).toThrow("No deployment");
    expect(fs.readdirSync(destination)).toEqual([]);
    stageProjection(destination, f.plan.id, projection);
    fs.writeFileSync(path.join(destination, "profiles/one/profile.yaml"), "manual repair");
    expect(() => stageProjection(destination, f.plan.id, projection)).toThrow("drift");
    expect(fs.readFileSync(path.join(destination, "profiles/one/profile.yaml"), "utf8")).toBe("manual repair");
  });
  test("refuses symlink escape and incomplete registry without changing siblings", () => {
    const f = fixture([["one"]]), destination = temp(), outside = temp();
    fs.symlinkSync(outside, path.join(destination, "deployments"));
    expect(() => stageProjection(destination, f.plan.id, f.compile())).toThrow("symbolic");
    expect(fs.readdirSync(outside)).toEqual([]);
    const other = temp(); fs.mkdirSync(path.join(other, "profiles/old"), { recursive: true }); fs.writeFileSync(path.join(other, "profiles/old/profile.yaml"), "keep");
    expect(() => stageProjection(other, f.plan.id, f.compile())).toThrow("Register existing profile");
  });
  test("only GitHub's specific base-change failure is retriable", () => {
    expect(transientMergeFailure(405, "Base branch was modified")).toBe(true);
    for (const status of [401, 403, 409, 422]) expect(transientMergeFailure(status, "Base branch was modified")).toBe(false);
    expect(transientMergeFailure(405, "Required status check missing")).toBe(false);
  });
  test("pending publication resumes without duplicate commits/PRs, and base-change retry never force pushes", async () => {
    const f = fixture([["one"]]), base = temp(), remote = path.join(base, "remote.git"), seed = path.join(base, "seed");
    const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    const git = (args: string[], cwd = base) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "--bare", "--initial-branch=main", remote]); git(["init", "--initial-branch=main", seed]);
    git(["commit", "--allow-empty", "-m", "initial"], seed); git(["remote", "add", "origin", remote], seed); git(["push", "origin", "main"], seed);
    f.plan.destination.repository = `file://${remote}`;
    const projection = f.compile();
    let created = 0, merges = 0, pr: any;
    const commands: string[][] = [];
    const exec: Run = async (...args) => { commands.push(args[0]); return run(...args); };
    const forge: Forge = { async request(method, route, body: any) {
      if (method === "GET") return pr ? [pr] : [];
      if (method === "POST") { created++; pr = { number: 1, html_url: "https://github.com/example/generated/pull/1" }; return pr; }
      merges++;
      if (merges === 1) {
        git(["commit", "--allow-empty", "-m", "concurrent writer"], seed); git(["push", "origin", "main"], seed);
        throw new ForgeFailure(405, true);
      }
      git(["--git-dir", remote, "update-ref", "refs/heads/main", body.sha]);
      return { merged: true, sha: body.sha };
    } };
    const beforePreview = git(["--git-dir", remote, "rev-parse", "main"]);
    const preview = await previewProjection(f.plan, projection, temp(), "fixture-token", exec);
    expect(preview.diff).toContain("deployments/agents/one/deployment.yaml");
    expect(git(["--git-dir", remote, "rev-parse", "main"])).toBe(beforePreview);
    f.plan.adoptRevision = "c".repeat(40);
    await expect(previewProjection(f.plan, projection, temp(), "fixture-token", exec)).rejects.toThrow("advanced");
    delete f.plan.adoptRevision;
    const first = await publishProjection(f.plan, projection, temp(), "fixture-token", exec, forge);
    expect(first.state).toBe("pending");
    const resumed = await publishProjection(f.plan, projection, temp(), "fixture-token", exec, forge);
    expect(resumed.revision).toBe(first.revision); expect(created).toBe(1);
    f.plan.destination.autoMerge = true;
    expect((await publishProjection(f.plan, projection, temp(), "fixture-token", exec, forge)).state).toBe("merged");
    expect(merges).toBe(2);
    expect(commands.flat()).not.toContain("--force");
    expect(commands.filter(c => c[1] === "commit")).toHaveLength(1);
    expect((await publishProjection(f.plan, projection, temp(), "fixture-token", exec, forge)).state).toBe("unchanged");
  });
  test("a merge that branch protection refuses is pending with its PR, never a failure", async () => {
    const f = fixture([["one"]]), base = temp(), remote = path.join(base, "remote.git"), seed = path.join(base, "seed");
    const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    const git = (args: string[], cwd = base) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "--bare", "--initial-branch=main", remote]); git(["init", "--initial-branch=main", seed]);
    git(["commit", "--allow-empty", "-m", "initial"], seed); git(["remote", "add", "origin", remote], seed); git(["push", "origin", "main"], seed);
    f.plan.destination.repository = `file://${remote}`;
    f.plan.destination.autoMerge = true;
    const projection = f.compile();
    let pr: any, answer: "refused" | "unmerged" = "refused";
    const forge: Forge = { async request(method, _route, _body: any) {
      if (method === "GET") return pr ? [pr] : [];
      if (method === "POST") { pr = { number: 2, html_url: "https://github.com/example/generated/pull/2" }; return pr; }
      if (answer === "refused") throw new ForgeFailure(405, false); // a required review or check
      return { merged: false };
    } };
    const refused = await publishProjection(f.plan, projection, temp(), "fixture-token", run, forge);
    expect(refused.state).toBe("pending");
    expect(refused.pullRequest).toBe("https://github.com/example/generated/pull/2");
    answer = "unmerged";
    const unmerged = await publishProjection(f.plan, projection, temp(), "fixture-token", run, forge);
    expect(unmerged.state).toBe("pending");
    expect(unmerged.revision).toBe(refused.revision);
  });
  test("a runtime pin reaches only that agent's values; an unpinned installation renders as before (ADR 0192)", () => {
    const f = fixture([["one", "two"]]);
    const before = f.compile();
    const plain = parse(String(before.files.get("deployments/agents/one/values.yaml")));
    expect(plain.runtimeImage).toEqual({ repository: "example/eve", digest: `sha256:${"a".repeat(64)}` });
    expect(effectiveRuntimeFacts(f.plan, f.plan.sources[0]!.agents[0]!)).toEqual({ runtimeDigest: f.plan.runtime.image, eveVersion: versions.runtimes.eve.version });
    // Canary exactly one agent.
    const pinned = { image: `example/eve@sha256:${"b".repeat(64)}`, eveVersion: "0.43.0" };
    f.plan.sources[0]!.agents[0]!.runtime = pinned;
    const after = f.compile();
    const canary = parse(String(after.files.get("deployments/agents/one/values.yaml")));
    expect(canary.runtimeImage).toEqual({ repository: "example/eve", digest: `sha256:${"b".repeat(64)}`, eveVersion: "0.43.0" });
    expect(effectiveRuntimeFacts(f.plan, f.plan.sources[0]!.agents[0]!)).toEqual({ runtimeDigest: pinned.image, eveVersion: "0.43.0", pinned: true });
    expect(isRuntimeCanary(f.plan, f.plan.sources[0]!.agents[0]!)).toBe(true);
    // Its neighbour is untouched: a canary moves one agent, not the installation.
    expect(String(after.files.get("deployments/agents/two/values.yaml"))).toBe(String(before.files.get("deployments/agents/two/values.yaml")));
    expect(isRuntimeCanary(f.plan, f.plan.sources[0]!.agents[1]!)).toBe(false);
  });
  test("a canary is checked and recovered against its own runtime, never the installation default", () => {
    const f = fixture([["one"]]);
    const agent = f.plan.sources[0]!.agents[0]!, source = f.sources[0]!;
    // The source lockfile must resolve the Eve the agent will actually deploy on.
    expect(() => validateRuntimeSource(source, agent)).not.toThrow();
    expect(() => validateRuntimeSource(source, agent, "0.43.0")).toThrow(/differs from the runtime it deploys on \(eve@0.43.0\)/);
    // Recovery knows the workload, not the agent: it must still resolve the canary's image.
    expect(workloadRuntimeImage(f.plan, "ag-eve-one")).toBe(f.plan.runtime.image);
    agent.runtime = { image: `example/eve@sha256:${"b".repeat(64)}`, eveVersion: "0.43.0" };
    expect(workloadRuntimeImage(f.plan, "ag-eve-one")).toBe(agent.runtime.image);
    expect(workloadRuntimeImage(f.plan, "ag-eve-unknown")).toBe(f.plan.runtime.image);
  });
  test("adoption permits a reviewed baseline but never a profile owned by another source", () => {
    const f = fixture([["one"]]), destination = temp(), projection = f.compile();
    fs.mkdirSync(path.join(destination, "profiles/one"), { recursive: true });
    fs.writeFileSync(path.join(destination, "profiles/one/profile.yaml"), stringify({ spec: { source: "https://github.com/another/owner" } }));
    expect(() => stageProjection(destination, f.plan.id, projection, true, true)).toThrow("another source");
    for (const source of ["github.com/example/team-0", "https://github.com/EXAMPLE/team-0.git/", "ssh://git@github.com/example/team-0.git", "git@github.com:example/team-0", "git@github.com:example/team-0\n"]) {
      fs.writeFileSync(path.join(destination, "profiles/one/profile.yaml"), stringify({ spec: { source } }));
      expect(() => stageProjection(destination, f.plan.id, projection, true, true)).not.toThrow();
    }
    for (const source of ["github:example/team-0", "https://github.com.evil.test/example/team-0", "https://github.com/example/team-0/extra", "https://github.com/example/team-0?repository=other"]) {
      fs.writeFileSync(path.join(destination, "profiles/one/profile.yaml"), stringify({ spec: { source } }));
      expect(() => stageProjection(destination, f.plan.id, projection, true, true)).toThrow("another source");
    }
  });
});

describe("stage evidence", () => {
  test("unknown blocks completion; resume re-observes prior results and revision changes invalidate evidence", async () => {
    const file = path.join(temp(), "state.json"); let ready = false; const calls: string[] = [];
    const operations = Object.fromEntries(STAGES.map(stage => [stage, {
      probe: async () => ({ verdict: "pass", summary: "authoritative readback" }),
      apply: async () => { calls.push(stage); return stage === "ready" && !ready ? { verdict: "unknown", summary: "not ready" } : { verdict: "pass", summary: "verified" }; },
    }])) as Record<Stage, StageOperation>;
    const first = await executeStages(file, readLedger(file, "test", "a"), operations);
    expect(first.complete).toBe(false); expect(first.stages.active).toBeUndefined();
    ready = true; calls.length = 0;
    const resumed = await executeStages(file, readLedger(file, "test", "a"), operations);
    expect(resumed.complete).toBe(true); expect(calls).not.toContain("published");
    const invalidated = readLedger(file, "test", "b");
    expect(invalidated.complete).toBe(false); expect(invalidated.stages).toEqual({}); expect(invalidated.history.length).toBeGreaterThan(0);
  });
  test("provider exceptions cannot leak credentials into the ledger", async () => {
    const file = path.join(temp(), "state.json");
    const operations = Object.fromEntries(STAGES.map(stage => [stage, { apply: async () => { throw new Error("token=do-not-persist"); } }])) as Record<Stage, StageOperation>;
    const ledger = await executeStages(file, readLedger(file, "test", "a"), operations);
    expect(ledger.complete).toBe(false); expect(fs.readFileSync(file, "utf8")).not.toContain("do-not-persist");
  });
});

describe("bounded recovery and private diagnostics", () => {
  function workspaceFixture() {
    const f = fixture([["one"]]); f.plan.authorizations.push("recover");
    const name = "ag-eve-one";
    const data = { metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } } };
    const spec = { replicas: 1, selector: { matchLabels: { agent: name } }, serviceName: name, volumeClaimTemplates: [data], template: { spec: {
      initContainers: [{ env: [{ name: "EVE_DIST_SHA", value: "a".repeat(40) }] }], containers: [{ name: "eve-agent", image: f.plan.runtime.image }],
    } } };
    const live = { metadata: { name, namespace: name, uid: "controller-id", resourceVersion: "123" }, spec: structuredClone(spec) };
    const desired = { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name }, spec: structuredClone(spec) };
    desired.spec.volumeClaimTemplates.push({ ...structuredClone(data), metadata: { name: "workspaces" } });
    const sources = [{ repoURL: "https://example.test/platform.git", targetRevision: "b".repeat(40) }];
    const application = { metadata: { name, namespace: "argocd", uid: "app-id" }, spec: { sources }, status: { operationState: { syncResult: { sources,
      resources: [{ kind: "StatefulSet", name, namespace: name, status: "SyncFailed", message: "Forbidden: updates to statefulset spec" }],
    } } } };
    const pod = { metadata: { name: `${name}-0`, namespace: name, uid: "pod-id", ownerReferences: [{ kind: "StatefulSet", uid: "controller-id" }] },
      spec: { volumes: [{ name: "data", persistentVolumeClaim: { claimName: `data-${name}-0` } }] }, status: { conditions: [{ type: "Ready", status: "True" }] } };
    const pvcs = { items: [{ metadata: { name: `data-${name}-0`, uid: "data-id" }, status: { phase: "Bound" } }] };
    return { f, live, desired, application, pod, pvcs };
  }
  test("first-workspace comparison preserves all existing immutable fields", () => {
    const { live, desired } = workspaceFixture();
    Object.assign(live.spec.volumeClaimTemplates[0]!, { apiVersion: "v1", kind: "PersistentVolumeClaim", status: { phase: "Pending" } });
    Object.assign(live.spec.volumeClaimTemplates[0]!.spec, { volumeMode: "Filesystem" });
    Object.assign(live.spec.volumeClaimTemplates[0]!.metadata, { creationTimestamp: null });
    expect(workspaceClaimAddition(live, desired)).toBe(true);
    for (const mutate of [
      (x: any) => { x.spec.volumeClaimTemplates[0].spec.resources.requests.storage = "20Gi"; },
      (x: any) => { x.spec.selector.matchLabels.agent = "another"; },
      (x: any) => { x.spec.serviceName = "another"; },
      (x: any) => { x.spec.volumeClaimTemplates.push(x.spec.volumeClaimTemplates[1]); },
      (x: any) => { x.spec.volumeClaimTemplates[1].metadata.name = "other"; },
      (x: any) => { x.spec.replicas = 2; },
      (x: any) => { x.spec.ordinals = { start: 1 }; },
    ]) { const changed = structuredClone(desired); mutate(changed); expect(workspaceClaimAddition(live, changed)).toBe(false); }
  });
  test("workspace recovery orphans only the preconditioned controller and records data retention", async () => {
    const { f, live, desired, application, pod, pvcs } = workspaceFixture();
    const state = temp(), calls: string[][] = [];
    const exec: Run = async argv => {
      calls.push(argv);
      if (argv.includes("manifests")) return stringify(desired);
      if (argv.includes("pvc")) return JSON.stringify(pvcs);
      if (argv.includes("application")) return JSON.stringify(application);
      const body = JSON.parse(fs.readFileSync(argv.at(-1)!, "utf8"));
      expect(body).toMatchObject({ propagationPolicy: "Orphan", preconditions: { uid: "controller-id", resourceVersion: "123" } });
      expect(argv).toContain("--raw=/apis/apps/v1/namespaces/ag-eve-one/statefulsets/ag-eve-one"); return "{}";
    };
    expect(await recoverWorkspaceClaim(f.plan, "a".repeat(40), pod, live, application, state, exec)).toBe(true);
    expect(await recoverWorkspaceClaim(f.plan, "a".repeat(40), pod, live, application, state, exec)).toBe(false);
    expect(calls.filter(c => c.includes("delete"))).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(state, fs.readdirSync(state)[0]!), "utf8"));
    expect(receipt).toMatchObject({ state: "accepted", dataClaimUid: "data-id", podUid: "pod-id" });
  });
  test("workspace recovery refuses unsafe or changed live evidence", async () => {
    for (const change of ["unapproved", "unhealthy", "wrong-sha", "wrong-image", "claim-change", "claim-exists", "unbound", "app-changed", "stale-operation"]) {
      const { f, live, desired, application, pod, pvcs } = workspaceFixture();
      if (change === "unapproved") f.plan.authorizations = [];
      if (change === "unhealthy") pod.status.conditions[0]!.status = "False";
      if (change === "wrong-sha") desired.spec.template.spec.initContainers[0]!.env[0]!.value = "c".repeat(40);
      if (change === "wrong-image") desired.spec.template.spec.containers[0]!.image = "unpinned:latest";
      if (change === "claim-change") desired.spec.volumeClaimTemplates[0]!.spec.resources.requests.storage = "30Gi";
      if (change === "claim-exists") pvcs.items.push({ metadata: { name: "workspaces-ag-eve-one-0", uid: "other" }, status: { phase: "Bound" } });
      if (change === "unbound") pvcs.items[0]!.status.phase = "Pending";
      if (change === "stale-operation") application.status.operationState.syncResult.sources = [];
      const exec: Run = async argv => {
        expect(argv).not.toContain("delete");
        if (argv.includes("manifests")) return stringify(desired);
        if (argv.includes("pvc")) return JSON.stringify(pvcs);
        const current = structuredClone(application);
        if (change === "app-changed") current.spec.sources = [];
        return JSON.stringify(current);
      };
      expect(await recoverWorkspaceClaim(f.plan, "a".repeat(40), pod, live, application, temp(), exec)).toBe(false);
    }
  });
  test("workspace recovery retries an unaccepted delete only against fresh verified identities", async () => {
    const { f, live, desired, application, pod, pvcs } = workspaceFixture();
    const state = temp(); let deletes = 0;
    const exec: Run = async argv => {
      if (argv.includes("manifests")) return stringify(desired);
      if (argv.includes("pvc")) return JSON.stringify(pvcs);
      if (argv.includes("application")) return JSON.stringify(application);
      deletes++;
      if (deletes === 1) throw new Error("resourceVersion conflict");
      expect(JSON.parse(fs.readFileSync(argv.at(-1)!, "utf8")).preconditions.resourceVersion).toBe("124");
      return "{}";
    };
    await expect(recoverWorkspaceClaim(f.plan, "a".repeat(40), pod, live, application, state, exec)).rejects.toThrow("conflict");
    live.metadata.resourceVersion = "124";
    expect(await recoverWorkspaceClaim(f.plan, "a".repeat(40), pod, live, application, state, exec)).toBe(true);
    expect(deletes).toBe(2);
    expect(await recoverWorkspaceClaim(f.plan, "a".repeat(40), pod, live, application, state, exec)).toBe(false);
  });
  test("verified stale workspace sync is terminated with identity tests before any controller deletion", async () => {
    const { f, live, desired, application, pod, pvcs } = workspaceFixture();
    Object.assign(application.metadata, { resourceVersion: "789" });
    Object.assign(application, { operation: { sync: {} } });
    Object.assign(application.status.operationState, { phase: "Running", startedAt: "2026-09-10T00:00:00Z" });
    application.status.operationState.syncResult.sources = [{ repoURL: "https://example.test/old.git", targetRevision: "main" }];
    const state = temp(); let patches = 0;
    const exec: Run = async argv => {
      expect(argv).not.toContain("delete");
      if (argv.includes("manifests")) return stringify(desired);
      if (argv.includes("pvc")) return JSON.stringify(pvcs);
      if (argv.includes("patch")) {
        patches++;
        const body = JSON.parse(fs.readFileSync(argv[argv.indexOf("--patch-file") + 1]!, "utf8"));
        expect(body).toContainEqual({ op: "test", path: "/metadata/uid", value: "app-id" });
        expect(body).toContainEqual({ op: "test", path: "/metadata/resourceVersion", value: "789" });
        expect(body.at(-1)).toEqual({ op: "replace", path: "/status/operationState/phase", value: "Terminating" });
        return "application.argoproj.io/ag-eve-one";
      }
      return JSON.stringify(application);
    };
    expect(await recoverWorkspaceClaim(f.plan, "a".repeat(40), pod, live, application, state, exec)).toBe(true);
    expect(await recoverWorkspaceClaim(f.plan, "a".repeat(40), pod, live, application, state, exec)).toBe(false);
    expect(patches).toBe(1);
  });
  test("only the recorded adopted pod can roll after workspace controller migration", async () => {
    for (const change of ["none", "no-receipt", "unaccepted", "different-pod", "different-data", "pod-owned-data", "missing-workspace", "changed-desired", "already-current", "unapproved"]) {
      const { f, live, desired, application, pod, pvcs } = workspaceFixture();
      const state = temp(); let deletes = 0;
      live.metadata.uid = "new-controller";
      live.spec = structuredClone(desired.spec);
      Object.assign(live, { status: { updateRevision: "new-revision" } });
      pod.metadata.ownerReferences[0]!.uid = "new-controller";
      Object.assign(pod.metadata, { resourceVersion: "456", labels: { "controller-revision-hash": "old-revision" } });
      Object.assign(application.status, { sync: { status: "Synced" } });
      Object.assign(pvcs.items[0]!.metadata, { ownerReferences: [{ kind: "StatefulSet", uid: "new-controller" }] });
      pvcs.items.push({ metadata: { name: "workspaces-ag-eve-one-0", uid: "workspace-id" }, status: { phase: "Pending" } });
      Object.assign(pvcs.items[1]!.metadata, { ownerReferences: [{ kind: "StatefulSet", uid: "new-controller" }] });
      const prior = { state: "accepted", name: "ag-eve-one", namespace: "ag-eve-one", controllerUid: "controller-id", podUid: "pod-id",
        dataClaim: "data-ag-eve-one-0", dataClaimUid: "data-id", desiredHash: digest(desired.spec) };
      if (change === "unaccepted") prior.state = "requested";
      if (change !== "no-receipt") fs.writeFileSync(path.join(state, `workspace-recovery-${"a".repeat(64)}.json`), JSON.stringify(prior));
      if (change === "different-pod") pod.metadata.uid = "another-pod";
      if (change === "different-data") pvcs.items[0]!.metadata.uid = "another-data";
      if (change === "pod-owned-data") Object.assign(pvcs.items[0]!.metadata, { ownerReferences: [{ kind: "Pod", uid: "pod-id" }] });
      if (change === "missing-workspace") pvcs.items.pop();
      if (change === "changed-desired") desired.spec.volumeClaimTemplates[0]!.spec.resources.requests.storage = "30Gi";
      if (change === "already-current") Object.assign(pod.metadata, { labels: { "controller-revision-hash": "new-revision" } });
      if (change === "unapproved") f.plan.authorizations = [];
      const exec: Run = async argv => {
        if (argv.includes("manifests")) return stringify(desired);
        if (argv.includes("pvc")) return JSON.stringify(pvcs);
        if (argv.includes("application")) return JSON.stringify(application);
        deletes++;
        expect(change).toBe("none");
        expect(argv).toContain("--raw=/api/v1/namespaces/ag-eve-one/pods/ag-eve-one-0");
        expect(JSON.parse(fs.readFileSync(argv.at(-1)!, "utf8"))).toEqual({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background", preconditions: { uid: "pod-id", resourceVersion: "456" } });
        return "{}";
      };
      expect(await recoverWorkspacePod(f.plan, "a".repeat(40), pod, live, application, state, exec)).toBe(change === "none");
      if (change === "none") expect(await recoverWorkspacePod(f.plan, "a".repeat(40), pod, live, application, state, exec)).toBe(false);
      if (change === "pod-owned-data") {
        pod.status.conditions[0]!.status = "False";
        Object.assign(pod.status, { containerStatuses: [{ state: { waiting: { reason: "CrashLoopBackOff" } } }] });
        expect(failedOldPod(pod, live)).toBe(true);
        expect(await recoverOldPod(f.plan, pod, live, state, exec)).toBe(false);
      }
      expect(deletes).toBe(change === "none" ? 1 : 0);
    }
  });
  test("missing recorded controllers get only a pinned selective Argo sync", async () => {
    for (const change of ["none", "controller-exists", "no-receipt", "different-data", "changed-desired", "running-operation", "unresolved-revision", "owned-pod"]) {
      const { f, desired, application, pod, pvcs } = workspaceFixture();
      const state = temp(); let patches = 0;
      pod.metadata.ownerReferences = [];
      Object.assign(application.metadata, { resourceVersion: "987" });
      Object.assign(application.status, { sync: { comparedTo: { sources: application.spec.sources }, revisions: ["b".repeat(40)] } });
      Object.assign(application.status.operationState, { phase: "Failed" });
      const prior = { state: "accepted", name: "ag-eve-one", namespace: "ag-eve-one", controllerUid: "controller-id", podUid: "pod-id", dataClaim: "data-ag-eve-one-0", dataClaimUid: "data-id", desiredHash: digest(desired.spec) };
      if (change !== "no-receipt") fs.writeFileSync(path.join(state, `workspace-recovery-${"a".repeat(64)}.json`), JSON.stringify(prior));
      if (change === "different-data") pvcs.items[0]!.metadata.uid = "different-data";
      if (change === "changed-desired") desired.spec.volumeClaimTemplates[0]!.spec.resources.requests.storage = "30Gi";
      if (change === "running-operation") Object.assign(application, { operation: { sync: {} } });
      if (change === "unresolved-revision") Object.assign(application.status, { sync: { comparedTo: { sources: application.spec.sources }, revisions: ["main"] } });
      if (change === "owned-pod") {
        pod.metadata.ownerReferences.push({ kind: "StatefulSet", uid: "other" });
        Object.assign(pod.metadata.ownerReferences[0]!, { controller: true });
      }
      const exec: Run = async argv => {
        if (argv.includes("statefulset") && argv.includes("get")) return change === "controller-exists" ? "{}" : "";
        if (argv.includes("manifests")) { expect(argv).toContain("--revisions"); expect(argv).toContain("b".repeat(40)); return stringify(desired); }
        if (argv.includes("pvc")) return JSON.stringify(pvcs.items[0]);
        if (argv.includes("patch")) {
          patches++; expect(change).toBe("none");
          const patch = JSON.parse(fs.readFileSync(argv[argv.indexOf("--patch-file") + 1]!, "utf8"));
          expect(patch[0]).toEqual({ op: "test", path: "/metadata/uid", value: "app-id" });
          expect(patch[1]).toEqual({ op: "test", path: "/metadata/resourceVersion", value: "987" });
          expect(patch[2].value.sync).toMatchObject({ prune: false, revisions: ["b".repeat(40)], resources: [{ group: "apps", kind: "StatefulSet", name: "ag-eve-one", namespace: "ag-eve-one" }] });
          return "application.argoproj.io/ag-eve-one";
        }
        return JSON.stringify(application);
      };
      expect(await resumeWorkspaceController(f.plan, "a".repeat(40), pod, state, exec)).toBe(change === "none");
      if (change === "none") expect(await resumeWorkspaceController(f.plan, "a".repeat(40), pod, state, exec)).toBe(false);
      expect(patches).toBe(change === "none" ? 1 : 0);
    }
  });
  test("only failed obsolete pods can be recovered, once, with a UID precondition", async () => {
    const f = fixture([["one"]]); f.plan.authorizations.push("recover");
    const workload = { metadata: { uid: "controller-id" }, status: { updateRevision: "new-revision" } };
    const pod = { metadata: { name: "ag-eve-one-0", namespace: "ag-eve-one", uid: "old-uid", labels: { "controller-revision-hash": "old-revision" }, ownerReferences: [{ uid: "controller-id", kind: "StatefulSet" }] }, status: { containerStatuses: [{ state: { waiting: { reason: "CrashLoopBackOff" } } }] } };
    expect(failedOldPod(pod, workload)).toBe(true);
    const calls: string[][] = [];
    const exec: Run = async argv => {
      calls.push(argv);
      const body = JSON.parse(fs.readFileSync(argv[argv.length - 1]!, "utf8"));
      expect(body.preconditions.uid).toBe("old-uid");
      expect(argv.join(" ")).not.toContain("--force"); return "{}";
    };
    const state = temp(); expect(await recoverOldPod(f.plan, pod, workload, state, exec)).toBe(true);
    expect(await recoverOldPod(f.plan, pod, workload, state, exec)).toBe(false); expect(calls).toHaveLength(1);
    pod.metadata.labels["controller-revision-hash"] = "new-revision";
    expect(failedOldPod(pod, workload)).toBe(false);
    pod.metadata.labels["controller-revision-hash"] = "old-revision";
    (pod.status as any).conditions = [{ type: "Ready", status: "True" }];
    expect(failedOldPod(pod, workload)).toBe(false);
  });
  test("subprocess diagnostics scrub secret inputs and keep files private", async () => {
    const diagnostics = temp();
    await expect(run([process.execPath, "-e", "console.error(process.env.TEST_TOKEN); process.exit(3)"], diagnostics,
      { ...process.env, TEST_TOKEN: "private-fixture-credential", HG_TEAM_DIAGNOSTICS_DIR: diagnostics })).rejects.toThrow("diagnostics:");
    const files = fs.readdirSync(diagnostics); expect(files).toHaveLength(1);
    const file = path.join(diagnostics, files[0]!);
    expect(fs.readFileSync(file, "utf8")).not.toContain("private-fixture-credential");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  test("plan-declared credential names are scrubbed whatever they are called", async () => {
    const f = fixture([["one"]]);
    f.plan.sources[0]!.agents[0]!.environment.push("POSTIZ_ACCESS");
    for (const name of secretEnvironmentNames(f.plan)) declaredSecrets.add(name);
    expect(declaredSecrets.has("POSTIZ_ACCESS")).toBe(true);
    const diagnostics = temp();
    await expect(run([process.execPath, "-e", "console.error('startup: ' + process.env.POSTIZ_ACCESS + ' ' + process.env.OPENAI_API_KEY); process.exit(3)"], diagnostics,
      { ...process.env, POSTIZ_ACCESS: "declared-fixture-value", OPENAI_API_KEY: "conventional-fixture-value", HG_TEAM_DIAGNOSTICS_DIR: diagnostics })).rejects.toThrow("diagnostics:");
    const text = fs.readFileSync(path.join(diagnostics, fs.readdirSync(diagnostics)[0]!), "utf8");
    expect(text).not.toContain("declared-fixture-value");
    expect(text).not.toContain("conventional-fixture-value");
  });
});


describe("activation preservation", () => {
  test("provisioning keeps existing baseline and previously applied gates enabled", () => {
    const baseline = { config: { "factory:agents": { manager: { enabled: true }, newcomer: { enabled: false } } } };
    expect(provisioningGate(baseline, "factory:agents.manager.enabled")).toBe(true);
    expect(provisioningGate(baseline, "factory:agents.newcomer.enabled")).toBe(false);
    expect(provisioningGate(baseline, "factory:agents.newcomer.enabled", true)).toBe(true);
    expect(provisioningGate(baseline, "factory:agents.third.enabled")).toBe(false);
    expect(() => provisioningGate({ config: { "factory:agents": { secure: "ciphertext" } } }, "factory:agents.manager.enabled")).toThrow("encrypted");
  });
  test("removing an owned profile refuses before touching its workload or data", () => {
    const f = fixture([["one", "two"]]), destination = temp();
    stageProjection(destination, f.plan.id, f.compile());
    const reduced = f.compile();
    reduced.files.delete("profiles/two/profile.yaml");
    expect(() => stageProjection(destination, f.plan.id, reduced)).toThrow("Register existing profile two");
    expect(fs.existsSync(path.join(destination, "deployments/agents/two/deployment.yaml"))).toBe(true);

  });
});

test("credential changes invalidate evidence even outside the runtime environment list", () => {
  const { plan } = fixture([["one"]]);
  plan.credentials = { configFile: "config.yaml", bindings: { PRIVATE_GIT: "factory:git.token" } };
  plan.sources[0]!.agents[0]!.slack = { url: "https://slack.example/events", signingSecretEnv: "SIGNING" };
  const before = credentialFingerprint(plan, { PRIVATE_GIT: "first", SIGNING: "first" });
  expect(credentialFingerprint(plan, { PRIVATE_GIT: "second", SIGNING: "first" })).not.toBe(before);
  expect(credentialFingerprint(plan, { PRIVATE_GIT: "first", SIGNING: "second" })).not.toBe(before);
  expect(credentialFingerprint(plan, { PRIVATE_GIT: "first", SIGNING: "first", UNRELATED: "changed" })).toBe(before);
});

// Exercises the shipped emitter rather than the synthetic renderer used by pure compiler tests.
test("complete projection accepts actual scaffold records from the production emitter", async () => {
  const f = fixture([["one"]]);
  const output = await compileResolved(f.plan, f.root, f.sources);
  const record = parse(String(output.files.get("profiles/one/profile.yaml")));
  expect(record.spec.sha).toBe(f.sources[0]!.sha);
  expect(record.spec.sourceSubdir).toBe("agents/eve/one/src");
  expect(output.files.has("deployments/agents/one/deployment.yaml")).toBe(true);
  expect(JSON.parse(String(output.files.get("deployments/dashboard/sources.json")))).toMatchObject({ version: 1, sources: [{ id: "team-0" }] });
}, 30_000);


test("Argo core manifests use mounted identity and clean temporary config after success or failure", async () => {
  const { root, plan } = fixture();
  const executable = path.join(root, "argocd");
  fs.writeFileSync(executable, `#!/bin/sh
set -eu
stat -c %a "$KUBECONFIG" > "$HG_PROBE_ROOT/mode"
printf '%s' "$KUBECONFIG" > "$HG_PROBE_ROOT/path"
cat "$KUBECONFIG" > "$HG_PROBE_ROOT/config"
printf '%s\\n' "$@" > "$HG_PROBE_ROOT/args"
exit "$HG_PROBE_EXIT"
`, { mode: 0o700 });
  for (const code of ["0", "7"]) {
    const exec: Run = async (argv, _cwd, _env, _timeout, input) => {
      expect(argv.slice(0, 9)).toEqual(["kubectl", "--context", plan.kubeContext, "-n", "argocd", "exec", "-i", "statefulset/argocd-application-controller", "--"]);
      return execFileSync(argv[9]!, argv.slice(10), { input, encoding: "utf8", env: {
        ...process.env, PATH: `${root}:${process.env.PATH}`, HG_PROBE_ROOT: root, HG_PROBE_EXIT: code,
      } });
    };
    const query = argoDesiredManifests(plan, "ag-eve-manager", root, exec, ["a".repeat(40)]);
    if (code === "0") await query; else await expect(query).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, "mode"), "utf8").trim()).toBe("600");
    expect(fs.existsSync(fs.readFileSync(path.join(root, "path"), "utf8"))).toBe(false);
    const config = JSON.parse(fs.readFileSync(path.join(root, "config"), "utf8"));
    expect(config.users[0].user).toEqual({ tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token" });
    expect(config.clusters[0].cluster).toEqual({ server: "https://kubernetes.default.svc", "certificate-authority": "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt" });
    expect(config.contexts[0].context.namespace).toBe("argocd");
    expect(fs.readFileSync(path.join(root, "args"), "utf8")).toContain(`--revisions\n${"a".repeat(40)}\n--source-positions\n1`);
  }
});

describe("unattended resume (ADR 0191)", () => {
  test("the halted stage and exit code follow the ledger: 0 complete, 75 pending, 1 failed", async () => {
    const { haltedStage, unattendedExitCode } = await import("../src/team/command.ts");
    const pass = { verdict: "pass" as const, summary: "ok" };
    expect(haltedStage({ validated: pass, "runtime-verified": pass })).toBeUndefined();
    expect(unattendedExitCode(true)).toBe(0);
    const pendingLedger = { validated: pass, published: { verdict: "unknown" as const, summary: "PR", pending: { reason: "merge-pending" as const, link: "https://example/pr/1" } } };
    const halted = haltedStage(pendingLedger)!;
    expect(halted.stage).toBe("published");
    expect(halted.evidence.pending?.reason).toBe("merge-pending");
    expect(unattendedExitCode(false, halted)).toBe(75);
    expect(unattendedExitCode(false, haltedStage({ validated: pass, provisioned: { verdict: "fail" as const, summary: "boom" } }))).toBe(1);
    // An unknown that names nothing to wait for is not pending: nobody can act on it by waiting.
    expect(unattendedExitCode(false, haltedStage({ validated: pass, "transport-verified": { verdict: "unknown" as const, summary: "?" } }))).toBe(1);
    // Order is the stage order, not insertion order.
    expect(haltedStage({ ready: { verdict: "unknown" as const, summary: "later" }, validated: { verdict: "fail" as const, summary: "first" } })!.stage).toBe("validated");
  });

  test("a missing approval is an ApprovalRequired the watcher maps to pending; attended it is still an error", async () => {
    const { ApprovalRequired } = await import("../src/lib.ts");
    const { requireApproval } = await import("../src/skills/contract.ts");
    const file = path.join(temp(), "approvals.yaml");
    fs.writeFileSync(file, "apiVersion: hermes-gitops.factorylevel.dev/agent-skills/v1alpha1\nkind: SkillApprovals\napprovals: []\n");
    let caught: unknown;
    try { requireApproval(file, "https://github.com/example/team#one", "a".repeat(64)); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ApprovalRequired);
    expect((caught as InstanceType<typeof ApprovalRequired>).subject).toBe("https://github.com/example/team#one");
    expect((caught as InstanceType<typeof ApprovalRequired>).fingerprint).toBe("a".repeat(64));
    expect((caught as Error).message).toContain("Human skill approval required");
  });

  test("write acceptance scenarios opt into unattended runs explicitly", () => {
    const f = fixture([["one"]]);
    f.plan.acceptance[0]!.unattended = true;
    expect(() => validatePlan(f.plan)).toThrow(/write scenarios only/);
    f.plan.acceptance[0]!.effect = "write";
    expect(() => validatePlan(f.plan)).not.toThrow();
    (f.plan.acceptance[0] as any).unattended = "yes";
    expect(() => validatePlan(f.plan)).toThrow(/must be a boolean/);
  });

  test("--unattended is refused for anything but resume, and for a version 1 plan", async () => {
    const { cmdTeam } = await import("../src/team/command.ts");
    const f = fixture([["one"]]);
    const planFile = path.join(f.root, "installation.yaml");
    fs.writeFileSync(planFile, stringify(f.plan));
    await expect(cmdTeam(true, ["apply"], { plan: "installation.yaml", root: f.root, unattended: true })).rejects.toThrow(/applies to team resume only/);
    await expect(cmdTeam(true, ["resume"], { plan: "installation.yaml", root: f.root, unattended: true })).rejects.toThrow(/version 2/);
  });
});

describe("the credential gate (ADR 0196)", () => {
  // The whole unattended path up to rendering runs for real: a local source repository behind the
  // plan's URL, a compiled lock, the production emitter. Only the delivery of the one required
  // secret the scaffold declares is missing.
  test("an unattended resume whose rendered agent requires an undelivered secret halts at validated with exit 1 and names it", async () => {
    const { cmdTeam } = await import("../src/team/command.ts");
    const { HG_HOME, CliError } = await import("../src/lib.ts");
    const { compileLock, lockPath, renderLock, writeLockFile } = await import("../src/team/lock.ts");
    const f = fixture([["one"]]), source = f.sources[0]!;
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: source.root, encoding: "utf8", env: gitEnv }).trim();
    git("init", "-q", "-b", "main"); git("config", "uploadpack.allowReachableSHA1InWant", "true");
    git("add", "-A"); git("commit", "-q", "-m", "source");
    const sha = git("rev-parse", "HEAD");
    const id = `credential-gate-${Date.now().toString(36)}`;
    Object.assign(f.plan, { id, version: 2, lock: "installation.lock.yaml" });
    source.definition.ref = sha;
    fs.writeFileSync(path.join(f.root, "installation.yaml"), stringify(f.plan));
    writeLockFile(lockPath(f.root, "installation.lock.yaml"), renderLock(await compileLock(f.plan, async () => sha)));
    const gitConfig = path.join(f.root, "gitconfig");
    fs.writeFileSync(gitConfig, `[url "${source.root}"]\n\tinsteadOf = ${source.definition.repository}\n`);
    const stateRoot = path.join(HG_HOME, "teams", id);
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, HG_TEAM_LOCK: process.env.HG_TEAM_LOCK, HG_TEAM_DIAGNOSTICS_DIR: process.env.HG_TEAM_DIAGNOSTICS_DIR };
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    process.env.HG_TEAM_LOCK = path.join(stateRoot, "lock"); // run in-process, as the locked child does
    const out: string[] = [], err: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
    let thrown: unknown;
    try {
      await cmdTeam(true, ["resume"], { plan: "installation.yaml", root: f.root, unattended: true });
    } catch (caught) {
      thrown = caught;
    } finally {
      console.log = log; console.error = error;
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as InstanceType<typeof CliError>).exitCode).toBe(1);
    const document = JSON.parse(out.at(-1)!);
    expect(document.report.stage).toBe("validated");
    expect(document.report.findings).toEqual([expect.objectContaining({
      kind: "undelivered", envNames: ["ANTHROPIC_API_KEY"], pulumiPath: "hermes-gitops-bootstrap:agentSecrets.one.ANTHROPIC_API_KEY",
      agentFile: "team-0:agents/eve/one/harness-hg/agent.yaml",
    })]);
    const failed = document.history.at(-1);
    expect(failed).toMatchObject({ stage: "validated", verdict: "fail" });
    expect(failed.summary).toContain("ANTHROPIC_API_KEY");
    expect(failed.summary).toContain("credentials.bindings");
    expect(err.join("\n")).toContain("hermes-gitops-bootstrap:agentSecrets.one.ANTHROPIC_API_KEY");
  }, 90_000);
});
