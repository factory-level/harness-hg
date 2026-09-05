// System registry + mandala geometry contracts.
import { describe, expect, test } from "bun:test";
import { CAPABILITIES, capabilityLevel, unplaced } from "../src/app/system/capabilities";
import { layoutSlices } from "../src/app/system/SystemView";
import { DEMO_INVENTORY } from "../src/stores/demo";

describe("the capability registry", () => {
  test("ten capabilities, vendor-free labels, 4 inner + 6 outer", () => {
    expect(CAPABILITIES.length).toBe(10);
    expect(CAPABILITIES.filter((c) => c.ring === "inner").length).toBe(4);
    for (const c of CAPABILITIES) {
      expect(c.label).not.toMatch(/argo|grafana|prometheus|cloudflare/i);
    }
  });
  test("no workload claimed by two slices", () => {
    const all = CAPABILITIES.flatMap((c) => c.members);
    expect(new Set(all).size).toBe(all.length);
  });
  test("an unclaimed workload surfaces as unplaced, never silently missing", () => {
    expect(unplaced(DEMO_INVENTORY).map((w) => w.id)).toEqual(["mystery-svc"]);
  });
  test("every cap hue token exists in the generated theme", async () => {
    const fs = await import("node:fs");
    const theme = fs.readFileSync(new URL("../src/theme/theme.css", import.meta.url), "utf8");
    for (const c of CAPABILITIES) expect(theme).toContain(`--cap-${c.id}:`);
  });
});

describe("capability level", () => {
  test("worst-of-members; a memberless slice does not read unknown by accident", () => {
    const cap = CAPABILITIES.find((c) => c.id === "monitoring")!;
    const levels: Record<string, string> = { prometheus: "healthy", grafana: "degraded", alertmanager: "healthy" };
    expect(capabilityLevel(cap, (id) => levels[id] ?? "unknown")).toBe("degraded");
    expect(capabilityLevel(CAPABILITIES.find((c) => c.id === "people")!, () => "unknown")).toBe("healthy");
  });
});

describe("mandala layout", () => {
  test("one slice per capability, on its ring's radius, no overlapping midpoints", () => {
    const slices = layoutSlices();
    expect(slices.length).toBe(10);
    const mids = slices.map((s) => `${s.cx.toFixed(1)},${s.cy.toFixed(1)}`);
    expect(new Set(mids).size).toBe(10);
    for (const s of slices) {
      const r = Math.hypot(s.cx - 50, s.cy - 50);
      expect(Math.abs(r - (s.cap.ring === "inner" ? 26 : 41))).toBeLessThan(0.5);
    }
  });
});
