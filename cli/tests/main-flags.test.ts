// Every flagValue("--x")/flagInt("--x") call site in main.ts must have
// its flag declared (with a value placeholder) in the command manifest -
// VALUE_FLAGS is derived from commands.ts, and a missing entry fails
// SILENTLY (the flag parses as boolean, its value falls into positionals,
// flagValue returns undefined). Found live in P5: --planes filtered
// nothing, --stage would have run every fleet-scaling stage, --since
// always used its default.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS } from "../src/commands.ts";

const src = fs.readFileSync(path.join(import.meta.dir, "..", "src", "main.ts"), "utf8");

const declared = new Set(
  COMMANDS.flatMap((c) =>
    c.subs.flatMap((s) => (s.flags ?? []).filter((f) => f.value !== undefined).map((f) => f.name)),
  ),
);

test("every flagValue/flagInt flag is a value flag in the manifest", () => {
  const used = new Set(
    [...src.matchAll(/flag(?:Value|Int)\(\s*"(--[a-z-]+)"/g)].map((m) => m[1]!),
  );
  expect(used.size).toBeGreaterThan(10);

  const missing = [...used].filter((f) => !declared.has(f));
  expect(missing).toEqual([]);

  // And the inverse: a manifest value flag nothing reads is documentation
  // for a flag the parser would swallow but no command consumes.
  const stale = [...declared].filter((f) => !used.has(f));
  expect(stale).toEqual([]);
});
