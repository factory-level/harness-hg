// The environment authority for the topology compiler: what exists
// (environment/topology.yaml) and what is allowed (environment/policy.yaml),
// validated against the published environment-topology/v1alpha1 schemas.
// When a repository carries no environment files, the compiler synthesizes
// the default single-target environment so every contract compiles
// somewhere - a bare persona repo needs zero operator files.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/2020";
import { CONTRACTS_ROOT, PLATFORM_ROOT } from "../lib.ts";
import type { ValidationFinding } from "../platform/index.ts";
import { schemaErrorLines, type Layout } from "./contract.ts";
import { CONTRACT_DIRNAME, TEAM_API_VERSION, readTeam, teamDir } from "../layout.ts";
import { loadEnvironmentSpec, type EnvironmentGrants } from "../env/spec.ts";

const ENV_SCHEMAS = path.join(CONTRACTS_ROOT, "environment-topology", "v1alpha1");
// The target-free TEAM topology (ADR 0178): layout + regions, no cluster
// names; the cluster half is the environment spec's `grants`.
const TEAM_TOPOLOGY_SCHEMA = path.join(CONTRACTS_ROOT, "agent-team", "v1alpha1", "topology.schema.json");
// v1alpha2 (#348): adds `chatopsConnections.<alias>.inbound`. Every
// v1alpha1 document is valid v1alpha2 and means the same thing - the
// block is optional and its absence is DENY - so the loader validates
// against the newer schema outright rather than dispatching on a version
// key the file does not carry.
//
// Pinned to v1alpha1 this rejected `inbound` as an additional property,
// which meant an operator following the documented contract got a broken
// environment rather than an unenforced one. Caught by Codex reviewing
// wave 2.
const COMM_SCHEMA = path.join(CONTRACTS_ROOT, "environment-communication", "v1alpha2", "communication.schema.json");

const ajv = new Ajv2020({ allErrors: true });
function compileSchema(file: string): ValidateFunction {
  return ajv.compile(JSON.parse(fs.readFileSync(file, "utf8")));
}
const validateTopology = compileSchema(path.join(ENV_SCHEMAS, "topology.schema.json"));
const validatePolicy = compileSchema(path.join(ENV_SCHEMAS, "policy.schema.json"));
const validateCommunication = compileSchema(COMM_SCHEMA);
const validateCapabilities = compileSchema(
  path.join(CONTRACTS_ROOT, "environment-capabilities", "v1alpha1", "capabilities.schema.json"),
);
const validateTeamTopology = compileSchema(TEAM_TOPOLOGY_SCHEMA);

/** One deployment target, flattened with its region context - the unit
 * the compiler places instances onto. */
export interface Target {
  name: string;
  argoDestination: string;
  region: string;
  jurisdiction: string;
  primary: boolean;
}

/** One ChatOps connection alias: which provider plugin backs it and where
 * its credential lives (a reference, never a value). */
export interface ChatopsInbound {
  approvedUsers?: string[];
  approvedRoles?: string[];
  approvedChannels?: string[];
  mentionPolicy?: "require-mention" | "any-message";
  threadPolicy?: string;
}

export interface ChatopsConnection {
  provider: "recording" | "slack" | "generic-webhook";
  credentialRef?: { name?: string; key?: string; env?: string };
  /** #348/#476: who may make this connection DO something. Absent =
   * deny-all at the gateway. Carried through so the emitter can
   * MATERIALIZE it into the gateway's enforced allowlist env vars -
   * authoring the block must not be mistaken for having authorization. */
  inbound?: ChatopsInbound;
}

/** The environment-owned half of the communication plane
 * (environment/communication.yaml). Absent = feature off - a profile
 * declaring ChatOps outputs or queued routes then fails compilation. */
export interface EnvCommunication {
  chatopsConnections: Record<string, ChatopsConnection>;
  durableProvider?: { plugin: string; config?: Record<string, unknown> };
}

/** Where a BUNDLED profile actually listens. Bundling retires the
 * per-profile namespace and Service, so any signal addressed to a
 * profile by name (today: communication edges) has to be redirected
 * here or it resolves to something that does not exist. */
export interface BundledProfile {
  bundle: string;
  namespace: string;
  service: string;
  webhookPort?: number;
  envSecretRef?: string;
  /** The member's declared listen port, when it declared one. */
  apiServerPort?: number;
  /** Position in the bundle's profiles[] - an Eve bundle's members listen
   * on 3000 + index unless apiServerPort says otherwise (eve-bundle chart). */
  memberIndex: number;
  /** True when the declaration named placement.namespace; false when
   * `namespace`/`service` are the Hermes default (`hermes-<bundle>`) and a
   * runtime-aware consumer should re-derive them (ADR-151: an Eve bundle is
   * `ag-eve-<bundle>`). The loader reads declarations, not records, so it
   * cannot know the runtime itself. */
  namespaceDeclared: boolean;
}

/** The bundle's namespace/Service for a member of the given runtime:
 * the declared placement wins, else the runtime's prefix (ADR-151). */
export function bundleCoordinatesFor(placement: BundledProfile, runtime: "hermes" | "eve"): { namespace: string; service: string } {
  if (placement.namespaceDeclared || runtime === "hermes") return { namespace: placement.namespace, service: placement.service };
  return { namespace: `ag-eve-${placement.bundle}`, service: `ag-eve-${placement.bundle}` };
}

/** One environment-provided capability (ADR-98, #144): the operator's
 * answer to "who serves this?" when the answer is not a peer profile.
 * Keyed by capability name in environment/capabilities.yaml; flattened
 * here with the name inside, the shape the compiler consumes. */
export interface EnvCapabilityBinding {
  capability: string;
  implementation: string;
  url: string;
  region?: string;
}

export interface Environment {
  layout: Layout;
  sovereignty: "permissive" | "strict";
  dns: { publicBaseDomain?: string; privateBaseDomain?: string };
  globalTarget?: string;
  regions: { name: string; jurisdiction: string; targets: Target[] }[];
  targets: Target[]; // all, flattened, declaration order
  policy: { allowedChartSources: string[]; allowedJurisdictions?: string[] };
  communication?: EnvCommunication;
  /** profile name -> its bundle placement, when environment/bundles.yaml
   * declares one. Absent for an unbundled fleet. */
  bundledProfiles?: Record<string, BundledProfile>;
  /** Environment-provided capabilities (environment/capabilities.yaml).
   * Absent when the file is absent - most environments provide nothing. */
  capabilityBindings?: EnvCapabilityBinding[];
  /** The installed distribution's identity (environment/bundles.yaml v4
   * `distribution` block): the operational CATEGORY this repository's
   * agents group under beside the Hermes control plane. Compiled into
   * every agent deployment record. */
  distribution?: { name?: string; displayName: string };
  /** The bootstrap's grants (ADR 0178), when an environment spec supplied
   * them. targets/dns/policy/capabilities are already unioned into the
   * fields above; `workspaces` is carried for a consumer that does not
   * exist yet (the workspace compiler runs in the local loop). */
  grants?: EnvironmentGrants;
  synthesized: boolean; // true = the default, no operator files found
}

interface RawTeamTopology {
  apiVersion: string;
  kind: string;
  layout: Layout;
  sovereignty?: { mode?: "permissive" | "strict" };
  hubRegion?: string;
  regions: { name: string; jurisdiction: string }[];
}

interface RawTopology {
  version: number;
  name?: string;
  layout: Layout;
  sovereignty?: { mode?: "permissive" | "strict" };
  dns?: { publicBaseDomain?: string; privateBaseDomain?: string };
  globalTarget?: string;
  regions: {
    name: string;
    jurisdiction: string;
    targets: { name: string; argoDestination: string; primary?: boolean }[];
  }[];
}

/** The environment every bare repository compiles under. */
export function defaultEnvironment(): Environment {
  const target: Target = {
    name: "in-cluster",
    argoDestination: "in-cluster",
    region: "local",
    jurisdiction: "NA",
    primary: true,
  };
  return {
    layout: "single",
    sovereignty: "permissive",
    dns: {},
    globalTarget: "in-cluster",
    regions: [{ name: "local", jurisdiction: "NA", targets: [target] }],
    targets: [target],
    policy: { allowedChartSources: [] },
    synthesized: true,
  };
}

export interface EnvLoadResult {
  environment: Environment;
  findings: ValidationFinding[];
}

/** Load the environment. `root` is the repository: its team-level files
 * (communication, bundles, capabilities, the distribution identity, and
 * the topology when no override is given) always come from ONE directory,
 * `teamDir(root)` - `harness-hg/` for an agent-team repo, `environment/`
 * otherwise. `environment` optionally overrides the CLUSTER half only:
 * a legacy `topology.yaml`-shaped file (policy.yaml is looked up beside
 * it), an environment spec (`infra/environments/<env>.yaml`, whose
 * `grants` supply targets/dns/policy/capabilities for a target-free team
 * topology), or a directory that is read as a whole repository root
 * (the pre-ADR-0178 form). A legacy topology override's DIRECTORY is a
 * named environment variant: a team file that also exists beside the
 * override (communication.yaml in `environments/<name>/`) wins for that
 * file alone; every other team file still comes from the team dir. The
 * bundle-blind golden was the old rule - the override directory replaced
 * the team dir wholesale, so bundles and workspaces silently vanished.
 * Absent everything, the synthesized default applies. Schema violations
 * become findings and the default environment is returned so compilation
 * can still report contract-side problems. */
export function loadEnvironment(root?: string, environment?: string): EnvLoadResult {
  const findings: ValidationFinding[] = [];
  let topologyFile: string | undefined;
  let specFile: string | undefined;
  // A directory override is the old "this directory is the repo" form.
  if (environment && fs.existsSync(environment) && fs.statSync(environment).isDirectory()) {
    root = environment;
    environment = undefined;
  }
  const envDir = root ? teamDir(root) : undefined; // the ONE place team files are looked up
  if (environment) {
    if (fs.existsSync(environment) && fs.statSync(environment).isFile()) {
      const head = parseYaml(fs.readFileSync(environment, "utf8")) as { apiVersion?: unknown } | null;
      if (typeof head?.apiVersion === "string" && head.apiVersion.includes("/environment/")) specFile = environment;
      else topologyFile = environment;
    } else {
      findings.push({
        profile: "*",
        severity: "error",
        check: "environment",
        message: `environment source not found: ${environment}`,
      });
    }
  }
  // A legacy topology override's directory is a named environment variant.
  const overrideDir = topologyFile && topologyFile === environment ? path.dirname(topologyFile) : undefined;
  if (!topologyFile && envDir) {
    const candidate = path.join(envDir, "topology.yaml");
    if (fs.existsSync(candidate)) topologyFile = candidate;
  }
  /** Where one team-level file is read from: beside a legacy override when
   * the variant carries it, else the team dir. */
  const fileFor = (name: string): string | undefined => {
    if (overrideDir && fs.existsSync(path.join(overrideDir, name))) return path.join(overrideDir, name);
    return envDir ? path.join(envDir, name) : undefined;
  };
  // communication.yaml is independent of topology.yaml: a single-cluster
  // local environment may declare ChatOps connections and a durable
  // provider under the synthesized default topology.
  const communication = loadCommunication(fileFor("communication.yaml"), findings);
  const bundledProfiles = loadBundlePlacements(fileFor("bundles.yaml"), findings);
  const capabilityBindings = loadCapabilityBindings(fileFor("capabilities.yaml"), findings);
  const distribution = root ? loadDistributionIdentity(root, fileFor("bundles.yaml"), findings) : undefined;
  const grants = specFile ? loadGrants(specFile, findings) : undefined;
  if (!topologyFile) {
    const base = grants
      ? unionTeamEnvironment(undefined, grants, undefined, capabilityBindings, findings)
      : { ...defaultEnvironment(), capabilityBindings };
    return {
      environment: { ...base, communication, bundledProfiles, distribution, ...(grants ? { grants } : {}) },
      findings,
    };
  }

  const parsed = parseYaml(fs.readFileSync(topologyFile, "utf8")) as RawTopology | RawTeamTopology;
  if ((parsed as RawTeamTopology)?.apiVersion === TEAM_API_VERSION) {
    const raw = parsed as RawTeamTopology;
    // The team's target-free topology + the bootstrap's grants (ADR 0178).
    if (!validateTeamTopology(raw)) {
      for (const line of schemaErrorLines(topologyFile, validateTeamTopology.errors)) {
        findings.push({ profile: "*", severity: "error", check: "environment", message: line });
      }
      return { environment: defaultEnvironment(), findings };
    }
    const env = unionTeamEnvironment(raw, grants, topologyFile, capabilityBindings, findings);
    return {
      environment: { ...env, communication, bundledProfiles, distribution, ...(grants ? { grants } : {}) },
      findings,
    };
  }
  const raw = parsed as RawTopology;
  if (grants && envDir && topologyFile === path.join(envDir, "topology.yaml")) {
    findings.push({
      profile: "*",
      severity: "warning",
      check: "environment",
      message: `${topologyFile} is a legacy environment topology (it names its own targets); the environment spec's grants are ignored for it`,
    });
  }
  if (!validateTopology(raw)) {
    for (const line of schemaErrorLines(topologyFile, validateTopology.errors)) {
      findings.push({ profile: "*", severity: "error", check: "environment", message: line });
    }
    return { environment: defaultEnvironment(), findings };
  }

  const policyFile = path.join(path.dirname(topologyFile), "policy.yaml");
  let policy: Environment["policy"] = { allowedChartSources: [] };
  if (fs.existsSync(policyFile)) {
    const rawPolicy = parseYaml(fs.readFileSync(policyFile, "utf8")) as {
      allowedChartSources?: string[];
      allowedJurisdictions?: string[];
    } | null;
    if (rawPolicy && !validatePolicy(rawPolicy)) {
      for (const line of schemaErrorLines(policyFile, validatePolicy.errors)) {
        findings.push({ profile: "*", severity: "error", check: "environment", message: line });
      }
    } else if (rawPolicy) {
      policy = {
        allowedChartSources: rawPolicy.allowedChartSources ?? [],
        allowedJurisdictions: rawPolicy.allowedJurisdictions,
      };
    }
  }

  const regions = raw.regions.map((r) => ({
    name: r.name,
    jurisdiction: r.jurisdiction,
    targets: r.targets.map((t, i) => ({
      name: t.name,
      argoDestination: t.argoDestination,
      region: r.name,
      jurisdiction: r.jurisdiction,
      primary: t.primary ?? i === 0,
    })),
  }));
  const targets = regions.flatMap((r) => r.targets);

  // Cross-field checks the schema cannot express.
  const targetNames = new Set(targets.map((t) => t.name));
  if (targetNames.size !== targets.length) {
    findings.push({
      profile: "*",
      severity: "error",
      check: "environment",
      message: `${topologyFile}: duplicate target names across regions`,
    });
  }
  if (raw.globalTarget && !targetNames.has(raw.globalTarget)) {
    findings.push({
      profile: "*",
      severity: "error",
      check: "environment",
      message: `${topologyFile}: globalTarget ${JSON.stringify(raw.globalTarget)} names no declared target`,
    });
  }

  // A capability binding's region must exist - a typo would otherwise
  // surface as TOPO004 blaming the consumer's locality.
  const regionNames = new Set(regions.map((r) => r.name));
  for (const b of capabilityBindings ?? []) {
    if (b.region && !regionNames.has(b.region)) {
      findings.push({
        profile: "*",
        severity: "error",
        check: "environment",
        message: `capabilities.yaml: binding ${b.capability} names region ${JSON.stringify(b.region)}, which topology.yaml does not declare`,
      });
    }
  }

  return {
    environment: {
      layout: raw.layout,
      sovereignty: raw.sovereignty?.mode ?? "permissive",
      dns: raw.dns ?? {},
      globalTarget: raw.globalTarget,
      regions,
      targets,
      policy,
      communication,
      capabilityBindings,
      distribution,
      bundledProfiles,
      synthesized: false,
    },
    findings,
  };
}

/** The bootstrap's grants from an environment spec (v1alpha2). A spec
 * without them is a finding: the caller asked for the cluster half and
 * got nothing. */
function loadGrants(specFile: string, findings: ValidationFinding[]): EnvironmentGrants | undefined {
  let grants: EnvironmentGrants | undefined;
  try {
    grants = loadEnvironmentSpec(specFile).grants;
  } catch (err) {
    findings.push({ profile: "*", severity: "error", check: "environment", message: (err as Error).message });
    return undefined;
  }
  if (!grants) {
    findings.push({
      profile: "*",
      severity: "warning",
      check: "environment",
      message: `${specFile} declares no grants - the team topology's regions get synthesized targets`,
    });
  }
  return grants;
}

/** The union (ADR 0178): the team says what it is built for, the grants
 * say what it gets. TOPO019 - a team region with no granted target, or a
 * grant for a region the team never declared. TOPO018 - a capability
 * declared on both sides. No grants at all synthesizes one target per
 * region (`in-cluster` for a lone region, so the default environment's
 * identity is preserved), marked `synthesized`. */
function unionTeamEnvironment(
  team: RawTeamTopology | undefined,
  grants: EnvironmentGrants | undefined,
  topologyFile: string | undefined,
  teamCapabilities: EnvCapabilityBinding[] | undefined,
  findings: ValidationFinding[],
): Environment {
  const where = topologyFile ?? `${CONTRACT_DIRNAME}/topology.yaml (absent)`;
  const teamRegions = team?.regions ?? [{ name: "local", jurisdiction: "NA" }];
  // Any grants block at all means the bootstrap spoke: a region it gave no
  // target is TOPO019, never a synthesized stand-in. Only an ABSENT block
  // synthesizes.
  const grantedMode = grants !== undefined;
  const granted = grants?.targets ?? {};
  const regions = teamRegions.map((r) => {
    const g = granted[r.name];
    let targets: Target[];
    if (g) {
      targets = g.map((t, i) => ({
        name: t.name,
        argoDestination: t.argoDestination,
        region: r.name,
        jurisdiction: r.jurisdiction,
        primary: t.primary ?? i === 0,
      }));
    } else {
      if (grantedMode) {
        findings.push({
          profile: "*",
          severity: "error",
          check: "TOPO019",
          message: `${where}: region ${r.name} is declared by the team but the environment grants it no target`,
          fix: `add grants.targets.${r.name} to the environment spec, or drop the region`,
        });
      }
      const name = teamRegions.length === 1 ? "in-cluster" : r.name;
      targets = [{ name, argoDestination: name, region: r.name, jurisdiction: r.jurisdiction, primary: true }];
    }
    return { name: r.name, jurisdiction: r.jurisdiction, targets };
  });
  for (const name of Object.keys(granted)) {
    if (!teamRegions.some((r) => r.name === name)) {
      findings.push({
        profile: "*",
        severity: "error",
        check: "TOPO019",
        message: `environment grants targets to region ${name}, which ${where} does not declare`,
        fix: `declare the region in the team topology, or drop the grant`,
      });
    }
  }
  const targets = regions.flatMap((r) => r.targets);
  const targetNames = new Set(targets.map((t) => t.name));
  if (targetNames.size !== targets.length) {
    findings.push({ profile: "*", severity: "error", check: "environment", message: `${where}: duplicate target names across regions` });
  }
  const grantedNames = new Set(Object.values(granted).flat().map((t) => t.name));
  let globalTarget = grants?.globalTarget;
  if (globalTarget && !grantedNames.has(globalTarget)) {
    findings.push({
      profile: "*",
      severity: "error",
      check: "environment",
      message: `environment grants.globalTarget ${JSON.stringify(globalTarget)} names no granted target`,
    });
  }
  if (!globalTarget) {
    const hub = team?.hubRegion ? regions.find((r) => r.name === team.hubRegion) : regions.length === 1 ? regions[0] : undefined;
    if (team?.hubRegion && !hub) {
      findings.push({
        profile: "*",
        severity: "error",
        check: "environment",
        message: `${where}: hubRegion ${JSON.stringify(team.hubRegion)} names no declared region`,
      });
    }
    globalTarget = hub?.targets.find((t) => t.primary)?.name ?? hub?.targets[0]?.name;
  }
  // Capabilities: the team's bindings + the granted ones; one name on both
  // sides is TOPO018, never a precedence rule.
  const capabilityBindings: EnvCapabilityBinding[] = [...(teamCapabilities ?? [])];
  const grantedCapabilities: EnvCapabilityBinding[] = Object.entries(grants?.capabilities ?? {}).map(
    ([capability, b]) => ({ capability, implementation: b.implementation, url: b.url, region: b.region }),
  );
  for (const b of grantedCapabilities) {
    if (capabilityBindings.some((c) => c.capability === b.capability)) {
      findings.push({
        profile: "*",
        severity: "error",
        check: "TOPO018",
        message: `capability ${b.capability} is bound by both ${CONTRACT_DIRNAME}/capabilities.yaml and the environment's grants - one provider, one side`,
        fix: "keep the binding on the side that owns the implementation and drop the other",
      });
      continue;
    }
    capabilityBindings.push(b);
  }
  const regionNames = new Set(regions.map((r) => r.name));
  // Every binding's region must exist - the colliding ones too, so one
  // finding never hides another.
  for (const b of [...capabilityBindings, ...grantedCapabilities.filter((g) => !capabilityBindings.includes(g))]) {
    if (b.region && !regionNames.has(b.region)) {
      findings.push({
        profile: "*",
        severity: "error",
        check: "environment",
        message: `capability binding ${b.capability} names region ${JSON.stringify(b.region)}, which ${where} does not declare`,
      });
    }
  }
  return {
    layout: team?.layout ?? "single",
    sovereignty: team?.sovereignty?.mode ?? "permissive",
    dns: grants?.dns ?? {},
    globalTarget,
    regions,
    targets,
    policy: {
      allowedChartSources: grants?.policy?.allowedChartSources ?? [],
      allowedJurisdictions: grants?.policy?.allowedJurisdictions,
    },
    capabilityBindings: capabilityBindings.length > 0 ? capabilityBindings : undefined,
    synthesized: !grantedMode,
  };
}

/** The distribution identity block (bundles.yaml v4), read leniently for
 * the same reason as loadBundlePlacements: `hg up` validates the file
 * properly; inspection must not become a second gate on it. */
function loadDistributionIdentity(
  root: string,
  file: string | undefined,
  findings: ValidationFinding[],
): { name?: string; displayName: string } | undefined {
  // The agent-team layout's identity is harness-hg/team.yaml (ADR 0178);
  // bundles.yaml v4's `distribution` block is the legacy form and may not
  // disagree with it.
  const teamRead = readTeam(root);
  const team = teamRead.team;
  if (teamRead.findings.length > 0) {
    // team.yaml exists and is invalid: loadContracts reports the schema
    // errors (same run, same findings list at compile); the identity is
    // simply absent - never the legacy bundles.yaml block by fallback.
    void findings;
    return undefined;
  }
  if (team) {
    if (file && fs.existsSync(file)) {
      try {
        const raw = parseYaml(fs.readFileSync(file, "utf8")) as { distribution?: { name?: string } } | null;
        if (raw?.distribution && raw.distribution.name !== team.name) {
          findings.push({
            profile: "*",
            severity: "error",
            check: "environment",
            message: `${file}: distribution.name ${JSON.stringify(raw.distribution.name)} disagrees with ${CONTRACT_DIRNAME}/team.yaml name ${JSON.stringify(team.name)} - team.yaml is the identity; drop the bundles.yaml block`,
          });
        }
      } catch {
        // loadBundlePlacements already filed the finding
      }
    }
    return { name: team.name, displayName: team.displayName };
  }
  if (!file || !fs.existsSync(file)) return undefined;
  let raw: { distribution?: { name?: string; displayName?: string } } | null;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8")) as typeof raw;
  } catch {
    return undefined; // loadBundlePlacements already filed the finding
  }
  const d = raw?.distribution;
  if (!d || typeof d.displayName !== "string" || !d.displayName.trim()) return undefined;
  void findings;
  return { ...(typeof d.name === "string" && d.name ? { name: d.name } : {}), displayName: d.displayName };
}

/** Load environment/communication.yaml when present. Schema violations
 * become findings and the file is treated as absent (feature off) so the
 * rest of compilation still reports. */
function loadCommunication(
  file: string | undefined,
  findings: ValidationFinding[],
): EnvCommunication | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as {
    chatopsConnections?: Record<string, ChatopsConnection>;
    durableProvider?: { plugin: string; config?: Record<string, unknown> };
  } | null;
  if (!raw) return undefined;
  if (!validateCommunication(raw)) {
    for (const line of schemaErrorLines(file, validateCommunication.errors)) {
      findings.push({ profile: "*", severity: "error", check: "environment", message: line });
    }
    return undefined;
  }
  for (const [alias, connection] of Object.entries(raw.chatopsConnections ?? {})) {
    if (!["recording", "slack", "generic-webhook"].includes(connection.provider)) {
      findings.push({ profile: "*", severity: "error", check: "environment", message: `${file}: ${alias} uses an unsupported provider; Discord is roadmap-only. Configure Slack.` });
      return undefined;
    }
  }
  return {
    chatopsConnections: raw.chatopsConnections ?? {},
    durableProvider: raw.durableProvider,
  };
}


/** Read environment/capabilities.yaml (ADR-98, #144): capabilities the
 * environment provides. A schema violation is an ERROR - unlike
 * bundles.yaml this file has no other validator, and a silently-dropped
 * binding would surface as TOPO004 blaming the wrong side. */
function loadCapabilityBindings(
  file: string | undefined,
  findings: ValidationFinding[],
): EnvCapabilityBinding[] | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as {
    bindings?: Record<string, { implementation: string; url: string; region?: string }>;
  } | null;
  if (!raw) return undefined;
  if (!validateCapabilities(raw)) {
    for (const line of schemaErrorLines(file, validateCapabilities.errors)) {
      findings.push({ profile: "*", severity: "error", check: "environment", message: line });
    }
    return undefined;
  }
  return Object.entries(raw.bindings ?? {}).map(([capability, b]) => ({
    capability,
    implementation: b.implementation,
    url: b.url,
    region: b.region,
  }));
}

/** Read environment/bundles.yaml for PLACEMENT only.
 *
 * The bundle compiler owns validation and emission; this reads the same
 * file for one narrow question - "if I address this profile by name,
 * where does it actually listen?" - because bundling retires the
 * per-profile namespace and Service that a communication edge would
 * otherwise resolve to. A malformed file is a warning here, not an
 * error: `hg up` validates it properly and would fail loudly, and
 * topology inspection should not become a second gate on the same file.
 */
function loadBundlePlacements(
  file: string | undefined,
  findings: ValidationFinding[],
): Record<string, BundledProfile> | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  let raw: {
    bundles?: {
      name?: string;
      placement?: { namespace?: string };
      profiles?: { name?: string; webhookPort?: number; envSecretRef?: string; apiServerPort?: number }[];
    }[];
  } | null;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8")) as typeof raw;
  } catch (err) {
    findings.push({
      profile: "*",
      severity: "warning",
      check: "environment",
      message: `bundles.yaml unreadable (${(err as Error).message}); bundled profiles will not resolve`,
    });
    return undefined;
  }
  const out: Record<string, BundledProfile> = {};
  for (const bundle of raw?.bundles ?? []) {
    if (!bundle?.name) continue;
    const namespace = bundle.placement?.namespace ?? `hermes-${bundle.name}`;
    const namespaceDeclared = typeof bundle.placement?.namespace === "string";
    const bundleName = bundle.name;
    (bundle.profiles ?? []).forEach((profile, memberIndex) => {
      if (!profile?.name) return;
      out[profile.name] = {
        bundle: bundleName,
        namespace,
        // The chart names the Service after the bundle, not the profile.
        service: bundle.placement?.namespace ?? `hermes-${bundle.name}`,
        memberIndex,
        namespaceDeclared,
        ...(profile.webhookPort !== undefined ? { webhookPort: profile.webhookPort } : {}),
        ...(profile.apiServerPort !== undefined ? { apiServerPort: profile.apiServerPort } : {}),
        ...(profile.envSecretRef ? { envSecretRef: profile.envSecretRef } : {}),
      };
    });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
