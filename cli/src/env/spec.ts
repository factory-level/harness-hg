// The environment spec (#674): load + validate environment.yaml, the
// declarative source of truth one environment's two Pulumi stacks are
// generated from. The schema is cli/schemas/environment/v1alpha1 (the
// evals precedent - a CLI-versioned contract, not a frozen deployment
// surface), and validation reports EVERY failure at once with the
// instance path, per the validate philosophy.
import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { parse as parseYaml } from "yaml";
import { CliError, PLATFORM_ROOT } from "../lib.ts";

export const ENV_SPEC_API_VERSION = "hermes-gitops.factorylevel.dev/environment/v1alpha2";

/** A leaf whose value exists only as secure: ciphertext in the
 * generated stack config - never in the spec. */
export interface SecretRef {
  secret: true;
}

export function isSecretRef(v: unknown): v is SecretRef {
  return (
    typeof v === "object" && v !== null && (v as Record<string, unknown>)["secret"] === true &&
    Object.keys(v as object).length === 1
  );
}

export interface RootKms {
  location: string;
  keyring: string;
  key: string;
}

/** The bootstrap's half of every dual-owned concern (ADR 0178, spec
 * v1alpha2 `grants`): what the environment GIVES an agent-team repo. */
export interface EnvironmentGrants {
  targets?: Record<string, { name: string; argoDestination: string; primary?: boolean }[]>;
  globalTarget?: string;
  dns?: { publicBaseDomain?: string; privateBaseDomain?: string };
  policy?: { allowedChartSources?: string[]; allowedJurisdictions?: string[] };
  capabilities?: Record<string, { implementation: string; url: string; region?: string }>;
  workspaces?: { repositories: unknown[]; bindings: unknown[] };
}

export interface EnvironmentSpec {
  apiVersion: string;
  name: string;
  project: string;
  rootKms: RootKms;
  rootStateBucket?: string;
  state: {
    deployerGroup: string;
    agents: string[];
    backupEnvironments?: string[];
    bucketLocation?: string;
    perAgentKeys?: boolean;
  };
  // The infra block mirrors infra/src/control-flow/config.ts load()
  // key-for-key; leaves may be SecretRef. Typed loosely on purpose -
  // the schema is the authority on shape, this type is the authority
  // on which keys the GENERATOR knows how to place.
  infra: Record<string, unknown>;
  grants?: EnvironmentGrants;
}

/** The assembled URIs the operator never types (#676). */
export function rootStateBucketUri(spec: EnvironmentSpec): string {
  return `gs://${spec.rootStateBucket ?? `${spec.project}-pulumi-root-state`}`;
}

export function rootKmsResourceId(spec: EnvironmentSpec): string {
  const k = spec.rootKms;
  return `projects/${spec.project}/locations/${k.location}/keyRings/${k.keyring}/cryptoKeys/${k.key}`;
}

export function rootSecretsProviderUri(spec: EnvironmentSpec): string {
  return `gcpkms://${rootKmsResourceId(spec)}`;
}

/** The per-environment backend derivations - the same strings
 * state/src/config.ts and infra/scripts/agent-backend.sh derive; ONE
 * more copy would be a bug, so env-new and the docs both call these. */
export function envStateBucketUri(spec: EnvironmentSpec, env: string): string {
  return `gs://${spec.project}-${env}-state`;
}

export function envDeployerEmail(spec: EnvironmentSpec, env: string): string {
  return `${env}-deployer@${spec.project}.iam.gserviceaccount.com`;
}

/** Every spec version the CLI reads, newest last. `hg env import` writes the
 * newest (ENV_SPEC_API_VERSION); older files keep validating against their own
 * frozen schema. An unknown or missing apiVersion is refused by name - never
 * guessed. */
export const ENV_SPEC_VERSIONS = ["v1alpha1", "v1alpha2"] as const;

function schemaPathFor(doc: unknown, abs: string): { version: string; file: string } {
  const api = (doc as { apiVersion?: unknown } | null)?.apiVersion;
  const version = ENV_SPEC_VERSIONS.find(
    (v) => api === `hermes-gitops.factorylevel.dev/environment/${v}`,
  );
  if (!version) {
    throw new CliError(
      `environment spec ${abs}: apiVersion ${JSON.stringify(api ?? null)} is not one the CLI reads ` +
        `(known: ${ENV_SPEC_VERSIONS.map((v) => `hermes-gitops.factorylevel.dev/environment/${v}`).join(", ")})`,
    );
  }
  return {
    version,
    file: path.join(PLATFORM_ROOT, "cli", "schemas", "environment", version, "environment.schema.json"),
  };
}

export function loadEnvironmentSpec(file: string): EnvironmentSpec {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new CliError(`environment spec ${abs} does not exist`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    throw new CliError(`environment spec ${abs} is not YAML: ${(err as Error).message}`);
  }
  const { version, file: schemaFile } = schemaPathFor(doc, abs);
  const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
  const validate = ajv.compile(schema);
  if (!validate(doc)) {
    const lines = (validate.errors ?? []).map(
      (e) => `  ${e.instancePath || "$"}: ${e.message}`,
    );
    throw new CliError(
      `environment spec ${abs} violates hermes-gitops.factorylevel.dev/environment/${version}:\n${lines.join("\n")}`,
    );
  }
  return doc as EnvironmentSpec;
}
