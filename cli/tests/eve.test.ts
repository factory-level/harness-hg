// The Eve session-protocol handling hg relies on (ADR-149), offline: the
// NDJSON stream reducer, the create-session envelope, the 401 path, the
// turn boundary, and the ProofResult shape - all through an injected
// fetch. No cluster, no model.
import { describe, expect, test } from "bun:test";
import { parseStreamLines, reduceTurn, runTurn, type Fetch } from "../src/harness/eve/index.ts";

const ndjson = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix) || url.includes(suffix)) return handler(init);
    }
    return new Response("not found", { status: 404 });
  }) as Fetch;
}

describe("parseStreamLines / reduceTurn", () => {
  test("parses NDJSON, drops a partial trailing line", () => {
    const text = ndjson([{ type: "session.started" }, { type: "turn.started" }]) + '{"type":"mess';
    expect(parseStreamLines(text).map((e) => e.type)).toEqual(["session.started", "turn.started"]);
  });

  test("the terminal reply is the last message.completed without a tool-call finishReason", () => {
    const out = reduceTurn([
      { type: "session.started" },
      { type: "message.completed", data: { message: "Let me check.", finishReason: "tool-calls" } },
      { type: "action.result" },
      { type: "message.completed", data: { message: "pong", finishReason: "stop" } },
      { type: "turn.completed" },
      { type: "session.waiting" },
    ]);
    expect(out.text).toBe("pong");
    expect(out.completed).toBe(true);
    expect(out.failure).toBeUndefined();
  });

  test("a turn.failed is a failure with its code, even after text", () => {
    const out = reduceTurn([
      { type: "message.completed", data: { message: "partial" } },
      { type: "turn.failed", data: { code: "model_error", message: "no credential" } },
    ]);
    expect(out.completed).toBe(false);
    expect(out.failure).toBe("model_error: no credential");
    expect(out.text).toBe("partial");
  });

  test("no boundary at all is not completed", () => {
    expect(reduceTurn([{ type: "session.started" }]).completed).toBe(false);
  });
});

describe("proveSessionContract (EVE006..011 over a fake agent)", () => {
  /** A fake agent that behaves exactly as the documented routes do. */
  function fakeAgent(opts: { eveVersion?: string; agentName?: string } = {}) {
    const sessions = new Map<string, { terminal: boolean }>();
    const byOp = new Map<string, string>();
    let n = 0;
    const authed = (init?: RequestInit) => !!(init?.headers as Record<string, string>)?.["authorization"];
    const J = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    return ((async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const u = new URL(url);
      const p = u.pathname;
      if (!authed(init)) return new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="agent"' } });
      if (p === "/eve/v1/info") return J(200, { agent: { name: opts.agentName ?? "echo", model: { id: "anthropic/x" } }, tools: { a: [] }, channels: {} });
      const m = p.match(/^\/eve\/v1\/session(?:\/([^/]+))?(?:\/(cancel|clear|reset|stream))?$/);
      if (!m) return new Response("nf", { status: 404 });
      const [, id, action] = m;
      if (!id) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (!body.message) return J(400, { ok: false, error: "Missing or empty 'message' field." });
        let sid = body.operationId ? byOp.get(body.operationId) : undefined;
        if (!sid) {
          sid = `wrun_${++n}`;
          sessions.set(sid, { terminal: false });
          if (body.operationId) byOp.set(body.operationId, sid);
        }
        return J(202, { ok: true, sessionId: sid, status: "accepted" });
      }
      const s = sessions.get(id);
      if (action === "stream") {
        if (!s) return J(409, { ok: false, code: "session_not_active" });
        return new Response(
          ndjson([
            { type: "session.started", data: { runtime: { agentName: opts.agentName ?? "echo", eveVersion: opts.eveVersion ?? "0.42.0" } } },
            { type: "turn.started" },
            { type: "message.received", data: { message: "hg agent prove: protocol check" } },
            { type: "turn.completed" },
            { type: "session.waiting" },
          ]),
          { status: 200 },
        );
      }
      if (action === "cancel") return J(s && !s.terminal ? 202 : 200, { ok: true, status: s && !s.terminal ? "accepted" : "no_active_turn", ...(s ? { sessionId: id } : {}) });
      if (action === "clear") return J(s && !s.terminal ? 202 : 200, { ok: true, status: s && !s.terminal ? "accepted" : "no_active_session" });
      if (action === "reset") {
        if (s && !s.terminal) {
          s.terminal = true;
          return J(200, { ok: true, status: "reset" });
        }
        return J(200, { ok: true, status: "no_active_session" });
      }
      // follow-up
      if (!s || s.terminal) return J(409, { ok: false, code: "session_not_active", error: "The session is no longer active." });
      return J(202, { ok: true, sessionId: id, status: "accepted" });
    }) as unknown) as Fetch;
  }

  async function run(f: Fetch, version = "0.42.0", name = "echo") {
    const { proveSessionContract, sessionApi } = await import("../src/harness/eve/index.ts");
    const out: Record<string, { status: string; message: string }> = {};
    await proveSessionContract(sessionApi("http://agent", "pw", f), name, version, (id, status, message) => {
      out[id] = { status, message };
    });
    return out;
  }

  test("a documented-behaviour agent passes every leg", async () => {
    const out = await run(fakeAgent());
    for (const id of ["EVE006", "EVE007", "EVE008", "EVE009", "EVE010", "EVE011"]) {
      expect({ id, ...out[id] }).toMatchObject({ id, status: "pass" });
    }
    expect(out["EVE008"]!.message).toContain("session.started → turn.started → message.received");
    expect(out["EVE009"]!.message).toContain("== versions.json pin");
  });

  test("a runtime that is not the pinned eve release fails EVE009 only", async () => {
    const out = await run(fakeAgent({ eveVersion: "0.41.0" }));
    expect(out["EVE009"]!.status).toBe("fail");
    expect(out["EVE008"]!.status).toBe("pass");
    expect(out["EVE010"]!.status).toBe("pass");
  });

  test("an agent answering under another name fails EVE009", async () => {
    const out = await run(fakeAgent({ agentName: "other" }));
    expect(out["EVE009"]!.status).toBe("fail");
  });

  test("an agent that accepts anonymous controls fails EVE011", async () => {
    const inner = fakeAgent();
    const leaky = (async (input: string | URL | Request, init?: RequestInit) =>
      inner(input, { ...init, headers: { ...(init?.headers as object), authorization: "Basic leak" } })) as Fetch;
    const out = await run(leaky);
    expect(out["EVE011"]!.status).toBe("fail");
    expect(out["EVE006"]!.status).toBe("fail"); // info must also refuse anonymous callers
  });
});

describe("summarizeEvalReport (eve eval --json, 0.42.0 shape)", () => {
  test("one line per result, one per assertion, verdict counts", async () => {
    const { summarizeEvalReport } = await import("../src/harness/eve/index.ts");
    const { lines, counts } = summarizeEvalReport({
      results: [
        { id: "echoes", verdict: "passed", assertions: [{ name: "succeeded", passed: true, severity: "gate" }] },
        { id: "weather/brooklyn", verdict: "failed", error: "boom", assertions: [{ name: "includes(x)", passed: false, severity: "gate" }] },
      ],
      passed: 1,
      failed: 1,
      scored: 0,
      skipped: 0,
      errored: 1,
    });
    expect(lines).toEqual([
      "✓ echoes: passed",
      "    ✓ succeeded [gate]",
      "✗ weather/brooklyn: failed (boom)",
      "    ✗ includes(x) [gate]",
    ]);
    expect(counts).toEqual({ passed: 1, failed: 1, scored: 0, skipped: 0, errored: 1 });
  });

  test("an unparseable report yields no lines", async () => {
    const { summarizeEvalReport } = await import("../src/harness/eve/index.ts");
    expect(summarizeEvalReport(null)).toEqual({ lines: [], counts: {} });
  });
});

describe("runTurn", () => {
  const accepted = JSON.stringify({ ok: true, sessionId: "wrun_A", status: "accepted" });

  test("happy path: create -> stream -> terminal text", async () => {
    const seen: { auth?: string | null; body?: string } = {};
    const f = fakeFetch({
      "/eve/v1/session/wrun_A/stream": () =>
        new Response(
          ndjson([
            { type: "session.started" },
            { type: "message.completed", data: { message: "pong", finishReason: "stop" } },
            { type: "turn.completed" },
            { type: "session.waiting" },
          ]),
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        ),
      "/eve/v1/session": (init) => {
        seen.auth = (init?.headers as Record<string, string>)["authorization"];
        seen.body = String(init?.body);
        return new Response(accepted, { status: 202, headers: { "content-type": "application/json" } });
      },
    });
    const r = await runTurn("http://x", "s3cret", "ping", 5_000, f);
    expect(r).toEqual({ ok: true, output: "pong", sessionId: "wrun_A" });
    expect(seen.auth).toBe("Basic " + Buffer.from("agent:s3cret").toString("base64"));
    expect(JSON.parse(seen.body!)).toEqual({ message: "ping" });
  });

  test("a 401 on create is reported as a route-auth rejection", async () => {
    const f = fakeFetch({
      "/eve/v1/session": () => new Response("", { status: 401, headers: { "www-authenticate": "Basic realm=\"agent\"" } }),
    });
    const r = await runTurn("http://x", "wrong", "ping", 5_000, f);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("route auth rejected");
  });

  test("a create without the accepted envelope is an error, not a stream attempt", async () => {
    let streamed = false;
    const f = fakeFetch({
      "/stream": () => {
        streamed = true;
        return new Response("", { status: 200 });
      },
      "/eve/v1/session": () => new Response(JSON.stringify({ ok: false, error: "bad" }), { status: 400 }),
    });
    const r = await runTurn("http://x", "s", "ping", 5_000, f);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("400");
    expect(streamed).toBe(false);
  });

  test("a turn.failed on the stream surfaces its message", async () => {
    const f = fakeFetch({
      "/stream": () =>
        new Response(ndjson([{ type: "turn.failed", data: { code: "provider", message: "AI_GATEWAY_API_KEY unset" } }]), {
          status: 200,
        }),
      "/eve/v1/session": () => new Response(accepted, { status: 202 }),
    });
    const r = await runTurn("http://x", "s", "ping", 5_000, f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("provider: AI_GATEWAY_API_KEY unset");
    expect(r.sessionId).toBe("wrun_A");
  });

  test("a stalled session create is bounded by the same timeout", async () => {
    const f = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as Fetch;
    const started = Date.now();
    const r = await runTurn("http://x", "s", "ping", 300, f);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no turn boundary within 300ms");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("the stream is read to the turn boundary, not to EOF", async () => {
    // A stream that never closes: a ReadableStream that emits the turn and
    // then idles. runTurn must return on session.waiting, before the timeout.
    const f = fakeFetch({
      "/stream": () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                ndjson([
                  { type: "message.completed", data: { message: "pong", finishReason: "stop" } },
                  { type: "session.waiting" },
                ]),
              ),
            );
            // never closes
          },
        });
        return new Response(stream, { status: 200 });
      },
      "/eve/v1/session": () => new Response(accepted, { status: 202 }),
    });
    const started = Date.now();
    const r = await runTurn("http://x", "s", "ping", 10_000, f);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("pong");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("resolvePlacement (ADR-150: bundle-aware coordinates)", () => {
  test("standalone: own namespace, Service, pod, port 3000, own Secrets", async () => {
    const { resolvePlacement } = await import("../src/harness/eve/index.ts");
    expect(resolvePlacement("echo", undefined, false)).toEqual({
      namespace: "ag-eve-echo",
      service: "ag-eve-echo",
      port: 3000,
      pod: "ag-eve-echo-0",
      container: "eve-agent",
      routeAuthSecret: "ag-eve-echo-route-auth",
      envSecret: "ag-eve-echo-env",
    });
  });

  test("bundled AND deployed: the bundle's namespace/Service/pod, the member's port, container and Secrets", async () => {
    const { resolvePlacement } = await import("../src/harness/eve/index.ts");
    const placement = { bundle: "team", namespace: "ag-eve-team", service: "ag-eve-team", memberIndex: 1, envSecretRef: "ag-eve-team-greeter-env" };
    expect(resolvePlacement("greeter", placement, true)).toEqual({
      namespace: "ag-eve-team",
      service: "ag-eve-team",
      port: 3001,
      pod: "ag-eve-team-0",
      container: "greeter",
      routeAuthSecret: "ag-eve-team-greeter-route-auth",
      envSecret: "ag-eve-team-greeter-env",
      bundle: "team",
    });
    // A declared apiServerPort wins over the index rule (the chart's rule).
    expect(resolvePlacement("greeter", { ...placement, apiServerPort: 3100 }, true).port).toBe(3100);
  });

  test("declared but NOT deployed as a bundle: standalone coordinates (the factory runs the same repo unbundled)", async () => {
    const { resolvePlacement } = await import("../src/harness/eve/index.ts");
    const placement = { bundle: "team", namespace: "ag-eve-team", service: "ag-eve-team", memberIndex: 0 };
    expect(resolvePlacement("echo", placement, false).namespace).toBe("ag-eve-echo");
  });
});

describe("ADR-150 proof helpers", () => {
  test("cancelOutcome reads the documented cancel vocabulary", async () => {
    const { cancelOutcome } = await import("../src/harness/eve/index.ts");
    const ev = (types: string[]) => types.map((type, i) => ({ type, index: i, data: {} }) as never);
    expect(cancelOutcome(ev(["session.started", "turn.started", "turn.cancelled", "session.waiting"]))).toBe("confirmed");
    expect(cancelOutcome(ev(["session.started", "turn.started", "turn.completed", "session.waiting"]))).toBe("completed-first");
    expect(cancelOutcome(ev(["session.started", "turn.started"]))).toBe("unconfirmed");
    expect(cancelOutcome(ev(["turn.started", "turn.cancelled", "turn.failed"]))).toBe("unconfirmed");
    expect(cancelOutcome(ev(["turn.started", "turn.cancelled"]))).toBe("confirmed");
  });

  test("scheduleWindowSeconds is two intervals for */N, ten minutes otherwise", async () => {
    const { scheduleWindowSeconds } = await import("../src/harness/eve/index.ts");
    expect(scheduleWindowSeconds("*/5 * * * *")).toBe(600);
    expect(scheduleWindowSeconds("*/1 * * * *")).toBe(120);
    expect(scheduleWindowSeconds("0 3 * * *")).toBe(600);
    expect(scheduleWindowSeconds(null)).toBe(600);
  });

  test("declaredSurface reads schedules (md prompt as needle), subagents and apps off the project", async () => {
    const { declaredSurface } = await import("../src/harness/eve/index.ts");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-eve-surface-"));
    fs.mkdirSync(path.join(dir, "agent", "schedules"), { recursive: true });
    fs.mkdirSync(path.join(dir, "agent", "subagents", "shout"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agent", "schedules", "heartbeat.md"), "---\ncron: \"*/5 * * * *\"\n---\n\nheartbeat\n");
    fs.writeFileSync(path.join(dir, "agent", "schedules", "sweep.ts"), "export default defineSchedule({ cron: \"0 0 * * 0\", markdown: \"x\" });\n");
    fs.writeFileSync(path.join(dir, "agent", "subagents", "shout", "agent.ts"), "export default {}\n");
    fs.writeFileSync(path.join(dir, "hermes-gitops.yaml"), "contractVersion: 5\nruntime:\n  kind: eve\napps:\n  - name: docs-site\n    chart: charts/test-page\n    repo: local\n");
    const s = declaredSurface({ name: "echo", dir, subdir: "", runtime: "eve" } as never);
    expect(s.schedules).toEqual([
      { id: "heartbeat", cron: "*/5 * * * *", needle: "heartbeat" },
      { id: "sweep", cron: "0 0 * * 0", needle: "sweep" },
    ]);
    expect(s.subagents).toEqual(["shout"]);
    expect(s.apps).toEqual(["docs-site"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
