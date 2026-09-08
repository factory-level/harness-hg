// The event router, live: import the chart's ACTUAL file
// (control-plane/event-router/chart/files/router.ts) against fake
// destinations - a signature-verifying stand-in for the Hermes agent
// gateway and a recording sink. Parity with cli/src/topology/envelope.ts
// is asserted with the real verifier, so the self-contained router cannot
// drift from the one engine silently.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifySignature } from "../src/topology/envelope.ts";

const SECRET = "test-secret-platform-sre";
const EXT_SECRET = "test-secret-demo-binding";

interface CapturedDelivery {
  path: string;
  headers: Record<string, string>;
  body: unknown;
  signatureOk: boolean;
}

const gatewayDeliveries: CapturedDelivery[] = [];
const sinkDeliveries: { path: string; body: unknown }[] = [];
// The recording sink receives chatops captures AND (ADR-74) the router's
// fire-and-forget observer records - count by path, never the raw array.
const chatops = () => sinkDeliveries.filter((s) => s.path.startsWith("/chatops/"));
const observed = () =>
  sinkDeliveries.filter((s) => s.path === "/observer").map((s) => s.body as { kind: string; [k: string]: unknown });

let gateway: ReturnType<typeof Bun.serve>;
let sink: ReturnType<typeof Bun.serve>;
let router: { port: number };
let slackResult = { status: 200, body: { ok: true, ts: "123.456" } as Record<string, unknown> };
const slackCalls: { auth: string | null; body: any }[] = [];
// The connection gateway (ADR-152): a fake eve agent that records what the
// router forwards verbatim, a Discord-style Ed25519 keypair whose PUBLIC
// half is the connection's DISCORD_PUBLIC_KEY, and a GitHub webhook secret.
let eveAgent: ReturnType<typeof Bun.serve>;
const forwarded: { path: string; headers: Record<string, string>; body: string }[] = [];
const discordKeys = generateKeyPairSync("ed25519");
const DISCORD_PUBLIC_HEX = (discordKeys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
const GITHUB_WEBHOOK_SECRET = "gh-webhook-secret-for-tests";

beforeAll(async () => {
  // The fake agent gateway: verifies X-Webhook-Signature-V2 exactly as
  // the Hermes gateway does, replies with the gateway's acceptance shape.
  gateway = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const ts = req.headers.get("x-webhook-timestamp") ?? "";
      const sig = req.headers.get("x-webhook-signature-v2") ?? "";
      const verdict = verifySignature(SECRET, ts, body, sig, { nowSeconds: Number(ts) });
      gatewayDeliveries.push({
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body: JSON.parse(body),
        signatureOk: verdict.ok,
      });
      if (!verdict.ok) return new Response(JSON.stringify({ status: "rejected" }), { status: 401 });
      return new Response(JSON.stringify({ status: "accepted", delivery_id: "gw_123" }), { status: 200 });
    },
  });
  sink = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/slack/chat.postMessage") {
        slackCalls.push({auth:req.headers.get("authorization"),body:await req.json()});
        return Response.json(slackResult.body,{status:slackResult.status});
      }
      sinkDeliveries.push({ path: url.pathname, body: await req.json() });
      return new Response('{"ok": true}');
    },
  });

  eveAgent = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      forwarded.push({ path: url.pathname, headers: Object.fromEntries(req.headers.entries()), body });
      // eve's deferred ACK shape for a command interaction
      return new Response(JSON.stringify({ type: 5 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const dir = mkdtempSync(join(tmpdir(), "router-"));
  const secretsDir = join(dir, "secrets");
  mkdirSync(secretsDir);
  mkdirSync(join(secretsDir, "connections", "company-discord"), { recursive: true });
  mkdirSync(join(secretsDir, "connections", "platform-github"), { recursive: true });
  writeFileSync(join(secretsDir, "connections", "company-discord", "DISCORD_PUBLIC_KEY"), DISCORD_PUBLIC_HEX);
  writeFileSync(join(secretsDir, "connections", "platform-github", "GITHUB_WEBHOOK_SECRET"), GITHUB_WEBHOOK_SECRET);
  writeFileSync(join(secretsDir, "hermes-platform-sre-env"), SECRET);
  writeFileSync(join(secretsDir, "demo-alert-source-webhook"), EXT_SECRET);
  // The generic-webhook credential IS the URL - point it at the sink so
  // the delivery is captured like any other.
  writeFileSync(join(secretsDir, "company-info-webhook-url"), `http://127.0.0.1:${sink.port}/info-webhook`);

  writeFileSync(join(secretsDir, "factory-slack-token"), "fixture-slack-token");
  process.env.SLACK_API_BASE = `http://127.0.0.1:${sink.port}/slack`;
  const config = {
    environment: "local",
    recordingBase: `http://127.0.0.1:${sink.port}`,
    spec: {
      router: { id: "router", scope: "global", namespace: "hermes-system", service: "hermes-event-router" },
      durableProvider: { plugin: "redis-streams" },
      chatopsConnections: {
        company_chat: { provider: "recording" },
        factory_slack: {provider:"slack",credentialRef:{name:"factory-slack-token",key:"value"}},
        missing_slack: {provider:"slack",credentialRef:{name:"not-present",key:"value"}},
        company_info: {
          provider: "generic-webhook",
          credentialRef: { name: "company-info-webhook-url", key: "value" },
        },
      },
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
        {
          id: "platform-sre/agent#vision-report",
          name: "platform-sre/agent#vision-report",
          profile: "platform-sre",
          app: "agent",
          appInstance: "platform-sre/agent",
          output: "vision-report",
          event: "vision.report/v1",
          subject: "repository",
          ingestPath: "/v1/events/platform-sre-vision-report",
          routes: ["vision-report"],
        },
      ],
      connections: [
        {
          name: "company-discord",
          provider: "discord",
          secretName: "connection-company-discord",
          verifyKey: "DISCORD_PUBLIC_KEY",
          routes: [
            { profile: "echo", url: `http://127.0.0.1:${eveAgent.port}/eve/v1/discord`, match: { guilds: ["111"] } },
            { profile: "greeter", url: `http://127.0.0.1:${eveAgent.port}/greeter/eve/v1/discord`, match: {} },
          ],
        },
        {
          name: "platform-github",
          provider: "github",
          secretName: "connection-platform-github",
          verifyKey: "GITHUB_WEBHOOK_SECRET",
          routes: [{ profile: "echo", url: `http://127.0.0.1:${eveAgent.port}/eve/v1/github`, match: { repositories: ["factory-level/harness-hg"] } }],
        },
      ],
      externalInputs: [
        {
          id: "platform-sre/demo-alert-source",
          profile: "platform-sre",
          name: "demo-alert-source",
          event: "source.demo.alert/v1",
          subject: "incident",
          verification: { type: "hmac-sha256", secretRef: { name: "demo-alert-source-webhook", key: "secret" } },
          hookPath: "/v1/hooks/platform-sre-demo-alert-source",
          routes: ["external-triage"],
        },
        {
          id: "platform-sre/brand-brief",
          profile: "platform-sre",
          name: "brand-brief",
          event: "source.demo.alert/v1",
          subject: "incident",
          verification: {
            type: "github-hmac-sha256",
            secretRef: { name: "demo-alert-source-webhook", key: "secret" },
          },
          accepts: ["push"],
          hookPath: "/v1/hooks/platform-sre-brand-brief",
          routes: ["external-triage"],
        },
      ],
      edges: [
        {
          id: "e-ext-agent",
          route: "external-triage",
          profile: "platform-sre",
          from: { externalInput: "platform-sre/demo-alert-source" },
          event: "source.demo.alert/v1",
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
          delivery: { mode: "direct", retry: { maxAttempts: 1, backoff: "fixed" }, deadLetter: { enabled: false } },
        },
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
            retry: { maxAttempts: 5, backoff: "exponential" },
            deadLetter: { enabled: true },
            ordering: { mode: "fifo", key: "subject", onFailure: "dead-letter-and-continue" },
          },
        },
        {
          id: "e-chatops-1",
          route: "operational-alerts",
          profile: "platform-sre",
          from: { producer: "platform-sre/monitoring#alerts" },
          event: "observability.alert/v1",
          kind: "chatops",
          chatops: { space: "company_chat#channel-1", alias: "company_chat", destination: "channel-1", provider: "recording" },
          delivery: { mode: "queued", retry: { maxAttempts: 5, backoff: "exponential" }, deadLetter: { enabled: true } },
        },
        {
          id: "e-chatops-2",
          route: "operational-alerts",
          profile: "platform-sre",
          from: { producer: "platform-sre/monitoring#alerts" },
          event: "observability.alert/v1",
          kind: "chatops",
          chatops: { space: "company_chat#channel-2", alias: "company_chat", destination: "channel-2", provider: "recording" },
          delivery: { mode: "queued", retry: { maxAttempts: 5, backoff: "exponential" }, deadLetter: { enabled: true } },
        },
        {
          id: "e-chatops-info",
          route: "vision-report",
          profile: "platform-sre",
          from: { producer: "platform-sre/agent#vision-report" },
          event: "vision.report/v1",
          kind: "chatops",
          chatops: { space: "company_info#info", alias: "company_info", destination: "info", provider: "generic-webhook" },
          delivery: { mode: "queued", retry: { maxAttempts: 2, backoff: "fixed" }, deadLetter: { enabled: false } },
        },
      ],
    },
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  process.env["CONFIG_PATH"] = configPath;
  process.env["SECRETS_DIR"] = secretsDir;
  process.env["PORT"] = "0";
  const mod = await import("../../control-plane/event-router/chart/files/router.ts");
  router = mod.server as { port: number };
});

afterAll(() => {
  gateway?.stop(true);
  sink?.stop(true);
  eveAgent?.stop(true);
});

const FIRING = {
  status: "firing",
  groupKey: "incident/postiz-down",
  title: "[FIRING:1] PostizDown",
  message: "The Postiz deployment has no available replicas.",
  alerts: [{ status: "firing", labels: { severity: "critical", team: "platform" }, annotations: {} }],
};

async function post(path: string, body: unknown): Promise<{ status: number; doc: any }> {
  const resp = await fetch(`http://127.0.0.1:${router.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, doc: await resp.json() };
}

describe("event router (the chart's actual file)", () => {
  test("fan-out: one event, one correlation, three independent deliveries", async () => {
    gatewayDeliveries.length = 0;
    sinkDeliveries.length = 0;
    const { status, doc } = await post("/v1/events/platform-sre-monitoring-alerts", FIRING);
    expect(status).toBe(202);
    expect(doc.status).toBe("accepted");
    expect(doc.eventId).toMatch(/^evt_/);
    expect(doc.correlationId).toMatch(/^corr_/);
    expect(doc.subject).toBe("incident/postiz-down");
    expect(doc.deliveries).toHaveLength(3);
    const ids = new Set(doc.deliveries.map((d: { deliveryId: string }) => d.deliveryId));
    expect(ids.size).toBe(3); // one delivery id per edge, never shared
    for (const d of doc.deliveries) expect(d.correlationId).toBe(doc.correlationId);

    // The agent got ONE signed POST at its own gateway handler.
    expect(gatewayDeliveries).toHaveLength(1);
    const gw = gatewayDeliveries[0]!;
    expect(gw.path).toBe("/webhooks/alerts");
    expect(gw.signatureOk).toBe(true); // the envelope.ts verifier accepted the router's signature
    const envelope = gw.body as { type: string; subject: string; hermes: { environment: string } };
    expect(envelope.type).toBe("observability.alert/v1");
    expect(envelope.subject).toBe("incident/postiz-down");
    expect(gw.headers["x-hermes-session-key"]).toBe("local/platform-sre/operational-alerts/incident/postiz-down");

    // Both spaces got their own recorded message.
    expect(chatops().map((s) => s.path).sort()).toEqual([
      "/chatops/company_chat/channel-1",
      "/chatops/company_chat/channel-2",
    ]);
    const recorded = chatops()[0]!.body as { message: { title: string; severity: string }; event: { correlationId: string } };
    expect(recorded.message.title).toContain("PostizDown");
    expect(recorded.message.severity).toBe("critical");
    expect(recorded.event.correlationId).toBe(doc.correlationId);
    // No secret material in anything the providers received.
    expect(JSON.stringify(sinkDeliveries)).not.toContain(SECRET);
  });

  test("same subject keeps the same session key across firing and resolved", async () => {
    const a = await post("/v1/events/platform-sre-monitoring-alerts", FIRING);
    const b = await post("/v1/events/platform-sre-monitoring-alerts", { ...FIRING, status: "resolved" });
    const key = (r: any) => r.doc.deliveries.find((d: any) => d.kind === "agent").sessionKey;
    expect(key(a)).toBe(key(b));
    expect(a.doc.eventId).not.toBe(b.doc.eventId);
    expect(a.doc.correlationId).not.toBe(b.doc.correlationId);
  });

  test("narrowing: --to-chatops delivers to exactly one space, the agent untouched", async () => {
    gatewayDeliveries.length = 0;
    sinkDeliveries.length = 0;
    const { doc } = await post(
      "/v1/events/platform-sre-monitoring-alerts?toChatops=company_chat%23channel-2",
      FIRING,
    );
    expect(doc.deliveries).toHaveLength(1);
    expect(doc.deliveries[0].space).toBe("company_chat#channel-2");
    expect(gatewayDeliveries).toHaveLength(0);
    expect(chatops()).toHaveLength(1);
  });

  test("unknown producer and invalid JSON are rejected, classified", async () => {
    const unknown = await post("/v1/events/nope", {});
    expect(unknown.status).toBe(404);
    expect(unknown.doc.reason).toBe("unknown-producer");
    const bad = await fetch(`http://127.0.0.1:${router.port}/v1/events/platform-sre-monitoring-alerts`, {
      method: "POST",
      body: "not json",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { reason: string }).reason).toBe("invalid-json");
  });

  test("status traces receipts by correlation", async () => {
    const { doc } = await post("/v1/events/platform-sre-monitoring-alerts", FIRING);
    const resp = await fetch(`http://127.0.0.1:${router.port}/v1/status?correlation=${doc.correlationId}`);
    const status = (await resp.json()) as { receipts: { correlationId: string }[]; counters: Record<string, number> };
    expect(status.receipts).toHaveLength(3);
    expect(status.receipts.every((r) => r.correlationId === doc.correlationId)).toBe(true);
    expect(status.counters["hermes_events_published_total"]).toBeGreaterThan(0);
  });

  test("chatops test delivers one synthetic message through the provider binding", async () => {
    sinkDeliveries.length = 0;
    const { status, doc } = await post("/v1/test/chatops", { space: "company_chat#channel-1" });
    expect(status).toBe(200);
    expect(doc.status).toBe("delivered");
    expect(doc.providerMessageId).toMatch(/^recording-/);
    expect(chatops()).toHaveLength(1);
    const unknown = await post("/v1/test/chatops", { space: "nobody#nowhere" });
    expect(unknown.status).toBe(404);
  });

  test("Slack confirms delivery, escapes mentions and fails on API-level errors", async () => {
    slackCalls.length = 0;
    let result = await post("/v1/test/chatops", {space:"factory_slack#C1", payload:{title:"Alert <!channel>",summary:"check <@U1>"}});
    expect(result.status).toBe(200);
    expect(result.doc.providerMessageId).toBe("123.456");
    expect(slackCalls[0]!.auth).toBe("Bearer fixture-slack-token");
    expect(slackCalls[0]!.body.channel).toBe("C1");
    expect(slackCalls[0]!.body.text).not.toContain("<!channel>");
    expect(slackCalls[0]!.body.unfurl_links).toBe(false);
    for (const [status,error,classification] of [[200,"not_in_channel","unknown-channel"],[200,"invalid_auth","credential-rejected"],[429,"ratelimited","rate-limited"],[503,"fatal_error","destination-5xx"]] as const) {
      slackResult={status,body:{ok:false,error}};
      result=await post("/v1/test/chatops",{space:"factory_slack#C1"});
      expect(result.status).toBe(502);
      expect(result.doc.classification).toBe(classification);
      expect(JSON.stringify(result.doc)).not.toContain("fixture-slack-token");
    }
    slackResult={status:200,body:{ok:true,ts:"123.456"}};
    const before=slackCalls.length;
    result=await post("/v1/test/chatops",{space:"missing_slack#C1"});
    expect(result.doc.classification).toBe("no-credential");
    expect(slackCalls.length).toBe(before);
  });

  test("external ingress: the full signature matrix, replay, and payload-selector immunity", async () => {
    const { signedHeaders } = await import("../src/topology/envelope.ts");
    const hookPath = "/v1/hooks/platform-sre-demo-alert-source";
    const url = `http://127.0.0.1:${router.port}${hookPath}`;
    const payload = JSON.stringify({
      incident: "incident/dns",
      severity: "warning",
      summary: "s",
      profile: "unrelated-sre", // a selector-shaped key that must have NO routing effect
    });
    const send = (headers: Record<string, string>, body = payload) =>
      fetch(url, { method: "POST", headers, body }).then(async (r) => ({ status: r.status, doc: (await r.json()) as any }));

    gatewayDeliveries.length = 0;
    const valid = await send(signedHeaders(EXT_SECRET, payload));
    expect(valid.status).toBe(202);
    expect(valid.doc.subject).toBe("incident/dns");
    // Routing came from compiled IaC; the selector key was ignored AND
    // the non-effect is stated in the response.
    expect(valid.doc.ignoredSelectors).toEqual(["profile"]);
    expect(valid.doc.routing).toBe("compiled-iac-only");
    expect(valid.doc.deliveries).toHaveLength(1);
    expect(gatewayDeliveries).toHaveLength(1); // platform-sre's gateway, nobody else's

    const replay = await send(signedHeaders(EXT_SECRET, payload));
    expect(replay.status).toBe(409);
    expect(replay.doc.reason).toBe("replay");

    const invalid = await send(signedHeaders("wrong-secret", payload));
    expect(invalid.status).toBe(401);
    expect(invalid.doc.reason).toBe("invalid-signature");

    const missing = await send({ "content-type": "application/json" });
    expect(missing.status).toBe(401);
    expect(missing.doc.reason).toBe("missing-signature");

    const stale = await send(signedHeaders(EXT_SECRET, payload, Date.now() - 3600_000));
    expect(stale.status).toBe(401);
    expect(stale.doc.reason).toBe("stale-signature");

    const unknown = await fetch(`http://127.0.0.1:${router.port}/v1/hooks/nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(unknown.status).toBe(404);

    const wrongType = await send({ ...signedHeaders(EXT_SECRET, payload), "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);
  });

  test("/metrics exposes the counters as Prometheus text with a presence marker", async () => {
    const res = await fetch(`http://127.0.0.1:${router.port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    // The presence marker the overlay's communication source keys on: an
    // idle router has bumped no counters, so only this proves it's there.
    expect(body).toContain("# TYPE hermes_router_up gauge");
    expect(body).toContain("hermes_router_up 1");
    // Same numbers /v1/status serves, rendered as counters.
    const status = await (await fetch(`http://127.0.0.1:${router.port}/v1/status`)).json();
    for (const [name, value] of Object.entries(status.counters as Record<string, number>)) {
      expect(body).toContain(`# TYPE ${name} counter`);
      expect(body).toContain(`${name} ${value}`);
    }
    // No redis in this harness: the dlq gauge must be absent entirely,
    // never present-with-a-guess.
    expect(body).not.toContain("hermes_event_dlq_depth");
  });

  test("/metrics stamps when each edge last delivered and last failed (#277)", async () => {
    // "Is this route working?" needs recency, not just cumulative counts.
    // The failing-destination case below produces both outcomes on the
    // same event, which is exactly the pair an operator compares.
    await post("/v1/events/platform-sre-monitoring-alerts", FIRING);
    const body = await (await fetch(`http://127.0.0.1:${router.port}/metrics`)).text();
    expect(body).toContain("# TYPE hermes_event_last_delivery_timestamp_seconds gauge");
    const stamps = body
      .split("\n")
      .filter((l) => l.startsWith("hermes_event_last_delivery_timestamp_seconds{"));
    expect(stamps.length).toBeGreaterThan(0);
    for (const line of stamps) {
      expect(line).toMatch(/outcome="(success|failure)"/);
      // Seconds, not milliseconds, and roughly now.
      const seconds = Number(line.split(" ").pop());
      expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(120);
    }
  });

  test("a GitHub-signed webhook is verified on its own terms (#278)", async () => {
    // GitHub signs the RAW BODY with no timestamp and names the event in
    // its own header. The contract has always allowed declaring this
    // scheme; the runtime never read verification.type until now.
    const url = `http://127.0.0.1:${router.port}/v1/hooks/platform-sre-brand-brief`;
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      after: "4f2c1ab9e0d3c7a15b6e8f209d4c3b7a1e5f6082",
      repository: { full_name: "factory-level/vision-manager" },
      incident: "brand-brief",
    });
    const sign = (secret: string, body: string) =>
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const send = (headers: Record<string, string>, body = payload) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    const guid = "11111111-2222-3333-4444-555555555555";
    const good = await send({
      "x-hub-signature-256": sign(EXT_SECRET, payload),
      "x-github-event": "push",
      "x-github-delivery": guid,
    });
    expect(good.status).toBe(202);
    // Fan-out itself is the generic scheme's test; this one is about
    // whether GitHub's signature is accepted on GitHub's own terms.
    const doc = (await good.json()) as { binding: string; correlationId: string };
    expect(doc.binding).toBe("platform-sre/brand-brief");
    expect(doc.correlationId).toMatch(/^corr_/);

    // GitHub's own "Redeliver" button reuses the guid: that is the
    // duplicate an idempotent consumer must absorb, not a new event.
    const replay = await send({
      "x-hub-signature-256": sign(EXT_SECRET, payload),
      "x-github-event": "push",
      "x-github-delivery": guid,
    });
    expect(replay.status).toBe(409);

    // A wrong secret, a missing signature, and an unaccepted event kind.
    const wrong = await send({
      "x-hub-signature-256": sign("not-the-secret", payload),
      "x-github-event": "push",
      "x-github-delivery": "aaaa",
    });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).reason).toBe("invalid-signature");

    const bare = await send({ "x-github-event": "push", "x-github-delivery": "bbbb" });
    expect(bare.status).toBe(401);
    expect((await bare.json()).reason).toBe("missing-signature");

    const wrongKind = await send({
      "x-hub-signature-256": sign(EXT_SECRET, payload),
      "x-github-event": "issues",
      "x-github-delivery": "cccc",
    });
    expect(wrongKind.status).toBe(422);

    // The platform's own timestamped scheme must NOT be accepted here -
    // a binding declares one scheme and gets exactly that one.
    const { signedHeaders } = await import("../src/topology/envelope.ts");
    const generic = await send({ ...signedHeaders(EXT_SECRET, payload), "x-github-event": "push" });
    expect(generic.status).toBe(401);
  });

  test("a generic-webhook chatops edge posts the embed to the credential URL", async () => {
    const before = sinkDeliveries.filter((s) => s.path === "/info-webhook").length;
    const { status, doc } = await post("/v1/events/platform-sre-vision-report", {
      repository: "factory-level/vision-manager",
      summary: "vision repository changed",
      severity: "info",
    });
    expect(status).toBe(202);
    expect(doc.deliveries).toHaveLength(1);
    // Queued delivery: wait for the worker to drain to the webhook sink.
    for (let i = 0; i < 200; i++) {
      if (sinkDeliveries.filter((s) => s.path === "/info-webhook").length > before) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const hits = sinkDeliveries.filter((s) => s.path === "/info-webhook");
    expect(hits.length).toBe(before + 1);
    const body = hits[hits.length - 1]!.body as { title?: string; severity?: string; embeds?: unknown };
    expect(typeof body.title).toBe("string");
    expect(body.severity).toBe("info");
    expect(body.embeds).toBeUndefined();
  });

  test("a failing destination never blocks the other edges", async () => {
    // Kill the gateway; chatops must still deliver.
    gateway.stop(true);
    sinkDeliveries.length = 0;
    const { status, doc } = await post("/v1/events/platform-sre-monitoring-alerts", FIRING);
    expect(status).toBe(202);
    const agent = doc.deliveries.find((d: any) => d.kind === "agent");
    expect(agent.status).toBe("failed");
    expect(["unreachable", "destination-5xx"]).toContain(agent.classification);
    expect(doc.deliveries.filter((d: any) => d.status === "delivered")).toHaveLength(2);
    expect(chatops()).toHaveLength(2);
  });

  test("observer records mirror the lifecycle, metadata only (ADR-74)", async () => {
    sinkDeliveries.length = 0;
    const { doc } = await post("/v1/events/platform-sre-monitoring-alerts", FIRING);
    // Fire-and-forget: poll briefly rather than racing the fetches.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const kindsSoFar = observed().map((o) => o.kind);
      if (kindsSoFar.includes("event.received") && kindsSoFar.some((k) => k.startsWith("delivery."))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const kinds = observed().map((o) => o.kind);
    expect(kinds).toContain("event.received");
    expect(kinds.some((k) => k.startsWith("delivery."))).toBe(true);
    const received = observed().find((o) => o.kind === "event.received")!;
    expect(received.correlationId).toBe(doc.correlationId);
    expect(received.router).toBe("router");
    // Metadata only: no payload, no signature material, no secret.
    expect("data" in received).toBe(false);
    expect(JSON.stringify(observed())).not.toContain(SECRET);
    expect(JSON.stringify(observed())).not.toContain("PostizDown");
  });

  test("a rejected external hook leaves an event.rejected observer record", async () => {
    sinkDeliveries.length = 0;
    const resp = await fetch(`http://127.0.0.1:${router.port}/v1/hooks/platform-sre-brand-brief`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "push" },
      body: JSON.stringify({ anything: true }),
    });
    expect(resp.status).toBe(401);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (observed().some((o) => o.kind === "event.rejected")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const rejected = observed().find((o) => o.kind === "event.rejected")!;
    expect(rejected.reason).toBe("invalid-signature");
    expect(JSON.stringify(rejected)).not.toContain("deadbeef");
  });

  test("a dead observer never blocks delivery (LAST: kills the sink)", async () => {
    sink.stop(true);
    gatewayDeliveries.length = 0;
    // The agent gateway was stopped by the failing-destination test above;
    // chatops delivery through the recording provider now ALSO fails
    // (recordingBase is down) - but ingress must still accept and classify,
    // and nothing may hang on the observer.
    const { status, doc } = await post("/v1/events/platform-sre-monitoring-alerts", FIRING);
    expect(status).toBe(202);
    expect(doc.deliveries).toHaveLength(3);
  });
});

describe("business outcomes (#408)", () => {
  // The four scenarios the ticket names, against the chart's real router:
  // success, terminal failure, duplicate suppression, and the inactivity
  // signal an alert needs (a counter that simply stops moving).
  const ingest = "/v1/events/platform-sre-monitoring-alerts";
  const EVENT = "observability.alert/v1";

  const series = async (): Promise<Record<string, number>> => {
    const body = await (await fetch(`http://127.0.0.1:${router.port}/metrics`)).text();
    const out: Record<string, number> = {};
    for (const line of body.split("\n")) {
      const m = line.match(/^hermes_business_outcome_total\{event="([^"]+)",outcome="([^"]+)"\} (\d+)$/);
      if (m) out[`${m[1]}|${m[2]}`] = Number(m[3]);
      const d = line.match(/^hermes_business_outcome_duplicates_total (\d+)$/);
      if (d) out["duplicates"] = Number(d[1]);
    }
    return out;
  };

  const outcome = (over: Record<string, unknown>) => ({
    ...FIRING,
    groupKey: "business/test",
    ...over,
  });

  test("a success is counted exactly once", async () => {
    const before = await series();
    await post(ingest, outcome({ outcome: "succeeded", eventId: "op-1" }));
    const after = await series();
    expect(after[`${EVENT}|succeeded`] ?? 0).toBe((before[`${EVENT}|succeeded`] ?? 0) + 1);
  });

  test("a terminal failure is a distinguishable signal, not an absence", async () => {
    const before = await series();
    await post(ingest, outcome({ outcome: "failed", eventId: "op-2" }));
    const after = await series();
    expect(after[`${EVENT}|failed`] ?? 0).toBe((before[`${EVENT}|failed`] ?? 0) + 1);
    // The success series must NOT move - a failure that also bumped
    // success would make every rate meaningless.
    expect(after[`${EVENT}|succeeded`] ?? 0).toBe(before[`${EVENT}|succeeded`] ?? 0);
  });

  test("a replayed event does not double-count, and says it was suppressed", async () => {
    await post(ingest, outcome({ outcome: "succeeded", eventId: "op-dupe" }));
    const before = await series();
    // The same logical outcome, twice more - a webhook retry.
    await post(ingest, outcome({ outcome: "succeeded", eventId: "op-dupe" }));
    await post(ingest, outcome({ outcome: "succeeded", eventId: "op-dupe" }));
    const after = await series();
    expect(after[`${EVENT}|succeeded`]).toBe(before[`${EVENT}|succeeded`]);
    expect(after["duplicates"] ?? 0).toBe((before["duplicates"] ?? 0) + 2);
  });

  test("an event carrying no outcome is transport-only and moves no business series", async () => {
    // Every existing producer is this case: business counting must be
    // opt-in, or the ledger fills with events that describe no operation.
    const before = await series();
    await post(ingest, outcome({}));
    const after = await series();
    expect(after).toEqual(before);
  });

  test("an unrecognised outcome value is ignored rather than counted", async () => {
    const before = await series();
    for (const bad of ["success", "SUCCEEDED", "ok", "", "done", 1, null]) {
      await post(ingest, outcome({ outcome: bad, eventId: `bad-${String(bad)}` }));
    }
    expect(await series()).toEqual(before);
  });

  test("cardinality is bounded by the declared producers", async () => {
    // The label can only ever be a declared producer's event type, so the
    // series count has a ceiling that lives in Git.
    const body = await (await fetch(`http://127.0.0.1:${router.port}/metrics`)).text();
    const events = new Set(
      [...body.matchAll(/^hermes_business_outcome_total\{event="([^"]+)"/gm)].map((m) => m[1]),
    );
    // These are the event types this fixture's producers declare. A label
    // outside the set would mean a payload could invent a series name.
    const declared = new Set(["observability.alert/v1", "vision.report/v1"]);
    for (const e of events) expect({ e, declared: declared.has(e!) }).toEqual({ e, declared: true });
  });
});

describe("the connection gateway (ADR-152): POST /v1/connect/<provider>/<name>", () => {
  const discordPost = async (body: string, opts: { sign?: boolean; forge?: boolean; ts?: string } = {}) => {
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.sign !== false) {
      const sig = opts.forge
        ? "00".repeat(64)
        : edSign(null, Buffer.from(ts + body, "utf8"), discordKeys.privateKey).toString("hex");
      headers["x-signature-ed25519"] = sig;
      headers["x-signature-timestamp"] = ts;
    }
    const resp = await fetch(`http://127.0.0.1:${router.port}/v1/connect/discord/company-discord`, { method: "POST", headers, body });
    return { status: resp.status, doc: await resp.json().catch(() => null) };
  };
  let deliverySeq = 0;
  const githubPost = async (body: string, event: string, opts: { sign?: boolean; forge?: boolean; delivery?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": opts.delivery ?? `d-${++deliverySeq}` };
    if (opts.sign !== false) {
      headers["x-hub-signature-256"] = opts.forge ? "sha256=" + "00".repeat(32) : "sha256=" + createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex");
    }
    const resp = await fetch(`http://127.0.0.1:${router.port}/v1/connect/github/platform-github`, { method: "POST", headers, body });
    return { status: resp.status, doc: await resp.json().catch(() => null) };
  };

  test("retired Discord gateway never forwards, even with a valid signature", async () => {
    forwarded.length = 0;
    expect((await discordPost(JSON.stringify({ type: 1 }))).status).toBe(404);
    expect((await discordPost(JSON.stringify({ type: 2, guild_id: "111" }))).status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  test("github: ping answered by the gateway; a signed issue_comment is routed by repository and forwarded verbatim", async () => {
    forwarded.length = 0;
    const ping = await githubPost(JSON.stringify({ zen: "x", hook_id: 1 }), "ping");
    expect(ping.status).toBe(200);
    const body = JSON.stringify({ action: "created", repository: { full_name: "factory-level/harness-hg" }, comment: { body: "@echo hi" } });
    const { status } = await githubPost(body, "issue_comment");
    expect(status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.path).toBe("/eve/v1/github");
    expect(forwarded[0]!.body).toBe(body);
    expect(forwarded[0]!.headers["x-hub-signature-256"]).toMatch(/^sha256=/);
    expect(forwarded[0]!.headers["x-github-event"]).toBe("issue_comment");
    expect(forwarded[0]!.headers["x-github-delivery"]).toMatch(/^d-\d+$/);
  });

  test("replays are refused: a repeated GitHub delivery id", async () => {
    forwarded.length = 0;
    const body = JSON.stringify({ action: "created", repository: { full_name: "factory-level/harness-hg" } });
    expect((await githubPost(body, "issue_comment", { delivery: "dup-1" })).status).toBe(200);
    const again = await githubPost(body, "issue_comment", { delivery: "dup-1" });
    expect(again.status).toBe(409);
    expect(again.doc.reason).toBe("replay");
    expect(forwarded).toHaveLength(1);
  });

  test("github: a forged signature, a missing one, and an unbound repository are refused", async () => {
    forwarded.length = 0;
    const body = JSON.stringify({ action: "created", repository: { full_name: "factory-level/harness-hg" } });
    expect((await githubPost(body, "issue_comment", { forge: true })).status).toBe(401);
    expect((await githubPost(body, "issue_comment", { sign: false })).status).toBe(401);
    const other = JSON.stringify({ action: "created", repository: { full_name: "someone/else" } });
    const r = await githubPost(other, "issue_comment");
    expect(r.status).toBe(422);
    expect(r.doc.reason).toBe("no-matching-route");
    expect(forwarded).toHaveLength(0);
  });

  test("an undeclared connection or provider is 404, and no rejection ever echoes the payload", async () => {
    const resp = await fetch(`http://127.0.0.1:${router.port}/v1/connect/discord/nope`, { method: "POST", body: "{}" });
    expect(resp.status).toBe(404);
    const bad = await fetch(`http://127.0.0.1:${router.port}/v1/connect/slack/company-discord`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(404);
    // Rejection bodies carry a reason and nothing of the request: no
    // payload field, no signature material.
    const forged = await discordPost(JSON.stringify({ type: 2, guild_id: "111", secretish: "do-not-echo" }), { forge: true });
    expect(forged.status).toBe(404);
    expect(JSON.stringify(forged.doc)).not.toContain("do-not-echo");
    expect(JSON.stringify(forged.doc)).not.toContain("guild_id");
    expect(forged.doc).toEqual({ status: "rejected", reason: "unknown-connection" });
  });

  test("the pure helpers: route selection and both verifiers", async () => {
    const mod = await import("../../control-plane/event-router/chart/files/router.ts");
    const conn = { name: "c", provider: "github" as const, secretName: "s", verifyKey: "K", routes: [
      { profile: "a", url: "http://a", match: { guilds: ["1"], channels: ["9"] } },
      { profile: "b", url: "http://b", match: { channels: ["9"] } },
    ] };
    expect(mod.selectConnectionRoute(conn, { guild_id: "1", channel_id: "9" })?.profile).toBe("a");
    expect(mod.selectConnectionRoute(conn, { guild_id: "2", channel_id: "9" })?.profile).toBe("b");
    expect(mod.selectConnectionRoute(conn, { guild_id: "2", channel_id: "8" })).toBeUndefined();
    expect(mod.verifyGithubSignature("k", "body", "sha256=" + createHmac("sha256", "k").update("body").digest("hex"))).toBe(true);
    expect(mod.verifyGithubSignature("k", "body", "sha256=deadbeef")).toBe(false);
  });
});
