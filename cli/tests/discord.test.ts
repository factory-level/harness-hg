// The Discord ChatOps provider: post -> read back -> delete against a
// fake Discord API (offline, always runs), plus one LIVE sandbox test
// that only runs when HG_DISCORD_BOT_TOKEN and HG_DISCORD_SANDBOX_CHANNEL
// are exported - the real-plugin proof of the goal doc.
//
// The redaction rule is a test, not a hope: no receipt, error, or JSON
// output may contain the token.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { discordDeliverAndVerify, renderDiscordEmbed, type LogicalMessage } from "../src/communication/index.ts";

const TOKEN = "fake-token-abcdef0123456789-SENTINEL";

const MESSAGE: LogicalMessage = {
  title: "Postiz is unavailable",
  summary: "The Postiz deployment has no available replicas.",
  severity: "critical",
  status: "firing",
  facts: { event: "observability.alert/v1", environment: "local", subject: "incident/postiz-down" },
  links: [],
};

interface FakeCall {
  method: string;
  path: string;
  auth: string | null;
  body?: unknown;
}

let fake: ReturnType<typeof Bun.serve>;
const calls: FakeCall[] = [];
const messages = new Map<string, unknown>();
let nextId = 1000;

beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const call: FakeCall = { method: req.method, path: url.pathname, auth: req.headers.get("authorization") };
      if (req.method === "POST") call.body = await req.json();
      calls.push(call);
      if (call.auth !== `Bot ${TOKEN}`) return new Response("{}", { status: 401 });
      const parts = url.pathname.split("/").filter(Boolean); // channels/<id>/messages[/<mid>]
      const channel = parts[1];
      if (channel === "no-such-channel") return new Response("{}", { status: 404 });
      if (req.method === "POST") {
        const id = String(nextId++);
        messages.set(id, call.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (req.method === "GET") {
        const id = parts[3]!;
        const stored = messages.get(id);
        return stored
          ? new Response(JSON.stringify(stored), { status: 200 })
          : new Response("{}", { status: 404 });
      }
      if (req.method === "DELETE") {
        messages.delete(parts[3]!);
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 400 });
    },
  });
  process.env["HG_DISCORD_API_BASE"] = `http://127.0.0.1:${fake.port}`;
});

afterAll(() => {
  delete process.env["HG_DISCORD_API_BASE"];
  fake?.stop(true);
});

describe("discord provider (fake API)", () => {
  test("delivers the embed, reads it back verified, and deletes the test message", async () => {
    calls.length = 0;
    const receipt = await discordDeliverAndVerify(TOKEN, "sandbox-channel", MESSAGE);
    expect(receipt.status).toBe("delivered");
    expect(receipt.providerMessageId).toBeDefined();
    expect(receipt.verified).toBe(true);
    expect(receipt.cleanedUp).toBe(true);
    // post -> read-back -> delete, in that order
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
    const embed = (calls[0]!.body as { embeds: { title: string; fields: { name: string }[] }[] }).embeds[0]!;
    expect(embed.title).toBe("Postiz is unavailable");
    expect(embed.fields.map((f) => f.name)).toContain("subject");
    // The redaction rule: the token exists in the Authorization header
    // and NOWHERE else.
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(JSON.stringify(calls[0]!.body)).not.toContain(TOKEN);
  });

  test("a rejected credential fails closed, classified, token-free", async () => {
    const receipt = await discordDeliverAndVerify("wrong-token", "sandbox-channel", MESSAGE);
    expect(receipt.status).toBe("failed");
    expect(receipt.classification).toBe("credential-rejected");
    expect(JSON.stringify(receipt)).not.toContain("wrong-token");
  });

  test("an unknown channel fails closed", async () => {
    const receipt = await discordDeliverAndVerify(TOKEN, "no-such-channel", MESSAGE);
    expect(receipt.status).toBe("failed");
    expect(receipt.classification).toBe("unknown-channel");
  });

  test("the embed projection carries severity color and status footer", () => {
    const embed = renderDiscordEmbed(MESSAGE) as { embeds: { color: number; footer?: { text: string } }[] };
    expect(embed.embeds[0]!.color).toBe(0xe01e5a); // critical
    expect(embed.embeds[0]!.footer?.text).toBe("status: firing");
  });
});

// The LIVE sandbox proof - a real Discord message ID, read back, deleted.
const LIVE_TOKEN = process.env["HG_DISCORD_BOT_TOKEN"];
const LIVE_CHANNEL = process.env["HG_DISCORD_SANDBOX_CHANNEL"];
const live = LIVE_TOKEN && LIVE_CHANNEL ? test : test.skip;

live("LIVE: posts to the sandbox channel, verifies, and cleans up", async () => {
  delete process.env["HG_DISCORD_API_BASE"]; // the real API
  try {
    const receipt = await discordDeliverAndVerify(LIVE_TOKEN!, LIVE_CHANNEL!, {
      ...MESSAGE,
      title: "hg communication-plane live test",
      summary: "Posted by the ADR-39 test suite; this message deletes itself.",
      severity: "info",
      status: undefined,
    });
    expect(receipt.status).toBe("delivered");
    expect(receipt.providerMessageId).toMatch(/^\d+$/); // a real Discord snowflake
    expect(receipt.cleanedUp).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(LIVE_TOKEN!);
  } finally {
    process.env["HG_DISCORD_API_BASE"] = `http://127.0.0.1:${fake.port}`;
  }
}, 60_000);
