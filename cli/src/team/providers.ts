import fs from "node:fs";
import path from "node:path";
import type { TeamPlan } from "./plan.ts";
import type { InstallationLock } from "./lock.ts";
import { run, type Run } from "./process.ts";
import { parse } from "yaml";
import { digest } from "./plan.ts";
import { pulumiEnvironment } from "./credentials.ts";

function owned(root: string, file: string): string {
  const resolved = fs.realpathSync(path.resolve(root, file));
  if (resolved !== fs.realpathSync(root) && !resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new Error("Provider path escapes bootstrap ownership");
  return resolved;
}
/** Resolve existing managed credentials without materializing plaintext files or logging values. */
export async function readBootstrapInputs(plan: TeamPlan, root: string, exec: Run = run): Promise<void> {
  if (!plan.credentials) return;
  const values = new Map<string, string>();
  // Every Pulumi read runs against the installation's derived backend (ADR 0196).
  const pulumiEnv = Object.keys(plan.credentials.inputs ?? {}).length ? pulumiEnvironment(plan, root) : process.env;
  for (const [environment, key] of Object.entries(plan.credentials.inputs ?? {})) {
    if (!values.has(key)) {
      const output = await exec(["pulumi", "config", "get", "--json", "--path", key,
        "--stack", plan.bootstrap.stack, "--config-file", owned(root, plan.credentials.configFile)],
        owned(root, plan.bootstrap.directory), pulumiEnv);
      let value: unknown;
      try { value = JSON.parse(output)?.value; } catch { throw new Error(`Invalid bootstrap credential response for ${environment}`); }
      if (typeof value !== "string" || !value.length) throw new Error(`Missing scalar bootstrap credential input ${environment}`);
      values.set(key, value);
    }
    process.env[environment] = values.get(key)!;
  }
  const secrets = new Map<string, Record<string, string>>();
  for (const [environment, ref] of Object.entries(plan.credentials.secretInputs ?? {})) {
    const identity = `${ref.namespace}/${ref.secret}`;
    if (!secrets.has(identity)) {
      const output = await exec(["kubectl", "--context", plan.kubeContext, "-n", ref.namespace,
        "get", "secret", ref.secret, "-o", "json"], root);
      try { secrets.set(identity, JSON.parse(output)?.data ?? {}); }
      catch { throw new Error(`Invalid managed Secret response for ${environment}`); }
    }
    const encoded = secrets.get(identity)?.[ref.key];
    if (typeof encoded !== "string" || !encoded.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error(`Missing managed Secret key for ${environment}`);
    const value = Buffer.from(encoded, "base64").toString("utf8");
    if (!value || value.includes("\0")) throw new Error(`Invalid managed Secret value for ${environment}`);
    process.env[environment] = value;
  }
}
/** Activation gates are deliberately restricted to unencrypted dotted boolean paths. */
export function provisioningGate(baseline: unknown, key: string, previouslyEnabled = false): boolean {
  if (!/^[\w-]+:[\w-]+(?:\.[\w-]+)*$/.test(key)) throw new Error("Activation gates require namespace-qualified dotted paths");
  const [first, ...rest] = key.split(".");
  let value: any = (baseline as any)?.config?.[first!];
  for (const part of rest) {
    if (value?.secure) throw new Error("Activation gate is encrypted; use a separate boolean gate");
    value = value?.[part];
  }
  if (value !== undefined && ![true, false, "true", "false"].includes(value)) throw new Error("Activation gate must be a plain boolean");
  return previouslyEnabled || value === true || value === "true";
}
function gatesFile(stateRoot: string, cwd: string, stack: string) {
  return path.join(stateRoot, `enabled-${digest({ cwd, stack })}.json`);
}
export function enabled(stateRoot: string, cwd: string, stack: string): Record<string, boolean> {
  const file = gatesFile(stateRoot, cwd, stack);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}
export function recordEnabled(stateRoot: string, cwd: string, stack: string, gates: Record<string, boolean | string>) {
  const previous = enabled(stateRoot, cwd, stack);
  for (const [key, value] of Object.entries(gates)) if (value === true || value === "true") previous[key] = true;
  const file = gatesFile(stateRoot, cwd, stack);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(previous), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file);
}
/** The configured provider owns app identities and one-time secret capture. No Slack adoption
 * or token generation is guessed here. Temporary phase configs retain the current ciphertext. */
export async function applyIntegrations(plan: TeamPlan, root: string, stateRoot: string, phase: "provision" | "activate") {
  if (!plan.authorizations.includes(phase === "provision" ? "provision" : "activate")) throw new Error(`Missing ${phase} authorization`);
  const env = pulumiEnvironment(plan, root);
  for (const integration of plan.integrations ?? []) {
    const cwd = owned(root, integration.directory);
    const config = path.join(stateRoot, `integration-${integration.id}.yaml`);
    // Merge from today's authoritative encrypted config, never yesterday's temporary copy.
    fs.copyFileSync(owned(root, integration.configFile), config); fs.chmodSync(config, 0o600);
    const baseline = parse(fs.readFileSync(config, "utf8"));
    const previous = enabled(stateRoot, cwd, integration.stack);
    for (const [key, requested] of Object.entries({ ...integration.provision, ...(phase === "activate" ? integration.activate : {}) })) {
      const value = requested || provisioningGate(baseline, key, previous[key]);
      await run(["pulumi", "config", "set", "--stack", integration.stack, "--config-file", config, "--path", key, String(value)], cwd, env);
    }
    await run(["pulumi", "up", "--stack", integration.stack, "--config-file", config, "--yes", "--suppress-outputs"], cwd, env, 900_000);
    recordEnabled(stateRoot, cwd, integration.stack, { ...integration.provision, ...(phase === "activate" ? integration.activate : {}) });
    await readIntegrationOutputs(plan, root, integration.id);
  }
}
export async function readIntegrationOutputs(plan: TeamPlan, root: string, only?: string) {
  for (const integration of plan.integrations ?? []) {
    if (only && integration.id !== only) continue;
    const outputs = JSON.parse(await run(["pulumi", "stack", "output", "--stack", integration.stack, "--json", "--show-secrets"], owned(root, integration.directory), pulumiEnvironment(plan, root)));
    for (const [environment, keys] of Object.entries(integration.outputs)) {
      const value = keys.reduce((value, key) => value?.[key], outputs);
      if (typeof value !== "string" || !value) throw new Error(`Integration ${integration.id}: required credential output is unavailable`);
      process.env[environment] = value;
    }
  }
}

export async function bootstrapConfig(plan: TeamPlan, root: string, stateRoot: string, active = false, lock?: InstallationLock): Promise<string | undefined> {
  if (!plan.credentials) {
    if (active && Object.keys(plan.activeConfig ?? {}).length) throw new Error("Activation requires a configured encrypted bootstrap baseline");
    return undefined;
  }
  const config = path.join(stateRoot, "bootstrap.yaml");
  fs.copyFileSync(owned(root, plan.credentials.configFile), config); fs.chmodSync(config, 0o600);
  const cwd = owned(root, plan.bootstrap.directory);
  const env = pulumiEnvironment(plan, root);
  for (const [environment, key] of Object.entries(plan.credentials.bindings)) {
    const value = process.env[environment];
    if (!value) throw new Error(`Missing credential environment reference ${environment}`);
    // Secret values arrive over stdin and are encrypted by the existing stack provider.
    await run(["pulumi", "config", "set", "--stack", plan.bootstrap.stack, "--config-file", config, "--secret", "--path", key], cwd, env, 120_000, value);
  }
  for (const source of plan.sources) for (const agent of source.agents) {
    if (!agent.appChartSource) continue;
    const token = source.credentialEnv ? process.env[source.credentialEnv] : undefined;
    if (!token) throw new Error(`Missing private chart source credential for ${agent.name}`);
    for (const [key, value] of Object.entries({ repository: agent.appChartSource.repository, username: "x-access-token", password: token })) {
      await run(["pulumi", "config", "set", "--stack", plan.bootstrap.stack, "--config-file", config, "--secret", "--path", `hermes-gitops-bootstrap:applicationGitAuth.${agent.name}.${key}`], cwd, env, 120_000, value);
    }
  }
  // The locked platform revision is what provisioning deploys: the compiler that publishes and
  // the charts Argo CD syncs are then the same revision, and a rollback is one lock commit.
  if (lock?.platform && plan.platform) {
    for (const [key, value] of Object.entries({ hermesGitopsRepoUrl: plan.platform.repository, chartRevision: lock.platform.revision })) {
      await run(["pulumi", "config", "set", "--stack", plan.bootstrap.stack, "--config-file", config, "--path", `hermes-gitops-bootstrap:${key}`, value], cwd, env);
    }
  }
  const baseline = parse(fs.readFileSync(config, "utf8"));
  const previous = enabled(stateRoot, cwd, plan.bootstrap.stack);
  for (const [key, requested] of Object.entries(plan.activeConfig ?? {})) {
    const value = (active && (requested === true || requested === "true")) || provisioningGate(baseline, key, previous[key]);
    await run(["pulumi", "config", "set", "--stack", plan.bootstrap.stack, "--config-file", config, "--path", key, String(value)], cwd, env);
  }
  return config;
}
