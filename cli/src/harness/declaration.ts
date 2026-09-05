// The harness declaration (ADR 0162): every harness the registry can
// dispatch on must carry harness/<name>/harness.yaml, validated against
// harness-declaration/v1alpha1 — the gateway declaration is the point.
// The platform ships no universal gateway, so "which gateway" must be a
// stated fact per harness, not folklore; `hg validate` fails the gate
// when a registered harness has no declaration or an invalid one.

import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/2020";
import { parse as parseYaml } from "yaml";
import { CONTRACTS_ROOT, PLATFORM_ROOT } from "../lib.ts";
import type { ValidationFinding } from "../platform/index.ts";
import { DRIVERS } from "./index.ts";

let validator: ValidateFunction | null = null;
function compile(): ValidateFunction {
  if (!validator) {
    const schema = path.join(CONTRACTS_ROOT, "harness-declaration", "v1alpha1", "harness.schema.json");
    validator = new Ajv2020({ allErrors: true }).compile(JSON.parse(fs.readFileSync(schema, "utf8")));
  }
  return validator;
}

export function harnessDeclarationFile(name: string): string {
  return path.join(PLATFORM_ROOT, "harness", name, "harness.yaml");
}

/** Validate every registered harness's declaration. Pure over the files;
 * findings follow the CONN/OBS pattern so cmdValidate can merge them. */
export function validateHarnessDeclarations(): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const v = compile();
  for (const name of Object.keys(DRIVERS)) {
    const file = harnessDeclarationFile(name);
    if (!fs.existsSync(file)) {
      findings.push({
        profile: "*", severity: "error", check: "harness-declaration",
        message: `harness ${name}: no declaration at harness/${name}/harness.yaml - every harness must declare its gateway (ADR 0162)`,
      });
      continue;
    }
    let doc: unknown;
    try {
      doc = parseYaml(fs.readFileSync(file, "utf8"));
    } catch (err) {
      findings.push({
        profile: "*", severity: "error", check: "harness-declaration",
        message: `harness ${name}: harness.yaml is not parseable YAML (${(err as Error).message.slice(0, 120)})`,
      });
      continue;
    }
    if (!v(doc)) {
      for (const e of v.errors ?? []) {
        findings.push({
          profile: "*", severity: "error", check: "harness-declaration",
          message: `harness ${name}: ${e.instancePath || "/"} ${e.message}`,
        });
      }
      continue;
    }
    const spec = (doc as { spec: { name: string } }).spec;
    if (spec.name !== name) {
      findings.push({
        profile: "*", severity: "error", check: "harness-declaration",
        message: `harness ${name}: declaration says spec.name=${JSON.stringify(spec.name)} - it must match the directory/registry name`,
      });
    }
  }
  return findings;
}
