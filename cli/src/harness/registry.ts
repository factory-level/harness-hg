// `hg harness list` — the declared harnesses (ADR 0162 / ADR 0177). Every
// runtime driver carries a schema-validated `harness/<name>/harness.yaml`;
// this is the read side of that contract: the registry, listed.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import { PLATFORM_ROOT } from "../lib.ts";

export interface DeclaredHarness {
  name: string;
  status: string;
  gateway: string;
}

export function listDeclaredHarnesses(root = PLATFORM_ROOT): DeclaredHarness[] {
  const dir = path.join(root, "harness");
  if (!fs.existsSync(dir)) return [];
  const rows: DeclaredHarness[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, entry, "harness.yaml");
    if (!fs.existsSync(file)) continue;
    const doc = parse(fs.readFileSync(file, "utf8")) as {
      spec?: { name?: string; status?: string; gateway?: { kind?: string } };
    };
    rows.push({
      name: doc?.spec?.name ?? entry,
      status: doc?.spec?.status ?? "(undeclared)",
      gateway: doc?.spec?.gateway?.kind ?? "(none)",
    });
  }
  return rows;
}
