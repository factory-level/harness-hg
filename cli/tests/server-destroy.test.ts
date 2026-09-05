// hg server destroy (ADR-66): the deletion allowlist and its containment
// property - "never touches the docker fleet or the disks" as a test,
// not a promise. The ssh execution itself is exercised only by the live
// rehearsal; everything decidable offline is decided here.
import { describe, expect, test } from "bun:test";
import { HERMES_USER_UNITS, destroyScope } from "../src/server/bootstrap.ts";

const ROOT = "/mnt/ssd/hermes-gitops";

describe("destroyScope containment", () => {
  test("every deleted path is UNDER the sync root - nothing else on the machine is reachable", () => {
    for (const p of destroyScope(ROOT)) {
      expect(p.startsWith(`${ROOT}/`)).toBe(true);
      expect(p).not.toContain("..");
      expect(p).not.toContain("*");
    }
  });

  test("env/ IS in scope - cached credentials must not survive to quietly satisfy the restore test", () => {
    expect(destroyScope(ROOT)).toContain(`${ROOT}/env`);
  });

  test("server-id IS in scope - its removal is what makes the re-bootstrap a NEW server identity", () => {
    expect(destroyScope(ROOT)).toContain(`${ROOT}/server-id`);
  });

  test("the scope never names the sync-root itself or its parent - the mount and the disk stay", () => {
    const scope = destroyScope(ROOT);
    expect(scope).not.toContain(ROOT);
    expect(scope).not.toContain("/mnt/ssd");
    expect(scope).not.toContain("/");
  });
});

describe("the unit allowlist", () => {
  test("exactly the three hermes timer pairs - a glob would take whatever else lives there", () => {
    expect(HERMES_USER_UNITS).toEqual([
      "hermes-reconcile.service", "hermes-reconcile.timer",
      "hermes-platform-backup.service", "hermes-platform-backup.timer",
      "hermes-restore-verify.service", "hermes-restore-verify.timer",
    ]);
    for (const u of HERMES_USER_UNITS) expect(u.startsWith("hermes-")).toBe(true);
  });
});
