// hg connection - the operator's view and controls over platform
// connections (ADR-152, environment/connections.yaml): what is declared,
// who is bound, which keys are set (names only - values never print), and
// whether the deployed projections and the gateway agree with the
// declaration. Data assembly here, rendering in main.ts (the backup.ts /
// workspace.ts split).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONNECTIONS_SECRET_NAMESPACE,
  PROVIDER_KEYS,
  PROVIDER_VERIFY_KEY,
  platformSecretName,
  projectedSecretName,
  type ConnectionProvider,
  type NormalizedConnectionBinding,
} from "./compile.ts";
import { CliError, type HgState, kubectl, loadState, log, ok } from "../lib.ts";
import {
  boundEnvOverlay,
  compiledConnections,
  connectionDeclarationFile,
  ensureConnectionSecrets,
  loadConnectionValues,
  saveConnectionValues,
} from "../platform/index.ts";
import type { ProofFinding, ProofResult } from "../backup/platform.ts";

export interface ConnectionRow {
  name: string;
  provider: ConnectionProvider;
  /** Per key: whether it has a value, and where that value comes from.
   * `store` is an explicit `hg connection set`; `env` is the operator's
   * .env overlay, which seeds a key the store has not set. Asking only
   * the store reported a key supplied through .env as unset - which is
   * what CONN003 did the moment .env became an authoring surface. */
  keys: { name: string; set: boolean; source?: "store" | "env" }[];
  bindings: { profile: string; namespace: string; routed: boolean; match: Record<string, string[]> }[];
}

export function connectionRows(state: HgState): { declaration: string | null; rows: ConnectionRow[]; findings: ReturnType<typeof compiledConnections>["findings"] } {
  const declaration = connectionDeclarationFile(state);
  const { bindings, findings } = compiledConnections(state);
  const byName = new Map<string, NormalizedConnectionBinding[]>();
  for (const b of bindings) byName.set(b.connection, [...(byName.get(b.connection) ?? []), b]);
  const rows: ConnectionRow[] = [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => {
    const provider = list[0]!.provider;
    const values = loadConnectionValues(name);
    const overlay = boundEnvOverlay(state, name, bindings).values;
    return {
      name,
      provider,
      keys: PROVIDER_KEYS[provider].map((k) => {
        const inStore = (values[k] ?? "") !== "";
        const inEnv = (overlay[k] ?? "") !== "";
        return { name: k, set: inStore || inEnv, ...(inStore ? { source: "store" as const } : inEnv ? { source: "env" as const } : {}) };
      }),
      bindings: list.sort((a, b) => a.order - b.order).map((b) => ({
        profile: b.profile,
        namespace: b.namespace,
        routed: b.url !== null,
        match: Object.fromEntries(Object.entries(b.match).filter(([, v]) => Array.isArray(v))) as Record<string, string[]>,
      })),
    };
  });
  return { declaration, rows, findings };
}

/** `hg connection set <name> KEY=value ...` - writes the local values file
 * and re-applies the platform Secret. Refuses an unknown key (the
 * provider's set is fixed) and never echoes a value. */
/** Read a connection value from a file (`KEY=@path`). Trailing whitespace
 * is trimmed and one newline is restored for a PEM, because that is what
 * every PEM parser expects and what `cat` of a downloaded key gives you;
 * anything else is passed through byte for byte. */
function readValueFile(file: string, key: string): string {
  const resolved = path.resolve(file.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(resolved)) {
    throw new CliError(`${key}=@${file}: no such file (${resolved})`);
  }
  const text = fs.readFileSync(resolved, "utf8");
  if (!text.trim()) throw new CliError(`${key}=@${file}: the file is empty`);
  return /-----END [A-Z ]+-----/.test(text) ? text.trimEnd() + "\n" : text;
}

export function setConnectionValues(state: HgState, name: string, pairs: string[]): string[] {
  const { bindings } = compiledConnections(state);
  const b = bindings.find((x) => x.connection === name);
  if (!b) throw new CliError(`connection ${JSON.stringify(name)} is not declared in environment/connections.yaml`);
  const allowed = new Set(PROVIDER_KEYS[b.provider]);
  const values = loadConnectionValues(name);
  const changed: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`expected KEY=value, got ${JSON.stringify(pair.split("=")[0] ?? pair)}`);
    const key = pair.slice(0, eq);
    if (!allowed.has(key)) {
      throw new CliError(`${key} is not a ${b.provider} connection key (${[...allowed].join(", ")})`);
    }
    const raw = pair.slice(eq + 1);
    // KEY=@path reads the value from a FILE. Two reasons, and the second
    // is the important one: a GitHub App private key is a multi-line PEM
    // that no shell hands over cleanly, and anything on a command line is
    // readable by every process on the host through /proc and lands
    // verbatim in the shell history. A credential should never need to
    // pass through argv to get here.
    values[key] = raw.startsWith("@") ? readValueFile(raw.slice(1), key) : raw;
    changed.push(key);
  }
  saveConnectionValues(name, values);
  ensureConnectionSecrets(state);
  return changed;
}

/** CONN001..CONN004 - the ProofResult for the connections subject. */
export async function proveConnections(state: HgState): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });
  const { declaration, rows, findings: compileFindings } = connectionRows(state);
  if (!declaration) {
    add("CONN001", "unknown", "connections", "no environment/connections.yaml declared");
  } else {
    const errors = compileFindings.filter((f) => f.severity === "error");
    add("CONN001", errors.length === 0 ? "pass" : "fail", "connections",
      errors.length === 0 ? `${rows.length} connection(s), ${rows.reduce((n, r) => n + r.bindings.length, 0)} binding(s) compile clean` : errors.map((f) => f.message).join("; "));
  }
  const secretKeys = (ns: string, name: string): string[] => {
    const out = kubectl(["-n", ns, "get", "secret", name, "-o", "jsonpath={.data}"], { allowFail: true, quiet: true }).trim();
    if (!out) return [];
    try { return Object.keys(JSON.parse(out) as Record<string, string>); } catch { return []; }
  };
  for (const r of rows) {
    // CONN002 the platform Secret and every projection carry the provider's full key set
    const platform = secretKeys(CONNECTIONS_SECRET_NAMESPACE, platformSecretName(r.name));
    const expected = [...PROVIDER_KEYS[r.provider]];
    const platformOk = expected.every((k) => platform.includes(k));
    const missingProjections: string[] = [];
    for (const b of r.bindings) {
      // The projected Secret: <instance>-connection-<name>; a bundled
      // member's instance is <bundle service>-<profile>.
      const candidates = [projectedSecretName(b.namespace, r.name), projectedSecretName(`${b.namespace}-${b.profile}`, r.name)];
      const found = candidates.some((c) => expected.every((k) => secretKeys(b.namespace, c).includes(k)));
      if (!found) missingProjections.push(`${b.namespace}/${candidates[0]}`);
    }
    add("CONN002", platformOk && missingProjections.length === 0 ? "pass" : "fail", r.name,
      `${CONNECTIONS_SECRET_NAMESPACE}/${platformSecretName(r.name)}: ${platformOk ? "every key present" : `missing ${expected.filter((k) => !platform.includes(k)).join(", ")}`}; ` +
        (missingProjections.length === 0 ? `${r.bindings.length} projection(s) present` : `projection(s) missing: ${missingProjections.join(", ")}`));
    // CONN003 the gateway refuses unsigned and forged requests, and answers
    // a liveness check it can verify
    const verifyKeySet = r.keys.find((k) => k.name === PROVIDER_VERIFY_KEY[r.provider])?.set ?? false;
    const port = state.ports?.router;
    if (!port) {
      add("CONN003", "unknown", r.name, "no event-router port-forward in state (hg up)");
    } else {
      const base = `http://127.0.0.1:${port}/v1/connect/${r.provider}/${r.name}`;
      const post = async (headers: Record<string, string>, body: string) => {
        try {
          const resp = await fetch(base, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(5000) });
          return resp.status;
        } catch {
          return 0;
        }
      };
      const body = JSON.stringify({ zen: "hg" });
      const unsigned = await post(r.provider === "github" ? { "x-github-event": "ping" } : {}, body);
      const forged = await post({ "x-github-event": "ping", "x-hub-signature-256": "sha256=" + "00".repeat(32) }, body);
      const refused = (s: number) => s === 401 || s === 403;
      if (!verifyKeySet) {
        add("CONN003", "unknown", r.name, `gateway: unsigned -> ${unsigned}, forged -> ${forged}; ${PROVIDER_VERIFY_KEY[r.provider]} is not set - put it in the env overlay (\`hg env\`, seeded into the connection by \`hg up\`) or set it explicitly: hg connection set ${r.name} ${PROVIDER_VERIFY_KEY[r.provider]}=@<file>`);
      } else if (r.provider === "github") {
        // We hold the secret: a correctly signed ping must be answered.
        const secret = loadConnectionValues(r.name)["GITHUB_WEBHOOK_SECRET"] ?? "";
        const sign = (b: string) => "sha256=" + crypto.createHmac("sha256", secret).update(b).digest("hex");
        // A UNIQUE delivery id per run. The gateway remembers deliveries to
        // refuse replays (ADR-152), and its fallback replay key is the
        // signature - so a fixed ping body signed with a fixed secret
        // passed once and then reported 409 for the life of the router
        // process. A proof that only passes the first time is not a proof.
        const signed = await post(
          { "x-github-event": "ping", "x-github-delivery": `hg-ping-${Date.now()}`, "x-hub-signature-256": sign(body) },
          body,
        );
        add("CONN003", refused(unsigned) && refused(forged) && signed === 200 ? "pass" : "fail", r.name,
          `gateway: unsigned -> ${unsigned}, forged -> ${forged}, signed ping -> ${signed}`);
        // CONN004 the forward: a signed event for a bound repository reaches
        // the agent, whose own channel re-verifies with its PROJECTED copy of
        // the secret and accepts (no invocation token, so no turn starts).
        const routed = r.bindings.find((b) => b.routed && b.match["repositories"]?.length);
        if (!routed) {
          add("CONN004", "unknown", r.name, "no routed binding with a repository match to forward through");
        } else {
          const repo = routed.match["repositories"]![0]!;
          const event = JSON.stringify({ action: "created", repository: { full_name: repo }, issue: { number: 1 }, comment: { id: 1, body: "hg connection prove", user: { login: "hg" } }, sender: { login: "hg" } });
          const fwd = await post({ "x-github-event": "issue_comment", "x-github-delivery": `hg-${Date.now()}`, "x-hub-signature-256": sign(event) }, event);
          add("CONN004", fwd === 200 ? "pass" : fwd === 401 ? "fail" : "unknown", routed.profile,
            `signed issue_comment for ${repo} through the gateway -> ${fwd}` +
              (fwd === 200 ? " (the agent's channel re-verified with its projected secret and accepted)" : fwd === 401 ? " - the agent refused: its projection is stale (pod started before the Secret synced) or differs" : ""));
        }
      }
    }
  }
  const summary = { pass: findings.filter((f) => f.status === "pass").length, fail: findings.filter((f) => f.status === "fail").length, unknown: findings.filter((f) => f.status === "unknown").length };
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "connection-prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    summary,
    findings,
  };
}

export function renderConnectionRows(rows: ConnectionRow[]): void {
  if (rows.length === 0) {
    log("no connections declared");
    return;
  }
  for (const r of rows) {
    // Where each value comes from, because that is the operator's whole
    // question once .env can seed a connection: (env) is the overlay,
    // seeded by `hg up`; a key with no marker was set explicitly and a
    // file can no longer change it.
    const keys = r.keys.map((k) => `${k.name}${k.set ? (k.source === "env" ? " (env)" : "") : " (unset)"}`).join(", ");
    ok(`${r.name}  ${r.provider}  keys: ${keys}`);
    for (const b of r.bindings) {
      const match = Object.entries(b.match).map(([k, v]) => `${k}=${v.join("|")}`).join(" ") || "catch-all";
      log(`    -> ${b.profile}  [${b.namespace}]  ${b.routed ? "routed" : "projection only"}  ${match}`);
    }
  }
}

export { loadState };
