// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as fs from "node:fs";
import * as path from "node:path";
import { agentApply } from "../harness/hermes/index.ts";
import { CliError, loadState, log } from "../lib.ts";
import { ensureExposures, publishGitops, pushDevChart, refreshApp, syncProfile } from "../platform/index.ts";
import { emitNexusInto, ociRepoForChart, renderAllRecords } from "./shared.ts";

// ---------------------------------------------------------------------------
// dev - the hot-reload loop
// ---------------------------------------------------------------------------

// dev - the REPL: watch the whole onboard root; a save to a PROFILE
// re-renders and re-publishes every record; a save to an
// AGENT-APPLICATION CHART (<root>/charts/<name>/) repackages it as a
// unique -dev.N prerelease, pushes it to the oci:// repo the profiles
// declare for it, and re-pins the published records so Argo CD syncs the
// new chart bytes. Everything flows through the REAL git → Argo CD path;
// the -dev.N pin is the one local-only divergence, visible in the
// records it touches.
export async function cmdDev(): Promise<void> {
  const state = loadState();
  if (!state.ports) throw new CliError("platform not up yet - run: hg up");
  const chartsRoot = path.join(state.profileDir, "charts");
  const devVersions: Record<string, string> = {};
  let devSeq = 0;
  const touchedCharts = new Set<string>();
  log(`REPL watching ${state.profileDir} - every save goes commit → push → re-sync`);
  if (fs.existsSync(chartsRoot)) {
    log(`agent-application charts under charts/ hot-reload as -dev.N builds`);
  }
  let pending = false;
  const reload = async () => {
    if (pending) return;
    pending = true;
    await Bun.sleep(400); // debounce editor save bursts
    pending = false;
    try {
      const { sha, changed } = syncProfile(state);
      if (!changed && touchedCharts.size === 0) return;

      // Chart hot-reload: push each touched chart once per burst, to the
      // oci:// repo the catalogue's records declare for it.
      for (const chartName of [...touchedCharts]) {
        touchedCharts.delete(chartName);
        const chartDir = path.join(chartsRoot, chartName);
        if (!fs.existsSync(path.join(chartDir, "Chart.yaml"))) continue;
        const repo = ociRepoForChart(state, chartName);
        if (!repo) {
          log(`chart ${chartName}: no profile pulls it from an oci:// repo - skipped`);
          continue;
        }
        try {
          const version = pushDevChart(chartDir, chartName, repo, ++devSeq);
          devVersions[chartName] = version;
          log(`chart ${chartName} → ${repo} @ ${version}`);
        } catch (err) {
          console.error(`[hg] chart ${chartName} push failed: ${(err as Error).message}`);
        }
      }

      const records = renderAllRecords(state, sha, devVersions);
      publishGitops(state, records.map((r) => ({ name: r.ctx.name, yaml: r.yaml })), emitNexusInto(state));
      for (const { ctx } of records) refreshApp(ctx.name);
      log(`reloaded @ ${sha.slice(0, 12)} - Argo CD refresh requested (${records.length} app(s))`);
      // Editing a cron declaration should feel like editing a chart: the
      // change reaches the running agent without a manual step. Fails soft
      // and stays quiet - a record change rolls the StatefulSet, so the pod
      // is often mid-restart here and the next save (or `hg agent apply`)
      // converges it anyway.
      for (const { ctx } of records) {
        // Hermes-only: an Eve pod has no hermes binary and its schedules are
        // compiled at build (ADR-153); exec-ing would be silent dead work.
        if (ctx.runtime !== "hermes") continue;
        const applied = agentApply(ctx, false);
        if (applied.ok) {
          const rep = applied.report as { created: unknown[]; updated: unknown[]; pruned: unknown[] };
          if (rep.created.length || rep.updated.length || rep.pruned.length) {
            log(`cron converged for ${ctx.name} (${rep.created.length} new, ${rep.updated.length} changed, ${rep.pruned.length} gone)`);
          }
        }
      }
      ensureExposures(state, false);
    } catch (err) {
      console.error(`[hg] reload failed: ${(err as Error).message}`);
    }
  };
  fs.watch(state.profileDir, { recursive: true }, (_event, filename) => {
    const rel = filename?.toString() ?? "";
    if (rel.startsWith(`charts${path.sep}`)) {
      const chartName = rel.split(path.sep)[1];
      if (chartName) touchedCharts.add(chartName);
    }
    void reload();
  });
  await reload();
  ensureExposures(state);
  // Watchdog: a record change rolls the pod (profileChecksum), which
  // kills pod-pinned forwards - respawn dead ones so the declared URLs
  // stay live across the whole dev session. A respawn racing a
  // not-yet-Ready pod dies quietly and is retried on the next tick.
  setInterval(() => {
    try {
      ensureExposures(state, false);
    } catch {
      /* cluster mid-restart - retry next tick */
    }
  }, 5000);
  // Foreground forever (^C to stop).
  await new Promise(() => {});
}
