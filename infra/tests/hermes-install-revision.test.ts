// The stage-1 install must re-run when the plugin clone advances - the
// revision, not just the path, is a trigger (found live 2026-09-03).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginRevision } from "../src/components/harness/hermes-install/index.ts";

describe("pluginRevision", () => {
  test("a git checkout answers its HEAD sha", () => {
    expect(pluginRevision(join(import.meta.dir, "..", ".."))).toMatch(/^[0-9a-f]{40}$/);
  });
  test("a vendored copy hashes its emitter files and changes when they do", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-rev-"));
    mkdirSync(join(root, "plugin", "gitops_emitter"), { recursive: true });
    writeFileSync(join(root, "plugin", "gitops_emitter", "a.py"), "x = 1\n");
    const first = pluginRevision(root);
    expect(first).toMatch(/^files-[0-9a-f]{16}$/);
    writeFileSync(join(root, "plugin", "gitops_emitter", "a.py"), "x = 12\n");
    expect(pluginRevision(root)).not.toBe(first);
  });
  test("an unreadable path is stable, never a throw", () => {
    expect(pluginRevision("/nonexistent/plugin")).toBe("unknown");
  });
});
