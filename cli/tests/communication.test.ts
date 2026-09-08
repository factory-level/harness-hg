// The communication plane, offline: contract v3 + environment loading
// (PR 1), the pure communication compiler with its EVENT/CHATOPS findings
// (PR 2), and the shared envelope/signing module every runtime path
// imports. tmpdir-synthesized repos, the topology.test.ts pattern.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yaml } from "yaml";
import { loadContracts } from "../src/topology/contract.ts";
import { loadEnvironment } from "../src/topology/environment.ts";
import { inputsHash } from "../src/topology/emit.ts";
import { compile, type TopologyPlan } from "../src/topology/compile.ts";
import {
  envelopeField,
  makeEnvelope,
  sessionKey,
  signedHeaders,
  verifySignature,
} from "../src/topology/envelope.ts";

function mkRepo(profiles: Record<string, object | null>, envFiles?: Record<string, object>): string {
  const root = mkdtempSync(join(tmpdir(), "comm-"));
  for (const [name, ext] of Object.entries(profiles)) {
    const dir = join(root, "distributions", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "distribution.yaml"), yaml({ name, version: "1.0.0" }));
    if (ext !== null) writeFileSync(join(dir, "hermes-gitops.yaml"), yaml(ext));
  }
  if (envFiles) {
    const envDir = join(root, "environment");
    mkdirSync(envDir, { recursive: true });
    for (const [file, doc] of Object.entries(envFiles)) {
      writeFileSync(join(envDir, file), yaml(doc));
    }
  }
  return root;
}

const V3_PROFILE = {
  contractVersion: 3,
  apps: [
    {
      name: "monitoring",
      chart: "charts/monitoring",
      repo: "local",
      outputs: [
        {
          name: "alerts",
          event: "observability.alert/v1",
          adapter: { type: "webhook", inject: { appValue: { path: "alert.webhookUrl" } } },
        },
      ],
    },
  ],
  communication: {
    routes: [
      {
        name: "operational-alerts",
        from: { app: "monitoring", output: "alerts" },
        outputs: [
          { agent: { profile: "platform-sre", handler: "alerts", session: { mode: "keyed", key: "subject" } } },
          { chatops: "company_chat#channel-1" },
        ],
      },
    ],
  },
};

const ENV_COMMUNICATION = {
  version: 1,
  chatopsConnections: { company_chat: { provider: "recording" } },
  durableProvider: { plugin: "redis-streams" },
};

describe("contract v3 loading", () => {
  test("a v3 file loads with outputs and communication carried", () => {
    const { contracts, findings } = loadContracts(mkRepo({ "platform-sre": V3_PROFILE }));
    expect(findings).toEqual([]);
    expect(contracts).toHaveLength(1);
    const c = contracts[0]!;
    expect(c.contractVersion).toBe(3);
    expect(c.apps[0]!.outputs).toHaveLength(1);
    expect(c.apps[0]!.outputs[0]!.event).toBe("observability.alert/v1");
    expect(c.communication?.routes).toHaveLength(1);
    expect(c.communication?.routes[0]!.outputs).toHaveLength(2);
    expect(c.communication?.externalInputs).toEqual([]);
  });

  test("a schema-invalid v3 file becomes a finding, never a contract", () => {
    const bad = {
      contractVersion: 3,
      communication: { routes: [{ name: "r", from: { app: "x", output: "y" }, outputs: [{ chatops: "no-hash-here" }] }] },
    };
    const { contracts, findings } = loadContracts(mkRepo({ broken: bad }));
    expect(contracts).toHaveLength(0);
    expect(findings.some((f) => f.check === "contract-schema" && f.severity === "error")).toBe(true);
  });

  test("a v2 file must not carry communication (dispatch on the marker's value)", () => {
    const { contracts, findings } = loadContracts(
      mkRepo({ old: { contractVersion: 2, communication: { routes: [] } } as object }),
    );
    expect(contracts).toHaveLength(0);
    expect(findings.some((f) => f.check === "contract-schema")).toBe(true);
  });

  test("v2 contracts load unchanged with empty communication surface", () => {
    const { contracts, findings } = loadContracts(
      mkRepo({ legacy: { contractVersion: 2, apps: [{ name: "m", chart: "c", repo: "local" }] } }),
    );
    expect(findings).toEqual([]);
    expect(contracts[0]!.contractVersion).toBe(2);
    expect(contracts[0]!.apps[0]!.outputs).toEqual([]);
    expect(contracts[0]!.communication).toBeUndefined();
  });
});

describe("environment/communication.yaml", () => {
  test("loads beside topology.yaml", () => {
    const root = mkRepo(
      { p: null },
      {
        "topology.yaml": {
          version: 1,
          layout: "single",
          regions: [{ name: "local", jurisdiction: "NA", targets: [{ name: "a", argoDestination: "in-cluster" }] }],
        },
        "communication.yaml": ENV_COMMUNICATION,
      },
    );
    const { environment, findings } = loadEnvironment(root);
    expect(findings).toEqual([]);
    expect(environment.communication?.chatopsConnections["company_chat"]?.provider).toBe("recording");
    expect(environment.communication?.durableProvider?.plugin).toBe("redis-streams");
  });

  test("loads under the synthesized default topology (no topology.yaml)", () => {
    const root = mkRepo({ p: null }, { "communication.yaml": ENV_COMMUNICATION });
    const { environment, findings } = loadEnvironment(root);
    expect(findings).toEqual([]);
    expect(environment.synthesized).toBe(true);
    expect(environment.communication?.durableProvider?.plugin).toBe("redis-streams");
  });

  test("absent file means feature off", () => {
    const { environment } = loadEnvironment(mkRepo({ p: null }));
    expect(environment.communication).toBeUndefined();
  });

  test("a schema-invalid file becomes a finding and is treated as absent", () => {
    const root = mkRepo(
      { p: null },
      { "communication.yaml": { version: 1, chatopsConnections: { company_chat: { provider: "discord" } } } },
    );
    const { environment, findings } = loadEnvironment(root);
    expect(findings.some((f) => f.check === "environment" && f.severity === "error")).toBe(true);
    expect(environment.communication).toBeUndefined();
  });

  test("inputsHash covers communication.yaml", () => {
    const bare = mkRepo({ p: null });
    const withComm = mkRepo({ p: null }, { "communication.yaml": ENV_COMMUNICATION });
    expect(inputsHash(bare)).not.toBe(inputsHash(withComm));
    // and a repo without the file hashes identically to itself (guard
    // against accidental inclusion of a missing-file marker)
    expect(inputsHash(bare)).toBe(inputsHash(mkRepo({ p: null })));
  });
});

// ---------------------------------------------------------------------------
// The communication compiler (PR 2)

// The reference fixture shape: platform-sre subscribes, unrelated-sre does
// not - the proof harness's isolation pair.
function referenceRepo(overrides?: {
  route?: object;
  envCommunication?: object | null;
  sreExtra?: object;
}): string {
  const platformSre = {
    contractVersion: 3,
    endpoints: [
      { name: "hooks", port: 8644, path: "/webhooks/alerts", type: "webhook", signature: "hmac-sha256" },
    ],
    apps: [
      {
        name: "monitoring",
        chart: "charts/monitoring",
        repo: "local",
        outputs: [
          {
            name: "alerts",
            event: "observability.alert/v1",
            adapter: { type: "webhook", inject: { appValue: { path: "alert.webhookUrl" } } },
          },
        ],
      },
    ],
    communication: {
      routes: [
        overrides?.route ?? {
          name: "operational-alerts",
          from: { app: "monitoring", output: "alerts" },
          delivery: {
            mode: "queued",
            ordering: { mode: "fifo", key: "subject", onFailure: "dead-letter-and-continue" },
          },
          outputs: [
            { agent: { profile: "platform-sre", handler: "alerts", session: { mode: "keyed", key: "subject" } } },
            { chatops: "company_chat#channel-1" },
            { chatops: "company_chat#channel-2" },
          ],
        },
      ],
    },
    ...(overrides?.sreExtra ?? {}),
  };
  const unrelatedSre = {
    contractVersion: 3,
    endpoints: [
      { name: "hooks", port: 8644, path: "/webhooks/alerts", type: "webhook", signature: "hmac-sha256" },
    ],
  };
  const envFiles: Record<string, object> = {};
  if (overrides?.envCommunication !== null) {
    envFiles["communication.yaml"] = (overrides?.envCommunication as object) ?? ENV_COMMUNICATION;
  }
  return mkRepo({ "platform-sre": platformSre, "unrelated-sre": unrelatedSre }, envFiles);
}

function planFor(root: string): TopologyPlan {
  const { contracts, findings } = loadContracts(root);
  const env = loadEnvironment(root);
  return compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
}

describe("compileCommunication", () => {
  test("the reference fixture compiles: producers, five edges, two auto-registered spaces", () => {
    const plan = planFor(referenceRepo());
    expect(plan.ok).toBe(true);
    const comm = plan.communication!;

    expect(comm.routers).toHaveLength(1);
    expect(comm.routers[0]!.namespace).toBe("hermes-system");

    // The declared alert producer plus the synthesized agents.all
    // broadcast - whose id sorts LAST, so position 0 stays the alert.
    expect(comm.producers).toHaveLength(2);
    const producer = comm.producers[0]!;
    expect(producer.name).toBe("platform-sre/monitoring#alerts");
    expect(producer.ingestUrl).toBe(
      `http://hermes-event-router.hermes-system.svc.cluster.local${producer.ingestPath}`,
    );
    expect(producer.inject).toEqual({ app: "monitoring", path: "alert.webhookUrl" });
    expect(producer.routes).toEqual(["operational-alerts"]);
    const broadcast = comm.producers[1]!;
    expect(broadcast.event).toBe("agents.all/v1");
    expect(broadcast.id > producer.id).toBe(true);
    expect(broadcast.routes).toEqual(["agents-all"]);

    // 3 business edges + one DIRECT broadcast edge per webhook-capable
    // profile (both fixture profiles declare one).
    expect(comm.edges).toHaveLength(5);
    const businessEdges = comm.edges.filter((e) => e.event !== "agents.all/v1");
    const broadcastEdges = comm.edges.filter((e) => e.event === "agents.all/v1");
    expect(broadcastEdges).toHaveLength(2);
    expect(broadcastEdges.every((e) => e.kind === "agent" && e.delivery.mode === "direct")).toBe(true);
    expect(broadcastEdges.map((e) => e.agent!.profile).sort()).toEqual(["platform-sre", "unrelated-sre"]);
    const agentEdges = businessEdges.filter((e) => e.kind === "agent");
    const chatopsEdges = businessEdges.filter((e) => e.kind === "chatops");
    expect(agentEdges).toHaveLength(1);
    expect(chatopsEdges).toHaveLength(2);

    // Fail-closed physical resolution: the ONE platform-sre instance, its
    // own gateway, the declared handler port and path - and never
    // unrelated-sre, which subscribes to nothing.
    const agent = agentEdges[0]!.agent!;
    expect(agent.instance).toBe("platform-sre");
    expect(agent.url).toBe("http://hermes-platform-sre.hermes-platform-sre.svc.cluster.local:8644/webhooks/alerts");
    expect(agent.session).toEqual({ mode: "keyed", key: "subject" });
    expect(agent.secretName).toBe("hermes-platform-sre-env");
    // Isolation holds for BUSINESS routes; only the reserved broadcast
    // may touch the unsubscribed profile.
    expect(businessEdges.some((e) => e.agent?.profile === "unrelated-sre")).toBe(false);

    // FIFO + queued carried onto every BUSINESS edge (the broadcast is
    // deliberately direct, no retry masking).
    for (const e of businessEdges) {
      expect(e.delivery.mode).toBe("queued");
      expect(e.delivery.ordering).toEqual({ mode: "fifo", key: "subject", onFailure: "dead-letter-and-continue" });
    }

    // Auto-registration: referencing the spaces IS registering them.
    expect(comm.chatopsSpaces.map((s) => s.id).sort()).toEqual([
      "company_chat#channel-1",
      "company_chat#channel-2",
    ]);
    expect(comm.chatopsSpaces[0]!.provider).toBe("recording");
  });

  test("compiling twice is byte-identical", () => {
    const root = referenceRepo();
    expect(JSON.stringify(planFor(root))).toBe(JSON.stringify(planFor(root)));
  });

  test("a repo without communication has no communication plan (neutrality)", () => {
    const plan = planFor(mkRepo({ plain: { contractVersion: 2 } }));
    expect(plan.communication).toBeUndefined();
    expect(plan.ok).toBe(true);
  });

  test("EVENT002: route referencing an unknown output fails", () => {
    const plan = planFor(
      referenceRepo({
        route: {
          name: "bad",
          from: { app: "monitoring", output: "nope" },
          outputs: [{ chatops: "company_chat#channel-1" }],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.findings.some((f) => f.check === "EVENT002")).toBe(true);
  });

  test("EVENT014: a persona-declared agents.all output or externalInput is refused", () => {
    const asOutput = planFor(
      referenceRepo({
        sreExtra: {
          apps: [
            {
              name: "monitoring",
              chart: "charts/monitoring",
              repo: "local",
              outputs: [{ name: "broadcast", event: "agents.all/v1", adapter: { type: "webhook" } }],
            },
          ],
        },
      }),
    );
    expect(asOutput.ok).toBe(false);
    expect(asOutput.findings.some((f) => f.check === "EVENT014" && f.message.includes("platform-reserved"))).toBe(true);

    const asInput = planFor(
      referenceRepo({
        sreExtra: {
          communication: {
            externalInputs: [
              {
                name: "broadcast",
                event: "agents.all/v1",
                verification: { type: "github-hmac-sha256", secretRef: { name: "x", key: "y" } },
              },
            ],
            routes: [],
          },
        },
      }),
    );
    expect(asInput.ok).toBe(false);
    expect(asInput.findings.some((f) => f.check === "EVENT014")).toBe(true);
  });

  test("EVENT015: a profile without a webhook endpoint is skipped by the broadcast, with a warning", () => {
    // Strip unrelated-sre's endpoint via a fresh repo shape: platform-sre
    // keeps its handler, the endpoint-less profile is skipped, the graph
    // still compiles ok (warnings never fail it).
    const plan = planFor(
      mkRepo(
        {
          "platform-sre": {
            contractVersion: 3,
            endpoints: [
              { name: "hooks", port: 8644, path: "/webhooks/alerts", type: "webhook", signature: "hmac-sha256" },
            ],
            apps: [
              {
                name: "monitoring",
                chart: "charts/monitoring",
                repo: "local",
                outputs: [
                  {
                    name: "alerts",
                    event: "observability.alert/v1",
                    adapter: { type: "webhook", inject: { appValue: { path: "alert.webhookUrl" } } },
                  },
                ],
              },
            ],
            communication: {
              routes: [
                {
                  name: "operational-alerts",
                  from: { app: "monitoring", output: "alerts" },
                  outputs: [{ agent: { profile: "platform-sre", handler: "alerts" } }],
                },
              ],
            },
          },
          "no-hooks": { contractVersion: 3 },
        },
        { "communication.yaml": ENV_COMMUNICATION },
      ),
    );
    expect(plan.ok).toBe(true);
    const comm = plan.communication!;
    const broadcastEdges = comm.edges.filter((e) => e.event === "agents.all/v1");
    expect(broadcastEdges.map((e) => e.agent!.profile)).toEqual(["platform-sre"]);
    expect(
      plan.findings.some(
        (f) => f.check === "EVENT015" && f.severity === "warning" && f.profile === "no-hooks",
      ),
    ).toBe(true);
  });

  test("EVENT003: an undeclared handler refuses to bind - no fallback", () => {
    const plan = planFor(
      referenceRepo({
        route: {
          name: "bad",
          from: { app: "monitoring", output: "alerts" },
          outputs: [{ agent: { profile: "platform-sre", handler: "not-declared" } }],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.findings.some((f) => f.check === "EVENT003" && f.message.includes("no fallback"))).toBe(true);
    // The bad route binds nothing; the synthesized broadcast is unaffected.
    expect(plan.communication!.edges.filter((e) => e.event !== "agents.all/v1")).toHaveLength(0);
  });

  test("EVENT003: targeting a nonexistent profile fails", () => {
    const plan = planFor(
      referenceRepo({
        route: {
          name: "bad",
          from: { app: "monitoring", output: "alerts" },
          outputs: [{ agent: { profile: "ghost", handler: "alerts" } }],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.findings.some((f) => f.check === "EVENT003" && f.message.includes("ghost"))).toBe(true);
  });

  test("EVENT006: queued delivery without a durable provider fails", () => {
    const plan = planFor(
      referenceRepo({
        envCommunication: { version: 1, chatopsConnections: { company_chat: { provider: "recording" } } },
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.findings.some((f) => f.check === "EVENT006")).toBe(true);
  });

  test("EVENT007: an unknown durable provider plugin fails", () => {
    const plan = planFor(
      referenceRepo({
        envCommunication: {
          version: 1,
          chatopsConnections: { company_chat: { provider: "recording" } },
          durableProvider: { plugin: "carrier-pigeon" },
        },
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.findings.some((f) => f.check === "EVENT007" && f.message.includes("carrier-pigeon"))).toBe(true);
  });

  test("CHATOPS001: an alias with no environment connection fails, naming the fix", () => {
    const plan = planFor(
      referenceRepo({
        envCommunication: null,
        route: {
          name: "operational-alerts",
          from: { app: "monitoring", output: "alerts" },
          outputs: [{ chatops: "company_chat#channel-1" }],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    const finding = plan.findings.find((f) => f.check === "CHATOPS001");
    expect(finding?.fix).toContain("environment/communication.yaml");
  });

  test("EVENT001: an output no route consumes is a warning, not an error", () => {
    const root = mkRepo(
      {
        "platform-sre": {
          contractVersion: 3,
          apps: [
            {
              name: "monitoring",
              chart: "charts/monitoring",
              repo: "local",
              outputs: [{ name: "alerts", event: "observability.alert/v1" }],
            },
          ],
        },
      },
      { "communication.yaml": ENV_COMMUNICATION },
    );
    const plan = planFor(root);
    expect(plan.ok).toBe(true);
    expect(plan.findings.some((f) => f.check === "EVENT001" && f.severity === "warning")).toBe(true);
  });

  test("EVENT010: an output inject colliding with a capability injection fails", () => {
    const plan = planFor(
      referenceRepo({
        sreExtra: {
          requires: [
            {
              capability: "alert-receiver",
              locality: "same-region",
              inject: { appValue: { app: "monitoring", path: "alert.webhookUrl" } },
            },
          ],
        },
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.findings.some((f) => f.check === "EVENT010")).toBe(true);
  });

  test("EVENT013: FIFO narrower than a route-wide session warns", () => {
    const plan = planFor(
      referenceRepo({
        route: {
          name: "operational-alerts",
          from: { app: "monitoring", output: "alerts" },
          delivery: { mode: "queued", ordering: { mode: "fifo", key: "subject" } },
          outputs: [{ agent: { profile: "platform-sre", handler: "alerts", session: { mode: "route" } } }],
        },
      }),
    );
    expect(plan.ok).toBe(true);
    expect(plan.findings.some((f) => f.check === "EVENT013" && f.severity === "warning")).toBe(true);
  });

  test("external inputs bind to the shared gateway and route to agents", () => {
    const plan = planFor(
      referenceRepo({
        sreExtra: {
          communication: {
            externalInputs: [
              {
                name: "demo-alert-source",
                event: "source.demo.alert/v1",
                verification: { type: "hmac-sha256", secretRef: { name: "demo-hook", key: "secret" } },
              },
            ],
            routes: [
              {
                name: "external-triage",
                from: { externalInput: "demo-alert-source" },
                outputs: [{ agent: { profile: "platform-sre", handler: "alerts" } }],
              },
            ],
          },
        },
      }),
    );
    expect(plan.ok).toBe(true);
    const comm = plan.communication!;
    expect(comm.externalInputs).toHaveLength(1);
    expect(comm.externalInputs[0]!.hookPath).toBe("/v1/hooks/platform-sre-demo-alert-source");
    expect(comm.externalInputs[0]!.routes).toEqual(["external-triage"]);
    const edge = comm.edges.find((e) => e.from.externalInput);
    expect(edge?.agent?.profile).toBe("platform-sre");
    // The default session policy errs toward isolation.
    expect(edge?.agent?.session.mode).toBe("per-event");
  });
});

// ---------------------------------------------------------------------------
// Emit (PR 3): deployments/communication/, schema-validated, byte-stable

describe("emit deployments/communication", () => {
  async function emitTo(root: string, output: string) {
    const { renderTree, writeTree } = await import("../src/topology/emit.ts");
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const plan = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    expect(plan.ok).toBe(true);
    const tree = renderTree(root, contracts, plan, env.environment, { sourceSha: "0".repeat(40) });
    return { plan, result: writeTree(output, tree), tree };
  }

  test("Discord declarations are rejected before emitting credentials or deployments", () => {
    const root = referenceRepo({ envCommunication: { version: 1, chatopsConnections: {
      company_chat: { provider: "discord", credentialRef: { name: "retired-token", key: "token" }, inbound: { approvedUsers: ["123"] } },
    } } });
    const plan = planFor(root);
    expect(plan.ok).toBe(false);
    expect(plan.findings.some((finding) => finding.severity === "error" && finding.message.includes("roadmap-only"))).toBe(true);
  });

  test("a capability injection may never write an authorization variable (reserved TOPO014)", () => {
    const root = mkRepo(
      {
        sneaky: {
          contractVersion: 4,
          endpoints: [{ name: "api", port: 80, type: "private", provides: "cap" }],
          requires: [{ capability: "cap", inject: { env: "DISCORD_ALLOWED_USERS" } }],
        },
      },
    );
    const plan = planFor(root);
    const topo14 = plan.findings.filter((f) => f.check === "TOPO014" && f.severity === "error");
    expect(topo14.length).toBeGreaterThan(0);
    expect(topo14[0]!.message).toContain("reserved");
  });

  test("unwrapSinkEntry: the sink envelope opens, everything else passes through", async () => {
    const { unwrapSinkEntry } = await import("../src/communication/index.ts");
    const record = { version: 1, plane: "cron", type: "cron.triggered" };
    expect(unwrapSinkEntry({ ts: "t", method: "POST", path: "/observer", body: record })).toEqual(record);
    expect(unwrapSinkEntry(record)).toEqual(record); // bare records untouched
    expect(unwrapSinkEntry("raw")).toBe("raw");
  });

  test("a non-discord connection's inbound materializes NOTHING - no guessed env vars", async () => {
    const { parse } = await import("yaml");
    const { readFileSync } = await import("node:fs");
    const root = referenceRepo({
      envCommunication: {
        version: 1,
        chatopsConnections: {
          company_chat: { provider: "recording", inbound: { approvedUsers: ["1"] } },
        },
        durableProvider: { plugin: "redis-streams" },
      },
    });
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    const { result } = await emitTo(root, out);
    const valuesFile = result.written.find((f) => f.startsWith("deployments/agents/") && f.endsWith("values.yaml"))!;
    const doc = parse(readFileSync(join(out, valuesFile), "utf8")) as { spec: { env: Record<string, string> } };
    expect(Object.keys(doc.spec.env ?? {})).not.toContain("RECORDING_ALLOWED_USERS");
    expect(Object.keys(doc.spec.env ?? {})).not.toContain("DISCORD_ALLOWED_USERS");
  });

  test("the reference fixture emits router record + values + plan, and regenerates as a no-op", async () => {
    const { readFileSync } = await import("node:fs");
    const { parse } = await import("yaml");
    const root = referenceRepo();
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    const first = await emitTo(root, out);
    expect(first.result.written).toContain("deployments/communication/router/deployment.yaml");
    expect(first.result.written).toContain("deployments/communication/router/values.yaml");
    expect(first.result.written).toContain("deployments/communication/plan.yaml");

    const second = await emitTo(root, out);
    expect(second.result.written).toEqual([]);
    expect(second.result.deleted).toEqual([]);

    const values = parse(readFileSync(join(out, "deployments/communication/router/values.yaml"), "utf8"));
    expect(values.spec.producers).toHaveLength(2);
    expect(values.spec.edges).toHaveLength(5);
    expect(values.spec.chatopsConnections["company_chat"].provider).toBe("recording");
    expect(values.spec.durableProvider.plugin).toBe("redis-streams");
    // Credential references only - no value-shaped key can survive the
    // schema, and the recording connection carries none at all.
    expect(JSON.stringify(values)).not.toContain("token");

    // The producer's generated ingest URL lands in the PRODUCING app's own
    // values at the declared path - Grafana's alert.webhookUrl slot.
    const appValues = parse(readFileSync(join(out, "deployments/apps/platform-sre-monitoring/values.yaml"), "utf8"));
    expect(appValues.alert.webhookUrl).toBe(
      "http://hermes-event-router.hermes-system.svc.cluster.local/v1/events/platform-sre-monitoring-alerts",
    );
  });

  test("every emitted communication file validates against the published schemas", async () => {
    const Ajv2020 = (await import("ajv/dist/2020")).default;
    const { parse } = await import("yaml");
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const schemaDir = join(import.meta.dir, "..", "..", "agent-bundle-contracts", "communication-deployment", "v1alpha1");
    const ajv = new Ajv2020({ allErrors: true });
    const validators = {
      deployment: ajv.compile(JSON.parse(readFileSync(join(schemaDir, "deployment.schema.json"), "utf8"))),
      values: ajv.compile(JSON.parse(readFileSync(join(schemaDir, "values.schema.json"), "utf8"))),
      plan: ajv.compile(JSON.parse(readFileSync(join(schemaDir, "plan.schema.json"), "utf8"))),
    };
    const root = referenceRepo({
      sreExtra: {
        communication: {
          externalInputs: [
            {
              name: "demo-alert-source",
              event: "source.demo.alert/v1",
              verification: { type: "hmac-sha256", secretRef: { name: "demo-hook", key: "secret" } },
            },
          ],
          routes: [
            {
              name: "operational-alerts",
              from: { app: "monitoring", output: "alerts" },
              delivery: { mode: "queued", ordering: { mode: "fifo", key: "subject" } },
              outputs: [
                { agent: { profile: "platform-sre", handler: "alerts", session: { mode: "keyed", key: "subject" } } },
                { chatops: "company_chat#channel-1" },
              ],
            },
            {
              name: "external-triage",
              from: { externalInput: "demo-alert-source" },
              outputs: [{ agent: { profile: "platform-sre", handler: "alerts" } }],
            },
          ],
        },
      },
    });
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    await emitTo(root, out);
    const base = join(out, "deployments", "communication");
    let checked = 0;
    for (const entry of readdirSync(base, { recursive: true }) as string[]) {
      const abs = join(base, entry);
      if (statSync(abs).isDirectory()) continue;
      const kind = entry.endsWith("values.yaml") ? "values" : entry.endsWith("plan.yaml") ? "plan" : "deployment";
      const doc = parse(readFileSync(abs, "utf8"));
      if (!validators[kind](doc)) {
        throw new Error(`${entry}: ${JSON.stringify(validators[kind].errors)}`);
      }
      checked++;
    }
    expect(checked).toBe(3);
  });

  test("emit knobs land as top-level chart values and validate as v1alpha2 (ADR-74)", async () => {
    const Ajv2020 = (await import("ajv/dist/2020")).default;
    const { parse } = await import("yaml");
    const { readFileSync } = await import("node:fs");
    const { renderTree } = await import("../src/topology/emit.ts");
    const root = referenceRepo();
    const { contracts, findings } = loadContracts(root);
    const env = loadEnvironment(root);
    const plan = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    expect(plan.ok).toBe(true);
    const tree = renderTree(root, contracts, plan, env.environment, {
      sourceSha: "0".repeat(40),
      routerImage: "example.dev/hermes/hermes-event-router:baseline-1",
      observerUrl: "http://192.0.2.10:8130",
    });
    const values = parse(tree.get("deployments/communication/router/values.yaml")!);
    expect(values.image).toBe("example.dev/hermes/hermes-event-router:baseline-1");
    expect(values.recordingBase).toBe("http://192.0.2.10:8130");
    const schemaDir = join(import.meta.dir, "..", "..", "agent-bundle-contracts", "communication-deployment", "v1alpha2");
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(join(schemaDir, "values.schema.json"), "utf8")));
    expect(validate(values)).toBe(true);
    // Without the knobs the emission is byte-identical to before: the keys
    // are absent, not empty - the default emission stays v1alpha1-shaped.
    const plain = renderTree(root, contracts, plan, env.environment, { sourceSha: "0".repeat(40) });
    const plainValues = parse(plain.get("deployments/communication/router/values.yaml")!);
    expect("image" in plainValues).toBe(false);
    expect("recordingBase" in plainValues).toBe(false);
  });

  test("a repo without communication emits no communication tree (neutrality)", async () => {
    const { existsSync } = await import("node:fs");
    const root = mkRepo({ plain: { contractVersion: 2, apps: [{ name: "m", chart: "c", repo: "local" }] } });
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    const { tree } = await emitTo(root, out);
    expect([...tree.keys()].some((k) => k.includes("communication"))).toBe(false);
    expect(existsSync(join(out, "deployments", "communication"))).toBe(false);
  });

  test("removing the communication block prunes the emitted tree", async () => {
    const { existsSync, writeFileSync: wf } = await import("node:fs");
    const { stringify } = await import("yaml");
    const root = referenceRepo();
    const out = mkdtempSync(join(tmpdir(), "gitops-"));
    await emitTo(root, out);
    expect(existsSync(join(out, "deployments", "communication"))).toBe(true);
    wf(
      join(root, "distributions", "platform-sre", "hermes-gitops.yaml"),
      stringify({
        contractVersion: 3,
        endpoints: [
          { name: "hooks", port: 8644, path: "/webhooks/alerts", type: "webhook", signature: "hmac-sha256" },
        ],
        apps: [{ name: "monitoring", chart: "charts/monitoring", repo: "local" }],
      }),
    );
    const second = await emitTo(root, out);
    expect(second.result.deleted.some((f) => f.startsWith("deployments/communication/"))).toBe(true);
    expect(existsSync(join(out, "deployments", "communication"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hg event / hg chatops against the committed reference fixture (PR 4) -
// subprocess, no onboarded state, the topology.test.ts pattern.

describe("hg event / hg chatops CLI (fixture, subprocess)", () => {
  const MAIN = join(import.meta.dir, "..", "src", "main.ts");
  const FIXTURE = join(import.meta.dir, "..", "..", "examples", "communication-plane");

  function hg(args: string[]): { code: number; stdout: string; stderr: string } {
    const home = mkdtempSync(join(tmpdir(), "comm-home-"));
    const proc = Bun.spawnSync(["bun", MAIN, ...args], {
      env: { ...process.env, HERMES_GITOPS_HOME: home },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  test("the committed fixture compiles clean", () => {
    const { contracts, findings } = loadContracts(FIXTURE);
    const env = loadEnvironment(FIXTURE);
    const plan = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
    expect(plan.findings).toEqual([]);
    expect(plan.ok).toBe(true);
    // The proof pair: platform-sre subscribes, unrelated-sre must not -
    // on business routes; the reserved broadcast reaches everyone.
    expect(plan.communication!.edges.some((e) => e.agent?.profile === "platform-sre")).toBe(true);
    expect(
      plan.communication!.edges.some((e) => e.event !== "agents.all/v1" && e.agent?.profile === "unrelated-sre"),
    ).toBe(false);
  });

  test("event list --json", () => {
    const r = hg(["event", "list", "--dir", FIXTURE, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("event-list");
    expect(doc.ok).toBe(true);
    const alert = doc.events.find((e: { event: string }) => e.event === "observability.alert/v1");
    expect(alert.producers).toEqual(["platform-sre/monitoring#alerts"]);
    expect(alert.outputs).toBe(3);
  });

  test("event routes --json: #350's per-route view with INDEPENDENT targets", () => {
    const r = hg(["event", "routes", "--dir", FIXTURE, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("event-routes");
    expect(doc.ok).toBe(true);
    const alerts = doc.routes.find((x: { route: string }) => x.route === "operational-alerts");
    expect(alerts).toBeDefined();
    // One route fanning out is N targets with N edge ids - never an
    // aggregate (#350's non-goal, pinned).
    expect(alerts.targets.length).toBeGreaterThan(1);
    const edgeIds = alerts.targets.map((t: { edge: string }) => t.edge);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
    const agent = alerts.targets.find((t: { kind: string }) => t.kind === "agent");
    expect(agent.profile).toBe("platform-sre");
    expect(agent.deadLetter).toBe(true);
  });

  test("event trace with no sink records says so rather than rendering nothing", () => {
    const r = hg(["event", "trace", "00000000-0000-0000-0000-000000000000", "--dir", FIXTURE, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("event-trace");
    expect(doc.records).toEqual([]);
  });

  test("event replay without a delivery id refuses with usage", () => {
    const r = hg(["event", "replay", "--dir", FIXTURE]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("hg event replay <delivery-id>");
  });

  test("event plan names producer, subscriber, non-subscriber absence, FIFO, spaces, and the generated Grafana URL", () => {
    const r = hg(["event", "plan", "observability.alert", "--dir", FIXTURE, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.durableProvider).toBe("redis-streams");
    expect(doc.producers[0].inject).toEqual({ app: "monitoring", path: "alert.webhookUrl" });
    expect(doc.producers[0].ingestUrl).toContain("/v1/events/");
    const agents = doc.edges.filter((e: { kind: string }) => e.kind === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0].agent.profile).toBe("platform-sre");
    expect(agents[0].delivery.ordering.key).toBe("subject");
    expect(doc.edges.some((e: { agent?: { profile: string } }) => e.agent?.profile === "unrelated-sre")).toBe(false);
    expect(doc.chatopsSpaces.map((s: { space: string }) => s.space).sort()).toEqual([
      "company_chat#channel-1",
      "company_chat#channel-2",
    ]);
  });

  test("event payload validate extracts the subject and enforces the schema", () => {
    const okRun = hg([
      "event", "payload", "validate", "observability.alert",
      "--dir", FIXTURE, "--payload", "fixtures/alert-firing.json", "--json",
    ]);
    expect(okRun.code).toBe(0);
    const doc = JSON.parse(okRun.stdout);
    expect(doc.ok).toBe(true);
    expect(doc.subject).toBe("incident/postiz-down");

    const badRun = hg([
      "event", "payload", "validate", "source.demo.alert",
      "--dir", FIXTURE, "--payload", "fixtures/alert-firing.json", "--json",
    ]);
    expect(badRun.code).toBe(1);
    expect(JSON.parse(badRun.stdout).ok).toBe(false);
  });

  test("chatops list + plan expose provider bindings, never secret values", () => {
    const r = hg(["chatops", "list", "--dir", FIXTURE, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.spaces).toHaveLength(2);
    expect(doc.spaces[0].provider).toBe("recording");

    const p = hg(["chatops", "plan", "company_chat#channel-1", "--dir", FIXTURE, "--json"]);
    expect(p.code).toBe(0);
    const planDoc = JSON.parse(p.stdout);
    expect(planDoc.routes.sort()).toEqual(["external-alert-triage", "operational-alerts"]);
  });

  test("chatops render produces the logical message and provider preview without sending", () => {
    const r = hg([
      "chatops", "render", "company_chat#channel-1",
      "--dir", FIXTURE, "--event", "observability.alert",
      "--payload", "fixtures/alert-firing.json", "--json",
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.logical.title).toContain("PostizDown");
    expect(doc.logical.severity).toBe("critical");
    expect(doc.logical.facts.subject).toBe("incident/postiz-down");
  });

  test("the slack-sandbox environment rebinds the alias to the real provider by reference only", () => {
    const envTopo = join(FIXTURE, "environments", "slack-sandbox", "topology.yaml");
    const r = hg(["chatops", "list", "--dir", FIXTURE, "--environment", envTopo, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.spaces[0].provider).toBe("slack");
    expect(doc.spaces[0].credentialRef).toEqual({ env: "HG_SLACK_BOT_TOKEN" });
    expect(r.stdout).not.toContain("xoxb");
  });

  test("unknown event and unknown space fail with the known sets named", () => {
    const e = hg(["event", "plan", "nope.event", "--dir", FIXTURE, "--json"]);
    expect(e.code).toBe(1);
    expect(e.stderr).toContain("observability.alert/v1");
    const s = hg(["chatops", "plan", "company_chat#nope", "--dir", FIXTURE, "--json"]);
    expect(s.code).toBe(1);
    expect(s.stderr).toContain("company_chat#channel-1");
  });
});

// ---------------------------------------------------------------------------
// The envelope module (shared by CLI, router, and eval runner)

describe("envelope", () => {
  const envelope = makeEnvelope({
    type: "observability.alert/v1",
    source: "hermes://platform-sre/apps/monitoring",
    environment: "local",
    subject: "incident/postiz-down",
    producerProfile: "platform-sre",
    data: { status: "firing", labels: { team: "platform" } },
  });

  test("identity: one event, one correlation, fresh delivery ids", () => {
    expect(envelope.id).toMatch(/^evt_[0-9a-f]{26}$/);
    expect(envelope.hermes.correlationId).toMatch(/^corr_[0-9a-f]{26}$/);
    expect(envelope.hermes.schema).toBe("observability.alert/v1");
  });

  test("envelopeField reads subject and data dot-paths", () => {
    expect(envelopeField(envelope, "subject")).toBe("incident/postiz-down");
    expect(envelopeField(envelope, "data.labels.team")).toBe("platform");
    expect(envelopeField(envelope, "data.labels.nope")).toBeUndefined();
  });

  test("session keys always carry environment/profile/route", () => {
    const opts = { environment: "local", profile: "platform-sre", route: "operational-alerts" } as const;
    expect(sessionKey(envelope, { ...opts, mode: "route" })).toBe("local/platform-sre/operational-alerts");
    expect(sessionKey(envelope, { ...opts, mode: "keyed", key: "subject" })).toBe(
      "local/platform-sre/operational-alerts/incident/postiz-down",
    );
    expect(sessionKey(envelope, { ...opts, mode: "per-event" })).toBe(
      `local/platform-sre/operational-alerts/${envelope.id}`,
    );
    // A keyed session with a missing key isolates per event - never shares.
    expect(sessionKey(envelope, { ...opts, mode: "keyed", key: "data.nope" })).toBe(
      `local/platform-sre/operational-alerts/${envelope.id}`,
    );
  });

  test("signing round-trips against the gateway scheme and rejects tampering", () => {
    const body = JSON.stringify(envelope);
    const headers = signedHeaders("secret-1", body);
    const ts = headers["x-webhook-timestamp"]!;
    expect(
      verifySignature("secret-1", ts, body, headers["x-webhook-signature-v2"]!, { nowSeconds: Number(ts) }),
    ).toEqual({ ok: true });
    expect(
      verifySignature("secret-2", ts, body, headers["x-webhook-signature-v2"]!, { nowSeconds: Number(ts) }),
    ).toEqual({ ok: false, reason: "mismatch" });
    expect(
      verifySignature("secret-1", ts, body + "x", headers["x-webhook-signature-v2"]!, { nowSeconds: Number(ts) }),
    ).toEqual({ ok: false, reason: "mismatch" });
    expect(
      verifySignature("secret-1", ts, body, headers["x-webhook-signature-v2"]!, { nowSeconds: Number(ts) + 400 }),
    ).toEqual({ ok: false, reason: "stale" });
  });
});
