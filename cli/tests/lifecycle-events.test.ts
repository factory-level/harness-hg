// Platform lifecycle events (ADR-65): severity mapping, mention
// rendering, registration idempotency and delivery - the last against
// the same fake Discord API the provider tests use. HG_HOME is a temp
// dir so nothing touches the operator's real ~/.hermes-gitops. Module
// paths read env at call time via LIFECYCLE_FILE(), which is what makes
// this isolation possible (the M0 lesson about frozen module state).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderDiscordEmbed } from "../src/communication/index.ts";

const TOKEN = "fake-lifecycle-token-SENTINEL";
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "hg-lifecycle-"));
const savedHome = process.env["HERMES_GITOPS_HOME"];
const savedToken = process.env["HG_DISCORD_BOT_TOKEN"];
process.env["HERMES_GITOPS_HOME"] = tempHome;
process.env["HG_DISCORD_BOT_TOKEN"] = TOKEN;

// lifecycle-events reads HERMES_GITOPS_HOME at CALL time (per-call hgHome()),
// so this redirection works regardless of module-load order in the suite.
const { LIFECYCLE_FILE, lifecycleMessage, lifecycleSeverity, registerEnvironment, emitLifecycleEvent } =
  await import("../src/communication/lifecycle-events.ts");

interface FakeCall {
  method: string;
  body?: unknown;
}
let fake: ReturnType<typeof Bun.serve>;
const calls: FakeCall[] = [];
let nextId = 5000;
const messages = new Map<string, unknown>();

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const call: FakeCall = { method: req.method };
      if (req.method === "POST") call.body = await req.json();
      calls.push(call);
      if (req.headers.get("authorization") !== `Bot ${TOKEN}`) return new Response("{}", { status: 401 });
      if (req.method === "POST") {
        const id = String(nextId++);
        messages.set(id, call.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (req.method === "GET") {
        const id = new URL(req.url).pathname.split("/").filter(Boolean)[3]!;
        const stored = messages.get(id);
        return stored ? new Response(JSON.stringify(stored)) : new Response("{}", { status: 404 });
      }
      return new Response(null, { status: 204 });
    },
  });
  process.env["HG_DISCORD_API_BASE"] = `http://127.0.0.1:${fake.port}`;
});

afterAll(() => {
  delete process.env["HG_DISCORD_API_BASE"];
  if (savedHome === undefined) delete process.env["HERMES_GITOPS_HOME"];
  else process.env["HERMES_GITOPS_HOME"] = savedHome;
  if (savedToken === undefined) delete process.env["HG_DISCORD_BOT_TOKEN"];
  else process.env["HG_DISCORD_BOT_TOKEN"] = savedToken;
  fake?.stop(true);
  fs.rmSync(tempHome, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  fs.rmSync(LIFECYCLE_FILE(), { force: true });
});

describe("lifecycleSeverity", () => {
  test("failed is critical regardless of kind", () => {
    for (const kind of ["bootstrap", "reconcile", "backup", "restore", "destroy", "approval"] as const)
      expect(lifecycleSeverity({ kind, phase: "failed" })).toBe("critical");
  });
  test("destroy and approval are warnings even when they succeed", () => {
    expect(lifecycleSeverity({ kind: "destroy", phase: "started" })).toBe("warning");
    expect(lifecycleSeverity({ kind: "approval", phase: "started" })).toBe("warning");
  });
  test("routine progress is info", () => {
    expect(lifecycleSeverity({ kind: "backup", phase: "completed" })).toBe("info");
  });
});

describe("lifecycleMessage + mention rendering", () => {
  const APPROVAL = {
    kind: "approval" as const,
    phase: "started" as const,
    environment: "factory",
    facts: { backupId: "hg-x" },
  };

  test("approval pings the operator role - top-level content plus the allowed_mentions grant", () => {
    const msg = lifecycleMessage(APPROVAL, { roleId: "9001" });
    const payload = renderDiscordEmbed(msg) as { content?: string; allowed_mentions?: { roles: string[] } };
    expect(payload.content).toBe("<@&9001>");
    expect(payload.allowed_mentions).toEqual({ roles: ["9001"] });
  });

  test("progress events never ping, even with a role registered", () => {
    const msg = lifecycleMessage(
      { kind: "backup", phase: "completed", environment: "factory", facts: {} },
      { roleId: "9001" },
    );
    expect(msg.mention).toBeUndefined();
    const payload = renderDiscordEmbed(msg) as { content?: string };
    expect(payload.content).toBeUndefined();
  });

  test("no registered role means no mention, even for approvals", () => {
    expect(lifecycleMessage(APPROVAL, {}).mention).toBeUndefined();
  });
});

describe("registerEnvironment", () => {
  test("registers once and records the non-sensitive identity", async () => {
    const reg = await registerEnvironment({ environment: "factory", channelId: "777", facts: {} });
    expect(reg.messageId).toBeDefined();
    const onDisk = JSON.parse(fs.readFileSync(LIFECYCLE_FILE(), "utf8"));
    expect(onDisk.channelId).toBe("777");
    expect(JSON.stringify(onDisk)).not.toContain(TOKEN);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("re-registering the same environment+channel posts NOTHING - no duplicate permanent message", async () => {
    await registerEnvironment({ environment: "factory", channelId: "777", facts: {} });
    calls.length = 0;
    await registerEnvironment({ environment: "factory", channelId: "777", facts: {} });
    expect(calls).toHaveLength(0);
  });
});

describe("emitLifecycleEvent", () => {
  test("without a registration it is a quiet no-op - an unregistered environment has nowhere to report", async () => {
    await emitLifecycleEvent({ kind: "backup", phase: "completed", environment: "factory", facts: {} });
    expect(calls).toHaveLength(0);
  });

  test("with a registration the event lands, and the message stays (no cleanup of real events)", async () => {
    await registerEnvironment({ environment: "factory", channelId: "777", facts: {} });
    calls.length = 0;
    await emitLifecycleEvent({ kind: "restore", phase: "completed", environment: "factory", facts: { backup: "hg-x" } });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(JSON.stringify(posts[0]!.body)).toContain("Harness Hg restore");
  });

  test("a delivery failure never throws - the operation it narrates must not die of a Discord outage", async () => {
    await registerEnvironment({ environment: "factory", channelId: "777", facts: {} });
    const saved = process.env["HG_DISCORD_API_BASE"];
    process.env["HG_DISCORD_API_BASE"] = "http://127.0.0.1:1"; // nothing listens
    try {
      await emitLifecycleEvent({ kind: "backup", phase: "completed", environment: "factory", facts: {} });
    } finally {
      process.env["HG_DISCORD_API_BASE"] = saved;
    }
  });
});
