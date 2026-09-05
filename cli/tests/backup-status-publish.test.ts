// The platform-backup status record must land in the namespace the
// reconciler is configured with - Nexus reads it from nowhere else. The
// lookup is a lazy, string-path require (kept lazy so `hg backup` does
// not load the tick machinery), which TypeScript cannot check: #691 moved
// backup/platform.ts and the string kept naming the old sibling, the
// catch swallowed the throw, and every nightly publish on the factory
// went to a namespace that does not exist for a week while the journal
// said only "could not publish". This test runs the real lookup against
// a real config file, so a broken path fails here, not on the fleet.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedHome = process.env["HERMES_GITOPS_HOME"];
const HOME = mkdtempSync(join(tmpdir(), "hg-status-publish-"));
process.env["HERMES_GITOPS_HOME"] = HOME;

// HOME must be set BEFORE these imports: the reconciler resolves its
// config path per call, but bun runs the suite in one process.
const { writeConfig, configFile } = await import("../src/reconcile/index.ts");
const { statusRecordNamespace, statusConfigMapManifest } = await import("../src/backup/platform.ts");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env["HERMES_GITOPS_HOME"];
  else process.env["HERMES_GITOPS_HOME"] = savedHome;
});

describe("the status record's namespace", () => {
  test("without a reconciler config, the in-cluster default applies", () => {
    expect(statusRecordNamespace()).toBe("hermes-gitops");
  });

  test("honours the reconciler's configured statusNamespace - the lookup really loads", () => {
    mkdirSync(join(HOME, "reconcile"), { recursive: true });
    writeConfig({
      version: "v-test",
      repoUrl: "https://example.invalid/persona.git",
      branch: "main",
      intervalSeconds: 60,
      checks: [],
      apply: "true",
      hermesHome: join(HOME, ".hermes"),
      argocdTimeoutSec: 5,
      statusNamespace: "probe-ns",
    });
    expect(configFile()).toBe(join(HOME, "reconcile", "config.json"));
    expect(statusRecordNamespace()).toBe("probe-ns");
  });

  test("the published manifest targets that namespace and carries the surface label", () => {
    const m = statusConfigMapManifest("hermes-platform-backup-status", "platform-backup", { backupId: "hg-1" });
    expect(m.metadata.namespace).toBe("probe-ns");
    expect(m.metadata.name).toBe("hermes-platform-backup-status");
    expect(m.metadata.labels).toEqual({ "hermes.dev/overlay-source": "platform-backup" });
    expect(JSON.parse(m.data["status.json"])).toEqual({ backupId: "hg-1" });
  });
});
