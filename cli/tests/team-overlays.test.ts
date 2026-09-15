import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify, parse } from "yaml";
import { scaffoldBundle } from "../src/agent-bundle/scaffold.ts";
import type { ResolvedSource } from "../src/team/compiler.ts";
import { secretEnvironmentNames, validatePlan, type OverlayDeclaration, type TeamPlan, type TeamSource } from "../src/team/plan.ts";
import { compileResolved } from "../src/team/command.ts";
import { validateRuntimeSource } from "../src/team/runtime.ts";
import { SKILL_API, dump, fingerprint, skillContentHash } from "../src/skills/contract.ts";
import type { FetchSkill } from "../src/skills/install.ts";
import { approveOverlayReview, overlaidRuntime, overlayMerge, resolveAgentOverlays, stageOverlayReview, templateOverlayDigest, verifyOverlayApproval } from "../src/team/overlays.ts";
import versions from "../../versions.json";

const temporary: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-overlays-test-")); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const COMMIT = "9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const VOICE: OverlayDeclaration = { id: "voice", kind: "skill", mode: "append", target: "agent/skills/voice",
  source: { repository: "https://github.com/example/overlays", commit: COMMIT, path: "skills/voice" },
  skill: { tools: [], executables: [], writes: [], scenario: "verify-one" } };
const NO_BASH: OverlayDeclaration = { id: "no-bash", kind: "tool", mode: "remove", target: "agent/tools/bash.ts" };
const VOICE_SKILL = "---\ndescription: The brand voice.\n---\n# Voice\n";

function fixture(overlays: OverlayDeclaration[] = [VOICE, NO_BASH]) {
  const root = temp();
  write(path.join(root, "environment.yaml"), stringify({ version: 1, layout: "single", sovereignty: { mode: "permissive" }, regions: [{ name: "local", jurisdiction: "local", targets: [{ name: "local", argoDestination: "in-cluster", primary: true }] }] }));
  const sourceRoot = path.join(root, "team-0");
  scaffoldBundle({ dir: sourceRoot, team: "team-0", agents: [{ name: "one", harness: "eve" }], gitopsRepoUrl: "https://github.com/example/generated" });
  write(path.join(sourceRoot, "agents/eve/one/src/package-lock.json"), JSON.stringify({ packages: { "node_modules/eve": { version: versions.runtimes.eve.version }, "node_modules/just-bash": { version: versions.runtimes.eve.sandboxDependency } } }));
  const definition: TeamSource = { id: "team-0", repository: "https://github.com/example/team-0", ref: "main", private: false, skillPolicy: { approvals: "approvals.yaml" },
    agents: [{ name: "one", subdir: "agents/eve/one/src", environment: [], tools: ["bash"], writablePaths: ["/workspace"], skills: [], overlays }] };
  const plan: TeamPlan = { version: 1, id: "factory", sources: [definition],
    destination: { repository: "https://github.com/example/generated", branch: "main", credentialEnv: "GITOPS_TOKEN", autoMerge: false },
    environment: "environment.yaml", argoDestinations: ["in-cluster"], bootstrap: { directory: "infra", stack: "test" }, kubeContext: "test",
    runtime: { image: `example/eve@sha256:${"a".repeat(64)}`, platform: "linux/amd64" }, authorizations: [],
    acceptance: [{ id: "verify-one", source: "team-0", agent: "one", argv: ["node", "verify.mjs"], effect: "read" }] };
  const source: ResolvedSource = { root: sourceRoot, sha: "a".repeat(40), definition };
  return { root, plan, definition, source, agent: definition.agents[0]! };
}
function fetchWith(files: Record<string, string>, commit = COMMIT): FetchSkill {
  return async (_repository, _ref, checkout) => {
    for (const [relative, text] of Object.entries(files)) write(path.join(checkout, relative), text);
    return commit;
  };
}

describe("installation plan overlays", () => {
  test("validate shape, privacy, approval policy and skill acceptance", () => {
    expect(() => validatePlan(fixture().plan)).not.toThrow();
    const noPolicy = fixture();
    delete noPolicy.definition.skillPolicy;
    expect(() => validatePlan(noPolicy.plan)).toThrow(/need skillPolicy.approvals/);
    const bad = (overlay: OverlayDeclaration, message: RegExp) => expect(() => validatePlan(fixture([overlay]).plan)).toThrow(message);
    bad({ ...VOICE, source: { ...VOICE.source!, commit: "9b1c2d3" } }, /40-character commit/);
    bad({ ...VOICE, source: { ...VOICE.source!, repository: "https://user:token@github.com/example/overlays" } }, /credential-free/);
    bad({ ...VOICE, source: { ...VOICE.source!, credentialEnv: "OVERLAY_TOKEN" } }, /needs both credentialEnv/);
    bad({ ...VOICE, skill: { ...VOICE.skill!, scenario: "nowhere" } }, /missing acceptance scenario for skill overlay voice/);
    bad({ ...NO_BASH, source: VOICE.source }, /removal carries no source/);
    bad({ ...NO_BASH, target: "tools/bash.ts" }, /path under agent/);
    const shared = fixture([]);
    shared.definition.overlays = [NO_BASH, NO_BASH];
    expect(() => validatePlan(shared.plan)).toThrow(/unique DNS labels/);
    const secret = fixture([{ ...VOICE, source: { ...VOICE.source!, credentialEnv: "OVERLAY_TOKEN", gitAuthSecretRef: "overlay-git" } }]);
    expect(() => validatePlan(secret.plan)).not.toThrow();
    expect(secretEnvironmentNames(secret.plan).has("OVERLAY_TOKEN")).toBe(true);
  });
});

describe("resolving overlays", () => {
  test("fetch, hash and merge into a copy with the build container's implementation", async () => {
    const f = fixture();
    const resolved = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
    const merge = await overlayMerge();
    expect(resolved.overlays).toEqual([
      { id: "voice", kind: "skill", mode: "append", target: "agent/skills/voice", source: { repository: VOICE.source!.repository, commit: COMMIT, path: "skills/voice" }, contentHash: resolved.overlays[0]!.contentHash },
      { id: "no-bash", kind: "tool", mode: "remove", target: "agent/tools/bash.ts" },
    ]);
    expect(resolved.overlays[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(resolved.project, "agent/skills/voice/SKILL.md"), "utf8")).toBe(VOICE_SKILL);
    expect(fs.readFileSync(path.join(resolved.project, "agent/tools/bash.ts"), "utf8")).toContain("disableTool()");
    expect(fs.existsSync(path.join(f.source.root, "agents/eve/one/src/agent/skills/voice"))).toBe(false);
    expect(resolved.digest).toBe(merge.overlayDigest(resolved.overlays, resolved.treeHash));
    expect(merge.contentHash(path.join(resolved.project, "agent"))).toBe(resolved.treeHash);
    expect(resolved.requirements).toEqual([{ path: "agent/skills/voice", revision: skillContentHash(path.join(resolved.project, "agent/skills/voice")), tools: [], files: [], executables: [], writes: [], scenario: "verify-one" }]);
    const view = overlaidRuntime(f.source, f.agent, resolved);
    expect(() => validateRuntimeSource(view.source, view.agent)).not.toThrow();
    expect(() => validateRuntimeSource({ ...f.source, root: resolved.mergedRoot }, f.agent)).toThrow(/no capability declaration/);
  });

  test("approval binds overlay content, not the team's source commit", async () => {
    const f = fixture();
    const first = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
    const release = (await resolveAgentOverlays({ ...f.source, sha: "b".repeat(40) }, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
    const changed = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": `${VOICE_SKILL}Say less.\n` })))!;
    expect(release.fingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(first.subject).toBe("https://github.com/example/team-0#one#overlays");
  });

  test("a fetch that returns another commit, or a manifest-owned skill override, refuses", async () => {
    const f = fixture();
    await expect(resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL }, "c".repeat(40)))).rejects.toThrow(/not the pinned/);
    const owned = fixture([{ ...VOICE, id: "drafting", mode: "override", target: "agent/skills/drafting" }]);
    const project = path.join(owned.source.root, "agents/eve/one/src");
    const manifest = { apiVersion: SKILL_API, kind: "AgentSkills", skills: [{ name: "drafting",
      source: { repository: "https://github.com/example/skills", root: ".", entrypoint: "SKILL.md", ref: { tag: "v1.0.0" } },
      resources: [], tools: [], executables: [], writes: [], scenario: "verify-one" }] };
    write(path.join(project, "agent/skills/drafting/SKILL.md"), "---\ndescription: Draft posts.\n---\n");
    write(path.join(owned.source.root, "agents/eve/one/harness-hg/skills.yaml"), dump(manifest));
    write(path.join(owned.source.root, "agents/eve/one/harness-hg/skills.lock.yaml"), dump({ apiVersion: SKILL_API, kind: "AgentSkillsLock", manifest: fingerprint(manifest),
      skills: [{ name: "drafting", source: manifest.skills[0]!.source, commit: "d".repeat(40), hash: skillContentHash(path.join(project, "agent/skills/drafting")) }] }));
    await expect(resolveAgentOverlays(owned.source, owned.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL }))).rejects.toThrow(/skill manifest/);
  });
});

describe("review-driven overlay rules", () => {
  test("a flat markdown skill overlay cannot require executables", async () => {
    const flat = fixture([{ ...VOICE, target: "agent/skills/voice.md", source: { ...VOICE.source!, path: "voice.md" }, skill: { ...VOICE.skill!, executables: ["ffmpeg"] } }]);
    await expect(resolveAgentOverlays(flat.source, flat.agent, temp(), fetchWith({ "voice.md": "Speak plainly." }))).rejects.toThrow(/cannot require executables/);
  });

  test("overriding or removing a declared local skill reconciles the merged runtime view", async () => {
    for (const mode of ["override", "remove"] as const) {
      const overlay: OverlayDeclaration = mode === "remove"
        ? { id: "drop-drafting", kind: "skill", mode, target: "agent/skills/drafting" }
        : { ...VOICE, id: "new-drafting", mode, target: "agent/skills/drafting" };
      const f = fixture([overlay]);
      const skillDir = path.join(f.source.root, "agents/eve/one/src/agent/skills/drafting");
      write(path.join(skillDir, "SKILL.md"), "---\ndescription: Draft posts.\n---\n");
      f.agent.skills = [{ path: "agent/skills/drafting", revision: skillContentHash(skillDir), tools: [], files: [], executables: [], writes: [], scenario: "verify-one" }];
      expect(() => validateRuntimeSource(f.source, f.agent)).not.toThrow();
      const resolved = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
      const view = overlaidRuntime(f.source, f.agent, resolved);
      expect(() => validateRuntimeSource(view.source, view.agent)).not.toThrow();
      expect(view.agent.skills.filter(skill => skill.path === "agent/skills/drafting")).toHaveLength(mode === "override" ? 1 : 0);
    }
  });

  test("review stages stay outside Git checkouts, even through a symlink", async () => {
    const f = fixture();
    const resolved = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
    const checkout = temp();
    fs.mkdirSync(path.join(checkout, ".git"));
    expect(() => stageOverlayReview(resolved, path.join(checkout, "reviews", "one"))).toThrow(/outside every Git checkout/);
    const link = path.join(temp(), "into-checkout");
    fs.symlinkSync(checkout, link);
    expect(() => stageOverlayReview(resolved, path.join(link, "reviews", "one"))).toThrow(/outside every Git checkout/);
  });

  test("approval refuses a review whose staged merged tree was edited", async () => {
    const f = fixture();
    const resolved = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
    const stage = path.join(temp(), "review");
    const reviewFile = stageOverlayReview(resolved, stage);
    write(path.join(stage, "merged-agent/skills/voice/SKILL.md"), "---\ndescription: not what builds\n---\n");
    await expect(approveOverlayReview(reviewFile, path.join(f.root, "approvals.yaml"), resolved.fingerprint, "A. Operator")).rejects.toThrow(/merged agent\/ tree differs/);
  });
});

describe("human approval of overlays", () => {
  test("stage, approve the reviewed fingerprint only, and require it before publication", async () => {
    const f = fixture();
    const resolved = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
    const stage = path.join(temp(), "review");
    const reviewFile = stageOverlayReview(resolved, stage);
    expect(fs.existsSync(path.join(stage, "merged-agent/skills/voice/SKILL.md"))).toBe(true);
    const approvals = path.join(f.root, "approvals.yaml");
    expect(() => verifyOverlayApproval(f.root, f.source, resolved)).toThrow(/Human overlay approval required/);
    await expect(approveOverlayReview(reviewFile, approvals, "e".repeat(64), "A. Operator")).rejects.toThrow(/reviewed fingerprint/);
    await expect(approveOverlayReview(reviewFile, approvals, resolved.fingerprint, " ")).rejects.toThrow(/named human/);
    await approveOverlayReview(reviewFile, approvals, resolved.fingerprint, "A. Operator");
    expect(parse(fs.readFileSync(approvals, "utf8")).approvals).toMatchObject([{ subject: resolved.subject, fingerprint: resolved.fingerprint, approvedBy: "A. Operator" }]);
    expect(() => verifyOverlayApproval(f.root, f.source, resolved)).not.toThrow();
    const changed = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": `${VOICE_SKILL}Say less.\n` })))!;
    expect(() => verifyOverlayApproval(f.root, f.source, changed)).toThrow(/Human overlay approval required/);
    write(path.join(stage, "content/voice/SKILL.md"), "---\ndescription: swapped after review\n---\n");
    await expect(approveOverlayReview(reviewFile, approvals, resolved.fingerprint, "A. Operator")).rejects.toThrow(/differs from the review/);
  });

  test("readiness compares the running template's overlay digest", async () => {
    const f = fixture();
    const resolved = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
    const template = (annotations?: Record<string, string>) => ({ spec: { template: { metadata: { annotations } } } });
    expect(templateOverlayDigest(template({ "harness-hg.factorylevel.dev/overlay-digest": resolved.digest }))).toBe(resolved.digest);
    expect(templateOverlayDigest(template())).toBeUndefined();
  });
});

// The shipped emitter, not a synthetic renderer: the record carries exactly the resolved overlays.
test("the production emitter carries approved overlays into the record", async () => {
  const f = fixture();
  const resolved = (await resolveAgentOverlays(f.source, f.agent, temp(), fetchWith({ "skills/voice/SKILL.md": VOICE_SKILL })))!;
  const output = await compileResolved(f.plan, f.root, [f.source], new Map([["one", resolved]]));
  const record = parse(String(output.files.get("profiles/one/profile.yaml")));
  expect(record.spec.overlays).toEqual(resolved.overlays);
  expect(record.spec.overlayTreeHash).toBe(resolved.treeHash);
  const plain = await compileResolved(f.plan, f.root, [f.source]);
  expect(parse(String(plain.files.get("profiles/one/profile.yaml"))).spec.overlays).toBeUndefined();
}, 60_000);
