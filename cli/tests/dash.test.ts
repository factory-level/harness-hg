// Offline unit tests for the hg dash parse/reconcile surface
// (cli/src/dash.ts) - captured kubectl/Grafana API JSON as fixtures, no
// cluster. Transport and helm-template paths are proven by the live loop.
import { describe, expect, test } from "bun:test";
import {
  dashboardContentErrors,
  parseAlertConfigMaps,
  parseDashboardConfigMaps,
  reconcileDashboards,
  reconcileRules,
  type DeclaredAlerts,
  type DeclaredDashboard,
} from "../src/dash/index.ts";

function cmList(items: object[]): string {
  return JSON.stringify({ items });
}

const DASH_CM = {
  metadata: { name: "hermes-x-monitoring-dashboard", namespace: "hermes-x" },
  data: {
    "hermes-x-dashboard.json": JSON.stringify({
      uid: "hermes-x-dash",
      title: "Hermes — x",
      panels: [
        {
          title: "Visits",
          datasource: { type: "prometheus", uid: "prometheus" },
          targets: [{ expr: "sum(rate(x[5m]))" }],
        },
      ],
    }),
  },
};

const ALERT_CM = {
  metadata: { name: "hermes-x-monitoring-alerts", namespace: "hermes-x" },
  data: {
    "alerts.yaml": [
      "apiVersion: 1",
      "groups:",
      "  - name: g",
      "    rules:",
      "      - uid: hermes-x-visits",
      "        title: SiteVisitsHigh (x)",
      "        data:",
      "          - model:",
      "              conditions:",
      "                - evaluator:",
      "                    type: gt",
      "                    params: [5]",
    ].join("\n"),
  },
};

describe("parseDashboardConfigMaps", () => {
  test("extracts uid/title per *.json key", () => {
    const [d] = parseDashboardConfigMaps(cmList([DASH_CM]));
    expect(d!.uid).toBe("hermes-x-dash");
    expect(d!.title).toBe("Hermes — x");
    expect(d!.configMap).toBe("hermes-x-monitoring-dashboard");
  });

  test("unparseable dashboard JSON becomes a reportable entry, not a crash", () => {
    const broken = { metadata: { name: "cm" }, data: { "bad.json": "{nope" } };
    const [d] = parseDashboardConfigMaps(cmList([broken]));
    expect(d!.uid).toBe("");
    expect(d!.title).toBe("<unparseable JSON>");
  });

  test("non-json keys are ignored", () => {
    const cm = { metadata: { name: "cm" }, data: { "readme.txt": "hi" } };
    expect(parseDashboardConfigMaps(cmList([cm]))).toEqual([]);
  });
});

describe("parseAlertConfigMaps", () => {
  test("extracts rule uids and every evaluator param", () => {
    const [a] = parseAlertConfigMaps(cmList([ALERT_CM]));
    expect(a!.rules).toEqual([
      { uid: "hermes-x-visits", title: "SiteVisitsHigh (x)", evaluatorParams: [[5]] },
    ]);
  });

  test("a contact-points-only ConfigMap yields no entry", () => {
    const cm = { metadata: { name: "cp" }, data: { "cp.yaml": "apiVersion: 1\ncontactPoints: [x]" } };
    expect(parseAlertConfigMaps(cmList([cm]))).toEqual([]);
  });

  test("a labelled CM with broken YAML yields a ZERO-rule entry for reconciliation to flag", () => {
    const cm = { metadata: { name: "broken" }, data: { "a.yaml": "groups: [\n  broken" } };
    const out = parseAlertConfigMaps(cmList([cm]));
    expect(out).toHaveLength(1);
    expect(out[0]!.rules).toEqual([]);
  });
});

describe("reconcileDashboards", () => {
  const declared: DeclaredDashboard = {
    configMap: "cm",
    namespace: "ns",
    key: "d.json",
    uid: "hermes-x-dash",
    title: "t",
    json: {},
  };

  test("an imported uid reconciles clean", () => {
    expect(reconcileDashboards([declared], new Set(["hermes-x-dash"]))).toEqual([]);
  });

  test("declared-but-not-imported is THE error - matched by uid, never title", () => {
    const findings = reconcileDashboards([declared], new Set(["something-else"]));
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toMatch(/NOT in Grafana/);
  });

  test("a dashboard with no uid is an error", () => {
    const findings = reconcileDashboards([{ ...declared, uid: "" }], new Set());
    expect(findings[0]!.message).toMatch(/no uid/);
  });
});

describe("reconcileRules", () => {
  const declared: DeclaredAlerts[] = [
    {
      configMap: "cm",
      namespace: "ns",
      rules: [{ uid: "r1", title: "R1", evaluatorParams: [[5]] }],
    },
  ];

  test("imported uid with matching number params reconciles clean", () => {
    expect(reconcileRules(declared, [{ uid: "r1", params: [[5]] }])).toEqual([]);
  });

  test("a STRING evaluator param is the float64 trap - error on either side", () => {
    const declaredStr: DeclaredAlerts[] = [
      { configMap: "cm", namespace: "ns", rules: [{ uid: "r1", title: "R1", evaluatorParams: [["5"]] }] },
    ];
    const f1 = reconcileRules(declaredStr, [{ uid: "r1", params: [["5"]] }]);
    expect(f1.some((f) => /never fires/.test(f.message))).toBe(true);
    const f2 = reconcileRules(declared, [{ uid: "r1", params: [["5"]] }]);
    expect(f2.some((f) => /not a number/.test(f.message))).toBe(true);
  });

  test("declared params != imported params is a disagreement error", () => {
    const findings = reconcileRules(declared, [{ uid: "r1", params: [[100]] }]);
    expect(findings.some((f) => /disagree/.test(f.message))).toBe(true);
  });

  test("condition structure is preserved: [1],[2] does not reconcile as [1,2]", () => {
    const twoConditions: DeclaredAlerts[] = [
      { configMap: "cm", namespace: "ns", rules: [{ uid: "r1", title: "R1", evaluatorParams: [[1], [2]] }] },
    ];
    const findings = reconcileRules(twoConditions, [{ uid: "r1", params: [[1, 2]] }]);
    expect(findings.some((f) => /disagree/.test(f.message))).toBe(true);
  });

  test("a labelled CM with zero parsed rules is an error, not a vacuous pass", () => {
    const empty: DeclaredAlerts[] = [{ configMap: "cm", namespace: "ns", rules: [] }];
    const findings = reconcileRules(empty, []);
    expect(findings.some((f) => /ZERO rules parsed/.test(f.message))).toBe(true);
  });

  test("declared-but-not-imported rule is an error", () => {
    const findings = reconcileRules(declared, []);
    expect(findings.some((f) => /NOT in Grafana/.test(f.message))).toBe(true);
  });
});

describe("dashboardContentErrors", () => {
  const base: DeclaredDashboard = {
    configMap: "cm",
    namespace: "ns",
    key: "d.json",
    uid: "u",
    title: "t",
    json: {
      panels: [
        {
          title: "ok",
          datasource: { uid: "prometheus" },
          targets: [{ expr: "up" }],
        },
        {
          title: "dead-ds",
          datasource: { uid: "prometheus-typo" },
          targets: [{ expr: "up" }],
        },
        { title: "empty-expr", datasource: { uid: "prometheus" }, targets: [{ expr: "  " }] },
        { title: "templated", datasource: { uid: "$datasource" }, targets: [{ expr: "up" }] },
      ],
    },
  };

  test("a dead datasource uid is an error; empty expr a warning; $vars skipped", () => {
    const findings = dashboardContentErrors(base, new Set(["prometheus"]));
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(1);
    expect(findings[0]!.message).toMatch(/prometheus-typo/);
    expect(findings.filter((f) => f.severity === "warning")).toHaveLength(1);
    expect(findings[1]!.message).toMatch(/empty expr/);
  });

  test("a clean dashboard yields nothing", () => {
    const clean = { ...base, json: { panels: [{ title: "p", datasource: { uid: "prometheus" }, targets: [{ expr: "up" }] }] } };
    expect(dashboardContentErrors(clean, new Set(["prometheus"]))).toEqual([]);
  });
});
