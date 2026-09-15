import fs from "node:fs";
import path from "node:path";
import type { TeamPlan, TeamSource, SkillRequirement } from "../team/plan.ts";
import type { ResolvedSource } from "../team/compiler.ts";
import { fingerprint, inside, packageFiles, requireApproval, skillContentHash, verifyInstalled } from "./contract.ts";
import { externalRequirements, reviewHash } from "./install.ts";

export function runtimeRequirements(project: string, local: SkillRequirement[]): SkillRequirement[] {
  const external = verifyInstalled(project);
  if (!external) return local;
  const requirements = externalRequirements(external.manifest, external.lock);
  for (const skill of local) if (requirements.some(s => s.path === skill.path)) throw new Error("External skill requirements must come from the source manifest, not bootstrap duplicates");
  return [...local, ...requirements];
}
export function verifySourceApproval(plan: TeamPlan, bootstrap: string, source: ResolvedSource, agent: TeamSource["agents"][number]): string | undefined {
  const policy = source.definition.skillPolicy;
  const project = inside(source.root, agent.subdir), installed = verifyInstalled(project);
  const requirements = runtimeRequirements(project, agent.skills);
  for (const skill of requirements) {
    if (skillContentHash(inside(project, skill.path)) !== skill.revision) throw new Error(`${agent.name}: skill content differs from declared hash`);
    if (!plan.acceptance.some(a => a.source === source.definition.id && a.agent === agent.name && a.id === skill.scenario)) throw new Error(`${agent.name}: missing skill acceptance ${skill.scenario}`);
  }
  // Every advertised SKILL.md must be declared, including nested packages.
  const root = path.join(project, "agent/skills");
  const expected = new Set(requirements.map(s => path.posix.join(s.path, s.entrypoint ?? "SKILL.md")));
  if (fs.existsSync(root)) for (const file of packageFiles(root).filter(f => path.basename(f) === "SKILL.md")) {
    if (!expected.has(`agent/skills/${file}`)) throw new Error(`${agent.name}: undeclared installed skill ${file}`);
  }
  if (!policy) return;
  const file = inside(bootstrap, policy.approvals);
  const subject = `${source.definition.repository.replace(/\.git$/, "")}#${agent.name}`;
  const data = installed ? { subject, ...installed, local: agent.skills } : { subject, local: agent.skills };
  const hash = installed ? reviewHash(data as Parameters<typeof reviewHash>[0]) : fingerprint(data);
  const approval = requireApproval(file, subject, hash);
  return fingerprint(approval);
}
