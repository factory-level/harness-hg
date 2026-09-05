// hg platform backup|restore|backup prove - the environment-level
// orchestrator over per-component backup routines (design 13, ADR-47/52).
//
// One backup = one scaffolded directory:
//
//   <root>/<backup-id>/
//     manifest.json            every component, its strategy, its checksum
//     volumes/<profile>/…      fresh routine archives (PR-1 export machinery)
//     host/nexus-state.tar.gz  the operator-host Nexus overlay (ADR-48's
//                              interim home until Nexus moves in-cluster)
//     restore-report.json      written by `restore`; absent = never restored
//
// The manifest is honest about strategy: `volume-archive` and
// `host-archive` components carry bytes; `declarative` components carry
// only the claim that `hg up` + Argo rebuild them, and `backup prove`
// checks that claim against the live cluster instead of pretending an
// archive exists. A backup is `available` on creation and `restorable`
// only after a restore has run against it (ADR-52).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  backupNsOf,
  discoverRoutines,
  parseRoutines,
  ROUTINE_LABEL,
  exportArtifact,
  restoreArtifact,
  restoreViaHook,
  runRoutine,
} from "./routines.ts";
import { appOf, bundleAppOf, CliError, KCTX, kubectl, log, nsOf, ok, sh, toRfc3339, warn, type ProfileCtx } from "../lib.ts";
import { bundleCoordinatesFor, loadEnvironment } from "../topology/environment.ts";
import { bucketKmsKey, destinationClassOf, ensureBucket, objectKey, putObject, type GcsSink } from "./gcs-sink.ts";

export const NEXUS_STATE_DIR = path.join(os.homedir(), ".hermes", "plugins", "hermes-gitops", "state");

export interface ComponentEntry {
  name: string;
  kind: "volume-archive" | "host-archive" | "declarative";
  profile?: string;
  routine?: string;
  /** Scaffold-relative archive path (volume/host kinds only). */
  archive?: string;
  sha256?: string;
  sizeKB?: number;
  consistency?: string;
  detail?: string;
  /** The object generation a cloud sink assigned. Absent for a local
   * directory, which has no generations to select between. */
  generation?: string;
}

export interface PlatformManifest {
  // v1alpha2 added the optional `encryption` block; readers accept both.
  // This is the CLI-owned HOST manifest, not the frozen runtime-overlay
  // record - the projection (platformBackupRecord) carries neither
  // version string nor key reference.
  schemaVersion: "hermes.dev/platform-backup/v1alpha1" | "hermes.dev/platform-backup/v1alpha2";
  backupId: string;
  createdAt: string;
  environment: string;
  components: ComponentEntry[];
  /** How the SINK encrypts these objects (#297: bucket-level CMEK - one
   * key per sink, so one block per manifest, not per component). Absent
   * for local directories and the emulator, which have no KMS - a real
   * sink without it fails `ensureBucket`'s posture check instead. */
  encryption?: {
    mode: "cmek";
    kmsKey: string;
  };
  /** ADR-52: `available` on upload; `restorable` only after a restore ran.
   * `durationSeconds` is the MEASURED restore time - absent means
   * `unmeasured` (ADR-26), and no surface may substitute a zero. */
  verification: {
    state: "available" | "restorable";
    restoredAt?: string;
    durationSeconds?: number;
  };
  /** #582: the PVC ledger's excused rows, resolved at backup time. What
   * the fleet deliberately does NOT back up, each with its recorded
   * rationale - so Nexus can show intentional gaps as intentional
   * instead of hiding them behind a blanket summary. Absent on records
   * written by an older CLI. */
  unprotectedByDesign?: { claim: string; namespace: string; reason: string }[];
}

const MANIFEST_VERSIONS = new Set([
  "hermes.dev/platform-backup/v1alpha1",
  "hermes.dev/platform-backup/v1alpha2",
]);

const sha256File = (p: string): string =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function writeManifest(dir: string, manifest: PlatformManifest): void {
  const tmp = path.join(dir, "manifest.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(tmp, path.join(dir, "manifest.json"));
}

export function readManifest(dir: string): PlatformManifest {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) throw new CliError(`no manifest.json in ${dir} - not a platform backup`);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as PlatformManifest;
  if (!MANIFEST_VERSIONS.has(manifest.schemaVersion)) {
    throw new CliError(
      `manifest ${file} carries schemaVersion ${JSON.stringify(manifest.schemaVersion)} - ` +
        `this CLI reads ${[...MANIFEST_VERSIONS].join(", ")}`,
    );
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Publishing the platform record into the cluster (#282).
//
// Exactly the reconciler's handshake (ADR-54): this command runs on the
// operator host, Nexus runs in a pod, and they share no filesystem - so
// the facts travel as a ConfigMap and Nexus reads them with the same
// Kubernetes transport every other adapter uses. Not through Git,
// because the deployment repository is the reconciler's INPUT.
//
// What crosses the boundary is a strict subset of the manifest. The
// manifest names archive paths and the operator's home directory; the
// record names neither, because a ConfigMap is readable by anything with
// get on the namespace and "where this operator keeps their backups" is
// not a fact a dashboard needs.

export const PLATFORM_BACKUP_CONFIGMAP = "hermes-platform-backup-status";

/** The scrubbed projection of a manifest. Pure - the scrubbing is the
 * interesting part, so it is testable without a cluster. */
export function platformBackupRecord(
  manifest: PlatformManifest,
  observedAt: string,
  destinationClass: "local-directory" | "gcs" | "gcs-emulated" = "local-directory",
): Record<string, unknown> {
  const components = manifest.components.slice(0, 200).map((c) => ({
    name: c.name,
    kind: c.kind,
    ...(c.profile ? { profile: c.profile } : {}),
    ...(c.routine ? { routine: c.routine } : {}),
    ...(typeof c.sizeKB === "number" ? { sizeKB: c.sizeKB } : {}),
    // Abbreviated on purpose: enough to tell two artifacts apart and to
    // show content WAS checksummed. The host manifest keeps the digest.
    ...(c.sha256 ? { checksum: c.sha256.slice(0, 12) } : {}),
    ...(c.consistency ? { consistency: c.consistency.slice(0, 200) } : {}),
    // The value a restore SELECTS by. Its absence is meaningful too - a
    // local-directory sink has no such concept, and inventing one would
    // make "which backup" answerable in a way it is not.
    ...(c.generation ? { generation: c.generation } : {}),
    // `detail` on a host archive IS a host path (NEXUS_STATE_DIR) - the
    // one field in the manifest that would leak by simply being copied.
    ...(c.detail && c.kind !== "host-archive" ? { detail: c.detail.slice(0, 200) } : {}),
  }));
  const archived = components.filter((c) => c.kind !== "declarative").length;
  return {
    apiVersion: "nexus.hermes.ai/v1alpha3",
    kind: "PlatformBackupStatus",
    observedAt: toRfc3339(observedAt),
    backupId: manifest.backupId,
    createdAt: toRfc3339(manifest.createdAt),
    environment: manifest.environment.slice(0, 200),
    destinationClass,
    verification: {
      ...manifest.verification,
      ...(manifest.verification.restoredAt
        ? { restoredAt: toRfc3339(manifest.verification.restoredAt) }
        : {}),
    },
    components,
    // #582: intentional gaps ride the record (claim + rationale only -
    // no paths, nothing host-specific). Bounded like components.
    ...(manifest.unprotectedByDesign?.length
      ? {
          unprotectedByDesign: manifest.unprotectedByDesign.slice(0, 50).map((e) => ({
            claim: e.claim.slice(0, 200),
            namespace: e.namespace.slice(0, 120),
            reason: e.reason.slice(0, 400),
          })),
        }
      : {}),
    summary: `${components.length} component(s), ${archived} archived`,
  };
}

/** Where the control plane reads status records. The reconciler already
 * owns this answer, so `hg platform` honours the same config rather than
 * inventing a second one; without a reconciler there is no convention to
 * honour and the in-cluster default applies. */
export function statusRecordNamespace(): string {
  try {
    // Lazy: importing the reconciler at module scope would drag the whole
    // tick machinery into every `hg backup` invocation. The path is
    // RUNTIME-resolved (a string, not a checked import) - #691 moved this
    // file into backup/ and the string kept pointing at the old sibling,
    // so every publish silently fell through to the in-cluster default
    // for a week (factory, 2026-08-27..09-03). tests/backup-status-publish
    // pins that the configured namespace actually reaches the manifest.
    const { readConfig } = require("../reconcile/index.ts") as typeof import("../reconcile/index.ts");
    return readConfig().statusNamespace ?? "hermes-gitops";
  } catch {
    return "hermes-gitops";
  }
}

export interface PublishResult {
  ok: boolean;
  /** kubectl's own words (stderr, else stdout; last 500 chars) when
   * `ok` is false - a publish that fails without saying why is the
   * failure mode this field exists to end. */
  reason?: string;
}

/** Best-effort, exactly like the reconciler's: a cluster that cannot take
 * the record must not fail a backup that already succeeded. The failure
 * is visible anyway - the reader stale-guards, so an unpublished record
 * ages into `unknown` rather than sitting green - but it must also be
 * NAMED at the source, so the operator reading the timer's journal is
 * not left with "could not publish" and nothing else. */
export function publishPlatformBackupStatus(record: Record<string, unknown>): PublishResult {
  return publishStatusConfigMap(PLATFORM_BACKUP_CONFIGMAP, "platform-backup", record);
}

/** The ConfigMap a status record rides in: one `status.json` key,
 * labelled by its owning surface, in the reconciler's status namespace.
 * Pure, so the namespace it targets is testable without a cluster. */
export function statusConfigMapManifest(
  name: string,
  source: string,
  record: Record<string, unknown>,
): { apiVersion: "v1"; kind: "ConfigMap"; metadata: { name: string; namespace: string; labels: Record<string, string> }; data: Record<string, string> } {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace: statusRecordNamespace(),
      labels: { "hermes.dev/overlay-source": source },
    },
    data: { "status.json": JSON.stringify(record, null, 2) + "\n" },
  };
}

/** The shared status-record publish. `hg workspace verify --record`
 * speaks the same convention. */
export function publishStatusConfigMap(
  name: string,
  source: string,
  record: Record<string, unknown>,
): PublishResult {
  const manifest = JSON.stringify(statusConfigMapManifest(name, source, record));
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(
      ["kubectl", "--context", KCTX, "apply", "--server-side", "--force-conflicts", "-f", "-"],
      { stdin: Buffer.from(manifest), stdout: "pipe", stderr: "pipe" },
    );
  } catch (e) {
    // No kubectl on PATH (or not executable) is a spawn THROW, not a
    // failed process - still best-effort, still a named reason.
    return { ok: false, reason: `kubectl could not be run: ${String(e).slice(0, 300)}` };
  }
  if ((proc.exitCode ?? 1) === 0) return { ok: true };
  const said = ((proc.stderr?.toString() ?? "").trim() || (proc.stdout?.toString() ?? "").trim()).slice(-500);
  return { ok: false, reason: said || `kubectl exit ${proc.exitCode ?? "unknown"}` };
}

function warnUnpublished(what: string, r: PublishResult): void {
  if (!r.ok) warn(`could not publish the platform backup record after ${what} (${r.reason}) - Nexus will read this backup as stale`);
}

/** The declarative inventory: what `hg up` + Argo rebuild rather than any
 * archive restoring. Recorded so `backup prove` can check the CLAIM.
 *
 * Bundle-aware, and it has to be (ADR-28): bundling RETIRES a profile's
 * own Application, so naming `hermes-<profile>` for a bundled member
 * records a claim about something that does not exist. Found live - the
 * manifest listed two Applications no cluster had, every restore reported
 * them failed, and the backup could therefore never reach `restorable`.
 * A backup that cannot be verified because it describes the wrong fleet
 * is worse than one that fails honestly. */
function declarativeInventory(ctxs: ProfileCtx[], envDir?: string): ComponentEntry[] {
  const bundled = envDir ? loadEnvironment(envDir).environment.bundledProfiles ?? {} : {};
  const entries: ComponentEntry[] = [];
  const seen = new Set<string>();
  for (const ctx of ctxs) {
    // Deployed reality over declaration (bundle-blindness #6): the
    // bundle Application only belongs in the inventory when this
    // deployment actually runs it - the same ns-existence check the
    // routine resolution uses. A restore verifying a phantom bundle app
    // can never reach `restorable` (the M12 bug, mirrored).
    let placement: (typeof bundled)[string] | undefined = bundled[ctx.name];
    const runtime = ctx.runtime === "eve" ? "eve" : "hermes";
    if (placement) {
      const probe = sh(["kubectl", "--context", KCTX, "get", "namespace", bundleCoordinatesFor(placement, runtime).namespace,
        "-o", "name"], { allowFail: true, quiet: true }).trim();
      if (!probe) placement = undefined;
    }
    // Several profiles share one bundle Application - record it once,
    // naming every member, rather than the same claim N times.
    const name = placement
      ? `argocd-application/${bundleAppOf(placement.bundle, runtime)}`
      : `argocd-application/${appOf(ctx.name)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({
      name,
      kind: "declarative" as const,
      profile: ctx.name,
      detail: placement
        ? `rebuilt by \`hg up\` inside the ${placement.bundle} bundle; Argo CD syncs it Healthy`
        : "rebuilt by `hg up` from the onboarded repo; Argo CD syncs it Healthy",
    });
  }
  entries.push(
    {
      name: "argocd",
      kind: "declarative",
      detail: "installed by the bootstrap; holds no state Git cannot rebuild",
    },
    {
      name: "grafana-dashboards-and-alerts",
      kind: "declarative",
      detail: "re-imported from labelled ConfigMaps by the sidecar after `hg up`",
    },
    {
      name: "prometheus-metric-history",
      kind: "declarative",
      detail:
        "TSDB not archived: no MVP panel promises continuity across recovery yet (design 13); " +
        "becomes a volume component when embedded panels promise history",
    },
    {
      name: "communication-router",
      kind: "declarative",
      detail: "event router + queues re-created by `hg up`; in-flight queue state is not promised",
    },
    {
      name: "cloudflare-tunnel",
      kind: "declarative",
      detail: "Pulumi-provisioned in production; inactive in the local loop",
    },
    {
      name: "hermes-host-config",
      kind: "declarative",
      detail: "operator-host Hermes install is re-created by bootstrap; secrets rehydrate " +
        "through the declared secret path and are NEVER copied into a backup",
    },
  );
  return entries;
}

/** Control-plane namespaces whose backup routines ride the platform
 * backup exactly like a profile's (ADR-48: Nexus). A pseudo-ctx per
 * namespace - the backup machinery only ever derives the namespace from
 * the name, so `nexus` -> `hermes-nexus` matches the profile convention. */
export function controlPlaneCtxs(): ProfileCtx[] {
  // `nexus` for the overlay state, `system` for the router's dead-letter
  // archive (#303). Both are pseudo-ctxs: the backup machinery only ever
  // derives a namespace from the name, so `nexus` -> `hermes-nexus` and
  // `system` -> `hermes-system` follow the profile convention.
  //
  // Without `system` the DLQ routine was discovered by the Nexus Backups
  // view (which lists cluster-wide by label) and by nothing else - so
  // `hg backup verify` never checked it and `hg platform backup` never
  // archived it, which would have made #303's whole point unreachable.
  return ["nexus", "system"].flatMap((name) => {
    const out = kubectl(["get", "namespace", nsOf(name), "-o", "name"], {
      allowFail: true,
      quiet: true,
    }).trim();
    return out ? [{ name, subdir: "", dir: "/nonexistent", runtime: "hermes" as const }] : [];
  });
}

/** Take a fresh backup of everything and scaffold it into <destRoot>/<id>/. */
/** The consistency claim (#436), derived from an archive listing. Pure so
 * the offline test exercises both branches. The marker file is written
 * only by the chart routine's sqlite snapshot step, so its presence in
 * the listing IS the evidence the snapshot ran; its absence is stated
 * honestly (old-chart archives, the Nexus overlay tar). */
export function consistencyOf(listing: string): string {
  // Exact basename, not a suffix match: "./foo.hermes-db-snapshot.json"
  // must not count as evidence (Codex catch - BKUP006 matches on path
  // components, and this claim must not be weaker).
  return listing
    .split("\n")
    .some((l) => l.trimEnd().split("/").pop() === ".hermes-db-snapshot.json")
    ? "tar + sqlite snapshot (sqlite3.backup + integrity_check; .hermes-db-snapshot.json verified in archive)"
    : "filesystem tar only - no sqlite snapshot marker";
}

export function createPlatformBackup(
  ctxs: ProfileCtx[],
  destRoot: string,
  timeoutSec: number,
  envDir?: string,
): { dir: string; manifest: PlatformManifest } {
  // Profile ctxs feed BOTH volumes and the declarative Argo inventory;
  // control-plane pseudo-ctxs (helm-installed, no Application) feed
  // volumes only.
  const profileCtxs = ctxs;
  ctxs = [...ctxs, ...controlPlaneCtxs()];
  const backupId = `hg-${new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "z")}`;
  const dir = path.join(destRoot, backupId);
  fs.mkdirSync(path.join(dir, "volumes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "host"), { recursive: true });
  const components: ComponentEntry[] = [];

  // Volume components: invoke every routine FRESH, then export - a
  // platform backup of stale artifacts would time-travel the fleet.
  for (const ctx of ctxs) {
    for (const routine of discoverRoutines(ctx)) {
      log(`[${ctx.name}] fresh run of ${routine.name}`);
      const run = runRoutine(ctx, routine, timeoutSec);
      if (!run.ok) {
        throw new CliError(`routine ${routine.name} did not complete - refusing a stale platform backup`);
      }
      const volDir = path.join(dir, "volumes", ctx.name);
      const report = exportArtifact(ctx, routine, volDir);
      components.push({
        name: `volume/${ctx.name}/${routine.name}`,
        kind: "volume-archive",
        profile: ctx.name,
        routine: routine.name,
        archive: path.relative(dir, report.file),
        sha256: report.sha256,
        sizeKB: report.sizeKB,
        // #436: the claim is derived from the archive's own listing, not
        // assumed - the marker is written only by the snapshot step.
        consistency: consistencyOf(sh(["tar", "-tzf", report.file], { quiet: true })),
      });
    }
  }

  // Host component: the Nexus operator overlay (workspace/layouts/flags).
  // Interim home until ADR-48 moves it in-cluster; the destructive gate
  // deletes exactly this, so the platform backup must carry it.
  if (fs.existsSync(NEXUS_STATE_DIR)) {
    const archive = path.join(dir, "host", "nexus-state.tar.gz");
    sh(["tar", "czf", archive, "-C", NEXUS_STATE_DIR, "."], { quiet: true });
    components.push({
      name: "host/nexus-state",
      kind: "host-archive",
      archive: path.relative(dir, archive),
      sha256: sha256File(archive),
      sizeKB: Math.round(fs.statSync(archive).size / 1024),
      consistency: "tar of the operator-host overlay directory",
      detail: NEXUS_STATE_DIR,
    });
  }

  components.push(...declarativeInventory(profileCtxs, envDir));

  const manifest: PlatformManifest = {
    schemaVersion: "hermes.dev/platform-backup/v1alpha2",
    backupId,
    createdAt: new Date().toISOString(),
    environment: ctxs.map((c) => c.name).join(","),
    components,
    verification: { state: "available" },
    // #582: resolve the PVC ledger's excused rows now, while we can see
    // the cluster - the record is what lets Nexus render intentional
    // gaps as intentional.
    unprotectedByDesign: protectedStateLedger(clusterClaims(), archivedClaims())
      .filter((e) => e.status === "unprotected-by-design")
      .map((e) => ({ claim: e.claim, namespace: e.namespace, reason: e.reason })),
  };
  writeManifest(dir, manifest);
  warnUnpublished("create", publishPlatformBackupStatus(platformBackupRecord(manifest, new Date().toISOString())));
  return { dir, manifest };
}


/** Upload a scaffolded backup to a cloud sink, recording each object's
 * generation in the manifest and re-publishing the record.
 *
 * The local directory stays the working set - this is an UPLOAD, not a
 * replacement. Losing the host is what the objects are for; losing the
 * objects is what the directory is for, and collapsing the two would
 * make a failed upload look like a missing backup. */
export function uploadPlatformBackup(sink: GcsSink, dir: string, manifest: PlatformManifest): void {
  // ponytail: a create-only writer cannot resume a PARTIAL upload of the
  // same backup id - the recovery is a fresh `backup create` (new id, new
  // second), and orphaned partials age out via the bucket lifecycle.
  // Resume-with-preconditions arrives if partial uploads ever hurt.
  ensureBucket(sink);
  // The sink's CMEK key, recorded so a restore knows what it must be able
  // to decrypt through BEFORE it starts downloading (#297). ensureBucket
  // already refused a real bucket without one.
  const kmsKey = bucketKmsKey(sink);
  if (kmsKey) manifest.encryption = { mode: "cmek", kmsKey };
  let uploaded = 0;
  for (const c of manifest.components) {
    if (!c.archive) continue; // declarative components carry no bytes
    const local = path.join(dir, c.archive);
    if (!fs.existsSync(local)) continue;
    c.generation = putObject(sink, local, objectKey(sink, manifest.backupId, c.archive));
    uploaded += 1;
  }
  // The manifest goes last and on purpose: it names the generations, so
  // its presence in the bucket is what makes the upload COMPLETE. A
  // restore that finds archives and no manifest found a partial upload.
  const manifestFile = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  putObject(sink, manifestFile, objectKey(sink, manifest.backupId, "manifest.json"));
  ok(`uploaded ${uploaded} archive(s) + manifest to ${destinationClassOf(sink)} (${sink.bucket})`);
  // The destination class rides this publish; a silent miss here left
  // Nexus describing an uploaded backup as local-only.
  warnUnpublished(
    "upload",
    publishPlatformBackupStatus(platformBackupRecord(manifest, new Date().toISOString(), destinationClassOf(sink))),
  );
}

export interface RestoreResult {
  component: string;
  status: "restored" | "verified-declarative" | "failed";
  message: string;
}

/** Restore a scaffolded backup: volume archives through the PR-1 restore
 * path, the host archive back onto disk, declaratives verified against
 * the live (already re-bootstrapped) cluster. */
export function restorePlatformBackup(
  ctxs: ProfileCtx[],
  fromDir: string,
  timeoutSec: number,
): RestoreResult[] {
  ctxs = [...ctxs, ...controlPlaneCtxs()];
  const manifest = readManifest(fromDir);
  const results: RestoreResult[] = [];
  // Measured, not estimated: design 13 lets an RTO number derive only
  // from a restore that actually ran, and this is where that number is
  // made. Absent = `unmeasured`, never a zero.
  const startedMs = Date.now();

  for (const c of manifest.components) {
    if (c.kind === "volume-archive") {
      const ctx = ctxs.find((x) => x.name === c.profile);
      if (!ctx) {
        results.push({ component: c.name, status: "failed", message: `profile ${c.profile} is not onboarded` });
        continue;
      }
      const file = path.join(fromDir, c.archive!);
      if (!fs.existsSync(file) || sha256File(file) !== c.sha256) {
        results.push({ component: c.name, status: "failed", message: "archive missing or checksum mismatch" });
        continue;
      }
      const routine = discoverRoutines(ctx).find((r) => r.name === c.routine);
      if (!routine) {
        results.push({ component: c.name, status: "failed", message: `routine ${c.routine} not found (has Argo synced the profile?)` });
        continue;
      }
      // Dispatch by the routine's restore SHAPE, exactly like `hg backup
      // restore` (this path called restoreArtifact unconditionally, so
      // every weekly verify since the hook-shaped DLQ routine shipped
      // died on it - the platform backup read "never restore-proven"
      // forever). The hook command is a GitOps-declared annotation on
      // the CronJob - the same trust domain as the routine's own backup
      // command, which this path already runs - so the interactive
      // --allow-restore-hook gate does not apply here; the command is
      // logged for the journal instead.
      if (routine.restoreHookError) {
        results.push({ component: c.name, status: "failed", message: `restore hook invalid: ${routine.restoreHookError}` });
        continue;
      }
      let report;
      if (routine.restoreHook) {
        log(`restore hook for ${routine.name}: ${routine.restoreHook.command.join(" ")}`);
        report = restoreViaHook(ctx, routine, file);
      } else {
        report = restoreArtifact(ctx, routine, file, timeoutSec);
      }
      results.push({
        component: c.name,
        status: "restored",
        message:
          report.fileCount >= 0
            ? `${report.fileCount} entries into ${report.targetPvc}`
            : `app-reported restore via hook into ${report.targetPvc}`,
      });
    } else if (c.kind === "host-archive") {
      const file = path.join(fromDir, c.archive!);
      if (!fs.existsSync(file) || sha256File(file) !== c.sha256) {
        results.push({ component: c.name, status: "failed", message: "archive missing or checksum mismatch" });
        continue;
      }
      // Wipe-then-untar, same never-merge rule as the volume path.
      fs.rmSync(NEXUS_STATE_DIR, { recursive: true, force: true });
      fs.mkdirSync(NEXUS_STATE_DIR, { recursive: true });
      sh(["tar", "xzf", file, "-C", NEXUS_STATE_DIR], { quiet: true });
      results.push({ component: c.name, status: "restored", message: `overlay back at ${NEXUS_STATE_DIR}` });
    } else {
      // Declarative: nothing to write; verify the rebuild claim. Wait for
      // convergence rather than sampling the instant after a volume restore
      // scaled the writer back - "Progressing" seconds after a restart is
      // recovery working, not recovery failing.
      if (c.name.startsWith("argocd-application/")) {
        const app = c.name.split("/")[1]!;
        const deadline = Date.now() + timeoutSec * 1000;
        let out = "";
        for (;;) {
          out = kubectl(
            ["-n", "argocd", "get", "applications.argoproj.io", app, "-o",
              "jsonpath={.status.sync.status} {.status.health.status}"],
            { allowFail: true, quiet: true },
          ).trim();
          if (out === "Synced Healthy" || Date.now() > deadline) break;
          sh(["sleep", "3"], { quiet: true });
        }
        results.push(
          out === "Synced Healthy"
            ? { component: c.name, status: "verified-declarative", message: "Synced+Healthy after rebuild" }
            : { component: c.name, status: "failed", message: `expected Synced Healthy within ${timeoutSec}s, got ${JSON.stringify(out || "absent")}` },
        );
      } else {
        results.push({ component: c.name, status: "verified-declarative", message: c.detail ?? "rebuilt from declared state" });
      }
    }
  }

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length === 0) {
    const updated = readManifest(fromDir);
    updated.verification = {
      state: "restorable",
      restoredAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedMs) / 1000),
    };
    writeManifest(fromDir, updated);
    // Re-publish: `available` -> `restorable` is the transition the whole
    // two-state contract exists to make visible, so a surface that never
    // learned about it would defeat the point (ADR-52).
    warnUnpublished("verify-restore", publishPlatformBackupStatus(platformBackupRecord(updated, new Date().toISOString())));
  }
  fs.writeFileSync(
    path.join(fromDir, "restore-report.json"),
    JSON.stringify({ restoredAt: new Date().toISOString(), ok: failed.length === 0, results }, null, 2) + "\n",
  );
  return results;
}

// ---------------------------------------------------------------------------
// backup prove: the design-16 ProofResult envelope over the restored state.


// ---------------------------------------------------------------------------
// The protected-state ledger (design 13, #283).
//
// A backup set is only as honest as its inventory. Every check above
// asks "is what we archived intact"; none of them asks the question that
// actually decides whether this server is disposable: **is there durable
// state nobody archived at all?**
//
// So the ledger is CLOSED. Every PersistentVolumeClaim in the cluster is
// either covered by a backup routine, or named here as deliberately not
// protected with a reason. A claim that is neither fails the proof - and
// that failure is the whole point, because the alternative is finding
// out during a restore.

/** Claims that are deliberately unprotected, and why. Each entry is a
 * promise that losing this volume costs nothing that cannot be rebuilt -
 * so each one is a claim a reviewer can check, not a silencer. */
export const UNPROTECTED_BY_DESIGN: { match: RegExp; reason: string }[] = [
  {
    // Matched loosely on purpose: the stack's generated claim name
    // depends on release and StatefulSet naming, and a pattern pinned to
    // one spelling silently reclassifies the volume as UNACCOUNTED the
    // day either changes. Found exactly that way.
    match: /^prometheus-.*-db-/,
    reason:
      "metric history: no enabled panel promises continuity across recovery (design 13), " +
      "so the gap is stated rather than archived",
  },
  {
    match: /-redis$/,
    reason:
      "the durable event queue: in-flight entries and consumer offsets, which `hg up` re-creates " +
      "and design 13 does not promise. The DEAD LETTERS on this volume are archived separately " +
      "by the router's own routine (#303) - restoring the whole volume would replay deliveries " +
      "that already succeeded",
  },
  {
    match: /-backups$/,
    reason: "a backup SINK - archiving the archive is circular; `hg platform backup` exports it",
  },
  {
    match: /^workspaces-/,
    reason:
      "pinned git checkouts, reproduced by cloning at the recorded SHA - declarative state, " +
      "not unique state",
  },
  {
    match: /^alertmanager-monitoring-kube-prometheus-alertmanager-db-/,
    reason: "silences and notification state; rebuilt by the stack, and stale silences are worse than none",
  },
];

export interface LedgerEntry {
  claim: string;
  namespace: string;
  status: "protected" | "unprotected-by-design" | "UNACCOUNTED";
  reason: string;
}

/** Reconcile every PVC in the cluster against the routines that archive
 * one. Pure over its inputs so the interesting cases are testable. */
export function protectedStateLedger(
  claims: { name: string; namespace: string }[],
  archivedClaims: Set<string>,
): LedgerEntry[] {
  return claims
    .map(({ name, namespace }): LedgerEntry => {
      const key = `${namespace}/${name}`;
      if (archivedClaims.has(key)) {
        return { claim: name, namespace, status: "protected", reason: "a backup routine archives it" };
      }
      const excused = UNPROTECTED_BY_DESIGN.find((u) => u.match.test(name));
      if (excused) {
        return { claim: name, namespace, status: "unprotected-by-design", reason: excused.reason };
      }
      return {
        claim: name,
        namespace,
        status: "UNACCOUNTED",
        reason:
          "durable state that no routine archives and nothing has excused - " +
          "this volume does not survive the loss of this server",
      };
    })
    .sort((a, b) => a.claim.localeCompare(b.claim));
}

/** Every PVC a labelled backup routine reads FROM - its data volume, not
 * its sink. Read from the routines themselves so the ledger cannot drift
 * from what actually runs. */
export function archivedClaims(): Set<string> {
  const out = new Set<string>();
  const json = kubectl(
    ["get", "cronjobs", "-A", "-l", `${ROUTINE_LABEL}=true`, "-o", "json"],
    { allowFail: true, quiet: true },
  );
  if (!json.trim()) return out;
  for (const r of parseRoutines(json)) {
    if (r.dataPvc) out.add(`${r.namespace}/${r.dataPvc}`);
    for (const covered of r.coversPvcs) out.add(`${r.namespace}/${covered}`);
  }
  return out;
}

export function clusterClaims(): { name: string; namespace: string }[] {
  const json = kubectl(["get", "pvc", "-A", "-o", "json"], { allowFail: true, quiet: true });
  if (!json.trim()) return [];
  try {
    const doc = JSON.parse(json) as { items?: { metadata?: { name?: string; namespace?: string } }[] };
    return (doc.items ?? [])
      .map((i) => ({ name: i.metadata?.name ?? "", namespace: i.metadata?.namespace ?? "" }))
      .filter((c) => c.name && c.namespace);
  } catch {
    return [];
  }
}

import type { ProofFinding, ProofResult } from "../proof.ts";
export type { ProofFinding, ProofResult } from "../proof.ts";

export function proveRecovery(ctxs: ProfileCtx[], fromDir: string): ProofResult {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });

  let manifest: PlatformManifest | null = null;
  try {
    manifest = readManifest(fromDir);
    add("PLAT001", "pass", "manifest", `parsed ${manifest.backupId} (${manifest.components.length} components)`);
  } catch (err) {
    add("PLAT001", "fail", "manifest", (err as Error).message);
  }

  if (manifest) {
    add(
      "PLAT002",
      manifest.verification.state === "restorable" ? "pass" : "fail",
      "verification",
      manifest.verification.state === "restorable"
        ? `restorable since ${manifest.verification.restoredAt}`
        : "still `available` - no restore has validated this backup (ADR-52)",
    );
    for (const c of manifest.components) {
      if (c.archive) {
        const file = path.join(fromDir, c.archive);
        const intact = fs.existsSync(file) && sha256File(file) === c.sha256;
        add("PLAT003", intact ? "pass" : "fail", c.name, intact ? "archive intact on disk" : "archive missing or corrupt");
      }
    }
    for (const c of manifest.components.filter((c) => c.name.startsWith("argocd-application/"))) {
      const app = c.name.split("/")[1]!;
      const out = kubectl(
        ["-n", "argocd", "get", "applications.argoproj.io", app, "-o",
          "jsonpath={.status.sync.status} {.status.health.status}"],
        { allowFail: true, quiet: true },
      ).trim();
      add("PLAT004", out === "Synced Healthy" ? "pass" : "fail", c.name, out || "absent");
    }
    for (const ctx of ctxs) {
      // backupNsOf, not nsOf: a bundled member's own namespace was
      // retired with its StatefulSet (ADR-28), so asking there returns
      // "no pods" - which on a RECOVERY proof reads as "the agent did
      // not come back". Fifth place in this arc that addressing a
      // bundled profile by its own name found nothing.
      const pods = kubectl(
        ["-n", backupNsOf(ctx), "get", "pods", "-o",
          "jsonpath={range .items[*]}{.metadata.name}={.status.phase} {end}"],
        { allowFail: true, quiet: true },
      ).trim();
      const running = pods.includes("Running");
      add("PLAT005", running ? "pass" : "fail", `pods/${ctx.name}`, pods || "no pods");
    }
    const nexusOk = fs.existsSync(NEXUS_STATE_DIR) && fs.readdirSync(NEXUS_STATE_DIR).length > 0;
    const hasNexusComponent = manifest.components.some((c) => c.name === "host/nexus-state");
    add(
      "PLAT006",
      hasNexusComponent ? (nexusOk ? "pass" : "fail") : "unknown",
      "host/nexus-state",
      hasNexusComponent
        ? nexusOk
          ? `overlay present at ${NEXUS_STATE_DIR}`
          : "overlay directory empty or missing after restore"
        : "backup carried no Nexus overlay - nothing to prove",
    );
  }

  // PLAT007 - the closed ledger. Every other finding asks whether what we
  // archived survived; this asks whether anything durable was never
  // archived at all, which is the question that decides if this server is
  // actually disposable.
  const ledger = protectedStateLedger(clusterClaims(), archivedClaims());
  const unaccounted = ledger.filter((e) => e.status === "UNACCOUNTED");
  add(
    "PLAT007",
    ledger.length === 0 ? "unknown" : unaccounted.length === 0 ? "pass" : "fail",
    "protected-state",
    ledger.length === 0
      ? "no persistent volumes could be listed - the ledger proved nothing"
      : unaccounted.length === 0
        ? `${ledger.length} volume(s) accounted for: ${ledger.filter((e) => e.status === "protected").length} archived, ` +
          `${ledger.length - unaccounted.length - ledger.filter((e) => e.status === "protected").length} unprotected by design`
        : `durable state nobody archives: ${unaccounted.map((e) => `${e.namespace}/${e.claim}`).join(", ")}`,
  );

  const summary = {
    pass: findings.filter((f) => f.status === "pass").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "platform backup prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    findings,
    summary,
  };
}
