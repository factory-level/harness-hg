// The GCS backup sink (#283, ADR-49) - one code path, two endpoints.
//
// The real bucket and its three-way identity split need a GCP account
// and are #297. Everything ELSE about the sink is buildable and provable
// here: the object layout, the generation a completed upload gets, the
// manifest that records it, and the restore that selects one.
//
// So the client is written once and pointed at whichever endpoint is
// configured. `fake-gcs-server` speaks the real JSON API, which means
// the local loop exercises the actual request path rather than a stub -
// the difference between proving the code works and proving a mock does.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliError, HG_HOME, log, ok, sh, type HgState } from "../lib.ts";

export const GCS_EMULATOR_CONTAINER = "hg-gcs-emulator";

export interface GcsSink {
  bucket: string;
  prefix: string;
  /** Absent = the real Google endpoint. Present = an emulator, and every
   * surface that reports a destination says so rather than letting an
   * emulated backup read as a cloud one. */
  endpoint?: string;
  /** Service account to impersonate for every gcloud call against this
   * sink (#297's identity split): backups impersonate the WRITER, restores
   * and verifies the READER - which is how "the backup is readable by an
   * identity other than the origin server's" stops being an assumption.
   * Ignored for emulated sinks (the emulator has no IAM to split). */
  impersonate?: string;
}

export function sinkFromUrl(url: string, endpoint?: string): GcsSink {
  const m = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])(\/(.*))?$/.exec(url);
  if (!m) {
    throw new CliError(
      `not a bucket URL: ${JSON.stringify(url)} (expected gs://<bucket>[/<prefix>])`,
    );
  }
  return { bucket: m[1]!, prefix: (m[3] ?? "").replace(/\/+$/, ""), ...(endpoint ? { endpoint } : {}) };
}

/** Where one backup's objects live. A single flat prefix per backup id,
 * because a restore selects a GENERATION of a whole backup - scattering
 * a backup across a tree would make "which objects belong to this one"
 * a question you answer by listing and hoping. */
export function objectKey(sink: GcsSink, backupId: string, relPath: string): string {
  const parts = [sink.prefix, "backups", backupId, relPath].filter(Boolean);
  return parts.join("/").replace(/\/{2,}/g, "/");
}

/** True when this sink is emulated. Load-bearing for honesty: a surface
 * reporting `gcs` for an emulator would claim off-site durability that
 * does not exist. */
export function isEmulated(sink: GcsSink): boolean {
  return Boolean(sink.endpoint);
}

export function destinationClassOf(sink: GcsSink): "gcs" | "gcs-emulated" {
  return isEmulated(sink) ? "gcs-emulated" : "gcs";
}

function gcloudEnv(sink: GcsSink): Record<string, string> {
  if (!sink.endpoint) {
    return sink.impersonate
      ? { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: sink.impersonate }
      : {};
  }
  return {
    // The documented override. One variable, so the client code below is
    // identical against Google and against the emulator.
    CLOUDSDK_API_ENDPOINT_OVERRIDES_STORAGE: `${sink.endpoint}/storage/v1/`,
    CLOUDSDK_AUTH_DISABLE_CREDENTIALS: "true",
    CLOUDSDK_CORE_PROJECT: "hermes-gitops-local",
  };
}

/** What a REAL sink bucket must look like before this CLI will touch it
 * (ADR-49: a bucket without these is storage, not a sink). Pure - the
 * describe JSON goes in, the violations come out - so the policy is
 * testable without a bucket.
 *
 * `gcloud storage buckets describe --format=json` emits its OWN
 * flattened snake_case schema (versioning_enabled, default_kms_key...),
 * not the JSON API's - learned by pointing this at the first live
 * bucket and watching every control read as missing. Both shapes are
 * accepted so a JSON-API caller (tests, other tools) stays valid. */
export function evaluateBucketPosture(desc: {
  // gcloud CLI shape
  uniform_bucket_level_access?: boolean;
  public_access_prevention?: string;
  versioning_enabled?: boolean;
  default_kms_key?: string;
  // JSON API shape
  iamConfiguration?: { uniformBucketLevelAccess?: { enabled?: boolean }; publicAccessPrevention?: string };
  versioning?: { enabled?: boolean };
  encryption?: { defaultKmsKeyName?: string };
}): string[] {
  const violations: string[] = [];
  const ubla = desc.uniform_bucket_level_access ?? desc.iamConfiguration?.uniformBucketLevelAccess?.enabled;
  const pap = desc.public_access_prevention ?? desc.iamConfiguration?.publicAccessPrevention;
  const versioning = desc.versioning_enabled ?? desc.versioning?.enabled;
  const kms = desc.default_kms_key ?? desc.encryption?.defaultKmsKeyName;
  if (!ubla) violations.push("uniform bucket-level access is off");
  if (pap !== "enforced") violations.push("public-access prevention is not enforced");
  if (!versioning) violations.push("object versioning is off");
  if (!kms) violations.push("no default CMEK key");
  return violations;
}

/** The bucket's default CMEK key, for the manifest's encryption block.
 * null for emulated sinks and for a real bucket that (wrongly) has none. */
export function bucketKmsKey(sink: GcsSink): string | null {
  if (isEmulated(sink)) return null;
  const desc = describeBucket(sink);
  return desc?.default_kms_key ?? desc?.encryption?.defaultKmsKeyName ?? null;
}

function describeBucket(sink: GcsSink): {
  default_kms_key?: string;
  iamConfiguration?: { uniformBucketLevelAccess?: { enabled?: boolean }; publicAccessPrevention?: string };
  versioning?: { enabled?: boolean };
  encryption?: { defaultKmsKeyName?: string };
} | null {
  const env = { ...process.env, ...gcloudEnv(sink) } as Record<string, string>;
  const proc = Bun.spawnSync(
    ["gcloud", "storage", "buckets", "describe", `gs://${sink.bucket}`, "--format=json"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if ((proc.exitCode ?? 1) !== 0) return null;
  try {
    return JSON.parse(proc.stdout.toString());
  } catch {
    return null;
  }
}

/** Upload one file and return the object's GENERATION - the number a
 * restore selects by. Google assigns it; the emulator assigns one too,
 * which is why the manifest can record the same field either way. */
export function putObject(sink: GcsSink, localFile: string, key: string): string {
  const env = { ...process.env, ...gcloudEnv(sink) } as Record<string, string>;
  const proc = Bun.spawnSync(
    ["gcloud", "storage", "cp", localFile, `gs://${sink.bucket}/${key}`, "--format=json"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if ((proc.exitCode ?? 1) !== 0) {
    // Sanitized: gcloud's stderr can carry a signed URL or a token.
    throw new CliError(`upload failed for ${path.basename(localFile)} - see the host logs`);
  }
  return statObject(sink, key) ?? "unknown";
}

export function statObject(sink: GcsSink, key: string): string | null {
  const env = { ...process.env, ...gcloudEnv(sink) } as Record<string, string>;
  const proc = Bun.spawnSync(
    ["gcloud", "storage", "objects", "describe", `gs://${sink.bucket}/${key}`, "--format=value(generation)"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if ((proc.exitCode ?? 1) !== 0) return null;
  return proc.stdout.toString().trim() || null;
}

export function ensureBucket(sink: GcsSink): void {
  const env = { ...process.env, ...gcloudEnv(sink) } as Record<string, string>;
  const exists = Bun.spawnSync(
    ["gcloud", "storage", "buckets", "describe", `gs://${sink.bucket}`, "--format=value(name)"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if ((exists.exitCode ?? 1) === 0) {
    if (isEmulated(sink)) return;
    // An existing real bucket must carry ADR-49's controls - a sink that
    // silently accepts a bare bucket would report off-site durability
    // with none of the properties the word promises.
    const desc = describeBucket(sink);
    const violations = desc ? evaluateBucketPosture(desc) : ["bucket describe returned no JSON"];
    if (violations.length > 0) {
      throw new CliError(
        `bucket gs://${sink.bucket} exists but is not a sink: ${violations.join("; ")}. ` +
          "Provision it through state/ (backupEnvironments) - ADR-49/#297.",
      );
    }
    return;
  }
  if (!isEmulated(sink)) {
    // A real bucket is INFRASTRUCTURE (ADR-49: uniform access, public
    // access prevention, versioning, retention, audit logging). Creating
    // one here would make a bucket with none of that and call it a sink.
    throw new CliError(
      `bucket gs://${sink.bucket} does not exist. It is provisioned by infrastructure code with ` +
        "uniform access, public-access prevention, versioning and retention (ADR-49, #297) - " +
        "not created by a backup run.",
    );
  }
  const made = Bun.spawnSync(["gcloud", "storage", "buckets", "create", `gs://${sink.bucket}`], {
    env, stdout: "pipe", stderr: "pipe",
  });
  if ((made.exitCode ?? 1) !== 0) throw new CliError(`could not create the emulated bucket ${sink.bucket}`);
}


/** Pull one object back. The half that makes the sink a RECOVERY path
 * rather than an upload destination - and the half a local-directory
 * sink never needed, which is why it did not exist until the rehearsal
 * had to run with the scaffold deleted. */
export function getObject(sink: GcsSink, key: string, localFile: string): void {
  const env = { ...process.env, ...gcloudEnv(sink) } as Record<string, string>;
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  const proc = Bun.spawnSync(
    ["gcloud", "storage", "cp", `gs://${sink.bucket}/${key}`, localFile],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if ((proc.exitCode ?? 1) !== 0) {
    throw new CliError(`could not download ${key} from ${sink.bucket} - see the host logs`);
  }
}

/** Backup ids present in the sink, oldest first. This is what "select an
 * explicit backup generation" (design 13) actually needs: without it a
 * clean server has a bucket and no way to name what is in it. */
export function listBackupIds(sink: GcsSink): string[] {
  const env = { ...process.env, ...gcloudEnv(sink) } as Record<string, string>;
  const prefix = [sink.prefix, "backups"].filter(Boolean).join("/");
  const proc = Bun.spawnSync(
    ["gcloud", "storage", "ls", `gs://${sink.bucket}/${prefix}/`],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if ((proc.exitCode ?? 1) !== 0) return [];
  return proc.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim().replace(/\/$/, "").split("/").pop() ?? "")
    .filter((n) => n.startsWith("hg-"))
    .sort();
}

// ---------------------------------------------------------------------------
// Verification objects. The writer identity can only ADD objects (#297:
// objectCreator, no delete, therefore no overwrite) - which is the right
// property for archives and a problem for exactly one fact: a manifest is
// uploaded saying `available`, and the restore that later proves it
// `restorable` cannot rewrite it. So verifications are their own
// append-only objects under `verification/<restoredAt>.json`, and a fetch
// merges the LATEST one over the manifest it downloaded.

export function putVerification(
  sink: GcsSink,
  backupId: string,
  verification: { state: string; restoredAt?: string; durationSeconds?: number },
): void {
  const stamp = (verification.restoredAt ?? new Date().toISOString()).replace(/[:]/g, "-");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hg-verify-")), "v.json");
  fs.writeFileSync(tmp, `${JSON.stringify(verification, null, 2)}\n`);
  putObject(sink, tmp, objectKey(sink, backupId, `verification/${stamp}.json`));
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}

export function latestVerification(
  sink: GcsSink,
  backupId: string,
): { state: string; restoredAt?: string; durationSeconds?: number } | null {
  const env = { ...process.env, ...gcloudEnv(sink) } as Record<string, string>;
  const prefix = objectKey(sink, backupId, "verification/");
  const proc = Bun.spawnSync(["gcloud", "storage", "ls", `gs://${sink.bucket}/${prefix}`], {
    env, stdout: "pipe", stderr: "pipe",
  });
  if ((proc.exitCode ?? 1) !== 0) return null;
  // Timestamps in the names make lexicographic order chronological.
  const names = proc.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean).sort();
  const latest = names[names.length - 1];
  if (!latest) return null;
  const key = latest.replace(`gs://${sink.bucket}/`, "");
  const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hg-verify-")), "v.json");
  try {
    getObject(sink, key, local);
    return JSON.parse(fs.readFileSync(local, "utf8"));
  } catch {
    return null;
  } finally {
    fs.rmSync(path.dirname(local), { recursive: true, force: true });
  }
}

/** Rehydrate a whole backup from the sink into a local scaffold - the
 * shape every existing restore verb already understands.
 *
 * Deliberately manifest-FIRST: it names the components, so a sink
 * missing it is a partial upload and there is nothing to be selective
 * about. Discovering that after downloading gigabytes would be a slower
 * way to learn the same thing. */
export function fetchBackup(sink: GcsSink, backupId: string, destRoot: string): string {
  const dir = path.join(destRoot, backupId);
  fs.mkdirSync(dir, { recursive: true });
  const manifestKey = objectKey(sink, backupId, "manifest.json");
  getObject(sink, manifestKey, path.join(dir, "manifest.json"));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    components?: { archive?: string }[];
    verification?: { state: string; restoredAt?: string; durationSeconds?: number };
  };
  // The manifest froze at upload time (`available`); a later verification
  // lives beside it. Merge so the fetched scaffold tells the truth.
  const verification = latestVerification(sink, backupId);
  if (verification) {
    manifest.verification = verification;
    fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const c of manifest.components ?? []) {
    if (!c.archive) continue;
    getObject(sink, objectKey(sink, backupId, c.archive), path.join(dir, c.archive));
  }
  return dir;
}

/** Start the emulator. Bound to the gateway interface for the same
 * reason everything else on this loop is: reachable from the cluster,
 * not from the LAN. */
export function ensureGcsEmulator(state: HgState): GcsSink {
  if (!state.gatewayIp) {
    throw new CliError("the emulated sink needs the local loop (no gateway ip) - run `hg up`, or pass --sink gs://...");
  }
  const port = 4443;
  const host = `${state.gatewayIp}:${port}`;
  const running = sh(["docker", "ps", "--filter", `name=^${GCS_EMULATOR_CONTAINER}$`, "--format", "{{.Names}}"], {
    allowFail: true, quiet: true,
  }).trim();
  const sink: GcsSink = { bucket: "hermes-gitops-local-backup", prefix: "local", endpoint: `http://${host}` };
  if (running === GCS_EMULATOR_CONTAINER) return sink;
  sh(["docker", "rm", "-f", GCS_EMULATOR_CONTAINER], { allowFail: true, quiet: true });
  const dataDir = path.join(HG_HOME, "gcs-emulator");
  fs.mkdirSync(dataDir, { recursive: true });
  log(`starting the GCS emulator on ${host}...`);
  sh([
    "docker", "run", "-d", "--name", GCS_EMULATOR_CONTAINER, "--restart", "unless-stopped",
    "-p", `${state.gatewayIp}:${port}:4443`,
    "-v", `${dataDir}:/data`,
    "fsouza/fake-gcs-server", "-scheme", "http", "-port", "4443",
    "-external-url", `http://${host}`, "-backend", "filesystem", "-filesystem-root", "/data",
  ], { quiet: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = Bun.spawnSync(["curl", "-sf", "-m", "2", "-o", "/dev/null", `http://${host}/storage/v1/b`]);
    if ((probe.exitCode ?? 1) === 0) {
      ok(`gcs emulator up: ${host}`);
      return sink;
    }
    Bun.sleepSync(500);
  }
  throw new CliError(`the GCS emulator never answered on http://${host}/storage/v1/b`);
}
