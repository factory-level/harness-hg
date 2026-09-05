// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as path from "node:path";
import { emitLifecycleEvent } from "../communication/lifecycle-events.ts";
import { CliError, HG_HOME, jsonOut, loadState, log, ok, warn } from "../lib.ts";
import { envTargets } from "../local/shared.ts";
import { ensureGcsEmulator, fetchBackup, listBackupIds, putVerification, sinkFromUrl } from "./gcs-sink.ts";
import { PlatformManifest, createPlatformBackup, proveRecovery, readManifest, restorePlatformBackup, uploadPlatformBackup } from "./platform.ts";
import { DEFAULT_TIMERS, installBackupTimers, newestBackup } from "./timers.ts";

// ---------------------------------------------------------------------------
// platform - environment-level backup/restore/proof over every component
// (design 13). `backup` scaffolds a directory; `restore` replays it onto a
// re-bootstrapped cluster; `backup prove` emits the design-16 ProofResult.

export async function cmdPlatform(
  json: boolean,
  args: string[],
  toDir: string | undefined,
  fromDir: string | undefined,
  timeoutSec: number,
  timers: { backupSchedule?: string; verifySchedule?: string; enable: boolean; sink?: string },
): Promise<void> {
  const state = loadState();
  // No state.ports gate: a destination server never ran `hg up` (its
  // control plane is Pulumi's), yet it backs up, fetches and restores.
  // Only the emulated sink needs the loop - guarded where it is built.
  const ctxs = envTargets(state, undefined, "platform");
  const [sub, subArg] = args;
  switch (sub) {
    case "backup": {
      if (subArg === "prove") {
        // The documented two-word form; shares the prove path below.
        args = [subArg];
        return cmdPlatform(json, args, toDir, fromDir, timeoutSec, timers);
      }
      if (subArg !== "create") {
        throw new CliError("usage: hermes-gitops platform backup create --to <dir> [--json]");
      }
      if (!toDir) throw new CliError("platform backup create needs --to <dir>");
      await emitLifecycleEvent({ kind: "backup", phase: "started", environment: "", facts: { destination: timers.sink ?? "local" } });
      let created: { dir: string; manifest: PlatformManifest };
      try {
        created = createPlatformBackup(ctxs, toDir, timeoutSec, state.profileDir);
      } catch (err) {
        const msg = err instanceof CliError ? err.message.slice(0, 200) : "unexpected error";
        await emitLifecycleEvent({ kind: "backup", phase: "failed", environment: "", facts: { error: msg } });
        throw err;
      }
      const { dir, manifest } = created;
      // A cloud sink is an UPLOAD of the scaffold, not a replacement for
      // it: the local directory stays the working set, and the objects
      // are what survives the loss of this host. `--sink gs://...`
      // selects a real bucket (#297); `--sink emulated` runs the loop's
      // fake-gcs-server, which reports `gcs-emulated` everywhere so it
      // can never read as off-site durability.
      const sinkFlag = timers.sink;
      if (sinkFlag) {
        // Uploads impersonate the WRITER (#297) when the split is
        // configured - create-only, so a finished backup cannot be
        // overwritten by the identity that made it.
        const sink = sinkFlag === "emulated"
          ? ensureGcsEmulator(state)
          : { ...sinkFromUrl(sinkFlag), impersonate: process.env["HG_BACKUP_WRITER_SA"] };
        uploadPlatformBackup(sink, dir, manifest);
      }
      const vols = manifest.components.filter((c) => c.kind !== "declarative").length;
      ok(
        `platform backup ${manifest.backupId}: ${manifest.components.length} component(s), ` +
          `${vols} archived, state=${manifest.verification.state} -> ${dir}`,
      );
      await emitLifecycleEvent({
        kind: "backup", phase: "completed", environment: "",
        facts: {
          backupId: manifest.backupId,
          components: String(manifest.components.length),
          state: manifest.verification.state,
          destination: timers.sink ?? "local",
          ...(manifest.encryption ? { encryption: manifest.encryption.mode } : {}),
        },
      });
      if (json) jsonOut({ command: "platform-backup-create", ok: true, dir, manifest });
      return;
    }
    case "fetch": {
      // Rehydrate from the SINK into a local scaffold, which is what a
      // clean server has to do first: it has a bucket and no directory.
      // Fetches impersonate the READER (#297): the proof that a restore
      // needs nothing the origin server's writer identity had.
      const sink = timers.sink === "emulated" || !timers.sink
        ? ensureGcsEmulator(state)
        : { ...sinkFromUrl(timers.sink), impersonate: process.env["HG_RESTORE_READER_SA"] };
      const ids = listBackupIds(sink);
      if (ids.length === 0) throw new CliError(`no backups under gs://${sink.bucket}`);
      // Explicit selection, defaulting to newest. Design 13 asks for an
      // explicit generation; defaulting to "latest" silently is how a
      // recovery restores something nobody chose.
      const wanted = subArg && subArg !== "latest" ? subArg : ids[ids.length - 1]!;
      if (!ids.includes(wanted)) {
        throw new CliError(`backup ${wanted} is not in the sink (have: ${ids.join(", ")})`);
      }
      const dest = toDir ?? path.join(HG_HOME, "platform-backups");
      const dir = fetchBackup(sink, wanted, dest);
      ok(`fetched ${wanted} from ${sink.bucket} -> ${dir}`);
      if (json) jsonOut({ command: "platform-fetch", ok: true, backupId: wanted, dir, available: ids });
      return;
    }
    case "restore": {
      if (!fromDir) throw new CliError("platform restore needs --from <backup-dir>");
      await emitLifecycleEvent({ kind: "restore", phase: "started", environment: "", facts: { backup: path.basename(fromDir) } });
      const results = restorePlatformBackup(ctxs, fromDir, timeoutSec);
      for (const r of results) {
        if (r.status === "failed") console.error(`  ✗ ${r.component}: ${r.message}`);
        else log(`  ${r.component}: ${r.message}`);
      }
      const failed = results.filter((r) => r.status === "failed");
      if (failed.length === 0) ok(`platform restore complete: ${results.length} component(s)`);
      await emitLifecycleEvent({
        kind: "restore", phase: failed.length === 0 ? "completed" : "failed", environment: "",
        facts: { backup: path.basename(fromDir), components: String(results.length), failed: String(failed.length) },
      });
      if (json) jsonOut({ command: "platform-restore", ok: failed.length === 0, results });
      if (failed.length > 0) throw new CliError(`platform restore: ${failed.length} component(s) failed`);
      return;
    }
    case "evidence": {
      if (!toDir) throw new CliError("platform evidence needs --to <dir>");
      const { cmdEvidence } = await import("./evidence.ts");
      cmdEvidence(json, {
        toDir,
        ...(fromDir ? { backupDir: fromDir } : {}),
        ...(timers.sink && timers.sink !== "emulated" ? { sinkUrl: timers.sink } : {}),
      });
      return;
    }
    case "install-timer": {
      installBackupTimers(
        {
          destination: toDir ?? path.join(HG_HOME, "platform-backups"),
          backupSchedule: timers.backupSchedule ?? DEFAULT_TIMERS.backupSchedule,
          verifySchedule: timers.verifySchedule ?? DEFAULT_TIMERS.verifySchedule,
          ...(timers.sink ? { sink: timers.sink } : {}),
          ...(process.env["HG_BACKUP_WRITER_SA"] ? { writerSa: process.env["HG_BACKUP_WRITER_SA"] } : {}),
          ...(process.env["HG_RESTORE_READER_SA"] ? { readerSa: process.env["HG_RESTORE_READER_SA"] } : {}),
        },
        { enable: timers.enable },
      );
      return;
    }
    case "verify-restore": {
      // The scheduled half of ADR-52: restore the NEWEST backup and prove
      // it. Without something doing this on a timer, `restorable` is a
      // state a fleet reaches once by hand and then drifts away from,
      // while every surface keeps showing the last verification it did.
      //
      // With a sink, "it" means THE SINK'S COPY: the backup is fetched
      // with the READER identity and that fetch is restored - otherwise
      // a local scaffold could pass while the objects the destroy gate
      // trusts are unfetchable or undecryptable by the identity a clean
      // server would use. The gate must never be marked by anything the
      // sink round-trip did not actually exercise.
      const root = fromDir ?? path.join(HG_HOME, "platform-backups");
      const newestLocal = newestBackup(root);
      if (!newestLocal) throw new CliError(`no scaffolded backup under ${root} to verify`);
      let newest = newestLocal;
      if (timers.sink) {
        const readerSink = timers.sink === "emulated"
          ? ensureGcsEmulator(state)
          : { ...sinkFromUrl(timers.sink), impersonate: process.env["HG_RESTORE_READER_SA"] };
        const backupId = path.basename(newestLocal);
        log(`fetching ${backupId} from the sink with the reader identity`);
        // Outside newestBackup's hg-* glob so a fetched copy never
        // shadows the real scaffolds.
        newest = fetchBackup(readerSink, backupId, path.join(root, ".verify-from-sink"));
      }
      log(`verifying ${path.basename(newest)} by restoring it`);
      restorePlatformBackup(ctxs, newest, timeoutSec);
      const proof = proveRecovery(ctxs, newest);
      if (json) {
        jsonOut(proof);
      } else {
        for (const f of proof.findings) {
          const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
          console.log(`  ${mark} [${f.id}] ${f.component}: ${f.message}`);
        }
      }
      if (!proof.ok) {
        await emitLifecycleEvent({
          kind: "backup", phase: "failed", environment: "",
          facts: { backup: path.basename(newest), stage: "verification", failed: String(proof.summary.fail) },
        });
        throw new CliError(`verify-restore: ${proof.summary.fail} finding(s) failed`);
      }
      ok(`${path.basename(newest)} is restorable`);
      await emitLifecycleEvent({
        kind: "backup", phase: "completed", environment: "",
        facts: { backup: path.basename(newest), state: "restorable" },
      });
      // The sink's manifest froze at `available` and the writer identity
      // cannot overwrite it (create-only, by design) - so the proof lands
      // as an append-only verification object a fetch merges back.
      if (timers.sink) {
        const sink = timers.sink === "emulated"
          ? ensureGcsEmulator(state)
          : { ...sinkFromUrl(timers.sink), impersonate: process.env["HG_BACKUP_WRITER_SA"] };
        putVerification(sink, path.basename(newest), readManifest(newest).verification);
        ok(`verification recorded in the sink for ${path.basename(newest)}`);
      }
      return;
    }
    case "prove": {
      if (!fromDir) throw new CliError("platform backup prove needs --from <backup-dir>");
      const proof = proveRecovery(ctxs, fromDir);
      if (json) {
        jsonOut(proof);
      } else {
        for (const f of proof.findings) {
          const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
          console.log(`  ${mark} [${f.id}] ${f.component}: ${f.message}`);
        }
        log(`platform backup prove: ${proof.summary.pass} pass, ${proof.summary.fail} fail, ${proof.summary.unknown} unknown`);
      }
      if (!proof.ok) throw new CliError("platform backup prove: mandatory failures");
      return;
    }
    default:
      throw new CliError(
        `unknown platform subcommand ${JSON.stringify(sub)} (backup create|fetch|restore|verify-restore|backup prove|evidence|install-timer)`,
      );
  }
}
