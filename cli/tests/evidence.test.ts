// The evidence package (ADR-67): bundle shape, proof collection, and the
// sweep that refuses secret-shaped content. Pure/fs-only - the sink
// upload is putObject, proven elsewhere.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildEvidence, sweepEvidence } from "../src/backup/evidence.ts";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "hg-evidence-home-"));
const savedHome = process.env["HERMES_GITOPS_HOME"];
process.env["HERMES_GITOPS_HOME"] = tempHome;

afterAll(() => {
  if (savedHome === undefined) delete process.env["HERMES_GITOPS_HOME"];
  else process.env["HERMES_GITOPS_HOME"] = savedHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hg-evidence-"));
}

describe("sweepEvidence", () => {
  test("clean content passes", () => {
    expect(sweepEvidence([{ name: "a.json", content: '{"ok":true}' }])).toEqual([]);
  });

  test("a bearer token names its file and its shape", () => {
    const hits = sweepEvidence([
      { name: "proofs/eval.json", content: '{"token":"hgev_abcdefghijklmnop123456"}' },
    ]);
    // Both layers fire: the hgev_ shape AND the secret-named key.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.join("; ")).toContain("proofs/eval.json");
    expect(hits.join("; ")).toContain("bearer/publish token");
  });

  test("an unknown secret under a secret-named key is caught by structure, not pattern", () => {
    const hits = sweepEvidence([
      { name: "x.json", content: '{"nested":{"api_key":"totally-novel-shape-1234"}}' },
    ]);
    expect(hits).toEqual(["x.json.nested.api_key: a secret-named key"]);
  });

  test("resource names under key-ish identifiers are NOT refused", () => {
    const hits = sweepEvidence([
      { name: "ok.json", content: '{"kmsKey":"projects/p/locations/us/keyRings/r/cryptoKeys/k","publicKey":"x"}' },
    ]);
    expect(hits).toEqual([]);
  });
});

describe("buildEvidence", () => {
  test("bundles the spine, collects operator-saved proofs, and never re-runs them", () => {
    const to = scratch();
    fs.writeFileSync(path.join(to, "launch.json"), '{"kind":"ProofResult","ok":true}');
    const { dir, files } = buildEvidence({ toDir: to });
    expect(files).toContain("evidence.json");
    expect(files).toContain("proofs/launch.json");
    const spine = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8"));
    expect(spine.kind).toBe("EvidencePackage");
    expect(spine.versions.host.k3s).toBeDefined();
    // No reconciler and no registration on this host: stated as null,
    // never invented.
    expect(spine.reconcile).toBeNull();
    expect(spine.registration).toBeNull();
  });

  test("includes the SCRUBBED backup record when a backup dir is named", () => {
    const to = scratch();
    const backup = path.join(to, "hg-2026-08-03t01-02-03z");
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(
      path.join(backup, "manifest.json"),
      JSON.stringify({
        schemaVersion: "hermes.dev/platform-backup/v1alpha2",
        backupId: "hg-2026-08-03t01-02-03z",
        createdAt: "2026-08-03T01:02:03Z",
        environment: "factory",
        components: [
          { name: "agent-data", kind: "volume-archive", archive: "volumes/x/a.tar.gz", sha256: "ab".repeat(32) },
        ],
        verification: { state: "restorable", restoredAt: "2026-08-03T02:00:00Z" },
      }),
    );
    const { dir, files } = buildEvidence({ toDir: to, backupDir: backup });
    expect(files).toContain("backup-record.json");
    const record = fs.readFileSync(path.join(dir, "backup-record.json"), "utf8");
    // The record is the scrubbed projection: no archive paths, truncated digests.
    expect(record).not.toContain("volumes/x/a.tar.gz");
    expect(record).not.toContain("ab".repeat(32));
  });

  test("REFUSES the whole bundle when a collected proof carries a secret shape", () => {
    const to = scratch();
    fs.writeFileSync(
      path.join(to, "tainted.json"),
      '{"command":"x","ok":true,"jwt":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"}',
    );
    expect(() => buildEvidence({ toDir: to })).toThrow(/tainted\.json/);
    // and nothing was written
    expect(fs.readdirSync(to).filter((n) => n.startsWith("evidence-"))).toEqual([]);
  });

  test("a JSON that is not proof-shaped is SKIPPED, never bundled because it was there", () => {
    const to = scratch();
    fs.writeFileSync(path.join(to, "scratch.json"), '{"whatever":"else"}');
    const { files } = buildEvidence({ toDir: to });
    expect(files).not.toContain("proofs/scratch.json");
  });
});
