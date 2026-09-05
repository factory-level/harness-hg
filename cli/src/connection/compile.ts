// Compile the operator-authored Connections declaration (ADR-152,
// environment/connections.yaml) into deployment-neutral records.
//
// A connection is ONE third-party app registration - a Discord application
// and its bot, a GitHub App - declared once and granted to profiles by
// explicit bindings. Two things come out of a binding:
//
//   1. the PROJECTION: the connection's secret keys, held in one platform
//      Secret (hermes-secrets/connection-<name>), reach the bound profile's
//      namespace as <instance>-connection-<name> (an ExternalSecret the
//      agent chart renders from deployments/connections/profiles/<p>.yaml)
//      and its pod through envFrom - so the agent's own channel code finds
//      DISCORD_* / GITHUB_* in the environment exactly as eve documents;
//   2. the ROUTE: the event router's gateway verifies the provider's
//      signature on POST /v1/connect/<provider>/<name> and forwards the
//      request verbatim to the profile the binding's match rule selects
//      (deployments/connections/gateway.yaml -> the router's spec.connections).
//
// Pure, like the workspace compiler: the caller passes every profile's
// deployed coordinates (runtime, namespace, service, port) in as data, so
// `hg validate` runs the structural rules with no cluster and compile-twice
// byte-equality holds. Findings accumulate; nothing throws past the loader.

import * as fs from "node:fs";
import { teamDir } from "../layout.ts";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { BundleDeclarations } from "../platform/profile-bundles";
import type { ValidationFinding } from "../platform/index";
import { CONTRACTS_ROOT } from "../lib.ts";

const SCHEMA_FILES: Record<string, string> = {
  "hermes.gitops/v1alpha1": path.join(CONTRACTS_ROOT, "environment-connections/v1alpha1/connections.schema.json"),
};

export type ConnectionProvider = "discord" | "github";

/** The secret keys a provider's platform Secret carries - the names eve's
 * channels read from the environment (docs/channels/discord, github), so
 * the projection needs no renaming layer. Every key is present in the
 * platform Secret (an unset one is an empty string, never absent): the
 * projection is a fixed shape, not a discovery. */
export const PROVIDER_KEYS: Record<ConnectionProvider, readonly string[]> = {
  discord: ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_PUBLIC_KEY"],
  github: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_SLUG"],
};

/** The key the gateway verifies inbound requests with, per provider. */
export const PROVIDER_VERIFY_KEY: Record<ConnectionProvider, string> = {
  discord: "DISCORD_PUBLIC_KEY",
  github: "GITHUB_WEBHOOK_SECRET",
};

/** The agent route the gateway forwards to (eve's channel routes). */
export const PROVIDER_AGENT_PATH: Record<ConnectionProvider, string> = {
  discord: "/eve/v1/discord",
  github: "/eve/v1/github",
};

/** Where the platform Secret lives and what it is called. */
export const CONNECTIONS_SECRET_NAMESPACE = "hermes-secrets";
export function platformSecretName(connection: string): string {
  return `connection-${connection}`;
}
/** The projected Secret in a bound instance's namespace. */
export function projectedSecretName(instance: string, connection: string): string {
  return `${instance}-connection-${connection}`;
}

export interface ConnectionMatch {
  guilds?: string[];
  channels?: string[];
  repositories?: string[];
}

export interface ConnectionBindingDeclaration {
  profile: string;
  match?: ConnectionMatch;
}

export interface ConnectionDeclaration {
  name: string;
  provider: ConnectionProvider;
  bindings: ConnectionBindingDeclaration[];
}

export interface ConnectionDeclarations {
  apiVersion: string;
  kind: "Connections";
  connections: ConnectionDeclaration[];
}

export function loadConnectionDeclarations(file: string): ConnectionDeclarations {
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as ConnectionDeclarations;
  const schemaFile = SCHEMA_FILES[raw?.apiVersion as string];
  if (!schemaFile) {
    throw new Error(
      `${file}: unsupported apiVersion ${JSON.stringify(raw?.apiVersion)} ` +
        `(supported: ${Object.keys(SCHEMA_FILES).join(", ")})`,
    );
  }
  const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
  const validate = ajv.compile(schema);
  if (!validate(raw)) {
    const lines = (validate.errors ?? []).map((error) => {
      const extra =
        "additionalProperty" in error.params ? ` (${JSON.stringify(error.params["additionalProperty"])})` : "";
      return `${error.instancePath || "/"} ${error.message ?? "invalid"}${extra}`;
    });
    throw new Error(`${file} failed connections schema validation:\n- ${lines.join("\n- ")}`);
  }
  return raw;
}

/** A profile's deployed coordinates, supplied by the caller. `hg validate`
 * supplies the standalone defaults for every onboarded profile; `hg up`
 * supplies the bundle-aware ones. */
export interface ProfileTarget {
  runtime: "hermes" | "eve";
  /** The instance name (`ag-eve-<p>` / `hermes-<p>`) - the projected
   * Secret's prefix and, standalone, the namespace and Service. */
  instance: string;
  namespace: string;
  service: string;
  port: number;
}

/** One binding, resolved. */
export interface NormalizedConnectionBinding {
  connection: string;
  provider: ConnectionProvider;
  profile: string;
  instance: string;
  namespace: string;
  /** Where the gateway forwards to; null for a Hermes profile (projection
   * only - a Hermes gateway speaks no eve channel route). */
  url: string | null;
  match: ConnectionMatch;
  /** Declaration order within the connection - the gateway tries matches
   * in this order and the first one wins. */
  order: number;
}

export interface ConnectionCompileResult {
  bindings: NormalizedConnectionBinding[];
  findings: ValidationFinding[];
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function compileConnections(
  declarations: ConnectionDeclarations,
  targets: Record<string, ProfileTarget>,
): ConnectionCompileResult {
  const findings: ValidationFinding[] = [];
  const bindings: NormalizedConnectionBinding[] = [];
  const error = (profile: string, code: string, message: string, fix?: string) =>
    findings.push({ profile, severity: "error", check: `connections ${code}`, message, ...(fix ? { fix } : {}) });
  const warn = (profile: string, code: string, message: string) =>
    findings.push({ profile, severity: "warning", check: `connections ${code}`, message });

  const seenNames = new Set<string>();
  // profile -> provider -> connection: one connection per provider per
  // profile, or the two would project the same env names (CONN003).
  const perProfileProvider = new Map<string, Map<ConnectionProvider, string>>();

  for (const c of declarations.connections ?? []) {
    if (!DNS_LABEL.test(c.name) || c.name.length > 40) {
      error("*", "CONN001", `connection ${JSON.stringify(c.name)} is not a DNS-1123 label (max 40 chars)`);
      continue;
    }
    if (seenNames.has(c.name)) {
      error("*", "CONN001", `connection ${JSON.stringify(c.name)} is declared twice`);
      continue;
    }
    seenNames.add(c.name);
    const provider = c.provider;
    const seenProfiles = new Set<string>();
    let sawCatchAll = false;
    (c.bindings ?? []).forEach((b, order) => {
      const profile = b.profile;
      if (seenProfiles.has(profile)) {
        error(profile, "CONN002", `connection ${c.name}: profile ${profile} is bound twice`);
        return;
      }
      seenProfiles.add(profile);
      const target = targets[profile];
      if (!target) {
        error(profile, "CONN002", `connection ${c.name} binds ${profile}, which is not an onboarded profile`,
          `name an installed profile, or onboard ${profile}`);
        return;
      }
      const byProvider = perProfileProvider.get(profile) ?? new Map<ConnectionProvider, string>();
      const prior = byProvider.get(provider);
      if (prior) {
        error(profile, "CONN003",
          `profile ${profile} is bound to two ${provider} connections (${prior}, ${c.name}); both would project ` +
            `${PROVIDER_KEYS[provider].join(", ")} into one environment`,
          "bind one connection per provider per profile");
        return;
      }
      byProvider.set(provider, c.name);
      perProfileProvider.set(profile, byProvider);
      const match = b.match ?? {};
      // The match vocabulary is the provider's: a guild rule on a GitHub
      // connection never matches anything, which is a lie in the plan.
      const foreign = Object.keys(match).filter((k) =>
        provider === "discord" ? k === "repositories" : k === "guilds" || k === "channels",
      );
      if (foreign.length > 0) {
        error(profile, "CONN004", `connection ${c.name} (${provider}): match.${foreign[0]} does not apply to ${provider}`);
        return;
      }
      const isCatchAll = Object.keys(match).length === 0;
      if (isCatchAll) {
        if (sawCatchAll) {
          warn(profile, "CONN005", `connection ${c.name}: ${profile} is a second catch-all binding - the first catch-all wins, this one never matches`);
        }
        sawCatchAll = true;
      } else if (sawCatchAll) {
        warn(profile, "CONN005", `connection ${c.name}: ${profile}'s match follows a catch-all binding and never matches`);
      }
      let url: string | null = null;
      if (target.runtime === "eve") {
        url = `http://${target.service}.${target.namespace}.svc.cluster.local:${target.port}${PROVIDER_AGENT_PATH[provider]}`;
      } else {
        warn(profile, "CONN006",
          `connection ${c.name}: ${profile} runs on Hermes - it receives the credentials (projection) but no inbound route; ` +
            "the gateway forwards only to eve channel routes");
      }
      bindings.push({ connection: c.name, provider, profile, instance: target.instance, namespace: target.namespace, url, match, order });
    });
  }
  return { bindings, findings };
}

const CONNECTIONS_ROOT = "deployments/connections";

/** Compile the declaration at `<root>/environment/connections.yaml` from
 * the contracts alone (no hg state, no cluster): standalone coordinates per
 * profile, bundle coordinates for members the environment bundles. The
 * `topology emit` path. Returns undefined when no declaration exists. */
export function compileConnectionsFromRoot(
  root: string,
  contracts: { profile: string; runtime: "hermes" | "eve" }[],
  bundledProfiles: Record<string, { bundle: string; namespace: string; service: string; memberIndex: number; apiServerPort?: number; namespaceDeclared: boolean }> | undefined,
): { result: ConnectionCompileResult; files: Map<string, string>; gateway: unknown[] } | undefined {
  const file = path.join(teamDir(root), "connections.yaml");
  if (!fs.existsSync(file)) return undefined;
  const declarations = loadConnectionDeclarations(file);
  const targets: Record<string, ProfileTarget> = {};
  for (const c of contracts) {
    const prefix = c.runtime === "eve" ? "ag-eve-" : "hermes-";
    const instance = `${prefix}${c.profile}`;
    const b = bundledProfiles?.[c.profile];
    if (b) {
      const ns = b.namespaceDeclared || c.runtime === "hermes" ? b.namespace : `ag-eve-${b.bundle}`;
      const svc = b.namespaceDeclared || c.runtime === "hermes" ? b.service : `ag-eve-${b.bundle}`;
      targets[c.profile] = { runtime: c.runtime, instance: `${svc}-${c.profile}`, namespace: ns, service: svc, port: b.apiServerPort ?? (c.runtime === "eve" ? 3000 + b.memberIndex : 8644) };
    } else {
      targets[c.profile] = { runtime: c.runtime, instance, namespace: instance, service: instance, port: c.runtime === "eve" ? 3000 : 8644 };
    }
  }
  const result = compileConnections(declarations, targets);
  const files = connectionFiles(result.bindings, new Set(Object.keys(bundledProfiles ?? {})));
  const gateway = (parseYaml(files.get(`${CONNECTIONS_ROOT}/gateway.yaml`) ?? "spec: {connections: []}") as { spec?: { connections?: unknown[] } })?.spec?.connections ?? [];
  return { result, files, gateway };
}

// ---------------------------------------------------------------------------
// Generated records


function dump(value: unknown): string {
  return stringifyYaml(value, { sortMapEntries: true, lineWidth: 0 });
}

/** The per-profile chart values (spec.connections) and the gateway record.
 * Bundled profiles are excluded from the per-profile files: their
 * projections travel through the bundle values (mergeConnectionsIntoBundles). */
export function connectionFiles(
  bindings: NormalizedConnectionBinding[],
  bundledProfiles: Set<string> = new Set(),
): Map<string, string> {
  const files = new Map<string, string>();
  const byProfile = new Map<string, NormalizedConnectionBinding[]>();
  for (const b of bindings) {
    if (bundledProfiles.has(b.profile)) continue;
    const list = byProfile.get(b.profile) ?? [];
    list.push(b);
    byProfile.set(b.profile, list);
  }
  for (const [profile, list] of [...byProfile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    files.set(
      `${CONNECTIONS_ROOT}/profiles/${profile}.yaml`,
      dump({
        spec: {
          connections: list
            .map((b) => ({ name: b.connection, provider: b.provider, secretName: platformSecretName(b.connection), keys: [...PROVIDER_KEYS[b.provider]] }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
      }),
    );
  }
  // The gateway record: every connection, its verification key, and the
  // ordered routes - only eve targets, which have a channel route to
  // forward to.
  const byConnection = new Map<string, NormalizedConnectionBinding[]>();
  for (const b of bindings) {
    const list = byConnection.get(b.connection) ?? [];
    list.push(b);
    byConnection.set(b.connection, list);
  }
  const connections = [...byConnection.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({
      name,
      provider: list[0]!.provider,
      secretName: platformSecretName(name),
      verifyKey: PROVIDER_VERIFY_KEY[list[0]!.provider],
      routes: list
        .filter((b) => b.url !== null)
        .sort((a, b) => a.order - b.order)
        .map((b) => ({ profile: b.profile, url: b.url!, match: b.match })),
    }));
  files.set(`${CONNECTIONS_ROOT}/gateway.yaml`, dump({ spec: { connections } }));
  return files;
}

/** Fold bindings to bundled members into the bundle declarations the
 * bundle compiler consumes: each member gains `connections[]`, the same
 * shape the per-profile values carry. */
export function mergeConnectionsIntoBundles(
  declarations: BundleDeclarations,
  bindings: NormalizedConnectionBinding[],
): BundleDeclarations {
  const merged: BundleDeclarations = JSON.parse(JSON.stringify(declarations));
  for (const bundle of merged.bundles ?? []) {
    for (const member of bundle.profiles) {
      const mine = bindings.filter((b) => b.profile === member.name);
      if (mine.length === 0) continue;
      (member as { connections?: unknown[] }).connections = mine
        .map((b) => ({ name: b.connection, provider: b.provider, secretName: platformSecretName(b.connection), keys: [...PROVIDER_KEYS[b.provider]] }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  return merged;
}

/** Desired-set writer for deployments/connections: write what the compile
 * produced, delete what it did not (fail closed - a stale projection is a
 * stale credential grant). */
export function writeConnectionTree(
  gitopsDir: string,
  files: Map<string, string>,
  checkOnly = false,
): { written: string[]; deleted: string[]; changed: boolean } {
  const root = path.join(gitopsDir, CONNECTIONS_ROOT);
  const existing: string[] = [];
  if (fs.existsSync(root)) {
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else existing.push(path.relative(gitopsDir, full));
      }
    };
    walk(root);
  }
  const deleted = existing.filter((rel) => !files.has(rel));
  const written: string[] = [];
  for (const [rel, content] of files) {
    const full = path.join(gitopsDir, rel);
    const current = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
    if (current === content) continue;
    written.push(rel);
    if (!checkOnly) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  if (!checkOnly) {
    for (const rel of deleted) fs.rmSync(path.join(gitopsDir, rel), { force: true });
    for (const dir of [path.join(root, "profiles"), root]) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
  }
  return { written, deleted, changed: written.length > 0 || deleted.length > 0 };
}
