// Manifest version compatibility (#297): v1alpha2 added the optional
// `encryption` block. Every backup taken before the bump is a v1alpha1
// manifest in a sink somewhere - a reader that only accepts the new
// version orphans every existing restore point.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../src/backup/platform.ts";

function manifestDir(overrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "hg-manifest-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: "hermes.dev/platform-backup/v1alpha2",
      backupId: "hg-2026-08-03t00-00-00z",
      createdAt: "2026-08-03T00:00:00Z",
      environment: "factory",
      components: [],
      verification: { state: "available" },
      ...overrides,
    }),
  );
  return dir;
}

describe("readManifest version allowlist", () => {
  test("v1alpha1 (pre-encryption) still reads", () => {
    const m = readManifest(manifestDir({ schemaVersion: "hermes.dev/platform-backup/v1alpha1" }));
    expect(m.encryption).toBeUndefined();
  });

  test("v1alpha2 reads with its encryption block intact", () => {
    const m = readManifest(
      manifestDir({ encryption: { mode: "cmek", kmsKey: "projects/p/locations/us/keyRings/backups/cryptoKeys/k" } }),
    );
    expect(m.encryption?.mode).toBe("cmek");
  });

  test("an unknown version is refused with both accepted versions named", () => {
    expect(() => readManifest(manifestDir({ schemaVersion: "hermes.dev/platform-backup/v9" }))).toThrow(
      /v1alpha1.*v1alpha2|v1alpha2.*v1alpha1/,
    );
  });
});
