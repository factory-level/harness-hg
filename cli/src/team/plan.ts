import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { CliError } from "../lib.ts";

export interface SkillRequirement {
  path: string;
  entrypoint?: string;
  revision: string;
  tools: string[];
  files: string[];
  executables: string[];
  writes: string[];
  scenario: string;
}
export interface OverlaySource { repository: string; commit: string; path: string; credentialEnv?: string; gitAuthSecretRef?: string }
/** An operator overlay the bootstrap declares (ADR 0194): approved, commit-pinned content merged before build. */
export interface OverlayDeclaration {
  id: string;
  kind: "skill" | "tool" | "connection" | "instructions" | "file";
  mode: "append" | "override" | "remove";
  target: string;
  source?: OverlaySource;
  skill?: { tools: string[]; executables: string[]; writes: string[]; scenario: string };
}
export interface TeamSource {
  id: string;
  repository: string;
  ref: string;
  private: boolean;
  credentialEnv?: string;
  skillPolicy?: { approvals: string };
  /** Operator overlays for every agent of this source, applied before agent-level overlays. */
  overlays?: OverlayDeclaration[];
  agents: {
    name: string;
    subdir: string;
    gitAuthSecretRef?: string;
    appValues?: Record<string, Record<string, unknown>>;
    appChartSource?: { repository: string; revision?: string };
    appValueBindings?: Record<string, string>;
    environment: string[];
    environmentBindings?: Record<string, string>;
    tools: string[];
    writablePaths: string[];
    skills: SkillRequirement[];
    /** Canary one agent onto a runtime from the platform's allowed list (ADR 0192). */
    runtime?: { image: string; eveVersion: string };
    overlays?: OverlayDeclaration[];
    slack?: { url: string; signingSecretEnv: string };
  }[];
}
export interface TeamPlan {
  version: 1 | 2;
  id: string;
  /** Version 2: bootstrap-relative installation lock written by `hg team compile` (ADR 0190). */
  lock?: string;
  sources: TeamSource[];
  destination: { repository: string; branch: string; credentialEnv: string; autoMerge: boolean };
  /** Explicit reviewed baseline for adopting pre-ledger generated files. */
  adoptRevision?: string;
  environment: string;
  /** Version 2: the platform revision this installation publishes and deploys from (ADR 0193). */
  platform?: { repository: string; ref: string; credentialEnv?: string };
  argoDestinations: string[];
  runtime: { image: string; platform: string };
  bootstrap: { directory: string; stack: string };
  /** Existing provider-owned stacks. Configuration contains non-secret activation gates only. */
  integrations?: { id: string; directory: string; stack: string; configFile: string;
    provision: Record<string, boolean>; activate: Record<string, boolean>;
    outputs: Record<string, string[]> }[];
  credentials?: { configFile: string; bindings: Record<string, string>; inputs?: Record<string, string>;
    secretInputs?: Record<string, { namespace: string; secret: string; key: string }> };
  activeConfig?: Record<string, boolean | string>;
  kubeContext: string;
  routerImage?: string;
  observerUrl?: string;
  workloadEndpoints?: string;
  terminalCwds?: Record<string, string>;
  authorizations: ("provision" | "publish" | "activate" | "acceptance" | "recover")[];
  /** `unattended: true` lets a watcher run a write-effect scenario without a person present (ADR 0191). */
  acceptance: { id: string; source: string; agent: string; argv: string[]; effect: "read" | "write"; unattended?: boolean }[];
}
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
/** Version-2 refs never move: a full commit, or an explicit tag ref valid under git's own
 * ref-name rules (git check-ref-format), so a plan never fails later at fetch (ADR 0190). */
export function immutableRef(ref: string): boolean {
  if (/^[a-f0-9]{40}$/.test(ref)) return !/^0+$/.test(ref);
  if (!ref.startsWith("refs/tags/")) return false;
  const name = ref.slice("refs/tags/".length);
  if (!name || name.endsWith("/") || name.endsWith(".") || name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));
}
/** All declared inputs that can change production permissions or transport behavior. */
/** Every environment name the plan treats as a credential or runtime secret. */
export function secretEnvironmentNames(plan: TeamPlan): Set<string> {
  return new Set([
    plan.destination.credentialEnv,
    ...plan.sources.flatMap(s => [s.credentialEnv, ...s.agents.flatMap(a => [...a.environment, ...Object.values(a.environmentBindings ?? {}), ...Object.values(a.appValueBindings ?? {}), a.slack?.signingSecretEnv]), ...[...(s.overlays ?? []), ...s.agents.flatMap(a => a.overlays ?? [])].map(o => o.source?.credentialEnv)]),
    ...Object.keys(plan.credentials?.bindings ?? {}),
    ...Object.keys(plan.credentials?.inputs ?? {}),
    ...Object.keys(plan.credentials?.secretInputs ?? {}),
    ...(plan.integrations ?? []).flatMap(i => Object.keys(i.outputs)),
  ].filter((key): key is string => Boolean(key)));
}
export function credentialFingerprint(plan: TeamPlan, env: NodeJS.ProcessEnv = process.env): string {
  const names = secretEnvironmentNames(plan);
  const destinationUsedByRuntime = plan.sources.some(s => s.agents.some(a =>
    a.environment.includes(plan.destination.credentialEnv) || Object.values(a.environmentBindings ?? {}).includes(plan.destination.credentialEnv) || Object.values(a.appValueBindings ?? {}).includes(plan.destination.credentialEnv) || a.slack?.signingSecretEnv === plan.destination.credentialEnv));
  if (!destinationUsedByRuntime) names.delete(plan.destination.credentialEnv);
  return digest([...names].sort().map(key => [key, env[key] ?? null]));
}
const name = /^[a-z][a-z0-9-]*$/;
const variable = /^[A-Z_][A-Z0-9_]*$/;
export function relativePath(value: string): boolean {
  return typeof value === "string" && Boolean(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).some(p => p === ".." || p === ".git") && !value.includes("\0");
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new CliError(`team plan: ${message}`);
}
const overlayKinds = new Set(["skill", "tool", "connection", "instructions", "file"]);
const overlayModes = new Set(["append", "override", "remove"]);
function validateOverlays(list: unknown, where: string): void {
  if (list === undefined) return;
  assert(Array.isArray(list), `${where}: overlays must be an array`);
  const ids = new Set<string>();
  for (const o of list as OverlayDeclaration[]) {
    assert(o && typeof o.id === "string" && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(o.id) && o.id.length <= 40 && !ids.has(o.id), `${where}: overlay ids must be unique DNS labels`);
    ids.add(o.id);
    assert(overlayKinds.has(o.kind) && overlayModes.has(o.mode), `${where}: overlay ${o.id} needs a known kind and mode`);
    assert(typeof o.target === "string" && o.target.startsWith("agent/") && relativePath(o.target), `${where}: overlay ${o.id} target must be a path under agent/`);
    if (o.mode === "remove") {
      assert(o.source === undefined && o.skill === undefined, `${where}: overlay ${o.id}: a removal carries no source or skill requirements`);
      continue;
    }
    const source = o.source;
    assert(source && typeof source.repository === "string" && (/^https:\/\/[^/@\s?#]+\/[^\s?#@]+$/.test(source.repository) || /^git@[^:\s]+:\S+$/.test(source.repository)), `${where}: overlay ${o.id} needs a credential-free https:// or git@ repository`);
    assert(typeof source.commit === "string" && /^[a-f0-9]{40}$/.test(source.commit) && !/^0+$/.test(source.commit), `${where}: overlay ${o.id} pins a full 40-character commit`);
    assert(source.path === "." || relativePath(source.path), `${where}: overlay ${o.id} source path must stay inside its repository`);
    assert(!source.credentialEnv === !source.gitAuthSecretRef, `${where}: private overlay ${o.id} needs both credentialEnv (the planning fetch) and gitAuthSecretRef (the build container)`);
    if (source.credentialEnv) assert(variable.test(source.credentialEnv) && source.repository.startsWith("https://github.com/") && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(source.gitAuthSecretRef ?? ""), `${where}: private overlay ${o.id} needs an HTTPS GitHub repository, an environment reference and a Secret name`);
    if (o.kind === "skill") assert(o.skill && [o.skill.tools, o.skill.executables, o.skill.writes].every(Array.isArray) && typeof o.skill.scenario === "string" && !!o.skill.scenario, `${where}: skill overlay ${o.id} declares tools, executables, writes and its acceptance scenario`);
    else assert(o.skill === undefined, `${where}: only skill overlays carry skill requirements`);
  }
}
export function validatePlan(input: unknown): TeamPlan {
  const p = input as TeamPlan;
  assert(p && (p.version === 1 || p.version === 2), "requires version 1 or 2");
  assert(typeof p.id === "string" && name.test(p.id), "invalid installation id");
  assert(Array.isArray(p.sources) && p.sources.length > 0, "sources must not be empty");
  const ids = new Set<string>(), profiles = new Set<string>();
  const repository = (s: string) => typeof s === "string" && (/^https:\/\/[^/@\s]+\/[^\s?#]+$/.test(s) || /^git@[^:\s]+:[^\s]+$/.test(s));
  for (const s of p.sources) {
    assert(typeof s.id === "string" && name.test(s.id) && !ids.has(s.id), "invalid or duplicate source id"); ids.add(s.id);
    assert(repository(s.repository), `source ${s.id} needs a credential-free Git URL`);
    assert(typeof s.ref === "string" && !!s.ref && !s.ref.startsWith("-") && !/\s/.test(s.ref), `source ${s.id} needs a ref`);
    if (p.version === 2) assert(immutableRef(s.ref), `source ${s.id}: version 2 plans pin refs/tags/<tag> or a full 40-character commit, never a branch`);
    assert(typeof s.private === "boolean", `source ${s.id} must declare private`);
    assert(!s.credentialEnv || variable.test(s.credentialEnv), "invalid credential environment reference");
    assert(!s.credentialEnv || /^https:\/\/github.com\//.test(s.repository), "environment-token source authentication requires an HTTPS GitHub URL");
    assert(!s.private || s.credentialEnv, `private source ${s.id} needs credentialEnv`);
    if (s.skillPolicy) assert(relativePath(s.skillPolicy.approvals), `source ${s.id}: skill approvals must be bootstrap-relative`);
    assert(Array.isArray(s.agents) && s.agents.length, `source ${s.id} has no agents`);
    for (const a of s.agents) {
      assert(typeof a.name === "string" && name.test(a.name) && a.name.length <= 40 && !profiles.has(a.name), "invalid or duplicate agent identity"); profiles.add(a.name);
      assert(typeof a.subdir === "string" && relativePath(a.subdir), `invalid subdirectory for ${a.name}`);
      assert(!s.private || (typeof a.gitAuthSecretRef === "string" && /^[a-z0-9][a-z0-9.-]*$/.test(a.gitAuthSecretRef)), `${a.name} needs its workload Git Secret binding`);
      if (a.appChartSource) {
        const chart = a.appChartSource;
        assert(repository(chart.repository) && chart.repository.startsWith("https://") && chart.repository === s.repository && s.private && Boolean(s.credentialEnv), `${a.name}: appChartSource requires a credential-free HTTPS repository and immutable commit`);
        // Version 2 derives the chart revision from the locked source commit, so the two cannot disagree.
        if (p.version === 2) assert(chart.revision === undefined, `${a.name}: version 2 derives appChartSource.revision from the locked source commit; remove it`);
        else assert(typeof chart.revision === "string" && /^[a-f0-9]{40}$/.test(chart.revision) && !/^0+$/.test(chart.revision), `${a.name}: appChartSource requires a credential-free HTTPS repository and immutable commit`);
      }
      if (a.appValues) assert(typeof a.appValues === "object" && !Array.isArray(a.appValues), `${a.name}: appValues must be an object of bootstrap overrides`);
      if (a.appValueBindings) assert(typeof a.appValueBindings === "object" && !Array.isArray(a.appValueBindings) && Object.entries(a.appValueBindings).every(([target, source]) => /^[\w-]+(?:\.[\w-]+)+$/.test(target) && !target.split(".").some(p => ["__proto__", "constructor", "prototype"].includes(p)) && typeof source === "string" && variable.test(source)), `${a.name}: app value bindings must map safe dotted paths to operator environment references`);
      // Shape only: whether the pair is one the platform publishes is effectiveRuntime's answer,
      // so a plan validates the same way wherever the allowed list is read from.
      if (a.runtime !== undefined) {
        assert(p.version === 2, `${a.name}: only version 2 plans pin a per-agent runtime`);
        assert(a.runtime && typeof a.runtime === "object" && !Array.isArray(a.runtime) && Object.keys(a.runtime).sort().join(",") === "eveVersion,image", `${a.name}: runtime pin carries exactly image and eveVersion`);
        assert(typeof a.runtime.image === "string" && /^\S+@sha256:[a-f0-9]{64}$/.test(a.runtime.image), `${a.name}: pinned runtime image must be pinned by digest`);
        assert(typeof a.runtime.eveVersion === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.]+)?$/.test(a.runtime.eveVersion), `${a.name}: pinned runtime needs the Eve release its image ships`);
      }
      for (const field of ["environment", "tools", "writablePaths", "skills"] as const) assert(Array.isArray(a[field]), `${a.name}.${field} must be an array`);
      assert(a.environment.every(v => typeof v === "string" && variable.test(v)), `invalid environment reference for ${a.name}`);
      if (a.environmentBindings) assert(typeof a.environmentBindings === "object" && !Array.isArray(a.environmentBindings) && Object.entries(a.environmentBindings).every(([target, source]) => a.environment.includes(target) && typeof source === "string" && variable.test(source)), `${a.name}: environment bindings must map declared runtime names to operator environment references`);
      if (a.slack) assert(/^https:\/\/[^@\s]+$/.test(a.slack.url) && variable.test(a.slack.signingSecretEnv), `${a.name}: invalid Slack endpoint or signing-secret reference`);
      for (const skill of a.skills) {
        if (skill.entrypoint !== undefined) assert(relativePath(skill.entrypoint), `${a.name}: invalid skill entrypoint`);
        assert(relativePath(skill.path) && /^[a-f0-9]{64}$/.test(skill.revision), `${a.name}: skill path and content SHA-256 required`);
        assert([skill.tools, skill.files, skill.executables, skill.writes].every(Array.isArray), `${a.name}: incomplete skill requirements`);
        assert(typeof skill.scenario === "string" && skill.scenario.length, `${a.name}: skill scenario required`);
      }
      validateOverlays(a.overlays, a.name);
    }
    validateOverlays(s.overlays, `source ${s.id}`);
    if (s.overlays?.length || s.agents.some(a => a.overlays?.length)) assert(s.skillPolicy, `source ${s.id}: operator overlays need skillPolicy.approvals`);
  }
  assert(p.destination && /^https:\/\/github.com\/[\w.-]+\/[\w.-]+$/.test(p.destination.repository), "destination needs a credential-free Git URL");
  assert(typeof p.destination.branch === "string" && !!p.destination.branch && !p.destination.branch.startsWith("-") && !/\s/.test(p.destination.branch), "invalid destination branch");
  assert(variable.test(p.destination.credentialEnv), "destination needs credentialEnv");
  assert(typeof p.destination.autoMerge === "boolean", "destination must declare autoMerge");
  if (p.version === 2) assert(typeof p.lock === "string" && relativePath(p.lock), "version 2 plans name a bootstrap-relative lock file");
  else assert(p.lock === undefined, "only version 2 plans name an installation lock");
  if (p.adoptRevision !== undefined) assert(/^[a-f0-9]{40}$/.test(p.adoptRevision), "adoptRevision must be the reviewed destination commit");
  assert(!p.sources.some(s => s.repository.replace(/\.git$/, "") === p.destination.repository.replace(/\.git$/, "")), "source and generated destination must differ");
  assert(typeof p.environment === "string" && relativePath(p.environment), "environment must be bootstrap-relative");
  if (p.platform !== undefined) {
    assert(p.version === 2, "only version 2 plans declare a platform revision");
    assert(p.platform && typeof p.platform === "object" && !Array.isArray(p.platform) && ["ref,repository", "credentialEnv,ref,repository"].includes(Object.keys(p.platform).sort().join(",")), "platform carries exactly repository, ref and an optional credentialEnv");
    assert(repository(p.platform.repository), "platform needs a credential-free Git URL");
    assert(typeof p.platform.ref === "string" && immutableRef(p.platform.ref), "platform pins refs/tags/<tag> or a full 40-character commit, never a branch");
    assert(!p.platform.credentialEnv || variable.test(p.platform.credentialEnv), "invalid platform credential environment reference");
    assert(!p.platform.credentialEnv || /^https:\/\/github.com\//.test(p.platform.repository), "platform token authentication requires an HTTPS GitHub URL");
    // Provisioning carries the locked revision through the encrypted bootstrap baseline. Without
    // one there is nowhere to put it, and the revision would silently not reach the cluster.
    assert(p.credentials, "a platform revision needs credentials.configFile: provisioning carries the revision through the encrypted bootstrap baseline");
  }
  assert(p.bootstrap && relativePath(p.bootstrap.directory) && typeof p.bootstrap.stack === "string" && !!p.bootstrap.stack, "bootstrap directory and stack required");
  if (p.integrations) {
    assert(Array.isArray(p.integrations), "integrations must be an array");
    const integrationIds = new Set<string>();
    for (const i of p.integrations) {
      assert(typeof i.id === "string" && name.test(i.id) && !integrationIds.has(i.id), "invalid or duplicate integration owner"); integrationIds.add(i.id);
      assert(relativePath(i.directory) && relativePath(i.configFile) && typeof i.stack === "string" && !!i.stack, "integration needs owned directory, stack and encrypted config file");
      for (const gates of [i.provision, i.activate]) assert(gates && typeof gates === "object" && !Array.isArray(gates) && Object.values(gates).every(v => typeof v === "boolean"), "integration gates must be booleans");
      assert(i.outputs && Object.entries(i.outputs).every(([env, parts]) => variable.test(env) && Array.isArray(parts) && parts.length && parts.every(p => typeof p === "string" && !!p)), "integration outputs must map environment names to output key paths");
    }
  }
  if (p.credentials) assert(relativePath(p.credentials.configFile) && p.credentials.bindings && Object.entries(p.credentials.bindings).every(([env, key]) => variable.test(env) && typeof key === "string" && !!key), "credential bindings need an encrypted config file and named environment inputs");
  if (p.credentials?.inputs) assert(typeof p.credentials.inputs === "object" && !Array.isArray(p.credentials.inputs) && Object.entries(p.credentials.inputs).every(([env, key]) => variable.test(env) && typeof key === "string" && /^[\w-]+:[\w-]+(?:\.[\w-]+)*$/.test(key)), "credential inputs must reference named bootstrap config paths");
  if (p.credentials?.secretInputs) assert(typeof p.credentials.secretInputs === "object" && !Array.isArray(p.credentials.secretInputs) && Object.entries(p.credentials.secretInputs).every(([env, ref]) => variable.test(env) && !p.credentials?.inputs?.[env] && ref && typeof ref.namespace === "string" && /^[a-z0-9][a-z0-9-]*$/.test(ref.namespace) && typeof ref.secret === "string" && /^[a-z0-9][a-z0-9.-]*$/.test(ref.secret) && typeof ref.key === "string" && /^[A-Za-z0-9._-]+$/.test(ref.key)), "secret inputs must reference explicit namespace, Secret and key without overlapping config inputs");
  if (p.activeConfig) assert(p.activeConfig && !Array.isArray(p.activeConfig) && Object.values(p.activeConfig).every(v => typeof v === "boolean" || v === "true" || v === "false"), "activeConfig may contain only activation booleans");
  assert(typeof p.kubeContext === "string" && !!p.kubeContext, "explicit kubeContext required");
  assert(p.runtime && typeof p.runtime.image === "string" && /^\S+@sha256:[a-f0-9]{64}$/.test(p.runtime.image), "runtime image must be pinned by digest");
  assert(/^linux\/(amd64|arm64)$/.test(p.runtime.platform), "runtime platform must be linux/amd64 or linux/arm64");
  assert(Array.isArray(p.argoDestinations) && p.argoDestinations.length && p.argoDestinations.every(x => typeof x === "string" && !!x), "registered Argo destinations required");
  assert(Array.isArray(p.authorizations) && p.authorizations.every(x => ["provision", "publish", "activate", "acceptance", "recover"].includes(x)), "invalid authorization scope");
  assert(Array.isArray(p.acceptance) && p.acceptance.length, "acceptance scenarios required");
  const scenarios = new Set<string>();
  for (const a of p.acceptance) {
    assert(typeof a.id === "string" && name.test(a.id) && !scenarios.has(a.id), "duplicate or invalid acceptance id"); scenarios.add(a.id);
    assert(p.sources.some(s => s.id === a.source && s.agents.some(x => x.name === a.agent)), `scenario ${a.id} needs its source and agent`);
    assert(Array.isArray(a.argv) && a.argv.length && a.argv.every(x => typeof x === "string" && !x.includes("\0")), "acceptance argv required");
    assert(["read", "write"].includes(a.effect), "acceptance effect must be read or write");
    assert(a.unattended === undefined || typeof a.unattended === "boolean", `scenario ${a.id}: unattended must be a boolean`);
    assert(!a.unattended || a.effect === "write", `scenario ${a.id}: unattended applies to write scenarios only (read scenarios always run)`);
  }
  for (const s of p.sources) for (const a of s.agents) {
    assert(p.acceptance.some(x => x.agent === a.name), `${a.name} needs an acceptance scenario`);
    for (const skill of a.skills) assert(p.acceptance.some(x => x.id === skill.scenario && x.agent === a.name), `${a.name}: missing skill scenario`);
    for (const o of [...(s.overlays ?? []), ...(a.overlays ?? [])]) if (o.skill) assert(p.acceptance.some(x => x.id === o.skill!.scenario && x.agent === a.name), `${a.name}: missing acceptance scenario for skill overlay ${o.id}`);
  }
  return p;
}
export function loadPlan(file: string): TeamPlan {
  return validatePlan(parse(fs.readFileSync(file, "utf8")));
}
