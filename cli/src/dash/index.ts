// hg dash - the dashboard/alert REPL and registration proof.
//
// The Grafana sidecar convention (ConfigMaps labelled grafana_dashboard /
// grafana_alert, observability.md) is documented and copied correctly -
// and enforced by NOTHING. A dashboard can fail to import forever, a
// panel can point at a dead datasource uid, and an alert rule can carry a
// STRING evaluator param (the float64 trap: imports clean, never fires,
// masked by execErrState: OK) - all invisible to `hg test`. This module
// makes the declared-vs-imported delta visible (`dash list`) and the
// content-level breakage visible (`dash errors`).

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError, KCTX, kubectl } from "../lib.ts";

export const DASHBOARD_LABEL = "grafana_dashboard";
export const ALERT_LABEL = "grafana_alert";

// ---------------------------------------------------------------------------
// Transport: Grafana's API through the same kubectl-exec path the register
// tier uses - no port to manage, works wherever kubectl works. busybox
// wget in the grafana container handles both verbs.

// The admin credential lives in ONE place: the monitoring-grafana-admin
// Secret the chart's admin.existingSecret references (ADR-45; issue #130
// removed the committed literal). The local loop generates it, a fleet
// delivers it through ESO - either way this transport reads the SAME
// Secret Grafana reads, so the CLI and a browser can never drift.
let grafanaCredsCache: { user: string; password: string } | null = null;
export function grafanaCredentials(): { user: string; password: string } {
  if (grafanaCredsCache) return grafanaCredsCache;
  const raw = kubectl(
    ["-n", "hermes-monitoring", "get", "secret", "monitoring-grafana-admin",
      "-o", "jsonpath={.data.admin-user} {.data.admin-password}"],
    { quiet: true, allowFail: true },
  ).trim();
  const [u, p] = raw.split(/\s+/);
  if (!u || !p) {
    throw new CliError(
      "monitoring-grafana-admin Secret not found in hermes-monitoring - " +
        "is the platform up? (hg up creates it before installing the stack)",
    );
  }
  grafanaCredsCache = {
    user: Buffer.from(u, "base64").toString("utf8"),
    password: Buffer.from(p, "base64").toString("utf8"),
  };
  return grafanaCredsCache;
}
const grafanaLocalApi = (): string => {
  const { user, password } = grafanaCredentials();
  return `http://${user}:${password}@127.0.0.1:3000`;
};

const API_PATH_RE = /^[A-Za-z0-9/?&=._%-]+$/;
function assertApiPath(apiPath: string): void {
  // The path is interpolated into a single-quoted sh -c inside the
  // container; every current caller passes constants, and this keeps the
  // exported signature from becoming an injection sink later.
  if (!API_PATH_RE.test(apiPath)) {
    throw new CliError(`refusing Grafana API path with unsafe characters: ${JSON.stringify(apiPath)}`);
  }
}

export function grafanaGet(apiPath: string): string {
  assertApiPath(apiPath);
  return kubectl(
    [
      "-n", "hermes-monitoring", "exec", "deploy/monitoring-grafana", "-c", "grafana", "--",
      "sh", "-c", `wget -qO- '${grafanaLocalApi()}${apiPath}'`,
    ],
    { allowFail: true, quiet: true },
  );
}

// ---------------------------------------------------------------------------
// The declared side: what the cluster's labelled ConfigMaps carry.

export interface DeclaredDashboard {
  configMap: string;
  namespace: string;
  key: string;
  uid: string;
  title: string;
  /** From the ConfigMap's plane label (ADR 0164); "" when unlabeled. */
  plane: string;
  json: Record<string, unknown>;
}

export interface DeclaredRule {
  uid: string;
  title: string;
  /** Evaluator params PER CONDITION, in order - flattening would let two
   * conditions [1],[2] reconcile against one condition [1,2]. */
  evaluatorParams: unknown[][];
}

export interface DeclaredAlerts {
  configMap: string;
  namespace: string;
  rules: DeclaredRule[];
}

/** Pure: parse `kubectl get cm -o json` items into declared dashboards. */
export function parseDashboardConfigMaps(kubectlJson: string): DeclaredDashboard[] {
  const doc = JSON.parse(kubectlJson) as {
    items?: { metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }; data?: Record<string, string> }[];
  };
  const out: DeclaredDashboard[] = [];
  for (const item of doc.items ?? []) {
    for (const [key, raw] of Object.entries(item.data ?? {})) {
      if (!key.endsWith(".json")) continue;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // A dashboard that does not parse is itself a finding; surface it
        // as a pseudo-entry the caller can report.
        out.push({
          configMap: item.metadata?.name ?? "<unnamed>",
          namespace: item.metadata?.namespace ?? "",
          key,
          uid: "",
          title: "<unparseable JSON>",
          plane: item.metadata?.labels?.["hermes-gitops.factorylevel.dev/plane"] ?? "",
          json: {},
        });
        continue;
      }
      out.push({
        configMap: item.metadata?.name ?? "<unnamed>",
        namespace: item.metadata?.namespace ?? "",
        key,
        uid: String(json["uid"] ?? ""),
        title: String(json["title"] ?? ""),
        plane: item.metadata?.labels?.["hermes-gitops.factorylevel.dev/plane"] ?? "",
        json,
      });
    }
  }
  return out;
}

/** Pure: parse alert-provisioning ConfigMaps into declared rules. */
export function parseAlertConfigMaps(kubectlJson: string): DeclaredAlerts[] {
  const doc = JSON.parse(kubectlJson) as {
    items?: { metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }; data?: Record<string, string> }[];
  };
  const out: DeclaredAlerts[] = [];
  for (const item of doc.items ?? []) {
    const rules: DeclaredRule[] = [];
    for (const raw of Object.values(item.data ?? {})) {
      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch {
        continue;
      }
      const groups = (parsed as { groups?: { rules?: unknown[] }[] })?.groups ?? [];
      for (const group of groups) {
        for (const rule of (group.rules ?? []) as {
          uid?: string;
          title?: string;
          data?: { model?: { conditions?: { evaluator?: { params?: unknown[] } }[] } }[];
        }[]) {
          rules.push({
            uid: String(rule.uid ?? ""),
            title: String(rule.title ?? ""),
            evaluatorParams: (rule.data ?? []).flatMap((d) =>
              (d.model?.conditions ?? []).map((c) => c.evaluator?.params ?? []),
            ),
          });
        }
      }
    }
    // A labelled CM that parsed to ZERO rules is included (unless it is
    // contact-points-only provisioning) so reconciliation can flag it -
    // silently dropping it is how "every declared rule imported" gets
    // reported over an empty declared set.
    const contactPointsOnly =
      rules.length === 0 &&
      Object.values(item.data ?? {}).some((raw) => {
        try {
          return Boolean((parseYaml(raw) as { contactPoints?: unknown })?.contactPoints);
        } catch {
          return false;
        }
      });
    if (rules.length > 0 || !contactPointsOnly) {
      out.push({
        configMap: item.metadata?.name ?? "<unnamed>",
        namespace: item.metadata?.namespace ?? "",
        rules,
      });
    }
  }
  return out;
}

export function declaredDashboards(ns: string): DeclaredDashboard[] {
  return parseDashboardConfigMaps(
    kubectl(["-n", ns, "get", "configmap", "-l", `${DASHBOARD_LABEL}=1`, "-o", "json"], {
      quiet: true,
    }),
  );
}

export function declaredAlerts(ns: string): DeclaredAlerts[] {
  return parseAlertConfigMaps(
    kubectl(["-n", ns, "get", "configmap", "-l", `${ALERT_LABEL}=1`, "-o", "json"], {
      quiet: true,
    }),
  );
}

// ---------------------------------------------------------------------------
// The imported side + reconciliation.

export interface DashFinding {
  severity: "error" | "warning";
  message: string;
}

/** Pure: is this declared dashboard actually in Grafana (by uid, never by
 * title-substring - a title match is how one app's dashboard masked a
 * missing platform one)? */
export function reconcileDashboards(
  declared: DeclaredDashboard[],
  importedUids: Set<string>,
): DashFinding[] {
  const findings: DashFinding[] = [];
  for (const d of declared) {
    if (!d.uid) {
      findings.push({
        severity: "error",
        message: `${d.configMap}/${d.key}: dashboard JSON is unparseable or has no uid`,
      });
      continue;
    }
    if (!importedUids.has(d.uid)) {
      findings.push({
        severity: "error",
        message: `${d.configMap}/${d.key}: dashboard uid ${JSON.stringify(d.uid)} is declared but NOT in Grafana - the sidecar never imported it`,
      });
    }
  }
  return findings;
}

/** Pure: declared rules must be imported uid-for-uid, and every evaluator
 * param must be a NUMBER both as declared and as imported - a string param
 * imports clean and then never, ever fires (execErrState: OK masks it). */
export function reconcileRules(
  declared: DeclaredAlerts[],
  imported: { uid: string; params: unknown[][] }[],
): DashFinding[] {
  const findings: DashFinding[] = [];
  const byUid = new Map(imported.map((r) => [r.uid, r]));
  for (const cm of declared) {
    if (cm.rules.length === 0) {
      findings.push({
        severity: "error",
        message:
          `${cm.configMap}: labelled ${ALERT_LABEL} but ZERO rules parsed from it - ` +
          "unparseable provisioning YAML reads as nothing to verify",
      });
      continue;
    }
    for (const rule of cm.rules) {
      for (const p of rule.evaluatorParams.flat()) {
        if (typeof p !== "number") {
          findings.push({
            severity: "error",
            message:
              `${cm.configMap}: rule ${rule.uid} declares evaluator param ${JSON.stringify(p)} ` +
              `(${typeof p}) - Grafana silently errors on non-number params and the rule never fires`,
          });
        }
      }
      const live = byUid.get(rule.uid);
      if (!live) {
        findings.push({
          severity: "error",
          message: `${cm.configMap}: rule ${rule.uid} (${rule.title}) is declared but NOT in Grafana`,
        });
        continue;
      }
      for (const p of live.params.flat()) {
        if (typeof p !== "number") {
          findings.push({
            severity: "error",
            message: `rule ${rule.uid}: IMPORTED evaluator param ${JSON.stringify(p)} is a ${typeof p}, not a number - the rule will never fire`,
          });
        }
      }
      if (JSON.stringify(live.params) !== JSON.stringify(rule.evaluatorParams)) {
        findings.push({
          severity: "error",
          message:
            `rule ${rule.uid}: declared evaluator params ${JSON.stringify(rule.evaluatorParams)} != ` +
            `imported ${JSON.stringify(live.params)} - the ConfigMap and Grafana disagree`,
        });
      }
    }
  }
  return findings;
}

/** Pure: content-level dashboard problems Grafana will render as broken
 * panels without ever raising an error. */
export function dashboardContentErrors(
  d: DeclaredDashboard,
  datasourceUids: Set<string>,
): DashFinding[] {
  const findings: DashFinding[] = [];
  type Panel = {
    title?: string;
    datasource?: { uid?: string } | string;
    targets?: { expr?: string }[];
    panels?: Panel[];
  };
  // Row panels nest their members under panel.panels - flatten, or a
  // whole row's worth of dead datasources goes unchecked.
  const flatten = (ps: Panel[]): Panel[] => ps.flatMap((p) => [p, ...flatten(p.panels ?? [])]);
  const panels = flatten(((d.json["panels"] as Panel[]) ?? []));
  for (const panel of panels) {
    const label = `${d.uid || d.key} panel ${JSON.stringify(panel.title ?? "<untitled>")}`;
    // Old schemaVersions carry datasource as a plain string name - no uid
    // to check, skip rather than false-error.
    const dsUid = typeof panel.datasource === "object" ? panel.datasource?.uid : undefined;
    if (dsUid && !dsUid.startsWith("$") && !datasourceUids.has(dsUid)) {
      findings.push({
        severity: "error",
        message: `${label}: datasource uid ${JSON.stringify(dsUid)} does not exist in Grafana - the panel renders "Datasource not found"`,
      });
    }
    for (const t of panel.targets ?? []) {
      if (t.expr !== undefined && String(t.expr).trim() === "") {
        findings.push({ severity: "warning", message: `${label}: target with an empty expr` });
      }
      const tds = (t as { datasource?: { uid?: string } | string }).datasource;
      const tUid = typeof tds === "object" ? tds?.uid : undefined;
      if (tUid && !tUid.startsWith("$") && !datasourceUids.has(tUid)) {
        findings.push({
          severity: "error",
          message: `${label}: target datasource uid ${JSON.stringify(tUid)} does not exist in Grafana`,
        });
      }
    }
  }
  return findings;
}

export function grafanaImportedDashboardUids(): Set<string> {
  const raw = grafanaGet("/api/search?type=dash-db&limit=500");
  try {
    return new Set((JSON.parse(raw) as { uid?: string }[]).map((d) => d.uid ?? ""));
  } catch {
    throw new CliError(`Grafana search returned unparseable output: ${raw.slice(0, 200)}`);
  }
}

export function grafanaImportedRules(): { uid: string; title: string; params: unknown[][] }[] {
  const raw = grafanaGet("/api/v1/provisioning/alert-rules");
  try {
    const rules = JSON.parse(raw) as {
      uid?: string;
      title?: string;
      data?: { model?: { conditions?: { evaluator?: { params?: unknown[] } }[] } }[];
    }[];
    return rules.map((r) => ({
      uid: r.uid ?? "",
      title: r.title ?? "",
      params: (r.data ?? []).flatMap((d) =>
        (d.model?.conditions ?? []).map((c) => c.evaluator?.params ?? []),
      ),
    }));
  } catch {
    throw new CliError(`Grafana alert-rules returned unparseable output: ${raw.slice(0, 200)}`);
  }
}

export function grafanaDatasourceUids(): Set<string> {
  const raw = grafanaGet("/api/datasources");
  try {
    return new Set((JSON.parse(raw) as { uid?: string }[]).map((d) => d.uid ?? ""));
  } catch {
    throw new CliError(`Grafana datasources returned unparseable output: ${raw.slice(0, 200)}`);
  }
}

