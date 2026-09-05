// The evidence package (Fable 1 §32, ADR-67): one durable bundle that
// ties WHAT ran (versions, git SHAs, server identity) to WHAT was proved
// (the ProofResult JSONs the operator collected) and WHAT protects it
// (the scrubbed backup record). Uploaded to the sink with the writer
// identity, because evidence that lives only on the machine it describes
// disappears with it - the same argument as the backups themselves.
//
// Nothing here re-runs a proof: each subject's own command is the
// authority (the launch-gate rule), and a bundle that re-ran them would
// be a second opinion that rots. Evidence COLLECTS.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliError, PLATFORM_ROOT, log, ok } from "../lib.ts";
import versions from "../../../versions.json" with { type: "json" };
import { LAUNCH_SECRET_PATTERNS } from "../launch/prove.ts";
import { destinationClassOf, putObject, sinkFromUrl, type GcsSink } from "./gcs-sink.ts";
import { platformBackupRecord, readManifest } from "./platform.ts";
import { readRegistration } from "../communication/lifecycle-events.ts";
import { readConfig as readReconcileConfig, readLedger as readReconcileLedger } from "../reconcile/index.ts";

const hgHome = () =>
  process.env["HERMES_GITOPS_HOME"] || path.join(os.homedir(), ".hermes-gitops");

function gitSha(dir: string): string | null {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  return (proc.exitCode ?? 1) === 0 ? proc.stdout.toString().trim() : null;
}

// Key names whose STRING values are refused wholesale. Pattern sweeps
// catch known token shapes; this catches the unknown ones by where they
// live. kmsKey/publicKey-style resource names are fine - the deny list
// matches whole key words, not substrings of longer identifiers.
const SECRET_KEY_RE = /(?:^|_|-)(token|secret|password|passwd|credential|credentials|authorization|cookie|apikey|api_key)(?:$|_|-)/i;

function secretKeyHits(value: unknown, trail: string): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => secretKeyHits(v, `${trail}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  const hits: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0 && SECRET_KEY_RE.test(k)) hits.push(`${trail}.${k}`);
    hits.push(...secretKeyHits(v, `${trail}.${k}`));
  }
  return hits;
}

/** Sweep serialized content for the launch-gate secret shapes AND, where
 * the content is JSON, for values living under secret-named keys. A
 * non-empty result REFUSES the bundle, because evidence is built to be
 * shared and re-read. */
export function sweepEvidence(files: { name: string; content: string }[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const pattern of LAUNCH_SECRET_PATTERNS) {
      if (pattern.re.test(f.content)) hits.push(`${f.name}: ${pattern.name}`);
    }
    try {
      hits.push(...secretKeyHits(JSON.parse(f.content), f.name).map((t) => `${t}: a secret-named key`));
    } catch {
      // non-JSON content is covered by the pattern sweep alone
    }
  }
  return hits;
}

/** Only recognized proof shapes ride along - an arbitrary JSON beside
 * the bundle root (a credentials file, someone's scratch) is skipped by
 * NAME, loudly, rather than uploaded because it happened to be there. */
export function isProofShaped(content: string): boolean {
  try {
    const doc = JSON.parse(content) as Record<string, unknown>;
    return doc["kind"] === "ProofResult" || (typeof doc["command"] === "string" && "ok" in doc);
  } catch {
    return false;
  }
}

export interface EvidenceArgs {
  toDir: string;
  backupDir?: string;
  sinkUrl?: string;
}

export function buildEvidence(args: EvidenceArgs): { dir: string; files: string[] } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(args.toDir, `evidence-${stamp}`);
  const files: { name: string; content: string }[] = [];

  // The spine: what ran, where, at which commits.
  let reconcile: Record<string, unknown> | null = null;
  try {
    const ledger = readReconcileLedger(readReconcileConfig());
    reconcile = {
      state: ledger.state,
      appliedSha: ledger.appliedSha ?? null,
      appliedAt: ledger.appliedAt ?? null,
      desiredSha: ledger.desiredSha ?? null,
    };
  } catch {
    reconcile = null; // no reconciler on this host - stated, not invented
  }
  let serverId: unknown = null;
  const idFile = path.join(hgHome(), "server-id");
  if (fs.existsSync(idFile)) {
    try {
      serverId = JSON.parse(fs.readFileSync(idFile, "utf8"));
    } catch {
      serverId = null;
    }
  }
  const registration = readRegistration();
  files.push({
    name: "evidence.json",
    content: JSON.stringify(
      {
        apiVersion: "cli.hermes.dev/v1alpha1",
        kind: "EvidencePackage",
        generatedAt: new Date().toISOString(),
        versions,
        platformGitSha: gitSha(PLATFORM_ROOT),
        server: serverId,
        reconcile,
        // ids only - the registration record never held the token.
        registration: registration
          ? { environment: registration.environment, channelId: registration.channelId, registeredAt: registration.registeredAt }
          : null,
      },
      null,
      2,
    ) + "\n",
  });

  // The protection: the SCRUBBED projection, never the raw manifest -
  // the record already withholds archive paths and the operator's home.
  if (args.backupDir) {
    const manifest = readManifest(args.backupDir);
    const destClass = args.sinkUrl ? "gcs" : "local-directory";
    files.push({
      name: "backup-record.json",
      content: JSON.stringify(platformBackupRecord(manifest, new Date().toISOString(), destClass), null, 2) + "\n",
    });
  }

  // The proofs: whatever ProofResult JSONs the operator saved beside the
  // bundle root (each subject's own --json output, collected not re-run).
  // Shape-gated: a JSON that is not proof-shaped is named and skipped,
  // never bundled because it happened to be there.
  if (fs.existsSync(args.toDir)) {
    for (const entry of fs.readdirSync(args.toDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const content = fs.readFileSync(path.join(args.toDir, entry.name), "utf8");
      if (!isProofShaped(content)) {
        log(`skipping ${entry.name}: not a ProofResult/command envelope`);
        continue;
      }
      files.push({ name: `proofs/${entry.name}`, content });
    }
  }

  // The sweep gates the WRITE: nothing lands on disk unswept.
  const hits = sweepEvidence(files);
  if (hits.length > 0) {
    throw new CliError(`evidence refused - secret-shaped content in: ${hits.join("; ")}`);
  }

  for (const f of files) {
    const target = path.join(dir, f.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
  return { dir, files: files.map((f) => f.name) };
}

export function uploadEvidence(sinkUrl: string, dir: string, files: string[]): void {
  const sink: GcsSink = { ...sinkFromUrl(sinkUrl), impersonate: process.env["HG_BACKUP_WRITER_SA"] };
  const id = path.basename(dir);
  for (const rel of files) {
    const key = [sink.prefix, "evidence", id, rel].filter(Boolean).join("/");
    putObject(sink, path.join(dir, rel), key);
  }
  ok(`evidence ${id} uploaded to ${destinationClassOf(sink)} (${sink.bucket}) - ${files.length} file(s)`);
}

export function cmdEvidence(json: boolean, args: EvidenceArgs): void {
  const { dir, files } = buildEvidence(args);
  ok(`evidence package: ${dir} (${files.length} file(s))`);
  if (args.sinkUrl) uploadEvidence(args.sinkUrl, dir, files);
  else log("local only - pass --sink gs://... to make it survive this machine");
  if (json) console.log(JSON.stringify({ command: "platform-evidence", ok: true, dir, files }, null, 2));
}
