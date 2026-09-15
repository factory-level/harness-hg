import fs from "node:fs";
import path from "node:path";
import { ApprovalRequired, CliError, PLATFORM_ROOT } from "../lib.ts";
import { fingerprint, inside, requireApproval, skillContentHash, verifyInstalled } from "../skills/contract.ts";
import { fetchSkill, recordApproval, type FetchSkill } from "../skills/install.ts";
import type { OverlayDeclaration, SkillRequirement, TeamSource } from "./plan.ts";
import type { ResolvedSource } from "./compiler.ts";

/** One operator overlay as the EveAgent record carries it (agent-bundle-contracts/eveagent/v1alpha3). */
export interface RecordOverlay {
  id: string;
  kind: OverlayDeclaration["kind"];
  mode: OverlayDeclaration["mode"];
  target: string;
  source?: { repository: string; commit: string; path: string };
  contentHash?: string;
  gitAuthSecretRef?: string;
}
interface OverlayMerge {
  applyOverlays(input: { project: string; overlays: RecordOverlay[]; contentFor: (overlay: RecordOverlay) => string; treeHash?: string; protectedSkills?: string[] }): { treeHash: string };
  contentHash(target: string): string;
  contentPath(checkout: string, overlay: RecordOverlay): string;
  overlayDigest(overlays: RecordOverlay[], treeHash: string): string;
}
/** The build container's merge implementation, imported rather than copied (ADR 0194). */
export const OVERLAY_MERGE_FILE = path.join(PLATFORM_ROOT, "harness/eve/charts/eve-agent/files/overlay-apply.mjs");
export const OVERLAY_DIGEST_ANNOTATION = "harness-hg.factorylevel.dev/overlay-digest";
let loaded: Promise<OverlayMerge> | undefined;
export const overlayMerge = (): Promise<OverlayMerge> => (loaded ??= import(OVERLAY_MERGE_FILE) as Promise<OverlayMerge>);

type Agent = TeamSource["agents"][number];
export interface OverlaySkill { id: string; tools: string[]; executables: string[]; writes: string[]; scenario: string }
export interface ResolvedOverlays {
  agent: string;
  subject: string;
  overlays: RecordOverlay[];
  contents: Map<string, string>;
  treeHash: string;
  digest: string;
  fingerprint: string;
  mergedRoot: string;
  project: string;
  requirements: SkillRequirement[];
  /** Local skill paths an overlay overrides or removes; the merged runtime view drops their old declarations. */
  replacedSkills: string[];
  skills: OverlaySkill[];
}

export const overlaySubject = (source: TeamSource, agent: string): string => `${source.repository.replace(/\.git$/, "")}#${agent}#overlays`;
/** What a human approves: the entries with their content hashes and the skill capabilities. The
 * base source commit is excluded, so a team release does not force re-approval. */
export const overlayFingerprint = (subject: string, overlays: RecordOverlay[], skills: OverlaySkill[]): string => fingerprint({ subject, overlays, skills });
export const declaredOverlays = (source: TeamSource, agent: Agent): OverlayDeclaration[] => [...(source.overlays ?? []), ...(agent.overlays ?? [])];
export const overlayDocument = (resolved: ResolvedOverlays) => ({ overlays: resolved.overlays, overlayTreeHash: resolved.treeHash });
export const templateOverlayDigest = (statefulSet: any): string | undefined => statefulSet?.spec?.template?.metadata?.annotations?.[OVERLAY_DIGEST_ANNOTATION];

/**
 * Fetch every overlay an agent receives at its pinned commit, hash it with the build container's
 * encoding, and merge it into a copy of the source with manifest-owned skills protected. The
 * original checkout is never modified.
 */
export async function resolveAgentOverlays(source: ResolvedSource, agent: Agent, scratch: string, fetch: FetchSkill = fetchSkill): Promise<ResolvedOverlays | undefined> {
  const declared = declaredOverlays(source.definition, agent);
  if (!declared.length) return undefined;
  try {
    const merge = await overlayMerge();
    const base = path.join(scratch, "overlays", agent.name);
    fs.mkdirSync(base, { recursive: true });
    const checkouts = new Map<string, string>();
    const contents = new Map<string, string>();
    const overlays: RecordOverlay[] = [];
    for (const o of declared) {
      const entry: RecordOverlay = { id: o.id, kind: o.kind, mode: o.mode, target: o.target };
      if (o.source) {
        const key = `${o.source.repository}\n${o.source.commit}`;
        let checkout = checkouts.get(key);
        if (!checkout) {
          checkout = path.join(base, `checkout-${checkouts.size}`);
          const commit = (await fetch(o.source.repository, o.source.commit, checkout, o.source.credentialEnv)).trim();
          if (commit !== o.source.commit) throw new CliError(`overlay ${o.id} fetched ${commit.slice(0, 12)}, not the pinned ${o.source.commit.slice(0, 12)}`);
          fs.rmSync(path.join(checkout, ".git"), { recursive: true, force: true });
          checkouts.set(key, checkout);
        }
        entry.source = { repository: o.source.repository, commit: o.source.commit, path: o.source.path };
        const content = merge.contentPath(checkout, entry);
        entry.contentHash = merge.contentHash(content);
        if (o.source.gitAuthSecretRef) entry.gitAuthSecretRef = o.source.gitAuthSecretRef;
        contents.set(o.id, content);
      }
      overlays.push(entry);
    }
    for (const o of declared) if (o.skill) {
      if (o.target.endsWith(".md") && o.skill.executables.length) throw new CliError(`skill overlay ${o.id}: a flat skills/<name>.md skill cannot require executables; package it as skills/<name>/SKILL.md so production startup checks them`);
      for (const tool of o.skill.tools) if (!agent.tools.includes(tool)) throw new CliError(`skill overlay ${o.id} requires unavailable tool ${tool}`);
      for (const write of o.skill.writes) if (!agent.writablePaths.some(allowed => write === allowed || write.startsWith(`${allowed.replace(/\/$/, "")}/`))) throw new CliError(`skill overlay ${o.id} requests a denied write destination`);
    }
    const mergedRoot = path.join(base, "merged");
    fs.cpSync(source.root, mergedRoot, { recursive: true, filter: file => path.basename(file) !== ".git" });
    const project = path.join(mergedRoot, agent.subdir);
    const protectedSkills = verifyInstalled(path.join(source.root, agent.subdir))?.manifest.skills.map(skill => skill.name) ?? [];
    const { treeHash } = merge.applyOverlays({ project, overlays, protectedSkills, contentFor: o => contents.get(o.id)! });
    const skills = declared.filter(o => o.skill).map(o => ({ id: o.id, ...o.skill! }));
    // A packaged skill overlay joins the runtime requirements, so the undeclared-SKILL.md,
    // capability and executable checks treat it like an authored skill.
    const requirements: SkillRequirement[] = declared.filter(o => o.skill && o.mode !== "remove" && !o.target.endsWith(".md")).map(o => ({
      path: o.target, revision: skillContentHash(inside(project, o.target)), tools: o.skill!.tools, files: [],
      executables: o.skill!.executables, writes: o.skill!.writes, scenario: o.skill!.scenario,
    }));
    const replacedSkills = declared.filter(o => o.kind === "skill" && o.mode !== "append").map(o => o.target.replace(/\.md$/, ""));
    const subject = overlaySubject(source.definition, agent.name);
    return { agent: agent.name, subject, overlays, contents, treeHash, digest: merge.overlayDigest(overlays, treeHash),
      fingerprint: overlayFingerprint(subject, overlays, skills), mergedRoot, project, requirements, replacedSkills, skills };
  } catch (error) {
    throw new CliError(`${agent.name}: ${error instanceof Error ? error.message : "operator overlay resolution failed"}`);
  }
}

/** The source and agent that runtime checks and production startup see once overlays are merged. */
export function overlaidRuntime(source: ResolvedSource, agent: Agent, resolved: ResolvedOverlays | undefined): { source: ResolvedSource; agent: Agent } {
  if (!resolved) return { source, agent };
  const kept = agent.skills.filter(skill => !resolved.replacedSkills.includes(skill.path.replace(/\/$/, "")));
  return { source: { ...source, root: resolved.mergedRoot }, agent: { ...agent, skills: [...kept, ...resolved.requirements] } };
}

export function verifyOverlayApproval(bootstrap: string, source: ResolvedSource, resolved: ResolvedOverlays): string {
  const policy = source.definition.skillPolicy;
  if (!policy) throw new CliError(`Source ${source.definition.id}: operator overlays need skillPolicy.approvals`);
  try {
    return fingerprint(requireApproval(inside(bootstrap, policy.approvals), resolved.subject, resolved.fingerprint));
  } catch {
    throw new ApprovalRequired(`Human overlay approval required for ${resolved.subject} at ${resolved.fingerprint}: run hg team overlays prepare, review the staged content, then record the decision with hg team overlays approve`, resolved.subject, resolved.fingerprint);
  }
}

export interface OverlayReview {
  version: 1;
  subject: string;
  overlays: RecordOverlay[];
  skills: OverlaySkill[];
  treeHash: string;
  fingerprint: string;
  /** Where each overlay's content is staged, relative to the review. Not part of the fingerprint. */
  staged: Record<string, string>;
}

/** A review stage holds private overlay content: a new directory outside every Git checkout, with
 * symlinks resolved before the check so a link cannot place it inside one. */
function assertReviewStage(stage: string): void {
  if (fs.existsSync(stage)) throw new CliError("Overlay review stage must be a new directory");
  let ancestor = path.dirname(path.resolve(stage));
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  for (let at = fs.realpathSync(ancestor); ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, ".git"))) throw new CliError("Overlay review stage must be outside every Git checkout");
    if (path.dirname(at) === at) break;
  }
}

/** Stage one agent's resolved overlays for a human: every content tree, the merged agent/ tree, and review.json. */
export function stageOverlayReview(resolved: ResolvedOverlays, stage: string): string {
  assertReviewStage(stage);
  fs.mkdirSync(path.join(stage, "content"), { recursive: true, mode: 0o700 });
  const staged: Record<string, string> = {};
  for (const [id, content] of resolved.contents) {
    const relative = fs.lstatSync(content).isDirectory() ? `content/${id}` : `content/${id}/${path.basename(content)}`;
    fs.mkdirSync(path.dirname(path.join(stage, relative)), { recursive: true });
    fs.cpSync(content, path.join(stage, relative), { recursive: true });
    staged[id] = relative;
  }
  fs.cpSync(path.join(resolved.project, "agent"), path.join(stage, "merged-agent"), { recursive: true });
  const review: OverlayReview = { version: 1, subject: resolved.subject, overlays: resolved.overlays, skills: resolved.skills,
    treeHash: resolved.treeHash, fingerprint: resolved.fingerprint, staged };
  const file = path.join(stage, "review.json");
  fs.writeFileSync(file, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function readOverlayReview(file: string): Promise<OverlayReview> {
  const merge = await overlayMerge();
  const review = JSON.parse(fs.readFileSync(file, "utf8")) as OverlayReview;
  if (review.version !== 1 || typeof review.subject !== "string" || typeof review.treeHash !== "string" || !Array.isArray(review.overlays) || !Array.isArray(review.skills) || !review.staged || typeof review.staged !== "object") throw new CliError("Invalid overlay review");
  if (review.fingerprint !== overlayFingerprint(review.subject, review.overlays, review.skills)) throw new CliError("Overlay review fingerprint differs from its content");
  for (const o of review.overlays) {
    if (!o.contentHash) continue;
    const relative = review.staged[o.id];
    if (typeof relative !== "string") throw new CliError(`Overlay review has no staged content for ${o.id}`);
    if (merge.contentHash(inside(path.dirname(file), relative)) !== o.contentHash) throw new CliError(`Staged overlay content for ${o.id} differs from the review`);
  }
  // What a human reads must be what the review names: the approval itself binds the entries and content hashes.
  if (merge.contentHash(inside(path.dirname(file), "merged-agent")) !== review.treeHash) throw new CliError("Staged merged agent/ tree differs from the review");
  return review;
}

/** Records the operator's explicit human decision; never call on an agent's behalf. */
export async function approveOverlayReview(reviewFile: string, approvalFile: string, expectedFingerprint: string, approvedBy: string): Promise<void> {
  const review = await readOverlayReview(reviewFile);
  if (expectedFingerprint !== review.fingerprint || !approvedBy.trim()) throw new CliError("Approval requires the reviewed fingerprint and a named human approver");
  recordApproval(approvalFile, review.subject, review.fingerprint, approvedBy);
}
