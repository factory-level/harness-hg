// The agent runtime manifest (ADR-153): what a deployed agent actually
// got, as one small descriptive record.
//
// It exists because that fact had no home. The engine, the resolved source
// revision, where each code workspace is mounted and at which revision,
// which secrets the record requires and which third-party connections are
// bound were spread across a StatefulSet's env vars, a bundle's values
// file and two compilers - readable only by someone who already knew where
// to look, and unreadable at all while the pod was down.
//
// Two producers, ONE definition:
//   - this module, offline, from the same value documents the chart gets
//     (`hg agent inspect`, `hg agent render`);
//   - the eve-agent / eve-bundle charts, which render the same object into
//     a ConfigMap mounted at /hg/runtime-manifest.json.
// `hg agent prove` EVE022 compares the two. If they ever disagree, one of
// them is lying about the deployment and the proof says which.
//
// Deliberately DESCRIPTIVE: nothing reads it to decide behaviour, and it
// must never become a second configuration language. Everything in it is
// already stated somewhere authoritative; this is the join.

import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/2020";
import { CONTRACTS_ROOT, PLATFORM_ROOT, type AgentRuntime } from "../lib.ts";

export const RUNTIME_MANIFEST_CONTRACT = "agent-runtime/v1alpha1";
/** Where the charts mount it, and where `hg agent show` reads it from. */
export const RUNTIME_MANIFEST_PATH = "/hg/runtime-manifest.json";

/** The frozen contract this module and the charts both write
 * (agent-bundle-contracts/agent-runtime/v1alpha1). Compiled on first use: most
 * `hg` invocations never touch a manifest, and Ajv compilation is not
 * free. */
let validator: ValidateFunction | null = null;
export function validateRuntimeManifest(doc: unknown): string[] {
  if (!validator) {
    const schema = path.join(CONTRACTS_ROOT, "agent-runtime", "v1alpha1", "agent-runtime.schema.json");
    validator = new Ajv2020({ allErrors: true }).compile(JSON.parse(fs.readFileSync(schema, "utf8")));
  }
  if (validator(doc)) return [];
  // Ajv's additionalProperties message omits the offending key, which is
  // the one thing a reader needs when a producer invents a field.
  return (validator.errors ?? []).map((e) => {
    const where = e.instancePath || "/";
    const extra = e.keyword === "additionalProperties" ? ` (${(e.params as { additionalProperty?: string }).additionalProperty})` : "";
    return `${where} ${e.message}${extra}`;
  });
}

export interface ManifestWorkspace {
  name: string;
  /** The absolute path INSIDE the pod. Standalone agents mount workspaces
   * under /app/workspaces (on the data claim); a bundle gives its members
   * one shared claim at /workspaces. The manifest records which. */
  path: string;
  access: string;
  repository: string;
  revision: string;
}

export interface RuntimeManifest {
  contract: typeof RUNTIME_MANIFEST_CONTRACT;
  spec: {
    name: string;
    engine: AgentRuntime;
    /** The Kubernetes-facing identity (ADR-151). */
    instance: string;
    namespace: string;
    /** Present only when the agent is a member of a bundle. */
    bundle?: string;
    runtimeImage: string;
    source: { repository: string; revision: string; subdir?: string };
    workspaces: ManifestWorkspace[];
    /** Environment variable NAMES the record requires. Never values - this
     * object is a ConfigMap in the agent's namespace. */
    requiredSecrets: string[];
    connections: { name: string; provider: string }[];
    apps: string[];
  };
}

export interface ManifestInputs {
  name: string;
  engine: AgentRuntime;
  instance: string;
  namespace: string;
  bundle?: string;
  runtimeImage: string;
  source: string;
  revision: string;
  subdir?: string;
  workspaces: ManifestWorkspace[];
  requiredSecrets: string[];
  connections: { name: string; provider: string }[];
  apps: string[];
}

/** Build the manifest. Pure, and every list is SORTED: the chart renders
 * this object through Helm's `toJson` and the CLI through JSON.stringify,
 * so the only way the two can be compared is if neither depends on the
 * order its inputs happened to arrive in. */
export function buildRuntimeManifest(i: ManifestInputs): RuntimeManifest {
  const spec: RuntimeManifest["spec"] = {
    name: i.name,
    engine: i.engine,
    instance: i.instance,
    namespace: i.namespace,
    ...(i.bundle ? { bundle: i.bundle } : {}),
    runtimeImage: i.runtimeImage,
    source: {
      repository: i.source,
      revision: i.revision,
      ...(i.subdir ? { subdir: i.subdir } : {}),
    },
    workspaces: [...i.workspaces]
      .map((w) => ({ name: w.name, path: w.path, access: w.access, repository: w.repository, revision: w.revision }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    requiredSecrets: [...new Set(i.requiredSecrets)].sort(),
    connections: [...i.connections]
      .map((c) => ({ name: c.name, provider: c.provider }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    apps: [...new Set(i.apps)].sort(),
  };
  return { contract: RUNTIME_MANIFEST_CONTRACT, spec };
}

/** The manifest as the charts write it: two-space JSON with a trailing
 * newline. Only used for `hg agent render`'s file - EVE022 compares parsed
 * objects, because Helm's toJson sorts keys and JSON.stringify does not. */
export function serializeRuntimeManifest(m: RuntimeManifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Reading the value documents the chart gets

/** One member's slice of a bundle's values.yaml (`spec.profiles[]`). */
export interface BundleMemberValues {
  name?: string;
  source?: string;
  sha?: string;
  sourceSubdir?: string;
  envRequires?: string[];
  repositoryRefs?: string[];
  connections?: { name?: string; provider?: string }[];
}

/** A bundle's values.yaml (`spec`). */
export interface BundleValues {
  runtime?: string;
  name?: string;
  profiles?: BundleMemberValues[];
  repositories?: { name?: string; source?: string; sha?: string; access?: string; mountPath?: string }[];
}

/** An agent record's `spec` (profiles/<name>/profile.yaml), plus the
 * per-profile connection projection the ApplicationSet layers over it. */
export interface AgentRecordValues {
  persona?: string;
  runtime?: string;
  source?: string;
  sha?: string;
  sourceSubdir?: string;
  /** A bare string (required + secret, the record schema's conservative
   * default) or an object with a name - both ship in real records. */
  envRequires?: (string | { name?: string })[];
  apps?: { name?: string }[];
  connections?: { name?: string; provider?: string }[];
  workspace?: { repositories?: { name?: string; source?: string; sha?: string; access?: string }[] };
  deployment?: { runtimeImageTag?: string };
}

/** The NAME of an envRequires entry, whichever of its two shapes it is. */
export function envRequireName(entry: string | { name?: string }): string {
  return typeof entry === "string" ? entry : entry?.name ?? "";
}

/** The manifest for a STANDALONE agent, from its record. Workspaces mount
 * under /app/workspaces (the chart's `$wsRepos` loop). */
export function manifestFromRecord(
  record: AgentRecordValues,
  ctx: { name: string; instance: string; namespace: string; runtimeImage: string },
): RuntimeManifest {
  return buildRuntimeManifest({
    name: record.persona ?? ctx.name,
    engine: (record.runtime === "eve" ? "eve" : "hermes") as AgentRuntime,
    instance: ctx.instance,
    namespace: ctx.namespace,
    runtimeImage: ctx.runtimeImage,
    source: record.source ?? "",
    revision: record.sha ?? "",
    ...(record.sourceSubdir ? { subdir: record.sourceSubdir } : {}),
    workspaces: (record.workspace?.repositories ?? []).map((r) => ({
      name: r.name ?? "",
      path: `/app/workspaces/${r.name ?? ""}`,
      access: r.access ?? "read-write",
      repository: r.source ?? "",
      revision: r.sha ?? "",
    })),
    requiredSecrets: (record.envRequires ?? []).map(envRequireName).filter(Boolean),
    connections: (record.connections ?? []).map((c) => ({ name: c.name ?? "", provider: c.provider ?? "" })),
    apps: (record.apps ?? []).map((a) => a.name ?? "").filter(Boolean),
  });
}

/** The manifest for ONE MEMBER of a bundle, from the bundle's values. The
 * member's workspaces are the bundle-level repositories its
 * `repositoryRefs` names, mounted at the bundle's shared claim. */
export function manifestFromBundle(
  bundle: BundleValues,
  memberName: string,
  ctx: { instance: string; namespace: string; runtimeImage: string },
): RuntimeManifest | null {
  const member = (bundle.profiles ?? []).find((p) => p.name === memberName);
  if (!member) return null;
  const refs = new Set(member.repositoryRefs ?? []);
  return buildRuntimeManifest({
    name: memberName,
    engine: (bundle.runtime === "eve" ? "eve" : "hermes") as AgentRuntime,
    instance: ctx.instance,
    namespace: ctx.namespace,
    ...(bundle.name ? { bundle: bundle.name } : {}),
    runtimeImage: ctx.runtimeImage,
    source: member.source ?? "",
    revision: member.sha ?? "",
    ...(member.sourceSubdir ? { subdir: member.sourceSubdir } : {}),
    workspaces: (bundle.repositories ?? [])
      .filter((r) => r.name && refs.has(r.name))
      .map((r) => ({
        name: r.name!,
        path: r.mountPath ?? `/workspaces/${r.name}`,
        access: r.access ?? "read-write",
        repository: r.source ?? "",
        revision: r.sha ?? "",
      })),
    requiredSecrets: member.envRequires ?? [],
    connections: (member.connections ?? []).map((c) => ({ name: c.name ?? "", provider: c.provider ?? "" })),
    // A bundled member's apps deploy from deployments/apps, not from the
    // bundle chart (EVE020) - so the bundle's values carry none, and the
    // manifest says so rather than inventing them.
    apps: [],
  });
}
