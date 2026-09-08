// The environment compiler (#674): spec -> the `Pulumi.<env>.yaml`
// config blocks, deterministically. The generated file is a PROJECTION
// (do-not-edit banner, drift gated by `hg env plan`); secret values
// exist only as `secure:` ciphertext, which the generator carries
// through from the existing file byte-for-byte - it never re-encrypts
// a secret it didn't change (the committed-with-secrets contract), and
// a marked leaf with no ciphertext yet becomes a finding naming the
// exact `pulumi config set --secret` command.
//
// Emission is hand-rolled rather than a YAML library so the quoting
// rules are LAW, not luck:
//   - agentSecrets values and chart versions are ALWAYS double-quoted
//     (#358 - a snowflake id or a two-segment version must never parse
//     as a number downstream);
//   - keys containing `:` are quoted (workload:<agent>/<app>);
//   - booleans and integers from the spec emit bare (the stack readers
//     use getBoolean/getNumber);
//   - everything else emits plain unless YAML would misread it.
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { EnvironmentSpec, isSecretRef, rootKmsResourceId, rootSecretsProviderUri } from "./spec.ts";

export interface SecretFinding {
  /** dot-path inside the stack config, `--path` ready. */
  path: string;
  stack: "state" | "infra";
  /** The exact command that supplies the missing ciphertext. */
  fix: string;
}

export interface GeneratedStack {
  text: string;
  missingSecrets: SecretFinding[];
}

const BANNER = `# GENERATED from the environment spec - do not hand-edit.
# Source of truth: the environment.yaml this file was compiled from
# (hg env plan diffs, hg env apply rewrites; make test gates drift).
# Secret values are pulumi-encrypted ciphertext, written only by
# \`pulumi config set --secret\` and carried through regeneration
# untouched - editing any OTHER line here is overwritten on the next
# apply.
`;

// ---------------------------------------------------------------------------
// Canonical key order per stack - determinism is the contract.

const STATE_ORDER = ["deployerGroup", "agents", "backupEnvironments", "bucketLocation", "perAgentKeys"];
const INFRA_ORDER = [
  "clusterProvider", "kubeconfigPath", "kubeconfigContext", "clusterName",
  "gitopsRepoUrl", "gitopsBranch", "gitopsBranchProtection", "gitopsRequiredReviewers",
  "hermesGitopsRepoUrl", "chartRevision",
  "providers", "stages", "versions", "hermes", "agents",
  "agentGitAuth", "argocdRepoCreds", "controlPlaneIngress", "reconcile",
  "gitopsGitToken", "agentSecrets", "cloudflareApiToken",
  "pluginConfig", "routerSecrets", "targetClusters", "helmOciRegistries",
  "fleetDefaults", "nexusCapabilities", "slack",
];

// ---------------------------------------------------------------------------
// The ciphertext donor: every `secure:` blob in the existing generated
// file, keyed by its config path.

type SecureMap = Map<string, string>;

function collectSecure(node: unknown, at: string, into: SecureMap): void {
  if (typeof node !== "object" || node === null) return;
  const rec = node as Record<string, unknown>;
  if (typeof rec["secure"] === "string" && Object.keys(rec).length === 1) {
    // Generated missing-value markers are not encrypted credentials.
    if (rec["secure"] !== "<UNSET - see findings>") into.set(at, rec["secure"] as string);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectSecure(v, `${at}[${i}]`, into));
    return;
  }
  for (const [k, v] of Object.entries(rec)) {
    collectSecure(v, at ? `${at}.${k}` : k, into);
  }
}

/** Read the existing stack file's config block (ciphertext donor +
 * the preserved pulumi-owned header lines). */
export function readExistingStack(file: string): {
  config: Record<string, unknown>;
  secure: SecureMap;
  secretsprovider?: string;
  encryptedkey?: string;
} {
  if (!fs.existsSync(file)) return { config: {}, secure: new Map() };
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
  const config = (doc?.["config"] as Record<string, unknown>) ?? {};
  const secure: SecureMap = new Map();
  for (const [k, v] of Object.entries(config)) {
    const bare = k.includes(":") ? k.slice(k.indexOf(":") + 1) : k;
    collectSecure(v, bare, secure);
  }
  return {
    config,
    secure,
    secretsprovider: doc?.["secretsprovider"] as string | undefined,
    encryptedkey: doc?.["encryptedkey"] as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// The emitter.

const PLAIN_SAFE = /^[A-Za-z0-9/_.@$+][A-Za-z0-9/_.@$+:-]*$/;

function looksLikeOtherScalar(s: string): boolean {
  return (
    s === "" || /^[-+]?[0-9][0-9_]*(\.[0-9]*)?([eE][-+]?[0-9]+)?$/.test(s) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(s)
  );
}

function scalar(v: unknown, forceQuote: boolean): string {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  if (forceQuote || looksLikeOtherScalar(s) || !PLAIN_SAFE.test(s) || s.includes(": ") || s.endsWith(":")) {
    return JSON.stringify(s);
  }
  return s;
}

function keyText(k: string): string {
  return k.includes(":") ? JSON.stringify(k) : k;
}

interface EmitCtx {
  stack: "state" | "infra";
  stackDir: string;
  envName: string;
  secure: SecureMap;
  missing: SecretFinding[];
  /** paths whose leaf VALUES are always quoted (#358). */
  forceQuoteUnder: RegExp[];
}

function resolveSecret(ctx: EmitCtx, at: string): string | undefined {
  const blob = ctx.secure.get(at);
  if (blob !== undefined) return blob;
  ctx.missing.push({
    path: at,
    stack: ctx.stack,
    fix: `(cd ${ctx.stackDir} && pulumi -s ${ctx.envName} config set --secret --path '${at}' <value>)`,
  });
  return undefined;
}

function emit(node: unknown, at: string, indent: string, ctx: EmitCtx, lines: string[], keyLabel?: string, rawKey = false): void {
  const label = keyLabel === undefined ? "" : `${indent}${rawKey ? keyLabel : keyText(keyLabel)}:`;
  if (isSecretRef(node)) {
    const blob = resolveSecret(ctx, at);
    lines.push(label);
    lines.push(`${indent}  secure: ${blob ?? "<UNSET - see findings>"}`);
    return;
  }
  if (node === null || node === undefined) return;
  if (typeof node !== "object") {
    const force = ctx.forceQuoteUnder.some((re) => re.test(at)) && typeof node === "string";
    lines.push(`${label} ${scalar(node, force)}`);
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) {
      // A bare `key:` is YAML null - pulumi refuses '' where it expects
      // a JSON array (found live on the scratch run). Empty emits [].
      lines.push(`${label} []`);
      return;
    }
    lines.push(label);
    node.forEach((item, i) => {
      const itemAt = `${at}[${i}]`;
      if (typeof item === "object" && item !== null && !isSecretRef(item)) {
        // block-style list item: first key on the dash line
        const entries = Object.entries(item as Record<string, unknown>);
        let first = true;
        for (const [k, v] of entries) {
          const sub: string[] = [];
          emit(v, `${itemAt}.${k}`, `${indent}    `, ctx, sub, k);
          if (first) {
            sub[0] = `${indent}  - ${sub[0]!.trimStart()}`;
            first = false;
          }
          lines.push(...sub);
        }
      } else if (isSecretRef(item)) {
        const blob = resolveSecret(ctx, itemAt);
        lines.push(`${indent}  - secure: ${blob ?? "<UNSET - see findings>"}`);
      } else {
        const force = ctx.forceQuoteUnder.some((re) => re.test(itemAt)) && typeof item === "string";
        lines.push(`${indent}  - ${scalar(item, force)}`);
      }
    });
    return;
  }
  if (Object.keys(node as object).length === 0) {
    lines.push(`${label} {}`);
    return;
  }
  lines.push(label);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    emit(v, at ? `${at}.${k}` : k, `${indent}  `, ctx, lines, k);
  }
}

// ---------------------------------------------------------------------------
// Public: generate one stack's file text from the spec.

export function generateStack(
  spec: EnvironmentSpec,
  stack: "state" | "infra",
  opts: {
    /** The Pulumi project name (read from the stack dir's Pulumi.yaml). */
    project: string;
    /** Existing generated file - ciphertext donor + preserved headers. */
    existingFile: string;
    stackDir: string;
  },
): GeneratedStack {
  const existing = readExistingStack(opts.existingFile);
  const ctx: EmitCtx = {
    stack,
    stackDir: opts.stackDir,
    envName: spec.name,
    secure: existing.secure,
    missing: [],
    forceQuoteUnder: [/^agentSecrets\./, /^versions\./],
  };

  const lines: string[] = [BANNER.trimEnd()];
  const provider = existing.secretsprovider ?? rootSecretsProviderUri(spec);
  lines.push(`secretsprovider: ${provider}`);
  if (existing.encryptedkey) lines.push(`encryptedkey: ${existing.encryptedkey}`);
  lines.push("config:");

  const p = opts.project;
  if (stack === "state") {
    lines.push(`  gcp:project: ${scalar(spec.project, false)}`);
    lines.push(`  ${p}:rootKmsKeyId: ${scalar(rootKmsResourceId(spec), false)}`);
    const src = spec.state as unknown as Record<string, unknown>;
    for (const key of STATE_ORDER) {
      if (src[key] === undefined) continue;
      const sub: string[] = [];
      emit(src[key], key, "  ", ctx, sub, `${p}:${key}`, true);
      lines.push(...sub);
    }
  } else {
    const src = spec.infra;
    for (const key of INFRA_ORDER) {
      if (src[key] === undefined) continue;
      const sub: string[] = [];
      emit(src[key], key, "  ", ctx, sub, `${p}:${key}`, true);
      lines.push(...sub);
    }
    // Any spec key the order list forgot fails loudly rather than
    // silently vanishing from the generated config.
    for (const key of Object.keys(src)) {
      if (!INFRA_ORDER.includes(key)) {
        throw new Error(`environment spec infra.${key} has no emission slot - add it to INFRA_ORDER`);
      }
    }
  }
  return { text: `${lines.join("\n")}\n`, missingSecrets: ctx.missing };
}
