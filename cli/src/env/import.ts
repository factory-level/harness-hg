// One-shot importer (#674): existing hand-written Pulumi stack config
// -> environment.yaml. The migration path for environments that
// predate the spec (the factory). Secrets become {secret: true}
// markers - the ciphertext stays where it lives, in the generated
// file, which the generator then reproduces from the same donor.
import * as fs from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { CliError } from "../lib.ts";
import { ENV_SPEC_API_VERSION } from "./spec.ts";

function markSecrets(node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node;
  const rec = node as Record<string, unknown>;
  if (typeof rec["secure"] === "string" && Object.keys(rec).length === 1) {
    return { secret: true };
  }
  if (Array.isArray(node)) return node.map(markSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = markSecrets(v);
  return out;
}

function stripPrefix(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    const bare = k.includes(":") ? k.slice(k.indexOf(":") + 1) : k;
    out[bare] = v;
  }
  return out;
}

const KMS_RE = /^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)$/;

export function importEnvironment(opts: {
  name: string;
  stateFile: string;
  infraFile: string;
}): string {
  for (const f of [opts.stateFile, opts.infraFile]) {
    if (!fs.existsSync(f)) throw new CliError(`env import: ${f} does not exist`);
  }
  const stateDoc = parseYaml(fs.readFileSync(opts.stateFile, "utf8")) as Record<string, unknown>;
  const infraDoc = parseYaml(fs.readFileSync(opts.infraFile, "utf8")) as Record<string, unknown>;
  const stateCfg = stripPrefix((stateDoc["config"] as Record<string, unknown>) ?? {});
  const infraCfg = stripPrefix((infraDoc["config"] as Record<string, unknown>) ?? {});

  const kmsId = String(stateCfg["rootKmsKeyId"] ?? "");
  const m = KMS_RE.exec(kmsId);
  if (!m) {
    throw new CliError(
      `env import: state config rootKmsKeyId ${JSON.stringify(kmsId)} is not a full KMS resource id`,
    );
  }
  const project = String(stateCfg["project"] ?? m[1]);

  const state: Record<string, unknown> = { deployerGroup: stateCfg["deployerGroup"] };
  for (const k of ["agents", "backupEnvironments", "bucketLocation", "perAgentKeys"]) {
    if (stateCfg[k] !== undefined) state[k] = stateCfg[k];
  }

  const infra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(infraCfg)) {
    infra[k] = markSecrets(v);
  }

  const spec = {
    apiVersion: ENV_SPEC_API_VERSION,
    name: opts.name,
    project,
    rootKms: { location: m[2], keyring: m[3], key: m[4] },
    state,
    infra,
  };
  return `${[
    "# The environment spec (#674) - the declarative source of truth this",
    `# environment's two Pulumi stacks are generated from. Imported from the`,
    `# pre-spec hand-written config; secrets are markers, their ciphertext`,
    "# lives only in the generated Pulumi.<env>.yaml files.",
  ].join("\n")}\n${yamlStringify(spec, { lineWidth: 100 })}`;
}
