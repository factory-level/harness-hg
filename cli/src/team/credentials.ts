// The team credential gate (ADR 0196, layer 1: install time, cluster-free where it can be).
// `hg team plan|apply|resume|compile` refuse at `validated` - every problem named at once, never
// a value - in three steps, each only after the one before succeeds:
//   1. access: this host can reach the stack's state backend (derived, never inherited), the stack
//      exists there, Google credentials work, and the kube context the plan reads Secrets through
//      exists and answers. An access failure judges no input missing.
//   2. completeness: every credentials input path is filled, every binding, source, overlay,
//      runtime and app-value credential has a source, and no stack file holds the unset
//      placeholder.
//   3. delivery (after rendering): every required envRequires entry reaches ag-eve-<name>-env.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ChildFailed, CliError } from "../lib.ts";
import { agentLayout } from "../layout.ts";
import { UNSET_SECRET_MARKER, configPresence, isRecord } from "../env/stack-config.ts";
import { GOOGLE_FIX, run, type Run } from "./process.ts";
import { deriveBackend, type TeamBackend } from "./backend.ts";
import {
  AGENT_SECRETS, BOOTSTRAP_PROJECT, bootstrapPath, bootstrapTarget, pathAgent, pulumiSetCommand, readStackDocument, readStackFile, renderFindings, secretDelivery,
  unsetMarkerFindings, type CredentialFinding, type CredentialPlan, type DeferredCheck, type FindingKind, type NeededBy, type StackTarget,
} from "./delivery.ts";

export { deliveredSecretNames } from "./delivery.ts";
export type { CredentialFinding, DeferredCheck } from "./delivery.ts";
export type { TeamBackend } from "./backend.ts";

export type TeamVerb = "plan" | "apply" | "resume" | "publish" | "compile";
/** One thing this host cannot reach, with its fix. */
export interface AccessFailure { kind: string; subject: string; cause: string; fix: string }

/** A credential refusal. Its message names installation, agents, variables, paths and fixes and is
 * safe to record as ledger evidence; `findings` and `access` travel in the unattended report. */
export class CredentialGateError extends CliError {
  constructor(message: string, readonly findings: CredentialFinding[] = [], readonly access: AccessFailure[] = []) { super(message); }
}

// ---------------------------------------------------------------------------------------------
// The state backend: derived from the environment spec, never whatever `pulumi login` ran last.

/** The derived backend (see backend.ts). Specs that disagree refuse. */
export function teamBackend(plan: CredentialPlan, root: string, operator: string | undefined = process.env.PULUMI_BACKEND_URL): TeamBackend {
  const backend = deriveBackend(plan, root, operator);
  if (backend.conflicts.length) {
    const failure = backendConflict(plan, backend);
    throw new CredentialGateError(renderAccess(plan, [failure]), [], [failure]);
  }
  return backend;
}

function backendConflict(plan: CredentialPlan, backend: TeamBackend): AccessFailure {
  const listed = backend.conflicts.map(c => `${c.backend} (${c.specs.join(", ")})`).join(" and ");
  return { kind: "backend-ambiguous", subject: `bootstrap stack ${plan.bootstrap.stack}`,
    cause: `its environment specs derive different Pulumi backends: ${listed}`, fix: "make every environment spec named for this stack agree on its project" };
}

function backendUnderived(plan: CredentialPlan, backend: TeamBackend): AccessFailure {
  const { directory, stack } = plan.bootstrap;
  return { kind: "backend-underived", subject: `bootstrap stack ${stack}`,
    cause: `no environment spec derives its state backend${backend.problems.length ? `: ${backend.problems.join("; ")}` : ` (looked for ${directory}/environments/${stack}.yaml and ${directory}/environments/*/environment.yaml)`}`,
    fix: `add or repair the environment spec named ${stack} (a hermes-gitops.factorylevel.dev/environment apiVersion, name: ${stack}, project: <gcp project>); hg never falls back to the last pulumi login${backend.operator ? `, so PULUMI_BACKEND_URL=${backend.operator} is not used` : ""}` };
}

function backendMismatch(plan: CredentialPlan, backend: TeamBackend): AccessFailure {
  return { kind: "backend-mismatch", subject: "PULUMI_BACKEND_URL",
    cause: `the operator environment sets ${backend.operator}, but bootstrap stack ${plan.bootstrap.stack} lives on ${backend.derived} (derived from ${backend.specs.join(", ")})`,
    fix: `unset PULUMI_BACKEND_URL, or export PULUMI_BACKEND_URL=${backend.derived}` };
}

/** The environment every Pulumi child on the team path runs with: the derived backend set. No
 * derivable backend, or a different operator-set one, refuses before the call - Pulumi never runs
 * against whatever login happens to be current. */
export function pulumiEnvironment(plan: CredentialPlan, root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const backend = teamBackend(plan, root, base.PULUMI_BACKEND_URL);
  const failure = !backend.derived ? backendUnderived(plan, backend)
    : backend.operator && backend.operator !== backend.derived ? backendMismatch(plan, backend) : undefined;
  if (failure) throw new CredentialGateError(renderAccess(plan, [failure]), [], [failure]);
  return { ...base, PULUMI_BACKEND_URL: backend.derived };
}

// ---------------------------------------------------------------------------------------------
// Step 1: access.

export function renderAccess(plan: CredentialPlan, failures: AccessFailure[]): string {
  const google = failures.some(f => f.kind === "google-auth");
  return [
    `team ${plan.id}: cannot read the encrypted team configuration${google ? ": Google credentials need re-authentication" : " or the Secrets it names"}.`,
    "No declared input has been judged missing yet: completeness is checked only after access succeeds, and nothing was read, provisioned or published.",
    "",
    ...failures.flatMap((failure, i) => [`  ${i + 1}. ${failure.subject}: ${failure.cause}`, `     fix: ${failure.fix}`]),
  ].join("\n");
}

const childFailureOf = (error: unknown) => (error instanceof ChildFailed ? error.failure : undefined);

/** Every access failure this host can detect, in order: stack files, backend, stack, Google
 * credentials, kube context, API reachability and RBAC. Pulumi is probed only when the run will
 * call it (a credentials block, or a verb that provisions), Kubernetes only when the plan reads
 * Secrets from it. No probe decrypts anything. */
export async function probeAccess(plan: CredentialPlan, root: string, verb: TeamVerb, exec: Run = run, env: NodeJS.ProcessEnv = process.env): Promise<AccessFailure[]> {
  const failures: AccessFailure[] = [];
  const backend = deriveBackend(plan, root, env.PULUMI_BACKEND_URL);
  const target = bootstrapTarget(plan, backend.derived);

  // An unreadable or malformed stack file is an access failure, never "absent" findings.
  for (const configFile of [target.configFile, ...(plan.integrations ?? []).map(i => i.configFile)]) {
    const { problem } = readStackFile(root, configFile);
    if (problem) failures.push({ kind: "config-unreadable", subject: `stack config ${configFile}`, cause: problem, fix: "make the file readable by this user and valid YAML at the position named" });
  }

  const provisions = (verb === "apply" || verb === "resume") && Boolean(plan.authorizations?.includes("provision") || plan.integrations?.length);
  const usesPulumi = Boolean(plan.credentials) || provisions;
  if (backend.conflicts.length) failures.push(backendConflict(plan, backend));
  else if (usesPulumi && !backend.derived) failures.push(backendUnderived(plan, backend));
  if (backend.derived && backend.operator && backend.operator !== backend.derived) failures.push(backendMismatch(plan, backend));
  const pulumiEnv: NodeJS.ProcessEnv = { ...env, ...(backend.derived ? { PULUMI_BACKEND_URL: backend.derived } : {}) };
  const googleFix = backend.derived ? `${GOOGLE_FIX}; this installation's stack is on PULUMI_BACKEND_URL=${backend.derived}` : GOOGLE_FIX;

  const stacks: (StackTarget & { label: string })[] = [];
  if (usesPulumi && backend.derived) {
    stacks.push({ ...target, label: `bootstrap stack ${target.stack}` });
    if (verb === "apply" || verb === "resume") {
      for (const integration of plan.integrations ?? []) {
        stacks.push({ directory: integration.directory, stack: integration.stack, configFile: integration.configFile, label: `integration ${integration.id} stack ${integration.stack}` });
      }
    }
  }
  let googleExercised = false;
  for (const stack of stacks) {
    let listed: unknown;
    try {
      listed = JSON.parse(await exec(["pulumi", "stack", "ls", "--json"], path.resolve(root, stack.directory), pulumiEnv, 120_000));
      if (backend.derived?.startsWith("gs://")) googleExercised = true;
    } catch (error) {
      const failure = childFailureOf(error);
      if (failure?.kind === "google-auth") googleExercised = true;
      failures.push(failure
        ? { kind: failure.kind, subject: stack.label, cause: failure.cause, fix: failure.kind === "google-auth" ? googleFix : failure.fix }
        : { kind: "probe-failed", subject: stack.label, cause: `pulumi stack ls could not list the stacks on ${backend.derived}`, fix: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const names = Array.isArray(listed) ? listed.map(s => (isRecord(s) && typeof s["name"] === "string" ? s["name"] : "")) : [];
    if (!names.some(name => name === stack.stack || name.endsWith(`/${stack.stack}`))) {
      failures.push({ kind: "stack-missing", subject: stack.label, cause: `stack ${stack.stack} not found on backend ${backend.derived}`,
        fix: `expected on ${backend.derived} (derived from ${backend.specs.join(", ")}): create it with (cd ${stack.directory} && PULUMI_BACKEND_URL=${backend.derived} pulumi stack init ${stack.stack}), or correct the stack name in the plan` });
    }
  }

  // Google credentials, directly, only when Pulumi did not already exercise them: a gs:// backend
  // Pulumi listed proves them; a failed listing or a gcpkms:// provider alone does not.
  const document = readStackFile(root, target.configFile).document;
  const provider = isRecord(document) && typeof document["secretsprovider"] === "string" ? document["secretsprovider"] : "";
  if (stacks.length && !googleExercised && (backend.derived?.startsWith("gs://") || provider.startsWith("gcpkms://"))) {
    try {
      await exec(["gcloud", "auth", "application-default", "print-access-token"], root, env, 60_000); // the token is discarded unread
    } catch (error) {
      // gcloud absent is not a finding: Pulumi's own reads are classified if they fail.
      if (error instanceof ChildFailed) {
        failures.push({ kind: "google-auth", subject: "Google application-default credentials",
          cause: error.failure?.kind === "google-auth" ? error.failure.cause : "gcloud could not mint an application-default access token", fix: googleFix });
      }
    }
  }

  // Each declared Secret by name: an identity scoped with RBAC resourceNames may read exactly
  // these and nothing else in the namespace, which is all the run needs.
  const secretInputs = [...new Map(Object.values(plan.credentials?.secretInputs ?? {}).map(s => [`${s.namespace}/${s.secret}`, s])).values()];
  const context = plan.kubeContext ?? "";
  if (secretInputs.length) {
    let contexts: string[] | undefined;
    try {
      contexts = (await exec(["kubectl", "config", "get-contexts", "-o", "name"], root, env, 30_000)).split("\n").map(s => s.trim()).filter(Boolean);
    } catch (error) {
      failures.push({ kind: "kube-config", subject: `kube context ${context}`, cause: "kubectl could not list the kube contexts", fix: error instanceof Error ? error.message : String(error) });
    }
    if (contexts && !contexts.includes(context)) {
      failures.push({ kind: "kube-context-missing", subject: `kube context ${context}`,
        cause: `context ${context} does not exist (this kubeconfig has: ${contexts.join(", ") || "no contexts"})`,
        fix: `run on the destination host where the watcher runs, or merge that cluster's kubeconfig as context ${context}` });
    } else if (contexts) {
      for (const input of secretInputs) {
        try {
          await exec(["kubectl", "--context", context, "--request-timeout=5s", "auth", "can-i", "get", `secrets/${input.secret}`, "-n", input.namespace], root, env, 30_000);
        } catch (error) {
          const failure = childFailureOf(error);
          if (failure && failure.kind !== "kube-forbidden") {
            failures.push({ kind: failure.kind, subject: `kube context ${context}`, cause: failure.cause, fix: failure.fix });
            break; // unreachable is unreachable for every Secret
          }
          // `auth can-i` answers "no" with exit 1 and nothing on stderr.
          failures.push({ kind: "kube-forbidden", subject: `kube context ${context}`, cause: `RBAC denies get on secrets/${input.secret} in namespace ${input.namespace}`,
            fix: `grant the context's identity get on secrets/${input.secret} in ${input.namespace}, or use the context the watcher runs with` });
        }
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------
// Step 2: completeness.

function projectName(root: string, directory: string): string {
  try {
    const doc = parse(fs.readFileSync(path.resolve(root, directory, "Pulumi.yaml"), "utf8")) as unknown;
    if (isRecord(doc) && typeof doc["name"] === "string") return doc["name"];
  } catch { /* no project file: the bootstrap program's name */ }
  return BOOTSTRAP_PROJECT;
}
const dedupe = (neededBy: NeededBy[]): NeededBy[] => [...new Map(neededBy.map(n => [JSON.stringify(n), n])).values()];
const INPUT_PROBLEM = { absent: "absent from", unset: `still the ${UNSET_SECRET_MARKER} placeholder in`, empty: "empty in", "not-scalar": "not a scalar value in" } as const;
/** Merge order when one environment name has several failing uses. */
const ENV_KINDS: FindingKind[] = ["binding", "source-credential", "overlay-credential", "agent-environment", "app-value"];

/** The full list of missing values, from the plan and its stack files, before any is read. */
export function credentialFindings(plan: CredentialPlan, root: string, env: NodeJS.ProcessEnv = process.env): { findings: CredentialFinding[]; deferred: DeferredCheck[] } {
  const backend = deriveBackend(plan, root, undefined).derived;
  const target = bootstrapTarget(plan, backend);
  const document = readStackDocument(root, target.configFile);
  const project = projectName(root, plan.bootstrap.directory);
  const inputs = plan.credentials?.inputs ?? {}, bindings = plan.credentials?.bindings ?? {}, secretInputs = plan.credentials?.secretInputs ?? {};
  const outputs = new Set((plan.integrations ?? []).flatMap(i => Object.keys(i.outputs ?? {})));

  // Every place an environment name is consumed, and whether its absence fails the run.
  const uses = new Map<string, { kind: FindingKind; neededBy: NeededBy; fails: boolean }[]>();
  const use = (name: string | undefined, kind: FindingKind, neededBy: NeededBy, fails = true): void => {
    if (name) uses.set(name, [...(uses.get(name) ?? []), { kind, neededBy, fails }]);
  };
  for (const [name, spelled] of Object.entries(bindings)) {
    use(name, "binding", { kind: "installation", name: plan.id, as: `binding ${spelled}` });
    const owner = pathAgent(spelled);
    if (owner) use(name, "binding", { kind: "agent", name: owner.agent, ...(owner.leaf ? { as: owner.leaf } : {}) });
  }
  // The destination credential only gates publication, which waits (pending) when it is absent.
  use(plan.destination?.credentialEnv, "source-credential", { kind: "installation", name: plan.id, as: "destination" }, false);
  for (const source of plan.sources ?? []) {
    use(source.credentialEnv, "source-credential", { kind: "source", name: source.id, as: "fetch" }, source.private === true);
    for (const overlay of source.overlays ?? []) use(overlay.source?.credentialEnv, "overlay-credential", { kind: "source", name: source.id, as: `overlay ${overlay.id}` });
    for (const agent of source.agents) {
      if (agent.appChartSource) use(source.credentialEnv, "source-credential", { kind: "agent", name: agent.name, as: "chart source" });
      for (const overlay of agent.overlays ?? []) use(overlay.source?.credentialEnv, "overlay-credential", { kind: "agent", name: agent.name, as: `overlay ${overlay.id}` });
      for (const variable of agent.environment ?? []) use(agent.environmentBindings?.[variable] ?? variable, "agent-environment", { kind: "agent", name: agent.name, as: variable });
      for (const [valuePath, reference] of Object.entries(agent.appValueBindings ?? {})) use(reference, "app-value", { kind: "agent", name: agent.name, as: `appValues.${valuePath}` });
    }
  }
  const neededByName = (name: string) => dedupe((uses.get(name) ?? []).map(u => u.neededBy));

  const findings: CredentialFinding[] = [];
  const inputFindings = new Map<string, CredentialFinding>();
  for (const [name, spelled] of Object.entries(inputs)) {
    const presence = configPresence(document, spelled, project);
    if (presence === "encrypted" || presence === "plaintext" || presence === "opaque") continue;
    const pulumiPath = bootstrapPath(spelled) ?? spelled;
    const existing = inputFindings.get(pulumiPath);
    if (existing) {
      existing.envNames.push(name);
      existing.neededBy = dedupe([...existing.neededBy, ...neededByName(name)]);
      continue;
    }
    const neededBy = neededByName(name);
    const finding: CredentialFinding = {
      kind: "input", envNames: [name], pulumiPath, configFile: target.configFile,
      problem: `${INPUT_PROBLEM[presence]} ${target.configFile}`,
      neededBy: neededBy.length ? neededBy : [{ kind: "installation", name: plan.id, as: `input ${name}` }],
      fix: [pulumiSetCommand(target, pulumiPath)],
    };
    inputFindings.set(pulumiPath, finding);
    findings.push(finding);
  }
  for (const finding of unsetMarkerFindings(plan, root, backend)) {
    if (finding.configFile === target.configFile && inputFindings.has(finding.pulumiPath!)) continue;
    findings.push(finding);
  }

  const satisfied = (name: string) => Boolean(env[name]) || name in inputs || name in secretInputs || outputs.has(name);
  for (const [name, entries] of uses) {
    const failing = entries.filter(e => e.fails);
    if (!failing.length || satisfied(name)) continue;
    const kind = ENV_KINDS.find(k => failing.some(e => e.kind === k))!;
    const bound = bindings[name] ? bootstrapPath(bindings[name]!) : undefined;
    const runtime = failing.find(e => e.kind === "agent-environment");
    const suggested = bound ?? (runtime?.neededBy.as ? `${AGENT_SECRETS}.${runtime.neededBy.name}.${runtime.neededBy.as}` : undefined);
    findings.push({
      kind, envNames: [name], ...(bound ? { pulumiPath: bound, configFile: target.configFile } : {}),
      problem: `environment variable ${name} is not set, and no credentials.inputs, secretInputs or integration output supplies it`,
      neededBy: dedupe(entries.map(e => e.neededBy)),
      fix: suggested
        ? [pulumiSetCommand(target, suggested), `then add to the plan: credentials.inputs: { ${name}: ${suggested} }  (stored encrypted, not required from the operator's shell)`]
        : [`store it encrypted: pulumi config set --secret --path '<namespace:path>' (see the other fixes for the command shape), then add to the plan: credentials.inputs: { ${name}: <namespace:path> }`],
    });
  }

  const deferred = Object.entries(secretInputs).map(([envName, ref]) => ({ envName, namespace: ref.namespace, secret: ref.secret, key: ref.key, neededBy: neededByName(envName) }));
  return { findings, deferred };
}

/** Steps 1 and 2: refuse with every access failure, or else every missing value. */
export async function credentialPreflight(plan: CredentialPlan, root: string, verb: TeamVerb, exec: Run = run, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const access = await probeAccess(plan, root, verb, exec, env);
  if (access.length) throw new CredentialGateError(renderAccess(plan, access), [], access);
  const { findings, deferred } = credentialFindings(plan, root, env);
  if (findings.length) {
    throw new CredentialGateError(renderFindings(plan, `the credential preflight found ${findings.length} missing value(s); nothing was read, provisioned or published`, findings, deferred), findings);
  }
}

// ---------------------------------------------------------------------------------------------
// Step 3: the rendered records' envRequires reach each pod Secret.

export interface AgentRequirements { agent: string; envRequires: unknown; agentFile?: string }

/** `{name, required, secret}` with the emitter's defaults: absent `required`/`secret` mean true,
 * and a bare string is a required secret. */
function normalizeEnvRequires(raw: unknown): { name: string; required: boolean; secret: boolean }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(entry => {
    if (typeof entry === "string") return entry ? [{ name: entry, required: true, secret: true }] : [];
    if (isRecord(entry) && typeof entry["name"] === "string" && entry["name"]) return [{ name: entry["name"], required: entry["required"] !== false, secret: entry["secret"] !== false }];
    return [];
  });
}

/** Every required entry that will not reach the agent's pod Secret with a usable value: not
 * delivered at all, only an empty plaintext value, only the unset placeholder, delivered but
 * absent from the production startup proof (a secret the plan's `agents[].environment` omits,
 * except the names a provisioned Slack app yields, which exist only after provisioning), or not
 * checkable because agentSecrets is encrypted whole. Encrypted values cannot be judged empty. */
export function uncoveredRequirements(plan: CredentialPlan, root: string, requirements: AgentRequirements[]): CredentialFinding[] {
  const delivery = secretDelivery(plan, root);
  const target = bootstrapTarget(plan, deriveBackend(plan, root, undefined).derived);
  const findings: CredentialFinding[] = [];
  for (const requirement of requirements) {
    const declared = (plan.sources ?? []).flatMap(s => s.agents).find(a => a.name === requirement.agent);
    const secretName = `ag-eve-${requirement.agent}-env`;
    for (const entry of normalizeEnvRequires(requirement.envRequires)) {
      if (!entry.required) continue;
      const pulumiPath = `${AGENT_SECRETS}.${requirement.agent}.${entry.name}`;
      const bindingEnv = `HG_${requirement.agent}_${entry.name}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      const base = {
        envNames: [entry.name], pulumiPath, configFile: target.configFile,
        neededBy: [{ kind: "agent" as const, name: requirement.agent, as: entry.name }],
        ...(requirement.agentFile ? { agentFile: requirement.agentFile } : {}),
      };
      const deliver = [
        `add to the plan: credentials.bindings: { ${bindingEnv}: ${pulumiPath} }  (with ${bindingEnv} supplied by a credentials.inputs entry)`,
        `or store it in the bootstrap config: ${pulumiSetCommand(target, pulumiPath)}`,
      ];
      if (delivery.opaque === "all" || delivery.opaque.has(requirement.agent)) {
        findings.push({ ...base, kind: "opaque", problem: `${delivery.opaque === "all" ? AGENT_SECRETS : `${AGENT_SECRETS}.${requirement.agent}`} is encrypted as one value, so whether ${entry.name} reaches ${secretName} cannot be checked`,
          fix: [`store each variable at its own path: ${pulumiSetCommand(target, pulumiPath)}`] });
        continue;
      }
      const sources = delivery.agents.get(requirement.agent)?.get(entry.name) ?? [];
      const live = sources.filter(s => s.presence !== "unset");
      if (!live.length) {
        findings.push({ ...base, kind: sources.length ? "unset" : "undelivered",
          problem: sources.length ? `still the ${UNSET_SECRET_MARKER} placeholder, so ${secretName} never receives it` : `declared required, but nothing delivers it to ${secretName}`, fix: deliver });
      } else if (live.every(s => s.via === "config" && s.presence === "empty")) {
        findings.push({ ...base, kind: "empty", problem: `delivered to ${secretName} as an empty plaintext value`, fix: deliver });
      } else if (entry.secret && declared && !(declared.environment ?? []).includes(entry.name) && !live.every(s => s.via === "slack")) {
        findings.push({ ...base, kind: "unproven", problem: `delivered to ${secretName}, but the production startup proof runs without it: it is not in the plan's agents[].environment`,
          fix: [`add ${entry.name} to agent ${requirement.agent}'s environment with environmentBindings: { ${entry.name}: ${bindingEnv} }`, `and credentials.inputs: { ${bindingEnv}: ${pulumiPath} }`] });
      }
    }
  }
  return findings;
}

/** Step 3 over a compiled projection: read each agent's rendered envRequires and refuse. */
export function assertRequirementsDelivered(plan: CredentialPlan, root: string, sources: { root: string; definition: { id: string; agents: { name: string; subdir: string }[] } }[], files: Map<string, string | Buffer>): void {
  const requirements = sources.flatMap(source => source.definition.agents.map(agent => {
    let record: unknown;
    // A rendered record can carry resolved app values: never let a parser error quote it.
    try { record = parse(String(files.get(`profiles/${agent.name}/profile.yaml`) ?? "")); }
    catch { throw new CliError(`profiles/${agent.name}/profile.yaml as rendered is not valid YAML`); }
    const spec = isRecord(record) && isRecord(record["spec"]) ? record["spec"] : {};
    const agentFile = agentLayout(path.join(source.root, agent.subdir)).agentFile;
    return { agent: agent.name, envRequires: spec["envRequires"], agentFile: `${source.definition.id}:${path.relative(source.root, agentFile)}` };
  }));
  const findings = uncoveredRequirements(plan, root, requirements);
  if (findings.length) {
    throw new CredentialGateError(renderFindings(plan, `${findings.length} required agent environment variable(s) would not reach their pod Secret; nothing was provisioned or published`, findings), findings);
  }
}
