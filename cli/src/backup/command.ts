// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as path from "node:path";
import { CliError, jsonOut, loadState, log, ok } from "../lib.ts";
import { envTargets, soleTarget } from "../local/shared.ts";
import { ProfileBackupStatus, RESTORE_HOOK_ANNOTATION, backupProof, backupStatus, discoverRoutines, exportArtifact, inspectSink, reconcile, renderStatusLine, restoreArtifact, restoreShapeOf, restoreViaHook, runRoutine, verifyFindings } from "./routines.ts";

// ---------------------------------------------------------------------------
// backup - invocation and sight over app-owned backup routines. The
// routine (CronJob labelled hermes.dev/backup-routine) belongs to the
// chart that owns the data; this command owns triggering it and proving
// its artifacts contain what the routine claims to protect (backup.ts).

export function cmdBackup(
  json: boolean,
  args: string[],
  onlyProfile: string | undefined,
  routineFilter: string | undefined,
  withVerify: boolean,
  timeoutSec: number,
  toDir: string | undefined,
  fromFile: string | undefined,
  allowRestoreHook: boolean,
): void {
  const state = loadState();
  if (!state.ports) throw new CliError("platform not up yet - run: hermes-gitops up");
  const [sub] = args;
  const ctxs = envTargets(state, onlyProfile, "backup");

  switch (sub ?? "list") {
    case "list": {
      const profiles = ctxs.map((ctx) => backupStatus(ctx, false));
      const errors = profiles.flatMap((p) => p.findings.filter((f) => f.severity === "error"));
      if (json) {
        jsonOut({ command: "backup-list", ok: errors.length === 0, profiles });
      } else {
        for (const p of profiles) {
          log(`[${p.profile}] ${p.declaresBackup ? "declares spec.backup" : "no spec.backup declared"}, ${p.routines.length} routine(s)`);
          for (const r of p.routines) console.log(`  ${renderStatusLine(r)}`);
          for (const f of p.findings) {
            console.error(`  ${f.severity === "error" ? "✗" : "!"} ${f.message}`);
          }
        }
      }
      if (errors.length > 0) throw new CliError(`backup list: ${errors.length} error(s)`);
      return;
    }
    case "run": {
      const ctx = soleTarget(state, onlyProfile, "backup run");
      const all = discoverRoutines(ctx);
      // Exact name only: a substring match could quietly trigger SEVERAL
      // backup Jobs, racing each other on their sinks.
      const routines = routineFilter ? all.filter((r) => r.name === routineFilter) : all;
      if (routines.length === 0) {
        throw new CliError(
          routineFilter
            ? `--routine ${JSON.stringify(routineFilter)} matches nothing exactly in ${ctx.name} ` +
              `(known: ${all.map((r) => r.name).join(", ") || "none"})`
            : `no backup routines found in ${ctx.name} (CronJobs labelled hermes.dev/backup-routine=true)`,
        );
      }
      const results = routines.map((r) => {
        log(`[${ctx.name}] triggering ${r.name} (Job from CronJob)`);
        const run = runRoutine(ctx, r, timeoutSec);
        if (run.ok) ok(`${r.name}: completed in ${Math.round(run.durationMs / 1000)}s`);
        else console.error(`  ✗ ${r.name}: did not complete\n${run.logTail}`);
        const artifact = run.ok && withVerify ? inspectSink(ctx, r) : undefined;
        if (artifact !== undefined) {
          // Verify against the SAME reconciliation the verify verb uses -
          // a routine with no protects annotation must fail here too, not
          // celebrate an unverifiable artifact.
          const status: ProfileBackupStatus = {
            profile: ctx.name,
            declaresBackup: true,
            routines: [{ ...r, artifact }],
            findings: reconcile(ctx.name, true, [r]),
          };
          const problems = verifyFindings(status);
          // Attribution: the newest artifact must be from THIS run, not a
          // leftover - stale means the run wrote nothing (or elsewhere).
          const maxAge = Math.ceil(run.durationMs / 1000) + 120;
          if (artifact && artifact.ageSeconds > maxAge) {
            problems.push({
              profile: ctx.name,
              severity: "error",
              message:
                `routine ${r.name}: newest artifact ${artifact.name} predates this run ` +
                `(${Math.round(artifact.ageSeconds)}s old) - the run completed but wrote nothing new`,
              id: "BKUP005",
            });
          }
          for (const f of problems) console.error(`  ✗ ${f.message}`);
          if (artifact && problems.length === 0) {
            ok(
              `${r.name}: artifact ${artifact.name} contains ` +
                artifact.protects.map((p) => p.pattern).join(", "),
            );
          }
          return { routine: r.name, ...run, artifact, problems };
        }
        return { routine: r.name, ...run };
      });
      const failed = results.filter(
        (r) => !r.ok || ("problems" in r && (r.problems?.length ?? 0) > 0),
      );
      if (json) {
        jsonOut({ command: "backup-run", profile: ctx.name, ok: failed.length === 0, results });
      }
      if (failed.length > 0) {
        throw new CliError(`backup run: ${failed.length} routine(s) failed`);
      }
      return;
    }
    case "verify": {
      const startedAt = new Date().toISOString();
      const raw = ctxs.map((ctx) => backupStatus(ctx, true));
      const profiles = raw.map((status) => ({ ...status, findings: verifyFindings(status) }));
      const errors = profiles.flatMap((p) => p.findings.filter((f) => f.severity === "error"));
      if (json) {
        // The design-16 envelope with stable BKUP00x ids, so the launch
        // gate aggregates a shape rather than parsing prose. `profiles`
        // rides along for the per-routine detail the envelope flattens.
        jsonOut({ ...backupProof(raw, startedAt, new Date().toISOString()), profiles });
      } else {
        for (const p of profiles) {
          log(`[${p.profile}] ${p.routines.length} routine(s)`);
          for (const r of p.routines) console.log(`  ${renderStatusLine(r)}`);
          for (const f of p.findings) {
            console.error(`  ${f.severity === "error" ? "✗" : "!"} ${f.message}`);
          }
          if (p.findings.length === 0 && p.routines.length > 0) {
            ok(`[${p.profile}] every routine's newest artifact contains what it claims to protect`);
          }
        }
      }
      if (errors.length > 0) throw new CliError(`backup verify: ${errors.length} error(s)`);
      return;
    }
    case "export": {
      // Get the archive OFF the cluster before any destroy: `hg reset`
      // deletes the sink PVC with the namespace, so an unexported backup
      // does not survive the very event it exists for.
      const ctx = soleTarget(state, onlyProfile, "backup export");
      if (!toDir) throw new CliError("backup export needs --to <dir>");
      const all = discoverRoutines(ctx);
      const routines = routineFilter ? all.filter((r) => r.name === routineFilter) : all;
      if (routines.length === 0) {
        throw new CliError(
          routineFilter
            ? `--routine ${JSON.stringify(routineFilter)} matches nothing exactly in ${ctx.name}`
            : `no backup routines found in ${ctx.name}`,
        );
      }
      const exports = routines
        .filter((r) => r.sinkPvc)
        .map((r) => {
          log(`[${ctx.name}] exporting newest artifact of ${r.name}`);
          const report = exportArtifact(ctx, r, toDir);
          ok(`${r.name}: ${report.artifact} -> ${report.file} (${report.sizeKB}KB, sha256 verified)`);
          return report;
        });
      if (exports.length === 0) throw new CliError("no routine had a sink to export from");
      if (json) jsonOut({ command: "backup-export", profile: ctx.name, ok: true, exports });
      return;
    }
    case "restore": {
      const ctx = soleTarget(state, onlyProfile, "backup restore");
      if (!fromFile) throw new CliError("backup restore needs --from <archive.tar.gz>");
      const all = discoverRoutines(ctx);
      const routines = routineFilter ? all.filter((r) => r.name === routineFilter) : all;
      if (routines.length !== 1) {
        // One archive, one routine, one target volume. Guessing which of
        // several routines an archive belongs to would risk untarring an
        // agent volume into an app's PVC.
        throw new CliError(
          routines.length === 0
            ? routineFilter
              ? `--routine ${JSON.stringify(routineFilter)} matches nothing exactly in ${ctx.name}`
              : `no backup routines found in ${ctx.name}`
            : `${routines.length} routines in ${ctx.name} - name the archive's owner with ` +
              `--routine (known: ${routines.map((r) => r.name).join(", ")})`,
        );
      }
      const routine = routines[0]!;
      const shape = restoreShapeOf(routine);
      if (routine.restoreHookError) {
        // A hook that was DECLARED and does not parse is not the same as
        // no hook: silently falling back to the volume path would untar a
        // database dump over a PVC.
        throw new CliError(
          `${routine.name} declares a restore hook that is invalid: ${routine.restoreHookError}`,
        );
      }
      if (shape === "unsupported") {
        throw new CliError(
          `${routine.name} names no data PVC and declares no ${RESTORE_HOOK_ANNOTATION} - ` +
            "its artifact cannot be put back by anything hg knows about. The app that owns " +
            "the dump owns the hook; until it declares one, this backup is not restorable.",
        );
      }
      let report;
      if (shape === "hook") {
        const hook = routine.restoreHook!;
        // The command comes from a cluster annotation, so it is shown and
        // gated - the same posture --allow-repo-scripts takes.
        log(`restore hook for ${routine.name}:`);
        log(`  workload: ${hook.workload}${hook.container ? ` (container ${hook.container})` : ""}`);
        log(`  stage:    ${hook.stagePath}`);
        log(`  command:  ${hook.command.join(" ")}`);
        if (hook.quiesce.length > 0) log(`  quiesce:  ${hook.quiesce.join(", ")}`);
        if (!allowRestoreHook) {
          throw new CliError(
            "refusing to run an app-declared restore command without --allow-restore-hook",
          );
        }
        report = restoreViaHook(ctx, routine, fromFile);
      } else {
        report = restoreArtifact(ctx, routine, fromFile, timeoutSec);
      }
      ok(
        `restored ${path.basename(report.archive)} into ${report.targetPvc} ` +
          `(${report.fileCount >= 0 ? `${report.fileCount} entries` : "app-reported"}; quiesced: ${
            report.scaled.map((s) => `${s.kind}/${s.name}`).join(", ") || "nothing"
          })`,
      );
      if (json) jsonOut({ command: "backup-restore", profile: ctx.name, ok: true, ...report });
      return;
    }
    default:
      throw new CliError(
        `unknown backup subcommand ${JSON.stringify(sub)} (list|run|verify|export|restore)`,
      );
  }
}
