// `hg agent prove` — the harness-neutral matrix (ADR 0177). Pure tests
// with injected deps: no cluster, no pods, no port-forwards.
import { describe, expect, test } from "bun:test";
import { proveAgentRuntime, proveHermes } from "../src/agent/prove.ts";
import type { ProfileCtx } from "../src/lib.ts";

const hermesCtx = { name: "persona-echo", runtime: "hermes" } as ProfileCtx;
const okShow = async () => ({ profile: "persona-echo", ok: true, cronDeclarations: [], cron: [] });
const okSmoke = async () => true;

describe("proveHermes (HRM001..002)", () => {
  test("a healthy Hermes profile passes both legs", async () => {
    const proof = await proveHermes([hermesCtx], { show: okShow as never, smoke: okSmoke as never });
    expect(proof.ok).toBe(true);
    expect(proof.findings.map((f) => f.id)).toEqual(["HRM001", "HRM002"]);
    expect(proof.summary).toEqual({ pass: 2, fail: 0, unknown: 0 });
    expect(proof.command).toBe("hg agent prove");
  });

  test("a declaration file name matches its activated job by stem", async () => {
    const show = async () => ({
      profile: "persona-echo",
      ok: true,
      cronDeclarations: ["status-checkin.yaml", "nightly.yml"],
      cron: [{ name: "status-checkin" }, { name: "nightly" }],
    });
    const proof = await proveHermes([hermesCtx], { show: show as never, smoke: okSmoke as never });
    expect(proof.findings.find((f) => f.id === "HRM001")?.status).toBe("pass");
  });

  test("declared-but-unactivated cron fails HRM001", async () => {
    const show = async () => ({
      profile: "persona-echo",
      ok: true,
      cronDeclarations: ["heartbeat"],
      cron: [],
    });
    const proof = await proveHermes([hermesCtx], { show: show as never, smoke: okSmoke as never });
    expect(proof.ok).toBe(false);
    expect(proof.findings.find((f) => f.id === "HRM001")?.status).toBe("fail");
    expect(proof.findings.find((f) => f.id === "HRM001")?.message).toContain("heartbeat");
  });

  test("a failing smoke tier fails HRM002; an unreachable pod is unknown, never a pass", async () => {
    const show = async () => ({ profile: "persona-echo", ok: false, error: "pod gone" });
    const smoke = async () => false;
    const proof = await proveHermes([hermesCtx], { show: show as never, smoke: smoke as never });
    expect(proof.findings.find((f) => f.id === "HRM001")?.status).toBe("unknown");
    expect(proof.findings.find((f) => f.id === "HRM002")?.status).toBe("fail");
    expect(proof.ok).toBe(false);
  });
});

describe("proveAgentRuntime (the merged, per-harness dispatch)", () => {
  test("a Hermes-only fleet yields findings — the launch-gate hole ADR 0177 closes", async () => {
    const proof = await proveAgentRuntime([hermesCtx], {
      hermesDeps: { show: okShow as never, smoke: okSmoke as never },
    });
    expect(proof.findings.length).toBe(2);
    expect(proof.ok).toBe(true);
  });

  test("an empty selection is an empty (ok) result, not an error", async () => {
    const proof = await proveAgentRuntime([]);
    expect(proof.findings).toEqual([]);
    expect(proof.ok).toBe(true);
  });
});
