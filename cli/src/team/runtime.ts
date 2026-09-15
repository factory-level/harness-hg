import fs from "node:fs";
import path from "node:path";
import versions from "../../../versions.json";
import { skillContentHash, packageFiles } from "../skills/contract.ts";
import { runtimeRequirements } from "../skills/team.ts";
export { skillContentHash } from "../skills/contract.ts";
import { CliError } from "../lib.ts";
import { relativePath, type TeamPlan, type TeamSource } from "./plan.ts";
import type { ResolvedSource } from "./compiler.ts";
import { run, type Run } from "./process.ts";

function inside(root: string, relative: string): string {
  if (!relativePath(relative)) throw new Error("Skill reference leaves its source project");
  const resolved = fs.realpathSync(path.join(root, relative));
  if (resolved !== fs.realpathSync(root) && !resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new Error("Skill reference resolves outside its source project");
  return resolved;
}
/** One agent's runtime: its own pin when it has one, the installation default otherwise (ADR 0192).
 * Pure resolution - whether a pin is one the platform publishes is asked once, by
 * `assertAllowedRuntimes`, so every render and comparison here agrees with the lock. */
export function effectiveRuntime(plan: TeamPlan, agent: TeamSource["agents"][number]): { image: string; eveVersion: string } {
  return agent.runtime ? { ...agent.runtime } : { image: plan.runtime.image, eveVersion: versions.runtimes.eve.version };
}
/** The policy gate over every pin in a plan: nothing deploys a runtime pair the platform does not
 * publish and keep. Asked once per command, before anything resolves, renders or locks. */
export function assertAllowedRuntimes(plan: TeamPlan, allowed: readonly { version: string; image: string }[] = versions.runtimes.eve.allowed): void {
  for (const source of plan.sources) for (const agent of source.agents) {
    if (!agent.runtime) continue;
    if (allowed.some(a => a.image === agent.runtime!.image && a.version === agent.runtime!.eveVersion)) continue;
    throw new CliError(`${agent.name}: runtime pin eve@${agent.runtime.eveVersion} at ${agent.runtime.image.split("@")[1]?.slice(0, 19)} is not one the platform publishes`
      + " - add the pair to versions.json runtimes.eve.allowed, or remove the pin to use the installation default");
  }
}
/** The image the workload `ag-eve-<agent>` should be running: that agent's effective runtime.
 * Recovery paths know the workload, not the agent, and a canary must still be recoverable. */
export function workloadRuntimeImage(plan: TeamPlan, workloadName: string): string {
  const agent = plan.sources.flatMap(s => s.agents).find(a => `ag-eve-${a.name}` === workloadName);
  return agent ? effectiveRuntime(plan, agent).image : plan.runtime.image;
}
/** True when this agent runs something other than the platform default Eve: a canary. */
export function isRuntimeCanary(plan: TeamPlan, agent: TeamSource["agents"][number]): boolean {
  return effectiveRuntime(plan, agent).eveVersion !== versions.runtimes.eve.version;
}
export function validateRuntimeSource(source: ResolvedSource, agent: TeamSource["agents"][number], eveVersion: string = versions.runtimes.eve.version): void {
  const root = inside(source.root, agent.subdir);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (pkg.name !== agent.name || pkg.dependencies?.eve !== eveVersion || lock.packages?.["node_modules/eve"]?.version !== eveVersion) throw new Error(`${agent.name}: package identity or locked Eve version differs from the runtime it deploys on (eve@${eveVersion})`);
  if (!pkg.dependencies?.["just-bash"] || !lock.packages?.["node_modules/just-bash"]?.version) throw new Error(`${agent.name}: missing locked production sandbox dependency`);
  const skillsRoot = path.join(root, "agent/skills");
  const requirements = runtimeRequirements(root, agent.skills);
  const selected = new Set(requirements.map(s => path.posix.join(s.path, s.entrypoint ?? "SKILL.md")));
  if (fs.existsSync(skillsRoot)) for (const entry of packageFiles(skillsRoot).filter(f => path.basename(f) === "SKILL.md")) {
    if (!selected.has(`agent/skills/${entry}`)) throw new Error(`${agent.name}: installed skill ${entry} has no capability declaration or acceptance scenario`);
  }
  for (const skill of requirements) {
    const skillDir = inside(root, skill.path);
    if (skillContentHash(skillDir) !== skill.revision) throw new Error(`${agent.name}: installed skill content differs from its recorded SHA-256`);
    const entrypoint = path.join(skillDir, skill.entrypoint ?? "SKILL.md");
    const instructions = fs.readFileSync(entrypoint, "utf8");
    for (const required of skill.tools) if (!agent.tools.includes(required)) throw new Error(`${agent.name}: skill requires unavailable tool ${required}`);
    for (const write of skill.writes) if (!agent.writablePaths.some(allowed => write === allowed || write.startsWith(`${allowed.replace(/\/$/, "")}/`))) throw new Error(`${agent.name}: skill requests a denied write destination`);
    for (const file of skill.files) inside(root, file);
    for (const match of instructions.matchAll(/\]\(([^)]+)\)/g)) {
      const ref = match[1]!.split("#")[0]!;
      if (!ref || /^[a-z]+:/i.test(ref)) continue;
      const target = path.resolve(path.dirname(entrypoint), ref);
      inside(root, path.relative(root, target));
    }
  }
}

/** Fresh production image/backend, with no workstation Docker/KVM socket or global packages. */
export async function verifyProductionRuntime(plan: TeamPlan, source: ResolvedSource, agent: TeamSource["agents"][number], exec: Run = run, capabilityEnvironment: Record<string, string> = {}): Promise<void> {
  const runtime = effectiveRuntime(plan, agent);
  validateRuntimeSource(source, agent, runtime.eveVersion);
  for (const [key, value] of Object.entries(capabilityEnvironment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string" || agent.environment.includes(key) || key in (agent.environmentBindings ?? {})) throw new Error(`${agent.name}: invalid or conflicting capability environment`);
  }
  const environment = { ...process.env, ...capabilityEnvironment };
  for (const [target, reference] of Object.entries(agent.environmentBindings ?? {})) environment[target] = process.env[reference];
  for (const variable of agent.environment) if (!environment[variable]) throw new Error(`${agent.name}: missing runtime environment reference ${variable}`);
  const project = path.join(source.root, agent.subdir);
  const name = `hg-startup-${agent.name}-${process.pid}`;
  const tools = [...new Set(runtimeRequirements(project, agent.skills).flatMap(s => s.executables))];
  if (tools.some(x => !/^[a-zA-Z0-9._-]+$/.test(x))) throw new Error("Invalid executable requirement");
  // Fixed script: source comes from a read-only mount and is copied into disposable
  // container storage. Environment values travel by name, never command arguments.
  const script = `set -eu
mkdir /tmp/hg-source
cp -R /input/. /tmp/hg-source/
cd "/tmp/hg-source/$HG_PROJECT_SUBDIR"
rm -rf node_modules .output
npm ci --no-audit --no-fund
node -e 'const fs=require("fs"); if(JSON.parse(fs.readFileSync("node_modules/eve/package.json")).version!==process.env.HG_EXPECT_EVE) process.exit(1); require.resolve("just-bash")'
npm run build
${tools.map(tool => `command -v ${tool} >/dev/null`).join("\n")}
npm run start > /tmp/hg-startup.log 2>&1 &
AGENT_PID=$!
trap 'kill "$AGENT_PID" 2>/dev/null || true' EXIT
node --input-type=module -e 'for(let i=0;i<90;i++){try {const r=await fetch("http://127.0.0.1:3000/eve/v1/health");if(r.ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)' || { cat /tmp/hg-startup.log >&2; exit 1; }
`;
  try {
    await exec(["docker", "run", "--rm", "--name", name, "--platform", plan.runtime.platform,
      "--mount", `type=bind,src=${source.root},dst=/input,readonly`,
      ...[...agent.environment, ...Object.keys(capabilityEnvironment)].flatMap(v => ["--env", v]), "--env", "HG_EXPECT_EVE", "--env", "HG_PROJECT_SUBDIR", runtime.image, "sh", "-c", script],
    source.root, { ...environment, HG_EXPECT_EVE: runtime.eveVersion, HG_PROJECT_SUBDIR: agent.subdir }, 900_000);
  } finally {
    // Timeout must not leave a build or server running on the operator host.
    await exec(["docker", "rm", "--force", name], source.root).catch(() => {});
  }
}
