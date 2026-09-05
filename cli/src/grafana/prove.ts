// hg grafana prove (#281) - the embedded-panel acceptance matrix.
//
// The mistake this exists to prevent is specific: an embed was built,
// verified in a browser, and withdrawn because the dashboard behind the
// card was a COST dashboard. A tab named Uptime would have rendered
// spend. Nothing about the frame was broken - the panel rendered
// perfectly and meant something else.
//
// So the important checks here are not "does it load". They are: does
// the panel this catalog names actually EXIST, can the browser be made
// to name a different one, and does a surface with no honest panel say
// so instead of showing the nearest available chart.

import { CliError, kubectl, type HgState } from "../lib.ts";
import type { ProofFinding, ProofResult } from "../backup/platform.ts";

export interface CataloguedPanel {
  id: string;
  surface: string;
  title: string;
  dashboard: string;
  panelId: number;
  size: string;
  range?: string;
}

/** Ask GRAFANA whether a dashboard carries a panel id. Parsing the chart
 * templates instead would prove the catalog agrees with the repository,
 * which is not the same as agreeing with what is deployed. */
export function livePanelIds(grafanaBase: string, uid: string, auth: string): Set<number> | null {
  const out = Bun.spawnSync([
    "curl", "-sf", "-m", "10", "-u", auth, `${grafanaBase}/api/dashboards/uid/${encodeURIComponent(uid)}`,
  ]);
  if ((out.exitCode ?? 1) !== 0) return null;
  try {
    const doc = JSON.parse(out.stdout.toString()) as { dashboard?: { panels?: { id?: number }[] } };
    return new Set((doc.dashboard?.panels ?? []).map((p) => p.id).filter((n): n is number => typeof n === "number"));
  } catch {
    return null;
  }
}

export interface GrafanaProveDeps {
  nexusBaseUrl: string;
  /** A verified id_token. The panel routes are viewer-gated (#284), and
   * a prover that could read them unauthenticated would be proving a
   * surface nobody else can reach. */
  bearer: string;
  grafanaBaseUrl: string;
  grafanaAuth: string;
  fetchJson: (url: string) => Promise<{ status: number; body: any }>;
}

export async function proveGrafana(_state: HgState, deps: GrafanaProveDeps): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });

  const surfaces = ["system", "communication", "backup", "agent", "application", "uptime", "eval"];
  // Per-instance panels resolve only WITH a component, so fetching the
  // agent surface bare would report every one of them `not configured`
  // and PANEL001 would quietly verify only the platform half. Pick a
  // real component out of the plan and ask again.
  const plan = (await deps.fetchJson(`${deps.nexusBaseUrl}/nexus`)).body;
  const componentFor = (kind: string): string | undefined =>
    (plan?.plan?.components ?? plan?.components ?? []).find(
      (c: any) => c.kind === kind && (c.instances ?? []).some((i: any) => i.grafanaDashboardUid),
    )?.id;
  const projected: Record<string, any> = {};
  for (const s of surfaces) {
    const comp = s === "agent" || s === "application" ? componentFor(s) : undefined;
    const q = comp ? `?surface=${s}&component=${encodeURIComponent(comp)}` : `?surface=${s}`;
    projected[s] = (await deps.fetchJson(`${deps.nexusBaseUrl}/nexus/panels${q}`)).body;
  }

  // PANEL001 - every catalogued panel exists in the LIVE Grafana. The
  // one check that would have caught the withdrawn embed.
  // TWO different bugs live here and they need different fixes, so they
  // get different findings. A panel id absent from a dashboard that
  // EXISTS is a catalog error - the catalog is wrong about a dashboard
  // it can see. A dashboard that does not exist at all is the PLAN
  // promising something the deployment never created (#301), which no
  // edit to this catalog can fix. Reporting them as one number would
  // send the next person to the wrong file.
  const wrongPanel: string[] = [];
  const absentDashboard: string[] = [];
  const checked: string[] = [];
  for (const s of surfaces) {
    for (const p of projected[s]?.panels ?? []) {
      if (p.status !== "configured" || !p.openUrl) continue;
      const m = /\/d\/([^?]+)\?viewPanel=(\d+)/.exec(p.openUrl);
      if (!m) continue;
      const uid = decodeURIComponent(m[1]!);
      const ids = livePanelIds(deps.grafanaBaseUrl, uid, deps.grafanaAuth);
      if (ids === null) {
        absentDashboard.push(`${p.id} -> ${uid}`);
      } else if (!ids.has(Number(m[2]))) {
        wrongPanel.push(`${p.id}: panel ${m[2]} is not in dashboard ${uid}`);
      } else {
        checked.push(p.id);
      }
    }
  }
  const missing = wrongPanel;
  // A count is not a proof of coverage: verifying six platform panels
  // while silently skipping every per-agent one would read identically.
  const perInstanceChecked = checked.some((id) => id.startsWith("agent-") || id.startsWith("application-"));
  add(
    "PANEL001",
    missing.length === 0 && checked.length > 0 && perInstanceChecked
      ? "pass"
      : missing.length
        ? "fail"
        : "unknown",
    "grafana",
    missing.length > 0
      ? missing.join("; ")
      : perInstanceChecked
        ? `${checked.length} catalogued panel(s) exist in the live Grafana, per-agent included`
        : `${checked.length} platform panel(s) checked, but NO per-agent panel was reachable - ` +
          "coverage is thinner than this count suggests",
  );

  // PANEL007 - the plan promises no dashboard the deployment lacks.
  // Separate from PANEL001 because the fix lives in the compiler, not
  // in the catalog: a bundled profile's apps are not deployed at all
  // (ADR-28 - the bundle chart ships no child Applications), yet the
  // plan still names their Applications and dashboard uids (#301).
  add(
    "PANEL007",
    absentDashboard.length === 0 ? "pass" : "fail",
    "plan",
    absentDashboard.length === 0
      ? "every dashboard the plan promises exists in Grafana"
      : `the plan names dashboards Grafana does not have (see #301): ${absentDashboard.join("; ")}`,
  );

  // PANEL002 - the browser cannot name a dashboard. An unknown surface
  // is refused rather than resolved to something.
  const bogus = await deps.fetchJson(`${deps.nexusBaseUrl}/nexus/panels?surface=../../etc`);
  add(
    "PANEL002",
    bogus.status === 400 ? "pass" : "fail",
    "nexus",
    bogus.status === 400
      ? "an unknown surface is refused, not resolved"
      : `an unknown surface returned ${bogus.status}`,
  );

  // PANEL003 - no embed URL points anywhere but the configured Grafana.
  const strays: string[] = [];
  for (const s of surfaces) {
    for (const p of projected[s]?.panels ?? []) {
      for (const url of [p.embedUrl, p.openUrl].filter(Boolean) as string[]) {
        if (!url.startsWith(deps.grafanaBaseUrl)) strays.push(`${p.id}: ${url}`);
      }
    }
  }
  add(
    "PANEL003",
    strays.length === 0 ? "pass" : "fail",
    "nexus",
    strays.length === 0 ? "every panel URL is under the configured Grafana origin" : strays.join("; "),
  );

  // PANEL004 - a surface with no honest panel says `not configured`
  // rather than borrowing one. Uptime is the live case: Gatus feeds
  // neither Prometheus nor Grafana.
  const uptime = projected["uptime"];
  add(
    "PANEL004",
    uptime?.status === "not configured" && (uptime?.panels ?? []).length === 0 ? "pass" : "fail",
    "nexus",
    uptime?.status === "not configured"
      ? "the uptime surface reports not-configured rather than borrowing a panel"
      : "the uptime surface returned panels, but nothing feeds uptime into Grafana",
  );

  // PANEL005 - every configured panel keeps a way through. A denied or
  // broken frame must never be a dead end.
  const noFallback: string[] = [];
  for (const s of surfaces) {
    for (const p of projected[s]?.panels ?? []) {
      if (p.status === "configured" && !p.openUrl) noFallback.push(p.id);
    }
  }
  add(
    "PANEL005",
    noFallback.length === 0 ? "pass" : "fail",
    "nexus",
    noFallback.length === 0
      ? "every rendered panel carries an Open in Grafana link"
      : `no fallback link on: ${noFallback.join(", ")}`,
  );

  // PANEL006 - the CSP frames the Grafana origin and nothing else.
  const head = Bun.spawnSync(["curl", "-sfI", "-m", "5", deps.nexusBaseUrl.replace(/\/api\/plugins.*/, "/")]);
  const csp = head.stdout.toString().split("\n").find((l) => l.toLowerCase().startsWith("content-security-policy:")) ?? "";
  const origin = new URL(deps.grafanaBaseUrl).origin;
  const ok = csp.includes(`frame-src ${origin}`) && !csp.includes("*") && csp.includes("frame-ancestors 'self'");
  add(
    "PANEL006",
    ok ? "pass" : "fail",
    "nexus",
    ok
      ? "frame-src names only the configured Grafana origin, and Nexus refuses to be framed"
      : `content-security-policy is ${csp.trim() || "absent"}`,
  );

  const fail = findings.filter((f) => f.status === "fail").length;
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "grafana-prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: fail === 0,
    findings,
    summary: {
      pass: findings.filter((f) => f.status === "pass").length,
      fail,
      unknown: findings.filter((f) => f.status === "unknown").length,
    },
  };
}
