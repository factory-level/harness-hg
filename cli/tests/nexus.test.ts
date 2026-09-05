// The Nexus compiler, offline: tmpdir-synthesized repositories (the
// topology.test.ts pattern) through loadDashboard/loadContracts/compile ->
// compileNexus. One negative case per NEXUS rule, multi-region rollup onto
// one logical component, the Grafana uid convention, determinism, and
// schema-validity of the emitted plan against the published
// dashboard-plan/v1alpha1 contract.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yaml } from "yaml";
import Ajv2020 from "ajv/dist/2020";
import { loadContracts } from "../src/topology/contract.ts";
import { loadEnvironment } from "../src/topology/environment.ts";
import { compile, type TopologyPlan } from "../src/topology/compile.ts";
import { loadDashboard } from "../src/nexus/contract.ts";
import { compileNexus, grafanaUid, monitoringUid, type NexusCompileResult } from "../src/nexus/compile.ts";
import { NEXUS_MANAGED_TREES, NEXUS_PLAN_PATH, loadAvatarInventory,
  loadFontInventory, nexusInputsHash, renderNexusTree, selectableAvatarIds } from "../src/nexus/emit.ts";
import { inputsHash as topologyInputsHash, renderTree, writeTree } from "../src/topology/emit.ts";
import { defaultEnvironment } from "../src/topology/environment.ts";
import { PLATFORM_ROOT } from "../src/lib.ts";

// ---------------------------------------------------------------------------
// Fixture builders

const TWO_REGIONS = {
  version: 1,
  layout: "hub-spoke",
  sovereignty: { mode: "permissive" },
  dns: { publicBaseDomain: "hermes.example.dev", privateBaseDomain: "internal.hermes.example.dev" },
  globalTarget: "ca-west-a",
  regions: [
    { name: "ca-west", jurisdiction: "CA", targets: [{ name: "ca-west-a", argoDestination: "ca-west-a", primary: true }] },
    { name: "eu-west", jurisdiction: "EU", targets: [{ name: "eu-west-a", argoDestination: "eu-west-a", primary: true }] },
  ],
};

/** A manager-ish profile: per-region agent with a dashboard endpoint, a
 * per-agent monitoring app, and a singleton board app with a ui endpoint. */
function managerContract(): object {
  return {
    contractVersion: 2,
    topology: {
      supportedLayouts: ["single", "hub-spoke"],
      agent: { multiplicity: "per-region", dataBoundary: "region" },
    },
    endpoints: [{ name: "dashboard", port: 9119, path: "/", type: "authenticated" }],
    apps: [
      {
        name: "monitoring",
        chart: "charts/monitoring",
        repo: "local",
        topology: { multiplicity: "per-agent", dataBoundary: "target" },
      },
      {
        name: "board",
        chart: "board",
        repo: "oci://ghcr.io/example/charts",
        version: "1.0.0",
        topology: { multiplicity: "singleton", dataBoundary: "global" },
        endpoints: [
          { name: "ui", service: "board", port: 80, path: "/", type: "authenticated" },
          { name: "api", service: "board", port: 80, path: "/api", type: "private" },
        ],
      },
    ],
  };
}

interface RepoSpec {
  profiles?: Record<string, object | null>;
  contribution?: object;
  views?: Record<string, object>;
  perProfileComponents?: Record<string, object>;
  crons?: Record<string, object[]>;
  configs?: Record<string, object>;
  /** filename -> bytes, written to repo-level dashboard/icons/ */
  icons?: Record<string, Buffer>;
  /** profile -> (filename -> bytes), written to <subdir>/dashboard/icons/ */
  perProfileIcons?: Record<string, Record<string, Buffer>>;
}

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);

function mkRepo(spec: RepoSpec): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-"));
  for (const [name, ext] of Object.entries(spec.profiles ?? {})) {
    const dir = join(root, "distributions", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "distribution.yaml"), yaml({ name, version: "1.0.0" }));
    if (ext !== null) writeFileSync(join(dir, "hermes-gitops.yaml"), yaml(ext));
    for (const cron of spec.crons?.[name] ?? []) {
      mkdirSync(join(dir, "cron"), { recursive: true });
      writeFileSync(join(dir, "cron", `${(cron as { name: string }).name}.yaml`), yaml(cron));
    }
    if (spec.configs?.[name]) writeFileSync(join(dir, "config.yaml"), yaml(spec.configs[name]!));
    if (spec.perProfileComponents?.[name]) {
      mkdirSync(join(dir, "dashboard"), { recursive: true });
      writeFileSync(join(dir, "dashboard", "components.yaml"), yaml(spec.perProfileComponents[name]!));
    }
    for (const [file, bytes] of Object.entries(spec.perProfileIcons?.[name] ?? {})) {
      mkdirSync(join(dir, "dashboard", "icons"), { recursive: true });
      writeFileSync(join(dir, "dashboard", "icons", file), bytes);
    }
  }
  if (spec.contribution) {
    mkdirSync(join(root, "dashboard"), { recursive: true });
    writeFileSync(join(root, "dashboard", "contribution.yaml"), yaml(spec.contribution));
  }
  for (const [file, bytes] of Object.entries(spec.icons ?? {})) {
    mkdirSync(join(root, "dashboard", "icons"), { recursive: true });
    writeFileSync(join(root, "dashboard", "icons", file), bytes);
  }
  for (const [id, view] of Object.entries(spec.views ?? {})) {
    mkdirSync(join(root, "dashboard", "views"), { recursive: true });
    writeFileSync(join(root, "dashboard", "views", `${id}.yaml`), yaml(view));
  }
  const envDir = join(root, "environment");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, "topology.yaml"), yaml(TWO_REGIONS));
  return root;
}

function topologyFor(root: string): TopologyPlan {
  const { contracts, findings } = loadContracts(root);
  const env = loadEnvironment(root);
  const plan = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
  expect(plan.ok).toBe(true);
  return plan;
}

function compileRepo(root: string, extra?: { workloadEndpoints?: Record<string, { hostname: string }> }): NexusCompileResult {
  const dash = loadDashboard(root);
  const topology = topologyFor(root);
  return compileNexus({ ...dash, topology, ...extra });
}

function contribution(spec: object, id = "acme"): object {
  return {
    apiVersion: "dashboard.hermes-gitops/v1alpha1",
    kind: "NexusContribution",
    metadata: { id, title: "Acme" },
    spec,
  };
}

const MANAGER_CARDS = {
  components: [
    { id: "manager", kind: "agent", title: "Manager", bind: { profile: "manager" } },
    { id: "board", kind: "application", title: "Board", bind: { profile: "manager", app: "board" }, details: { showArgoCd: true } },
  ],
  people: [{ id: "cal", displayName: "Cal", title: "Operator", cohorts: ["ops"], accessors: ["manager", "board"] }],
  groups: [{ id: "ops", title: "Operations", kind: "department" }],
  relationships: [{ id: "manager-runs-board", from: "manager", to: "board", label: "manages" }],
};

// ---------------------------------------------------------------------------

describe("nexus compile", () => {
  test("multi-region agent rolls onto ONE logical component with per-instance destinations", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
      crons: { manager: [{ name: "weekly", schedule: "0 6 * * 1", prompt: "SECRET PROMPT" }] },
      configs: {
        manager: {
          model: { provider: "anthropic", name: "claude-sonnet-4-5" },
          platforms: { discord: { enabled: true }, webhook: { enabled: false } },
        },
      },
    });
    const { plan, findings, ok } = compileRepo(root);
    expect(findings).toEqual([]);
    expect(ok).toBe(true);

    const manager = plan.components.find((c) => c.id === "manager")!;
    expect(manager.kind).toBe("agent");
    expect(manager.resolved).toBe(true);
    expect(manager.instances.map((i) => i.id)).toEqual(["manager@ca-west", "manager@eu-west"]);
    for (const inst of manager.instances) {
      expect(inst.destinations.hermesClassic).toStartWith("https://dashboard.agent-manager-");
      // The agent's Grafana dashboard is its per-agent monitoring app's.
      expect(inst.grafanaDashboardUid).toBe(monitoringUid(inst.namespace!));
    }

    // Declared allowlist: name+schedule only - the prompt never enters the plan.
    expect(manager.crons).toEqual([{ name: "weekly", schedule: "0 6 * * 1" }]);
    expect(manager.configSummary).toEqual({
      profile: "manager",
      modelProvider: "anthropic",
      model: "claude-sonnet-4-5",
      platforms: ["discord"],
      skillCount: 0,
      cronCount: 1,
    });
    expect(JSON.stringify(plan)).not.toContain("SECRET PROMPT");

    const board = plan.components.find((c) => c.id === "board")!;
    expect(board.instances).toHaveLength(1);
    const boardInst = board.instances[0]!;
    expect(boardInst.id).toBe("manager/board@global");
    expect(boardInst.destinations.deployed).toEqual([
      { name: "api", url: expect.stringContaining("https://api.board-manager-global.") },
      { name: "ui", url: expect.stringContaining("https://ui.board-manager-global.") },
    ]);
    expect(boardInst.grafanaDashboardUid).toBe(grafanaUid(boardInst.application!, "board"));

    // People and groups arrive as canvas components without instances.
    expect(plan.components.find((c) => c.id === "cal")!.kind).toBe("human");
    expect(plan.components.find((c) => c.id === "ops")!.groupKind).toBe("department");
  });

  test("monitoringUid matches the monitoring chart, NOT the app convention", () => {
    // control-plane/monitoring/chart/_helpers.tpl: {{ trunc 32 .Release.Namespace |
    // trimSuffix "-" }}-dash. Verified against a live k3d cluster - the
    // rendered ConfigMap for namespace hermes-marketing-sre carries uid
    // hermes-marketing-sre-dash. The app convention would have produced
    // hermes-marketing-sre-monitoring-dash, which does not exist, and
    // every agent card linked to it.
    expect(monitoringUid("hermes-marketing-sre")).toBe("hermes-marketing-sre-dash");
    expect(monitoringUid("hermes-marketing-engagement")).toBe("hermes-marketing-engagement-dash");
    expect(monitoringUid("hermes-marketing-sre")).not.toBe(
      grafanaUid("hermes-marketing-sre", "monitoring"),
    );
    // A truncation landing on a dash must trim it, as trimSuffix does.
    expect(monitoringUid("hermes-marketing-department-xy-")).not.toContain("--dash");
  });

  test("grafanaUid matches the chart template convention exactly", () => {
    // {{ trunc 32 (printf "%s-postiz" "hermes-marketing-engagement-postiz") | trimSuffix "-" }}-dash
    expect(grafanaUid("hermes-marketing-engagement-postiz", "postiz")).toBe("hermes-marketing-engagement-post-dash");
    expect(grafanaUid("hermes-m", "charts/monitoring")).toBe("hermes-m-monitoring-dash");
    // A truncation landing on a dash must trim it (trimSuffix "-").
    expect(grafanaUid("hermes-manager-ca-west-monitorin", "g")).not.toContain("--dash");
  });

  test("unresolved binds stay visible with unknown-health semantics (NEXUS003)", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution({
        components: [{ id: "ghost", kind: "application", title: "Ghost", bind: { profile: "manager", app: "ghost" } }],
      }),
    });
    const { plan, findings, ok } = compileRepo(root);
    expect(ok).toBe(true); // unresolved is a warning, never a silent drop
    expect(findings.map((f) => f.check)).toEqual(["NEXUS003"]);
    const ghost = plan.components.find((c) => c.id === "ghost")!;
    expect(ghost.resolved).toBe(false);
    expect(ghost.instances).toEqual([]);
    expect(ghost.unresolvedReason).toContain("manager/ghost");
  });

  test("duplicate ids across contribution files are errors (NEXUS001)", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution({
        components: [{ id: "manager", kind: "agent", title: "Manager", bind: { profile: "manager" } }],
      }),
      perProfileComponents: {
        manager: contribution(
          { components: [{ id: "manager", kind: "agent", title: "Duplicate", bind: { profile: "manager" } }] },
          "manager",
        ),
      },
    });
    const { findings, ok } = compileRepo(root);
    expect(ok).toBe(false);
    expect(findings.some((f) => f.check === "NEXUS001")).toBe(true);
  });

  test("relationships and view nodes must reference contributed ids (NEXUS002/NEXUS004)", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution({
        components: [{ id: "manager", kind: "agent", title: "Manager", bind: { profile: "manager" } }],
        relationships: [{ id: "r1", from: "manager", to: "nowhere", label: "points at" }],
      }),
      views: {
        default: {
          apiVersion: "dashboard.hermes-gitops/v1alpha1",
          kind: "NexusView",
          metadata: { id: "default" },
          spec: { nodes: [{ ref: "unknown-node", position: { x: 0, y: 0 } }] },
        },
      },
    });
    const { findings, ok } = compileRepo(root);
    expect(ok).toBe(false);
    expect(findings.map((f) => f.check).sort()).toEqual(["NEXUS002", "NEXUS004"]);
  });

  test("missing view auto-places every node deterministically", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
    });
    const { plan } = compileRepo(root);
    expect(plan.view.id).toBe("default");
    expect(plan.view.nodes.map((n) => n.ref)).toEqual(["board", "cal", "manager", "ops"]);
    const again = compileRepo(root);
    expect(JSON.stringify(again.plan)).toBe(JSON.stringify(plan));
  });

  test("unknown endpointNames warn (NEXUS006); the filter selects deployed links", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution({
        components: [
          {
            id: "board",
            kind: "application",
            title: "Board",
            bind: { profile: "manager", app: "board" },
            details: { endpointNames: ["ui", "nope"] },
          },
        ],
      }),
    });
    const { plan, findings } = compileRepo(root);
    expect(findings.map((f) => f.check)).toEqual(["NEXUS006"]);
    expect(plan.components[0]!.instances[0]!.destinations.deployed).toEqual([
      { name: "ui", url: expect.stringContaining("https://ui.") },
    ]);
  });

  test("ADR-40 workload endpoints join as published deployed links", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution({
        components: [{ id: "board", kind: "application", title: "Board", bind: { profile: "manager", app: "board" } }],
      }),
    });
    const { plan } = compileRepo(root, {
      workloadEndpoints: { "manager/board": { hostname: "board.hermes.example.dev" } },
    });
    const deployed = plan.components[0]!.instances[0]!.destinations.deployed!;
    expect(deployed).toContainEqual({ name: "published", url: "https://board.hermes.example.dev" });
  });

  test("duplicate view ids are errors (NEXUS007)", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution({
        components: [{ id: "manager", kind: "agent", title: "Manager", bind: { profile: "manager" } }],
      }),
      views: {
        default: {
          apiVersion: "dashboard.hermes-gitops/v1alpha1",
          kind: "NexusView",
          metadata: { id: "default" },
          spec: { nodes: [{ ref: "manager", position: { x: 1, y: 2 } }] },
        },
        second: {
          apiVersion: "dashboard.hermes-gitops/v1alpha1",
          kind: "NexusView",
          metadata: { id: "default", title: "Impostor" },
          spec: { nodes: [{ ref: "manager", position: { x: 9, y: 9 } }] },
        },
      },
    });
    const { findings, ok } = compileRepo(root);
    expect(ok).toBe(false);
    expect(findings.map((f) => f.check)).toEqual(["NEXUS007"]);
  });

  test("invalid authored files become NEXUS000 findings, not throws", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: {
        apiVersion: "dashboard.hermes-gitops/v1alpha1",
        kind: "NexusContribution",
        metadata: { id: "broken", title: "Broken" },
        spec: { components: [{ id: "x", kind: "spaceship", title: "X", bind: { profile: "manager" } }] },
      },
    });
    const dash = loadDashboard(root);
    expect(dash.contributions).toEqual([]);
    expect(dash.findings.length).toBeGreaterThan(0);
    expect(dash.findings.every((f) => f.check === "NEXUS000" && f.severity === "error")).toBe(true);
    // ...and they survive into the compile result: a partial plan is never ok.
    const result = compileNexus({ ...dash, topology: topologyFor(root) });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.check === "NEXUS000")).toBe(true);
  });

  test("malformed workload-endpoint hostnames are refused, never minted into URLs (NEXUS008)", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution({
        components: [{ id: "board", kind: "application", title: "Board", bind: { profile: "manager", app: "board" } }],
      }),
    });
    const { plan, findings, ok } = compileRepo(root, {
      workloadEndpoints: { "manager/board": { hostname: "https://evil.example.dev/path" } },
    });
    expect(ok).toBe(false);
    expect(findings.map((f) => f.check)).toEqual(["NEXUS008"]);
    expect(JSON.stringify(plan)).not.toContain("evil.example.dev");
  });

  test("view node parents must be contributed groups (NEXUS004)", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution({
        components: [{ id: "manager", kind: "agent", title: "Manager", bind: { profile: "manager" } }],
      }),
      views: {
        default: {
          apiVersion: "dashboard.hermes-gitops/v1alpha1",
          kind: "NexusView",
          metadata: { id: "default" },
          spec: { nodes: [{ ref: "manager", position: { x: 0, y: 0 }, parent: "manager" }] },
        },
      },
    });
    const { findings, ok } = compileRepo(root);
    expect(ok).toBe(false);
    expect(findings.map((f) => f.check)).toEqual(["NEXUS004"]);
  });

  test("the emitted plan validates against the published dashboard-plan schema", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
      views: {
        default: {
          apiVersion: "dashboard.hermes-gitops/v1alpha1",
          kind: "NexusView",
          metadata: { id: "default", title: "Ops" },
          spec: {
            nodes: [{ ref: "manager", position: { x: 100, y: 100 } }],
            viewport: { x: 0, y: 0, zoom: 0.9 },
          },
        },
      },
    });
    const { plan } = compileRepo(root);
    const schema = JSON.parse(
      readFileSync(
        join(PLATFORM_ROOT, "agent-bundle-contracts", "dashboard-plan", "v1alpha1", "plan.schema.json"),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
    const validate = ajv.compile(schema);
    // Round-trip through JSON exactly as emit will serialize it.
    const ok = validate(JSON.parse(JSON.stringify(plan)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("nexus emit", () => {
  function emitBoth(root: string): { out: string } {
    const out = mkdtempSync(join(tmpdir(), "nexus-out-"));
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const topo = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    expect(topo.ok).toBe(true);
    const tree = renderTree(root, contracts, topo, env.environment, { sourceSha: "0".repeat(40) });
    writeTree(out, tree);
    const dash = loadDashboard(root);
    const nexus = compileNexus({ ...dash, topology: topo, inputsHash: nexusInputsHash(root) });
    expect(nexus.ok).toBe(true);
    writeTree(out, renderNexusTree(nexus.plan), NEXUS_MANAGED_TREES);
    return { out };
  }

  test("topology emit and nexus emit coexist - neither prunes the other's tree", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
    });
    const { out } = emitBoth(root);
    expect(readFileSync(join(out, NEXUS_PLAN_PATH), "utf8")).toContain('"version": 1');

    // Re-running topology emit MUST NOT delete the nexus plan...
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const topo = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    const again = writeTree(out, renderTree(root, contracts, topo, env.environment, { sourceSha: "0".repeat(40) }));
    expect(again.deleted).toEqual([]);
    expect(readFileSync(join(out, NEXUS_PLAN_PATH), "utf8")).toContain('"version": 1');

    // ...and re-running nexus emit is a byte-identical no-op that touches
    // nothing of topology's.
    const dash = loadDashboard(root);
    const nexus = compileNexus({ ...dash, topology: topo, inputsHash: nexusInputsHash(root) });
    const rerun = writeTree(out, renderNexusTree(nexus.plan), NEXUS_MANAGED_TREES);
    expect(rerun.written).toEqual([]);
    expect(rerun.deleted).toEqual([]);
    expect(rerun.unchanged).toEqual([NEXUS_PLAN_PATH]);
  });

  test("dashboard files are invisible to the topology compiler and its inputs hash", () => {
    const bare = mkRepo({ profiles: { manager: managerContract() } });
    const withDash = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
    });
    const planOf = (root: string) => {
      const { contracts, findings } = loadContracts(root);
      const env = loadEnvironment(root);
      return compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    };
    expect(JSON.stringify(planOf(withDash))).toBe(JSON.stringify(planOf(bare)));
    expect(topologyInputsHash(withDash)).toBe(topologyInputsHash(bare));
    // The nexus hash, by contrast, MUST see them.
    expect(nexusInputsHash(withDash)).not.toBe(nexusInputsHash(bare));
  });

  test("the emitted plan file round-trips the published schema", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
    });
    const { out } = emitBoth(root);
    const doc = JSON.parse(readFileSync(join(out, NEXUS_PLAN_PATH), "utf8"));
    const schema = JSON.parse(
      readFileSync(join(PLATFORM_ROOT, "agent-bundle-contracts", "dashboard-plan", "v1alpha1", "plan.schema.json"), "utf8"),
    );
    const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
    const validate = ajv.compile(schema);
    expect(validate(doc)).toBe(true);
    expect(doc.inputsHash).toBe(nexusInputsHash(root));
  });
});

// ---------------------------------------------------------------------------

describe("nexus icon assets (design 12 repository-owned icons)", () => {
  test("a stem naming a contributed id is emitted beside the plan, byte-for-byte", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
      icons: { "manager.png": PNG_BYTES, "cal.png": PNG_BYTES, "ops.png": PNG_BYTES },
    });
    const result = compileRepo(root);
    expect(result.ok).toBe(true);
    expect(result.icons.map((i) => i.stem).sort()).toEqual(["cal", "manager", "ops"]);
    const out = mkdtempSync(join(tmpdir(), "nexus-icons-out-"));
    const written = writeTree(out, renderNexusTree(result.plan, result.icons), NEXUS_MANAGED_TREES);
    expect(written.written).toContain(join("deployments/dashboard/assets/icons", "manager.png"));
    expect(readFileSync(join(out, "deployments/dashboard/assets/icons/manager.png")).equals(PNG_BYTES)).toBe(true);
    // Idempotent: binary byte-compare marks a re-run unchanged, and the
    // plan file is untouched by icons (frozen dashboard-plan schema).
    const again = writeTree(out, renderNexusTree(result.plan, result.icons), NEXUS_MANAGED_TREES);
    expect(again.written).toEqual([]);
    expect(readFileSync(join(out, NEXUS_PLAN_PATH), "utf8")).not.toContain("icons");
  });

  test("an unknown stem warns NEXUS012 and is not emitted; a removed icon is pruned", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
      icons: { "manager.png": PNG_BYTES, "nobody.png": PNG_BYTES },
    });
    const result = compileRepo(root);
    expect(result.ok).toBe(true); // warning, never fatal
    expect(result.findings.some((f) => f.check === "NEXUS012" && f.message.includes("nobody"))).toBe(true);
    expect(result.icons.map((i) => i.stem)).toEqual(["manager"]);
    const out = mkdtempSync(join(tmpdir(), "nexus-icons-prune-"));
    writeTree(out, renderNexusTree(result.plan, result.icons), NEXUS_MANAGED_TREES);
    const pruned = writeTree(out, renderNexusTree(result.plan, []), NEXUS_MANAGED_TREES);
    expect(pruned.deleted).toContain(join("deployments/dashboard/assets/icons", "manager.png"));
  });

  test("avatar selection (#426): a known code is silent, an unknown one warns NEXUS013 and only for agents", () => {
    const withIcons = (icon: string, appIcon?: string) =>
      contribution({
        ...MANAGER_CARDS,
        components: [
          { ...MANAGER_CARDS.components[0]!, display: { icon } },
          { ...MANAGER_CARDS.components[1]!, ...(appIcon ? { display: { icon: appIcon } } : {}) },
        ],
      });
    const known = compileNexus({
      ...loadDashboard(mkRepo({ profiles: { manager: managerContract() }, contribution: withIcons("bot-nova") })),
      topology: topologyFor(mkRepo({ profiles: { manager: managerContract() }, contribution: withIcons("bot-nova") })),
      avatarIds: ["bot-nova", "bot-vega"],
    });
    expect(known.findings.filter((f) => f.check === "NEXUS013")).toEqual([]);
    // Unknown agent code warns and names the inventory; the application's
    // Lucide-era icon stays silent - only agents wear avatars.
    const root = mkRepo({ profiles: { manager: managerContract() }, contribution: withIcons("user-cog", "megaphone") });
    const unknown = compileNexus({ ...loadDashboard(root), topology: topologyFor(root), avatarIds: ["bot-nova"] });
    const warns = unknown.findings.filter((f) => f.check === "NEXUS013");
    expect(warns.length).toBe(1);
    expect(unknown.ok).toBe(true); // warn, never fatal
    expect(warns[0]!.message).toContain("user-cog");
    expect(warns[0]!.fix).toContain("bot-nova");
    // No inventory in reach (undefined) -> the check is skipped outright.
    const skipped = compileNexus({ ...loadDashboard(root), topology: topologyFor(root) });
    expect(skipped.findings.filter((f) => f.check === "NEXUS013")).toEqual([]);
  });

  test("the avatar inventory rides the emitted tree and stamps the inputs hash (#426)", () => {
    const dir = mkdtempSync(join(tmpdir(), "avatar-inv-"));
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([128, 0, 128, 0]), Buffer.alloc(16)]);
    writeFileSync(join(dir, "bot-nova.gif"), gif);
    // Same id, second extension: one identity, gif wins (serve parity).
    writeFileSync(join(dir, "bot-nova.webp"), gif);
    writeFileSync(join(dir, "notes.txt"), "not an asset");
    writeFileSync(join(dir, "UPPER.gif"), gif);
    const inventory = loadAvatarInventory(dir);
    expect(inventory.map((a) => a.id)).toEqual(["bot-nova"]);
    expect(inventory[0]!.ext).toBe(".gif");
    // Referenced-ids-only (ADR-104 deferral, executed): only an id an
    // agent component actually wears rides the tree, twin included.
    writeFileSync(join(dir, "bot-nova-still.gif"), gif);
    writeFileSync(join(dir, "bot-unworn.gif"), gif);
    const worn = loadAvatarInventory(dir);
    const cards = {
      ...MANAGER_CARDS,
      components: [
        { ...MANAGER_CARDS.components[0]!, display: { icon: "bot-nova" } },
        ...MANAGER_CARDS.components.slice(1),
      ],
    };
    const root = mkRepo({ profiles: { manager: managerContract() }, contribution: contribution(cards) });
    const result = compileRepo(root);
    const out = mkdtempSync(join(tmpdir(), "avatar-out-"));
    const written = writeTree(out, renderNexusTree(result.plan, result.icons, worn), NEXUS_MANAGED_TREES);
    expect(written.written).toContain(join("deployments/dashboard/assets/avatars", "bot-nova.gif"));
    expect(written.written).toContain(join("deployments/dashboard/assets/avatars", "bot-nova-still.gif"));
    expect(written.written).not.toContain(join("deployments/dashboard/assets/avatars", "bot-unworn.gif"));
    expect(readFileSync(join(out, "deployments/dashboard/assets/avatars/bot-nova.gif")).equals(gif)).toBe(true);
    // A swapped byte is a different emit...
    const h1 = nexusInputsHash(root, { avatarAssets: inventory });
    const h2 = nexusInputsHash(root, { avatarAssets: [{ ...inventory[0]!, bytes: Buffer.from("GIF89adifferent") }] });
    expect(h1).not.toBe(h2);
    // ...and a retired inventory prunes from the managed tree.
    const pruned = writeTree(out, renderNexusTree(result.plan, result.icons, []), NEXUS_MANAGED_TREES);
    expect(pruned.deleted).toContain(join("deployments/dashboard/assets/avatars", "bot-nova.gif"));
  });

  test("a -still twin rides the emitted tree but is not a selectable id (#426 beta pass)", () => {
    // Codex catch: the -still twin must reach the gitops tree (reduced
    // motion needs to fetch it) but must NOT become a NEXUS013-known
    // code - picking "bot-nova-still" itself would have reduced motion
    // request "bot-nova-still-still" and 404.
    const dir = mkdtempSync(join(tmpdir(), "avatar-still-"));
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([128, 0, 128, 0]), Buffer.alloc(16)]);
    writeFileSync(join(dir, "bot-nova.gif"), gif);
    writeFileSync(join(dir, "bot-nova-still.gif"), gif);
    const inventory = loadAvatarInventory(dir);
    expect(inventory.map((a) => a.id).sort()).toEqual(["bot-nova", "bot-nova-still"]);
    expect(selectableAvatarIds(inventory)).toEqual(["bot-nova"]);
  });

  test("the font inventory rides the emitted tree and stamps the inputs hash (#435, ADR-105)", () => {
    const dir = mkdtempSync(join(tmpdir(), "font-inv-"));
    const woff2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(24)]);
    writeFileSync(join(dir, "figtree-latin.woff2"), woff2);
    writeFileSync(join(dir, "notes.txt"), "not an asset");
    writeFileSync(join(dir, "UPPER.woff2"), woff2); // id-shape gate
    const fonts = loadFontInventory(dir);
    expect(fonts.map((f) => f.name)).toEqual(["figtree-latin.woff2"]);
    const root = mkRepo({ profiles: { manager: managerContract() }, contribution: contribution(MANAGER_CARDS) });
    const result = compileRepo(root);
    const out = mkdtempSync(join(tmpdir(), "font-out-"));
    const written = writeTree(out, renderNexusTree(result.plan, result.icons, [], fonts), NEXUS_MANAGED_TREES);
    expect(written.written).toContain(join("deployments/dashboard/assets/fonts", "figtree-latin.woff2"));
    expect(readFileSync(join(out, "deployments/dashboard/assets/fonts/figtree-latin.woff2")).equals(woff2)).toBe(true);
    const h1 = nexusInputsHash(root, { fontAssets: fonts });
    const h2 = nexusInputsHash(root, { fontAssets: [{ name: fonts[0]!.name, bytes: Buffer.from("wOF2x") }] });
    expect(h1).not.toBe(h2);
    const pruned = writeTree(out, renderNexusTree(result.plan, result.icons, [], []), NEXUS_MANAGED_TREES);
    expect(pruned.deleted).toContain(join("deployments/dashboard/assets/fonts", "figtree-latin.woff2"));
  });

  test("a fake .png refuses with NEXUS010 at load time and blocks the compile", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
      icons: { "manager.png": Buffer.from("not a png") },
    });
    const dash = loadDashboard(root);
    expect(dash.findings.some((f) => f.check === "NEXUS010")).toBe(true);
    expect(dash.icons).toEqual([]);
    const result = compileNexus({ ...dash, topology: topologyFor(root) });
    expect(result.ok).toBe(false);
  });

  test("a duplicate stem across repo-level and profile icons warns NEXUS011; first discovered wins", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
      icons: { "manager.png": PNG_BYTES },
      perProfileIcons: { manager: { "manager.png": PNG_BYTES } },
    });
    const result = compileRepo(root);
    expect(result.findings.some((f) => f.check === "NEXUS011")).toBe(true);
    expect(result.icons.filter((i) => i.stem === "manager")).toHaveLength(1);
    expect(result.icons[0]!.relPath).toBe(join("dashboard", "icons", "manager.png"));
  });

  test("a symlinked icon refuses with NEXUS010 - emitter parity", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
    });
    mkdirSync(join(root, "dashboard", "icons"), { recursive: true });
    writeFileSync(join(root, "outside.png"), PNG_BYTES);
    symlinkSync(join(root, "outside.png"), join(root, "dashboard", "icons", "manager.png"));
    const dash = loadDashboard(root);
    expect(dash.findings.some((f) => f.check === "NEXUS010" && f.message.includes("symlink"))).toBe(true);
    expect(dash.icons).toEqual([]);
  });

  test("icon bytes are part of the nexus staleness hash", () => {
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
      icons: { "manager.png": PNG_BYTES },
    });
    const before = nexusInputsHash(root);
    writeFileSync(join(root, "dashboard", "icons", "manager.png"), Buffer.concat([PNG_BYTES, Buffer.from([1])]));
    expect(nexusInputsHash(root)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe("nexus prove (offline legs)", () => {
  test("a compiled, emitted, secret-free repo passes every offline mandatory check", async () => {
    const { proveNexus } = await import("../src/nexus/prove.ts");
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
    });
    const out = mkdtempSync(join(tmpdir(), "nexus-prove-out-"));
    const proofs = mkdtempSync(join(tmpdir(), "nexus-proofs-"));
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const topo = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    // emit first, so plan-current can pass
    const dash = loadDashboard(root);
    const compiled = compileNexus({ ...dash, topology: topo, inputsHash: nexusInputsHash(root) });
    writeTree(out, renderNexusTree(compiled.plan), NEXUS_MANAGED_TREES);

    const report = await proveNexus({
      sourceRoot: root,
      gitopsRoot: out,
      topology: topo,
      topologyFindingsOk: topo.ok,
      proofsRoot: proofs,
      timestamp: "t0",
    });
    expect(report.ok).toBe(true);
    const byId = new Map(report.checks.map((c) => [c.id, c] as const));
    expect(byId.get("contributions-validate")!.status).toBe("pass");
    expect(byId.get("plan-deterministic")!.status).toBe("pass");
    expect(byId.get("plan-current")!.status).toBe("pass");
    expect(byId.get("components-unique")!.status).toBe("pass");
    expect(byId.get("multi-instance-rollup")!.status).toBe("pass"); // per-region manager
    expect(byId.get("agent-destinations")!.status).toBe("pass");
    expect(byId.get("no-secrets-in-plan")!.status).toBe("pass");
    // live legs without --control-plane: unknown, never healthy
    expect(byId.get("nexus-overrides-root")!.status).toBe("unknown");
    expect(byId.get("workspace-roundtrip")!.status).toBe("unknown");
    // artifacts written
    for (const f of ["result.json", "nexus-plan.json", "component-bindings.json", "health-rollup.json", "route-checks.json", "secret-scan.json"]) {
      expect(() => JSON.parse(readFileSync(join(proofs, "t0", f), "utf8"))).not.toThrow();
    }
  });

  test("a stale gitops plan fails the mandatory plan-current check", async () => {
    const { proveNexus } = await import("../src/nexus/prove.ts");
    const root = mkRepo({
      profiles: { manager: managerContract() },
      contribution: contribution(MANAGER_CARDS),
    });
    const out = mkdtempSync(join(tmpdir(), "nexus-prove-stale-"));
    const proofs = mkdtempSync(join(tmpdir(), "nexus-proofs-"));
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const topo = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    const report = await proveNexus({
      sourceRoot: root,
      gitopsRoot: out, // nothing emitted here
      topology: topo,
      topologyFindingsOk: topo.ok,
      proofsRoot: proofs,
      timestamp: "t1",
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "plan-current")!.status).toBe("fail");
  });

  test("secretScan catches credential shapes and clean text passes", async () => {
    const { secretScan } = await import("../src/nexus/prove.ts");
    expect(secretScan("x", "https://user:hunter2secret@host/x")).not.toEqual([]);
    expect(secretScan("x", "ghp_" + "a".repeat(30))).not.toEqual([]);
    expect(secretScan("x", '"apiKey": "abcdefgh12345678"')).not.toEqual([]);
    expect(secretScan("x", JSON.stringify({ url: "https://ui.board.example.dev", token: undefined }))).toEqual([]);
  });
});

describe("nexus features CLI (ADR-43)", () => {
  const cli = join(PLATFORM_ROOT, "cli", "src", "main.ts");
  function run(home: string, ...args: string[]) {
    const proc = Bun.spawnSync(["bun", cli, "nexus", "features", ...args, "--json"], {
      env: { ...process.env, HOME: home },
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  }

  test("lists from the installed registry, flips atomically, rejects unknown ids", () => {
    const home = mkdtempSync(join(tmpdir(), "hg-nexus-feat-"));
    const dash = join(home, ".hermes", "plugins", "hermes-gitops", "dashboard");
    mkdirSync(dash, { recursive: true });
    writeFileSync(
      join(dash, "features.json"),
      JSON.stringify({
        version: 1,
        features: [{ id: "search", title: "Search", milestone: "M5", defaultOff: true }],
      }),
    );
    const list = run(home);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out).features).toEqual([
      { id: "search", title: "Search", milestone: "M5", enabled: false },
    ]);

    const on = run(home, "--enable", "search");
    expect(on.code).toBe(0);
    expect(JSON.parse(on.out).features[0].enabled).toBe(true);
    // The state file is EXACTLY what the plugin backend reads per request.
    const statePath = join(home, ".hermes", "plugins", "hermes-gitops", "state", "features.json");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ version: 1, enabled: { search: true } });

    const off = run(home, "--disable", "all");
    expect(JSON.parse(off.out).features[0].enabled).toBe(false);

    const bad = run(home, "--enable", "nope");
    expect(bad.code).not.toBe(0);

    // --reset restores registry defaults by deleting the state file.
    run(home, "--enable", "search");
    const reset = run(home, "--reset");
    expect(reset.code).toBe(0);
    expect(JSON.parse(reset.out).features[0].enabled).toBe(false);
  });
});

function contributionV2(spec: object, id = "acme"): object {
  return {
    apiVersion: "dashboard.hermes-gitops/v1alpha2",
    kind: "NexusContribution",
    metadata: { id, title: "Acme" },
    spec,
  };
}

describe("nexus links (contribution v1alpha2, ADR-43)", () => {
  test("clean links carry into a version-2 plan; v1alpha1 input stays version 1 with no links key", () => {
    const v1 = compileRepo(mkRepo({ profiles: { manager: managerContract() }, contribution: contribution(MANAGER_CARDS) }));
    expect(v1.ok).toBe(true);
    expect(v1.plan.version).toBe(1);
    expect(JSON.stringify(v1.plan)).not.toContain('"links"');

    const cards = structuredClone(MANAGER_CARDS) as { components: Record<string, unknown>[] };
    cards.components[0]!.links = { repository: "https://github.com/acme/agents", docs: "https://acme.dev/docs" };
    const out = compileRepo(mkRepo({ profiles: { manager: managerContract() }, contribution: contributionV2(cards) }));
    expect(out.ok).toBe(true);
    expect(out.plan.version).toBe(2);
    const manager = out.plan.components.find((c) => c.id === "manager")!;
    expect(manager.links).toEqual({ repository: "https://github.com/acme/agents", docs: "https://acme.dev/docs" });
  });

  test("a v1alpha2 contribution WITHOUT links still emits a version-1 plan", () => {
    const out = compileRepo(mkRepo({ profiles: { manager: managerContract() }, contribution: contributionV2(MANAGER_CARDS) }));
    expect(out.ok).toBe(true);
    expect(out.plan.version).toBe(1);
  });

  test("dirty links are refused: http (schema), userinfo/query/fragment (NEXUS009)", () => {
    for (const url of [
      "http://acme.dev/repo",
      "https://user@acme.dev/repo",
      "https://acme.dev/repo?x=1",
      "https://acme.dev/repo#frag",
    ]) {
      const cards = structuredClone(MANAGER_CARDS) as { components: Record<string, unknown>[] };
      cards.components[0]!.links = { repository: url };
      const out = compileRepo(mkRepo({ profiles: { manager: managerContract() }, contribution: contributionV2(cards) }));
      expect(out.ok).toBe(false);
      expect(out.findings.some((f) => f.check === "NEXUS009" || f.check === "NEXUS000")).toBe(true);
    }
  });

  test("a v1alpha1 file declaring links fails its own schema - the widening is opt-in", () => {
    const cards = structuredClone(MANAGER_CARDS) as { components: Record<string, unknown>[] };
    cards.components[0]!.links = { repository: "https://acme.dev/repo" };
    const out = compileRepo(mkRepo({ profiles: { manager: managerContract() }, contribution: contribution(cards) }));
    expect(out.ok).toBe(false);
    expect(out.findings.some((f) => f.check === "NEXUS000")).toBe(true);
  });
});

// The install source is pinned so a re-home cannot silently break
// `hg nexus install` again: the #732 flip retired the old dashboard tree but
// left command.ts copying from it, and nothing failed until a fresh
// machine ran install (#736). Asserting the payload's key files exist
// at the constant keeps the constant honest.
describe("nexus install source (#736)", () => {
  test("NEXUS_PLUGIN_SRC names the re-homed installable unit", async () => {
    const { NEXUS_PLUGIN_SRC } = await import("../src/nexus/command.ts");
    const fs = await import("node:fs");
    const path = await import("node:path");
    expect(NEXUS_PLUGIN_SRC.endsWith(path.join("control-plane", "nexus"))).toBe(true);
    for (const f of ["manifest.json", "features.json", "plugin_api.py", "dist"]) {
      expect(fs.existsSync(path.join(NEXUS_PLUGIN_SRC, f))).toBe(true);
    }
  });
});
