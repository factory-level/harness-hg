// What a team installation's bootstrap stack delivers into each agent's pod Secret
// `ag-eve-<name>-env`, and every placeholder a stack file the plan names still carries - read from
// the files alone, names and paths only (ADR 0196). `deliveredSecretNames` mirrors
// availableSecretNames() in infra/src/components/harness/eve-agent/index.ts, and
// infra/tests/eve-agent.test.ts holds the two together; this module stays free of the CLI's wider
// import graph so that test can load it.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { UNSET_SECRET_MARKER, formatPulumiPath, isRecord, isSecureValue, leafPresence, parsePulumiPath, qualifyPath, unsetSecretPaths, type ConfigPresence } from "../env/stack-config.ts";

export const BOOTSTRAP_PROJECT = "hermes-gitops-bootstrap";
export const AGENT_SECRETS = `${BOOTSTRAP_PROJECT}:agentSecrets`;
const SLACK = `${BOOTSTRAP_PROJECT}:slack`;
/** A provisioned Slack app always yields exactly these two pod credentials (ADR 0175). */
export const SLACK_PROVISIONED = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;
/** Bootstrap config trees keyed by agent instance: a path under one belongs to that agent. */
const PER_AGENT = new Set(["agentSecrets", "agentGitAuth", "applicationSecrets", "applicationGitAuth"].map(k => `${BOOTSTRAP_PROJECT}:${k}`));

type OverlayRef = { id: string; source?: { credentialEnv?: string } };
/** The plan fields the credential gate reads. Structural, so a TeamPlan fits and this module
 * needs nothing from plan.ts. */
export interface CredentialPlan {
  id: string;
  bootstrap: { directory: string; stack: string };
  kubeContext?: string;
  authorizations?: string[];
  destination?: { credentialEnv: string };
  credentials?: {
    configFile: string;
    bindings?: Record<string, string>;
    inputs?: Record<string, string>;
    secretInputs?: Record<string, { namespace: string; secret: string; key: string }>;
  };
  integrations?: { id: string; directory: string; stack: string; configFile: string; outputs?: Record<string, string[]> }[];
  sources?: {
    id: string;
    private?: boolean;
    credentialEnv?: string;
    overlays?: OverlayRef[];
    agents: {
      name: string;
      environment?: string[];
      environmentBindings?: Record<string, string>;
      appValueBindings?: Record<string, string>;
      appChartSource?: unknown;
      overlays?: OverlayRef[];
    }[];
  }[];
}

/** Who needs a value: an agent (as which variable), a source, or the installation itself. */
export interface NeededBy { kind: "agent" | "source" | "installation"; name: string; as?: string }
export type FindingKind =
  | "input" | "unset" | "binding" | "source-credential" | "overlay-credential" | "agent-environment" | "app-value"
  | "undelivered" | "empty" | "unproven" | "opaque";
/** One missing value: names, paths and fixes - never a value. */
export interface CredentialFinding {
  kind: FindingKind;
  envNames: string[];
  pulumiPath?: string;
  configFile?: string;
  problem: string;
  neededBy: NeededBy[];
  agentFile?: string;
  fix: string[];
}
/** A Kubernetes Secret input: its access is probed, its key is read by the run itself. */
export interface DeferredCheck { envName: string; namespace: string; secret: string; key: string; neededBy: NeededBy[] }
/** Where one stack's `pulumi config set` runs, and against which state backend. */
export interface StackTarget { directory: string; stack: string; configFile: string; backend?: string }

export function bootstrapTarget(plan: CredentialPlan, backend?: string): StackTarget {
  return {
    ...(backend ? { backend } : {}),
    directory: plan.bootstrap.directory,
    stack: plan.bootstrap.stack,
    // Without a credentials block, `pulumi up --stack <stack>` reads the stack's own file.
    configFile: plan.credentials?.configFile ?? path.posix.join(plan.bootstrap.directory, `Pulumi.${plan.bootstrap.stack}.yaml`),
  };
}

/** A stack file that exists but cannot be used. Its message names the file and a position or
 * error code only: a YAML parser's own message quotes the source, which may hold plaintext. */
export class StackConfigError extends Error {}

/** A stack file read without leaking it: absent (no document), unreadable or invalid (a problem
 * naming the file), or parsed. Absence and an access failure are never confused. */
export function readStackFile(root: string, relative: string): { document?: unknown; problem?: string } {
  let text: string;
  try { text = fs.readFileSync(path.resolve(root, relative), "utf8"); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? {} : { problem: `${relative} cannot be read (${code ?? "I/O error"})` };
  }
  try { return { document: parse(text) ?? {} }; } catch (error) {
    const at = (error as { linePos?: { line: number; col: number }[] } | null)?.linePos?.[0];
    return { problem: `${relative} is not valid YAML${at ? ` (line ${at.line}, column ${at.col})` : ""}` };
  }
}

/** The parsed stack file, or undefined when the plan names a file that does not exist. */
export function readStackDocument(root: string, relative: string): unknown {
  const { document, problem } = readStackFile(root, relative);
  if (problem) throw new StackConfigError(problem);
  return document;
}

/** The fix for one path, against the stack's own backend. The value comes from the prompt or
 * stdin, never an argument. */
export function pulumiSetCommand(target: StackTarget, pulumiPath: string): string {
  const configFile = path.posix.relative(target.directory, target.configFile) || path.posix.basename(target.configFile);
  const backend = target.backend ? `PULUMI_BACKEND_URL=${target.backend} ` : "";
  return `(cd ${target.directory} && ${backend}pulumi config set --secret --path '${pulumiPath}' --stack ${target.stack} --config-file ${configFile})`;
}

/** A bootstrap path in its canonical, project-qualified spelling. */
export function bootstrapPath(spelled: string): string | undefined {
  const segments = parsePulumiPath(spelled);
  return segments ? formatPulumiPath(qualifyPath(segments, BOOTSTRAP_PROJECT)) : undefined;
}

/** The agent a bootstrap path belongs to, when it sits under a per-agent tree. */
export function pathAgent(spelled: string): { agent: string; leaf?: string } | undefined {
  const segments = parsePulumiPath(spelled);
  if (!segments) return undefined;
  const [tree, agent, ...rest] = qualifyPath(segments, BOOTSTRAP_PROJECT);
  if (typeof tree !== "string" || !PER_AGENT.has(tree) || typeof agent !== "string") return undefined;
  const leaf = rest.at(-1);
  return { agent, ...(typeof leaf === "string" ? { leaf } : {}) };
}

export interface SecretSource { via: "config" | "binding" | "slack"; presence?: ConfigPresence }
export interface SecretDelivery {
  agents: Map<string, Map<string, SecretSource[]>>;
  /** Agents whose agentSecrets are encrypted as one value, so their names cannot be read. */
  opaque: "all" | Set<string>;
}

/** Every source that puts a variable into an agent's pod Secret, mirroring the bootstrap program:
 * the config file's `agentSecrets.<agent>` keys, plan bindings that write
 * `agentSecrets.<agent>.<VAR>` at provision time, and the two names a provisioned Slack app
 * yields. `credentials.inputs` only READ config, so they deliver nothing themselves. */
export function secretDelivery(plan: CredentialPlan, root: string): SecretDelivery {
  const document = readStackDocument(root, bootstrapTarget(plan).configFile);
  const config = isRecord(document) && isRecord(document["config"]) ? document["config"] : {};
  const agents = new Map<string, Map<string, SecretSource[]>>();
  const add = (agent: string, name: string, source: SecretSource): void => {
    const vars = agents.get(agent) ?? new Map<string, SecretSource[]>();
    vars.set(name, [...(vars.get(name) ?? []), source]);
    agents.set(agent, vars);
  };
  let everything = false;
  const opaque = new Set<string>();
  const secrets = config[AGENT_SECRETS];
  if (isSecureValue(secrets)) everything = true;
  else if (isRecord(secrets)) {
    for (const [agent, vars] of Object.entries(secrets)) {
      if (isSecureValue(vars)) { opaque.add(agent); continue; }
      if (isRecord(vars)) for (const [name, value] of Object.entries(vars)) add(agent, name, { via: "config", presence: leafPresence(value) });
    }
  }
  for (const target of Object.values(plan.credentials?.bindings ?? {})) {
    const segments = parsePulumiPath(target);
    const qualified = segments ? qualifyPath(segments, BOOTSTRAP_PROJECT) : [];
    if (qualified.length === 3 && qualified[0] === AGENT_SECRETS && typeof qualified[1] === "string" && typeof qualified[2] === "string") {
      add(qualified[1], qualified[2], { via: "binding" });
    }
  }
  const slack = config[SLACK];
  if (isRecord(slack) && slack["enabled"] === true && isRecord(slack["apps"])) {
    for (const [agent, app] of Object.entries(slack["apps"])) {
      const appId = isRecord(app) && typeof app["appId"] === "string" ? app["appId"] : "";
      if (appId !== "") continue; // an adopted app rides config alone
      for (const name of SLACK_PROVISIONED) add(agent, name, { via: "slack" });
    }
  }
  return { agents, opaque: everything ? "all" : opaque };
}

/** Per agent, the variable names its pod Secret receives. A key still holding the unset
 * placeholder is not delivered: Pulumi refuses the stack before any Secret is written. */
export function deliveredSecretNames(plan: CredentialPlan, root: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [agent, vars] of secretDelivery(plan, root).agents) {
    out[agent] = [...vars].filter(([, sources]) => sources.some(s => s.presence !== "unset")).map(([name]) => name).sort();
  }
  return out;
}

/** Every unset placeholder in the bootstrap stack file and each integration's file. */
export function unsetMarkerFindings(plan: CredentialPlan, root: string, backend?: string): CredentialFinding[] {
  const bindings = new Map<string, string[]>();
  for (const [env, target] of Object.entries(plan.credentials?.bindings ?? {})) {
    const key = bootstrapPath(target);
    if (key) bindings.set(key, [...(bindings.get(key) ?? []), env]);
  }
  const targets: (StackTarget & { owner: NeededBy; bootstrap: boolean })[] = [
    { ...bootstrapTarget(plan, backend), bootstrap: true, owner: { kind: "installation", name: plan.id, as: `bootstrap stack ${plan.bootstrap.stack}` } },
    ...(plan.integrations ?? []).map(i => ({ ...(backend ? { backend } : {}), directory: i.directory, stack: i.stack, configFile: i.configFile, bootstrap: false,
      owner: { kind: "installation" as const, name: plan.id, as: `integration ${i.id}` } })),
  ];
  const findings: CredentialFinding[] = [];
  for (const target of targets) {
    for (const pulumiPath of unsetSecretPaths(readStackDocument(root, target.configFile))) {
      const envNames = target.bootstrap ? bindings.get(pulumiPath) ?? [] : [];
      const owner = target.bootstrap ? pathAgent(pulumiPath) : undefined;
      const neededBy: NeededBy[] = [
        ...(owner ? [{ kind: "agent" as const, name: owner.agent, ...(owner.leaf ? { as: owner.leaf } : {}) }] : []),
        ...envNames.map(env => ({ kind: "installation" as const, name: plan.id, as: `binding ${env}` })),
      ];
      findings.push({
        kind: "unset", envNames, pulumiPath, configFile: target.configFile,
        problem: `still the ${UNSET_SECRET_MARKER} placeholder, which makes Pulumi reject the whole stack configuration`,
        neededBy: neededBy.length ? neededBy : [target.owner],
        fix: [pulumiSetCommand(target, pulumiPath)],
      });
    }
  }
  return findings;
}

const GROUP_RANK = { agent: 0, source: 1, installation: 2 } as const;

/** One refusal, grouped by who needs each value, with every fix listed once. */
export function renderFindings(plan: CredentialPlan, headline: string, findings: CredentialFinding[], deferred: DeferredCheck[] = []): string {
  const groups = new Map<string, { rank: number; entries: number[] }>();
  findings.forEach((finding, index) => {
    const agents = finding.neededBy.filter(n => n.kind === "agent");
    const sources = finding.neededBy.filter(n => n.kind === "source");
    const owners = agents.length ? agents : sources.length ? sources : [{ kind: "installation" as const, name: plan.id }];
    for (const owner of owners) {
      const key = owner.kind === "installation" ? "installation" : `${owner.kind} ${owner.name}`;
      const group = groups.get(key) ?? { rank: GROUP_RANK[owner.kind], entries: [] };
      if (!group.entries.includes(index)) group.entries.push(index);
      groups.set(key, group);
    }
  });
  const lines = [`team ${plan.id}: ${headline}`, ""];
  for (const [key, group] of [...groups].sort(([a, x], [b, y]) => x.rank - y.rank || a.localeCompare(b))) {
    lines.push(key);
    for (const index of group.entries) {
      const finding = findings[index]!;
      const subject = finding.pulumiPath ?? finding.envNames.join(", ");
      const via = finding.pulumiPath && finding.envNames.length ? `  (${finding.envNames.join(", ")})` : "";
      const uses = [...new Set(finding.neededBy.filter(n => (key === "installation" ? n.kind === "installation" : `${n.kind} ${n.name}` === key) && n.as).map(n => n.as!))];
      lines.push(`  [${index + 1}] ${finding.kind.padEnd(18)} ${subject}${via}`);
      lines.push(`      ${finding.problem}${uses.length ? `; needed as ${uses.join(", ")}` : ""}`);
      if (finding.agentFile) lines.push(`      declared in ${finding.agentFile}`);
    }
    lines.push("");
  }
  lines.push("Fixes (a value is read from the prompt or stdin - never pass one as an argument):");
  findings.forEach((finding, index) => finding.fix.forEach((fix, i) => lines.push(`  ${i === 0 ? `[${index + 1}]` : "   "} ${fix}`)));
  if (deferred.length) {
    lines.push("", "Kubernetes Secret inputs (context and access probed; each key is read when the run starts):");
    for (const check of deferred) {
      const agents = [...new Set(check.neededBy.filter(n => n.kind === "agent").map(n => n.name))];
      lines.push(`  ${check.envName} <- ${check.namespace}/${check.secret} key ${check.key}${agents.length ? ` (${agents.join(", ")})` : ""}`);
    }
  }
  return lines.join("\n");
}
