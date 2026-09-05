// Scheduled backup and restore verification (#283, ADR-52).
//
// The unit files are generated text with four interpolations, which is
// exactly how templates drift - so they are asserted rather than
// eyeballed, the same discipline the reconciler's units get.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupUnitFiles, DEFAULT_TIMERS, newestBackup, windowStatus } from "../src/backup/timers.ts";

const cfg = { destination: "/srv/backups", ...DEFAULT_TIMERS };
const units = backupUnitFiles(cfg, { bun: "/usr/bin/bun", main: "/opt/hg/main.ts" });

describe("unit files", () => {
  test("there are TWO timers, not one", () => {
    // They answer different questions: "is there a recent restore point"
    // and "does one of them actually restore". Collapsing them loses the
    // second, which is the one ADR-52 is about.
    expect(Object.keys(units).sort()).toEqual([
      "hermes-platform-backup.service",
      "hermes-platform-backup.timer",
      "hermes-restore-verify.service",
      "hermes-restore-verify.timer",
    ]);
  });

  test("both timers are Persistent - a missed window is when it matters most", () => {
    expect(units["hermes-platform-backup.timer"]).toContain("Persistent=true");
    expect(units["hermes-restore-verify.timer"]).toContain("Persistent=true");
  });

  test("both services bake a PATH that includes bun's own directory", () => {
    // systemd user units get a minimal PATH without ~/.local/bin, where
    // bun AND gcloud live on a bootstrapped server. The factory backups
    // failed silently for two nights on exactly this before it was baked.
    for (const unit of ["hermes-platform-backup.service", "hermes-restore-verify.service"]) {
      expect(units[unit]).toContain("Environment=PATH=/usr/bin:/usr/local/bin:/usr/bin:/bin");
    }
  });

  test("verification runs rarer than backup", () => {
    // A verification restores into the live cluster. It is a real
    // operation with real disruption, not a poll.
    expect(DEFAULT_TIMERS.backupSchedule).toContain("*-*-*");
    expect(DEFAULT_TIMERS.verifySchedule.startsWith("Sun ")).toBe(true);
  });

  test("the backup timeout is generous enough not to truncate", () => {
    // A killed backup leaves a scaffold with no manifest, which reads as
    // a backup that exists and cannot be restored.
    expect(units["hermes-platform-backup.service"]).toContain("TimeoutStartSec=3600");
  });

  test("the units carry the resolved runtime and entrypoint", () => {
    expect(units["hermes-platform-backup.service"]).toContain("/usr/bin/bun /opt/hg/main.ts platform backup create --to /srv/backups");
    expect(units["hermes-restore-verify.service"]).toContain("platform verify-restore --from /srv/backups");
  });
});

describe("newestBackup", () => {
  test("timestamped names sort chronologically", () => {
    const root = mkdtempSync(join(tmpdir(), "hg-backups-"));
    for (const n of ["hg-2026-08-01T02-30-00z", "hg-2026-08-03T02-30-00z", "hg-2026-08-02T02-30-00z"]) {
      mkdirSync(join(root, n));
    }
    expect(newestBackup(root)).toBe(join(root, "hg-2026-08-03T02-30-00z"));
  });

  test("an empty or missing root is null, not a throw", () => {
    expect(newestBackup(mkdtempSync(join(tmpdir(), "hg-empty-")))).toBeNull();
    expect(newestBackup("/nonexistent/path")).toBeNull();
  });

  test("unrelated directories are ignored", () => {
    const root = mkdtempSync(join(tmpdir(), "hg-mixed-"));
    mkdirSync(join(root, "zzz-not-a-backup"));
    mkdirSync(join(root, "hg-2026-08-01T02-30-00z"));
    expect(newestBackup(root)).toBe(join(root, "hg-2026-08-01T02-30-00z"));
  });
});

describe("windowStatus", () => {
  const now = new Date("2026-08-10T12:00:00Z");

  test("never is not the same as late", () => {
    // "We have never verified a restore" and "our last verification is
    // old" are different operator problems with different fixes.
    const s = windowStatus(now, null, null);
    expect(s).toEqual({ backup: "never", verify: "never" });
  });

  test("a backup inside its window is current", () => {
    expect(windowStatus(now, "2026-08-10T02:30:00Z", null).backup).toBe("current");
  });

  test("a missed nightly window is late", () => {
    expect(windowStatus(now, "2026-08-08T02:30:00Z", null).backup).toBe("late");
  });

  test("verification is judged in days, not hours", () => {
    // A four-day-old verification is fine; a four-day-old backup is not.
    expect(windowStatus(now, null, "2026-08-06T04:00:00Z").verify).toBe("current");
    expect(windowStatus(now, null, "2026-07-20T04:00:00Z").verify).toBe("late");
  });
});

describe("sink + identity in the units (#297)", () => {
  const withSink = backupUnitFiles(
    { ...cfg, sink: "gs://factorylevel-prod-factory-backup/factory", writerSa: "factory-backup-writer@p.iam.gserviceaccount.com" },
    { bun: "/usr/bin/bun", main: "/opt/hg/main.ts" },
  );

  test("both scheduled runs carry the sink - a nightly backup that stays local survives nothing", () => {
    expect(withSink["hermes-platform-backup.service"]).toContain(
      "--sink gs://factorylevel-prod-factory-backup/factory",
    );
    expect(withSink["hermes-restore-verify.service"]).toContain(
      "--sink gs://factorylevel-prod-factory-backup/factory",
    );
  });

  test("the writer identity is baked as env - a timer has no interactive login", () => {
    expect(withSink["hermes-platform-backup.service"]).toContain(
      "Environment=HG_BACKUP_WRITER_SA=factory-backup-writer@p.iam.gserviceaccount.com",
    );
    expect(withSink["hermes-restore-verify.service"]).toContain("HG_BACKUP_WRITER_SA=");
  });

  test("without a sink the units are byte-stable - the local loop is unchanged", () => {
    expect(units["hermes-platform-backup.service"]).not.toContain("--sink");
    expect(units["hermes-platform-backup.service"]).not.toContain("HG_BACKUP_WRITER_SA");
  });
});
