#!/usr/bin/env node
// Generate TypeScript contract types from the canonical JSON Schemas
// (ADR-7, #139).
//
// JSON Schema is the contract. The TypeScript the Pulumi program used was
// a HAND-MIRROR of it, and two hand-maintained descriptions of one
// contract diverge — the only question is when and how expensively.
//
// WHAT THIS GENERATES, and what it deliberately does not:
//
// Only the closed enumerations — the provider vocabularies. Those are
// where divergence is both most likely and most expensive: a value the
// schema accepts and the program does not is a stack config an operator
// can write and the platform will refuse for no stated reason.
//
// The interfaces are NOT generated. `BootstrapConfig` is not a
// projection of any schema: it carries bootstrap-only concepts
// (`clusterProvider`, kubeconfig paths, the reconcile block) that no
// record schema describes, and generating half of it while hand-writing
// the rest would leave a file where you cannot tell which half is which.
// #139 asks for the mirrors to be deleted; the enums ARE the mirrors that
// were drifting.
//
// GENERATION IS NOT A COPY. A frozen schema keeps values the platform has
// since retired — `providers.ingress` still lists `tailscale`, correctly,
// because `cluster-values/v1alpha1` is immutable and old records may name
// it. The ACCEPTED set is the frozen set minus what the platform retired,
// so RETIRED below is part of the contract rather than a workaround, and
// it mirrors the same map in plugin/tests/test_values_schema_subset.py.
//
// Usage:
//   node infra/scripts/generate-contract-types.mjs           # write
//   node infra/scripts/generate-contract-types.mjs --check   # drift-check

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA = join(
  ROOT,
  "agent-bundle-contracts/cluster-values/v1alpha1/cluster-values.schema.json",
);
const OUT = join(ROOT, "infra/src/control-flow/generated-contract.ts");

/** Values a frozen schema still lists that the platform has retired.
 *
 * Mirrors plugin/tests/test_values_schema_subset.py's RETIRED. A frozen
 * schema is immutable, so removal is expressed HERE rather than by
 * editing the contract — and stating it in one place per language beats
 * an unexplained difference between the schema and the code.
 */
const RETIRED = {
  // ADR-9 / #131: three contradictory in-tree descriptions of its status
  // and no test. Templates, guard and sidecar removed.
  ingress: ["tailscale"],
};

/** Which schema enums become which exported names. */
const ENUMS = [
  {
    pointer: ["providers", "compute"],
    constName: "COMPUTE_PROVIDERS",
    typeName: "ComputeProvider",
    note: "pod is the ONLY compute provider: the per-agent VM compute path (gce/libvirt) was removed outright (issue #27 [G8]).",
  },
  {
    pointer: ["providers", "secret"],
    constName: "SECRET_PROVIDERS",
    typeName: "SecretProvider",
    note: "k8s is the ONLY secret provider: values are encrypted in the Pulumi stack (`pulumi config set --secret`) and materialized as k8s Secrets — no external secret backend (vault/gsm/sops removed, issue #30 [H1]).",
  },
  {
    pointer: ["providers", "ingress"],
    constName: "INGRESS_PROVIDERS",
    typeName: "IngressProvider",
    note: "`tailscale` is in the frozen schema and NOT here: ADR-9 retired it (#131). A frozen schema keeps the value; the platform stops accepting it.",
  },
  {
    pointer: ["providers", "backup"],
    constName: "BACKUP_PROVIDERS",
    typeName: "BackupProvider",
    note: "Where an agent's backup artifacts land.",
  },
];

function enumAt(schema, pointer) {
  let node = schema;
  for (const key of pointer) {
    node = node?.properties?.[key];
    if (node === undefined) {
      throw new Error(
        `generate-contract-types: no such property in the schema: ${pointer.join(".")}`,
      );
    }
  }
  if (!Array.isArray(node.enum)) {
    throw new Error(
      `generate-contract-types: ${pointer.join(".")} is not an enum — this generator only ` +
        `produces closed vocabularies, and a property that stopped being one needs a decision, ` +
        `not a silent skip`,
    );
  }
  return node.enum;
}

function render(schema) {
  const lines = [
    "// GENERATED FILE — DO NOT EDIT.",
    "//",
    "// Source:   agent-bundle-contracts/cluster-values/v1alpha1/cluster-values.schema.json",
    "// Producer: infra/scripts/generate-contract-types.mjs",
    "// Contract: ADR-7 — JSON Schema is canonical; every other machine-readable",
    "//           description is generated from it (#139).",
    "//",
    "// Regenerate:  make contract-types",
    "// Drift-check: make contract-types-drift  (runs in `make test`)",
    "//",
    "// Only the closed provider vocabularies are generated. The interfaces in",
    "// config.ts are NOT projections of any schema — BootstrapConfig carries",
    "// bootstrap-only concepts no record schema describes — and generating half",
    "// of a file leaves you unable to tell which half is which.",
    "",
  ];

  for (const spec of ENUMS) {
    const key = spec.pointer[spec.pointer.length - 1];
    const retired = RETIRED[key] ?? [];
    const all = enumAt(schema, spec.pointer);
    const accepted = all.filter((v) => !retired.includes(v));

    lines.push("/**");
    for (const chunk of wrap(spec.note, 72)) lines.push(` * ${chunk}`);
    if (retired.length > 0) {
      lines.push(" *");
      lines.push(` * Retired and therefore not accepted: ${retired.map((r) => `\`${r}\``).join(", ")}.`);
    }
    lines.push(" */");
    lines.push(
      `export const ${spec.constName} = [${accepted.map((v) => JSON.stringify(v)).join(", ")}] as const;`,
    );
    lines.push(
      `export type ${spec.typeName} = (typeof ${spec.constName})[number];`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const out = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width && line) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
const rendered = render(schema);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(
      `FAIL ${OUT} does not exist — run \`make contract-types\``,
    );
    process.exit(1);
  }
  if (current !== rendered) {
    console.error(
      "FAIL infra/src/control-flow/generated-contract.ts is out of date with the canonical schema.\n" +
        "     The schema is the contract (ADR-7); the TypeScript is a projection of it.\n" +
        "     Run `make contract-types` and commit the result.",
    );
    process.exit(1);
  }
  console.log("OK   generated contract types match the canonical schema");
} else {
  writeFileSync(OUT, rendered, "utf8");
  console.log(`wrote ${OUT}`);
}
