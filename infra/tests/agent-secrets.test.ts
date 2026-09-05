// Offline unit tests for the agent-secrets component's pure surface
// (issue #38 [K6]) — no Pulumi runtime.
import { describe, expect, test } from "bun:test";
import {
  parseAgentGitAuth,
  parseAgentSecrets,
  secretsDigest,
} from "../src/components/agent-secrets/index.ts";
import { ConfigError } from "../src/control-flow/config.ts";

describe("parseAgentSecrets", () => {
  test("absent config means no secrets", () => {
    expect(parseAgentSecrets(undefined)).toEqual({});
    expect(parseAgentSecrets(null)).toEqual({});
  });

  test("valid shape passes through", () => {
    expect(
      parseAgentSecrets({ "support-agent": { DISCORD_BOT_TOKEN: "x", OPENAI_API_KEY: "y" } }),
    ).toEqual({ "support-agent": { DISCORD_BOT_TOKEN: "x", OPENAI_API_KEY: "y" } });
  });

  test("non-mapping shapes are rejected", () => {
    expect(() => parseAgentSecrets(["a"])).toThrow(ConfigError);
    expect(() => parseAgentSecrets({ agent: ["x"] })).toThrow(/must be a mapping/);
  });

  test("invalid instance names are rejected (DNS-1123, max 40)", () => {
    expect(() => parseAgentSecrets({ "Bad-Name": { A: "x" } })).toThrow(/instance name/);
    expect(() => parseAgentSecrets({ ["a".repeat(41)]: { A: "x" } })).toThrow(/max 40/);
  });

  test("invalid env var names are rejected (envRequires pattern)", () => {
    expect(() => parseAgentSecrets({ agent: { "lower_case": "x" } })).toThrow(
      /not a valid env var/,
    );
    expect(() => parseAgentSecrets({ agent: { "1STARTS_WITH_DIGIT": "x" } })).toThrow(
      ConfigError,
    );
  });
});

describe("secretsDigest", () => {
  test("is order-insensitive and value-sensitive", () => {
    const a = secretsDigest({ A: "1", B: "2" });
    expect(secretsDigest({ B: "2", A: "1" })).toBe(a);
    expect(secretsDigest({ A: "1", B: "changed" })).not.toBe(a);
  });
});

describe("parseAgentGitAuth (G1)", () => {
  test("https and ssh credential shapes normalize", () => {
    expect(
      parseAgentGitAuth({
        "agent-a": { username: "x-access-token", password: "pat" },
        "agent-b": { sshPrivateKey: "-----BEGIN KEY-----" },
      }),
    ).toEqual({
      "agent-a": { username: "x-access-token", password: "pat" },
      "agent-b": { "ssh-privatekey": "-----BEGIN KEY-----" },
    });
  });

  test("neither shape present is rejected naming both options", () => {
    expect(() => parseAgentGitAuth({ agent: { token: "x" } })).toThrow(
      /username\+password.*sshPrivateKey/,
    );
  });

  test("invalid instance names rejected", () => {
    expect(() => parseAgentGitAuth({ "Bad-Name": { sshPrivateKey: "k" } })).toThrow(
      /instance name/,
    );
  });
});
