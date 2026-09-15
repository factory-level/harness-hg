import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { run, gitEnvironment } from "../team/process.ts";
import type { SkillRequirement } from "../team/plan.ts";
import { SKILL_API, dump, fingerprint, inside, packageFiles, readDocument, readLock, readManifest, requireApproval, skillContentHash, validatePackage, verifyInstalled, verifyLock, type Approvals, type SkillLock, type SkillManifest, type LockedSkill } from "./contract.ts";

export interface SkillReview {
  version: 1;
  subject: string;
  manifest: SkillManifest;
  lock: SkillLock;
  local: SkillRequirement[];
  fingerprint: string;
}
export const reviewHash = (review: Omit<SkillReview, "fingerprint" | "version">): string => fingerprint(review);
export function externalRequirements(manifest: SkillManifest, lock: SkillLock): SkillRequirement[] {
  return manifest.skills.map(skill => ({ path: `agent/skills/${skill.name}`, entrypoint: skill.source.entrypoint,
    revision: lock.skills.find(s => s.name === skill.name)!.hash, tools: skill.tools, executables: skill.executables,
    writes: skill.writes, files: skill.resources.map(f => `agent/skills/${skill.name}/${f}`), scenario: skill.scenario }));
}
export function projectReview(project: string, subject: string, local: SkillRequirement[] = []): SkillReview | undefined {
  const installed = verifyInstalled(project);
  if (!installed) return;
  const review = { subject, ...installed, local };
  return { version: 1, ...review, fingerprint: reviewHash(review) };
}
function checkLocal(project: string, local: SkillRequirement[], manifest: SkillManifest): void {
  const external = new Set(manifest.skills.map(s => `agent/skills/${s.name}`));
  for (const skill of local) {
    if (external.has(skill.path)) throw new Error("External skill requirements must come from the source manifest, not bootstrap duplicates");
    const root = inside(project, skill.path);
    if (skillContentHash(root) !== skill.revision) throw new Error(`Local skill ${skill.path} differs from its declared hash`);
    validatePackage(root, skill.entrypoint ?? "SKILL.md");
  }
}
export type FetchSkill = (repository: string, ref: string, checkout: string, credentialEnv?: string) => Promise<string>;
export const fetchSkill: FetchSkill = async (repository, ref, checkout, credentialEnv) => {
  if (credentialEnv && !/^[A-Z_][A-Z0-9_]*$/.test(credentialEnv)) throw new Error("Invalid Git credential environment name");
  const token = credentialEnv ? process.env[credentialEnv] : undefined;
  if (credentialEnv && !token) throw new Error(`Missing Git credential reference ${credentialEnv}`);
  // No checkout hooks, global filters, prompts, or untrusted subprocess setup continuations.
  const env = { ...gitEnvironment(token), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[]) => run(["git", "-c", "core.hooksPath=/dev/null", ...args], checkout, env);
  fs.mkdirSync(checkout, { recursive: true });
  await git(["init", "--quiet"]);
  await git(["remote", "add", "origin", repository]);
  await git(["fetch", "--depth=1", "--no-tags", "origin", ref]);
  const commit = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
  await git(["checkout", "--detach", "--quiet", commit]);
  return commit;
};
function copyResource(source: string, dest: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Only regular skill files can be copied");
  if (stat.isDirectory()) {
    packageFiles(source);
    fs.cpSync(source, dest, { recursive: true, errorOnExist: false });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest);
  }
}
/** Stage is intentionally external to the repo and never visible to Eve's skill discovery. */
export async function prepareSkills(project: string, subject: string, stage: string, options: { update?: string[]; local?: SkillRequirement[]; credentialEnv?: string; fetch?: FetchSkill } = {}): Promise<SkillReview> {
  const manifest = readManifest(project);
  if (!manifest) throw new Error("No per-agent skills.yaml manifest");
  if (!subject.includes("#") || !subject.endsWith(`#${path.basename(path.dirname(project))}`)) throw new Error("Review subject must be source-repository#agent-name");
  const absoluteStage = path.resolve(stage), sourceRoot = path.resolve(project, "../../../..");
  if (absoluteStage === sourceRoot || absoluteStage.startsWith(`${sourceRoot}/`) || fs.existsSync(stage)) throw new Error("Skill review stage must be a new directory outside the source repository");
  const local = options.local ?? [];
  checkLocal(project, local, manifest);
  const lockFile = path.join(path.dirname(project), "harness-hg/skills.lock.yaml");
  const previous = fs.existsSync(lockFile) ? readDocument<SkillLock>(lockFile, "lock") : undefined;
  const updates = new Set(options.update ?? []);
  for (const name of updates) if (!manifest.skills.some(s => s.name === name)) throw new Error(`Unknown skill update: ${name}`);
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hg-skills-fetch-"));
  try {
    const locks: LockedSkill[] = [];
    for (const skill of manifest.skills) {
      const prior = previous?.skills.find(s => s.name === skill.name);
      const unchanged = prior && fingerprint(prior.source) === fingerprint(skill.source);
      if (prior && !unchanged && !updates.has(skill.name)) throw new Error(`${skill.name}: changed source/version requires an explicit update`);
      const locked = unchanged && !updates.has(skill.name) ? prior : undefined;
      const destination = path.join(stage, "packages", skill.name), installed = path.join(project, "agent/skills", skill.name);
      if (locked && fs.existsSync(installed)) {
        validatePackage(installed, skill.source.entrypoint);
        if (skillContentHash(installed) !== locked.hash) throw new Error(`Refusing locally modified skill ${skill.name}`);
        copyResource(installed, destination); locks.push(locked); continue;
      }
      const checkout = path.join(scratch, skill.name);
      const commit = await (options.fetch ?? fetchSkill)(skill.source.repository, locked?.commit ?? skill.source.ref.commit ?? `refs/tags/${skill.source.ref.tag}`, checkout, options.credentialEnv);
      if (!/^[a-f0-9]{40}$/.test(commit) || (locked?.commit ?? skill.source.ref.commit) && commit !== (locked?.commit ?? skill.source.ref.commit)) throw new Error("Fetched skill commit differs from the requested lock");
      const root = inside(checkout, skill.source.root, true);
      const entryDir = path.dirname(skill.source.entrypoint);
      if (entryDir === ".") {
        fs.mkdirSync(destination, { recursive: true });
        for (const file of fs.readdirSync(root).filter(f => f !== ".git")) copyResource(inside(root, file), path.join(destination, file));
      }
      else {
        copyResource(inside(root, entryDir), path.join(destination, entryDir));
        for (const resource of skill.resources) copyResource(inside(root, resource), path.join(destination, resource));
        for (const file of fs.readdirSync(root).filter(f => /^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(f))) copyResource(inside(root, file), path.join(destination, file));
      }
      validatePackage(destination, skill.source.entrypoint);
      for (const resource of skill.resources) inside(destination, resource);
      const hash = skillContentHash(destination);
      if (locked && hash !== locked.hash) throw new Error(`Fetched skill ${skill.name} differs from its locked SHA-256`);
      locks.push({ name: skill.name, source: skill.source, commit, hash });
    }
    const lock: SkillLock = { apiVersion: SKILL_API, kind: "AgentSkillsLock", manifest: fingerprint(manifest), skills: locks };
    const data = { subject, manifest, lock, local };
    const review: SkillReview = { version: 1, ...data, fingerprint: reviewHash(data) };
    fs.writeFileSync(path.join(stage, "review.json"), JSON.stringify(review, null, 2) + "\n");
    fs.writeFileSync(path.join(stage, "skills.lock.yaml"), dump(lock));
    return review;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
export function readReview(file: string): SkillReview {
  const review = JSON.parse(fs.readFileSync(file, "utf8")) as SkillReview;
  if (review.version !== 1 || !Array.isArray(review.local)) throw new Error("Invalid skill review");
  verifyLock(review.lock, review.manifest);
  const { subject, manifest, lock, local } = review;
  if (typeof subject !== "string" || review.fingerprint !== reviewHash({ subject, manifest, lock, local })) throw new Error("Skill review fingerprint differs from content");
  for (const skill of manifest.skills) {
    const root = inside(path.dirname(file), `packages/${skill.name}`);
    validatePackage(root, skill.source.entrypoint);
    if (skillContentHash(root) !== lock.skills.find(s => s.name === skill.name)!.hash) throw new Error("Staged skill content differs from review");
  }
  return review;
}
/** This command records the operator's explicit human decision; never call on an agent's behalf. */
export function approveReview(reviewFile: string, approvalFile: string, expectedFingerprint: string, approvedBy: string): void {
  const review = readReview(reviewFile);
  if (expectedFingerprint !== review.fingerprint || !approvedBy.trim()) throw new Error("Approval requires the reviewed fingerprint and a named human approver");
  recordApproval(approvalFile, review.subject, review.fingerprint, approvedBy);
}
/** Replace one subject's approval in a bootstrap-owned SkillApprovals file (skills and operator overlays). */
export function recordApproval(approvalFile: string, subject: string, reviewed: string, approvedBy: string): void {
  const doc: Approvals = fs.existsSync(approvalFile) ? readDocument<Approvals>(approvalFile, "approvals") : { apiVersion: SKILL_API, kind: "SkillApprovals", approvals: [] };
  doc.approvals = doc.approvals.filter(a => a.subject !== subject);
  doc.approvals.push({ subject, fingerprint: reviewed, approvedBy, approvedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(approvalFile), { recursive: true });
  inside(path.dirname(approvalFile), ".", true);
  if (fs.existsSync(approvalFile)) inside(path.dirname(approvalFile), path.basename(approvalFile));
  const temp = `${approvalFile}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, dump(doc), { mode: 0o600 }); fs.renameSync(temp, approvalFile);
}
/** The journal permits recovery after process death; validation never accepts a pending install. */
export function installSkills(project: string, reviewFile: string, approvalFile: string): void {
  const review = readReview(reviewFile), manifest = readManifest(project);
  if (!manifest || fingerprint(manifest) !== fingerprint(review.manifest)) throw new Error("Source manifest changed since review");
  const agent = path.basename(path.dirname(project));
  if (!review.subject.endsWith(`#${agent}`)) throw new Error("Review belongs to another agent");
  const sourceRoot = path.resolve(project, "../../../.."), approval = fs.realpathSync(approvalFile);
  if (approval.startsWith(`${sourceRoot}/`)) throw new Error("Skill approvals must be owned outside the agent source repository");
  requireApproval(approvalFile, review.subject, review.fingerprint);
  const contract = path.join(path.dirname(project), "harness-hg"), lockPath = path.join(contract, "skills.lock.yaml");
  const journal = path.join(contract, ".skills-install.json");
  inside(contract, ".", true);
  inside(project, "agent");
  if (fs.existsSync(path.join(project, "agent/skills"))) inside(project, "agent/skills");
  else fs.mkdirSync(path.join(project, "agent/skills"));
  if (fs.existsSync(lockPath)) inside(contract, "skills.lock.yaml");
  if (fs.existsSync(journal)) recoverInstall(project, review.fingerprint);
  checkLocal(project, review.local, manifest);
  const previous = fs.existsSync(lockPath) ? readDocument<SkillLock>(lockPath, "lock") : undefined;
  // Removed packages are explicit lock changes and must still be unchanged before removal.
  const names = new Set([...manifest.skills.map(s => s.name), ...(previous?.skills.map(s => s.name) ?? [])]);
  for (const name of names) {
    const dest = path.join(project, "agent/skills", name), prior = previous?.skills.find(s => s.name === name);
    if (fs.existsSync(dest) && (!prior || skillContentHash(dest) !== prior.hash)) throw new Error(`Skill collision or local modification: ${name}`);
  }
  const transaction = fs.mkdtempSync(path.join(contract, ".skills-transaction-"));
  const backups: { destination: string; backup: string; existed: boolean }[] = [];
  try {
    for (const name of names) {
      const destination = path.join(project, "agent/skills", name), backup = path.join(transaction, "old", name);
      const existed = fs.existsSync(destination);
      if (existed) copyResource(destination, backup);
      backups.push({ destination, backup, existed });
    }
    if (fs.existsSync(lockPath)) fs.copyFileSync(lockPath, path.join(transaction, "lock"));
    fs.writeFileSync(journal, JSON.stringify({ transaction, backups, hadLock: fs.existsSync(lockPath), fingerprint: review.fingerprint }));
    for (const item of backups) {
      fs.rmSync(item.destination, { recursive: true, force: true });
      const name = path.basename(item.destination);
      if (manifest.skills.some(s => s.name === name)) copyResource(inside(path.dirname(reviewFile), `packages/${name}`), item.destination);
    }
    fs.writeFileSync(lockPath, dump(review.lock));
    for (const skill of manifest.skills) {
      const root = inside(project, `agent/skills/${skill.name}`);
      validatePackage(root, skill.source.entrypoint);
      if (skillContentHash(root) !== review.lock.skills.find(s => s.name === skill.name)!.hash) throw new Error("Installed bytes differ from approved package");
    }
    fs.unlinkSync(journal);
  } catch (error) {
    if (fs.existsSync(journal)) {
      for (const item of backups) {
        fs.rmSync(item.destination, { recursive: true, force: true });
        if (item.existed) copyResource(item.backup, item.destination);
      }
      if (fs.existsSync(path.join(transaction, "lock"))) fs.copyFileSync(path.join(transaction, "lock"), lockPath);
      else fs.rmSync(lockPath, { force: true });
      fs.unlinkSync(journal);
    }
    throw error;
  } finally {
    if (!fs.existsSync(journal)) fs.rmSync(transaction, { recursive: true, force: true });
  }
}

/** Called only after the same review is approved; never trust paths from the journal blindly. */
function recoverInstall(project: string, approvedFingerprint: string): void {
  const contract = path.join(path.dirname(project), "harness-hg"), journal = inside(contract, ".skills-install.json");
  const state = JSON.parse(fs.readFileSync(journal, "utf8"));
  if (state.fingerprint !== approvedFingerprint || typeof state.transaction !== "string" || path.dirname(state.transaction) !== contract || !path.basename(state.transaction).startsWith(".skills-transaction-") || !Array.isArray(state.backups)) throw new Error("Interrupted installation requires its original approved review");
  inside(contract, path.basename(state.transaction));
  inside(project, "agent/skills");
  if (fs.existsSync(path.join(contract, "skills.lock.yaml"))) inside(contract, "skills.lock.yaml");
  for (const item of state.backups) {
    const name = path.basename(item.destination ?? "");
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name) || item.destination !== path.join(project, "agent/skills", name) || item.backup !== path.join(state.transaction, "old", name) || typeof item.existed !== "boolean") throw new Error("Invalid skill installation recovery paths");
    if (item.existed) packageFiles(inside(state.transaction, `old/${name}`));
  }
  const oldLock = state.hadLock ? inside(state.transaction, "lock") : undefined;
  if (oldLock) readDocument<SkillLock>(oldLock, "lock");
  for (const item of state.backups) {
    fs.rmSync(item.destination, { recursive: true, force: true });
    if (item.existed) copyResource(item.backup, item.destination);
  }
  const lock = path.join(contract, "skills.lock.yaml");
  if (oldLock) fs.copyFileSync(oldLock, lock); else fs.rmSync(lock, { force: true });
  fs.unlinkSync(journal); fs.rmSync(state.transaction, { recursive: true, force: true });
}
