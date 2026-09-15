import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { agentLayout } from "../layout.ts";
import { compile } from "../topology/compile.ts";
import { loadContracts, discoverContractDirs } from "../topology/contract.ts";
import { loadEnvironment } from "../topology/environment.ts";
import { renderTree } from "../topology/emit.ts";
import { compileConnectionsFromRoot, connectionFiles } from "../connection/compile.ts";
import { loadWorkspaceDeclarations, compileWorkspaceBindings, workspaceFiles, type WorkspaceProfileRecord, type NormalizedWorkspaceBinding } from "../workspace/bindings.ts";
import { loadDashboard } from "../nexus/contract.ts";
import { compileNexusSourceSet, type NexusSource, type NexusDeployment } from "../nexus/source-set.ts";
import { loadAvatarInventory, loadFontInventory, renderNexusTree, selectableAvatarIds, loadWorkloadEndpoints } from "../nexus/emit.ts";
import { PLATFORM_ROOT } from "../lib.ts";
import { digest, type TeamPlan, type TeamSource } from "./plan.ts";
import { effectiveRuntime } from "./runtime.ts";

export interface ResolvedSource { definition: TeamSource; root: string; sha: string }
/** Opt one owner into the bootstrap's private platform chart source without
 * changing preserved chart sources for any other owner. */
export function applyBootstrapChartSource(record: Record<string, unknown>, source: { repository: string; revision: string } | undefined, owner: string): void {
  if (!source) return;
  const url = source.repository;
  const revision = source.revision;
  let valid = false;
  try {
    const parsed = new URL(url);
    valid = parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { /* Refuse malformed/credential-bearing sources. */ }
  if (!valid || typeof url !== "string" || typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision) || /^0+$/.test(revision)) throw new Error("Bootstrap chart source requires a credential-free HTTPS repository and immutable commit");
  record.platformRepo = { url, revision };
  record.appProject = { name: `hg-appcharts-${owner}`, sourceRepos: [] };
}

export interface Projection { files: Map<string, string | Buffer>; fingerprint: string; profiles: string[] }
export type RecordRenderer = (source: ResolvedSource, agent: TeamSource["agents"][number]) => string;
const dump = (value: unknown) => stringify(value, { sortMapEntries: true, lineWidth: 0 });
function errors(findings: { severity: string; message: string }[]): void {
  const bad = findings.filter(f => f.severity === "error");
  if (bad.length) throw new Error(bad.map(f => f.message).join("\n"));
}

/** Compile in memory. No destination checkout is written, pruned, or used as input. */
export function compileTeam(plan: TeamPlan, bootstrapRoot: string, sources: ResolvedSource[], renderRecord: RecordRenderer): Projection {
  const ordered = [...sources].sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  if (digest(ordered.map(s => s.definition.id)) !== digest(plan.sources.map(s => s.id).sort())) throw new Error("Source registry coverage mismatch");
  const envPath = path.resolve(bootstrapRoot, plan.environment);
  const loaded = ordered.map(s => ({ ...s, contracts: loadContracts(s.root), env: loadEnvironment(s.root, envPath) }));
  const all = loaded.flatMap(s => s.contracts.contracts);
  if (new Set(all.map(c => c.profile)).size !== all.length) throw new Error("Duplicate profiles across registered teams");
  const environment = structuredClone(loaded[0]!.env.environment);
  // Placement and policy must agree. Merge only independently owned connection aliases;
  // choosing the first source's grants would silently change the other team's authority.
  for (const s of loaded.slice(1)) {
    const env = s.env.environment;
    for (const key of ["layout", "sovereignty", "dns", "globalTarget", "regions", "targets", "policy", "capabilityBindings", "grants", "bundledProfiles"] as const) {
      if (digest(environment[key]) !== digest(env[key])) throw new Error(`Source ${s.definition.id}: incompatible bootstrap ${key}`);
    }
    if (env.communication) {
      environment.communication ??= { chatopsConnections: {} };
      if (environment.communication.durableProvider && env.communication.durableProvider && digest(environment.communication.durableProvider) !== digest(env.communication.durableProvider)) throw new Error("Conflicting durable transport providers");
      environment.communication.durableProvider ??= env.communication.durableProvider;
      for (const [alias, connection] of Object.entries(env.communication.chatopsConnections)) {
        const previous = environment.communication.chatopsConnections[alias];
        if (previous && digest(previous) !== digest(connection)) throw new Error(`Conflicting communication ownership: ${alias}`);
        environment.communication.chatopsConnections[alias] = connection;
      }
    }
  }
  if (environment.bundledProfiles && Object.keys(environment.bundledProfiles).length) throw new Error("Team publication requires standalone agents; bundled migration must be explicitly planned");
  // All inputs share the bootstrap environment. Distribution names remain source-owned.
  for (const s of loaded) {
    errors([...s.contracts.findings, ...s.env.findings]);
    if (!/^[a-f0-9]{40}$/.test(s.sha) || /^0+$/.test(s.sha)) throw new Error("Unresolved source revision");
    const declared = s.definition.agents.map(a => a.name).sort();
    if (digest(declared) !== digest(s.contracts.contracts.map(c => c.profile).sort())) throw new Error(`Source ${s.definition.id}: register every authored agent before publishing`);
    for (const c of s.contracts.contracts) {
      const a = s.definition.agents.find(a => a.name === c.profile)!;
      if (c.runtime !== "eve" || c.subdir !== a.subdir) throw new Error(`${c.profile}: runtime/subdirectory differs from installation plan`);
    }
  }
  const topology = compile(all, environment, { knownArgoDestinations: plan.argoDestinations, priorFindings: loaded.flatMap(s => [...s.contracts.findings, ...s.env.findings]) });
  errors(topology.findings);
  const catalogue = new Map<string, string>(), revisions = new Map<string, string>();
  const records = new Map<string, WorkspaceProfileRecord>();
  const files = new Map<string, string | Buffer>();
  const connectionOwners = new Map<string, string>();
  const connections = loaded.flatMap(s => {
    const result = compileConnectionsFromRoot(s.root, s.contracts.contracts, undefined);
    if (result) {
      errors(result.result.findings);
      for (const binding of result.result.bindings) {
        const owner = connectionOwners.get(binding.connection);
        if (owner && owner !== s.definition.id) throw new Error(`Connection ${binding.connection} is claimed by multiple source owners`);
        connectionOwners.set(binding.connection, s.definition.id);
      }
    }
    return result?.result.bindings ?? [];
  });
  const connFiles = connectionFiles(connections);
  const gateway = parse(connFiles.get("deployments/connections/gateway.yaml")!)?.spec?.connections ?? [];
  const workspaces: NormalizedWorkspaceBinding[] = [];
  const nexusSources: NexusSource[] = [], deployments: NexusDeployment[] = [];
  for (const s of loaded) {
    const dirs = discoverContractDirs(s.root);
    for (const c of s.contracts.contracts) {
      const a = s.definition.agents.find(a => a.name === c.profile)!;
      const dir = dirs.find(d => d.subdir === c.subdir);
      if (!dir) throw new Error(`Missing source for ${c.profile}`);
      catalogue.set(c.profile, fs.readFileSync(agentLayout(dir.dir).agentFile, "utf8"));
      revisions.set(c.profile, s.sha);
      const text = renderRecord(s, a);
      const record = parse(text);
      if (record?.spec?.sha !== s.sha || record?.spec?.source !== s.definition.repository || record?.spec?.sourceSubdir !== a.subdir) throw new Error(`${a.name}: rendered provenance mismatch`);
      if (s.definition.private && record.spec.gitAuthSecretRef !== a.gitAuthSecretRef) throw new Error(`${a.name}: provisioned Git credential is not bound in its source declaration`);
      files.set(`profiles/${c.profile}/profile.yaml`, text);
      records.set(c.profile, record.spec);
      deployments.push({ profile: c.profile, repository: s.definition.repository, sha: s.sha, runtime: "eve", subdir: a.subdir });
    }
    const workspaceFile = path.join(s.root, "harness-hg/workspaces.yaml");
    if (fs.existsSync(workspaceFile)) {
      const ownRecords = new Map(s.contracts.contracts.map(c => [c.profile, records.get(c.profile)!]));
      const compiled = compileWorkspaceBindings(loadWorkspaceDeclarations(workspaceFile), ownRecords, { requireResolution: true });
      errors(compiled.findings); workspaces.push(...compiled.bindings);
    }
    const localTopology = compile(s.contracts.contracts, s.env.environment, { knownArgoDestinations: plan.argoDestinations });
    errors(localTopology.findings);
    nexusSources.push({ id: s.definition.id, repository: s.definition.repository, sha: s.sha,
      inputsHash: digest({ sha: s.sha, environment: s.env.environment, profiles: s.definition.agents }),
      dashboard: loadDashboard(s.root), topology: localTopology,
      profileIdentities: Object.fromEntries(s.definition.agents.map(a => [a.name, { runtime: "eve", subdir: a.subdir }])) });
  }
  const rendered = renderTree(ordered[0]!.root, all, topology, environment, {
    sourceSha: "0".repeat(40), sourceShaByProfile: revisions, catalogue, environmentSource: envPath,
    routerImage: plan.routerImage, observerUrl: plan.observerUrl, connections: { files: connFiles, gateway },
  });
  for (const [key, value] of rendered) files.set(key, value);
  // Keep per-team operational identity even though placement is compiled globally.
  for (const s of loaded) for (const instance of topology.agents.filter(a => s.definition.agents.some(x => x.name === a.profile))) {
    const key = `deployments/agents/${instance.id.replace(/[@/]/g, "-")}/deployment.yaml`;
    const value = parse(String(files.get(key)));
    const team = parse(fs.readFileSync(path.join(s.root, "harness-hg/team.yaml"), "utf8"));
    value.spec.distribution = { name: team.name ?? s.definition.id, displayName: team.displayName ?? team.name ?? s.definition.id };
    files.set(key, dump(value));
    const valuesKey = key.replace("deployment.yaml", "values.yaml");
    const values = parse(String(files.get(valuesKey)));
    const definition = s.definition.agents.find(a => a.name === instance.profile);
    // A pinned agent deploys its own image and tells the build container which Eve to expect; an
    // unpinned one renders exactly as before, so an installation that pins nothing is unchanged.
    const runtime = definition ? effectiveRuntime(plan, definition) : { image: plan.runtime.image, eveVersion: "" };
    const [repository, digest] = runtime.image.split("@");
    values.runtimeImage = { repository, digest, ...(definition?.runtime ? { eveVersion: runtime.eveVersion } : {}) };
    // Version 2 omits the chart revision: the owner's charts come from its own locked source commit.
    const chartSource = definition?.appChartSource;
    applyBootstrapChartSource(values, chartSource && { repository: chartSource.repository, revision: chartSource.revision ?? s.sha }, instance.profile);
    files.set(valuesKey, dump(values));
  }
  const aggregate = parse(String(files.get("deployments/plan.yaml")));
  aggregate.inputsHash = digest({ sources: ordered.map(s => ({ id: s.definition.id, sha: s.sha })), environment, registry: plan.sources });
  files.set("deployments/plan.yaml", dump(aggregate));
  for (const [key, value] of workspaceFiles(workspaces, new Set(), plan.terminalCwds)) files.set(key, value);
  const avatars = loadAvatarInventory(path.join(PLATFORM_ROOT, "control-plane/nexus/avatars"));
  const fonts = loadFontInventory(path.join(PLATFORM_ROOT, "control-plane/nexus/fonts"));
  const nexus = compileNexusSourceSet(nexusSources, deployments, { avatarIds: selectableAvatarIds(avatars),
    workloadEndpoints: plan.workloadEndpoints ? loadWorkloadEndpoints(path.resolve(bootstrapRoot, plan.workloadEndpoints)) : undefined });
  errors(nexus.findings);
  const icons = nexusSources.flatMap(s => s.dashboard.icons);
  for (const [key, value] of renderNexusTree(nexus.plan, icons, avatars, fonts)) {
    if (files.has(key)) throw new Error(`Compilers collided at ${key}`);
    files.set(key, value);
  }
  files.set("deployments/dashboard/sources.json", `${JSON.stringify({ version: 1, sources: nexus.provenance }, null, 2)}\n`);
  for (const profile of records.keys()) if (!topology.agents.some(a => a.profile === profile)) throw new Error(`${profile}: no ApplicationSet-discoverable deployment`);
  const fingerprint = digest([...files].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, Buffer.from(value).toString("base64")]));
  return { files, fingerprint, profiles: [...records.keys()].sort() };
}
