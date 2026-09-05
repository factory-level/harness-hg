// Queued delivery through real Redis Streams: the router runs as a
// SUBPROCESS (exactly how the chart runs it) against a dockerized
// redis:7-alpine and a controllable fake agent gateway. Proves durable
// acceptance, same-key FIFO with cross-key concurrency, retry ->
// dead-letter -> replay, duplicate suppression, and - by killing and
// restarting the router process - consumer-restart survival.
//
// Skips (visibly) when docker is unavailable; CI and dev machines that
// can run the local loop can run this.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "../src/lib.ts";

const ROUTER = join(import.meta.dir, "..", "..", "control-plane", "event-router", "chart", "files", "router.ts");
const SECRET = "queued-test-secret";

const dockerOk = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const d = dockerOk ? describe : describe.skip;

let redisName = "";
let redisPort = 0;
let gateway: ReturnType<typeof Bun.serve>;
let gatewayMode: "ok" | "fail" = "ok";
const gatewayHits: { path: string; body: { subject?: string; data?: { hgSeq?: number }; id?: string } }[] = [];
let sink: ReturnType<typeof Bun.serve>;
let routerPort = 0;
let routerProc: ReturnType<typeof Bun.spawn> | undefined;
let configPath = "";
let secretsDir = "";

function redisCli(...args: string[]): string {
  const proc = Bun.spawnSync(["docker", "exec", redisName, "redis-cli", ...args]);
  return proc.stdout.toString().trim();
}

async function startRouter(): Promise<void> {
  routerProc = Bun.spawn(["bun", ROUTER], {
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      SECRETS_DIR: secretsDir,
      PORT: String(routerPort),
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${routerPort}/healthz`);
      if (resp.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("router subprocess never became healthy");
}

async function stopRouter(): Promise<void> {
  routerProc?.kill();
  await routerProc?.exited;
  routerProc = undefined;
}

async function post(path: string, body: unknown): Promise<{ status: number; doc: any }> {
  const resp = await fetch(`http://127.0.0.1:${routerPort}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, doc: await resp.json() };
}

async function waitFor(pred: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function receiptsFor(pred: (r: any) => boolean): Promise<any[]> {
  const resp = await fetch(`http://127.0.0.1:${routerPort}/v1/status`);
  const doc = (await resp.json()) as { receipts: any[] };
  return doc.receipts.filter(pred);
}

beforeAll(async () => {
  if (!dockerOk) return;
  redisPort = freePort();
  redisName = `hg-router-test-redis-${Math.random().toString(36).slice(2, 8)}`;
  const run = Bun.spawnSync(["docker", "run", "-d", "--rm", "--name", redisName, "-p", `${redisPort}:6379`, "redis:7-alpine"]);
  if (run.exitCode !== 0) throw new Error(`docker run redis failed: ${run.stderr.toString()}`);
  await waitFor(() => redisCli("ping") === "PONG", 15_000, "redis ping");

  gateway = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { subject?: string; data?: { hgSeq?: number }; id?: string };
      if (gatewayMode === "fail") return new Response("{}", { status: 503 });
      gatewayHits.push({ path: new URL(req.url).pathname, body });
      return new Response(JSON.stringify({ status: "accepted", delivery_id: "gw" }), { status: 200 });
    },
  });
  sink = Bun.serve({ port: 0, fetch: async () => new Response('{"ok": true}') });

  const dir = mkdtempSync(join(tmpdir(), "router-q-"));
  secretsDir = join(dir, "secrets");
  mkdirSync(secretsDir);
  writeFileSync(join(secretsDir, "hermes-platform-sre-env"), SECRET);
  configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      environment: "local",
      recordingBase: `http://127.0.0.1:${sink.port}`,
      spec: {
        router: { id: "router", scope: "global", namespace: "hermes-system", service: "hermes-event-router" },
        durableProvider: { plugin: "redis-streams", config: { retryBaseMs: 20 } },
        chatopsConnections: { company_discord: { provider: "recording" } },
        producers: [
          {
            id: "platform-sre/monitoring#alerts",
            name: "platform-sre/monitoring#alerts",
            profile: "platform-sre",
            app: "monitoring",
            appInstance: "platform-sre/monitoring",
            output: "alerts",
            event: "observability.alert/v1",
            subject: "groupKey",
            ingestPath: "/v1/events/platform-sre-monitoring-alerts",
            routes: ["operational-alerts"],
          },
        ],
        externalInputs: [],
        edges: [
          {
            id: "e-agent",
            route: "operational-alerts",
            profile: "platform-sre",
            from: { producer: "platform-sre/monitoring#alerts" },
            event: "observability.alert/v1",
            kind: "agent",
            agent: {
              profile: "platform-sre",
              handler: "alerts",
              instance: "platform-sre",
              url: `http://127.0.0.1:${gateway.port}/webhooks/alerts`,
              signature: "hmac-sha256",
              secretName: "hermes-platform-sre-env",
              session: { mode: "keyed", key: "subject" },
            },
            delivery: {
              mode: "queued",
              retry: { maxAttempts: 3, backoff: "exponential" },
              deadLetter: { enabled: true },
              ordering: { mode: "fifo", key: "subject", onFailure: "dead-letter-and-continue" },
            },
          },
          {
            id: "e-chatops",
            route: "operational-alerts",
            profile: "platform-sre",
            from: { producer: "platform-sre/monitoring#alerts" },
            event: "observability.alert/v1",
            kind: "chatops",
            chatops: { space: "company_discord#channel-1", alias: "company_discord", destination: "channel-1", provider: "recording" },
            delivery: { mode: "queued", retry: { maxAttempts: 3, backoff: "exponential" }, deadLetter: { enabled: true } },
          },
        ],
      },
    }),
  );
  routerPort = freePort();
  await startRouter();
});

afterAll(async () => {
  await stopRouter().catch(() => {});
  gateway?.stop(true);
  sink?.stop(true);
  if (redisName) Bun.spawnSync(["docker", "rm", "-f", redisName], { stdout: "ignore", stderr: "ignore" });
});

d("queued delivery on redis streams (router subprocess)", () => {
  test("durable acceptance, then worker delivery on the queued transport", async () => {
    gatewayMode = "ok";
    const { status, doc } = await post("/v1/events/platform-sre-monitoring-alerts", {
      groupKey: "incident-basic",
      status: "firing",
    });
    expect(status).toBe(202);
    expect(doc.deliveries.every((x: any) => x.status === "queued")).toBe(true);
    await waitFor(
      async () =>
        (await receiptsFor((r) => r.eventId === doc.eventId && ["accepted", "delivered"].includes(r.status))).length === 2,
      10_000,
      "both queued deliveries terminal",
    );
    const done = await receiptsFor((r) => r.eventId === doc.eventId && ["accepted", "delivered"].includes(r.status));
    expect(done.every((r) => r.transport === "queued")).toBe(true);
  }, 30_000);

  test("same-key FIFO holds while a second key runs concurrently", async () => {
    gatewayMode = "ok";
    gatewayHits.length = 0;
    const emitted: { key: string; seq: number; eventId: string }[] = [];
    for (let seq = 0; seq < 4; seq++) {
      for (const key of ["incident-a", "incident-b"]) {
        const { doc } = await post("/v1/events/platform-sre-monitoring-alerts", {
          groupKey: key,
          status: "firing",
          hgSeq: seq,
        });
        emitted.push({ key, seq, eventId: doc.eventId });
      }
    }
    await waitFor(async () => gatewayHits.length >= 8, 15_000, "all 8 agent deliveries");
    for (const key of ["incident-a", "incident-b"]) {
      const seqs = gatewayHits
        .filter((h) => h.body.subject === key)
        .map((h) => (h.body.data as { hgSeq?: number }).hgSeq);
      expect(seqs).toEqual([0, 1, 2, 3]); // same-key order preserved
    }
  }, 60_000);

  test("retry exhaustion dead-letters; replay succeeds once the destination recovers", async () => {
    gatewayMode = "fail";
    const { doc } = await post("/v1/events/platform-sre-monitoring-alerts?toAgent=platform-sre", {
      groupKey: "incident-dlq",
      status: "firing",
    });
    await waitFor(
      async () => (await receiptsFor((r) => r.eventId === doc.eventId && r.status === "dead-lettered")).length === 1,
      15_000,
      "dead-letter receipt",
    );
    const dlq = await fetch(`http://127.0.0.1:${routerPort}/v1/dlq`).then((r) => r.json() as Promise<{ entries: any[] }>);
    expect(dlq.entries.some((e) => e.eventId === doc.eventId)).toBe(true);

    gatewayMode = "ok";
    gatewayHits.length = 0;
    const replay = await post("/v1/dlq/replay", { deliveryId: doc.deliveries[0].deliveryId });
    expect(replay.status).toBe(200);
    await waitFor(
      async () => (await receiptsFor((r) => r.eventId === doc.eventId && r.status === "accepted")).length >= 1,
      10_000,
      "replayed delivery accepted",
    );
    const after = await fetch(`http://127.0.0.1:${routerPort}/v1/dlq`).then((r) => r.json() as Promise<{ entries: any[] }>);
    expect(after.entries.some((e) => e.eventId === doc.eventId)).toBe(false);
  }, 60_000);

  test("duplicate event ids do not repeat the side effect", async () => {
    gatewayMode = "ok";
    gatewayHits.length = 0;
    const envelope = {
      specversion: "1.0",
      id: "evt_dedup_test_000000000000",
      type: "observability.alert/v1",
      source: "hermes://platform-sre/apps/monitoring",
      subject: "incident-dup",
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      hermes: {
        environment: "local",
        producerProfile: "platform-sre",
        correlationId: "corr_dedup_test_00000000000",
        orderingKey: "incident-dup",
        schema: "observability.alert/v1",
      },
      data: { groupKey: "incident-dup", status: "firing" },
    };
    const stream = "hermes:edge:e-agent";
    redisCli("XADD", stream, "*", "message", JSON.stringify({ deliveryId: "delivery_dup_1", envelope }));
    redisCli("XADD", stream, "*", "message", JSON.stringify({ deliveryId: "delivery_dup_2", envelope }));
    await waitFor(
      async () => (await receiptsFor((r) => r.eventId === envelope.id && ["accepted", "duplicate"].includes(r.status))).length === 2,
      10_000,
      "one accept + one duplicate",
    );
    const receipts = await receiptsFor((r) => r.eventId === envelope.id);
    expect(receipts.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(receipts.filter((r) => r.status === "duplicate")).toHaveLength(1);
    expect(gatewayHits.filter((h) => h.body.id === envelope.id)).toHaveLength(1);
  }, 30_000);

  test("the router recovers by itself when REDIS restarts (#277)", async () => {
    // Found live: Bun's client stops reconnecting after maxRetries (10 by
    // default), so an ordinary Redis pod restart permanently killed the
    // durable transport - every queued delivery failed forever, /metrics
    // 503'd, and the overlay reported the router "not configured", which
    // reads as "nothing here" rather than "your queue is dead". Nothing
    // recovered it but a router restart. This pins the recovery.
    gatewayMode = "ok";
    gatewayHits.length = 0;
    Bun.spawnSync(["docker", "restart", redisName]);
    await waitFor(() => redisCli("ping") === "PONG", 30_000, "redis back after restart");

    // The SAME router process (never restarted) must deliver again.
    const envelope = {
      specversion: "1.0",
      id: "evt_redis_restart_00000000",
      type: "observability.alert/v1",
      source: "hermes://platform-sre/apps/monitoring",
      subject: "incident-redis-restart",
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      hermes: {
        environment: "local",
        producerProfile: "platform-sre",
        correlationId: "corr_redis_restart_000000",
        orderingKey: "incident-redis-restart",
        schema: "observability.alert/v1",
      },
      data: { groupKey: "incident-redis-restart", status: "firing" },
    };
    redisCli(
      "XADD",
      "hermes:edge:e-agent",
      "*",
      "message",
      JSON.stringify({ deliveryId: "delivery_redis_restart_1", envelope }),
    );
    await waitFor(
      async () => gatewayHits.some((h) => h.body.id === envelope.id),
      30_000,
      "delivery after a redis restart, with no router restart",
    );
    // And the scrape is serving live queue facts again, not 503.
    const res = await fetch(`http://127.0.0.1:${routerPort}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hermes_router_redis_up 1");
    expect(body).toContain("hermes_event_pending_depth{");
  }, 60_000);

  test("a queued event survives a consumer restart", async () => {
    gatewayMode = "ok";
    gatewayHits.length = 0;
    await stopRouter();
    // Enqueued while NO consumer exists - durable state only.
    const envelope = {
      specversion: "1.0",
      id: "evt_restart_test_0000000000",
      type: "observability.alert/v1",
      source: "hermes://platform-sre/apps/monitoring",
      subject: "incident-restart",
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      hermes: {
        environment: "local",
        producerProfile: "platform-sre",
        correlationId: "corr_restart_test_000000000",
        orderingKey: "incident-restart",
        schema: "observability.alert/v1",
      },
      data: { groupKey: "incident-restart", status: "firing" },
    };
    redisCli("XADD", "hermes:edge:e-agent", "*", "message", JSON.stringify({ deliveryId: "delivery_restart_1", envelope }));
    await startRouter();
    await waitFor(async () => gatewayHits.some((h) => h.body.id === envelope.id), 15_000, "delivery after restart");
    // The receipt is recorded after the destination's acceptance settles -
    // poll for it rather than racing the last two redis round-trips.
    await waitFor(
      async () => (await receiptsFor((r) => r.eventId === envelope.id && r.status === "accepted")).length === 1,
      10_000,
      "restart delivery receipt",
    );
  }, 30_000);
});
