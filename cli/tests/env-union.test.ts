// One envDir + the bootstrap grants union (ADR 0178, P4). The bundle-blind
// bug had two faces: a topology override in another directory replaced the
// team dir wholesale, and the full-topology return path never carried
// bundledProfiles at all. Both are pinned here, beside the union rules.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yaml } from "yaml";
import { loadEnvironment } from "../src/topology/environment.ts";

const API = "hermes-gitops.factorylevel.dev/agent-team/v1alpha1";
const BUNDLES = {
  version: 4,
  bundles: [{ name: "core", profiles: [{ name: "manager", envSecretRef: "m-env", webhookPort: 8644 }, { name: "research", envSecretRef: "r-env", webhookPort: 8645 }] }],
};
const LEGACY_TOPO = {
  version: 1, layout: "hub-spoke", globalTarget: "ca-west-a",
  regions: [
    { name: "ca-west", jurisdiction: "CA", targets: [{ name: "ca-west-a", argoDestination: "ca-west-a", primary: true }] },
    { name: "eu-west", jurisdiction: "EU", targets: [{ name: "eu-west-a", argoDestination: "eu-west-a", primary: true }] },
  ],
};
const TEAM_TOPO = { apiVersion: API, kind: "Topology", layout: "hub-spoke", hubRegion: "ca-west", regions: [{ name: "ca-west", jurisdiction: "CA" }, { name: "eu-west", jurisdiction: "EU" }] };

function teamRepo(files: Record<string, object>): string {
  const root = mkdtempSync(join(tmpdir(), "env-union-"));
  mkdirSync(join(root, "harness-hg"), { recursive: true });
  writeFileSync(join(root, "harness-hg", "team.yaml"), yaml({ apiVersion: API, kind: "AgentTeam", name: "marketing", displayName: "Marketing", harnesses: ["eve"] }));
  for (const [rel, doc] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), yaml(doc));
  }
  return root;
}

function spec(root: string, grants: object | undefined, version = "v1alpha2"): string {
  const file = join(root, "factory.yaml");
  writeFileSync(file, yaml({
    apiVersion: `hermes-gitops.factorylevel.dev/environment/${version}`, name: "factory", project: "p",
    rootKms: { location: "us", keyring: "k", key: "k" }, state: { deployerGroup: "d@x.dev", agents: ["factory"] },
    infra: { gitopsRepoUrl: "https://x/y.git", providers: { compute: "pod", secret: "k8s", ingress: "none" } },
    ...(grants ? { grants } : {}),
  }));
  return file;
}

describe("one envDir (the bundle-blind regression)", () => {
  test("a topology override in ANOTHER directory keeps the team's bundles", () => {
    const root = teamRepo({ "harness-hg/bundles.yaml": BUNDLES, "evals/environments/hub-spoke/topology.yaml": LEGACY_TOPO });
    const env = loadEnvironment(root, join(root, "evals", "environments", "hub-spoke", "topology.yaml"));
    expect(env.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(env.environment.layout).toBe("hub-spoke");
    expect(env.environment.bundledProfiles?.["research"]?.webhookPort).toBe(8645);
    expect(env.environment.distribution).toEqual({ name: "marketing", displayName: "Marketing" });
  });

  test("a legacy repo with topology.yaml AND bundles.yaml in environment/ is not bundle-blind either", () => {
    const root = mkdtempSync(join(tmpdir(), "env-legacy-"));
    mkdirSync(join(root, "environment"));
    writeFileSync(join(root, "environment", "topology.yaml"), yaml(LEGACY_TOPO));
    writeFileSync(join(root, "environment", "bundles.yaml"), yaml(BUNDLES));
    const env = loadEnvironment(root);
    expect(env.environment.synthesized).toBe(false);
    expect(Object.keys(env.environment.bundledProfiles ?? {})).toEqual(["manager", "research"]);
  });

  test("a named environment variant overrides ONE file beside its topology and nothing else", () => {
    const root = teamRepo({
      "harness-hg/bundles.yaml": BUNDLES,
      "harness-hg/communication.yaml": { version: 1, chatopsConnections: { company: { provider: "recording" } } },
      "environments/sandbox/topology.yaml": LEGACY_TOPO,
      "environments/sandbox/communication.yaml": { version: 1, chatopsConnections: { company: { provider: "slack", credentialRef: { name: "s", key: "k" } } } },
    });
    const env = loadEnvironment(root, join(root, "environments", "sandbox", "topology.yaml"));
    expect(env.environment.communication?.chatopsConnections["company"]?.provider).toBe("slack");
    expect(env.environment.bundledProfiles?.["manager"]).toBeDefined();
  });

  test("a directory override is still read as a whole repository root (the old form)", () => {
    const root = teamRepo({ "harness-hg/bundles.yaml": BUNDLES });
    const env = loadEnvironment(undefined, root);
    expect(env.environment.bundledProfiles?.["manager"]).toBeDefined();
  });
});

describe("team topology + grants (TOPO018/TOPO019)", () => {
  test("no grants: one synthesized target per region; a lone region is in-cluster", () => {
    const one = teamRepo({ "harness-hg/topology.yaml": { ...TEAM_TOPO, layout: "single", hubRegion: undefined, regions: [{ name: "factory", jurisdiction: "NA" }] } });
    const e1 = loadEnvironment(one);
    expect(e1.environment.synthesized).toBe(true);
    expect(e1.environment.targets.map((t) => [t.name, t.region])).toEqual([["in-cluster", "factory"]]);
    expect(e1.environment.globalTarget).toBe("in-cluster");
    const two = teamRepo({ "harness-hg/topology.yaml": TEAM_TOPO });
    const e2 = loadEnvironment(two);
    expect(e2.environment.targets.map((t) => t.name)).toEqual(["ca-west", "eu-west"]);
    expect(e2.environment.globalTarget).toBe("ca-west"); // hubRegion's primary
    expect(e2.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  test("grants supply targets, dns, policy and capabilities; the union is exact", () => {
    const root = teamRepo({
      "harness-hg/topology.yaml": TEAM_TOPO,
      "harness-hg/capabilities.yaml": { version: 1, bindings: { board: { implementation: "kanban", url: "https://board.internal" } } },
    });
    const file = spec(root, {
      targets: { "ca-west": [{ name: "ca-west-a", argoDestination: "ca-west-a", primary: true }], "eu-west": [{ name: "eu-west-a", argoDestination: "eu-west-a" }] },
      dns: { publicBaseDomain: "hermes.example.dev" },
      policy: { allowedChartSources: ["oci://reg/charts"], allowedJurisdictions: ["CA", "EU"] },
      capabilities: { sentiment: { implementation: "ext", url: "https://s.example.com", region: "eu-west" } },
      workspaces: { repositories: [{ name: "vision", source: { url: "https://x/v.git", revision: { mode: "pinned", sha: "a".repeat(40) } }, mount: { path: "/workspaces/vision", access: "read-only" } }], bindings: [{ repository: "vision", profiles: ["manager"], purpose: "strategy" }] },
    });
    const env = loadEnvironment(root, file);
    expect(env.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(env.environment.synthesized).toBe(false);
    expect(env.environment.targets.map((t) => t.argoDestination)).toEqual(["ca-west-a", "eu-west-a"]);
    expect(env.environment.globalTarget).toBe("ca-west-a");
    expect(env.environment.dns.publicBaseDomain).toBe("hermes.example.dev");
    expect(env.environment.policy).toEqual({ allowedChartSources: ["oci://reg/charts"], allowedJurisdictions: ["CA", "EU"] });
    expect(env.environment.capabilityBindings?.map((c) => c.capability).sort()).toEqual(["board", "sentiment"]);
    expect(env.environment.grants?.workspaces?.repositories).toHaveLength(1);
  });

  test("TOPO019 both ways: a team region with no grant, a grant for no region", () => {
    const root = teamRepo({ "harness-hg/topology.yaml": TEAM_TOPO });
    const file = spec(root, { targets: { "ca-west": [{ name: "ca-west-a", argoDestination: "ca-west-a" }], "ap-south": [{ name: "ap-a", argoDestination: "ap-a" }] } });
    const env = loadEnvironment(root, file);
    const topo19 = env.findings.filter((f) => f.check === "TOPO019").map((f) => f.message);
    expect(topo19.some((m) => m.includes("region eu-west is declared by the team but the environment grants it no target"))).toBe(true);
    expect(topo19.some((m) => m.includes("grants targets to region ap-south, which"))).toBe(true);
  });

  test("any grants block is granted mode: a region with no target is TOPO019 even when only dns was granted; globalTarget must name a GRANTED target", () => {
    const root = teamRepo({ "harness-hg/topology.yaml": TEAM_TOPO });
    const dnsOnly = spec(root, { dns: { publicBaseDomain: "x.dev" } });
    const e1 = loadEnvironment(root, dnsOnly);
    expect(e1.findings.filter((f) => f.check === "TOPO019")).toHaveLength(2);
    expect(e1.environment.synthesized).toBe(false);
    const partial = spec(root, { targets: { "ca-west": [{ name: "ca-west-a", argoDestination: "ca-west-a" }] }, globalTarget: "eu-west" });
    const e2 = loadEnvironment(root, partial);
    expect(e2.findings.some((f) => f.message.includes('grants.globalTarget "eu-west" names no granted target'))).toBe(true);
  });

  test("an invalid team.yaml never falls back to the legacy bundles.yaml identity", () => {
    const root = teamRepo({ "harness-hg/bundles.yaml": { ...BUNDLES, distribution: { name: "legacy", displayName: "Legacy" } } });
    writeFileSync(join(root, "harness-hg", "team.yaml"), yaml({ apiVersion: API, kind: "AgentTeam", name: "marketing", displayName: "Marketing", harnesses: [] }));
    expect(loadEnvironment(root).environment.distribution).toBeUndefined();
  });

  test("TOPO018: one capability bound on both sides refuses", () => {
    const root = teamRepo({
      "harness-hg/topology.yaml": TEAM_TOPO,
      "harness-hg/capabilities.yaml": { version: 1, bindings: { board: { implementation: "kanban", url: "https://board.internal" } } },
    });
    const file = spec(root, { targets: { "ca-west": [{ name: "a", argoDestination: "a" }], "eu-west": [{ name: "b", argoDestination: "b" }] }, capabilities: { board: { implementation: "other", url: "https://other" } } });
    const env = loadEnvironment(root, file);
    expect(env.findings.some((f) => f.check === "TOPO018" && f.message.includes("capability board"))).toBe(true);
  });

  test("a legacy topology at the root ignores grants with a warning; a v1alpha1 spec is a finding, not a crash", () => {
    const root = teamRepo({ "harness-hg/topology.yaml": LEGACY_TOPO });
    const file = spec(root, { targets: {} });
    const env = loadEnvironment(root, file);
    expect(env.findings.some((f) => f.severity === "warning" && f.message.includes("grants are ignored"))).toBe(true);
    expect(env.environment.layout).toBe("hub-spoke");
    const old = spec(root, undefined, "v1alpha1");
    const env2 = loadEnvironment(root, old);
    expect(env2.findings.some((f) => f.message.includes("declares no grants"))).toBe(true);
  });

  test("the distribution identity is team.yaml; a disagreeing bundles.yaml block is a finding", () => {
    const root = teamRepo({ "harness-hg/bundles.yaml": { ...BUNDLES, distribution: { name: "other", displayName: "Other" } } });
    const env = loadEnvironment(root);
    expect(env.environment.distribution).toEqual({ name: "marketing", displayName: "Marketing" });
    expect(env.findings.some((f) => f.message.includes('distribution.name "other" disagrees'))).toBe(true);
  });
});
