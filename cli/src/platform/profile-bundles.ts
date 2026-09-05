// Compile operator-authored profile bundles into the generated records consumed
// by the hermes-bundles ApplicationSet. This is intentionally a separate,
// reviewable migration surface before ADR-28 replaces the legacy per-profile
// generator: it reads existing profile records, never profile source code, and
// writes only deployments/bundles/.

import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CONTRACTS_ROOT } from "../lib.ts";

const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SECRET_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
// One schema per declared version. A document names its own version and
// is validated against exactly that contract - unknown versions are
// refused loudly rather than guessed at.
const SCHEMA_FILES: Record<number, string> = {
  1: path.join(CONTRACTS_ROOT, "environment-bundles/v1alpha1/bundles.schema.json"),
  2: path.join(CONTRACTS_ROOT, "environment-bundles/v1alpha2/bundles.schema.json"),
  3: path.join(CONTRACTS_ROOT, "environment-bundles/v1alpha3/bundles.schema.json"),
  4: path.join(CONTRACTS_ROOT, "environment-bundles/v1alpha4/bundles.schema.json"),
};

export interface BundleProfileDeclaration {
  name: string;
  envSecretRef?: string;
  gitAuthSecretRef?: string;
  /** Where this profile's gateway serves its declared webhook endpoints.
   * Only meaningful in a version-2 document, and only needed when a
   * communication route TARGETS this profile (see the schema). */
  webhookPort?: number;
  gatewayEnabled?: boolean;
  apiServerPort?: number;
  terminalCwd?: string;
  repositoryRefs?: string[];
  /** Connections projected into this member (ADR-152): folded in by
   * mergeConnectionsIntoBundles from environment/connections.yaml, never
   * authored in bundles.yaml. */
  connections?: ConnectionProjection[];
}

/** One projected connection, the shape the charts consume (spec.connections[]
 * standalone, profiles[].connections[] in a bundle). */
export interface ConnectionProjection {
  name: string;
  provider: string;
  /** The platform Secret in hermes-secrets the ExternalSecret reads. */
  secretName: string;
  keys: string[];
}

export interface BundleRepositoryDeclaration {
  name: string;
  source: string;
  sha: string;
  mountPath: string;
  access: "read-only" | "read-write";
  gitAuthSecretRef?: string;
}

export interface BundleDeclaration {
  name: string;
  /** Human-facing Bundle title ("Marketing Team", #567). Presentation
   * only - `name` stays the machine identity every join uses. */
  displayName?: string;
  profiles: BundleProfileDeclaration[];
  repositories?: BundleRepositoryDeclaration[];
  placement?: {
    scope?: string;
    target?: string;
    argoDestination?: string;
    namespace?: string;
    application?: string;
  };
  deployment?: {
    baseImageTag?: string;
    diskSizeGb?: number;
    workspaceSizeGb?: number;
  };
  dashboard?: {
    enabled?: boolean;
    port?: number;
    envSecretRef?: string;
  };
}

export interface BundleDeclarations {
  version: 1 | 2 | 3 | 4;
  /** Optional since v4: a per-profile topology declares only its
   * distribution identity and ships no shared-pod bundles. */
  bundles?: BundleDeclaration[];
  /** The installed distribution's identity (v4): the operational
   * category this repository's agents group under. */
  distribution?: { name?: string; displayName: string };
}

interface ProfileRecord {
  spec?: {
    persona?: string;
    /** The agent runtime the record deploys on (ADR-149): absent means
     * hermes (the HermesProfile record has no runtime key). */
    runtime?: string;
    source?: string;
    sha?: string;
    sourceSubdir?: string;
    /** A bare string or an object with a name (the record schema's oneOf). */
    envRequires?: (string | { name?: string })[];
    gitAuthSecretRef?: string;
  };
}

export interface CompiledBundleProfile {
  name: string;
  source: string;
  sha: string;
  sourceSubdir?: string;
  /** The env variable NAMES this member's record requires (never values).
   * Carried into the bundle's values so the member's runtime manifest can
   * state them - a bundled member's record is not layered over the bundle
   * chart, so this is the only path they have (ADR-153). */
  envRequires?: string[];
  envSecretRef?: string;
  gitAuthSecretRef?: string;
  gatewayEnabled: boolean;
  apiServerPort?: number;
  webhookPort?: number;
  terminalCwd?: string;
  repositoryRefs: string[];
  connections?: ConnectionProjection[];
}

/** A bundle is HOMOGENEOUS (ADR-150): every member runs on one runtime,
 * because the pod is one chart - hermes-bundle runs gateways on the Hermes
 * image, eve-bundle runs `eve start` per member on the eve-runtime image.
 * The compiler reads the runtime off each member's RECORD (spec.runtime),
 * never off the declaration, and stamps it with the chart that realizes
 * it into deployment.yaml (the bundles ApplicationSet selects the chart
 * path from spec.chart, like the agents one). */
export type BundleRuntime = "hermes" | "eve";
export const BUNDLE_CHART: Record<BundleRuntime, string> = {
  hermes: "hermes-bundle",
  eve: "eve-bundle",
};
/** The instance-name prefix per runtime (ADR-151), mirrored from cli/src/lib.ts. */
export const BUNDLE_PREFIX: Record<BundleRuntime, string> = { hermes: "hermes-", eve: "ag-eve-" };

export interface CompiledBundle {
  id: string;
  name: string;
  runtime: BundleRuntime;
  chart: string;
  displayName?: string;
  scope: string;
  target: string;
  argoDestination: string;
  namespace: string;
  application: string;
  profiles: CompiledBundleProfile[];
  repositories: BundleRepositoryDeclaration[];
  deployment: {
    baseImageTag?: string;
    diskSizeGb: number;
    workspaceSizeGb: number;
  };
  dashboard: {
    enabled: boolean;
    port: number;
    envSecretRef?: string;
  };
}

export interface BundleCompileResult {
  bundles: CompiledBundle[];
  files: Map<string, string>;
}

function dump(value: unknown): string {
  return stringifyYaml(value, { sortMapEntries: true, lineWidth: 0 });
}

function readProfileRecord(gitopsDir: string, name: string): ProfileRecord {
  const file = path.join(gitopsDir, "profiles", name, "profile.yaml");
  if (!fs.existsSync(file)) {
    throw new Error(`bundle profile ${name}: ${file} does not exist`);
  }
  const record = parseYaml(fs.readFileSync(file, "utf8")) as ProfileRecord | null;
  if (!record?.spec) throw new Error(`bundle profile ${name}: ${file} has no spec`);
  return record;
}

export function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label}: duplicate ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

/** Reject mount paths that NEST, not merely ones that repeat.
 *
 * `assertUnique` catches `/workspaces/a` twice. It does not catch
 * `/workspaces/a` and `/workspaces/a/generated`, and that pair breaks the
 * read-only guarantee outright: Kubernetes marks the first mount
 * `readOnly: true`, then mounts the second WRITABLE inside it. A tree the
 * operator declared read-only is then partly writable, which is worse than
 * an honest error because the declaration still reads as if it holds.
 *
 * Compared segment-wise - a plain prefix test would call `/workspaces/ab`
 * a child of `/workspaces/a`. */
export function assertNoNestedMounts(mountPaths: string[], label: string): void {
  const split = mountPaths.map((p) => ({ path: p, segments: p.split("/") }));
  for (const a of split) {
    for (const b of split) {
      if (a.path === b.path) continue;
      if (a.segments.length >= b.segments.length) continue;
      if (b.segments.slice(0, a.segments.length).join("/") === a.path) {
        throw new Error(
          `${label}: ${JSON.stringify(b.path)} is nested inside ${JSON.stringify(a.path)} - ` +
            "a repository mounted under another cannot honour the outer repository's access mode",
        );
      }
    }
  }
}

/** The chart's values.schema.json constrains `sourceSubdir` to a segment
 * grammar (no traversal, no shell metacharacters). The profile contract it
 * is copied FROM is looser, so a record that is perfectly legal upstream
 * can compile here and then be rejected by Helm at deploy time - a failure
 * three steps from its cause, in a component nobody was editing.
 *
 * Fail here instead, naming the profile. Mirrors
 * harness/hermes/charts/hermes-bundle/values.schema.json; keep the two in step. */
const SUBDIR_SEGMENT = /^\.?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
function assertSourceSubdir(value: string, label: string): void {
  const segments = value.split("/");
  if (!segments.length || !segments.every((seg) => SUBDIR_SEGMENT.test(seg))) {
    throw new Error(
      `${label}: sourceSubdir ${JSON.stringify(value)} is not a plain relative path ` +
        "(segments of letters, digits, '.', '_' and '-'; no leading '/', no '..')",
    );
  }
}

export function assertSecretName(value: string, label: string): void {
  const labels = value.split(".");
  if (
    value.length > 253 ||
    !SECRET_NAME.test(value) ||
    labels.some((part) => !NAME.test(part) || part.length > 63)
  ) {
    throw new Error(`${label} ${JSON.stringify(value)} is not a valid Kubernetes Secret name`);
  }
}

export function assertWorkspaceMount(value: string, label: string): void {
  if (!value.startsWith("/workspaces/") || value.includes("\\")) {
    throw new Error(`${label} must be an absolute child of /workspaces`);
  }
  const segments = value.slice("/workspaces/".length).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an empty, '.' or '..' path segment`);
  }
}

export function loadBundleDeclarations(file: string): BundleDeclarations {
  const rawText = fs.readFileSync(file, "utf8");
  const raw = parseYaml(rawText) as BundleDeclarations;
  const schemaFile = SCHEMA_FILES[raw?.version as number];
  if (!schemaFile) {
    throw new Error(
      `${file}: unsupported bundles version ${JSON.stringify(raw?.version)} ` +
        `(supported: ${Object.keys(SCHEMA_FILES).join(", ")})`,
    );
  }
  const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
  const validate = ajv.compile(schema);
  if (!validate(raw)) {
    const lines = (validate.errors ?? []).map((error) => {
      const extra =
        "additionalProperty" in error.params
          ? ` (${JSON.stringify(error.params["additionalProperty"])})`
          : "";
      return `${error.instancePath || "/"} ${error.message ?? "invalid"}${extra}`;
    });
    throw new Error(`${file} failed bundle schema validation:\n- ${lines.join("\n- ")}`);
  }
  // Bundle-local repository authoring is retired (#365): workspace
  // repositories are profile capabilities, declared once in
  // environment/workspaces.yaml and folded into bundles by
  // mergeWorkspacesIntoBundles. The frozen v1alpha1/v1alpha2 schemas still
  // parse the fields, so the refusal lives here - at the authored
  // declaration, before anything compiles.
  const legacy: string[] = [];
  for (const bundle of raw.bundles ?? []) {
    if (bundle.repositories?.length) {
      legacy.push(`bundle ${bundle.name}: repositories [${bundle.repositories.map((r) => r.name).join(", ")}]`);
    }
    for (const profile of bundle.profiles ?? []) {
      if (profile.repositoryRefs?.length) {
        legacy.push(`bundle ${bundle.name} profile ${profile.name}: repositoryRefs [${profile.repositoryRefs.join(", ")}]`);
      }
    }
  }
  if (legacy.length > 0) {
    throw new Error(
      `${file}: bundle-local repository declarations are no longer accepted - move them to ` +
        `environment/workspaces.yaml as workspace bindings (workspace repositories are profile ` +
        `capabilities, not bundle configuration; migration: _docs/wiki/runbooks/workspace-bindings.md):\n- ` +
        legacy.join("\n- "),
    );
  }
  return raw;
}

export function compileBundles(
  gitopsDir: string,
  declarations: BundleDeclarations,
): BundleCompileResult {
  const declared = declarations.bundles ?? [];
  assertUnique(
    declared.map((bundle) => bundle.name),
    "bundles",
  );

  const globallyAssigned = new Map<string, string>();
  const compiled: CompiledBundle[] = [];

  for (const bundle of declared) {
    if (!NAME.test(bundle.name) || bundle.name.length > 40) {
      throw new Error(`bundle ${JSON.stringify(bundle.name)} is not a DNS-1123 label (max 40 chars)`);
    }
    assertUnique(
      bundle.profiles.map((profile) => profile.name),
      `bundle ${bundle.name} profiles`,
    );
    const repositories = bundle.repositories ?? [];
    assertUnique(
      repositories.map((repo) => repo.name),
      `bundle ${bundle.name} repositories`,
    );
    assertUnique(
      repositories.map((repo) => repo.mountPath),
      `bundle ${bundle.name} repository mount paths`,
    );
    assertNoNestedMounts(
      repositories.map((repo) => repo.mountPath),
      `bundle ${bundle.name} repository mount paths`,
    );
    const repositoryByName = new Map<string, BundleRepositoryDeclaration>();
    for (const repository of repositories) {
      repositoryByName.set(repository.name, repository);
      assertWorkspaceMount(repository.mountPath, `bundle ${bundle.name} repository ${repository.name} mountPath`);
      if (repository.gitAuthSecretRef) {
        assertSecretName(
          repository.gitAuthSecretRef,
          `bundle ${bundle.name} repository ${repository.name} gitAuthSecretRef`,
        );
      }
    }

    const dashboardEnabled = bundle.dashboard?.enabled ?? false;
    if (dashboardEnabled && !bundle.dashboard?.envSecretRef) {
      throw new Error(
        `bundle ${bundle.name}: dashboard.enabled requires dashboard.envSecretRef ` +
          "for its authentication provider",
      );
    }
    if (bundle.dashboard?.envSecretRef) {
      assertSecretName(bundle.dashboard.envSecretRef, `bundle ${bundle.name} dashboard.envSecretRef`);
    }
    const dashboard = {
      enabled: dashboardEnabled,
      port: bundle.dashboard?.port ?? 9119,
      ...(bundle.dashboard?.envSecretRef
        ? { envSecretRef: bundle.dashboard.envSecretRef }
        : {}),
    };

    const usedPorts = new Set<number>();
    if (dashboard.enabled) usedPorts.add(dashboard.port);

    // Runtime first, from the records, so the per-member rules below can
    // be runtime-aware and a mixed bundle fails before anything else.
    let runtime: BundleRuntime | null = null;
    let runtimeOwner = "";
    for (const declared of bundle.profiles) {
      const rawRuntime = readProfileRecord(gitopsDir, declared.name).spec!.runtime ?? "hermes";
      if (rawRuntime !== "hermes" && rawRuntime !== "eve") {
        throw new Error(
          `bundle profile ${declared.name}: record runtime ${JSON.stringify(rawRuntime)} is not one of hermes, eve`,
        );
      }
      if (runtime === null) {
        runtime = rawRuntime;
        runtimeOwner = declared.name;
      } else if (runtime !== rawRuntime) {
        throw new Error(
          `bundle ${bundle.name}: members must share one runtime - ${runtimeOwner} is ${runtime}, ` +
            `${declared.name} is ${rawRuntime}; a bundle is one pod on one chart (ADR-150), ` +
            "split them into two bundles",
        );
      }
    }
    const bundleRuntime: BundleRuntime = runtime ?? "hermes";
    if (bundleRuntime === "eve" && dashboard.enabled) {
      throw new Error(
        `bundle ${bundle.name}: dashboard.enabled is a Hermes dashboard knob with no Eve realization (ADR-150 cost)`,
      );
    }
    if (bundleRuntime === "eve" && bundle.deployment?.baseImageTag) {
      throw new Error(
        `bundle ${bundle.name}: deployment.baseImageTag names the Hermes image and has no Eve meaning; an Eve bundle runs on the platform's pinned eve-runtime image (ADR-150 cost: no per-bundle override yet)`,
      );
    }

    const profiles: CompiledBundleProfile[] = bundle.profiles.map((declared) => {
      if (declared.name === "default") {
        throw new Error(
          `bundle ${bundle.name}: profile name "default" is reserved by Hermes and cannot be installed as a managed profile`,
        );
      }
      const prior = globallyAssigned.get(declared.name);
      if (prior) {
        throw new Error(
          `profile ${declared.name} is assigned to both bundle ${prior} and ${bundle.name}`,
        );
      }
      globallyAssigned.set(declared.name, bundle.name);

      if (declared.envSecretRef) {
        assertSecretName(
          declared.envSecretRef,
          `bundle ${bundle.name} profile ${declared.name} envSecretRef`,
        );
      }
      if (declared.gitAuthSecretRef) {
        assertSecretName(
          declared.gitAuthSecretRef,
          `bundle ${bundle.name} profile ${declared.name} gitAuthSecretRef`,
        );
      }

      const repositoryRefs = declared.repositoryRefs ?? [];
      assertUnique(repositoryRefs, `bundle ${bundle.name} profile ${declared.name} repositoryRefs`);
      for (const repositoryRef of repositoryRefs) {
        if (!repositoryByName.has(repositoryRef)) {
          throw new Error(
            `bundle ${bundle.name} profile ${declared.name}: repositoryRef ` +
              `${JSON.stringify(repositoryRef)} does not name a declared bundle repository`,
          );
        }
      }

      const gatewayEnabled = declared.gatewayEnabled ?? true;
      if (declared.apiServerPort !== undefined && !gatewayEnabled) {
        throw new Error(
          `bundle ${bundle.name} profile ${declared.name}: apiServerPort requires gatewayEnabled`,
        );
      }
      if (declared.webhookPort !== undefined && !gatewayEnabled) {
        throw new Error(
          `bundle ${bundle.name} profile ${declared.name}: webhookPort requires gatewayEnabled`,
        );
      }
      // Hermes-only: its API server is keyed by API_SERVER_KEY from the env
      // Secret. An Eve member's apiServerPort is simply its listen port.
      if (bundleRuntime === "hermes" && declared.apiServerPort !== undefined && !declared.envSecretRef) {
        throw new Error(
          `bundle ${bundle.name} profile ${declared.name}: apiServerPort requires envSecretRef ` +
            "containing API_SERVER_KEY",
        );
      }

      const terminalCwd =
        declared.terminalCwd ??
        (repositoryRefs.length === 1 ? repositoryByName.get(repositoryRefs[0]!)!.mountPath : undefined);
      if (terminalCwd?.startsWith("/workspaces/")) {
        const assigned = repositoryRefs
          .map((repositoryRef) => repositoryByName.get(repositoryRef)!)
          .some(
            (repository) =>
              terminalCwd === repository.mountPath || terminalCwd.startsWith(`${repository.mountPath}/`),
          );
        if (!assigned) {
          throw new Error(
            `bundle ${bundle.name} profile ${declared.name}: terminalCwd ${JSON.stringify(terminalCwd)} ` +
              "is not inside one of its assigned repositoryRefs",
          );
        }
      }

      const record = readProfileRecord(gitopsDir, declared.name);
      const spec = record.spec!;
      if (!spec.source || !spec.sha) {
        throw new Error(
          `bundle profile ${declared.name}: profile record needs spec.source and spec.sha`,
        );
      }
      if (!/^[0-9a-f]{40}$/.test(spec.sha)) {
        throw new Error(`bundle profile ${declared.name}: spec.sha is not a full commit SHA`);
      }

      const envRequires = (spec.envRequires ?? [])
        .map((e) => (typeof e === "string" ? e : e?.name))
        .filter((n): n is string => typeof n === "string" && n.length > 0)
        .sort();
      const needsEnv = envRequires.length > 0;
      if (needsEnv && !declared.envSecretRef) {
        throw new Error(
          `bundle profile ${declared.name}: its record declares envRequires, so the bundle ` +
            `declaration must name envSecretRef in namespace ${BUNDLE_PREFIX[bundleRuntime]}${bundle.name}; ` +
            `the old per-profile Secret cannot be mounted across namespaces`,
        );
      }
      if (spec.gitAuthSecretRef && !declared.gitAuthSecretRef) {
        throw new Error(
          `bundle profile ${declared.name}: its private distribution used gitAuthSecretRef; ` +
            `declare the copied Secret name for namespace ${BUNDLE_PREFIX[bundleRuntime]}${bundle.name}`,
        );
      }
      for (const port of [declared.apiServerPort, declared.webhookPort]) {
        if (port === undefined) continue;
        if (usedPorts.has(port)) {
          throw new Error(
            `bundle ${bundle.name}: port ${port} is used more than once ` +
              `(profile API server, webhook or dashboard)`,
          );
        }
        usedPorts.add(port);
      }

      if (spec.sourceSubdir) {
        assertSourceSubdir(spec.sourceSubdir, `bundle ${bundle.name} profile ${declared.name}`);
      }

      return {
        name: declared.name,
        source: spec.source,
        sha: spec.sha,
        ...(spec.sourceSubdir ? { sourceSubdir: spec.sourceSubdir } : {}),
        ...(declared.envSecretRef ? { envSecretRef: declared.envSecretRef } : {}),
        ...(envRequires.length ? { envRequires } : {}),
        ...(declared.webhookPort !== undefined ? { webhookPort: declared.webhookPort } : {}),
        ...(declared.gitAuthSecretRef
          ? { gitAuthSecretRef: declared.gitAuthSecretRef }
          : {}),
        gatewayEnabled,
        ...(declared.apiServerPort !== undefined
          ? { apiServerPort: declared.apiServerPort }
          : {}),
        ...(terminalCwd ? { terminalCwd } : {}),
        repositoryRefs,
        ...(declared.connections?.length ? { connections: declared.connections } : {}),
      };
    });

    if (!profiles.some((profile) => profile.gatewayEnabled) && !dashboard.enabled) {
      throw new Error(
        `bundle ${bundle.name}: at least one profile gateway or the shared dashboard must be enabled`,
      );
    }

    const scope = bundle.placement?.scope ?? "global";
    const target = bundle.placement?.target ?? "in-cluster";
    const argoDestination = bundle.placement?.argoDestination ?? "in-cluster";
    // ADR-151: an Eve bundle's namespace/Application default to ag-eve-<name>.
    const prefix = BUNDLE_PREFIX[bundleRuntime];
    const namespace = bundle.placement?.namespace ?? `${prefix}${bundle.name}`;
    const application = bundle.placement?.application ?? `${prefix}${bundle.name}`;
    const id = scope === "global" ? bundle.name : `${bundle.name}@${scope}`;

    compiled.push({
      id,
      name: bundle.name,
      runtime: bundleRuntime,
      chart: BUNDLE_CHART[bundleRuntime],
      ...(bundle.displayName ? { displayName: bundle.displayName } : {}),
      scope,
      target,
      argoDestination,
      namespace,
      application,
      profiles,
      repositories,
      deployment: {
        ...(bundle.deployment?.baseImageTag
          ? { baseImageTag: bundle.deployment.baseImageTag }
          : {}),
        diskSizeGb: bundle.deployment?.diskSizeGb ?? 20,
        workspaceSizeGb: bundle.deployment?.workspaceSizeGb ?? 20,
      },
      dashboard,
    });
  }

  const files = new Map<string, string>();
  for (const bundle of compiled) {
    const dir = bundle.id.replace(/[@/]/g, "-");
    files.set(
      `deployments/bundles/${dir}/deployment.yaml`,
      dump({
        spec: {
          id: bundle.id,
          bundle: bundle.name,
          // Presentation title, carried in deployment.yaml ONLY (#567):
          // Nexus reads it from here; values.yaml stays chart input and
          // the hermes-bundle chart has no use for a display label.
          ...(bundle.displayName ? { displayName: bundle.displayName } : {}),
          scope: bundle.scope,
          target: bundle.target,
          argoDestination: bundle.argoDestination,
          namespace: bundle.namespace,
          application: bundle.application,
          // The runtime and the chart that realizes it (ADR-150): the
          // bundles ApplicationSet reads spec.chart with sprig `dig`, so
          // a record written before this key still renders hermes-bundle.
          runtime: bundle.runtime,
          chart: bundle.chart,
          profiles: bundle.profiles.map((profile) => profile.name),
        },
      }),
    );
    files.set(
      `deployments/bundles/${dir}/values.yaml`,
      dump({
        spec: {
          runtime: bundle.runtime,
          name: bundle.name,
          profiles: bundle.profiles,
          repositories: bundle.repositories,
          deployment: bundle.deployment,
          dashboard: bundle.dashboard,
        },
      }),
    );
  }

  return { bundles: compiled, files };
}

export function writeBundleTree(
  gitopsDir: string,
  result: BundleCompileResult,
  checkOnly = false,
): { written: string[]; deleted: string[]; changed: boolean } {
  const root = path.join(gitopsDir, "deployments", "bundles");
  const desired = new Set(result.files.keys());
  const written: string[] = [];
  const deleted: string[] = [];

  if (fs.existsSync(root)) {
    for (const bundleDir of fs.readdirSync(root)) {
      const absoluteBundle = path.join(root, bundleDir);
      if (!fs.statSync(absoluteBundle).isDirectory()) continue;
      for (const file of fs.readdirSync(absoluteBundle)) {
        const rel = path.posix.join("deployments/bundles", bundleDir, file);
        if (!desired.has(rel)) deleted.push(rel);
      }
    }
  }

  for (const [rel, content] of result.files) {
    const absolute = path.join(gitopsDir, rel);
    const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined;
    if (current !== content) written.push(rel);
  }

  const changed = written.length > 0 || deleted.length > 0;
  if (checkOnly || !changed) return { written, deleted, changed };

  for (const rel of deleted) fs.rmSync(path.join(gitopsDir, rel), { force: true });
  for (const [rel, content] of result.files) {
    const absolute = path.join(gitopsDir, rel);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root)) {
      const absolute = path.join(root, entry);
      if (fs.statSync(absolute).isDirectory() && fs.readdirSync(absolute).length === 0) {
        fs.rmdirSync(absolute);
      }
    }
  }
  return { written, deleted, changed };
}
