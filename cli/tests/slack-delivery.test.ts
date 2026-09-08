import { afterAll, beforeAll, expect, test } from "bun:test";
import { slackDeliver, renderSlackMessage } from "../src/communication/index.ts";
const token = "slack-token-sentinel";
const message = { title: "Postiz unavailable", summary: "<@everyone> & test", severity: "critical" as const, status: "firing", facts: { subject: "incident/postiz" }, links: [] };
let server: ReturnType<typeof Bun.serve>;
let result: Record<string, unknown> = { ok: true, ts: "123.456" };
let body: any;
const old = process.env.HG_SLACK_API_BASE;
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    body = await req.json();
    if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ ok: false, error: "invalid_auth" });
    return Response.json(result);
  } });
  process.env.HG_SLACK_API_BASE = `http://127.0.0.1:${server.port}`;
});
afterAll(() => { server?.stop(true); if (old === undefined) delete process.env.HG_SLACK_API_BASE; else process.env.HG_SLACK_API_BASE = old; });
test("Slack acceptance requires ok and a message timestamp; receipts never contain credentials", async () => {
  const receipt = await slackDeliver(token, "C123", message);
  expect(receipt).toMatchObject({ status: "delivered", providerMessageId: "123.456" });
  expect(body.channel).toBe("C123");
  expect(body.text).toContain("&lt;@everyone&gt; &amp; test");
  expect(JSON.stringify(receipt)).not.toContain(token);
  expect(JSON.stringify(body)).not.toContain(token);
  result = { ok: true };
  expect((await slackDeliver(token, "C123", message)).status).toBe("failed");
});
test("Slack API errors inside HTTP 200 responses fail closed", async () => {
  expect((await slackDeliver("wrong-token", "C123", message)).classification).toBe("credential-rejected");
  result = { ok: false, error: "channel_not_found" };
  expect((await slackDeliver(token, "C123", message)).classification).toBe("unknown-channel");
  result = { ok: false, error: "ratelimited" };
  expect((await slackDeliver(token, "C123", message)).classification).toBe("rate-limited");
});
test("rendering preserves severity and status while disabling automatic markup and unfurls", () => {
  const payload = renderSlackMessage(message);
  expect(payload.text).toContain("Severity: critical");
  expect(payload.text).toContain("Status: firing");
  expect(payload).toMatchObject({ mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false });
});
