// Agents directory contracts, fixture-tested.
import { describe, expect, test } from "bun:test";
import { agentLevel, applyFilters, bundleOf, groupLevel, groups } from "../src/app/agents/model";
import { DEMO_DATA, DEMO_HEALTH } from "../src/stores/demo";

describe("grouping", () => {
  test("bundles group by membership; unbundled agents get their own bucket", () => {
    const gs = groups(DEMO_DATA);
    expect(gs.map((g) => g.id)).toEqual(["bundle:marketing", "bucket:unbundled"]);
    expect(gs[0].agents.map((a) => a.id)).toEqual(["mkt-manager", "mkt-research"]);
    expect(gs[1].agents.map((a) => a.id)).toEqual(["mkt-engage"]);
  });
  test("bundleOf resolves membership, null when unbundled", () => {
    expect(bundleOf(DEMO_DATA, "mkt-manager")?.title).toBe("Marketing Team");
    expect(bundleOf(DEMO_DATA, "mkt-engage")).toBeNull();
  });
});

describe("levels come from the server, never the browser", () => {
  test("group pill reads the SERVED rollup", () => {
    expect(groupLevel(DEMO_HEALTH, "bundle:marketing")).toBe("degraded");
  });
  test("a missing rollup is unknown, not a computed fold", () => {
    expect(groupLevel(DEMO_HEALTH, "bundle:nope")).toBe("unknown");
  });
  test("an agent absent from the overlay is unknown", () => {
    expect(agentLevel(DEMO_HEALTH, "ghost")).toBe("unknown");
  });
});

describe("filters", () => {
  test("level filter narrows rows; empty groups vanish", () => {
    const gs = applyFilters(groups(DEMO_DATA), DEMO_HEALTH, { level: "degraded", bundle: null });
    expect(gs.map((g) => g.id)).toEqual(["bundle:marketing"]);
    expect(gs[0].agents.map((a) => a.id)).toEqual(["mkt-research"]);
  });
});

// The wire's bundles is a MAP (plugin_api bundle_membership) - the
// live factory's Agents view threw "not iterable" on it. The store
// normalizes; the model groups by membership either way.
describe("bundles wire shape", () => {
  test("a membership map normalizes into groups", async () => {
    const { groups } = await import("../src/app/agents/model");
    const { normalizeBundles } = await import("../src/stores/data");
    const normalized = normalizeBundles({ core: { namespace: "hermes-core", profiles: ["a1"] } });
    expect(normalized).toEqual([{ id: "core", title: "core", members: ["a1"] }]);
    const data = {
      demo: false, canWrite: true, links: {}, features: {}, capabilities: {},
      plan: { components: [{ id: "a1", kind: "agent", title: "A1" }, { id: "a2", kind: "agent", title: "A2" }] },
      bundles: [{ id: "core", title: "core", members: ["a1"] }],
    };
    const gs = groups(data as never);
    expect(gs.map((g) => g.id)).toEqual(["bundle:core", "bucket:unbundled"]);
  });
});
