import { describe, expect, test } from "bun:test";
import { compileNexusSourceSet, type NexusSource } from "../src/nexus/source-set.ts";

function source(id: string): NexusSource {
  return { id, repository: `github.com/example/${id}`, sha: "a".repeat(40), inputsHash: "b".repeat(64),
    profileIdentities: { [id]: { runtime: "eve", subdir: `agents/eve/${id}/src` } },
    dashboard: { contributions: [{ relPath: "dashboard.yaml", doc: {
      apiVersion: "dashboard.hermes-gitops/v1alpha2", kind: "NexusContribution", metadata: { id, title: id },
      spec: { components: [{ id, kind: "agent", title: id, bind: { profile: id } }] },
    } }], views: [{ relPath: "views/default.yaml", doc: {
      apiVersion: "dashboard.hermes-gitops/v1alpha2", kind: "NexusView", metadata: { id: "default" },
      spec: { nodes: [{ ref: id, position: { x: 0, y: 0 } }] },
    } }], icons: [], declared: { [id]: { crons: [] } }, findings: [] },
    topology: { layout: "single", sovereignty: "permissive", agents: [{ id, profile: id,
      scope: "local", target: "local", argoDestination: "in-cluster", namespace: `ag-eve-${id}`, application: `ag-eve-${id}` }],
      apps: [], endpoints: [], bindings: [], findings: [], ok: true },
  };
}
const registry = (s: NexusSource[]) => s.map(x => ({ profile: x.id, repository: x.repository, sha: x.sha,
  ...x.profileIdentities[x.id]! }));

describe("shared Nexus source set", () => {
  test("preserves sibling teams, exact identities and both default views deterministically", () => {
    const sources = [source("social"), source("internal")];
    const result = compileNexusSourceSet(sources, registry(sources));
    expect(result.ok).toBe(true);
    expect(result.plan.components.map(c => c.id)).toEqual(["internal", "social"]);
    expect(result.plan.components.map(c => c.instances[0]?.namespace)).toEqual(["ag-eve-internal", "ag-eve-social"]);
    expect(new Set(result.plan.view.nodes.map(n => n.position.x)).size).toBe(2);
    expect(result.plan.sourceSha).toBe("0".repeat(40));
    expect(result.provenance.map(p => p.sha)).toEqual(sources.map(s => s.sha));
    expect(compileNexusSourceSet([...sources].reverse(), registry(sources).reverse())).toEqual(result);
  });
  test("refuses partial source coverage and an undeployed new team", () => {
    const a = source("social"), b = source("internal");
    expect(() => compileNexusSourceSet([a], registry([a, b]))).toThrow("missing from source set");
    expect(() => compileNexusSourceSet([a, b], registry([a]))).toThrow("does not match");
  });
  test("refuses a newer checkout than the deployed record", () => {
    const a = source("social"), records = registry([a]); a.sha = "c".repeat(40);
    expect(() => compileNexusSourceSet([a], records)).toThrow("does not match");
  });
  test("refuses a same-commit runtime or subdirectory mismatch", () => {
    const a = source("social"), records = registry([a]);
    records[0]!.runtime = "hermes";
    expect(() => compileNexusSourceSet([a], records)).toThrow("runtime and source subdirectory");
    records[0]!.runtime = "eve"; records[0]!.subdir = "legacy/social";
    expect(() => compileNexusSourceSet([a], records)).toThrow("runtime and source subdirectory");
  });
  test("preserves bundled placement instead of inventing per-agent workloads", () => {
    const a = source("social");
    a.bundledProfiles = { social: { bundle: "shared", namespace: "hermes-shared" } };
    const result = compileNexusSourceSet([a], registry([a]));
    expect(result.ok).toBe(true);
    expect(result.plan.components[0]!.instances[0]!.namespace).toBe("hermes-shared");
    expect(result.plan.components[0]!.instances[0]!.application).not.toBe("ag-eve-social");
  });
  test("rejects duplicate identities across repositories", () => {
    const a = source("social"), b = source("internal");
    b.dashboard.contributions[0]!.doc.spec.components![0]!.id = "social";
    b.dashboard.views = [];
    const result = compileNexusSourceSet([a, b], registry([a, b]));
    expect(result.ok).toBe(false);
    expect(result.findings.some(f => f.check === "NEXUS001")).toBe(true);
  });
  test("does not resolve one repository's dangling reference against a sibling", () => {
    const a = source("social"), b = source("internal");
    a.dashboard.contributions[0]!.doc.spec.relationships = [{ id: "cross", from: "social", to: "internal", label: "tracks" }];
    expect(compileNexusSourceSet([a, b], registry([a, b])).ok).toBe(false);
  });
  test("carries source validation failures into the combined result", () => {
    const a = source("social");
    a.topology.findings.push({ profile: "social", check: "TEST", severity: "error", message: "bad topology" });
    expect(compileNexusSourceSet([a], registry([a])).ok).toBe(false);
  });
});
