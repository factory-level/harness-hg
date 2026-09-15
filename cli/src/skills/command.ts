import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { HG_HOME } from "../lib.ts";
import { approveReview, installSkills, prepareSkills } from "./install.ts";
import { inside, verifyInstalled } from "./contract.ts";

export interface SkillOptions { dir?: string; agent?: string; subject?: string; stage?: string; review?: string; approvals?: string; approver?: string; fingerprint?: string; update?: string; credentialEnv?: string; requirements?: string }
export async function cmdSkills(args: string[], opts: SkillOptions): Promise<void> {
  const sub = args[0];
  if (sub === "approve") {
    if (!opts.review || !opts.approvals || !opts.approver || !opts.fingerprint) throw new Error("skills approve requires --review, --approval-file, --approver and --fingerprint after human review");
    approveReview(path.resolve(opts.review), path.resolve(opts.approvals), opts.fingerprint, opts.approver);
    console.log(JSON.stringify({ approved: true, fingerprint: opts.fingerprint })); return;
  }
  if (!opts.agent || !/^[a-z][a-z0-9-]{0,39}$/.test(opts.agent)) throw new Error("skills requires --agent <name>");
  const root = path.resolve(opts.dir ?? process.cwd()), project = inside(root, `agents/eve/${opts.agent}/src`);
  if (sub === "check") {
    const result = verifyInstalled(project);
    console.log(JSON.stringify({ ok: true, agent: opts.agent, skills: result?.lock.skills ?? [] }, null, 2)); return;
  }
  if (sub === "prepare") {
    if (!opts.subject) throw new Error("skills prepare requires --subject <source-repository#agent>");
    const stage = path.resolve(opts.stage ?? path.join(HG_HOME, "skill-reviews", `${opts.agent}-${Date.now()}`));
    const review = await prepareSkills(project, opts.subject, stage, { update: opts.update?.split(","), credentialEnv: opts.credentialEnv,
      local: opts.requirements ? parse(fs.readFileSync(opts.requirements, "utf8")) : [] });
    console.log(JSON.stringify({ ...review, reviewFile: path.join(stage, "review.json") }, null, 2)); return;
  }
  if (sub === "install") {
    if (!opts.review || !opts.approvals) throw new Error("skills install requires --review and --approval-file");
    const approval = path.resolve(opts.approvals);
    if (approval === root || approval.startsWith(`${root}/`)) throw new Error("Skill approval file must be bootstrap-owned, outside agent source");
    installSkills(project, path.resolve(opts.review), approval);
    console.log(JSON.stringify({ installed: true, agent: opts.agent })); return;
  }
  throw new Error("skills supports prepare, approve, install and check");
}
