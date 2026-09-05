// evals v1alpha2 typed invocation, end to end and offline: a synthesized
// v3 repository, the router (the chart's actual file) as a subprocess
// configured FROM the repository's own emitted record, and `hg eval` as
// a subprocess - the full runner path: invoke -> real router -> receipts
// -> expect checks -> evaluator env.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { loadContracts } from "../src/topology/contract.ts";
import { loadEnvironment } from "../src/topology/environment.ts";
import { compile } from "../src/topology/compile.ts";
import { renderTree } from "../src/topology/emit.ts";
import { freePort } from "../src/lib.ts";
import { verifySignature } from "../src/topology/envelope.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const ROUTER = join(import.meta.dir, "..", "..", "control-plane", "event-router", "chart", "files", "router.ts");
const SECRET = "eval-invoke-secret";
const EXT_SECRET = "eval-invoke-ext-secret";

let home = "";
let repo = "";
let gateway: ReturnType<typeof Bun.serve>;
let sink: ReturnType<typeof Bun.serve>;
let routerProc: ReturnType<typeof Bun.spawn> | undefined;
let routerPort = 0;
const gatewayHits: unknown[] = [];

beforeAll(async () => {
  // --- The repository: v3, one producer, a DIRECT route to the agent and
  // one space, plus an external input. Direct delivery keeps redis out of
  // this suite - the queued path has its own.
  repo = mkdtempSync(join(tmpdir(), "eval-inv-repo-"));
  const dir = join(repo, "distributions", "platform-sre");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "distribution.yaml"), yaml({ name: "platform-sre", version: "1.0.0" }));
  writeFileSync(
    join(dir, "hermes-gitops.yaml"),
    yaml({
      contractVersion: 3,
      endpoints: [{ name: "hooks", port: 8644, path: "/webhooks/alerts", type: "webhook", signature: "hmac-sha256" }],
      apps: [
        {
          name: "monitoring",
          chart: "charts/monitoring",
          repo: "local",
          outputs: [{ name: "alerts", event: "observability.alert/v1", subject: "groupKey" }],
        },
      ],
      communication: {
        routes: [
          {
            name: "operational-alerts",
            from: { app: "monitoring", output: "alerts" },
            outputs: [
              { agent: { profile: "platform-sre", handler: "alerts", session: { mode: "keyed", key: "subject" } } },
              { chatops: "company_discord#channel-1" },
            ],
          },
          {
            name: "external-triage",
            from: { externalInput: "demo-alert-source" },
            outputs: [{ agent: { profile: "platform-sre", handler: "alerts" } }],
          },
        ],
        externalInputs: [
          {
            name: "demo-alert-source",
            event: "source.demo.alert/v1",
            subject: "incident",
            verification: { type: "hmac-sha256", secretRef: { name: "demo-alert-source-webhook", key: "secret" } },
          },
        ],
      },
    }),
  );
  const envDir = join(repo, "environment");
  mkdirSync(envDir);
  writeFileSync(join(envDir, "communication.yaml"), yaml({ version: 1, chatopsConnections: { company_discord: { provider: "recording" } } }));

  // --- Destinations.
  gateway = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      const ts = req.headers.get("x-webhook-timestamp") ?? "";
      const sig = req.headers.get("x-webhook-signature-v2") ?? "";
      if (!verifySignature(SECRET, ts, body, sig, { nowSeconds: Number(ts) }).ok) {
        return new Response("{}", { status: 401 });
      }
      gatewayHits.push(JSON.parse(body));
      return new Response(JSON.stringify({ status: "accepted", delivery_id: "gw" }), { status: 200 });
    },
  });
  sink = Bun.serve({ port: 0, fetch: async () => new Response('{"ok": true}') });

  // --- The router, configured from the repository's OWN emitted record -
  // the values file the chart would consume, byte for byte.
  const { contracts, findings } = loadContracts(repo);
  const env = loadEnvironment(repo);
  const plan = compile(contracts, env.environment, { priorFindings: [...findings, ...env.findings] });
  if (!plan.ok) throw new Error(`fixture repo does not compile: ${JSON.stringify(plan.findings)}`);
  const tree = renderTree(repo, contracts, plan, env.environment, { sourceSha: "0".repeat(40) });
  const emitted = parseYaml(tree.get("deployments/communication/router/values.yaml")!) as { spec: Record<string, unknown> };
  // Point the agent edge at the fake gateway (the compiled URL names
  // cluster DNS; this is the only test-time substitution).
  for (const edge of (emitted.spec["edges"] as { agent?: { url: string } }[]) ?? []) {
    if (edge.agent) edge.agent.url = `http://127.0.0.1:${gateway.port}/webhooks/alerts`;
  }
  const routerDir = mkdtempSync(join(tmpdir(), "eval-inv-router-"));
  const secretsDir = join(routerDir, "secrets");
  mkdirSync(secretsDir);
  writeFileSync(join(secretsDir, "hermes-platform-sre-env"), SECRET);
  writeFileSync(join(secretsDir, "demo-alert-source-webhook"), EXT_SECRET);
  const configPath = join(routerDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ environment: "local", recordingBase: `http://127.0.0.1:${sink.port}`, spec: emitted.spec }));
  routerPort = freePort();
  routerProc = Bun.spawn(["bun", ROUTER], {
    env: { ...process.env, CONFIG_PATH: configPath, SECRETS_DIR: secretsDir, PORT: String(routerPort) },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${routerPort}/healthz`)).ok) break;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error("router never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // --- The CLI's home: onboarded state pointing at the repo + router.
  home = mkdtempSync(join(tmpdir(), "eval-inv-home-"));
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      profileDir: repo,
      profileName: "platform-sre",
      profiles: [{ name: "platform-sre", subdir: "distributions/platform-sre" }],
      trusted: true,
      ports: { git: 1, http: 1, sink: 1, router: routerPort },
      commExtSecrets: { "platform-sre/demo-alert-source": EXT_SECRET },
    }),
  );

  // --- The suite.
  const evals = join(repo, "evals");
  const fanout = join(evals, "scenarios", "fanout");
  const negative = join(evals, "scenarios", "negative");
  mkdirSync(join(fanout, "fixtures"), { recursive: true });
  mkdirSync(join(negative, "fixtures"), { recursive: true });
  writeFileSync(join(evals, "suite.yaml"), yaml({ apiVersion: "hermes-gitops.factorylevel.dev/evals/v1alpha2", name: "invoke-suite" }));
  writeFileSync(
    join(fanout, "fixtures", "firing.json"),
    JSON.stringify({ status: "firing", groupKey: "incident/x", alerts: [] }),
  );
  writeFileSync(
    join(fanout, "scenario.yaml"),
    yaml({
      name: "fanout",
      profile: "platform-sre",
      invoke: { event: { name: "observability.alert", payload: "fixtures/firing.json" } },
      expect: { outputs: [{ agent: { profile: "platform-sre" } }, { chatops: "company_discord#channel-1" }] },
      evaluate: "evaluate.sh",
    }),
  );
  writeFileSync(
    join(fanout, "evaluate.sh"),
    '#!/usr/bin/env bash\nset -e\ntest "$HG_EVAL_INVOCATION_TYPE" = event\ntest -s "$HG_EVAL_RECEIPTS"\ngrep -q accepted "$HG_EVAL_RECEIPTS"\ntest -n "$HG_EVAL_CORRELATION_ID"\n',
  );
  chmodSync(join(fanout, "evaluate.sh"), 0o755);
  writeFileSync(
    join(negative, "fixtures", "external.json"),
    JSON.stringify({ incident: "incident/y", severity: "warning", summary: "s" }),
  );
  writeFileSync(
    join(negative, "scenario.yaml"),
    yaml({
      name: "negative",
      profile: "platform-sre",
      invoke: { externalWebhook: { binding: "demo-alert-source", payload: "fixtures/external.json", signature: "invalid" } },
      expect: { rejected: { reason: "invalid-signature" } },
    }),
  );
});

afterAll(async () => {
  routerProc?.kill();
  await routerProc?.exited;
  gateway?.stop(true);
  sink?.stop(true);
});

// NOT spawnSync: the fake gateway/sink live in THIS process, and a
// blocking spawn would freeze the event loop they serve from.
async function hgEval(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", MAIN, "eval", ...args], {
    env: { ...process.env, HERMES_GITOPS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

describe("hg eval with typed invocation (v1alpha2)", () => {
  test("invoke -> real router -> receipts -> expect -> evaluator env, end to end", async () => {
    const proc = await hgEval(["--dir", join(repo, "evals"), "--json"]);
    const doc = JSON.parse(proc.stdout.toString()) as {
      ok: boolean;
      scenarios: { name: string; status: string; runs: { reason?: string }[] }[];
    };
    if (!doc.ok) console.error(JSON.stringify(doc, null, 2));
    expect(doc.ok).toBe(true);
    expect(doc.scenarios.find((s) => s.name === "fanout")?.status).toBe("pass");
    expect(doc.scenarios.find((s) => s.name === "negative")?.status).toBe("pass");
    expect(proc.exitCode).toBe(0);
    // The agent really was invoked - with a VERIFIED signature.
    expect(gatewayHits.length).toBeGreaterThan(0);
  }, 120_000);

  test("a wrong expectation fails the scenario with the missing destination named", async () => {
    const bad = join(repo, "evals", "scenarios", "wrong-expect");
    mkdirSync(join(bad, "fixtures"), { recursive: true });
    writeFileSync(join(bad, "fixtures", "firing.json"), JSON.stringify({ status: "firing", groupKey: "incident/z", alerts: [] }));
    writeFileSync(
      join(bad, "scenario.yaml"),
      yaml({
        name: "wrong-expect",
        profile: "platform-sre",
        invoke: { event: { name: "observability.alert", payload: "fixtures/firing.json" } },
        expect: { outputs: [{ chatops: "company_discord#not-routed" }] },
      }),
    );
    const proc = await hgEval(["--dir", join(repo, "evals"), "--scenario", "wrong-expect", "--json"]);
    const doc = JSON.parse(proc.stdout.toString()) as { ok: boolean; scenarios: { runs: { reason?: string }[] }[] };
    expect(doc.ok).toBe(false);
    expect(doc.scenarios[0]?.runs[0]?.reason).toContain("company_discord#not-routed");
    expect(proc.exitCode).toBe(1);
  }, 120_000);
});
