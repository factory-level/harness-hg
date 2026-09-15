import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_API, dump, fingerprint, readLock, readManifest, skillContentHash, verifyInstalled, type SkillManifest, type SkillLock } from "../src/skills/contract.ts";
import { approveReview, fetchSkill, installSkills, prepareSkills, readReview, type FetchSkill } from "../src/skills/install.ts";
import { runtimeRequirements, verifySourceApproval } from "../src/skills/team.ts";
import type { TeamPlan } from "../src/team/plan.ts";
import { readAgentDeclaration } from "../src/layout.ts";
import { scaffoldBundle } from "../src/agent-bundle/scaffold.ts";

const dirs: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "hg-skills-test-")); dirs.push(root); return root; };
afterEach(() => { for (const root of dirs.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function fixture(agent = "workshop-coordinator") {
  const root = temp(), project = path.join(root, `agents/eve/${agent}/src`), bootstrap = temp(), staging = temp();
  scaffoldBundle({ dir: root, team: "workshops", agents: [{ name: agent, harness: "eve" }], gitopsRepoUrl: "https://github.com/example/generated" });
  const manifest: SkillManifest = { apiVersion: SKILL_API, kind: "AgentSkills", skills: [{ name: "venue-research",
    source: { repository: "https://github.com/example/skills", root: "packages/plugin", entrypoint: "skills/research/SKILL.md", ref: { tag: "v1.0.0" } },
    resources: ["references"], tools: ["search"], executables: [], writes: [], scenario: "venue-research" }] };
  const manifestFile = path.join(root, `agents/eve/${agent}/harness-hg/skills.yaml`);
  write(manifestFile, dump(manifest));
  const subject = `https://github.com/example/workshops#${agent}`, approvals = path.join(bootstrap, "skills-approved.yaml");
  let fetches = 0, revision = "a".repeat(40), content = "venue checklist";
  const fetch: FetchSkill = async (_url, ref, checkout) => {
    fetches++;
    const sha = /^[a-f0-9]{40}$/.test(ref) ? ref : revision;
    write(path.join(checkout, "packages/plugin/skills/research/SKILL.md"), "---\nname: venue-research\ndescription: Research workshop venues.\n---\nRead `../../references/checklist.md`.\n");
    write(path.join(checkout, "packages/plugin/references/checklist.md"), content);
    write(path.join(checkout, "packages/plugin/LICENSE"), "MIT");
    return sha;
  };
  const prepare = (stage = "review", update?: string[]) => prepareSkills(project, subject, path.join(staging, stage), { fetch, update });
  const approveInstall = (stage: string, hash: string) => {
    const file = path.join(staging, stage, "review.json");
    approveReview(file, approvals, hash, "Calvin"); installSkills(project, file, approvals);
  };
  return { root, project, bootstrap, staging, manifest, manifestFile, subject, approvals, prepare, approveInstall,
    fetches: () => fetches, change: () => { revision = "b".repeat(40); content = "updated checklist"; } };
}

describe("locked per-agent skills", () => {
  test("production Git fetch supports a tagged repository-root package", async () => {
    const f = fixture(), upstream = temp();
    write(path.join(upstream, "SKILL.md"), "---\nname: venue-research\ndescription: Research venues.\n---\n");
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(["git", ...args], { cwd: upstream });
      expect(p.exitCode).toBe(0); return p.stdout.toString().trim();
    };
    git("init", "--quiet"); git("add", "SKILL.md");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
    git("tag", "v1.0.0");
    f.manifest.skills[0]!.source.root = ".";
    f.manifest.skills[0]!.source.entrypoint = "SKILL.md";
    f.manifest.skills[0]!.resources = [];
    write(f.manifestFile, dump(f.manifest));
    const review = await prepareSkills(f.project, f.subject, path.join(f.staging, "git"), {
      fetch: (_repository, ref, checkout) => fetchSkill(`file://${upstream}`, ref, checkout),
    });
    expect(review.lock.skills[0]!.commit).toBe(git("rev-parse", "HEAD"));
    f.approveInstall("git", review.fingerprint);
    expect(verifyInstalled(f.project)).toBeDefined();
  });
  test("recovery restores an interrupted install and rejects symlink destinations", async () => {
    const f = fixture(), review = await f.prepare(); f.approveInstall("review", review.fingerprint);
    const contract = path.join(path.dirname(f.project), "harness-hg");
    const transaction = fs.mkdtempSync(path.join(contract, ".skills-transaction-"));
    const destination = path.join(f.project, "agent/skills/venue-research");
    const backup = path.join(transaction, "old/venue-research");
    fs.cpSync(destination, backup, { recursive: true });
    fs.copyFileSync(path.join(contract, "skills.lock.yaml"), path.join(transaction, "lock"));
    write(path.join(contract, ".skills-install.json"), JSON.stringify({ transaction,
      backups: [{ destination, backup, existed: true }], hadLock: true, fingerprint: review.fingerprint }));
    write(path.join(destination, "references/checklist.md"), "interrupted bytes");
    installSkills(f.project, path.join(f.staging, "review/review.json"), f.approvals);
    expect(verifyInstalled(f.project)).toBeDefined();
    fs.renameSync(path.join(f.project, "agent/skills"), path.join(f.bootstrap, "outside"));
    fs.symlinkSync(path.join(f.bootstrap, "outside"), path.join(f.project, "agent/skills"));
    expect(() => installSkills(f.project, path.join(f.staging, "review/review.json"), f.approvals)).toThrow("symlink");
    expect(fs.existsSync(path.join(f.bootstrap, "outside/venue-research/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(f.bootstrap, "outside/venue-research/skills/research/SKILL.md"))).toBe(true);
  });
  test("stages complete shared resources, requires human approval, installs and verifies offline", async () => {
    const f = fixture(), review = await f.prepare();
    expect(fs.existsSync(path.join(f.project, "agent/skills/venue-research"))).toBe(false);
    expect(fs.existsSync(path.join(f.staging, "review/packages/venue-research/LICENSE"))).toBe(true);
    expect(() => installSkills(f.project, path.join(f.staging, "review/review.json"), f.approvals)).toThrow();
    f.approveInstall("review", review.fingerprint);
    expect(verifyInstalled(f.project)?.lock.skills[0]!.commit).toBe("a".repeat(40));
    expect(readAgentDeclaration(f.project).findings).toEqual([]);
    const requirements = runtimeRequirements(f.project, []);
    expect(requirements[0]!.entrypoint).toBe("skills/research/SKILL.md");
    expect(() => runtimeRequirements(f.project, requirements)).toThrow("source manifest");
    const repeat = await f.prepare("repeat");
    expect(f.fetches()).toBe(1); expect(repeat.fingerprint).toBe(review.fingerprint);
    f.approveInstall("repeat", repeat.fingerprint);
  });
  test("moving upstream tag cannot change a lock; explicit update requires renewed approval", async () => {
    const f = fixture(), original = await f.prepare(); f.approveInstall("review", original.fingerprint);
    f.change();
    expect((await f.prepare("unchanged")).lock.skills[0]!.commit).toBe("a".repeat(40));
    const updated = await f.prepare("update", ["venue-research"]);
    expect(updated.lock.skills[0]!.commit).toBe("b".repeat(40));
    expect(() => installSkills(f.project, path.join(f.staging, "update/review.json"), f.approvals)).toThrow("approval");
    f.approveInstall("update", updated.fingerprint);
    expect(verifyInstalled(f.project)?.lock.skills[0]!.commit).toBe("b".repeat(40));
  });
  test("modified packages and capability-expanded manifests fail closed", async () => {
    const f = fixture(), review = await f.prepare(); f.approveInstall("review", review.fingerprint);
    write(path.join(f.project, "agent/skills/venue-research/references/checklist.md"), "local changes");
    expect(() => verifyInstalled(f.project)).toThrow("SHA-256");
    await expect(f.prepare("modified")).rejects.toThrow("locally modified");
    f.manifest.skills[0]!.tools.push("send_email"); write(f.manifestFile, dump(f.manifest));
    expect(() => verifyInstalled(f.project)).toThrow("stale");
    expect(readAgentDeclaration(f.project).findings.some(f => f.message.includes("stale"))).toBe(true);
  });
  test("changed candidate bytes and unknown source versions cannot be approved", async () => {
    const f = fixture(); await f.prepare();
    write(path.join(f.staging, "review/packages/venue-research/references/checklist.md"), "tampered");
    expect(() => readReview(path.join(f.staging, "review/review.json"))).toThrow("content differs");
    f.manifest.skills[0]!.source.ref = { tag: "latest" }; write(f.manifestFile, dump(f.manifest));
    expect(() => readManifest(f.project)).toThrow("exact tag");
    f.manifest.skills[0]!.source.ref = { branch: "main" } as any; write(f.manifestFile, dump(f.manifest));
    expect(() => readManifest(f.project)).toThrow();
  });
  test("name collisions, path traversal and symlink resources are rejected", async () => {
    const f = fixture(), review = await f.prepare();
    write(path.join(f.project, "agent/skills/venue-research/SKILL.md"), "local package");
    expect(() => f.approveInstall("review", review.fingerprint)).toThrow("collision");
    f.manifest.skills.push(f.manifest.skills[0]!); write(f.manifestFile, dump(f.manifest));
    expect(() => readManifest(f.project)).toThrow("Duplicate");
    f.manifest.skills.pop(); f.manifest.skills[0]!.resources = ["../secret"];
    write(f.manifestFile, dump(f.manifest)); expect(() => readManifest(f.project)).toThrow("resource");
    const target = path.join(f.bootstrap, "secret"); write(target, "secret");
    fs.symlinkSync(target, path.join(f.staging, "review/packages/venue-research/reference-link"));
    expect(() => readReview(path.join(f.staging, "review/review.json"))).toThrow("symlink");
  });
  test("network failure leaves installed content intact and staged packages inactive", async () => {
    const f = fixture(), review = await f.prepare(); f.approveInstall("review", review.fingerprint);
    const before = skillContentHash(path.join(f.project, "agent/skills/venue-research"));
    await expect(prepareSkills(f.project, f.subject, path.join(f.staging, "failed"), { update: ["venue-research"], fetch: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
    expect(skillContentHash(path.join(f.project, "agent/skills/venue-research"))).toBe(before);
    expect(verifyInstalled(f.project)).toBeDefined();
  });
  test("same upstream can be independently locked for different agents", async () => {
    const a = fixture("coordinator"), b = fixture("campaign-manager");
    const ar = await a.prepare(); a.approveInstall("review", ar.fingerprint);
    b.change(); const br = await b.prepare(); b.approveInstall("review", br.fingerprint);
    expect(ar.lock.skills[0]!.commit).not.toBe(br.lock.skills[0]!.commit);
    expect(ar.fingerprint).not.toBe(br.fingerprint);
  });
  test("approval policy checks source ownership, scenarios and nested undeclared skills", async () => {
    const f = fixture(), review = await f.prepare(); f.approveInstall("review", review.fingerprint);
    const agent = { name: "workshop-coordinator", subdir: "agents/eve/workshop-coordinator/src", skills: [], tools: ["search"], environment: [], writablePaths: [] };
    const source = { root: f.root, sha: "a".repeat(40), definition: { id: "workshops", repository: "https://github.com/example/workshops", ref: "main", private: false, agents: [agent], skillPolicy: { approvals: "skills-approved.yaml" } } };
    const plan = { acceptance: [{ id: "venue-research", source: "workshops", agent: agent.name }] } as TeamPlan;
    expect(verifySourceApproval(plan, f.bootstrap, source, agent)).toHaveLength(64);
    expect(() => verifySourceApproval({ acceptance: [] } as unknown as TeamPlan, f.bootstrap, source, agent)).toThrow("acceptance");
    const noPolicy = { ...source, definition: { ...source.definition, skillPolicy: undefined } };
    expect(() => verifySourceApproval({ acceptance: [] } as unknown as TeamPlan, f.bootstrap, noPolicy, agent)).toThrow("acceptance");
    source.definition.repository = "https://github.com/example/other";
    expect(() => verifySourceApproval(plan, f.bootstrap, source, agent)).toThrow("approval");
    source.definition.repository = "https://github.com/example/workshops";
    write(path.join(f.project, "agent/skills/rogue/nested/SKILL.md"), "unapproved");
    expect(() => verifySourceApproval(plan, f.bootstrap, source, agent)).toThrow("undeclared");
  });
  test("pending installation journal blocks validation and old projects stay compatible", async () => {
    const f = fixture(), review = await f.prepare(); f.approveInstall("review", review.fingerprint);
    write(path.join(path.dirname(f.project), "harness-hg/.skills-install.json"), "{}");
    expect(() => verifyInstalled(f.project)).toThrow("Interrupted");
    const old = temp(); scaffoldBundle({ dir: old, team: "old", agents: [{ name: "old", harness: "eve" }], gitopsRepoUrl: "https://github.com/example/generated" });
    expect(verifyInstalled(path.join(old, "agents/eve/old/src"))).toBeUndefined();
    expect(readAgentDeclaration(path.join(old, "agents/eve/old/src")).findings).toEqual([]);
  });
});
