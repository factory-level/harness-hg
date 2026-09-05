import { describe, expect, test } from "bun:test";
import { ConfigError, parseControlPlaneIngress, parseSlack } from "../src/control-flow/config.ts";
import {
  buildSlackManifest,
  manifestHasEvents,
  parseProvisionStdout,
  slackProjectDir,
} from "../src/components/slack-workspace/index.ts";

// ---------------------------------------------------------------------------
// parseSlack — the five-move parser idiom: defaults, closed keys, shapes.

describe("parseSlack", () => {
  test("absent block is a complete disabled default", () => {
    const out = parseSlack(undefined);
    expect(out.enabled).toBe(false);
    expect(out.teamId).toBe("");
    expect(out.cliBin).toBe("slack");
    expect(out.apps).toEqual({});
    expect(out.channels).toEqual([]);
  });

  test("unknown keys are refused with the allowed list", () => {
    expect(() => parseSlack({ configToken: "x" })).toThrow(/not a recognized key/);
  });

  test("a full valid block parses", () => {
    const out = parseSlack({
      enabled: true,
      teamId: "T0123456789",
      adminUserToken: "xoxp-test",
      eventsReady: false,
      apps: {
        "marketing-manager-eve": {
          displayName: "Eve Manager",
          description: "Coordinates the operation.",
          botScopes: ["app_mentions:read", "chat:write"],
          botEvents: ["app_mention"],
        },
      },
      channels: [
        {
          name: "social",
          agents: ["marketing-manager-eve"],
          users: ["U0123456789"],
        },
      ],
    });
    expect(out.enabled).toBe(true);
    expect(out.apps["marketing-manager-eve"]!.eventsUrl).toBe("");
    expect(out.channels[0]!.isPrivate).toBe(false);
  });

  test("a malformed team id names the two-workspace trap", () => {
    expect(() => parseSlack({ teamId: "inferlab-group" })).toThrow(/different workspace/);
  });

  test("an app with no scopes is refused", () => {
    expect(() =>
      parseSlack({ apps: { a: { displayName: "A", botScopes: [] } } }),
    ).toThrow(/at least one bot scope/);
  });

  test("channel users must be Slack ids, not emails", () => {
    expect(() =>
      parseSlack({
        apps: { a: { displayName: "A", botScopes: ["chat:write"] } },
        channels: [{ name: "c", agents: [], users: ["calvin@example.com"] }],
      }),
    ).toThrow(/not a Slack user id/);
  });

  test("a channel naming an undeclared app is refused", () => {
    expect(() =>
      parseSlack({ channels: [{ name: "c", agents: ["ghost"], users: [] }] }),
    ).toThrow(/declares no app for it/);
  });

  test("duplicate channels are refused", () => {
    expect(() =>
      parseSlack({ channels: [{ name: "c" }, { name: "c" }] }),
    ).toThrow(/declares c twice/);
  });

  test("appId must look like a Slack app id", () => {
    expect(() =>
      parseSlack({ apps: { a: { displayName: "A", botScopes: ["chat:write"], appId: "nope" } } }),
    ).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// buildSlackManifest — pure; the JSON is also the Command trigger.

const APP = {
  displayName: "Eve Manager",
  description: "Coordinates the operation.",
  botScopes: ["chat:write", "app_mentions:read"],
  botEvents: ["message.im", "app_mention"],
  eventsUrl: "https://slack-manager.example.dev/eve/v1/slack",
  appId: "",
};

function slackCfg(overrides: object = {}) {
  return {
    ...parseSlack({ teamId: "T0123456789" }),
    ...overrides,
  };
}

describe("buildSlackManifest", () => {
  test("events are withheld until eventsReady - Slack challenges the URL at apply", () => {
    const manifest = buildSlackManifest(slackCfg(), APP) as Record<string, any>;
    expect(manifest.settings.event_subscriptions).toBeUndefined();
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });

  test("eventsReady renders request_url + sorted events", () => {
    const manifest = buildSlackManifest(slackCfg({ eventsReady: true }), APP) as Record<string, any>;
    expect(manifest.settings.event_subscriptions).toEqual({
      request_url: "https://slack-manager.example.dev/eve/v1/slack",
      bot_events: ["app_mention", "message.im"],
    });
  });

  test("scopes are sorted and the bot handle is the kebab display name", () => {
    const manifest = buildSlackManifest(slackCfg(), APP) as Record<string, any>;
    expect(manifest.oauth_config.scopes.bot).toEqual(["app_mentions:read", "chat:write"]);
    expect(manifest.features.bot_user.display_name).toBe("eve-manager");
  });

  test("is deterministic - the trigger contract", () => {
    expect(JSON.stringify(buildSlackManifest(slackCfg(), APP))).toBe(
      JSON.stringify(buildSlackManifest(slackCfg(), APP)),
    );
  });
});

describe("slackProjectDir", () => {
  test("keys on the agent under the hg home", () => {
    expect(slackProjectDir("marketing-manager-eve", "/mnt/ssd/hermes-gitops")).toBe(
      "/mnt/ssd/hermes-gitops/slack-apps/marketing-manager-eve",
    );
  });
});

// ---------------------------------------------------------------------------
// parseProvisionStdout — the provision Command's stdout contract (ADR
// 0175): {app_id, signing_secret, bot_token}, all three or a loud refusal
// that names KEYS, never values.

describe("parseProvisionStdout", () => {
  const FULL = JSON.stringify({
    app_id: "A0NEWAPP001",
    signing_secret: "sign-sec",
    bot_token: "xoxb-tok",
    superseded_app_id: "",
  });

  test("parses the three credentials", () => {
    expect(parseProvisionStdout("m", FULL)).toEqual({
      app_id: "A0NEWAPP001",
      signing_secret: "sign-sec",
      bot_token: "xoxb-tok",
    });
  });

  test("missing keys are refused BY NAME - values never enter the message", () => {
    const partial = JSON.stringify({ app_id: "A0NEWAPP001", bot_token: "xoxb-SECRET" });
    let message = "";
    try {
      parseProvisionStdout("m", partial);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("signing_secret");
    expect(message).not.toContain("xoxb-SECRET");
  });

  test("non-JSON stdout throws rather than returning junk", () => {
    expect(() => parseProvisionStdout("m", "not json")).toThrow();
  });
});

describe("manifestHasEvents", () => {
  test("requires eventsReady AND events AND a url - the wireEvents gate", () => {
    expect(manifestHasEvents(slackCfg({ eventsReady: true }), APP)).toBe(true);
    expect(manifestHasEvents(slackCfg(), APP)).toBe(false);
    expect(
      manifestHasEvents(slackCfg({ eventsReady: true }), { ...APP, botEvents: [] }),
    ).toBe(false);
    expect(
      manifestHasEvents(slackCfg({ eventsReady: true }), { ...APP, eventsUrl: "" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookEndpoints — no-Access hostnames published for provider webhooks.

describe("controlPlaneIngress.webhookEndpoints", () => {
  const base = {
    provider: "cloudflare",
    accountId: "acc",
    zoneId: "zone",
    zoneName: "example.dev",
    teamName: "team",
    access: { emailDomain: "example.dev" },
  };

  test("a webhook endpoint parses without an Access group", () => {
    const out = parseControlPlaneIngress({
      ...base,
      webhookEndpoints: {
        "slack-manager": {
          hostname: "slack-manager.example.dev",
          origin: "http://ag-eve-marketing-manager-eve.ag-eve-marketing-manager-eve.svc.cluster.local:3000",
        },
      },
    });
    expect(out.webhookEndpoints["slack-manager"]!.hostname).toBe(
      "slack-manager.example.dev",
    );
  });

  test("a webhook hostname outside the zone is refused", () => {
    expect(() =>
      parseControlPlaneIngress({
        ...base,
        webhookEndpoints: { w: { hostname: "slack.example.com", origin: "http://x:3000" } },
      }),
    ).toThrow(/outside the configured zone/);
  });

  test("an unknown key on a webhook endpoint is refused", () => {
    expect(() =>
      parseControlPlaneIngress({
        ...base,
        webhookEndpoints: {
          w: { hostname: "w.example.dev", origin: "http://x:3000", groups: ["admins"] },
        },
      }),
    ).toThrow(/not a recognized key/);
  });

  test("absent webhookEndpoints defaults to empty", () => {
    expect(parseControlPlaneIngress({ ...base }).webhookEndpoints).toEqual({});
  });
});
