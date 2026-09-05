// The environment compiler (#674): the spec round-trips, the quoting
// rules hold (#358 stays unreachable), ciphertext survives
// regeneration byte-for-byte, and drift is a finding.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { generateStack } from "../src/env/generate.ts";
import { importEnvironment } from "../src/env/import.ts";
import {
  envDeployerEmail,
  envStateBucketUri,
  loadEnvironmentSpec,
  rootKmsResourceId,
  rootSecretsProviderUri,
} from "../src/env/spec.ts";

const SPEC_YAML = `
apiVersion: hermes-gitops.factorylevel.dev/environment/v1alpha1
name: scratch
project: example-proj
rootKms: {location: us, keyring: pulumi, key: pulumi-root}
state:
  deployerGroup: deployers@example.dev
  agents: [scratch]
infra:
  gitopsRepoUrl: https://github.com/example/scratch.gitops.git
  gitopsBranchProtection: true
  gitopsRequiredReviewers: 0
  providers: {compute: pod, secret: k8s, ingress: none}
  stages: {hermes: false, agents: false, cluster: true}
  versions: {argocdChart: "7.7.11"}
  gitopsGitToken: {secret: true}
  agentSecrets:
    scratch:
      DISCORD_HOME_CHANNEL: "1534804917468795002"
      PLAIN_WORD: hello
  controlPlaneIngress:
    access:
      groups:
        "workload:scratch/app": [admins]
`;

function writeSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), "hg-env-"));
  const file = join(dir, "scratch.yaml");
  writeFileSync(file, SPEC_YAML);
  return file;
}

describe("environment spec", () => {
  test("URIs are assembled, never typed", () => {
    const spec = loadEnvironmentSpec(writeSpec());
    expect(rootSecretsProviderUri(spec)).toBe(
      "gcpkms://projects/example-proj/locations/us/keyRings/pulumi/cryptoKeys/pulumi-root",
    );
    expect(rootKmsResourceId(spec)).toContain("cryptoKeys/pulumi-root");
    expect(envStateBucketUri(spec, "scratch")).toBe("gs://example-proj-scratch-state");
    expect(envDeployerEmail(spec, "scratch")).toBe("scratch-deployer@example-proj.iam.gserviceaccount.com");
  });

  test("v1alpha2 dispatches on apiVersion and accepts grants; v1alpha1 stays valid (ADR 0178)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-env-v2-"));
    const file = join(dir, "prod.yaml");
    writeFileSync(
      file,
      SPEC_YAML.replace("environment/v1alpha1", "environment/v1alpha2") +
        `grants:
  targets:
    ca-west: [{name: ca-west-a, argoDestination: ca-west-a, primary: true}]
  policy: {allowedJurisdictions: [CA]}
  workspaces:
    repositories:
      - name: vision
        source: {url: https://example.com/v.git, revision: {mode: pinned, sha: ${"a".repeat(40)}}}
        mount: {path: /workspaces/vision, access: read-only}
    bindings:
      - {repository: vision, profiles: [scratch], purpose: strategy-context}
`,
    );
    const spec = loadEnvironmentSpec(file) as unknown as { grants?: { targets: Record<string, unknown[]> } };
    expect(spec.grants?.targets["ca-west"]).toHaveLength(1);
    // v1alpha1 has no grants block: the same document under the old apiVersion is refused.
    writeFileSync(file, SPEC_YAML + "grants: {targets: {}}\n");
    expect(() => loadEnvironmentSpec(file)).toThrow(/environment\/v1alpha1/);
    // an unknown version is refused by name, never validated against a guess
    writeFileSync(file, SPEC_YAML.replace("environment/v1alpha1", "environment/v9"));
    expect(() => loadEnvironmentSpec(file)).toThrow(/not one the CLI reads/);
  });

  test("a spec violating the schema reports every failure with its path", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-env-bad-"));
    const file = join(dir, "bad.yaml");
    writeFileSync(file, SPEC_YAML.replace('PLAIN_WORD: hello', "PLAIN_WORD: 42"));
    expect(() => loadEnvironmentSpec(file)).toThrow(/agentSecrets/);
  });
});

describe("the generator", () => {
  const gen = (existing = "") => {
    const dir = mkdtempSync(join(tmpdir(), "hg-env-gen-"));
    const existingFile = join(dir, "Pulumi.scratch.yaml");
    if (existing) writeFileSync(existingFile, existing);
    const spec = loadEnvironmentSpec(writeSpec());
    return generateStack(spec, "infra", { project: "hermes-gitops-bootstrap", existingFile, stackDir: dir });
  };

  test("agentSecrets values emit QUOTED, always - the #358 rule as law", () => {
    const { text } = gen();
    expect(text).toContain('DISCORD_HOME_CHANNEL: "1534804917468795002"');
    expect(text).toContain('PLAIN_WORD: "hello"');
    expect(text).toContain('argocdChart: "7.7.11"');
    // ...and booleans/ints outside the forced zone emit bare.
    expect(text).toContain("gitopsBranchProtection: true");
    expect(text).toContain("gitopsRequiredReviewers: 0");
    // A YAML reload must give back STRINGS where strings were declared.
    const doc = parseYaml(text) as { config: Record<string, unknown> };
    const secrets = (doc.config["hermes-gitops-bootstrap:agentSecrets"] as Record<string, Record<string, unknown>>)["scratch"]!;
    expect(secrets["DISCORD_HOME_CHANNEL"]).toBe("1534804917468795002");
  });

  test("composite keys quote; top-level project-prefixed keys stay bare", () => {
    const { text } = gen();
    expect(text).toContain('"workload:scratch/app":');
    expect(text).toContain("hermes-gitops-bootstrap:agentSecrets:");
    expect(text).not.toContain('"hermes-gitops-bootstrap:agentSecrets"');
  });

  test("existing ciphertext survives regeneration byte-for-byte; missing ciphertext is a finding naming the fix", () => {
    const blob = "v1:abc123:CIPHERTEXTCIPHERTEXT=";
    const existing = [
      "config:",
      "  hermes-gitops-bootstrap:gitopsGitToken:",
      `    secure: ${blob}`,
      "",
    ].join("\n");
    const withDonor = gen(existing);
    expect(withDonor.text).toContain(`secure: ${blob}`);
    expect(withDonor.missingSecrets).toHaveLength(0);

    const cold = gen();
    expect(cold.missingSecrets).toHaveLength(1);
    expect(cold.missingSecrets[0]!.path).toBe("gitopsGitToken");
    expect(cold.missingSecrets[0]!.fix).toContain("pulumi -s scratch config set --secret --path 'gitopsGitToken'");
  });

  test("generation is deterministic", () => {
    expect(gen().text).toBe(gen().text);
  });
});

describe("import round-trip", () => {
  test("hand config -> spec -> generated config is value-identical, ciphertext included", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-env-rt-"));
    const stateFile = join(dir, "Pulumi.rt.yaml");
    const infraFile = join(dir, "Pulumi.rt-infra.yaml");
    writeFileSync(stateFile, [
      "secretsprovider: gcpkms://projects/example-proj/locations/us/keyRings/pulumi/cryptoKeys/pulumi-root",
      "encryptedkey: AAAA",
      "config:",
      "  gcp:project: example-proj",
      "  hermes-gitops-state:rootKmsKeyId: projects/example-proj/locations/us/keyRings/pulumi/cryptoKeys/pulumi-root",
      "  hermes-gitops-state:deployerGroup: user:root@example.dev",
      "  hermes-gitops-state:agents:",
      "    - rt",
      "",
    ].join("\n"));
    writeFileSync(infraFile, [
      "secretsprovider: gcpkms://projects/example-proj/locations/us/keyRings/pulumi/cryptoKeys/pulumi-root",
      "config:",
      "  hermes-gitops-bootstrap:gitopsRepoUrl: https://github.com/example/rt.git",
      "  hermes-gitops-bootstrap:providers:",
      "    compute: pod",
      "    secret: k8s",
      "    ingress: none",
      "  hermes-gitops-bootstrap:gitopsGitToken:",
      "    secure: v1:rt:BLOB=",
      "  hermes-gitops-bootstrap:agentSecrets:",
      "    rt:",
      '      SNOWFLAKE: "9007199254740993"',
      "",
    ].join("\n"));

    const specText = importEnvironment({ name: "rt", stateFile, infraFile });
    const specFile = join(dir, "rt.yaml");
    writeFileSync(specFile, specText);
    const spec = loadEnvironmentSpec(specFile);

    const state = generateStack(spec, "state", { project: "hermes-gitops-state", existingFile: stateFile, stackDir: dir });
    const infra = generateStack(spec, "infra", { project: "hermes-gitops-bootstrap", existingFile: infraFile, stackDir: dir });
    expect(state.missingSecrets).toHaveLength(0);
    expect(infra.missingSecrets).toHaveLength(0);

    for (const [orig, gen] of [
      [stateFile, state.text],
      [infraFile, infra.text],
    ] as const) {
      const before = parseYaml(require("node:fs").readFileSync(orig, "utf8"));
      const after = parseYaml(gen);
      expect(after.config).toEqual(before.config);
      expect(after.secretsprovider).toBe(before.secretsprovider);
    }
    // The snowflake survived as a string through the whole loop.
    const after = parseYaml(infra.text) as { config: Record<string, unknown> };
    const rt = (after.config["hermes-gitops-bootstrap:agentSecrets"] as Record<string, Record<string, unknown>>)["rt"]!;
    expect(rt["SNOWFLAKE"]).toBe("9007199254740993");
  });
});

describe("env new (#676)", () => {
  test("the dry-run transcript is the whole sequence, hand-executable", async () => {
    // Capture console output around a dry run against the shipped
    // minimal example spec. Preflight probes may report fail (no cloud
    // in tests) - dry-run must still print every step.
    const { cmdEnvNew } = await import("../src/env/new.ts");
    const spec = join(import.meta.dir, "..", "schemas", "environment", "v1alpha1", "examples", "valid-minimal.yaml");
    const seen: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { seen.push(a.join(" ")); };
    try {
      cmdEnvNew(false, "scratch", { spec, dryRun: true });
    } finally {
      console.log = orig;
    }
    const text = seen.join("\n");
    expect(text).toContain("pulumi stack init scratch --secrets-provider gcpkms://projects/example-project/locations/us/keyRings/pulumi/cryptoKeys/pulumi-root");
    expect(text).toContain("PULUMI_BACKEND_URL=gs://example-project-pulumi-root-state");
    expect(text).toContain("PULUMI_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=scratch-deployer@example-project.iam.gserviceaccount.com");
    expect(text).toContain("pulumi up --yes -s scratch");
    expect(text.split("\n").filter((l) => /^\s+\d+\. /.test(l)).length).toBe(6);
  });
});

describe("empty collections (#676 scratch run)", () => {
  test("an empty agents list emits [], never a bare YAML-null key", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-env-empty-"));
    const file = join(dir, "e.yaml");
    writeFileSync(file, SPEC_YAML.replace("infra:", "infra:\n  agents: []\n  hermes: {}"));
    const spec = loadEnvironmentSpec(file);
    const { text } = generateStack(spec, "infra", {
      project: "hermes-gitops-bootstrap", existingFile: join(dir, "none.yaml"), stackDir: dir,
    });
    expect(text).toContain("hermes-gitops-bootstrap:agents: []");
    expect(text).toContain("hermes-gitops-bootstrap:hermes: {}");
    // pulumi refuses '' where it expects a JSON value - a bare key is that.
    expect(text).not.toMatch(/agents:\n/);
  });
});
