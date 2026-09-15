// Join validated repositories before compiling one shared Nexus plan. The caller
// supplies the deployment registry; an undeployed source is never silently shown.
import { createHash } from "node:crypto";
import { compileNexus, type NexusInputs } from "./compile.ts";
import type { DashboardLoadResult, ViewDoc } from "./contract.ts";
import type { TopologyPlan } from "../topology/compile.ts";

export interface NexusSource {
  id: string;
  repository: string;
  sha: string;
  inputsHash: string;
  dashboard: DashboardLoadResult;
  topology: TopologyPlan;
  profileIdentities: Record<string, { runtime: string; subdir: string }>;
  bundledProfiles?: NexusInputs["bundledProfiles"];
}
export interface NexusDeployment {
  profile: string;
  repository: string;
  sha: string;
  runtime: string;
  subdir: string;
}

export function compileNexusSourceSet(
  sources: NexusSource[],
  deployments: NexusDeployment[],
  options: Pick<NexusInputs, "avatarIds" | "workloadEndpoints"> = {},
) {
  if (!sources.length || !deployments.length) throw new Error("Nexus source set requires sources and deployed profiles");
  const ordered = [...sources].sort((a, b) => a.id.localeCompare(b.id));
  const sourceIds = new Set<string>(), repositories = new Set<string>();
  const registry = new Map<string, NexusDeployment>();
  for (const d of deployments) {
    if (registry.has(d.profile)) throw new Error(`Duplicate deployed profile: ${d.profile}`);
    registry.set(d.profile, d);
  }
  const claimed = new Set<string>();
  const bundledProfiles: NonNullable<NexusInputs["bundledProfiles"]> = {};
  const dashboard: DashboardLoadResult = { contributions: [], views: [], icons: [], declared: {}, findings: [] };
  const first = ordered[0]!.topology;
  const topology: TopologyPlan = { layout: first.layout, sovereignty: first.sovereignty,
    agents: [], apps: [], endpoints: [], bindings: [], findings: [], ok: true };
  const nodes: ViewDoc["spec"]["nodes"] = [];
  let offset = 0;
  for (const source of ordered) {
    if (!/^[a-z][a-z0-9-]*$/.test(source.id) || sourceIds.has(source.id)) throw new Error(`Invalid or duplicate source id: ${source.id}`);
    if (repositories.has(source.repository)) throw new Error(`Duplicate repository: ${source.repository}`);
    if (!/^[a-f0-9]{40}$/.test(source.sha) || /^0+$/.test(source.sha)) throw new Error(`Source ${source.id} requires a resolved commit`);
    if (!/^[a-f0-9]{64}$/.test(source.inputsHash)) throw new Error(`Source ${source.id} requires an input hash`);
    sourceIds.add(source.id); repositories.add(source.repository);
    if (source.topology.layout !== first.layout || source.topology.sovereignty !== first.sovereignty) {
      throw new Error(`Source ${source.id} uses a different environment layout`);
    }
    const profiles = new Set(source.topology.agents.map(a => a.profile));
    for (const profile of profiles) {
      const deployed = registry.get(profile);
      if (!deployed || deployed.repository !== source.repository || deployed.sha !== source.sha) {
        throw new Error(`Source ${source.id}: ${profile} does not match its deployed repository and commit`);
      }
      const identity = source.profileIdentities[profile];
      if (!identity || identity.runtime !== deployed.runtime || identity.subdir !== deployed.subdir) {
        throw new Error(`Source ${source.id}: ${profile} does not match its deployed runtime and source subdirectory`);
      }
      if (claimed.has(profile)) throw new Error(`Profile contributed by multiple sources: ${profile}`);
      claimed.add(profile);
      if (source.bundledProfiles?.[profile]) bundledProfiles[profile] = source.bundledProfiles[profile]!;
    }
    // Validate each repository independently as well: joining must not repair a
    // dangling relationship by borrowing another repository's private identity.
    const local = compileNexus({ ...source.dashboard, topology: source.topology,
      findings: [...source.dashboard.findings, ...source.topology.findings], ...options,
      bundledProfiles: source.bundledProfiles });
    dashboard.findings.push(...local.findings);
    dashboard.contributions.push(...source.dashboard.contributions.map(f => ({ ...f, relPath: `${source.id}/${f.relPath}` })));
    dashboard.icons.push(...source.dashboard.icons.map(f => ({ ...f, relPath: `${source.id}/${f.relPath}` })));
    for (const [name, facts] of Object.entries(source.dashboard.declared)) {
      if (Object.hasOwn(dashboard.declared, name)) throw new Error(`Duplicate profile facts: ${name}`);
      dashboard.declared[name] = facts;
    }
    // Preserve each source's selected view, including auto-placed components,
    // in deterministic horizontal sections. Default view ids can safely repeat.
    const viewNodes = local.plan.view.nodes;
    const minX = Math.min(0, ...viewNodes.map(n => n.position.x));
    const maxX = Math.max(0, ...viewNodes.map(n => n.position.x));
    nodes.push(...viewNodes.map(n => ({ ...n, position: { ...n.position, x: n.position.x - minX + offset } })));
    offset += maxX - minX + 600;
    topology.agents.push(...source.topology.agents);
    topology.apps.push(...source.topology.apps);
    topology.endpoints.push(...source.topology.endpoints);
    topology.bindings.push(...source.topology.bindings);
  }
  for (const profile of registry.keys()) if (!claimed.has(profile)) throw new Error(`Deployed profile missing from source set: ${profile}`);
  dashboard.views = [{ relPath: "source-set/default.yaml", doc: {
    apiVersion: "dashboard.hermes-gitops/v1alpha2", kind: "NexusView",
    metadata: { id: "default", title: "Agent teams" }, spec: { nodes },
  } }];
  const provenance = ordered.map(({ id, repository, sha, inputsHash }) => ({ id, repository, sha, inputsHash }));
  const inputsHash = createHash("sha256").update(JSON.stringify({ provenance, options, bundledProfiles,
    deployments: [...deployments].sort((a, b) => a.profile.localeCompare(b.profile)) })).digest("hex");
  // No single repository commit describes a multi-repository plan. Preserve the
  // frozen plan schema's unknown marker and record exact commits in a sidecar.
  return { ...compileNexus({ ...dashboard, topology, ...options, bundledProfiles, sourceSha: "0".repeat(40), inputsHash }), provenance };
}
