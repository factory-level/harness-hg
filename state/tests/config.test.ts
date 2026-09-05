// Offline unit tests for the state/ stack's pure config surface - no
// Pulumi runtime, no GCP.
import { describe, expect, test } from "bun:test";
import {
  AGENT_NAME_MAX,
  BACKUP_ENV_NAME_MAX,
  ConfigError,
  backupBucketNameFor,
  backupWriterIdFor,
  bucketNameFor,
  deployerIdFor,
  deployerPrincipal,
  parseStateStackConfig,
  restoreReaderIdFor,
  validateAgentName,
} from "../src/config.ts";

const PROJECT = "factorylevel-prod";
const VALID = {
  rootKmsKeyId: "projects/factorylevel-prod/locations/us/keyRings/pulumi/cryptoKeys/pulumi-root",
  deployerGroup: "deployers@example.dev",
  agents: ["research-agent", "ops-agent"],
  bucketLocation: undefined,
  perAgentKeys: undefined,
};

describe("parseStateStackConfig (spec §23)", () => {
  test("valid config parses with defaults", () => {
    const c = parseStateStackConfig(VALID, PROJECT);
    expect(c.agents).toEqual(["research-agent", "ops-agent"]);
    expect(c.bucketLocation).toBe("US");
    expect(c.perAgentKeys).toBe(false);
  });

  test("rootKmsKeyId must be the full resource id (manual-root pointer)", () => {
    expect(() =>
      parseStateStackConfig({ ...VALID, rootKmsKeyId: "pulumi-root" }, PROJECT),
    ).toThrow(/full resource id of the MANUALLY created root key/);
  });

  test("deployerGroup must be a group email", () => {
    expect(() =>
      parseStateStackConfig({ ...VALID, deployerGroup: "deployers" }, PROJECT),
    ).toThrow(/group email/);
  });

  test("agents must be a non-empty string list, unique", () => {
    expect(() => parseStateStackConfig({ ...VALID, agents: [] }, PROJECT)).toThrow(
      /non-empty list/,
    );
    expect(() =>
      parseStateStackConfig({ ...VALID, agents: ["a-agent", "a-agent"] }, PROJECT),
    ).toThrow(/listed twice/);
  });

  test("agent names fit GCP service-account and bucket limits", () => {
    expect(() => validateAgentName("Research-Agent", PROJECT)).toThrow(ConfigError);
    expect(() => validateAgentName("-agent", PROJECT)).toThrow(/starting with a letter/);
    const tooLong = "a".repeat(AGENT_NAME_MAX + 1);
    expect(() => validateAgentName(tooLong, PROJECT)).toThrow(/service-account id/);
    // bucket limit binds when the project name is long
    const longProject = "p".repeat(60);
    expect(() => validateAgentName("agent", longProject)).toThrow(/GCS max/);
  });

  test("name derivations are the documented conventions", () => {
    expect(bucketNameFor(PROJECT, "research-agent")).toBe(
      "factorylevel-prod-research-agent-state",
    );
    expect(deployerIdFor("research-agent")).toBe("research-agent-deployer");
  });

  test("perAgentKeys flips strict isolation on", () => {
    expect(parseStateStackConfig({ ...VALID, perAgentKeys: true }, PROJECT).perAgentKeys).toBe(
      true,
    );
  });
});

describe("backupEnvironments (ADR-49/#297)", () => {
  test("absent means none - the block is opt-in", () => {
    expect(parseStateStackConfig(VALID, PROJECT).backupEnvironments).toEqual([]);
  });

  test("a valid environment yields the bucket and both identities", () => {
    const c = parseStateStackConfig({ ...VALID, backupEnvironments: ["factory"] }, PROJECT);
    expect(c.backupEnvironments).toEqual(["factory"]);
    expect(backupBucketNameFor(PROJECT, "factory")).toBe("factorylevel-prod-factory-backup");
    expect(backupWriterIdFor("factory")).toBe("factory-backup-writer");
    expect(restoreReaderIdFor("factory")).toBe("factory-restore-reader");
  });

  test("a name too long for the writer SA id is refused at preview", () => {
    const long = "x".repeat(BACKUP_ENV_NAME_MAX + 1);
    expect(() => parseStateStackConfig({ ...VALID, backupEnvironments: [long] }, PROJECT)).toThrow(ConfigError);
  });

  test("duplicates are refused", () => {
    expect(() =>
      parseStateStackConfig({ ...VALID, backupEnvironments: ["factory", "factory"] }, PROJECT),
    ).toThrow(/listed twice/);
  });
});

describe("deployerPrincipal", () => {
  test("a bare email is a group; explicit prefixes pass through", () => {
    expect(deployerPrincipal("deployers@example.dev")).toBe("group:deployers@example.dev");
    expect(deployerPrincipal("user:admin@example.dev")).toBe("user:admin@example.dev");
  });

  test("an unknown prefix is refused at parse", () => {
    expect(() => parseStateStackConfig({ ...VALID, deployerGroup: "role:whatever@x.dev" }, PROJECT)).toThrow(ConfigError);
  });

  test("user-prefixed principals parse", () => {
    const c = parseStateStackConfig({ ...VALID, deployerGroup: "user:admin@example.dev" }, PROJECT);
    expect(c.deployerGroup).toBe("user:admin@example.dev");
  });
});
