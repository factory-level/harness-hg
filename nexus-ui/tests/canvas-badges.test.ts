// The badge layer's honesty contracts: joins ported from the retired
// dashboard, and the never-an-empty-badge rule.
import { describe, expect, test } from "bun:test";
import {
  alertBell,
  badgeModel,
  bindingsFor,
  peopleFor,
  producerKeyOf,
  publishedHostnames,
  routesFor,
} from "../src/app/workspace/badges";
import type { PlanComponent } from "../src/stores/data";
import type { CommEdge } from "../src/app/communication/model";

const agent: PlanComponent = {
  id: "mkt-manager",
  title: "Marketing Manager",
  kind: "agent",
  bind: { profile: "mkt-manager" },
  links: { repository: "https://github.com/x/y" },
  instances: [{ destinations: { deployed: [{ name: "published", url: "https://m.example" }, { name: "internal", url: "https://i.example" }] } }],
};
const app: PlanComponent = { id: "app-postiz", kind: "application", bind: { profile: "mkt-manager", app: "postiz" } };
const person: PlanComponent = { id: "calvin", title: "Calvin", kind: "person", personTitle: "Operator", accessors: ["mkt-manager"] };

const edges: CommEdge[] = [
  { id: "e1", producer: "mkt-research@feed#topics", kind: "agent", event: "content.topic/v1", target: { profile: "mkt-manager" } },
  { id: "e2", producer: "mkt-manager/postiz@queue#approved", kind: "agent", event: "content.approved/v1", target: { profile: "mkt-engage" } },
  { id: "e3", producer: "mkt-engage@voice#published", kind: "chatops", target: { provider: "discord", space: "#social" } },
  { id: "e4", producer: "alert-router@routes#alarm", kind: "agent", alarmClass: true, event: "observability.alert/v1", target: { profile: "mkt-manager" } },
];

describe("comm joins (carried verbatim)", () => {
  test("an agent RECEIVES: agent edges targeting its profile", () => {
    expect(routesFor(agent, edges).map((e) => e.id)).toEqual(["e1", "e4"]);
  });
  test("an application PRODUCES: composite producer prefix match", () => {
    expect(producerKeyOf(app)).toBe("mkt-manager/postiz");
    expect(routesFor(app, edges).map((e) => e.id)).toEqual(["e2"]);
  });
  test("a bare producer never matches the composite grammar", () => {
    const bare: CommEdge[] = [{ id: "x", producer: "mkt-manager/postiz", kind: "agent" }];
    expect(routesFor(app, bare)).toHaveLength(0);
  });
});

describe("bindings tri-state", () => {
  test("dedupes per repository; a KNOWN state beats unknown", () => {
    const rows = bindingsFor(
      [
        { repository: "r1", targets: [{ profile: "p", mounted: null }] },
        { repository: "r1", targets: [{ profile: "p", mounted: true }] },
        { repository: "r2", targets: [{ profile: "p", mounted: false }, { profile: "other", mounted: true }] },
      ],
      "p",
    );
    expect(rows).toEqual([
      { repository: "r1", mount: "mounted" },
      { repository: "r2", mount: "pending" },
    ]);
  });
});

describe("IAM joins", () => {
  test("published hostnames only - internal destinations do not leak", () => {
    expect(publishedHostnames(agent)).toEqual(["https://m.example"]);
  });
  test("people join through accessors", () => {
    expect(peopleFor("mkt-manager", [agent, app, person]).map((p) => p.id)).toEqual(["calvin"]);
  });
});

describe("the alerting bell is earned twice", () => {
  const health = { components: { "mkt-manager": { level: "healthy", sources: [{ kind: "grafana", status: "configured" }] } }, instances: {}, sources: {} };
  test("alarm route + configured grafana source", () => {
    expect(alertBell(agent, edges, health).map((e) => e.id)).toEqual(["e4"]);
  });
  test("no grafana source, no bell - routing alone is not enough", () => {
    const bare = { components: { "mkt-manager": { level: "healthy" } }, instances: {}, sources: {} };
    expect(alertBell(agent, edges, bare)).toHaveLength(0);
  });
});

describe("never an empty badge", () => {
  const flags = { gh: true, comm: true, iam: true, alert: true };
  test("a component with no rows gets NO domains", () => {
    const bare: PlanComponent = { id: "ghostless", kind: "agent", bind: { profile: "ghostless" } };
    const m = badgeModel(bare, { components: [bare], edges, bindings: [], health: null, flags });
    expect(m).toEqual({});
  });
  test("an unserved data source (null) suppresses its domain even with authored rows", () => {
    const m = badgeModel(agent, { components: [agent], edges: null, bindings: null, health: null, flags });
    expect(m.gh).toBeUndefined();
    expect(m.comm).toBeUndefined();
  });
  test("authored link and attached binding to the same repo merge into one row", () => {
    const m = badgeModel(agent, {
      components: [agent, person],
      edges,
      bindings: [{ repository: "https://github.com/x/y", targets: [{ profile: "mkt-manager", mounted: true }] }],
      health: null,
      flags,
    });
    expect(m.gh?.rows).toHaveLength(1);
    expect(m.gh?.rows[0]).toMatchObject({ label: "repository", href: "https://github.com/x/y", mount: "mounted" });
  });
});
