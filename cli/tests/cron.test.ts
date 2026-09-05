// `hg cron` — the wrapper's own decisions (#349).
//
// Everything tested here is a place where `hg` and the fork's CLI
// disagree about vocabulary or shape, and the wrapper has to choose. The
// scheduling itself is native and is not tested here; reimplementing it
// is exactly what #349's non-goals forbid.

import { describe, expect, test } from "bun:test";
import { parseCronList, parseTemporary, requireJob, type CronJob } from "../src/cron/index.ts";

describe("reading the fork's job list", () => {
  test("normalises snake_case into the shape hg reports", () => {
    const jobs = parseCronList(
      JSON.stringify([
        {
          name: "communication-proof",
          schedule: "0 2 * * *",
          enabled: true,
          state: "scheduled",
          last_run_at: "2026-08-12T02:00:00Z",
          next_run_at: "2026-08-13T02:00:00Z",
          enabled_toolsets: ["cluster_health"],
        },
      ]),
    );
    expect(jobs).toEqual([
      {
        name: "communication-proof",
        schedule: "0 2 * * *",
        enabled: true,
        state: "scheduled",
        lastRunAt: "2026-08-12T02:00:00Z",
        nextRunAt: "2026-08-13T02:00:00Z",
        pausedReason: null,
        toolsets: ["cluster_health"],
      },
    ]);
  });

  test("a paused job is disabled even when `enabled` is still true", () => {
    // The fork carries both `enabled` and `state`, and they can disagree
    // in flight. Trusting only `enabled` would report a paused job as
    // schedulable - which is the reading an operator would act on.
    const [job] = parseCronList(
      JSON.stringify([{ name: "x", enabled: true, state: "paused", paused_reason: "manual" }]),
    );
    expect(job!.enabled).toBe(false);
    expect(job!.pausedReason).toBe("manual");
  });

  test("both list shapes are accepted", () => {
    // A bare array and a {jobs: [...]} envelope both appear depending on
    // the fork's version.
    expect(parseCronList(JSON.stringify([{ name: "a", enabled: true }]))[0]!.name).toBe("a");
    expect(parseCronList(JSON.stringify({ jobs: [{ name: "b", enabled: true }] }))[0]!.name).toBe("b");
  });

  test("unparseable output names the command to run by hand", () => {
    // The likely cause is an older hermes or a warning printed before the
    // JSON, and neither is diagnosable from "unexpected token".
    expect(() => parseCronList("Warning: something\n[]")).toThrow(/hg agent exec -- cron list --json/);
  });

  test("a job with no name is refused rather than silently dropped", () => {
    expect(() => parseCronList(JSON.stringify([{ enabled: true }]))).toThrow(/no name/);
  });
});

describe("--temporary durations (#349)", () => {
  test("accepts seconds, minutes and hours", () => {
    expect(parseTemporary("90s")).toBe(90);
    expect(parseTemporary("30m")).toBe(1800);
    expect(parseTemporary("2h")).toBe(7200);
  });

  test("rejects an invalid duration", () => {
    // #349's negative test: "Invalid temporary duration is rejected."
    for (const bad of ["30", "m", "-5m", "30 minutes", "1d", ""]) {
      expect(() => parseTemporary(bad)).toThrow();
    }
  });

  test("rejects zero", () => {
    expect(() => parseTemporary("0m")).toThrow(/greater than zero/);
  });

  test("caps at 24h, and says why", () => {
    // A "temporary" enablement that outlives the session which set it is
    // just an undeclared schedule - and #349 requires temporary state to
    // leave no persistent desired-state drift.
    expect(parseTemporary("24h")).toBe(86400);
    expect(() => parseTemporary("25h")).toThrow(/Git-backed/);
  });
});

describe("naming a job that does not exist", () => {
  const jobs: CronJob[] = [
    { name: "communication-proof", enabled: true },
    { name: "status-checkin", enabled: false },
  ];

  test("lists what does exist", () => {
    // #349's negative test: "Unknown job ID produces an actionable
    // error." The cause is nearly always a typo or a job that never
    // deployed, and both are answered by showing the real names.
    expect(() => requireJob(jobs, "comunication-proof")).toThrow(/communication-proof, status-checkin/);
  });

  test("an empty registry says so rather than listing nothing", () => {
    // "Jobs here: " with an empty list reads as a bug. No jobs at all is
    // a different problem with a different fix.
    expect(() => requireJob([], "anything")).toThrow(/no cron jobs at all/);
  });

  test("an exact match resolves", () => {
    expect(requireJob(jobs, "status-checkin").enabled).toBe(false);
  });
});
