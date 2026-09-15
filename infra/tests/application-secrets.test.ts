import { describe, expect, test } from "bun:test";
import { parseApplicationSecrets, applicationSecretName, applicationSecretResourceName } from "../src/components/agent-secrets/index.ts";
import { validateEveSecretOwnership, parseApplicationGitAuth, type BootstrapConfig } from "../src/control-flow/config.ts";

describe("application credential isolation", () => {
  test("application identity is separate from agent env and git auth", () => {
    expect(parseApplicationSecrets({ coordinator: { crm: { DB_PASSWORD: "synthetic" } } }).coordinator!.crm!.DB_PASSWORD).toBe("synthetic");
    expect(applicationSecretName("ag-eve-coordinator", "crm")).toBe("ag-eve-coordinator-app-crm-env");
  });
  test("Pulumi identities cannot collide with agent Secrets or another owner/app split", () => {
    expect(applicationSecretResourceName("ag-eve-foo", "bar")).not.toBe("ag-eve-foo-app-bar-env");
    expect(applicationSecretResourceName("ag-eve-foo", "bar-app-baz")).not.toBe(applicationSecretResourceName("ag-eve-foo-app-bar", "baz"));
  });
  test("invalid shapes and credential types fail without echoing values", () => {
    for (const value of [[], "secret", { owner: [] }, { owner: { crm: {} } }, { owner: { crm: { password: "sensitive" } } }, { owner: { crm: { DB_PASSWORD: 123 } } }, { owner: { crm: { DB_PASSWORD: "" } } }, { "Bad/Owner": {} }, JSON.parse('{"__proto__":{}}')]) {
      expect(() => parseApplicationSecrets(value)).toThrow();
      try { parseApplicationSecrets(value); } catch (error) { expect(String(error)).not.toContain("sensitive"); }
    }
    expect(parseApplicationSecrets(undefined)).toEqual({});
  });
  test("unregistered owner is refused even without Eve agents", () => {
    expect(() => validateEveSecretOwnership({ agents: [], agentSecrets: {}, agentGitAuth: {}, applicationSecrets: { unknown: { crm: { PASSWORD: "synthetic" } } } } as unknown as BootstrapConfig)).toThrow("matches no registered");
  });
});

test("private chart credentials require an exact HTTPS repository without leaking values", () => {
  expect(parseApplicationGitAuth({ owner: { repository: "https://github.com/example/team", username: "git", password: "synthetic" } }).owner?.repository).toBe("https://github.com/example/team");
  expect(() => parseApplicationGitAuth({ owner: { repository: "https://token@github.com/example/team", username: "git", password: "sensitive" } })).toThrow("Invalid applicationGitAuth");
});
