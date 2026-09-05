// hg backup - invocation and sight over app-owned backup routines.
//
// The contract split: the ROUTINE (what to protect, how to archive it)
// belongs to whoever owns the data - the hermes-profile chart for the
// agent volume, an app chart for its own state - declared as a CronJob
// labelled `hermes.dev/backup-routine: "true"` whose sink volume is
// named `backups`, annotated `hermes.dev/backup-protects` with the
// comma-separated path patterns the artifact must contain. INVOCATION
// and OBSERVABILITY belong to the platform: this command discovers every
// routine, triggers it on demand (a CronJob's nightly schedule is
// useless to a developer loop), and opens the newest artifact to assert
// it contains what the routine claims to protect - because a Job that
// completes green while archiving the wrong volume is exactly the
// failure this exists to catch.
//
// No frozen schema is touched: spec.backup stays {schedule, retention}
// intent, providers.backup stays the sink choice. Discovery is by label.

import { createHash } from "node:crypto";
import { readAgentDeclaration } from "../layout.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { bundleCoordinatesFor, loadEnvironment, type BundledProfile } from "../topology/environment.ts";
import {
  CliError,
  KCTX,
  kubectl,
  log,
  nsOf,
  sh,
  type ProfileCtx,
} from "../lib.ts";

export const ROUTINE_LABEL = "hermes.dev/backup-routine";
export const PROTECTS_ANNOTATION = "hermes.dev/backup-protects";
export const RESTORE_HOOK_ANNOTATION = "hermes.dev/backup-restore-hook";
/** PVCs a NETWORK-DUMP routine covers without mounting them (pg_dump over
 * the service): the ledger cannot infer coverage from volumes it never
 * sees, so the routine declares it - found live when a real postgres PVC
 * read UNACCOUNTED behind a perfectly good dump routine. */
export const COVERS_ANNOTATION = "hermes.dev/backup-covers";
/** The convention for finding a routine's sink: the volume named `backups`. */
const SINK_VOLUME = "backups";

export interface BackupRoutine {
  name: string;
  namespace: string;
  schedule: string;
  suspend: boolean;
  /** Comma-separated path patterns the newest artifact must contain. */
  protects: string[];
  /** PVC the routine's `backups` volume claims - null is a convention breach. */
  sinkPvc: string | null;
  /** PVC the routine archives FROM: its first non-`backups` PVC volume.
   * This is the restore target - the routine already names its source. */
  dataPvc: string | null;
  /** PVCs covered WITHOUT being mounted (network dumps) - ledger
   * attribution only, never a restore target. */
  coversPvcs: string[];
  lastScheduleTime?: string;
  lastSuccessfulTime?: string;
  /** The app-owned restore path, when the routine declares one. */
  restoreHook?: RestoreHook;
  /** Why the hook annotation was rejected, when it was present and bad.
   * Kept separate from absence: "declared a hook that does not parse" and
   * "declared none" are different operator problems. */
  restoreHookError?: string;
}

/** How to restore an artifact that is NOT a volume tarball (#282).
 *
 * The volume path (scale to zero, wipe, untar) is wrong for a database
 * dump: the database has to be UP to accept it. So an app whose artifact
 * is `pg_dump` output declares how to put it back, as an annotation on
 * the CronJob it already owns. No frozen schema changes - the persona
 * chart authors its own CronJob, and this annotation is the contract,
 * validated here on read.
 *
 * The command is arbitrary and comes from the cluster, so `hg backup
 * restore` prints it and refuses to run it without `--allow-restore-hook`
 * - the same posture `--allow-repo-scripts` takes for repository-authored
 * test scripts. */
export interface RestoreHook {
  /** `kind/name` to exec into, e.g. `statefulset/postiz-db`. */
  workload: string;
  container?: string;
  command: string[];
  /** Where the archive is staged inside the container before the command
   * runs. The command is expected to read it from here. */
  stagePath: string;
  /** Workloads to scale to zero first, for apps that need their writers
   * quiesced even though the restore target itself must stay up. */
  quiesce: string[];
}

const WORKLOAD_RE = /^(statefulset|deployment)\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Parse and VALIDATE the restore-hook annotation. Returns the hook, or a
 * message explaining why the declaration was refused - never a partially
 * applied hook, because a half-understood restore command is worse than
 * none. */
export function parseRestoreHook(raw: string | undefined): { hook?: RestoreHook; error?: string } {
  if (!raw || !raw.trim()) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { error: `${RESTORE_HOOK_ANNOTATION} is not valid JSON` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { error: `${RESTORE_HOOK_ANNOTATION} must be a JSON object` };
  }
  const d = doc as Record<string, unknown>;
  const workload = typeof d.workload === "string" ? d.workload : "";
  if (!WORKLOAD_RE.test(workload)) {
    return {
      error: `${RESTORE_HOOK_ANNOTATION}.workload must be statefulset/<name> or deployment/<name>`,
    };
  }
  const command = Array.isArray(d.command) ? d.command.filter((c) => typeof c === "string") : [];
  if (command.length === 0 || command.length !== (d.command as unknown[]).length) {
    return { error: `${RESTORE_HOOK_ANNOTATION}.command must be a non-empty array of strings` };
  }
  const stagePath = typeof d.stagePath === "string" && d.stagePath ? d.stagePath : "/tmp/hg-restore";
  if (!stagePath.startsWith("/") || stagePath.includes("..")) {
    return { error: `${RESTORE_HOOK_ANNOTATION}.stagePath must be an absolute path with no ".." segment` };
  }
  const quiesceRaw = Array.isArray(d.quiesce) ? d.quiesce : [];
  const quiesce = quiesceRaw.filter((q): q is string => typeof q === "string" && WORKLOAD_RE.test(q));
  if (quiesce.length !== quiesceRaw.length) {
    return { error: `${RESTORE_HOOK_ANNOTATION}.quiesce entries must be statefulset/<name> or deployment/<name>` };
  }
  const container = typeof d.container === "string" && d.container ? d.container : undefined;
  return { hook: { workload, ...(container ? { container } : {}), command, stagePath, quiesce } };
}

/** What `hg backup restore` would do with this routine. `unsupported` is
 * an actionable FAILURE, not a shrug: an app whose artifact is a database
 * dump and which declares no hook has a backup nothing can put back, and
 * every surface must say so rather than showing a healthy routine. */
export function restoreShapeOf(r: BackupRoutine): "volume" | "hook" | "unsupported" {
  if (r.restoreHook) return "hook";
  return r.dataPvc ? "volume" : "unsupported";
}

/** The namespace a profile's workloads actually run in.
 *
 * `hermes-<profile>` for an ordinary profile - and something else
 * entirely for a bundled one (ADR-28), whose per-profile namespace was
 * retired along with its StatefulSet. Every kubectl call in this module
 * goes through here for the same reason `resolveAgent` had to become
 * bundle-aware in #278: addressing a bundled profile by name resolves to
 * something that does not exist, and the failure looks exactly like "no
 * routines found" - which on THIS surface reads as "nothing is backed
 * up" rather than "you asked the wrong namespace".
 *
 * The placement file is the authority; a fleet with no bundles.yaml gets
 * the plain answer and pays one cheap file check. */
export function backupNsOf(
  ctx: ProfileCtx,
  nsExists: (namespace: string) => boolean = (namespace) =>
    sh(["kubectl", "--context", KCTX, "get", "namespace", namespace,
      "-o", "name"], { allowFail: true, quiet: true }).trim() !== "",
): string {
  const placement = bundlePlacement(ctx);
  // The declaration says WHERE a bundled profile would live; only the
  // CLUSTER says whether this deployment bundles at all. The factory
  // environment runs the same repo unbundled, and trusting the
  // declaration alone silently dropped two agents' data volumes from a
  // real backup - bundle-blindness #6, inverted. Namespace existence is
  // the cheapest deployed-reality check that distinguishes the two;
  // nsExists is a parameter only so tests can assert both branches
  // without a cluster (#735).
  if (placement) {
    const { namespace } = bundleCoordinatesFor(placement, ctx.runtime === "eve" ? "eve" : "hermes");
    if (nsExists(namespace)) return namespace;
  }
  return nsOf(ctx.name);
}

/** ponytail: re-reads bundles.yaml per call. It is one small YAML file
 * and these commands make dozens of kubectl calls beside it; cache only
 * if a profile count ever makes it show up. */
function bundlePlacement(ctx: ProfileCtx): BundledProfile | undefined {
  // The onboard root, two levels up from a catalogue member's directory
  // (dir = <root>/<subdir>), or the directory itself for a bare profile.
  const root = ctx.subdir ? path.resolve(ctx.dir, ...ctx.subdir.split("/").map(() => "..")) : ctx.dir;
  try {
    return loadEnvironment(root).environment.bundledProfiles?.[ctx.name];
  } catch {
    return undefined;
  }
}

export interface ArtifactReport {
  name: string;
  sizeKB: number;
  ageSeconds: number;
  count: number;
  protects: { pattern: string; found: boolean }[];
  /** SQLite sidecar files found in the artifact (#436) - a hot-copied db
   * shipped with its live -wal/-shm/-journal is a torn restore waiting.
   * Empty means clean; absent lines from an OLD inspector parse as empty
   * too, which BKUP008 treats as clean (the protects marker gate BKUP006
   * is what fails an old-chart archive). */
  dbSidecars?: string[];
}

// ---------------------------------------------------------------------------
// Pure parsing/reconciliation - unit-tested offline against captured JSON.

/** Parse `kubectl get cronjob -l hermes.dev/backup-routine=true -o json`. */
export function parseRoutines(kubectlJson: string): BackupRoutine[] {
  const doc = JSON.parse(kubectlJson) as {
    items?: {
      metadata?: {
        name?: string;
        namespace?: string;
        annotations?: Record<string, string>;
      };
      spec?: {
        schedule?: string;
        suspend?: boolean;
        jobTemplate?: {
          spec?: {
            template?: {
              spec?: {
                volumes?: { name?: string; persistentVolumeClaim?: { claimName?: string } }[];
              };
            };
          };
        };
      };
      status?: { lastScheduleTime?: string; lastSuccessfulTime?: string };
    }[];
  };
  return (doc.items ?? []).map((item) => {
    const volumes = item.spec?.jobTemplate?.spec?.template?.spec?.volumes ?? [];
    const sink = volumes.find((v) => v.name === SINK_VOLUME);
    const data = volumes.find(
      (v) => v.name !== SINK_VOLUME && v.persistentVolumeClaim?.claimName,
    );
    const protectsRaw = item.metadata?.annotations?.[PROTECTS_ANNOTATION] ?? "";
    const coversRaw = item.metadata?.annotations?.[COVERS_ANNOTATION] ?? "";
    const { hook, error } = parseRestoreHook(item.metadata?.annotations?.[RESTORE_HOOK_ANNOTATION]);
    return {
      name: item.metadata?.name ?? "<unnamed>",
      namespace: item.metadata?.namespace ?? "",
      schedule: item.spec?.schedule ?? "",
      suspend: item.spec?.suspend ?? false,
      protects: protectsRaw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      coversPvcs: coversRaw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      sinkPvc: sink?.persistentVolumeClaim?.claimName ?? null,
      dataPvc: data?.persistentVolumeClaim?.claimName ?? null,
      ...(item.status?.lastScheduleTime ? { lastScheduleTime: item.status.lastScheduleTime } : {}),
      ...(item.status?.lastSuccessfulTime
        ? { lastSuccessfulTime: item.status.lastSuccessfulTime }
        : {}),
      ...(hook ? { restoreHook: hook } : {}),
      ...(error ? { restoreHookError: error } : {}),
    };
  });
}

/** Parse the inspector pod's HG_-prefixed output lines. Returns null ONLY
 * for an explicitly-empty sink; anything else that lacks the artifact line
 * is a broken inspector, and throwing is what keeps a harness failure from
 * reading as "no artifact". */
export function parseInspector(output: string): ArtifactReport | null {
  const lines = output.split("\n").map((l) => l.trim());
  if (lines.some((l) => l === "HG_NO_ARTIFACT")) return null;
  const artifact = lines.find((l) => l.startsWith("HG_ARTIFACT "));
  if (!artifact) {
    throw new CliError(
      `inspector emitted no HG_ARTIFACT line - not an empty sink, a broken ` +
        `inspection: ${output.trim().slice(0, 300) || "(no output)"}`,
    );
  }
  const fields = Object.fromEntries(
    artifact
      .slice("HG_ARTIFACT ".length)
      .split(" ")
      .map((kv) => kv.split("=", 2) as [string, string]),
  );
  const countLine = lines.find((l) => l.startsWith("HG_COUNT "));
  const protects = lines
    .filter((l) => l.startsWith("HG_PROTECTS_"))
    .map((l) => {
      const [tag, ...rest] = l.split(" ");
      return { pattern: rest.join(" "), found: tag === "HG_PROTECTS_OK" };
    });
  const sidecarLine = lines.find((l) => l.startsWith("HG_DB_SIDECARS"));
  const dbSidecars =
    !sidecarLine || sidecarLine === "HG_DB_SIDECARS none"
      ? []
      : sidecarLine.slice("HG_DB_SIDECARS ".length).split(" ").filter(Boolean);
  return {
    name: fields["name"] ?? "<unknown>",
    sizeKB: Number(fields["sizeKB"] ?? 0),
    ageSeconds: Number(fields["ageSec"] ?? -1),
    count: countLine ? Number(countLine.slice("HG_COUNT ".length)) : 1,
    protects,
    dbSidecars,
  };
}

export interface RoutineFinding {
  profile: string;
  severity: "error" | "warning";
  message: string;
  /** The stable check id this finding belongs to (BKUP00x). Structural,
   * not derived from the message - the launch gate (#285) groups on it,
   * and grouping on prose would re-break every time a message is
   * reworded. */
  id: BackupCheckId;
}

/** The backup acceptance matrix. One id per CHECK, not per finding, so a
 * profile with three suspended routines reports one failed check with
 * three messages rather than three checks. */
export type BackupCheckId =
  | "BKUP001" // declared intent has a discovered routine
  | "BKUP002" // no routine is suspended
  | "BKUP003" // the sink convention is intact
  | "BKUP004" // protected paths are declared
  | "BKUP005" // the newest artifact exists and is not empty
  | "BKUP006" // the artifact contains every declared pattern
  | "BKUP007" // every routine has a restore path
  | "BKUP008"; // no artifact carries live sqlite sidecar files

export const BACKUP_CHECKS: Record<BackupCheckId, string> = {
  BKUP001: "declared backup intent has a discovered routine",
  BKUP002: "no discovered routine is suspended",
  BKUP003: "every routine's sink convention is intact",
  BKUP004: "every routine declares what its artifact must protect",
  BKUP005: "every sink holds a non-empty newest artifact",
  BKUP006: "every artifact contains every pattern it declares",
  BKUP007: "every routine has a restore path hg can execute",
  BKUP008: "no artifact contains live sqlite sidecar files (a hot-copied WAL db is a torn restore)",
};

/** Reconcile declared intent against discovered routines - no cluster reads. */
export function reconcile(
  profile: string,
  declaresBackup: boolean,
  routines: BackupRoutine[],
): RoutineFinding[] {
  const findings: RoutineFinding[] = [];
  if (declaresBackup && routines.length === 0) {
    findings.push({
      profile,
      severity: "error",
      message:
        "spec.backup is declared but NO backup routine exists in the namespace - " +
        `intent with no mechanism (routines are CronJobs labelled ${ROUTINE_LABEL}=true)`,
      id: "BKUP001",
    });
  }
  for (const r of routines) {
    if (r.suspend) {
      findings.push({
        profile,
        severity: "error",
        message: `routine ${r.name} is suspended - it will never take a backup`,
        id: "BKUP002",
      });
    }
    if (r.sinkPvc === null) {
      findings.push({
        profile,
        severity: "error",
        message:
          `routine ${r.name} has no volume named "${SINK_VOLUME}" backed by a PVC - ` +
          "the sink convention is broken and hg cannot inspect its artifacts",
        id: "BKUP003",
      });
    }
    if (r.protects.length === 0) {
      findings.push({
        profile,
        severity: "warning",
        message:
          `routine ${r.name} declares no ${PROTECTS_ANNOTATION} annotation - ` +
          "verify can prove an artifact exists but not that it protects anything",
        id: "BKUP004",
      });
    }
  }
  return findings;
}

/** Pods that would still be WRITING to `pvc` - the quiesce gate.
 *
 * The phase filter is the whole point. A completed backup Job pod keeps
 * `spec.volumes` naming the PVC forever, so a spec-only scan sees a
 * writer that finished hours ago and holds no volume attachment at all.
 * Found live: every namespace that had ever run a backup could no longer
 * be restored, because the quiesce poll waited out its full timeout on a
 * `Succeeded` pod and then refused. The same family as the completed-pod
 * bug that made agent availability read 0% (#279) - terminal pods are not
 * participants, and any check that treats them as such is wrong. */
export function mountingPods(kubectlPodsJson: string, pvc: string | null): string[] {
  if (!pvc) return [];
  const doc = JSON.parse(kubectlPodsJson) as {
    items?: {
      metadata?: { name?: string };
      status?: { phase?: string };
      spec?: { volumes?: { persistentVolumeClaim?: { claimName?: string } }[] };
    }[];
  };
  return (doc.items ?? [])
    .filter((p) => p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed")
    .filter((p) => p.spec?.volumes?.some((v) => v.persistentVolumeClaim?.claimName === pvc))
    .map((p) => p.metadata?.name ?? "<unnamed>");
}

/** Human-readable age. */
export function fmtAge(seconds: number): string {
  if (seconds < 0) return "unknown";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Cluster actions.

/** Does this profile's hermes-gitops.yaml declare backup intent? */
export function declaresBackup(profileDir: string): boolean {
  return Boolean(readAgentDeclaration(profileDir).raw["backup"]);
}

export function discoverRoutines(ctx: ProfileCtx): BackupRoutine[] {
  // No allowFail: an RBAC denial, missing namespace or dead API server must
  // surface as the error it is, never as "zero routines discovered".
  const out = kubectl(
    ["-n", backupNsOf(ctx), "get", "cronjob", "-l", `${ROUTINE_LABEL}=true`, "-o", "json"],
    { quiet: true },
  );
  try {
    return parseRoutines(out);
  } catch (err) {
    throw new CliError(`could not parse cronjob list for ${ctx.name}: ${(err as Error).message}`);
  }
}

/** Trigger a routine now: Job from CronJob, wait, return the outcome. */
export function runRoutine(
  ctx: ProfileCtx,
  routine: BackupRoutine,
  timeoutSec: number,
): { ok: boolean; durationMs: number; job: string; logTail: string } {
  const ns = backupNsOf(ctx);
  const job = `${routine.name}-hg-${Date.now().toString(36)}`;
  const started = Date.now();
  kubectl(["-n", ns, "create", "job", `--from=cronjob/${routine.name}`, job]);
  const wait = sh(
    [
      "kubectl", "--context", KCTX, "-n", ns, "wait", `job/${job}`,
      "--for=condition=complete", `--timeout=${timeoutSec}s`,
    ],
    { allowFail: true, quiet: true },
  );
  const completed = wait.includes("condition met");
  const logTail = kubectl(["-n", ns, "logs", `job/${job}`, "--tail=15"], {
    allowFail: true,
    quiet: true,
  }).trim();
  // The Job served its purpose; its logs are captured. Leaving it would
  // accumulate one Job per invocation forever.
  kubectl(["-n", ns, "delete", "job", job, "--wait=false"], { allowFail: true, quiet: true });
  return { ok: completed, durationMs: Date.now() - started, job, logTail };
}

// The inspector: a short-lived pod that mounts the routine's sink PVC
// read-only and reports the newest artifact + whether the protected paths
// are inside it. This is the mock that unblocks the tool - the PVC is
// only ever mounted by the (finished) backup Job, so nothing else can
// answer "what did the backup actually contain".
// ponytail: no node affinity - the local k3d cluster is single-node; on a
// multi-node cluster with local-path PVs the inspector would need the
// same co-scheduling the backup job uses.
const INSPECTOR_SCRIPT = `
set -eu
newest=$(ls -1t /backups 2>/dev/null | grep -vE '^(lost\\+found|.*\\.tmp|.*\\.lock)$' | head -1)
if [ -z "$newest" ]; then echo "HG_NO_ARTIFACT"; exit 0; fi
p="/backups/$newest"
size=$(du -sk "$p" | cut -f1)
now=$(date +%s)
mtime=$(date -r "$p" +%s 2>/dev/null || echo "$now")
echo "HG_ARTIFACT name=$newest sizeKB=$size ageSec=$((now - mtime))"
echo "HG_COUNT $(ls -1 /backups | grep -vE '^(lost\\+found|.*\\.tmp|.*\\.lock)$' | wc -l)"
# Path-component-anchored matching: "profiles/" must NOT match
# "old-profiles/", "board.json" must NOT match "board.json.bak". The
# pattern (trailing slash stripped, regex chars escaped) must sit on a
# path-component boundary in the listing.
for pat in $(echo "\${HG_PROTECTS:-}" | tr ',' ' '); do
  stripped=$(printf '%s' "$pat" | sed 's|/*$||')
  esc=$(printf '%s' "$stripped" | sed 's/[.[\\*^$+?(){}|]/\\\\&/g')
  if [ -d "$p" ]; then
    found=$(find "$p" 2>/dev/null | grep -E "(^|/)\${esc}(/|$)" | head -1)
  else
    found=$(tar -tzf "$p" 2>/dev/null | grep -E "(^|/)\${esc}(/|$)" | head -1)
  fi
  if [ -n "$found" ]; then echo "HG_PROTECTS_OK $pat"; else echo "HG_PROTECTS_MISSING $pat"; fi
done
# SQLite sidecars (#436): a live -wal/-shm/-journal next to a hot-copied
# db is a torn restore on the next open. The routine snapshots dbs and
# excludes the sidecars; an archive that carries one skipped that step.
if [ -d "$p" ]; then
  sidecars=$(find "$p" 2>/dev/null | grep -E '\\.db-(wal|shm|journal)$' | head -3)
else
  sidecars=$(tar -tzf "$p" 2>/dev/null | grep -E '\\.db-(wal|shm|journal)$' | head -3)
fi
if [ -n "$sidecars" ]; then echo "HG_DB_SIDECARS $(echo $sidecars | tr '\\n' ' ')"; else echo "HG_DB_SIDECARS none"; fi
`;

export function inspectSink(ctx: ProfileCtx, routine: BackupRoutine): ArtifactReport | null {
  if (!routine.sinkPvc) return null;
  const ns = backupNsOf(ctx);
  const pod = `hg-backup-inspect-${Date.now().toString(36)}`;
  const overrides = {
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "inspect",
          image: "busybox:1.37",
          command: ["sh", "-c", INSPECTOR_SCRIPT],
          env: [{ name: "HG_PROTECTS", value: routine.protects.join(",") }],
          volumeMounts: [{ name: "backups", mountPath: "/backups", readOnly: true }],
        },
      ],
      volumes: [
        { name: "backups", persistentVolumeClaim: { claimName: routine.sinkPvc, readOnly: true } },
      ],
    },
  };
  kubectl([
    "-n", ns, "run", pod,
    "--image=busybox:1.37", "--restart=Never",
    `--overrides=${JSON.stringify(overrides)}`,
  ]);
  try {
    const wait = sh(
      [
        "kubectl", "--context", KCTX, "-n", ns, "wait", `pod/${pod}`,
        "--for=jsonpath={.status.phase}=Succeeded", "--timeout=120s",
      ],
      { allowFail: true, quiet: true },
    );
    if (!wait.includes("condition met")) {
      // Pending RWO attach, image pull failure, bad override - a HARNESS
      // problem, never "no artifact".
      const phase = kubectl(
        ["-n", ns, "get", "pod", pod, "-o", "jsonpath={.status.phase}"],
        { allowFail: true, quiet: true },
      ).trim();
      throw new CliError(
        `inspector pod for ${routine.name} never succeeded (phase: ${phase || "unknown"}) - ` +
          "cannot inspect the sink; this is an inspection failure, not an empty sink",
      );
    }
    const logs = kubectl(["-n", ns, "logs", pod], { quiet: true });
    return parseInspector(logs);
  } finally {
    kubectl(["-n", ns, "delete", "pod", pod, "--wait=false"], { allowFail: true, quiet: true });
  }
}

// ---------------------------------------------------------------------------
// Export and restore (ADR-47). Export copies the newest artifact OFF the
// cluster - load-bearing before any destroy, because `hg reset` deletes
// the sink PVC with the namespace. Restore is the inverse of the routine:
// quiesce the writer, wipe the volume, untar, resume. It never merges: a
// restore onto existing data would interleave two generations, so the
// wipe is the contract, not a convenience.

/** One scale-target that mounts PVCs, parsed from `kubectl get sts,deploy -o json`. */
export interface WorkloadClaims {
  kind: "statefulset" | "deployment";
  name: string;
  replicas: number;
  /** Every PVC name this workload's pods would mount. */
  claims: string[];
}

/** Parse `kubectl get statefulsets,deployments -o json` into scale targets.
 * StatefulSet claims include the volumeClaimTemplate-generated names
 * (`<template>-<sts>-<ordinal>`) for every ordinal up to replicas. */
export function parseWorkloadClaims(kubectlJson: string): WorkloadClaims[] {
  const doc = JSON.parse(kubectlJson) as {
    items?: {
      kind?: string;
      metadata?: { name?: string };
      spec?: {
        replicas?: number;
        volumeClaimTemplates?: { metadata?: { name?: string } }[];
        template?: {
          spec?: {
            volumes?: { persistentVolumeClaim?: { claimName?: string } }[];
          };
        };
      };
    }[];
  };
  return (doc.items ?? []).flatMap((item): WorkloadClaims[] => {
    const kind = (item.kind ?? "").toLowerCase();
    if (kind !== "statefulset" && kind !== "deployment") return [];
    const name = item.metadata?.name ?? "";
    const replicas = item.spec?.replicas ?? 0;
    const claims = (item.spec?.template?.spec?.volumes ?? [])
      .map((v) => v.persistentVolumeClaim?.claimName)
      .filter((c): c is string => Boolean(c));
    if (kind === "statefulset") {
      for (const vct of item.spec?.volumeClaimTemplates ?? []) {
        const tpl = vct.metadata?.name;
        if (!tpl) continue;
        // Ordinals up to max(replicas, 1): a scaled-to-zero StatefulSet
        // still OWNS its ordinal-0 PVC, and that is the restore case.
        for (let i = 0; i < Math.max(replicas, 1); i++) claims.push(`${tpl}-${name}-${i}`);
      }
    }
    return [{ kind, name, replicas, claims }];
  });
}

/** The workloads that must be quiesced before writing into `pvc`. */
export function writersOf(workloads: WorkloadClaims[], pvc: string): WorkloadClaims[] {
  return workloads.filter((w) => w.claims.includes(pvc));
}

/** Argo CD selfHeal reverts a scale-to-zero within seconds (the drift suite
 * asserts that as a PASS), so a restore must pause auto-sync on the owning
 * Application first. Returns the prior `automated` policy JSON to hand back
 * to resumeAutoSync, or null when no Application owns the namespace or
 * auto-sync was already off. */
export function pauseAutoSync(ns: string): { app: string; automated: string }[] | null {
  const out = kubectl(["-n", "argocd", "get", "applications.argoproj.io", "-o", "json"], {
    allowFail: true,
    quiet: true,
  });
  if (!out.trim()) return null;
  let apps: {
    metadata?: { name?: string };
    spec?: { destination?: { namespace?: string }; syncPolicy?: { automated?: unknown } };
  }[];
  try {
    apps = (JSON.parse(out) as { items?: typeof apps }).items ?? [];
  } catch {
    return null;
  }
  // EVERY Application targeting this namespace, not the first one found.
  // A profile's namespace holds its own Application AND one per
  // spec.apps[] entry, and each carries its own selfHeal. Pausing only
  // the profile's left postiz's child Application quietly restoring
  // `replicas: 1` under the quiesce - the restore scaled the deployment
  // to zero, Argo put it straight back, and the poll timed out after
  // 300s reporting a pod that "still mounts" a volume it had just been
  // told to release. Found by the recovery rehearsal.
  const owners = apps.filter(
    (a) =>
      a.spec?.destination?.namespace === ns &&
      a.metadata?.name &&
      a.spec?.syncPolicy?.automated !== undefined,
  );
  if (owners.length === 0) return null;
  const paused: { app: string; automated: string }[] = [];
  for (const owner of owners) {
    const name = owner.metadata!.name!;
    log(`pausing Argo auto-sync on application ${name} (selfHeal would fight the quiesce)`);
    kubectl(
      [
        "-n", "argocd", "patch", "applications.argoproj.io", name, "--type=merge",
        "-p", JSON.stringify({ spec: { syncPolicy: { automated: null } } }),
      ],
      { quiet: true },
    );
    paused.push({ app: name, automated: JSON.stringify(owner.spec!.syncPolicy!.automated) });
  }
  return paused;
}

export function resumeAutoSync(paused: { app: string; automated: string }[]): void {
  for (const entry of paused) resumeOne(entry);
}

function resumeOne(paused: { app: string; automated: string }): void {
  log(`resuming Argo auto-sync on application ${paused.app}`);
  kubectl(
    [
      "-n", "argocd", "patch", "applications.argoproj.io", paused.app, "--type=merge",
      "-p", JSON.stringify({ spec: { syncPolicy: { automated: JSON.parse(paused.automated) } } }),
    ],
    { allowFail: true, quiet: true },
  );
}

const NEWEST_CMD =
  "ls -1t /backups 2>/dev/null | grep -vE '^(lost\\+found|.*\\.tmp|.*\\.lock)$' | head -1";

/** Start a sleeping pod mounting `pvc`, run `body`, always clean up. */
function withPvcPod<T>(
  ns: string,
  prefix: string,
  volumes: { name: string; mountPath: string; pvc?: string; readOnly?: boolean }[],
  body: (pod: string) => T,
): T {
  const pod = `${prefix}-${Date.now().toString(36)}`;
  const overrides = {
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "work",
          image: "busybox:1.37",
          command: ["sleep", "1800"],
          volumeMounts: volumes.map((v) => ({
            name: v.name,
            mountPath: v.mountPath,
            ...(v.readOnly ? { readOnly: true } : {}),
          })),
        },
      ],
      volumes: volumes.map((v) =>
        v.pvc
          ? {
              name: v.name,
              persistentVolumeClaim: { claimName: v.pvc, ...(v.readOnly ? { readOnly: true } : {}) },
            }
          : { name: v.name, emptyDir: {} },
      ),
    },
  };
  kubectl([
    "-n", ns, "run", pod,
    "--image=busybox:1.37", "--restart=Never",
    `--overrides=${JSON.stringify(overrides)}`,
  ]);
  try {
    const wait = sh(
      [
        "kubectl", "--context", KCTX, "-n", ns, "wait", `pod/${pod}`,
        "--for=condition=Ready", "--timeout=120s",
      ],
      { allowFail: true, quiet: true },
    );
    if (!wait.includes("condition met")) {
      const phase = kubectl(
        ["-n", ns, "get", "pod", pod, "-o", "jsonpath={.status.phase}"],
        { allowFail: true, quiet: true },
      ).trim();
      throw new CliError(
        `${prefix} pod never became Ready (phase: ${phase || "unknown"}) - ` +
          "likely a pending RWO attach; is the volume's writer still running?",
      );
    }
    return body(pod);
  } finally {
    kubectl(["-n", ns, "delete", "pod", pod, "--wait=false"], { allowFail: true, quiet: true });
  }
}

export interface ExportReport {
  routine: string;
  artifact: string;
  file: string;
  sizeKB: number;
  sha256: string;
}

/** Copy the newest artifact in the routine's sink to `destDir`, checksummed
 * on both sides - a truncated `kubectl cp` must never read as an export. */
export function exportArtifact(
  ctx: ProfileCtx,
  routine: BackupRoutine,
  destDir: string,
): ExportReport {
  if (!routine.sinkPvc) {
    throw new CliError(`routine ${routine.name} has no sink PVC - nothing to export`);
  }
  const ns = backupNsOf(ctx);
  fs.mkdirSync(destDir, { recursive: true });
  return withPvcPod(
    ns,
    "hg-backup-export",
    [{ name: "backups", mountPath: "/backups", pvc: routine.sinkPvc, readOnly: true }],
    (pod) => {
      const newest = kubectl(["-n", ns, "exec", pod, "--", "sh", "-c", NEWEST_CMD], {
        quiet: true,
      }).trim();
      if (!newest) {
        throw new CliError(`routine ${routine.name}: sink ${routine.sinkPvc} holds no artifact`);
      }
      // Some routines write a DIRECTORY per run rather than one tarball
      // (postiz's dump + uploads layout is the reference). `hg backup
      // verify` already knows both shapes; export did not, and failed
      // with `sha256sum: Is a directory` the first time postiz actually
      // deployed. One artifact must be one FILE downstream - checksum,
      // upload and restore all assume it - so a directory is tarred in
      // the pod before it leaves.
      const isDir =
        kubectl(
          ["-n", ns, "exec", pod, "--", "sh", "-c", `[ -d /backups/${newest} ] && echo dir || echo file`],
          { quiet: true },
        ).trim() === "dir";
      let remoteName = newest;
      if (isDir) {
        remoteName = `${newest}.tar.gz`;
        // Into /tmp, not the sink: the sink is mounted read-only here,
        // and writing to it would also make the export change what the
        // next export finds.
        kubectl(
          ["-n", ns, "exec", pod, "--", "sh", "-c",
            `tar czf /tmp/${remoteName} -C /backups/${newest} .`],
          { quiet: true },
        );
      }
      const remotePath = isDir ? `/tmp/${remoteName}` : `/backups/${remoteName}`;
      const remoteSum = kubectl(
        ["-n", ns, "exec", pod, "--", "sha256sum", remotePath],
        { quiet: true },
      )
        .trim()
        .split(/\s+/)[0]!;
      const file = path.join(destDir, remoteName);
      kubectl(["cp", `${ns}/${pod}:${remotePath}`, file, "--retries=3"], { quiet: true });
      const localSum = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (localSum !== remoteSum) {
        fs.rmSync(file, { force: true });
        throw new CliError(
          `export of ${newest} is corrupt: sha256 ${localSum} != in-cluster ${remoteSum}`,
        );
      }
      const sizeKB = Math.round(fs.statSync(file).size / 1024);
      return { routine: routine.name, artifact: remoteName, file, sizeKB, sha256: localSum };
    },
  );
}

export interface RestoreReport {
  routine: string;
  targetPvc: string;
  archive: string;
  scaled: { kind: string; name: string; replicas: number }[];
  fileCount: number;
}

/** Restore `archivePath` into the routine's data PVC: scale writers to
 * zero, wipe, untar, scale back, wait ready. Fails loudly at every stage -
 * a half-restored volume re-runs the whole restore (ADR-47). */
export function restoreArtifact(
  ctx: ProfileCtx,
  routine: BackupRoutine,
  archivePath: string,
  timeoutSec: number,
): RestoreReport {
  if (!routine.dataPvc) {
    throw new CliError(
      `routine ${routine.name} names no data PVC (no non-"backups" PVC volume) - ` +
        "hg cannot know the restore target; app-specific dumps need their own restore hook",
    );
  }
  if (!fs.existsSync(archivePath)) throw new CliError(`no such archive: ${archivePath}`);
  const ns = backupNsOf(ctx);

  const workloads = parseWorkloadClaims(
    kubectl(["-n", ns, "get", "statefulsets,deployments", "-o", "json"], { quiet: true }),
  );
  const writers = writersOf(workloads, routine.dataPvc);
  const scaled = writers.map((w) => ({ kind: w.kind, name: w.name, replicas: w.replicas }));

  const paused = pauseAutoSync(ns);
  try {
    // Quiesce: scale every writer to zero and wait until no pod mounts the
    // target. Writing under a live writer is the one unforgivable restore.
    for (const w of writers) {
      log(`scaling ${w.kind}/${w.name} to 0 (was ${w.replicas})`);
      kubectl(["-n", ns, "scale", `${w.kind}/${w.name}`, "--replicas=0"], { quiet: true });
    }
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      const pods = kubectl(["-n", ns, "get", "pods", "-o", "json"], { quiet: true });
      const mounted = mountingPods(pods, routine.dataPvc).length > 0;
      if (!mounted) break;
      if (Date.now() > deadline) {
        const holders = mountingPods(
          kubectl(["-n", ns, "get", "pods", "-o", "json"], { quiet: true }),
          routine.dataPvc,
        );
        throw new CliError(
          `pods still mount ${routine.dataPvc} after ${timeoutSec}s - refusing to restore ` +
            `under a live writer (holding: ${holders.join(", ") || "unknown"})`,
        );
      }
      sh(["sleep", "2"], { quiet: true });
    }
    const fileCount = withPvcPod(
      ns,
      "hg-backup-restore",
      [
        // ponytail: pod runs as root so the wipe and ownership-preserving
        // untar just work; a PSP/PSS-restricted cluster needs a uid-10000
        // variant with fsGroup.
        { name: "data", mountPath: "/data", pvc: routine.dataPvc },
        { name: "staging", mountPath: "/staging" },
      ],
      (pod) => {
        log(`copying ${path.basename(archivePath)} into the restore pod`);
        kubectl(["cp", archivePath, `${ns}/${pod}:/staging/restore.tar.gz`, "--retries=3"], {
          quiet: true,
        });
        const remoteSum = kubectl(
          ["-n", ns, "exec", pod, "--", "sha256sum", "/staging/restore.tar.gz"],
          { quiet: true },
        )
          .trim()
          .split(/\s+/)[0]!;
        const localSum = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
        if (remoteSum !== localSum) {
          throw new CliError(`staged archive is corrupt: ${remoteSum} != local ${localSum}`);
        }
        log(`restoring into ${routine.dataPvc} (wipe + untar)`);
        // The snapshot marker is verify evidence, never application data
        // (#436, Codex catch): restored into /data it would ride a LATER
        // hot-copy archive and launder BKUP006/consistencyOf into
        // claiming a snapshot that never ran. Excluded here so the
        // volume never contains one.
        const out = kubectl(
          [
            "-n", ns, "exec", pod, "--", "sh", "-c",
            "set -eu; find /data -mindepth 1 -delete; " +
              "tar xzf /staging/restore.tar.gz -C /data --exclude='./.hermes-db-snapshot.json'; " +
              "echo HG_RESTORE_OK $(find /data | wc -l)",
          ],
          { quiet: true },
        );
        const okLine = out.split("\n").find((l) => l.trim().startsWith("HG_RESTORE_OK"));
        if (!okLine) {
          throw new CliError(`restore did not complete: ${out.trim().slice(0, 300)}`);
        }
        return Number(okLine.trim().split(/\s+/)[1] ?? 0);
      },
    );
    return { routine: routine.name, targetPvc: routine.dataPvc, archive: archivePath, scaled, fileCount };
  } finally {
    // Resume the writers whatever happened - a failed restore with the
    // agent left at 0 replicas would turn one incident into two.
    for (const w of writers) {
      log(`scaling ${w.kind}/${w.name} back to ${w.replicas}`);
      kubectl(["-n", ns, "scale", `${w.kind}/${w.name}`, `--replicas=${w.replicas}`], {
        allowFail: true,
        quiet: true,
      });
    }
    if (paused) resumeAutoSync(paused);
    for (const w of writers.filter((w) => w.replicas > 0)) {
      const rollout = sh(
        [
          "kubectl", "--context", KCTX, "-n", ns, "rollout", "status",
          `${w.kind}/${w.name}`, `--timeout=${timeoutSec}s`,
        ],
        { allowFail: true, quiet: true },
      );
      if (rollout.includes("successfully rolled out") || rollout.includes("roll out complete")) {
        log(`${w.kind}/${w.name} is back`);
      } else {
        console.error(`  ! ${w.kind}/${w.name} has not finished rolling out - check it`);
      }
    }
  }
}

/** Restore through the routine's declared hook: stage the archive into a
 * live pod and run the app's own command.
 *
 * Deliberately NOT the volume sequence. A database dump has to go into a
 * running database, so wiping the PVC and untarring over it would destroy
 * exactly the thing that has to accept the restore. The app owns the
 * command because only the app knows it; `hg` owns the staging, the
 * checksum, the quiesce and the reporting. */
export function restoreViaHook(
  ctx: ProfileCtx,
  routine: BackupRoutine,
  archivePath: string,
): RestoreReport {
  const hook = routine.restoreHook!;
  if (!fs.existsSync(archivePath)) throw new CliError(`no such archive: ${archivePath}`);
  const ns = backupNsOf(ctx);

  const workloads = parseWorkloadClaims(
    kubectl(["-n", ns, "get", "statefulsets,deployments", "-o", "json"], { quiet: true }),
  );
  const byRef = new Map(workloads.map((w) => [`${w.kind.toLowerCase()}/${w.name}`, w]));
  const target = byRef.get(hook.workload.toLowerCase());
  if (!target) {
    throw new CliError(
      `restore hook names ${hook.workload}, which does not exist in ${ns} ` +
        `(present: ${[...byRef.keys()].join(", ") || "nothing"})`,
    );
  }
  const quiesced = hook.quiesce
    .map((ref) => byRef.get(ref.toLowerCase()))
    .filter((w): w is (typeof workloads)[number] => Boolean(w));
  const scaled = quiesced.map((w) => ({ kind: w.kind, name: w.name, replicas: w.replicas }));

  const paused = pauseAutoSync(ns);
  try {
    for (const w of quiesced) {
      log(`scaling ${w.kind}/${w.name} to 0 (was ${w.replicas})`);
      kubectl(["-n", ns, "scale", `${w.kind}/${w.name}`, "--replicas=0"], { quiet: true });
    }
    // The hook target must stay UP - that is the whole difference from
    // the volume path - so we exec into its running pod rather than
    // starting one of our own.
    const pod = kubectl(
      ["-n", ns, "get", "pods", "-l", `app.kubernetes.io/name=${target.name}`,
        "-o", "jsonpath={.items[0].metadata.name}"],
      { allowFail: true, quiet: true },
    ).trim() ||
      kubectl(
        ["-n", ns, "get", "pods", "-o",
          `jsonpath={.items[?(@.metadata.ownerReferences[0].name=='${target.name}')].metadata.name}`],
        { allowFail: true, quiet: true },
      ).trim().split(/\s+/)[0];
    if (!pod) {
      throw new CliError(`no running pod found for ${hook.workload} in ${ns} - it must be up to accept a restore`);
    }
    const exec = (args: string[], opts = {}) =>
      kubectl(["-n", ns, "exec", pod, ...(hook.container ? ["-c", hook.container] : []), "--", ...args], {
        quiet: true,
        ...opts,
      });

    log(`staging ${path.basename(archivePath)} into ${pod}:${hook.stagePath}`);
    kubectl(
      ["cp", archivePath, `${ns}/${pod}:${hook.stagePath}`, "--retries=3",
        ...(hook.container ? ["-c", hook.container] : [])],
      { quiet: true },
    );
    const remoteSum = exec(["sha256sum", hook.stagePath]).trim().split(/\s+/)[0]!;
    const localSum = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    if (remoteSum !== localSum) {
      throw new CliError(`staged archive is corrupt: ${remoteSum} != local ${localSum}`);
    }
    log(`running the app's restore hook in ${hook.workload}`);
    // ponytail: no timeout - `sh` has no timeout option, and a restore is
    // exactly the operation you least want killed halfway. Add one to
    // ShOptions if a hung hook ever actually strands an operator.
    exec(hook.command);
    // Best-effort: a dump left in a live pod is a copy of the data
    // sitting somewhere nobody is tracking.
    exec(["rm", "-f", hook.stagePath], { allowFail: true });
    return {
      routine: routine.name,
      targetPvc: hook.workload,
      archive: archivePath,
      scaled,
      fileCount: -1, // ponytail: only the app knows what it restored.
    };
  } finally {
    for (const w of quiesced) {
      log(`scaling ${w.kind}/${w.name} back to ${w.replicas}`);
      kubectl(["-n", ns, "scale", `${w.kind}/${w.name}`, `--replicas=${w.replicas}`], {
        allowFail: true,
        quiet: true,
      });
    }
    if (paused) resumeAutoSync(paused);
  }
}

// ---------------------------------------------------------------------------
// The three sub-verbs' data assembly (rendering stays in main.ts).

export interface ProfileBackupStatus {
  profile: string;
  declaresBackup: boolean;
  routines: (BackupRoutine & { artifact?: ArtifactReport | null })[];
  findings: RoutineFinding[];
}

export function backupStatus(ctx: ProfileCtx, withArtifacts: boolean): ProfileBackupStatus {
  const declared = declaresBackup(ctx.dir);
  const routines = discoverRoutines(ctx);
  const findings = reconcile(ctx.name, declared, routines);
  const enriched = routines.map((r) => {
    if (!withArtifacts || !r.sinkPvc) return r;
    log(`inspecting sink of ${r.name} (${r.sinkPvc})`);
    return { ...r, artifact: inspectSink(ctx, r) };
  });
  return { profile: ctx.name, declaresBackup: declared, routines: enriched, findings };
}

/** Verify adds artifact-level findings to the reconciliation. The bar:
 * every DECLARED pattern must be REPORTED found - a pattern the inspector
 * never reported on is a failure, not a skip, and a routine declaring no
 * patterns cannot be verified at all (an artifact whose contents nobody
 * specified proves nothing). */
export function verifyFindings(status: ProfileBackupStatus): RoutineFinding[] {
  const findings = [...status.findings];
  for (const r of status.routines) {
    // Restorability first, and independent of whether an artifact exists:
    // a routine producing perfect archives that nothing can put back is
    // not a backup, it is a collection of files (#282).
    if (r.restoreHookError) {
      findings.push({
        profile: status.profile,
        severity: "error",
        message: `routine ${r.name}: ${r.restoreHookError} - the declared restore path is unusable`,
        id: "BKUP007",
      });
    } else if (restoreShapeOf(r) === "unsupported") {
      findings.push({
        profile: status.profile,
        severity: "error",
        message:
          `routine ${r.name}: no data PVC and no ${RESTORE_HOOK_ANNOTATION} - its artifact ` +
          "cannot be restored by anything hg knows about",
        id: "BKUP007",
      });
    }
    if (!("artifact" in r)) continue;
    if (r.artifact === null || r.artifact === undefined) {
      findings.push({
        profile: status.profile,
        severity: "error",
        message: `routine ${r.name}: sink ${r.sinkPvc} holds NO artifact - nothing has ever been backed up`,
        id: "BKUP005",
      });
      continue;
    }
    if (r.artifact.sizeKB === 0) {
      findings.push({
        profile: status.profile,
        severity: "error",
        message: `routine ${r.name}: newest artifact ${r.artifact.name} is empty`,
        id: "BKUP005",
      });
    }
    if ((r.artifact.dbSidecars ?? []).length > 0) {
      findings.push({
        profile: status.profile,
        severity: "error",
        message:
          `routine ${r.name}: artifact ${r.artifact.name} contains live sqlite sidecar ` +
          `file(s) (${(r.artifact.dbSidecars ?? []).join(", ")}) - the db was copied hot and a ` +
          "restore can tear on its next open (#436); the routine's snapshot step was skipped",
        id: "BKUP008",
      });
    }
    if (r.protects.length === 0) {
      findings.push({
        profile: status.profile,
        severity: "error",
        message:
          `routine ${r.name}: no ${PROTECTS_ANNOTATION} annotation - an artifact whose ` +
          "required contents nobody declared cannot be verified",
        id: "BKUP004",
      });
      continue;
    }
    const reported = new Map(r.artifact.protects.map((p) => [p.pattern, p.found]));
    for (const pattern of r.protects) {
      const found = reported.get(pattern);
      if (found === undefined) {
        findings.push({
          profile: status.profile,
          severity: "error",
          message:
            `routine ${r.name}: declared pattern ${JSON.stringify(pattern)} was never ` +
            "reported by the inspector - incomplete inspection, not a pass",
          id: "BKUP006",
        });
      } else if (!found) {
        findings.push({
          profile: status.profile,
          severity: "error",
          message:
            `routine ${r.name}: artifact ${r.artifact.name} does NOT contain ` +
            `${JSON.stringify(pattern)} - the backup runs green but does not ` +
            "protect what it claims to",
          id: "BKUP006",
        });
      }
    }
  }
  return findings;
}

export function renderStatusLine(r: BackupRoutine & { artifact?: ArtifactReport | null }): string {
  const parts = [
    `${r.name}  schedule=${JSON.stringify(r.schedule)}${r.suspend ? "  SUSPENDED" : ""}`,
  ];
  if (r.lastSuccessfulTime) {
    const age = (Date.now() - Date.parse(r.lastSuccessfulTime)) / 1000;
    parts.push(`last success ${fmtAge(age)} ago`);
  } else {
    parts.push("never succeeded");
  }
  if (r.artifact) {
    parts.push(
      `newest artifact ${r.artifact.name} (${r.artifact.sizeKB}KB, ` +
        `${fmtAge(r.artifact.ageSeconds)} old, ${r.artifact.count} kept)`,
    );
  } else if (r.artifact === null) {
    parts.push("NO ARTIFACT in sink");
  }
  if (r.protects.length > 0) parts.push(`protects: ${r.protects.join(", ")}`);
  return parts.join("  |  ");
}

// ---------------------------------------------------------------------------
// The acceptance envelope (#282, design 16). `hg backup verify --json`
// speaks the same ProofResult shape `hg platform backup prove` does, so
// the launch gate (#285) can aggregate it instead of parsing prose.
//
// One finding per CHECK, not per message: a profile with three suspended
// routines is one failed check carrying three reasons. That is what makes
// the id stable enough to be worth having.

/** Group findings into the fixed check matrix. A check with no findings
 * PASSES, which is only honest because the checks are evaluated over
 * discovered routines - a profile with no routines at all reports
 * BKUP001, and everything downstream of it is vacuously true. */
export function backupProof(
  statuses: ProfileBackupStatus[],
  startedAt: string,
  finishedAt: string,
): {
  apiVersion: "cli.hermes.dev/v1alpha1";
  kind: "ProofResult";
  command: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  findings: { id: string; status: "pass" | "fail"; component: string; message: string }[];
  summary: { pass: number; fail: number; unknown: number };
} {
  const byCheck = new Map<BackupCheckId, RoutineFinding[]>();
  for (const status of statuses) {
    for (const f of verifyFindings(status)) {
      if (f.severity !== "error") continue; // warnings inform, they do not gate
      byCheck.set(f.id, [...(byCheck.get(f.id) ?? []), f]);
    }
  }
  const ids = Object.keys(BACKUP_CHECKS) as BackupCheckId[];
  const findings = ids.map((id) => {
    const hits = byCheck.get(id) ?? [];
    return hits.length === 0
      ? { id, status: "pass" as const, component: "backup", message: BACKUP_CHECKS[id] }
      : {
          id,
          status: "fail" as const,
          component: [...new Set(hits.map((h) => h.profile))].join(","),
          message: hits.map((h) => h.message).join("; "),
        };
  });
  const fail = findings.filter((f) => f.status === "fail").length;
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "backup-verify",
    startedAt,
    finishedAt,
    ok: fail === 0,
    findings,
    summary: { pass: findings.length - fail, fail, unknown: 0 },
  };
}
