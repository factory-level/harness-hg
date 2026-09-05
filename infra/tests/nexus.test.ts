// The Nexus dist bundles are provisioned as a ConfigMap, never as chart
// files (#804/#807): the chart projection must not carry them, and the
// bootstrap must find all three - index.js included, because standalone.js
// is a shell that imports it at runtime (the blank-page regression).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  NEXUS_CHART_PATH,
  NEXUS_DIST_FILES,
  nexusDistData,
  projectedCodeChecksum,
} from "../src/components/nexus/index.ts";

describe("nexus dist provisioning", () => {
  test("all three bundles are read from control-plane/nexus/dist", () => {
    const data = nexusDistData();
    expect(Object.keys(data).sort()).toEqual([...NEXUS_DIST_FILES].sort());
    expect(data["index.js"]!.length).toBeGreaterThan(100_000);
    expect(data["standalone.js"]!.length).toBeGreaterThan(10_000);
    expect(data["style.css"]!.length).toBeGreaterThan(10_000);
  });

  test("the chart projection carries no dist file", () => {
    const files = readdirSync(path.join(NEXUS_CHART_PATH, "files"));
    expect(files.filter((f) => f.startsWith("dist__"))).toEqual([]);
    expect(existsSync(path.join(NEXUS_CHART_PATH, "templates", "configmaps.yaml"))).toBe(true);
  });

  test("the code checksum is a sha256 hex", () => {
    expect(projectedCodeChecksum()).toMatch(/^[0-9a-f]{64}$/);
  });
});
