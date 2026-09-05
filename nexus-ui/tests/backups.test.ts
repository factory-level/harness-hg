// Backups honesty rules, fixture-tested (the ADR-52/59/122/123 + #582
// contracts the view renders).
import { describe, expect, test } from "bun:test";
import { cronProse, destinationProse, rowStatus, shelfLevel, shelves, verdict, type BackupsDoc } from "../src/app/backups/model";
import { DEMO_BACKUPS } from "../src/stores/demo";

const doc: BackupsDoc = DEMO_BACKUPS;

describe("shelves", () => {
  test("control plane always leads and is explicit per-component - never a blanket row", () => {
    const s = shelves(doc);
    expect(s[0].id).toBe("control-plane");
    expect(s[0].routines.map((r) => r.component)).toEqual(["nexus", "event-router", "grafana"]);
  });
  test("workloads roll up by bundle; independents come last", () => {
    const s = shelves(doc);
    expect(s.map((x) => x.id)).toEqual(["control-plane", "bundle:marketing", "independent"]);
  });
  test("uncovered components render inside their bundle's shelf", () => {
    const s = shelves(doc).find((x) => x.id === "bundle:marketing")!;
    expect(s.uncovered.map((u) => u.id)).toEqual(["mkt-relay"]);
  });
});

describe("aggregation is never derivation", () => {
  test("an empty shelf is unknown", () => {
    expect(shelfLevel({ id: "x", title: "x", controlPlane: false, routines: [], uncovered: [] })).toBe("unknown");
  });
  test("worst-of-children: the marketing shelf is degraded via its uncovered row", () => {
    const s = shelves(doc).find((x) => x.id === "bundle:marketing")!;
    expect(["degraded", "unknown"]).toContain(shelfLevel(s));
  });
});

describe("the two-axis truth", () => {
  test("a never-run routine reads unknown, not healthy", () => {
    const r = doc.routines.find((x) => x.id === "mkt-postiz-db")!;
    expect(rowStatus(r).level).toBe("unknown");
  });
  test("running-but-unproven surfaces the artifact word, not quiet health", () => {
    const r = doc.routines.find((x) => x.id === "cp-router")!;
    expect(rowStatus(r).word).toBe("Not restore-proven");
  });
  test("ephemeral-by-design is quiet, not a failure", () => {
    const r = doc.routines.find((x) => x.id === "indep-registry")!;
    expect(rowStatus(r).level).toBe("healthy");
  });
});

describe("verdict", () => {
  test("attention counts routines needing it plus uncovered components", () => {
    expect(verdict(doc).text).toMatch(/^\d+ of \d+ backup routines need attention\.$/);
  });
  test("all-healthy-but-unproven is its own sentence", () => {
    const healthy: BackupsDoc = {
      routines: [
        { id: "a", title: "A", state: "healthy", level: "healthy", artifact: { state: "unproven" } },
      ],
      unprotected: [],
    };
    expect(verdict(healthy).text).toContain("not all proven restorable");
  });
});

describe("cron prose never guesses", () => {
  test("the four known shapes translate", () => {
    expect(cronProse("20 3 * * *")).toBe("daily at 03:20");
    expect(cronProse("15 * * * *")).toBe("hourly at :15");
    expect(cronProse("0 4 * * 0")).toBe("weekly on Sunday at 04:00");
    expect(cronProse("*/30 * * * *")).toBe("every 30 minutes");
  });
  test("anything else is VERBATIM", () => {
    expect(cronProse("0 4 1 * *")).toBe("0 4 1 * *");
    expect(cronProse("@daily")).toBe("@daily");
  });
});

describe("destinations", () => {
  test("known classes speak durability; unknown is verbatim, no gloss", () => {
    expect(destinationProse("gcs")).toContain("survives cluster loss");
    expect(destinationProse("weird-store")).toBe("weird-store");
  });
});
