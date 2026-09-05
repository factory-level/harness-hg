// The preview-time topology gate (#145): compile errors fail preview,
// infrastructure failures degrade with a warning. The deps are injected
// so these tests exercise the DECISION - which of the two happens - not
// git or bun.

import { describe, expect, test } from "bun:test";
import {
  checkAgentTopology,
  groupBySource,
  isLocalSource,
  type SourceGroup,
} from "../src/components/harness/hermes-agent/topology-preview.ts";
import type { AgentSpec } from "../src/control-flow/config.ts";

const agent = (over: Partial<AgentSpec>): AgentSpec => ({
  source: "github.com/acme/personas",
  ref: "main",
  subdir: "",
  name: null,
  overrides: null,
  ...over,
} as AgentSpec);

describe("grouping: one checkout compiles every profile it hosts", () => {
  test("agents sharing (source, ref) collapse to one group", () => {
    const groups = groupBySource([
      agent({ subdir: "distributions/manager", name: "manager" }),
      agent({ subdir: "distributions/research", name: "research" }),
      agent({ source: "github.com/acme/other", name: "solo" }),
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]!.agents).toEqual(["manager", "research"]);
  });

  test("same source at different refs stays two groups - two shas are two contract sets", () => {
    const groups = groupBySource([agent({ ref: "main" }), agent({ ref: "v2" })]);
    expect(groups.length).toBe(2);
  });

  test("local-source detection matches resolveSourceRevision's non-URL prefixes", () => {
    expect(isLocalSource("/home/op/personas")).toBe(true);
    expect(isLocalSource("./personas")).toBe(true);
    expect(isLocalSource("~/personas")).toBe(true);
    expect(isLocalSource("github.com/acme/personas")).toBe(false);
    expect(isLocalSource("https://github.com/acme/personas")).toBe(false);
  });
});

describe("the two failure modes are asymmetric on purpose (#145)", () => {
  const deps = (over: {
    materialize?: (g: SourceGroup) => { root: string } | { skip: string };
    compile?: (root: string, argoDestinations: string[]) => { ok: boolean; output: string };
  }) => {
    const warnings: string[] = [];
    return {
      deps: {
        materialize: over.materialize ?? (() => ({ root: "/tmp/x" })),
        compile: over.compile ?? (() => ({ ok: true, output: "" })),
        warn: (m: string) => warnings.push(m),
      },
      warnings,
    };
  };

  test("a clean compile passes silently", () => {
    const { deps: d, warnings } = deps({});
    checkAgentTopology([agent({ name: "manager" })], [], [], d);
    expect(warnings).toEqual([]);
  });

  test("a compile ERROR throws, carrying the findings and the agents it blocks", () => {
    const { deps: d } = deps({
      compile: () => ({
        ok: false,
        output: "✗ [manager] TOPO004: no provider for capability sre-relay (locality global)",
      }),
    });
    expect(() => checkAgentTopology([agent({ name: "manager" })], [], [], d)).toThrow(/TOPO004/);
    expect(() => checkAgentTopology([agent({ name: "manager" })], [], [], d)).toThrow(/manager/);
    // The message routes the operator: preview is where this fails, by design.
    expect(() => checkAgentTopology([agent({ name: "manager" })], [], [], d)).toThrow(/preview/);
  });

  test("an unfetchable source WARNS and continues - and the warning says the check did not run", () => {
    const { deps: d, warnings } = deps({
      materialize: () => ({ skip: "could not resolve github.com/acme/personas#main to a sha" }),
    });
    checkAgentTopology([agent({ name: "manager" })], [], [], d);
    expect(warnings.length).toBe(1);
    // The dangerous misreading is "preview passed, so the topology is
    // fine" - the warning must forestall exactly that.
    expect(warnings[0]!).toContain("will NOT fail this preview");
  });

  test("the registered cluster names reach the compile - TOPO017's join input (#176)", () => {
    const seen: string[][] = [];
    const { deps: d } = deps({});
    d.compile = (_root: string, argoDestinations: string[]) => {
      seen.push(argoDestinations);
      return { ok: true, output: "" };
    };
    checkAgentTopology([agent({ name: "manager" })], ["eu-west-a", "factory-edge"], [], d);
    expect(seen).toEqual([["eu-west-a", "factory-edge"]]);
  });

  test("an injection colliding with an agentSecrets key fails preview - the chart cannot see those (Codex catch)", () => {
    const { deps: d } = deps({
      compile: () => ({
        ok: true,
        output: "",
        bindings: [
          { capability: "sre-relay", consumer: "manager@global", inject: { env: "HERMES_CAP_SRE_RELAY_URL" } },
          { capability: "board", consumer: "manager@global", inject: { env: "DISCORD_BOT_TOKEN" } },
        ],
      }),
    });
    const run = () =>
      checkAgentTopology([agent({ name: "manager" })], [], ["DISCORD_BOT_TOKEN", "OPENAI_API_KEY"], d);
    expect(run).toThrow(/DISCORD_BOT_TOKEN/);
    expect(run).toThrow(/SHADOW/);
    // The non-colliding injection alone passes.
    const { deps: ok } = deps({
      compile: () => ({
        ok: true,
        output: "",
        bindings: [{ capability: "sre-relay", consumer: "manager@global", inject: { env: "HERMES_CAP_SRE_RELAY_URL" } }],
      }),
    });
    checkAgentTopology([agent({ name: "manager" })], [], ["DISCORD_BOT_TOKEN"], ok);
  });

  test("one broken group fails preview even when another group is fine", () => {
    const { deps: d } = deps({
      compile: (root) => (root === "/bad" ? { ok: false, output: "TOPO005" } : { ok: true, output: "" }),
      materialize: (g) => ({ root: g.source === "/bad" ? "/bad" : "/good" }),
    });
    expect(() =>
      checkAgentTopology([agent({ source: "/good", name: "a" }), agent({ source: "/bad", name: "b" })], [], [], d),
    ).toThrow(/TOPO005/);
  });
});
