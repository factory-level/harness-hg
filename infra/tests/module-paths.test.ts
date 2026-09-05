// Runtime paths built from a module's own location.
//
// These are not imports, so nothing type-checks them and no test exercised
// them: moving `components/hermes-agent/` into `components/harness/`
// (ADR-153) left `topology-preview.ts` pointing one level too shallow, at
// `infra/cli/src/main.ts`. `cd infra && bun test` stayed green and
// `pulumi preview` against the factory stack failed with "Module not
// found" - the first time anything noticed, on a live environment.
//
// So: every `import.meta.dirname` path in the Pulumi program is resolved
// here and asserted to exist. A file that moves and forgets to re-count
// its `..` now fails locally instead of on a deployment.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(import.meta.dirname, "..", "src");

/** Every `path.resolve(import.meta.dirname, …)` in the program, with the
 * file that builds it - found by reading the source rather than by
 * listing them here, so a NEW one is covered the day it is written. */
function resolvedPaths(): { file: string; target: string }[] {
  const out: { file: string; target: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const text = fs.readFileSync(full, "utf8");
      const re = /path\.resolve\(\s*import\.meta\.dirname\s*,([^)]*)\)/g;
      for (const m of text.matchAll(re)) {
        const parts = [...m[1]!.matchAll(/"([^"]+)"/g)].map((p) => p[1]!);
        if (parts.length === 0) continue;
        out.push({ file: path.relative(SRC, full), target: path.resolve(path.dirname(full), ...parts) });
      }
    }
  };
  walk(SRC);
  return out;
}

describe("runtime paths built from import.meta.dirname", () => {
  test("at least one exists to check", () => {
    // If this ever hits zero the scanner has stopped matching, and the
    // suite would pass by finding nothing - the failure mode this guards.
    expect(resolvedPaths().length).toBeGreaterThan(0);
  });

  for (const { file, target } of resolvedPaths()) {
    test(`${file} -> ${path.relative(path.resolve(SRC, "..", ".."), target)}`, () => {
      expect(fs.existsSync(target)).toBe(true);
    });
  }
});
