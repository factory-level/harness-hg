// Shell contracts: the ops aggregate's honesty rules and the two-gate
// route resolution with its sentinel - pure, fixture-tested.
import { describe, expect, test } from "bun:test";
import { opsModel, telemetryDescription } from "../src/app/chrome/ops";
import { resolveRoute, tabs } from "../src/app/routes";
import type { HealthOverlay, NexusData } from "../src/stores/data";

const base: NexusData = {
  demo: false,
  canWrite: false,
  plan: { components: [] },
  links: {},
  features: { "communication-view": true, "agents-view": true, "backups-view": true },
  capabilities: { views: {} },
  bundles: [],
  alerts: { configured: true, reachable: true, firing: [] },
};
const okHealth: HealthOverlay = {
  components: {},
  instances: {},
  sources: { argocd: { status: "configured", kind: "argocd" } },
};

describe("opsModel", () => {
  test("quiet only when telemetry answers and nothing fires", () => {
    expect(opsModel(base, okHealth, false).level).toBe("quiet");
  });
  test("firing alerts win: attention with the count", () => {
    const d = { ...base, alerts: { configured: true, reachable: true, firing: [{ name: "A" }, { name: "B" }] } };
    const m = opsModel(d, okHealth, false);
    expect(m.level).toBe("attention");
    expect(m.count).toBe(2);
  });
  test("severity 'none' (dead-man) is excluded from attention", () => {
    const d = { ...base, alerts: { configured: true, reachable: true, firing: [{ name: "Watchdog", severity: "none" }] } };
    expect(opsModel(d, okHealth, false).level).toBe("quiet");
  });
  test("missing telemetry never launders to green: empty sources map is unknown", () => {
    expect(opsModel(base, { ...okHealth, sources: {} }, false).level).toBe("unknown");
  });
  test("stale poll is unknown, not quiet", () => {
    expect(opsModel(base, okHealth, true).level).toBe("unknown");
  });
  test("unconfigured alerting is unknown, not quiet", () => {
    const d = { ...base, alerts: { configured: false, firing: [] } };
    expect(opsModel(d, okHealth, false).level).toBe("unknown");
  });
  test("control-plane ownership among firing alerts is marked", () => {
    const d = { ...base, alerts: { configured: true, reachable: true, firing: [{ name: "A", ownership: "control-plane" }] } };
    expect(opsModel(d, okHealth, false).hasControlPlane).toBe(true);
  });
});

describe("routes", () => {
  test("unknown hash falls back to fleet (a typo is not a withdrawal)", () => {
    expect(resolveRoute("#/nope", base).view).toBe("fleet");
  });
  test("withheld capability renders the unavailable sentinel, not a bounce", () => {
    const d = { ...base, capabilities: { views: { agents: false } } };
    expect(resolveRoute("#/agents", d).view).toBe("unavailable");
  });
  test("flag-off view is unavailable too (two gates, never merged)", () => {
    const d = { ...base, features: { ...base.features, "backups-view": false } };
    expect(resolveRoute("#/backups", d).view).toBe("unavailable");
  });
  test("demo turns flags on but never re-enables a withheld view", () => {
    const d = { ...base, demo: true, features: {}, capabilities: { views: { backups: false } } };
    expect(resolveRoute("#/backups", d).view).toBe("unavailable");
    expect(resolveRoute("#/communication", d).view).toBe("communication");
  });
  test("malformed escapes decode to an unknown sub, never a crash", () => {
    expect(resolveRoute("#/agents/%E0%A4%A", base).sub).toBeNull();
  });
  test("withheld tabs leave the strip", () => {
    const d = { ...base, capabilities: { views: { agents: false } } };
    expect(tabs(d).map((r) => r.id)).toEqual(["fleet", "communication", "backups"]);
  });
});


describe("live source freshness contract", () => {
  test("only stale sources are named; configured and absent sources are distinct", () => {
    const health = { ...okHealth, sources: {
      argocd: { kind: "argocd", status: "configured" },
      grafana: { kind: "grafana", status: "configured" },
      uptime: { kind: "uptime", status: "not configured" },
      reconciliation: { kind: "reconciliation", status: "stale" },
    } };
    expect(opsModel(base, health, true).staleSources).toEqual(["reconciliation"]);
    expect(opsModel(base, health, true).level).toBe("unknown");
  });
  test("unconfigured sources remain unavailable, not stale or healthy", () => {
    const health = { ...okHealth, sources: { uptime: { kind: "uptime", status: "not configured" } } };
    expect(opsModel(base, health, false).staleSources).toEqual([]);
    expect(opsModel(base, health, false).reason).toBe("telemetry unavailable: uptime");
    expect(opsModel(base, health, false).level).toBe("unknown");
  });
});


test("first failed poll cannot claim cached readings or quiet health", () => {
  expect(opsModel(base, null, false).level).toBe("unknown");
  expect(telemetryDescription(null, true, [])).toBe("No health readings have been fetched yet.");
  expect(telemetryDescription(okHealth, true, [])).toBe("Showing the last successfully fetched readings.");
  expect(telemetryDescription(okHealth, false, ["reconciliation"])).toBe("reconciliation — the latest report is out of date.");
});
