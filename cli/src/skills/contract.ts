import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import Ajv2020 from "ajv/dist/2020";
import { ApprovalRequired } from "../lib.ts";

export const SKILL_API = "hermes-gitops.factorylevel.dev/agent-skills/v1alpha1";
export interface SkillSource {
  repository: string;
  root: string;
  entrypoint: string;
  ref: { tag: string; commit?: never } | { commit: string; tag?: never };
}
export interface ExternalSkill {
  name: string;
  source: SkillSource;
  resources: string[];
  tools: string[];
  executables: string[];
  writes: string[];
  scenario: string;
}
export interface SkillManifest { apiVersion: typeof SKILL_API; kind: "AgentSkills"; skills: ExternalSkill[] }
export interface LockedSkill { name: string; source: SkillSource; commit: string; hash: string }
export interface SkillLock { apiVersion: typeof SKILL_API; kind: "AgentSkillsLock"; manifest: string; skills: LockedSkill[] }
export interface Approval { subject: string; fingerprint: string; approvedBy: string; approvedAt: string }
export interface Approvals { apiVersion: typeof SKILL_API; kind: "SkillApprovals"; approvals: Approval[] }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const dump = (value: unknown): string => stringify(value, { sortMapEntries: true, lineWidth: 0 });
export function relative(value: string, allowRoot = false): boolean {
  return typeof value === "string" && (allowRoot && value === "." || !!value && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && value.split("/").every(p => !!p && p !== "." && p !== ".." && p !== ".git"));
}
/** Reject symlinks at every component, including the root, before reading or copying content. */
export function inside(root: string, file: string, allowRoot = false): string {
  if (!relative(file, allowRoot)) throw new Error(`Skill path escapes package: ${file}`);
  const base = path.resolve(root);
  for (let at = base; ; at = path.dirname(at)) {
    if (fs.lstatSync(at).isSymbolicLink()) throw new Error("Skill paths must not contain symlinks");
    if (path.dirname(at) === at) break;
  }
  let at = base;
  if (file !== ".") for (const part of file.split("/")) {
    at = path.join(at, part);
    if (fs.lstatSync(at).isSymbolicLink()) throw new Error("Skill paths must not contain symlinks");
  }
  return at;
}
export function packageFiles(root: string): string[] {
  inside(root, ".", true);
  const files: string[] = [];
  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error("Skill packages require regular files and no symlinks");
      if (entry.name === ".git") throw new Error("Git metadata cannot be installed as a skill");
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(path.relative(root, full));
    }
  }
  visit(root);
  return files.sort();
}
/** Existing `hg team inspect` hash: sorted relative names and bytes, separated by NULs. */
export function skillContentHash(root: string): string {
  const hash = createHash("sha256");
  for (const file of packageFiles(root)) hash.update(file).update("\0").update(fs.readFileSync(path.join(root, file))).update("\0");
  return hash.digest("hex");
}
const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemas = path.resolve(import.meta.dir, "../../../agent-bundle-contracts/agent-skills/v1alpha1");
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function validateDocument<T>(stem: string, value: unknown): T {
  let validate = validators.get(stem);
  if (!validate) {
    validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(schemas, `${stem}.schema.json`), "utf8")));
    validators.set(stem, validate);
  }
  if (!validate(value)) throw new Error(`Skill ${stem}: ${ajv.errorsText(validate.errors)}`);
  return value as T;
}
export function readDocument<T>(file: string, stem: string): T { return validateDocument<T>(stem, parse(fs.readFileSync(file, "utf8"))); }
export function readManifest(project: string): SkillManifest | undefined {
  const contract = path.join(path.dirname(project), "harness-hg"), file = path.join(contract, "skills.yaml");
  if (!fs.existsSync(file)) {
    if (fs.existsSync(path.join(contract, "skills.lock.yaml"))) throw new Error("Skill lock has no manifest");
    return;
  }
  inside(contract, "skills.yaml");
  const agent = parse(fs.readFileSync(path.join(contract, "agent.yaml"), "utf8"));
  if (agent?.harness !== "eve") throw new Error("External skill installation supports Eve agents only");
  return validateManifest(readDocument<SkillManifest>(file, "manifest"));
}
export function validateManifest(value: unknown): SkillManifest {
  const manifest = validateDocument<SkillManifest>("manifest", value);
  const names = new Set<string>();
  for (const skill of manifest.skills) {
    if (names.has(skill.name)) throw new Error(`Duplicate skill name: ${skill.name}`);
    names.add(skill.name);
    if (!relative(skill.source.root, true) || !relative(skill.source.entrypoint) || path.basename(skill.source.entrypoint) !== "SKILL.md") throw new Error("Invalid skill package root or entrypoint");
    if (skill.source.ref.tag && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(skill.source.ref.tag) || /\.\.|\/\//.test(skill.source.ref.tag) || /(^|\/)(latest|HEAD)$/.test(skill.source.ref.tag))) throw new Error("Skill version must be an exact tag or commit");
    for (const resource of skill.resources) if (!relative(resource)) throw new Error("Invalid skill resource path");
  }
  return manifest;
}
export function readLock(project: string, manifest: SkillManifest): SkillLock {
  const file = inside(path.join(path.dirname(project), "harness-hg"), "skills.lock.yaml");
  return verifyLock(readDocument<SkillLock>(file, "lock"), manifest);
}
export function verifyLock(lock: SkillLock, manifest: SkillManifest): SkillLock {
  validateManifest(manifest);
  validateDocument("lock", lock);
  if (lock.manifest !== fingerprint(manifest) || lock.skills.length !== manifest.skills.length || new Set(lock.skills.map(s => s.name)).size !== lock.skills.length) throw new Error("Skill lock is stale or has duplicate entries; prepare a review");
  for (const skill of manifest.skills) {
    const pinned = lock.skills.find(s => s.name === skill.name);
    if (!pinned || fingerprint(pinned.source) !== fingerprint(skill.source) || skill.source.ref.commit && pinned.commit !== skill.source.ref.commit) throw new Error(`Skill lock does not match ${skill.name}`);
  }
  return lock;
}
export function validatePackage(root: string, entrypoint: string): void {
  const files = packageFiles(root), entries = files.filter(file => path.basename(file) === "SKILL.md");
  if (entries.length !== 1 || entries[0] !== entrypoint) throw new Error("A skill package must contain exactly its declared SKILL.md entrypoint");
  const entry = inside(root, entrypoint), content = fs.readFileSync(entry, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match || typeof parse(match[1]!)?.description !== "string") throw new Error("Skill entrypoint requires description frontmatter");
  // Markdown links and backticked relative resource paths both appear in upstream skills.
  for (const file of files.filter(f => /\.mdx?$/.test(f))) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)|`((?:\.\.?\/)[^`\n]+)`/g)) {
      const ref = (m[1] ?? m[2]!).split("#")[0]!;
      if (!ref || /^[a-z]+:/i.test(ref) || ref.startsWith("/")) continue;
      const target = path.resolve(root, path.dirname(file), ref);
      inside(root, path.relative(root, target));
    }
  }
}
export function verifyInstalled(project: string): { manifest: SkillManifest; lock: SkillLock } | undefined {
  if (fs.existsSync(path.join(path.dirname(project), "harness-hg/.skills-install.json"))) throw new Error("Interrupted skill installation must be recovered before validation");
  const manifest = readManifest(project);
  if (!manifest) return;
  const lock = readLock(project, manifest);
  for (const skill of manifest.skills) {
    const root = inside(project, `agent/skills/${skill.name}`);
    validatePackage(root, skill.source.entrypoint);
    for (const resource of skill.resources) inside(root, resource);
    if (skillContentHash(root) !== lock.skills.find(s => s.name === skill.name)!.hash) throw new Error(`Installed skill ${skill.name} differs from its locked SHA-256`);
  }
  return { manifest, lock };
}
export function requireApproval(file: string, subject: string, hash: string): Approval {
  inside(path.dirname(path.resolve(file)), path.basename(file));
  const doc = readDocument<Approvals>(file, "approvals");
  const approval = doc.approvals.find(a => a.subject === subject && a.fingerprint === hash);
  if (!approval) throw new ApprovalRequired(`Human skill approval required for ${subject} at ${hash}`, subject, hash);
  return approval;
}
