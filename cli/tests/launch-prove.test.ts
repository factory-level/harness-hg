// The launch gate's own contract (#285). It adds no subject checks - it
// asserts the INSTALLATION is in its launch configuration, which is the
// part no per-subject matrix owns.

import { describe, expect, test } from "bun:test";
import { LAUNCH_FLAGS_OFF, LAUNCH_FLAGS_ON, LAUNCH_NAV, LAUNCH_SECRET_PATTERNS } from "../src/launch/prove.ts";

describe("the launch configuration", () => {
  test("the navigation is exactly four views, in order", () => {
    // A fifth tab appearing is a product change nobody decided.
    expect([...LAUNCH_NAV]).toEqual(["Fleet Canvas", "Communication", "Agents", "Backups"]);
  });

  test("every launch view has a flag that must be on", () => {
    for (const f of ["communication-view", "agents-view", "backups-view"]) {
      expect(LAUNCH_FLAGS_ON).toContain(f);
    }
  });

  test("embed-debug must be OFF", () => {
    // It framed Grafana to answer "could we embed at all". Catalogued
    // panels answer that now, and a diagnostic beside four product views
    // reads as a fifth product view.
    expect(LAUNCH_FLAGS_OFF).toContain("embed-debug");
  });

  test("no flag is required both on and off", () => {
    for (const f of LAUNCH_FLAGS_ON) expect(LAUNCH_FLAGS_OFF).not.toContain(f);
  });
});

describe("an environment without Nexus (ADR-149: Eve-only, no Hermes image)", () => {
  test("every Nexus-backed leg reads unknown, subjects still aggregate, nothing fails", async () => {
    const { proveLaunch } = await import("../src/launch/prove.ts");
    const agent = {
      apiVersion: "cli.hermes.dev/v1alpha1" as const,
      kind: "ProofResult" as const,
      command: "hg agent prove",
      startedAt: "",
      finishedAt: "",
      ok: true,
      findings: [{ id: "EVE001", status: "pass" as const, component: "echo", message: "200" }],
      summary: { pass: 1, fail: 0, unknown: 0 },
    };
    const proof = await proveLaunch({} as never, {
      nexusBaseUrl: "http://127.0.0.1:0/api/plugins/hermes-gitops",
      fetchJson: async () => {
        throw new Error("must not be called without Nexus");
      },
      subjects: { auth: null, agent },
      nexusAvailable: false,
    });
    expect(proof.ok).toBe(true);
    expect(proof.summary.fail).toBe(0);
    expect(proof.findings.find((f) => f.id === "LAUNCH001" && f.component === "agent")?.status).toBe("pass");
    expect(proof.findings.find((f) => f.id === "LAUNCH001" && f.component === "auth")?.status).toBe("unknown");
    for (const id of ["LAUNCH002", "LAUNCH003", "LAUNCH004", "LAUNCH005", "LAUNCH006"]) {
      expect(proof.findings.find((f) => f.id === id)?.status).toBe("unknown");
    }
  });
});

describe("the secret sweep", () => {
  const fires = (s: string) => LAUNCH_SECRET_PATTERNS.some((p) => p.re.test(s));

  test("it catches the shapes this system actually mints", () => {
    expect(fires('{"token":"hgev_aaaaaaaaaaaaaaaaaaaaaaaa"}')).toBe(true);
    expect(fires("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(fires("$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123")).toBe(true);
    expect(fires("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJlc2ln")).toBe(true);
    expect(fires("https://user:swordfish@grafana.example")).toBe(true);
  });

  test("it does NOT fire on ordinary payload prose", () => {
    // A pattern that fires on normal output gets silenced, and a
    // silenced sweep is worse than none.
    for (const ok of [
      '{"summary":"4 routine(s) current, restore verified"}',
      '{"url":"https://grafana.example/d/hg-control-plane-overview?viewPanel=7"}',
      '{"checksum":"9f3a1c7e2b45"}',
      '{"reason":"no backup routine covers this agent\'s data volume"}',
      '{"id":"marketing-sre@ca-west","namespace":"hermes-marketing-sre"}',
    ]) {
      expect(fires(ok)).toBe(false);
    }
  });

  test("every pattern is named for a human", () => {
    for (const p of LAUNCH_SECRET_PATTERNS) expect(p.name.length).toBeGreaterThan(5);
  });
});
