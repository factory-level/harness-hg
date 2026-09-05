// Where an agent's contract and payload live (ADR 0178) - ONE helper every
// reader routes through. Two layouts, two branches of the same function,
// never two code paths:
//
//   legacy      <dir>/hermes-gitops.yaml beside the payload (distribution.yaml
//               or package.json + agent/); test/dashboard files beside it.
//   agent-team  agents/<harness>/<name>/harness-hg/*.yaml beside the payload
//               at agents/<harness>/<name>/src/; the team's own files at
//               <root>/harness-hg/. `harness-hg/` at any level is exactly
//               what the platform reads.
//
// The agent-team files are FOLDED into the legacy v5 (or v3, when the
// Hermes-only expose block is present) raw shape at load time, so every
// consumer downstream - the compiler, the emitter, the records - sees what
// a legacy authoring would have produced. Byte-identical records are the
// proof this module has to keep.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020";

// Same expression as lib.ts PLATFORM_ROOT; lib.ts imports this module, so
// this module imports nothing from lib.ts.
const PLATFORM_ROOT = path.resolve(import.meta.dir, "..", "..");
const TEAM_SCHEMAS = path.join(PLATFORM_ROOT, "agent-bundle-contracts", "agent-team", "v1alpha1");

export const HARNESSES = ["eve", "hermes"] as const;
export type Harness = (typeof HARNESSES)[number];
export const TEAM_API_VERSION = "hermes-gitops.factorylevel.dev/agent-team/v1alpha1";
/** The team-level contract directory name AND the per-agent one. */
export const CONTRACT_DIRNAME = "harness-hg";
/** The payload directory beside a per-agent contract directory. */
export const SRC_DIRNAME = "src";

const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
const validators = new Map<string, ValidateFunction>();
function validatorFor(stem: string): ValidateFunction {
  let v = validators.get(stem);
  if (!v) {
    v = ajv.compile(JSON.parse(fs.readFileSync(path.join(TEAM_SCHEMAS, `${stem}.schema.json`), "utf8")));
    validators.set(stem, v);
  }
  return v;
}

export interface LayoutFinding {
  file: string; // absolute
  message: string;
}

function errorLines(file: string, errors: ErrorObject[] | null | undefined): LayoutFinding[] {
  return (errors ?? []).map((e) => {
    const detail =
      "additionalProperty" in e.params ? ` (${JSON.stringify(e.params["additionalProperty"])})` : "";
    return { file, message: `${e.instancePath || "/"} ${e.message ?? "invalid"}${detail}` };
  });
}

export interface AgentLayout {
  /** true = hermes-gitops.yaml beside the payload. */
  legacy: boolean;
  /** The payload the harness installs (= the discovered contract dir). */
  srcDir: string;
  /** Where the agent's contract files live (legacy: srcDir itself). */
  contractDir: string;
  agentFile: string;
  testFile: string;
  dashboardFile: string;
  iconsDir: string;
  // agent-team layout only:
  harness?: Harness;
  name?: string;
  agentDir?: string;
  root?: string;
  teamDir?: string;
}

/** Is `srcDir` the payload of an agent-team-layout agent? */
function isTeamAgentSrc(srcDir: string): boolean {
  return (
    path.basename(srcDir) === SRC_DIRNAME &&
    fs.existsSync(path.join(path.dirname(srcDir), CONTRACT_DIRNAME, "agent.yaml"))
  );
}

export function agentLayout(srcDir: string): AgentLayout {
  const abs = path.resolve(srcDir);
  if (!isTeamAgentSrc(abs)) {
    return {
      legacy: true,
      srcDir: abs,
      contractDir: abs,
      agentFile: path.join(abs, "hermes-gitops.yaml"),
      testFile: path.join(abs, "hermes-gitops.test.yaml"),
      dashboardFile: path.join(abs, "dashboard", "components.yaml"),
      iconsDir: path.join(abs, "dashboard", "icons"),
    };
  }
  const agentDir = path.dirname(abs);
  const harnessDir = path.dirname(agentDir);
  const root = path.dirname(path.dirname(harnessDir));
  const contractDir = path.join(agentDir, CONTRACT_DIRNAME);
  const harness = path.basename(harnessDir);
  return {
    legacy: false,
    srcDir: abs,
    contractDir,
    agentFile: path.join(contractDir, "agent.yaml"),
    testFile: path.join(contractDir, "test.yaml"),
    dashboardFile: path.join(contractDir, "dashboard.yaml"),
    iconsDir: path.join(contractDir, "icons"),
    harness: (HARNESSES as readonly string[]).includes(harness) ? (harness as Harness) : undefined,
    name: path.basename(agentDir),
    agentDir,
    root,
    teamDir: path.join(root, CONTRACT_DIRNAME),
  };
}

export function isTeamRepo(root: string): boolean {
  return fs.existsSync(path.join(root, CONTRACT_DIRNAME, "team.yaml"));
}

/** The ONE place a team-level file is looked up: `<root>/harness-hg` for an
 * agent-team repo (team.yaml is the switch - a stray harness-hg/ file in a
 * legacy repo changes nothing), else the legacy `<root>/environment`. */
export function teamDir(root: string): string {
  return isTeamRepo(root) ? path.join(root, CONTRACT_DIRNAME) : path.join(root, "environment");
}

export interface TeamDecl {
  name: string;
  displayName: string;
  harnesses: Harness[];
}

/** Read + validate `<root>/harness-hg/team.yaml`. Undefined when absent
 * (a legacy repo); findings when present and wrong. */
export function readTeam(root: string): { team?: TeamDecl; findings: LayoutFinding[] } {
  const file = path.join(root, CONTRACT_DIRNAME, "team.yaml");
  if (!fs.existsSync(file)) return { findings: [] };
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
  const v = validatorFor("team");
  if (!v(doc)) return { findings: errorLines(file, v.errors) };
  const d = doc as unknown as TeamDecl;
  return { team: { name: d.name, displayName: d.displayName, harnesses: d.harnesses }, findings: [] };
}

/** One team app as authored (apps.yaml apps[] entry). */
export interface TeamApp {
  name: string;
  agent: string;
  routes?: unknown[];
  [k: string]: unknown;
}

/** Read + validate `<teamDir>/apps.yaml`. Empty when absent. */
export function readTeamApps(teamDirPath: string): { apps: TeamApp[]; findings: LayoutFinding[] } {
  const file = path.join(teamDirPath, "apps.yaml");
  if (!fs.existsSync(file)) return { apps: [], findings: [] };
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as { apps?: TeamApp[] } | null;
  const v = validatorFor("apps");
  if (!v(doc)) return { apps: [], findings: errorLines(file, v.errors) };
  const findings: LayoutFinding[] = [];
  for (const app of doc?.apps ?? []) {
    for (const r of (app.routes ?? []) as { name?: string; from?: { app?: string } }[]) {
      if (r.from?.app !== app.name) {
        findings.push({
          file,
          message: `app ${app.name}: route ${r.name ?? "?"} is from app ${JSON.stringify(r.from?.app)} - a route under an app must be from that app`,
        });
      }
    }
  }
  return { apps: doc?.apps ?? [], findings };
}

function readOptional(file: string, stem: string, findings: LayoutFinding[]): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
  const v = validatorFor(stem);
  if (!v(doc)) {
    findings.push(...errorLines(file, v.errors));
    return undefined;
  }
  return doc ?? {};
}

/** The legacy raw shape (what `hermes-gitops.yaml` holds): kept as a loose
 * record here; `topology/contract.ts` owns the typed view. */
export type RawDeclaration = Record<string, unknown>;

/** The agent's declaration in the LEGACY raw shape, whichever layout it is
 * authored in. Legacy: the file's contents (or {} when absent - "no infra
 * intent"). Agent-team: `harness-hg/*.yaml` + the team's `apps.yaml`
 * entries this agent owns, validated against the agent-team schemas and
 * folded. `findings` non-empty means `raw` must not be trusted. */
export function readAgentDeclaration(
  srcDir: string,
  /** The team's apps, when the caller already read them (loadContracts
   * reads once and reports their findings once); else read here. */
  teamApps?: TeamApp[],
): {
  layout: AgentLayout;
  raw: RawDeclaration;
  findings: LayoutFinding[];
} {
  const layout = agentLayout(srcDir);
  if (layout.legacy) {
    if (!fs.existsSync(layout.agentFile)) return { layout, raw: {}, findings: [] };
    const doc = parseYaml(fs.readFileSync(layout.agentFile, "utf8")) as RawDeclaration | null;
    return { layout, raw: doc ?? {}, findings: [] };
  }
  const findings: LayoutFinding[] = [];
  if (!layout.harness) {
    findings.push({
      file: layout.agentFile,
      message: `agents/${path.basename(path.dirname(layout.agentDir!))}/ is not a declared harness (${HARNESSES.join(", ")})`,
    });
    return { layout, raw: {}, findings };
  }
  const agent = readOptional(layout.agentFile, "agent", findings);
  const backup = readOptional(path.join(layout.contractDir, "backup.yaml"), "backup", findings);
  const endpoints = readOptional(path.join(layout.contractDir, "endpoints.yaml"), "endpoints", findings);
  let apps = teamApps;
  if (apps === undefined) {
    const read = readTeamApps(layout.teamDir!);
    findings.push(...read.findings);
    apps = read.apps;
  }
  if (!agent || findings.length > 0) return { layout, raw: {}, findings };

  if (agent["harness"] !== layout.harness) {
    findings.push({
      file: layout.agentFile,
      message: `harness: ${JSON.stringify(agent["harness"])} but the directory is agents/${layout.harness}/ - the path and the declaration must agree`,
    });
  }
  const expose = endpoints?.["expose"];
  if (expose !== undefined && layout.harness !== "hermes") {
    findings.push({
      file: path.join(layout.contractDir, "endpoints.yaml"),
      message: "expose is Hermes-only (the record's expose block); an Eve agent declares endpoints[]",
    });
  }
  // expose selects the v3 legacy shape (the last version that carried it),
  // and v3 has no requires[].optional: the two cannot be expressed together
  // in any record the destination reads today. Say so at the source field,
  // not as a folded-document schema error.
  const optionalReq = ((agent["requires"] as { capability?: string; optional?: boolean }[] | undefined) ?? [])
    .find((r) => r.optional !== undefined);
  if (expose !== undefined && optionalReq) {
    findings.push({
      file: layout.agentFile,
      message: `requires[] capability ${optionalReq.capability}: \`optional\` cannot be carried beside endpoints.yaml's expose block (expose is the contract-v3 record shape, which predates optional requirements) - drop one until the endpoints generator is promoted`,
    });
  }
  if (findings.length > 0) return { layout, raw: {}, findings };

  // ---- the fold: agent-team files -> the legacy raw shape ----------------
  const mine = apps.filter((a) => a.agent === layout.name);
  const raw: RawDeclaration = { contractVersion: expose !== undefined ? 3 : 5 };
  if (layout.harness === "eve") {
    raw["runtime"] = { kind: "eve", envRequires: agent["envRequires"] ?? [] };
  }
  for (const k of ["topology", "requires", "deployment", "gitAuthSecretRef"]) {
    if (agent[k] !== undefined) raw[k] = agent[k];
  }
  if (backup) {
    const { apiVersion: _a, kind: _k, ...rest } = backup;
    raw["backup"] = rest;
  }
  if (endpoints?.["endpoints"] !== undefined) raw["endpoints"] = endpoints["endpoints"];
  if (expose !== undefined) raw["expose"] = expose;
  const routes = [
    ...((endpoints?.["routes"] as unknown[] | undefined) ?? []),
    ...mine.flatMap((a) => a.routes ?? []),
  ];
  const externalInputs = (endpoints?.["externalInputs"] as unknown[] | undefined) ?? [];
  if (routes.length > 0 || externalInputs.length > 0) {
    const communication: Record<string, unknown> = {};
    if (externalInputs.length > 0) communication["externalInputs"] = externalInputs;
    if (routes.length > 0) communication["routes"] = routes;
    raw["communication"] = communication;
  }
  if (mine.length > 0) {
    raw["apps"] = mine.map(({ agent: _owner, routes: _routes, ...rest }) => rest);
  }
  return { layout, raw, findings: [] };
}
