// ADR 0162: the gateway is part of the harness contract. This asserts the
// repo's own declarations stay valid and the gate actually bites.

import { describe, expect, test } from "bun:test";
import { DRIVERS } from "../src/harness/index.ts";
import { harnessDeclarationFile, validateHarnessDeclarations } from "../src/harness/declaration.ts";
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";

describe("harness declarations (ADR 0162)", () => {
  test("every registered harness declares, and validates green", () => {
    expect(validateHarnessDeclarations()).toEqual([]);
  });

  test("both harnesses declare a gateway with the decided kinds", () => {
    const kinds: Record<string, string> = {};
    for (const name of Object.keys(DRIVERS)) {
      const doc = parseYaml(fs.readFileSync(harnessDeclarationFile(name), "utf8")) as {
        spec: { gateway: { kind: string; provider?: { name: string } } };
      };
      kinds[name] = doc.spec.gateway.kind;
      if (doc.spec.gateway.kind === "external-service") {
        expect(doc.spec.gateway.provider?.name).toBeTruthy();
      }
    }
    expect(kinds["hermes"]).toBe("native");
    expect(kinds["eve"]).toBe("external-service");
  });
});
