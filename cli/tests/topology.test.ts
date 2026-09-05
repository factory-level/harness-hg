// The topology compiler, offline: tmpdir-synthesized repositories (the
// eval.test.ts pattern) through loadContracts/loadEnvironment/compile.
// One negative case per TOPO rule, the v1-adaptation parity guarantee
// (today's fleet shape reproduced exactly), determinism, and the
// two-region hub-spoke reference acceptance from design 10.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yaml } from "yaml";
import { discoverContractDirs, loadContracts } from "../src/topology/contract.ts";
import { defaultEnvironment, loadEnvironment } from "../src/topology/environment.ts";
import { compile, k8sName, type TopologyPlan } from "../src/topology/compile.ts";
import { compileCommunication } from "../src/topology/communication.ts";

// ---------------------------------------------------------------------------
// Fixture builders

function mkRepo(
  profiles: Record<string, object | null>,
  envTopology?: object,
  envPolicy?: object,
  envCapabilities?: object,
): string {
  const root = mkdtempSync(join(tmpdir(), "topo-"));
  for (const [name, ext] of Object.entries(profiles)) {
    const dir = join(root, "distributions", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "distribution.yaml"), yaml({ name, version: "1.0.0" }));
    if (ext !== null) writeFileSync(join(dir, "hermes-gitops.yaml"), yaml(ext));
  }
  if (envTopology || envCapabilities) {
    const envDir = join(root, "environment");
    mkdirSync(envDir, { recursive: true });
    if (envTopology) writeFileSync(join(envDir, "topology.yaml"), yaml(envTopology));
    if (envPolicy) writeFileSync(join(envDir, "policy.yaml"), yaml(envPolicy));
    if (envCapabilities) writeFileSync(join(envDir, "capabilities.yaml"), yaml(envCapabilities));
  }
  return root;
}

function planFor(root: string, layout?: "single" | "replicated" | "hub-spoke"): TopologyPlan {
  const { contracts, findings } = loadContracts(root);
  const env = loadEnvironment(root);
  return compile(contracts, env.environment, { layout, priorFindings: [...findings, ...env.findings] });
}

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

// The four-persona reference contracts (the shape PR-5.2 migrates the real
// repo to - kept in lockstep with design 10 §reference).
function referencePersonas(): Record<string, object> {
  const monitoring = (extra?: object) => ({
    name: "monitoring",
    chart: "charts/monitoring",
    repo: "local",
    ...(extra ?? {}),
  });
  const needsAlerts = {
    capability: "alert-receiver",
    locality: "same-region",
    inject: { appValue: { app: "monitoring", path: "alert.webhookUrl" } },
  };
  return {
    "marketing-manager": {
      contractVersion: 2,
      topology: { supportedLayouts: ["single", "hub-spoke"], agent: { multiplicity: "per-region", dataBoundary: "region" } },
      apps: [
        monitoring(),
        {
          name: "content-kanban",
          chart: "content-kanban",
          repo: "oci://ghcr.io/factory-level/charts",
          version: "0.3.0",
          topology: { multiplicity: "singleton", dataBoundary: "global" },
          endpoints: [
            { name: "api", service: "content-kanban", port: 80, path: "/api", type: "private", provides: "content-board" },
            { name: "ui", service: "content-kanban", port: 80, type: "authenticated" },
          ],
        },
      ],
      requires: [
        needsAlerts,
        {
          capability: "alert-receiver",
          locality: "same-region",
          inject: { appValue: { app: "content-kanban", path: "alerts.webhookUrl" } },
        },
        { capability: "content-board", inject: { env: "HERMES_CAP_CONTENT_BOARD_URL" } },
      ],
    },
    "marketing-research": {
      contractVersion: 2,
      topology: { supportedLayouts: ["single", "hub-spoke"], agent: { multiplicity: "per-region", dataBoundary: "region" } },
      apps: [monitoring()],
      requires: [needsAlerts, { capability: "content-board", inject: { env: "HERMES_CAP_CONTENT_BOARD_URL" } }],
    },
    "marketing-engagement": {
      contractVersion: 2,
      topology: { supportedLayouts: ["single", "hub-spoke"], agent: { multiplicity: "per-region", dataBoundary: "region" } },
      apps: [
        monitoring(),
        {
          name: "postiz",
          chart: "postiz",
          repo: "oci://ghcr.io/factory-level/charts",
          version: "0.2.0",
          topology: { multiplicity: "singleton", dataBoundary: "global" },
          endpoints: [{ name: "api", service: "postiz", port: 5000, path: "/api/public/v1", type: "private", provides: "publishing-api" }],
        },
      ],
      requires: [
        needsAlerts,
        {
          capability: "alert-receiver",
          locality: "same-region",
          inject: { appValue: { app: "postiz", path: "alerts.webhookUrl" } },
        },
        { capability: "content-board", inject: { env: "HERMES_CAP_CONTENT_BOARD_URL" } },
        { capability: "publishing-api", inject: { env: "HERMES_CAP_PUBLISHING_API_URL" } },
      ],
    },
    "marketing-sre": {
      contractVersion: 2,
      topology: { supportedLayouts: ["single", "hub-spoke"], agent: { multiplicity: "per-region", dataBoundary: "region" } },
      endpoints: [
        { name: "hooks", port: 8644, path: "/webhooks/alerts", type: "webhook", signature: "hmac-sha256", provides: "alert-webhook" },
      ],
      apps: [
        monitoring(),
        {
          name: "relay",
          chart: "marketing-sre-relay",
          repo: "oci://ghcr.io/factory-level/charts",
          version: "0.2.0",
          topology: { multiplicity: "per-region", dataBoundary: "region" },
          endpoints: [{ name: "alerts", service: "relay", port: 80, path: "/alert", type: "internal", provides: "alert-receiver" }],
        },
      ],
      requires: [
        needsAlerts,
        // the relay forwards into ITS OWN region's agent webhook route -
        // replacing the hardcoded chart-default targetUrl
        {
          capability: "alert-webhook",
          locality: "same-region",
          inject: { appValue: { app: "relay", path: "targetUrl" } },
        },
      ],
    },
  };
}

const errs = (plan: TopologyPlan, rule: string) =>
  plan.findings.filter((f) => f.check === rule && f.severity === "error");

// ---------------------------------------------------------------------------

describe("v1 adaptation parity", () => {
  test("a legacy repo under the default environment reproduces today's fleet", () => {
    const root = mkRepo({
      "persona-a": {
        apps: [{ name: "monitoring", chart: "charts/monitoring", repo: "local" }],
        expose: { services: [{ name: "dashboard", port: 9119, path: "/" }], access: { policy: "service-token" } },
        backup: { schedule: "0 3 * * *" },
      },
      "persona-b": null, // no hermes-gitops.yaml at all - still a valid contract
    });
    const plan = planFor(root);
    expect(plan.ok).toBe(true);
    expect(plan.agents.map((a) => a.namespace)).toEqual(["hermes-persona-a", "hermes-persona-b"]);
    expect(plan.agents.map((a) => a.application)).toEqual(["hermes-persona-a", "hermes-persona-b"]);
    expect(plan.agents.every((a) => a.argoDestination === "in-cluster")).toBe(true);
    // per-agent app rides in the agent's namespace under the legacy child name
    const mon = plan.apps.find((a) => a.app === "monitoring")!;
    expect(mon.namespace).toBe("hermes-persona-a");
    expect(mon.application).toBe("hermes-persona-a-monitoring");
    // adapted expose: service-token policy => external type, agent-backed
    const dash = plan.endpoints.find((e) => e.endpoint === "dashboard")!;
    expect(dash.type).toBe("external");
    expect(dash.internalUrl).toBe("http://hermes-persona-a.hermes-persona-a.svc.cluster.local:9119");
  });
});

describe("TOPO rules", () => {
  test("TOPO001 unsupported layout", () => {
    const root = mkRepo({ p: { contractVersion: 2, topology: { supportedLayouts: ["single"] } } }, TWO_REGIONS);
    expect(errs(planFor(root, "replicated"), "TOPO001").length).toBe(1);
  });

  test("TOPO002 singleton without globalTarget", () => {
    const env = { ...TWO_REGIONS, layout: "hub-spoke" as const };
    const { globalTarget: _drop, ...noHub } = env;
    const root = mkRepo(
      {
        p: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } },
          apps: [{ name: "kv", chart: "kv", repo: "oci://r.example/c", version: "1.0.0", topology: { multiplicity: "singleton" } }],
        },
      },
      noHub,
    );
    expect(errs(planFor(root), "TOPO002").length).toBe(1);
  });

  test("TOPO004 missing provider / TOPO005 ambiguous provider", () => {
    const base = {
      contractVersion: 2,
      topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } },
    };
    const missing = mkRepo(
      { p: { ...base, requires: [{ capability: "nowhere", inject: { env: "HERMES_CAP_NOWHERE_URL" } }] } },
      TWO_REGIONS,
    );
    expect(errs(planFor(missing), "TOPO004").length).toBe(2); // one per agent instance

    const ambiguous = mkRepo(
      {
        p: {
          ...base,
          endpoints: [
            { name: "a", port: 1000, type: "private", provides: "cap" },
            { name: "b", port: 1001, type: "private", provides: "cap" },
          ],
          requires: [{ capability: "cap", inject: { env: "HERMES_CAP_CAP_URL" } }],
        },
      },
      TWO_REGIONS,
    );
    expect(errs(planFor(ambiguous), "TOPO005").length).toBeGreaterThan(0);
  });

  test("a contractVersion: 5 file validates against v1alpha5 and compiles like v4 (ADR-149)", () => {
    const root = mkRepo(
      {
        p: {
          contractVersion: 5,
          topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } },
          requires: [{ capability: "nowhere", optional: true, inject: { env: "HERMES_CAP_NOWHERE_URL" } }],
        },
        // a v5 file must NOT carry a runtime kind other than eve
        q: { contractVersion: 5, runtime: { kind: "hermes" } },
      },
      TWO_REGIONS,
    );
    const { contracts, findings } = loadContracts(root);
    expect(contracts.map((c) => c.profile)).toEqual(["p"]);
    expect(contracts[0]!.contractVersion).toBe(5);
    expect(contracts[0]!.runtime).toBe("hermes");
    expect(findings.filter((f) => f.profile === "q" && f.check === "contract-schema").length).toBeGreaterThan(0);
    // the only error is q's schema finding - p itself compiles clean
    const plan = planFor(root);
    expect(plan.findings.filter((f) => f.severity === "error").every((f) => f.check === "contract-schema")).toBe(true);
    expect(errs(plan, "TOPO004").length).toBe(0);
  });

  test("an unsatisfied OPTIONAL requirement is a warning and an absent binding, never TOPO004 (v1alpha4)", () => {
    const base = {
      contractVersion: 4,
      topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } },
    };
    const root = mkRepo(
      {
        p: {
          ...base,
          requires: [{ capability: "nowhere", optional: true, inject: { env: "HERMES_CAP_NOWHERE_URL" } }],
        },
      },
      TWO_REGIONS,
    );
    const plan = planFor(root);
    expect(plan.ok).toBe(true); // no error-severity finding
    expect(errs(plan, "TOPO004").length).toBe(0);
    expect(plan.bindings.filter((b) => b.capability === "nowhere").length).toBe(0);
    // Visible, never silent: the operator reading the plan sees WHY the
    // variable is absent, per consumer instance.
    const warns = plan.findings.filter((f) => f.check === "TOPO004" && f.severity === "warning");
    expect(warns.length).toBe(2); // one per agent instance (two regions)
    expect(warns[0]!.message).toContain("HERMES_CAP_NOWHERE_URL");
    expect(warns[0]!.message).toContain("will be absent");
  });

  test("a SATISFIED optional requirement binds exactly like a mandatory one", () => {
    const root = mkRepo(
      {
        provider: {
          contractVersion: 4,
          topology: { supportedLayouts: ["hub-spoke"] },
          apps: [
            {
              name: "feed",
              chart: "feed",
              repo: "oci://r.example/c",
              version: "1.0.0",
              topology: { multiplicity: "singleton", dataBoundary: "global" },
              endpoints: [{ name: "api", service: "feed", port: 80, type: "private", provides: "sentiment-feed" }],
            },
          ],
        },
        consumer: {
          contractVersion: 4,
          topology: { supportedLayouts: ["hub-spoke"] },
          requires: [{ capability: "sentiment-feed", optional: true, inject: { env: "HERMES_CAP_SENTIMENT_FEED_URL" } }],
        },
      },
      TWO_REGIONS,
    );
    const plan = planFor(root, "hub-spoke");
    expect(plan.ok).toBe(true);
    expect(plan.bindings.filter((b) => b.capability === "sentiment-feed").length).toBeGreaterThan(0);
  });

  test("TOPO017: a destination the control plane never registered fails, naming the config to add (#176)", () => {
    const root = mkRepo(
      { p: { contractVersion: 2, topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } } } },
      TWO_REGIONS,
    );
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    // The caller knows only ca-west-a is registered: eu-west-a must fail.
    const plan = compile(contracts, env.environment, {
      layout: "hub-spoke",
      priorFindings: [...findings, ...env.findings],
      knownArgoDestinations: ["ca-west-a"],
    });
    const topo17 = errs(plan, "TOPO017");
    expect(topo17.length).toBe(1);
    expect(topo17[0]!.message).toContain("eu-west-a");
    expect(topo17[0]!.fix).toContain("targetClusters");
    // Registering it clears the finding; in-cluster is implicit.
    const ok = compile(contracts, env.environment, {
      layout: "hub-spoke",
      priorFindings: [...findings, ...env.findings],
      knownArgoDestinations: ["ca-west-a", "eu-west-a"],
    });
    expect(errs(ok, "TOPO017").length).toBe(0);
    // A caller that cannot know (standalone CLI, no option) stays silent.
    const silent = compile(contracts, env.environment, {
      layout: "hub-spoke",
      priorFindings: [...findings, ...env.findings],
    });
    expect(errs(silent, "TOPO017").length).toBe(0);
  });

  test("TOPO017: the default single-target environment passes with zero registered clusters - in-cluster is implicit", () => {
    const root = mkRepo({ p: null });
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const plan = compile(contracts, env.environment, {
      priorFindings: [...findings, ...env.findings],
      knownArgoDestinations: [],
    });
    expect(errs(plan, "TOPO017").length).toBe(0);
  });

  test("an environment binding satisfies a requirement nothing else provides (ADR-98)", () => {
    const root = mkRepo(
      {
        consumer: {
          contractVersion: 4,
          topology: { supportedLayouts: ["hub-spoke"] },
          requires: [{ capability: "sentiment-feed", inject: { env: "HERMES_CAP_SENTIMENT_FEED_URL" } }],
        },
      },
      TWO_REGIONS,
      undefined,
      {
        version: 1,
        bindings: {
          "sentiment-feed": { implementation: "external-sentiment-api", url: "https://sentiment.example.net/v1" },
        },
      },
    );
    const plan = planFor(root, "hub-spoke");
    expect(plan.ok).toBe(true);
    const bind = plan.bindings.find((b) => b.capability === "sentiment-feed")!;
    expect(bind.provider).toBe("environment:sentiment-feed");
    expect(bind.url).toBe("https://sentiment.example.net/v1");
  });

  test("BOTH a profile endpoint and an environment binding is TOPO005, never precedence", () => {
    const root = mkRepo(
      {
        provider: {
          contractVersion: 4,
          topology: { supportedLayouts: ["hub-spoke"] },
          endpoints: [{ name: "api", port: 80, type: "private", provides: "sentiment-feed" }],
        },
        consumer: {
          contractVersion: 4,
          topology: { supportedLayouts: ["hub-spoke"] },
          requires: [{ capability: "sentiment-feed", inject: { env: "HERMES_CAP_SENTIMENT_FEED_URL" } }],
        },
      },
      TWO_REGIONS,
      undefined,
      {
        version: 1,
        bindings: {
          "sentiment-feed": { implementation: "external-sentiment-api", url: "https://sentiment.example.net/v1" },
        },
      },
    );
    const plan = planFor(root, "hub-spoke");
    const topo5 = errs(plan, "TOPO005");
    expect(topo5.length).toBeGreaterThan(0);
    // The message names both sources - the fix is in the declarations.
    expect(topo5[0]!.message).toContain("environment/capabilities.yaml");
  });

  test("an environment binding never satisfies same-target, and a regional one respects same-region", () => {
    const mk = (locality: string, region?: string) =>
      mkRepo(
        {
          consumer: {
            contractVersion: 4,
            topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } },
            requires: [{ capability: "work-queue", locality, inject: { env: "HERMES_CAP_WORK_QUEUE_URL" } }],
          },
        },
        TWO_REGIONS,
        undefined,
        {
          version: 1,
          bindings: {
            "work-queue": {
              implementation: "managed-redis",
              url: "http://redis.internal:6379",
              ...(region ? { region } : {}),
            },
          },
        },
      );
    // same-target can never match a binding with no target.
    expect(errs(planFor(mk("same-target"), "hub-spoke"), "TOPO004").length).toBeGreaterThan(0);
    // same-region: the ca-west binding satisfies the ca-west instance and
    // fails the eu-west one - one TOPO004, not zero, not two.
    expect(errs(planFor(mk("same-region", "ca-west"), "hub-spoke"), "TOPO004").length).toBe(1);
  });

  test("a binding whose region is undeclared is an environment error, not a consumer TOPO004", () => {
    const root = mkRepo(
      { consumer: { contractVersion: 4, topology: { supportedLayouts: ["hub-spoke"] } } },
      TWO_REGIONS,
      undefined,
      {
        version: 1,
        bindings: {
          "work-queue": { implementation: "managed-redis", url: "http://redis.internal:6379", region: "mars" },
        },
      },
    );
    const plan = planFor(root, "hub-spoke");
    const envErrs = plan.findings.filter((f) => f.check === "environment" && f.severity === "error");
    expect(envErrs.length).toBe(1);
    expect(envErrs[0]!.message).toContain("mars");
  });

  test("TOPO006 strict sovereignty rejects cross-region bindings", () => {
    const strict = { ...TWO_REGIONS, sovereignty: { mode: "strict" } };
    const root = mkRepo(
      {
        provider: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"] },
          apps: [
            {
              name: "board",
              chart: "board",
              repo: "oci://r.example/c",
              version: "1.0.0",
              topology: { multiplicity: "singleton", dataBoundary: "global" },
              endpoints: [{ name: "api", service: "board", port: 80, type: "private", provides: "board" }],
            },
          ],
        },
        consumer: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } },
          requires: [{ capability: "board", inject: { env: "HERMES_CAP_BOARD_URL" } }],
        },
      },
      strict,
    );
    const plan = planFor(root);
    // the eu-west consumer crosses into ca-west (the hub)
    expect(errs(plan, "TOPO006").length).toBe(1);
    expect(plan.ok).toBe(false);
  });

  test("TOPO007 disallowed jurisdiction / TOPO008 chart-source policy", () => {
    const root = mkRepo(
      {
        p: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"] },
          apps: [{ name: "x", chart: "x", repo: "oci://rogue.example/c", version: "1.0.0" }],
        },
      },
      TWO_REGIONS,
      { allowedChartSources: ["oci://ghcr.io/factory-level/charts"], allowedJurisdictions: ["CA"] },
    );
    const plan = planFor(root);
    expect(errs(plan, "TOPO007").length).toBe(1); // EU target not allowed
    expect(errs(plan, "TOPO008").length).toBe(1); // rogue registry
  });

  test("TOPO009 URL collisions and duplicate endpoint names", () => {
    const root = mkRepo(
      {
        p: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"] },
          endpoints: [
            { name: "dup", port: 1000, type: "authenticated" },
            { name: "dup", port: 1001, type: "authenticated" },
          ],
        },
      },
      TWO_REGIONS,
    );
    expect(errs(planFor(root), "TOPO009").length).toBeGreaterThan(0);
  });

  test("TOPO012 data boundary narrower than consumption", () => {
    const root = mkRepo(
      {
        provider: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"] },
          apps: [
            {
              name: "store",
              chart: "store",
              repo: "oci://r.example/c",
              version: "1.0.0",
              // singleton compute, but state must stay in one region -
              // consumed from the other region = contradiction even
              // under permissive sovereignty
              topology: { multiplicity: "singleton", dataBoundary: "region" },
              endpoints: [{ name: "api", service: "store", port: 80, type: "private", provides: "store" }],
            },
          ],
        },
        consumer: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } },
          requires: [{ capability: "store", inject: { env: "HERMES_CAP_STORE_URL" } }],
        },
      },
      TWO_REGIONS,
    );
    expect(errs(planFor(root), "TOPO012").length).toBe(1);
  });

  test("TOPO016 cross-cluster binding needs a reachable URL projection", () => {
    const noPrivateDns = { ...TWO_REGIONS, dns: { publicBaseDomain: "hermes.example.dev" } };
    const root = mkRepo(
      {
        provider: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"] },
          apps: [
            {
              name: "board",
              chart: "board",
              repo: "oci://r.example/c",
              version: "1.0.0",
              topology: { multiplicity: "singleton", dataBoundary: "global" },
              // private + no privateBaseDomain => only a cluster-DNS URL,
              // unreachable from the other region's cluster
              endpoints: [{ name: "api", service: "board", port: 80, type: "private", provides: "board" }],
            },
          ],
        },
        consumer: {
          contractVersion: 2,
          topology: { supportedLayouts: ["hub-spoke"], agent: { multiplicity: "per-region" } },
          requires: [{ capability: "board", inject: { env: "HERMES_CAP_BOARD_URL" } }],
        },
      },
      noPrivateDns,
    );
    const plan = planFor(root);
    expect(errs(plan, "TOPO016").length).toBe(1); // the eu-west consumer only
    // the hub-region consumer still binds over cluster DNS
    expect(plan.bindings.filter((b) => b.capability === "board").length).toBe(1);
  });

  test("single layout with several targets is an environment error, not a collision storm", () => {
    const root = mkRepo(
      { p: { contractVersion: 2, topology: { supportedLayouts: ["single"] } } },
      { ...TWO_REGIONS, layout: "single" },
    );
    const plan = planFor(root);
    expect(plan.findings.some((f) => f.check === "environment" && f.message.includes("exactly one target"))).toBe(true);
    expect(plan.ok).toBe(false);
  });

  test("TOPO014 env collision / TOPO015 undeclared inject app", () => {
    const root = mkRepo({
      p: {
        contractVersion: 2,
        endpoints: [{ name: "e", port: 1000, type: "private", provides: "cap" }],
        requires: [
          { capability: "cap", inject: { env: "TAKEN" } },
          { capability: "cap", inject: { appValue: { app: "ghost", path: "x.y" } } },
        ],
      },
    });
    // distribution.yaml env_requires TAKEN collides with the injection
    writeFileSync(
      join(root, "distributions", "p", "distribution.yaml"),
      yaml({ name: "p", version: "1.0.0", env_requires: ["TAKEN"] }),
    );
    const plan = planFor(root);
    expect(errs(plan, "TOPO014").length).toBe(1);
    expect(errs(plan, "TOPO015").length).toBe(1);
  });

  test("schema-invalid contracts become findings, not throws", () => {
    const root = mkRepo({ p: { contractVersion: 2, placement: { target: "x" } } });
    const plan = planFor(root);
    expect(errs(plan, "contract-schema").length).toBeGreaterThan(0);
    expect(plan.ok).toBe(false);
  });
});

describe("naming", () => {
  test("k8sName truncates deterministically with a hash suffix", () => {
    const long = `hermes-app-${"x".repeat(80)}`;
    const out = k8sName(long);
    expect(out.length).toBe(63);
    expect(out).toBe(k8sName(long));
    expect(out).not.toBe(k8sName(`${long}y`));
  });
});

describe("determinism", () => {
  test("identical inputs produce byte-identical plans", () => {
    const root = mkRepo(referencePersonas(), TWO_REGIONS, {
      allowedChartSources: ["oci://ghcr.io/factory-level/charts"],
    });
    const a = JSON.stringify(planFor(root));
    const b = JSON.stringify(planFor(root));
    expect(a).toBe(b);
  });
});

describe("the reference acceptance (design 10)", () => {
  const root = () =>
    mkRepo(referencePersonas(), TWO_REGIONS, { allowedChartSources: ["oci://ghcr.io/factory-level/charts"] });

  test("two-region hub-spoke: 8 agents, 1 kanban, 1 postiz, 2 relays, monitoring x8", () => {
    const plan = planFor(root());
    expect(plan.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(plan.agents.length).toBe(8); // 4 personas x 2 regions
    expect(plan.apps.filter((a) => a.app === "monitoring").length).toBe(8);
    expect(plan.apps.filter((a) => a.app === "content-kanban").length).toBe(1);
    expect(plan.apps.filter((a) => a.app === "postiz").length).toBe(1);
    expect(plan.apps.filter((a) => a.app === "relay").length).toBe(2);

    const kanban = plan.apps.find((a) => a.app === "content-kanban")!;
    expect(kanban.scope).toBe("global");
    expect(kanban.target).toBe("ca-west-a");
    expect(kanban.namespace).toBe("hermes-app-marketing-manager-content-kanban-global");

    // every monitoring instance binds its own region's relay
    const alertBindings = plan.bindings.filter((b) => b.capability === "alert-receiver");
    expect(alertBindings.length).toBe(10); // monitoring x8 + kanban + postiz
    for (const b of alertBindings.filter((x) => x.consumer.includes("monitoring"))) {
      expect(b.crossRegion).toBe(false);
    }

    // cross-region edges: the eu agents consuming the global kanban/postiz
    const cross = plan.bindings.filter((b) => b.crossRegion);
    expect(cross.length).toBeGreaterThan(0);
    expect(cross.every((b) => b.providerRegion === "ca-west")).toBe(true);

    // URL projection: two-label scheme under the public base domain
    const ui = plan.endpoints.find((e) => e.component === "content-kanban" && e.endpoint === "ui")!;
    expect(ui.url).toBe("https://ui.content-kanban-marketing-manager-global.hermes.example.dev");

    // the relay's targetUrl injection resolves to the SAME region's agent hooks endpoint
    const hookBindings = plan.bindings.filter((b) => b.capability === "alert-webhook");
    expect(hookBindings.length).toBe(2);
    for (const b of hookBindings) expect(b.crossRegion).toBe(false);
  });

  test("strict replicated fails: unsupported layout AND cross-region state", () => {
    const strictRoot = mkRepo(referencePersonas(), {
      ...TWO_REGIONS,
      layout: "replicated",
      sovereignty: { mode: "strict" },
    });
    const plan = planFor(strictRoot);
    expect(plan.ok).toBe(false);
    expect(errs(plan, "TOPO001").length).toBe(4); // no persona supports replicated
    expect(errs(plan, "TOPO006").length).toBeGreaterThan(0); // eu -> global kanban/postiz
  });

  test("single layout collapses everything onto one target with legacy identity", () => {
    const soloRoot = mkRepo(referencePersonas(), {
      version: 1,
      layout: "single",
      regions: [{ name: "local", jurisdiction: "NA", targets: [{ name: "in-cluster", argoDestination: "in-cluster" }] }],
    });
    const plan = planFor(soloRoot);
    expect(plan.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(plan.agents.length).toBe(4);
    expect(plan.agents.map((a) => a.namespace).sort()).toEqual([
      "hermes-marketing-engagement",
      "hermes-marketing-manager",
      "hermes-marketing-research",
      "hermes-marketing-sre",
    ]);
    // D5: the kanban keeps today's identity - manager namespace, child name
    const kanban = plan.apps.find((a) => a.app === "content-kanban")!;
    expect(kanban.namespace).toBe("hermes-marketing-manager");
    expect(kanban.application).toBe("hermes-marketing-manager-content-kanban");
  });
});

describe("environment loading", () => {
  test("no environment files synthesizes the single default", () => {
    const env = loadEnvironment(undefined);
    expect(env.environment).toEqual(defaultEnvironment());
    expect(env.findings).toEqual([]);
  });

  test("a broken topology.yaml reports findings and falls back to the default", () => {
    const root = mkRepo({ p: null }, { version: 1, layout: "mesh", regions: [] });
    const env = loadEnvironment(root);
    expect(env.findings.some((f) => f.check === "environment")).toBe(true);
    expect(env.environment.synthesized).toBe(true);
  });

  test("an unknown globalTarget is an environment finding", () => {
    const root = mkRepo({ p: null }, { ...TWO_REGIONS, globalTarget: "nowhere" });
    const env = loadEnvironment(root);
    expect(env.findings.some((f) => f.message.includes("globalTarget"))).toBe(true);
  });
});

describe("hg topology CLI (subprocess, no state.json)", () => {
  const MAIN = join(import.meta.dir, "..", "src", "main.ts");

  function hg(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
    const home = mkdtempSync(join(tmpdir(), "topo-home-"));
    const proc = Bun.spawnSync(["bun", MAIN, ...args], {
      env: { ...process.env, HERMES_GITOPS_HOME: home, ...env },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  test("inspect --json emits one document and exit 0, without any onboarded state", () => {
    const root = mkRepo({ p: { contractVersion: 2, topology: { supportedLayouts: ["single"] } } });
    const r = hg(["topology", "inspect", "--dir", root, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("topology-inspect");
    expect(doc.profiles[0].profile).toBe("p");
  });

  test("plan --layout simulation fails with the JSON document still emitted", () => {
    const root = mkRepo({ p: null });
    const r = hg(["topology", "plan", "--dir", root, "--layout", "hub-spoke", "--json"]);
    expect(r.code).toBe(1); // v1 profile supports single only -> TOPO001
    const doc = JSON.parse(r.stdout); // document BEFORE the throw
    expect(doc.ok).toBe(false);
    expect(doc.findings.some((f: { check: string }) => f.check === "TOPO001")).toBe(true);
  });

  test("missing --dir is a hard usage error", () => {
    const r = hg(["topology", "plan"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--dir");
  });
});

describe("doctor lint, print, --fix (PR-5 surface)", () => {
  test("lintRepo flags value literals and prose URLs", async () => {
    const { lintRepo } = await import("../src/topology/doctor.ts");
    const root = mkRepo({
      p: {
        apps: [
          {
            name: "monitoring",
            chart: "charts/monitoring",
            repo: "local",
            values: { alert: { webhookUrl: "http://relay.other-ns.svc/alert" } },
          },
        ],
      },
    });
    writeFileSync(
      join(root, "distributions", "p", "SOUL.md"),
      "Read the board at http://kanban.hermes-x.svc/api/board when planning.",
    );
    const { contracts } = loadContracts(root);
    const env = loadEnvironment(root);
    const plan = compile(contracts, env.environment, {});
    const findings = lintRepo(root, contracts, plan);
    expect(findings.filter((f) => f.check === "hardcoded-cluster-url").length).toBe(1);
    expect(findings.filter((f) => f.check === "prose-cluster-url").length).toBe(1);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  test("a configured memory.provider warns about backup coverage (#437)", async () => {
    const { lintRepo } = await import("../src/topology/doctor.ts");
    const root = mkRepo({ p: {} });
    writeFileSync(
      join(root, "distributions", "p", "config.yaml"),
      "memory:\n  provider: honcho\n",
    );
    const { contracts } = loadContracts(root);
    const env = loadEnvironment(root);
    const plan = compile(contracts, env.environment, {});
    const findings = lintRepo(root, contracts, plan);
    const hit = findings.filter((f) => f.check === "memory-provider-backup-coverage");
    expect(hit.length).toBe(1);
    expect(hit[0]!.severity).toBe("warning");
    expect(hit[0]!.message).toContain("honcho");
    // Without the key, silent - the deployed profiles set none today.
    writeFileSync(join(root, "distributions", "p", "config.yaml"), "model:\n  provider: anthropic\n");
    const clean = lintRepo(root, loadContracts(root).contracts, plan);
    expect(clean.filter((f) => f.check === "memory-provider-backup-coverage")).toEqual([]);
  });

  test("renderTopology groups region -> target -> instances and marks cross-region", async () => {
    const { renderTopology } = await import("../src/topology/print.ts");
    const root = mkRepo(referencePersonas(), TWO_REGIONS, {
      allowedChartSources: ["oci://ghcr.io/factory-level/charts"],
    });
    const { contracts } = loadContracts(root);
    const env = loadEnvironment(root);
    const plan = compile(contracts, env.environment, {});
    const lines = renderTopology(plan, env.environment);
    expect(lines[0]).toContain("layout hub-spoke");
    expect(lines).toContain("region ca-west (CA)");
    expect(lines.some((l) => l.includes("CROSS-REGION (eu-west -> ca-west)"))).toBe(true);
    expect(lines.some((l) => l.includes("provides content-board"))).toBe(true);
  });

  test("fixToV2 upgrades a commented v1 file idempotently and semantics-preserving", async () => {
    const { fixToV2 } = await import("../src/topology/doctor.ts");
    const root = mkRepo({ p: null });
    const file = join(root, "distributions", "p", "hermes-gitops.yaml");
    writeFileSync(
      file,
      "# the persona's infra intent\napps:\n  # the observability chart\n  - name: monitoring\n    chart: charts/monitoring\n    repo: local\nbackup:\n  schedule: \"0 3 * * *\" # nightly\n",
    );
    const before = planFor(root);

    const first = fixToV2(file);
    expect(first.changed).toBe(true);
    writeFileSync(file, first.after);
    // comments survive
    expect(first.after).toContain("# the persona's infra intent");
    expect(first.after).toContain("# nightly");
    // the file is now schema-valid v2 with explicit legacy defaults
    const upgraded = loadContracts(root);
    expect(upgraded.findings).toEqual([]);
    expect(upgraded.contracts[0]!.contractVersion).toBe(2);
    // the compiled plan is unchanged (same instances, same names)
    const after = planFor(root);
    expect(JSON.stringify({ a: after.agents, b: after.apps })).toBe(
      JSON.stringify({ a: before.agents, b: before.apps }),
    );
    // idempotent
    const second = fixToV2(file);
    expect(second.changed).toBe(false);
  });

  test("deepCheck warns when helm renders no matching Service", async () => {
    const { deepCheck } = await import("../src/topology/doctor.ts");
    const root = mkRepo({
      p: {
        contractVersion: 2,
        apps: [
          {
            name: "board",
            chart: "board",
            repo: "oci://r.example/c",
            version: "1.0.0",
            endpoints: [{ name: "api", service: "board", port: 80, type: "private" }],
          },
        ],
      },
    });
    // the persona convention: the chart source lives in the repo's charts/
    const chartDir = join(root, "charts", "board");
    mkdirSync(join(chartDir, "templates"), { recursive: true });
    writeFileSync(join(chartDir, "Chart.yaml"), "apiVersion: v2\nname: board\nversion: 1.0.0\n");
    writeFileSync(
      join(chartDir, "templates", "service.yaml"),
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: board\nspec:\n  ports:\n    - port: 8080\n",
    );
    const { contracts } = loadContracts(root);
    const cache = mkdtempSync(join(tmpdir(), "charts-"));
    const findings = deepCheck(root, contracts, cache);
    // helm may be missing in some environments - both outcomes are honest
    if (findings.some((f) => f.check === "deep-skipped")) return;
    expect(findings.some((f) => f.check === "deep-endpoint-port")).toBe(true); // 80 declared, 8080 rendered
  });
});

describe("hg topology emit (PR-6 surface)", () => {
  async function emitTo(root: string, output: string) {
    const { renderTree, writeTree } = await import("../src/topology/emit.ts");
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const plan = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    expect(plan.ok).toBe(true);
    const tree = renderTree(root, contracts, plan, env.environment, { sourceSha: "0".repeat(40) });
    return { plan, result: writeTree(output, tree), tree };
  }

  test("the reference fleet materializes, regenerates as a no-op, and prunes removed profiles", async () => {
    const root = mkRepo(referencePersonas(), TWO_REGIONS, {
      allowedChartSources: ["oci://ghcr.io/factory-level/charts"],
    });
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    const first = await emitTo(root, out);
    expect(first.result.written.length).toBeGreaterThan(20);
    expect(first.result.written).toContain("deployments/plan.yaml");
    expect(first.result.written).toContain("catalog/profiles/marketing-manager/contract.yaml");

    const second = await emitTo(root, out);
    expect(second.result.written).toEqual([]);
    expect(second.result.deleted).toEqual([]);

    // removing a profile prunes its generated records atomically
    const { rmSync } = await import("node:fs");
    rmSync(join(root, "distributions", "marketing-research"), { recursive: true });
    const third = await emitTo(root, out);
    expect(third.result.deleted.some((f) => f.includes("marketing-research"))).toBe(true);
    expect(third.result.deleted.some((f) => f.startsWith("catalog/"))).toBe(true);
  });

  test("a declared distribution identity stamps every agent record (ADR-123)", async () => {
    const root = mkRepo(referencePersonas(), TWO_REGIONS, {
      allowedChartSources: ["oci://ghcr.io/factory-level/charts"],
    });
    const { writeFileSync: wf, mkdirSync: mk } = await import("node:fs");
    mk(join(root, "environment"), { recursive: true });
    wf(
      join(root, "environment", "bundles.yaml"),
      yaml({ version: 4, distribution: { name: "marketing", displayName: "Marketing Team" } }),
    );
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    const { tree } = await emitTo(root, out);
    const { parse } = await import("yaml");
    const agentRecords = [...tree.keys()].filter(
      (k) => k.startsWith("deployments/agents/") && k.endsWith("deployment.yaml"),
    );
    expect(agentRecords.length).toBeGreaterThan(0);
    for (const key of agentRecords) {
      const record = parse(tree.get(key)!) as {
        spec: { distribution?: { name?: string; displayName?: string } };
      };
      expect(record.spec.distribution).toEqual({ name: "marketing", displayName: "Marketing Team" });
    }
  });

  test("every emitted file validates against the published topology-plan schemas", async () => {
    const Ajv2020 = (await import("ajv/dist/2020")).default;
    const { parse } = await import("yaml");
    const schemaDir = join(import.meta.dir, "..", "..", "agent-bundle-contracts", "topology-plan", "v1alpha1");
    // Deployment records validate against v1alpha3 (ADR-123, ADR-149): agent
    // records may carry the distribution identity stamp and the runtime/chart
    // discriminator.
    const schemaDir2 = join(import.meta.dir, "..", "..", "agent-bundle-contracts", "topology-plan", "v1alpha3");
    const ajv = new Ajv2020({ allErrors: true });
    const validators = {
      contract: ajv.compile(JSON.parse(readFileSync(join(schemaDir, "provenance.schema.json"), "utf8"))),
      deployment: ajv.compile(JSON.parse(readFileSync(join(schemaDir2, "deployment.schema.json"), "utf8"))),
      plan: ajv.compile(JSON.parse(readFileSync(join(schemaDir, "plan.schema.json"), "utf8"))),
    };
    const root = mkRepo(referencePersonas(), TWO_REGIONS, {
      allowedChartSources: ["oci://ghcr.io/factory-level/charts"],
    });
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    await emitTo(root, out);
    const { readdirSync, statSync } = await import("node:fs");
    for (const entry of readdirSync(out, { recursive: true }) as string[]) {
      const abs = join(out, entry);
      if (statSync(abs).isDirectory()) continue;
      const doc = parse(readFileSync(abs, "utf8"));
      const kind = entry.endsWith("provenance.yaml")
        ? "contract"
        : entry.startsWith("catalog/")
          ? undefined // contract.yaml = the authored file, authoring-schema territory
          : entry.endsWith("plan.yaml")
          ? "plan"
          : entry.endsWith("deployment.yaml")
            ? "deployment"
            : undefined;
      if (!kind) continue; // values.yaml is free-form chart values
      const valid = validators[kind](doc);
      if (!valid) throw new Error(`${entry}: ${JSON.stringify(validators[kind].errors)}`);
    }
  });

  test("catalogue records carry the authored bytes verbatim, comments included", async () => {
    const { parse } = await import("yaml");
    const root = mkRepo({ p: null });
    const authored = "# a load-bearing comment\ncontractVersion: 2\napps: []\n";
    writeFileSync(join(root, "distributions", "p", "hermes-gitops.yaml"), authored);
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    await emitTo(root, out);
    // the copy is byte-for-byte - no YAML round-trip in the way
    const copied = readFileSync(join(out, "catalog", "profiles", "p", "contract.yaml"), "utf8");
    expect(copied).toBe(authored);
    const prov = parse(readFileSync(join(out, "catalog", "profiles", "p", "provenance.yaml"), "utf8"));
    expect(prov.profile).toBe("p");
    expect(prov.sourceSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("app values merge capability injections at the declared dot-path", async () => {
    const root = mkRepo(referencePersonas(), TWO_REGIONS, {
      allowedChartSources: ["oci://ghcr.io/factory-level/charts"],
    });
    const { parse } = await import("yaml");
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    await emitTo(root, out);
    // monitoring@ca-west of the manager: alert.webhookUrl injected with the
    // ca-west relay's internal URL
    const values = parse(
      readFileSync(join(out, "deployments", "apps", "marketing-manager-monitoring-ca-west", "values.yaml"), "utf8"),
    );
    expect(values.alert.webhookUrl).toContain("relay");
    expect(values.alert.webhookUrl).toContain("ca-west");
  });
});

describe("Eve agents in the catalogue (ADR-149)", () => {
  /** An Eve project at agents/<name>/: package.json + agent/ + the v5 file. */
  function mkEveAgent(root: string, name: string, ext: object, pkgName = name) {
    const dir = join(root, "agents", name);
    mkdirSync(join(dir, "agent"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkgName, dependencies: { eve: "0.0.0" } }));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(dir, "agent", "instructions.md"), "echo\n");
    writeFileSync(join(dir, "hermes-gitops.yaml"), yaml(ext));
    return dir;
  }
  const EVE_EXT = {
    contractVersion: 5,
    runtime: { kind: "eve", envRequires: ["AI_GATEWAY_API_KEY", { name: "GREETING", required: false, secret: false }] },
  };

  test("an agents/<name>/ project is discovered as a contract on the eve runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "topo-eve-"));
    mkEveAgent(root, "echo", EVE_EXT);
    const dirs = discoverContractDirs(root);
    expect(dirs.map((d) => d.subdir)).toEqual(["agents/echo"]);
    const { contracts, findings } = loadContracts(root);
    expect(findings).toEqual([]);
    expect(contracts.length).toBe(1);
    const c = contracts[0]!;
    expect(c.profile).toBe("echo");
    expect(c.runtime).toBe("eve");
    expect(c.contractVersion).toBe(5);
    expect(c.subdir).toBe("agents/echo");
    expect(c.envRequires).toEqual(["AI_GATEWAY_API_KEY", "GREETING"]);
  });

  test("a catalogue may hold both runtimes", () => {
    const root = mkRepo({ p: { contractVersion: 4 } });
    mkEveAgent(root, "echo", EVE_EXT);
    const { contracts } = loadContracts(root);
    expect(contracts.map((c) => [c.profile, c.runtime])).toEqual([
      ["p", "hermes"],
      ["echo", "eve"],
    ]);
  });

  test("a single-profile root with a distribution.yaml still discovers agents/*", () => {
    const root = mkdtempSync(join(tmpdir(), "topo-eve-"));
    writeFileSync(join(root, "distribution.yaml"), yaml({ name: "solo", version: "1.0.0" }));
    mkEveAgent(root, "echo", EVE_EXT);
    expect(discoverContractDirs(root).map((d) => [d.subdir, d.runtime])).toEqual([
      ["", "hermes"],
      ["agents/echo", "eve"],
    ]);
  });

  test("the package name is the identity and must be a DNS label", () => {
    const root = mkdtempSync(join(tmpdir(), "topo-eve-"));
    mkEveAgent(root, "echo", EVE_EXT, "@factorylevel/echo");
    expect(() => loadContracts(root)).toThrow(/not a DNS-1123 label/);
  });

  test("an agents/ dir without the v5 runtime block is not an Eve contract", () => {
    const root = mkdtempSync(join(tmpdir(), "topo-eve-"));
    mkEveAgent(root, "echo", { contractVersion: 5 });
    const { contracts, findings } = loadContracts(root);
    expect(contracts).toEqual([]);
    expect(findings.some((f) => f.check === "contract-schema" || f.check === "contract-runtime")).toBe(true);
  });

  test("emitted agent records carry runtime + chart, and validate against topology-plan v1alpha3", async () => {
    const Ajv2020 = (await import("ajv/dist/2020")).default;
    const { parse } = await import("yaml");
    const { renderTree, writeTree } = await import("../src/topology/emit.ts");
    const root = mkRepo({ p: { contractVersion: 4 } });
    mkEveAgent(root, "echo", EVE_EXT);
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const plan = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    expect(plan.ok).toBe(true);
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    writeTree(out, renderTree(root, contracts, plan, env.environment, { sourceSha: "0".repeat(40) }));
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "agent-bundle-contracts", "topology-plan", "v1alpha3", "deployment.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    const eve = parse(readFileSync(join(out, "deployments", "agents", "echo", "deployment.yaml"), "utf8"));
    expect(eve.spec.runtime).toBe("eve");
    expect(eve.spec.chart).toBe("eve-agent");
    expect(validate(eve)).toBe(true);
    const hermes = parse(readFileSync(join(out, "deployments", "agents", "p", "deployment.yaml"), "utf8"));
    expect(hermes.spec.runtime).toBe("hermes");
    expect(hermes.spec.chart).toBe("hermes-profile");
    expect(validate(hermes)).toBe(true);
    // the catalogue carries the authored v5 file verbatim
    expect(readFileSync(join(out, "catalog", "profiles", "echo", "contract.yaml"), "utf8")).toBe(yaml(EVE_EXT));
  });
});

describe("bundled communication targets (#278)", () => {
  // Bundling retires the per-profile namespace and Service, so a route
  // that targets a bundled profile used to compile to a URL for something
  // that does not exist. This is the gaps.md "bundle gap" made concrete.
  const contracts = [
    {
      profile: "producer",
      contractVersion: 3 as const,
      endpoints: [],
      apps: [{ name: "monitoring", outputs: [{ name: "alerts", event: "observability.alert/v1" }] }],
      communication: {
        routes: [
          {
            name: "alerts",
            from: { app: "monitoring", output: "alerts" },
            outputs: [{ agent: { profile: "manager", handler: "alerts" } }],
          },
        ],
      },
    },
    {
      profile: "manager",
      contractVersion: 3 as const,
      apps: [],
      endpoints: [{ name: "hooks", port: 8644, path: "/webhooks/alerts", type: "webhook" }],
    },
  ];

  function compileWith(bundledProfiles?: Record<string, unknown>) {
    const env = { ...loadEnvironment().environment, bundledProfiles } as never;
    return compileCommunication(contracts as never, env, {
      layout: "single",
      agents: [
        { id: "manager@local", profile: "manager", scope: "local", namespace: "hermes-manager" },
        { id: "producer@local", profile: "producer", scope: "local", namespace: "hermes-producer" },
      ] as never,
      apps: [
        { id: "producer/monitoring@local", profile: "producer", app: "monitoring", scope: "local", namespace: "hermes-producer" },
      ] as never,
    });
  }

  test("an unbundled target keeps its own Service", () => {
    const { plan, findings } = compileWith(undefined);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const edge = plan.edges.find((e) => e.kind === "agent")!;
    expect(edge.agent!.url).toBe("http://hermes-manager.hermes-manager.svc.cluster.local:8644/webhooks/alerts");
  });

  test("a bundled target is addressed at the BUNDLE's Service and port", () => {
    const { plan, findings } = compileWith({
      manager: {
        bundle: "marketing-core",
        namespace: "hermes-marketing-core",
        service: "hermes-marketing-core",
        webhookPort: 8644,
        envSecretRef: "hermes-manager-env",
      },
    });
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const edge = plan.edges.find((e) => e.kind === "agent")!;
    expect(edge.agent!.url).toBe(
      "http://hermes-marketing-core.hermes-marketing-core.svc.cluster.local:8644/webhooks/alerts",
    );
    expect(edge.agent!.secretName).toBe("hermes-manager-env");
  });

  test("a bundled target with no webhookPort refuses to compile", () => {
    // Fail closed: a route compiling to a dead URL is worse than one that
    // refuses, because the failure surfaces at delivery time in prod.
    const { findings } = compileWith({
      manager: { bundle: "marketing-core", namespace: "hermes-marketing-core", service: "hermes-marketing-core" },
    });
    const errors = findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.check).toBe("EVENT003");
    expect(errors[0]!.message).toContain("bundled into marketing-core");
    expect(errors[0]!.fix).toContain("webhookPort");
  });
});

describe("root Eve project discovery (ADR-150)", () => {
  test("a directory that IS one Eve project is discovered with an empty subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "hg-root-eve-"));
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "solo", dependencies: { eve: "0.42.0" } }));
    writeFileSync(join(root, "agent", "instructions.md"), "solo\n");
    writeFileSync(join(root, "hermes-gitops.yaml"), "contractVersion: 5\nruntime:\n  kind: eve\n");
    expect(discoverContractDirs(root)).toEqual([{ dir: root, subdir: "", runtime: "eve" }]);
  });
});
