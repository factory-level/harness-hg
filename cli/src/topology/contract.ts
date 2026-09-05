// Loading + validation of authored contracts for the topology compiler
// (design 10, ADR-33). Pure filesystem reads - no cluster, no state.json,
// and NOTHING from the repository is ever executed.
//
// The published schemas ARE the runtime validators (the eval.ts pattern):
// a file carrying `contractVersion: 3` validates against v1alpha3, one
// carrying `contractVersion: 2` against v1alpha2, an unmarked file
// against v1alpha1, and adaptV1 projects the legacy shape onto the one
// input shape the compiler consumes - under the default single-target
// environment that adaptation reproduces today's fleet exactly.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import { CONTRACTS_ROOT, PLATFORM_ROOT } from "../lib.ts";
import type { ValidationFinding } from "../platform/index.ts";
import {
  CONTRACT_DIRNAME,
  HARNESSES,
  SRC_DIRNAME,
  agentLayout,
  readAgentDeclaration,
  readTeam,
  readTeamApps,
} from "../layout.ts";

const EXT_SCHEMAS = path.join(CONTRACTS_ROOT, "hermes-gitops-extension");

// strictTypes off: the v1alpha2 agent-endpoint variant composes `$ref`
// with a bare `not: {required: [service]}`, which Ajv's strict mode
// flags (harmlessly) for lacking a type keyword. The schema is frozen;
// the validator setting is ours.
const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
function compileSchema(file: string): ValidateFunction {
  return ajv.compile(JSON.parse(fs.readFileSync(file, "utf8")));
}
const validateV1 = compileSchema(path.join(EXT_SCHEMAS, "v1alpha1", "hermes-gitops.schema.json"));
const validateV2 = compileSchema(path.join(EXT_SCHEMAS, "v1alpha2", "hermes-gitops.schema.json"));
const validateV3 = compileSchema(path.join(EXT_SCHEMAS, "v1alpha3", "hermes-gitops.schema.json"));
const validateV4 = compileSchema(path.join(EXT_SCHEMAS, "v1alpha4", "hermes-gitops.schema.json"));
const validateV5 = compileSchema(path.join(EXT_SCHEMAS, "v1alpha5", "hermes-gitops.schema.json"));

/** The agent runtime a contract runs on (ADR-149). `hermes` is the legacy
 * runtime and the default; `eve` is selected by the v5 runtime block. */
export type AgentRuntime = "hermes" | "eve";

export function schemaErrorLines(file: string, errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const detail =
      "additionalProperty" in e.params ? ` (${JSON.stringify(e.params["additionalProperty"])})` : "";
    return `${file}: ${e.instancePath || "/"} ${e.message ?? "invalid"}${detail}`;
  });
}

// ---------------------------------------------------------------------------
// The one input shape (v2 semantics; v1 files are adapted onto it)

export type Layout = "single" | "replicated" | "hub-spoke";
export type AgentMultiplicity = "singleton" | "per-region" | "per-target";
export type AppMultiplicity = AgentMultiplicity | "per-agent";
export type DataBoundary = "global" | "region" | "target";
export type EndpointType =
  | "internal"
  | "private"
  | "authenticated"
  | "public"
  | "webhook"
  | "external";

export interface Endpoint {
  name: string;
  service?: string; // app endpoints only; agent endpoints are pod-backed
  port: number;
  path: string;
  type: EndpointType;
  signature?: string;
  provides?: string;
}

// --- Communication plane (contract v3). Routes and outputs are logical
// intent only; providers, transports, and credentials come from
// environment/communication.yaml. An agent output targets a HANDLER on
// the destination profile's own Hermes gateway - the communication plane
// delivers TO that gateway and never replaces it.

export interface OutputDecl {
  name: string;
  event: string; // e.g. observability.alert/v1
  schema?: string; // repo-relative payload schema path
  subject?: string; // payload dot-path -> envelope.subject (FIFO/session identity)
  adapter?: { type: "webhook"; inject?: { appValue?: { path: string } } };
}

export interface SessionPolicy {
  mode: "per-event" | "keyed" | "route";
  key?: string; // required when mode === "keyed" (schema-enforced)
}

export interface DeliveryPolicy {
  mode: "direct" | "queued";
  guarantee?: "at-least-once";
  retry?: { maxAttempts?: number; backoff?: "fixed" | "exponential" };
  deadLetter?: { enabled?: boolean; retention?: string };
  ordering?: { mode: "fifo"; key: string; onFailure?: "block" | "dead-letter-and-continue" };
}

export interface AgentOutputTarget {
  profile: string;
  handler: string;
  session?: SessionPolicy;
  delivery?: DeliveryPolicy;
}

export interface RouteOutput {
  agent?: AgentOutputTarget;
  chatops?: string; // <alias>#<opaque-destination>
  delivery?: DeliveryPolicy;
}

export interface RouteDecl {
  name: string;
  from: { app?: string; output?: string; externalInput?: string };
  filter?: Record<string, string | number | boolean>;
  delivery?: DeliveryPolicy;
  outputs: RouteOutput[];
}

export interface ExternalInputDecl {
  name: string;
  event: string;
  schema?: string;
  subject?: string; // payload dot-path -> envelope.subject
  provider?: string;
  verification: { type: string; secretRef: { name: string; key: string } };
  accepts?: string[];
}

export interface CommunicationDecl {
  routes: RouteDecl[];
  externalInputs: ExternalInputDecl[];
}

export interface AppDecl {
  name: string;
  chart: string;
  repo: string;
  version?: string;
  values?: Record<string, unknown>; // authored defaults (doctor --deep renders with them)
  multiplicity: AppMultiplicity;
  dataBoundary: DataBoundary;
  endpoints: Endpoint[];
  outputs: OutputDecl[]; // typed events this app produces (v3; empty before)
}

export interface Requirement {
  capability: string;
  locality: "same-target" | "same-region" | "global";
  /** v1alpha4: an unsatisfied optional requirement is a warning and an
   * absent injection, never TOPO004. Default false - absent means
   * required, the same conservative default envRequires applies. */
  optional: boolean;
  inject: { env?: string; appValue?: { app: string; path: string } };
}

export interface Contract {
  profile: string; // distribution.yaml name = instance identity
  subdir: string;
  contractVersion: 1 | 2 | 3 | 4 | 5; // 1 = adapted legacy file (no marker)
  runtime: AgentRuntime; // ADR-149: hermes unless the v5 runtime block says eve
  supportedLayouts: Layout[];
  agent: { multiplicity: AgentMultiplicity; dataBoundary: DataBoundary };
  endpoints: Endpoint[]; // the agent's own
  apps: AppDecl[];
  requires: Requirement[];
  envRequires: string[]; // distribution.yaml env_requires names (TOPO014)
  communication?: CommunicationDecl; // v3 only
}

// ---------------------------------------------------------------------------
// Discovery (the same catalogue convention as hg onboard/eval)

/** Read a distribution.yaml's name + env_requires, loudly on a missing name. */
function readDistribution(dir: string): { name: string; envRequires: string[] } {
  const manifest = path.join(dir, "distribution.yaml");
  const doc = parseYaml(fs.readFileSync(manifest, "utf8")) as {
    name?: string;
    env_requires?: (string | { name?: string })[];
  };
  if (!doc?.name) throw new Error(`${manifest} has no name:`);
  // The name becomes directory names in generated trees and instance ids -
  // enforce the platform's rule (DNS-1123 label, max 40) at the source so
  // no traversal-shaped name ever reaches a path join.
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(doc.name) || doc.name.length > 40) {
    throw new Error(`${manifest}: name ${JSON.stringify(doc.name)} is not a DNS-1123 label (max 40 chars)`);
  }
  const envRequires = (doc.env_requires ?? [])
    .map((e) => (typeof e === "string" ? e : (e?.name ?? "")))
    .filter(Boolean);
  return { name: doc.name, envRequires };
}

/** One discovered contract directory. `runtime` is what the DIRECTORY
 * SHAPE says (a distribution.yaml is a Hermes profile; package.json +
 * agent/ is an Eve project, ADR-149); the v5 file's runtime block is
 * checked against it in loadContracts. */
export interface ContractDir {
  dir: string;
  subdir: string;
  runtime: AgentRuntime;
}

/** Read an Eve project's identity: package.json `name`, the same DNS-1123
 * rule as a distribution name (it becomes directory names and instance
 * ids). Loud on a missing or unusable name. */
export function readEveProjectName(dir: string): string {
  const pkgFile = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { name?: unknown };
  const name = pkg?.name;
  if (typeof name !== "string" || !name) throw new Error(`${pkgFile} has no "name"`);
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 40) {
    throw new Error(
      `${pkgFile}: name ${JSON.stringify(name)} is not a DNS-1123 label (max 40 chars) - the ` +
        "package name is the agent's identity",
    );
  }
  return name;
}

/** Is `dir` an Eve project: package.json + agent/ + a hermes-gitops.yaml
 * (the v5 file is what declares the runtime; without it the directory is
 * just an npm package the platform does not own). */
function isEveProjectDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "package.json")) &&
    fs.existsSync(path.join(dir, "agent")) &&
    fs.statSync(path.join(dir, "agent")).isDirectory() &&
    fs.existsSync(path.join(dir, "hermes-gitops.yaml"))
  );
}

/** Root distribution.yaml, else every distributions/<x> and
 * .hermes-dist/<x> carrying one (main.ts discoverProfiles, made reusable
 * here so topology never needs state.json), PLUS every agents/<x> that is
 * an Eve project (ADR-149). One catalogue may hold both runtimes. */
export function discoverContractDirs(root: string): ContractDir[] {
  const found: ContractDir[] = [];
  // A root distribution.yaml is the single-profile layout; an agents/
  // tree beside it still counts (a Hermes profile repo adopting its first
  // Eve agent), so discovery does not stop here.
  if (fs.existsSync(path.join(root, "distribution.yaml"))) found.push({ dir: root, subdir: "", runtime: "hermes" });
  // A root that IS one Eve project (`eve init`'s layout: package.json +
  // agent/ + hermes-gitops.yaml at the top) - the single-agent repository,
  // and how one member of an agents/ catalogue is onboarded on its own.
  if (isEveProjectDir(root)) found.push({ dir: root, subdir: "", runtime: "eve" });
  for (const catalogueDir of ["distributions", ".hermes-dist"]) {
    const base = path.join(root, catalogueDir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base).sort()) {
      const subdir = path.join(catalogueDir, entry);
      if (fs.existsSync(path.join(root, subdir, "distribution.yaml"))) {
        found.push({ dir: path.join(root, subdir), subdir, runtime: "hermes" });
      }
    }
  }
  const agentsBase = path.join(root, "agents");
  if (fs.existsSync(agentsBase) && fs.statSync(agentsBase).isDirectory()) {
    for (const entry of fs.readdirSync(agentsBase).sort()) {
      const subdir = path.join("agents", entry);
      if (isEveProjectDir(path.join(root, subdir))) {
        found.push({ dir: path.join(root, subdir), subdir, runtime: "eve" });
        continue;
      }
      // The agent-team layout (ADR 0178): agents/<harness>/<name>/harness-hg/
      // agent.yaml declares the agent; agents/<harness>/<name>/src/ is the
      // payload the harness installs and IS the contract dir downstream
      // (its subdir becomes the record's sourceSubdir). The harness is the
      // path segment - a positive fact, never inferred from marker files.
      if (!(HARNESSES as readonly string[]).includes(entry)) continue;
      const harnessBase = path.join(root, subdir);
      if (!fs.statSync(harnessBase).isDirectory()) continue;
      for (const name of fs.readdirSync(harnessBase).sort()) {
        const agentDir = path.join(harnessBase, name);
        if (!fs.existsSync(path.join(agentDir, CONTRACT_DIRNAME, "agent.yaml"))) continue;
        const srcSubdir = path.join(subdir, name, SRC_DIRNAME);
        found.push({ dir: path.join(root, srcSubdir), subdir: srcSubdir, runtime: entry as AgentRuntime });
      }
    }
  }
  if (found.length === 0) {
    throw new Error(
      `${root} has no distribution.yaml, no distributions/*/ or .hermes-dist/*/ profiles, ` +
        "no agents/*/ Eve projects (package.json + agent/ + hermes-gitops.yaml) and no " +
        "agents/<harness>/<name>/harness-hg/agent.yaml agents - not a profile directory or catalogue",
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// v1 -> one shape

const LEGACY_DEFAULTS = {
  supportedLayouts: ["single"] as Layout[],
  agent: { multiplicity: "singleton", dataBoundary: "target" } as Contract["agent"],
  app: { multiplicity: "per-agent", dataBoundary: "target" } as {
    multiplicity: AppMultiplicity;
    dataBoundary: DataBoundary;
  },
};

/** v1 expose.access.policy -> endpoint type: absent/service-token carry
 * machine-client semantics (the tunnel's default policy), idp/mixed carry
 * a person behind the IdP. */
function legacyEndpointType(policy: string | undefined): EndpointType {
  return policy === "idp" || policy === "mixed" ? "authenticated" : "external";
}

interface RawExtension {
  contractVersion?: number;
  runtime?: { kind?: AgentRuntime; envRequires?: (string | { name?: string })[] };
  topology?: {
    supportedLayouts?: Layout[];
    agent?: { multiplicity?: AgentMultiplicity; dataBoundary?: DataBoundary };
  };
  endpoints?: Endpoint[];
  requires?: {
    capability: string;
    locality?: Requirement["locality"];
    optional?: boolean;
    inject: Requirement["inject"];
  }[];
  apps?: {
    name: string;
    chart: string;
    repo: string;
    version?: string;
    values?: Record<string, unknown>;
    topology?: { multiplicity?: AppMultiplicity; dataBoundary?: DataBoundary };
    endpoints?: Endpoint[];
    outputs?: OutputDecl[];
  }[];
  expose?: { services: { name: string; port: number; path?: string }[]; access?: { policy?: string } };
  communication?: { routes?: RouteDecl[]; externalInputs?: ExternalInputDecl[] };
}

function toContract(
  profile: string,
  subdir: string,
  envRequires: string[],
  raw: RawExtension,
): Contract {
  const isV2 = raw.contractVersion !== undefined;
  const agent = {
    multiplicity: raw.topology?.agent?.multiplicity ?? LEGACY_DEFAULTS.agent.multiplicity,
    dataBoundary: raw.topology?.agent?.dataBoundary ?? LEGACY_DEFAULTS.agent.dataBoundary,
  };
  const endpoints: Endpoint[] = (raw.endpoints ?? []).map((e) => ({ ...e, path: e.path ?? "/" }));
  if (raw.expose) {
    // Project legacy exposure onto typed endpoints - for v1 files this IS
    // the adaptation; a v2 file may legally carry both blocks (the record
    // still renders expose), so only services not already declared as
    // endpoints are projected, never double-counted.
    const type = legacyEndpointType(raw.expose.access?.policy);
    const declared = new Set(endpoints.map((e) => e.name));
    for (const svc of raw.expose.services) {
      if (declared.has(svc.name)) continue;
      endpoints.push({ name: svc.name, port: svc.port, path: svc.path ?? "/", type });
    }
  }
  return {
    profile,
    subdir,
    contractVersion:
      raw.contractVersion === 5 ? 5 : raw.contractVersion === 4 ? 4 : raw.contractVersion === 3 ? 3 : isV2 ? 2 : 1,
    runtime: raw.runtime?.kind ?? "hermes",
    supportedLayouts: raw.topology?.supportedLayouts ?? LEGACY_DEFAULTS.supportedLayouts,
    agent,
    endpoints,
    apps: (raw.apps ?? []).map((a) => ({
      name: a.name,
      chart: a.chart,
      repo: a.repo,
      version: a.version,
      values: a.values,
      multiplicity: a.topology?.multiplicity ?? LEGACY_DEFAULTS.app.multiplicity,
      dataBoundary: a.topology?.dataBoundary ?? LEGACY_DEFAULTS.app.dataBoundary,
      endpoints: (a.endpoints ?? []).map((e) => ({ ...e, path: e.path ?? "/" })),
      outputs: a.outputs ?? [],
    })),
    requires: (raw.requires ?? []).map((r) => ({
      capability: r.capability,
      locality: r.locality ?? "global",
      optional: r.optional ?? false,
      inject: r.inject,
    })),
    envRequires,
    communication: raw.communication
      ? {
          routes: raw.communication.routes ?? [],
          externalInputs: raw.communication.externalInputs ?? [],
        }
      : undefined,
  };
}


/** Reconstruct a legacy contract from an emitted v1 profile RECORD - the
 * upgrade path, where the GitOps repo holds records but no authored
 * files. The record's extension-shaped fields (apps, deployment, expose,
 * backup, gitAuthSecretRef) ARE the resolved v1 contract; envRequires
 * rides along for TOPO014. */
export function contractFromRecord(
  name: string,
  spec: Record<string, unknown>,
): { contract: Contract; authored: string } {
  const raw: RawExtension = {
    apps: spec["apps"] as RawExtension["apps"],
    expose: spec["expose"] as RawExtension["expose"],
  };
  const authoredDoc: Record<string, unknown> = {};
  for (const key of ["apps", "deployment", "expose", "backup", "gitAuthSecretRef"]) {
    if (spec[key] !== undefined) authoredDoc[key] = spec[key];
  }
  const contract = toContract(
    name,
    "",
    Array.isArray(spec["envRequires"]) ? (spec["envRequires"] as string[]) : [],
    { ...raw, apps: (spec["apps"] as RawExtension["apps"]) ?? [] },
  );
  const header =
    "# Reconstructed from profiles/" + name + "/profile.yaml by `hg gitops upgrade`.\n" +
    "# The RESOLVED v1 contract (operator overrides already merged); the\n" +
    "# authored source of truth stays in the profile repository.\n";
  return { contract, authored: header + yamlStringify(authoredDoc, { sortMapEntries: true, lineWidth: 0 }) };
}

// ---------------------------------------------------------------------------
// Load

export interface LoadResult {
  contracts: Contract[];
  findings: ValidationFinding[]; // schema violations, per profile
}

/** Load and validate every contract in a repository. A profile without a
 * hermes-gitops.yaml is a valid contract with no infra intent (agent
 * only). Schema violations become findings, not throws - the compiler
 * reports every broken profile at once. */
export function loadContracts(root: string): LoadResult {
  const contracts: Contract[] = [];
  const findings: ValidationFinding[] = [];
  const rel = (f: string) => path.relative(root, f);
  // The team declaration (agent-team layout, ADR 0178): read once; a
  // schema-invalid team.yaml is one finding, an agents/<harness>/ dir the
  // team does not list is one finding per agent below.
  const teamRead = readTeam(root);
  for (const f of teamRead.findings) {
    findings.push({ profile: "team", severity: "error", check: "contract-schema", message: `${rel(f.file)}: ${f.message}`, file: rel(f.file) });
  }
  // The team's apps: read ONCE, findings reported once (not per agent).
  const teamApps = teamRead.team ? readTeamApps(path.join(root, CONTRACT_DIRNAME)) : { apps: [], findings: [] };
  for (const f of teamApps.findings) {
    findings.push({ profile: "team", severity: "error", check: "contract-schema", message: `${rel(f.file)}: ${f.message}`, file: rel(f.file) });
  }
  const dirs = discoverContractDirs(root);
  for (const { dir, subdir, runtime } of dirs) {
    const layout = agentLayout(dir);
    if (!layout.legacy) {
      // src/ is the payload; a contract with nothing to install is a
      // finding here, not a throw from the manifest readers below.
      if (!fs.existsSync(dir)) {
        findings.push({
          profile: layout.name!, severity: "error", check: "contract-layout",
          message: `${rel(layout.agentDir!)}/ has harness-hg/agent.yaml but no ${SRC_DIRNAME}/ payload to install`,
          file: rel(layout.agentFile),
        });
        continue;
      }
      // A schema-invalid team.yaml was reported once above; its agents are
      // simply not loaded (no "missing team" finding on top).
      if (teamRead.findings.length > 0 || teamApps.findings.length > 0) continue;
      if (!teamRead.team) {
        findings.push({
          profile: layout.name!, severity: "error", check: "contract-team",
          message: `${rel(layout.agentFile)}: an agents/<harness>/<name>/ agent needs ${CONTRACT_DIRNAME}/team.yaml at the repo root`,
          file: rel(layout.agentFile),
        });
        continue;
      }
      if (layout.harness && !teamRead.team.harnesses.includes(layout.harness)) {
        findings.push({
          profile: layout.name!, severity: "error", check: "contract-team",
          message: `${rel(layout.agentFile)}: harness ${layout.harness} is not listed in ${CONTRACT_DIRNAME}/team.yaml harnesses`,
          file: rel(path.join(root, CONTRACT_DIRNAME, "team.yaml")),
        });
        continue;
      }
    }
    // Identity + env requirements come from the runtime's own manifest:
    // distribution.yaml for Hermes; package.json (name) and the v5 file's
    // runtime.envRequires for Eve (ADR-149), read below once validated.
    let name: string;
    let envRequires: string[];
    if (runtime === "eve") {
      name = readEveProjectName(dir);
      envRequires = [];
    } else {
      ({ name, envRequires } = readDistribution(dir));
    }
    if (!layout.legacy && name !== layout.name) {
      findings.push({
        profile: layout.name!, severity: "error", check: "contract-identity",
        message: `${rel(layout.agentDir!)}/: the directory name is the agent's identity, but ${rel(dir)}'s manifest names it ${JSON.stringify(name)}`,
        file: rel(layout.agentFile),
      });
      continue;
    }
    const extFile = layout.agentFile;
    const read = readAgentDeclaration(dir, layout.legacy ? undefined : teamApps.apps);
    if (read.findings.length > 0) {
      for (const f of read.findings) {
        findings.push({ profile: name, severity: "error", check: "contract-schema", message: `${rel(f.file)}: ${f.message}`, file: rel(f.file) });
      }
      continue;
    }
    const raw = read.raw as RawExtension;
    if (layout.legacy ? fs.existsSync(extFile) : true) {
      const validator =
        raw.contractVersion === 5
          ? validateV5
          : raw.contractVersion === 4
          ? validateV4
          : raw.contractVersion === 3
            ? validateV3
            : raw.contractVersion !== undefined
              ? validateV2
              : validateV1;
      if (!validator(raw)) {
        // For the agent-team layout this is the fold's own proof: the
        // folded document must be a valid legacy authoring, or the split
        // files declared something the record could never carry.
        const relFile = layout.legacy ? rel(extFile) : `${rel(layout.contractDir)}/ (folded)`;
        for (const line of schemaErrorLines(relFile, validator.errors)) {
          findings.push({
            profile: name,
            severity: "error",
            check: "contract-schema",
            message: line,
            file: rel(extFile),
          });
        }
        continue; // a schema-invalid contract never reaches the compiler
      }
    }
    // The directory shape and the v5 runtime block must agree: an agents/
    // project whose file names no runtime (or a distribution whose file
    // says eve) is a contract nobody can build. Finding, not throw - the
    // compiler reports every broken profile at once.
    const declared: AgentRuntime = raw.runtime?.kind ?? "hermes";
    if (declared !== runtime) {
      const relFile = rel(extFile);
      findings.push({
        profile: name,
        severity: "error",
        check: "contract-runtime",
        message:
          runtime === "eve"
            ? `${relFile}: an agents/<name>/ Eve project must declare contractVersion: 5 with runtime: {kind: eve}`
            : `${relFile}: runtime.kind is eve but the directory is a Hermes distribution (distribution.yaml); Eve projects live at agents/<name>/`,
        file: relFile,
      });
      continue;
    }
    if (runtime === "eve") {
      envRequires = (raw.runtime?.envRequires ?? [])
        .map((e) => (typeof e === "string" ? e : (e?.name ?? "")))
        .filter(Boolean);
    }
    contracts.push(toContract(name, subdir, envRequires, raw));
  }
  // Team apps (agent-team layout): every app names an owner that exists;
  // an (owner, name) pair is declared once; and a SINGLETON app name is
  // unique across the team - two agents cannot each declare the same
  // board, which is the whole point of the lift. A per-agent app
  // (monitoring) legitimately repeats under every owner: its instances
  // are scoped by the owner already.
  if (teamRead.team) {
    const known = new Set(dirs.map((d) => agentLayout(d.dir).name).filter(Boolean));
    const seenPair = new Set<string>();
    const singletonOwner = new Map<string, string>();
    const appsFile = path.join(CONTRACT_DIRNAME, "apps.yaml");
    for (const app of teamApps.apps) {
      if (!known.has(app.agent)) {
        findings.push({
          profile: app.agent, severity: "error", check: "apps-owner",
          message: `${appsFile}: app ${app.name} is owned by ${JSON.stringify(app.agent)}, which is no agents/<harness>/<name>/ in this repo`,
          file: appsFile,
        });
      }
      const pair = `${app.agent}/${app.name}`;
      if (seenPair.has(pair)) {
        findings.push({
          profile: app.agent, severity: "error", check: "apps-unique",
          message: `${appsFile}: app ${app.name} is declared twice under ${app.agent}`,
          file: appsFile,
        });
      }
      seenPair.add(pair);
      const topo = app["topology"] as { multiplicity?: string } | undefined;
      if (topo?.multiplicity === "singleton") {
        const prior = singletonOwner.get(app.name);
        if (prior && prior !== app.agent) {
          findings.push({
            profile: app.agent, severity: "error", check: "apps-unique",
            message: `${appsFile}: singleton app ${app.name} is declared by both ${prior} and ${app.agent} - one singleton, one owner (a second declaration deploys a second one)`,
            file: appsFile,
          });
        }
        singletonOwner.set(app.name, app.agent);
      }
    }
  }
  return { contracts, findings };
}
