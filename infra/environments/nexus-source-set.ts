// Operator entry point. Writes a reviewable GitOps checkout; never publishes it.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { loadDashboard } from "../../cli/src/nexus/contract.ts";
import { compileNexusSourceSet } from "../../cli/src/nexus/source-set.ts";
import { loadContracts } from "../../cli/src/topology/contract.ts";
import { loadEnvironment } from "../../cli/src/topology/environment.ts";
import { compile } from "../../cli/src/topology/compile.ts";
import { writeTree } from "../../cli/src/topology/emit.ts";
import { platformAvatarsDir, platformFontsDir } from "../../cli/src/local/shared.ts";
import { loadAvatarInventory, loadFontInventory, nexusInputsHash, renderNexusTree,
  selectableAvatarIds, NEXUS_MANAGED_TREES } from "../../cli/src/nexus/emit.ts";

const [specFile, sourcesFile, gitopsArg] = process.argv.slice(2);
if (!specFile || !sourcesFile || !gitopsArg) throw new Error("usage: nexus-source-set.ts <environment-spec.yaml> <sources.json> <gitops-checkout>");
const gitops = path.resolve(gitopsArg);
const spec = parse(fs.readFileSync(specFile, "utf8"));
const locations: unknown = JSON.parse(fs.readFileSync(sourcesFile, "utf8"));
if (!Array.isArray(locations)) throw new Error("sources.json must be an array of {id, repository, root, environment?}");
const deployments = spec.infra.agents.map((agent: { name: string; source: string; runtime?: string; subdir: string }) => {
  if (!/^[a-z][a-z0-9-]*$/.test(agent.name)) throw new Error("Invalid configured profile name");
  const record = parse(fs.readFileSync(path.join(gitops, "profiles", agent.name, "profile.yaml"), "utf8"))?.spec;
  if (!record?.sha || record.source !== agent.source || (record.runtime ?? "hermes") !== (agent.runtime ?? "hermes")
      || record.sourceSubdir !== agent.subdir) throw new Error(`Missing or mismatched deployment identity: ${agent.name}`);
  return { profile: agent.name, repository: agent.source, sha: record.sha,
    runtime: record.runtime ?? "hermes", subdir: record.sourceSubdir };
});
const avatars = loadAvatarInventory(platformAvatarsDir()), fonts = loadFontInventory(platformFontsDir());
const sources = locations.map((entry: unknown) => {
  if (!entry || typeof entry !== "object") throw new Error("Invalid source entry");
  const s = entry as Record<string, unknown>;
  for (const key of ["id", "repository", "root"]) if (typeof s[key] !== "string" || !s[key]) throw new Error(`Source entry requires ${key}`);
  if (s.environment !== undefined && typeof s.environment !== "string") throw new Error("Source environment must be a path");
  const root = fs.realpathSync(s.root as string);
  if (root === gitops) throw new Error("Source and GitOps checkouts must differ");
  if (execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim()) {
    throw new Error(`Source ${s.id} is dirty; compile an exact committed checkout`);
  }
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const environment = s.environment as string | undefined;
  const loaded = loadContracts(root), env = loadEnvironment(root, environment);
  return { id: s.id as string, repository: s.repository as string, sha,
    profileIdentities: Object.fromEntries(loaded.contracts.map(c => [c.profile, { runtime: c.runtime, subdir: c.subdir }])),
    bundledProfiles: env.environment.bundledProfiles,
    inputsHash: nexusInputsHash(root, { environmentSource: environment, avatarAssets: avatars, fontAssets: fonts }),
    dashboard: loadDashboard(root), topology: compile(loaded.contracts, env.environment, {
      priorFindings: [...loaded.findings, ...env.findings],
    }) };
});
const workloadEndpoints = Object.fromEntries(Object.entries(spec.infra.controlPlaneIngress?.workloadEndpoints ?? {})
  .map(([key, value]) => [key, { hostname: (value as { hostname: string }).hostname }]));
const result = compileNexusSourceSet(sources, deployments, { avatarIds: selectableAvatarIds(avatars), workloadEndpoints });
if (!result.ok) throw new Error(result.findings.filter(f => f.severity === "error").map(f => `${f.check}: ${f.message}`).join("\n"));
const tree = renderNexusTree(result.plan, result.icons, avatars, fonts);
tree.set("deployments/dashboard/sources.json", JSON.stringify({ version: 1, sources: result.provenance }, null, 2) + "\n");
const written = writeTree(gitops, tree, NEXUS_MANAGED_TREES);
console.log(JSON.stringify({ sources: result.provenance, components: result.plan.components.length, ...written }));
