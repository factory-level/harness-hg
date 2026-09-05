// hg slack prove — offline: every dep injected, every leg's three
// verdicts (pass / fail / unknown-never-pass) exercised.

import { describe, expect, test } from "bun:test";
import { proveSlack, slackSpecOf, type SlackProveDeps, type SlackSpecView } from "../src/slack/prove.ts";
import { CliError } from "../src/lib.ts";

function spec(partial: Partial<SlackSpecView> = {}): SlackSpecView {
  return {
    teamId: "T0000000000",
    cliBin: "slack",
    eventsReady: true,
    apps: {
      "manager-eve": {
        appId: "",
        botEvents: ["app_mention"],
        eventsUrl: "https://slack-manager.example.dev/eve/v1/slack",
      },
    },
    channels: [{ name: "social", channelId: "C000000", agents: ["manager-eve"] }],
    ...partial,
  };
}

function deps(partial: Partial<SlackProveDeps> = {}): SlackProveDeps {
  const authTest = JSON.stringify({ ok: true, team_id: "T0000000000", user_id: "U0BOT" });
  const members = JSON.stringify({ ok: true, members: ["U0BOT", "U0HUMAN"] });
  return {
    spec: spec(),
    runSlack: (args) => ({
      code: 0,
      stdout: args.includes("auth.test") ? authTest : members,
    }),
    secretKeys: () => ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "ANTHROPIC_API_KEY"],
    postStatus: async () => 401,
    appIdOf: () => "A0PROVISIONED",
    projectDirOf: (a) => `/tmp/${a}`,
    ...partial,
  };
}

const byId = (r: Awaited<ReturnType<typeof proveSlack>>, id: string) =>
  r.findings.find((f) => f.id === id)!;

describe("proveSlack", () => {
  test("all four legs pass on a healthy surface", async () => {
    const r = await proveSlack(deps());
    expect(r.ok).toBe(true);
    for (const id of ["SLK001", "SLK002", "SLK003", "SLK004"]) {
      expect(byId(r, id).status).toBe("pass");
    }
  });

  test("SLK001: a missing Secret key fails by agent+key name", async () => {
    const r = await proveSlack(deps({ secretKeys: () => ["SLACK_BOT_TOKEN"] }));
    const f = byId(r, "SLK001");
    expect(f.status).toBe("fail");
    expect(f.message).toContain("manager-eve: SLACK_SIGNING_SECRET");
  });

  test("SLK001: an unreachable cluster is unknown, never a pass", async () => {
    const r = await proveSlack(deps({ secretKeys: () => null }));
    expect(byId(r, "SLK001").status).toBe("unknown");
  });

  test("SLK002: a foreign-team answer fails loudly", async () => {
    const r = await proveSlack(
      deps({
        runSlack: () => ({
          code: 0,
          stdout: JSON.stringify({ ok: true, team_id: "T0WRONG", user_id: "U0BOT" }),
        }),
      }),
    );
    expect(byId(r, "SLK002").status).toBe("fail");
    expect(byId(r, "SLK002").message).toContain("T0WRONG");
  });

  test("SLK002: no app id anywhere is unknown naming the cause", async () => {
    const r = await proveSlack(deps({ appIdOf: () => "" }));
    expect(byId(r, "SLK002").status).toBe("unknown");
    expect(byId(r, "SLK002").message).toContain("not provisioned");
  });

  test("SLK003: an absent bot fails naming the channel", async () => {
    const r = await proveSlack(
      deps({
        runSlack: (args) => ({
          code: 0,
          stdout: args.includes("auth.test")
            ? JSON.stringify({ ok: true, team_id: "T0000000000", user_id: "U0BOT" })
            : JSON.stringify({ ok: true, members: ["U0HUMAN"] }),
        }),
      }),
    );
    expect(byId(r, "SLK003").status).toBe("fail");
    expect(byId(r, "SLK003").message).toContain("#social");
  });

  test("SLK004: a 200 on an unsigned POST is a FAILURE (forgeries accepted)", async () => {
    const r = await proveSlack(deps({ postStatus: async () => 200 }));
    expect(byId(r, "SLK004").status).toBe("fail");
    expect(byId(r, "SLK004").message).toContain("expected 401");
  });

  test("SLK004: no events configured is unknown", async () => {
    const r = await proveSlack(deps({ spec: spec({ eventsReady: false }) }));
    expect(byId(r, "SLK004").status).toBe("unknown");
  });

  test("--agent restricts the matrix and an unknown agent refuses", async () => {
    const r = await proveSlack(deps({ agent: "manager-eve" }));
    expect(r.ok).toBe(true);
    await expect(proveSlack(deps({ agent: "nobody" }))).rejects.toThrow(CliError);
  });
});

describe("slackSpecOf", () => {
  test("shapes the spec's slack block and refuses a disabled one", () => {
    const view = slackSpecOf({
      apiVersion: "x",
      name: "e",
      project: "p",
      rootKms: { location: "l", keyring: "k", key: "k" },
      state: { deployerGroup: "g", agents: [] },
      infra: {
        slack: {
          enabled: true,
          teamId: "T0000000000",
          apps: { a: { botEvents: ["app_mention"], eventsUrl: "https://x/eve/v1/slack" } },
          channels: [{ name: "social", channelId: "C1", agents: ["a"] }],
        },
      },
    });
    expect(view.apps["a"]!.appId).toBe("");
    expect(view.channels[0]!.channelId).toBe("C1");
    expect(() =>
      slackSpecOf({
        apiVersion: "x", name: "e", project: "p",
        rootKms: { location: "l", keyring: "k", key: "k" },
        state: { deployerGroup: "g", agents: [] },
        infra: {},
      }),
    ).toThrow(/no enabled slack block/);
  });
});
