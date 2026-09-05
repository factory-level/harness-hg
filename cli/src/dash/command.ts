// Extracted from main.ts (final-pass #657): see the subject directory contract.
import { CliError, jsonOut, loadState, log, nsOf, ok } from "../lib.ts";
import { envTargets } from "../local/shared.ts";
import { dashboardContentErrors, declaredAlerts, declaredDashboards, grafanaDatasourceUids, grafanaImportedDashboardUids, grafanaImportedRules, reconcileDashboards, reconcileRules } from "./index.ts";

// ---------------------------------------------------------------------------
// dash - the dashboard/alert REPL and registration sight (dash.ts). list =
// declared vs imported, errors = content-level breakage Grafana renders
// silently, load = straight into Grafana as an overwritable [dev] copy so
// the edit loop is seconds instead of the sidecar's minutes.

export function cmdDash(
  json: boolean,
  args: string[],
  onlyProfile: string | undefined,
  onlyApp: string | undefined,
): void {
  const state = loadState();
  if (!state.ports) throw new CliError("platform not up yet - run: hermes-gitops up");
  const [sub] = args;
  const ctxs = envTargets(state, onlyProfile, "dash");

  switch (sub ?? "list") {
    case "list": {
      const importedUids = grafanaImportedDashboardUids();
      const importedRules = grafanaImportedRules();
      const profiles = ctxs.map((ctx) => {
        const ns = nsOf(ctx.name);
        const dashboards = declaredDashboards(ns);
        const alerts = declaredAlerts(ns);
        const findings = [
          ...reconcileDashboards(dashboards, importedUids),
          ...reconcileRules(alerts, importedRules),
        ];
        return {
          profile: ctx.name,
          dashboards: dashboards.map((d) => ({
            configMap: d.configMap,
            uid: d.uid,
            title: d.title,
            plane: d.plane || "workload",
            imported: importedUids.has(d.uid),
          })),
          rules: alerts.flatMap((cm) =>
            cm.rules.map((r) => ({
              uid: r.uid,
              title: r.title,
              params: r.evaluatorParams,
              imported: importedRules.some((ir) => ir.uid === r.uid),
            })),
          ),
          findings,
        };
      });
      const errors = profiles.flatMap((p) => p.findings.filter((f) => f.severity === "error"));
      if (json) {
        jsonOut({ command: "dash-list", ok: errors.length === 0, profiles });
      } else {
        for (const p of profiles) {
          log(`[${p.profile}] ${p.dashboards.length} dashboard(s), ${p.rules.length} rule(s)`);
          for (const d of p.dashboards) {
            console.log(`  ${d.imported ? "✓" : "✗"} dashboard ${d.uid}  "${d.title}"  (${d.configMap})`);
          }
          for (const r of p.rules) {
            console.log(`  ${r.imported ? "✓" : "✗"} rule ${r.uid}  params=${JSON.stringify(r.params)}`);
          }
          for (const f of p.findings) {
            console.error(`  ${f.severity === "error" ? "✗" : "!"} ${f.message}`);
          }
        }
      }
      if (errors.length > 0) throw new CliError(`dash list: ${errors.length} error(s)`);
      return;
    }
    case "errors": {
      const datasources = grafanaDatasourceUids();
      const profiles = ctxs.map((ctx) => {
        const ns = nsOf(ctx.name);
        const findings = declaredDashboards(ns).flatMap((d) =>
          dashboardContentErrors(d, datasources),
        );
        return { profile: ctx.name, findings };
      });
      const errors = profiles.flatMap((p) => p.findings.filter((f) => f.severity === "error"));
      if (json) {
        jsonOut({ command: "dash-errors", ok: errors.length === 0, profiles });
      } else {
        for (const p of profiles) {
          if (p.findings.length === 0) {
            ok(`[${p.profile}] no content-level dashboard errors`);
            continue;
          }
          log(`[${p.profile}]`);
          for (const f of p.findings) {
            console.error(`  ${f.severity === "error" ? "✗" : "!"} ${f.message}`);
          }
        }
      }
      if (errors.length > 0) throw new CliError(`dash errors: ${errors.length} error(s)`);
      return;
    }
    default:
      throw new CliError(`unknown dash subcommand ${JSON.stringify(sub)} (list|errors)`);
  }
}
