// Reading lifecycle records back (#349).
//
// The interesting decisions here are all about ORDER and TRUST: which
// ordering is actually true across planes whose clocks are not
// synchronised, which lines in a shared sink are ours, and what to do
// with a record that carries content it promised not to.

import { describe, expect, test } from "bun:test";
import {
  depths,
  isLifecycleRecord,
  orderTrace,
  parseSince,
  readRecords,
  redactForOutput,
  redactionViolations,
  since,
  summarise,
  type LifecycleRecord,
} from "../src/communication/lifecycle.ts";

const TRACE = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

function rec(over: Partial<LifecycleRecord> & { recordId: string }): LifecycleRecord {
  return {
    version: 1,
    traceId: TRACE,
    plane: "cron",
    type: "cron.triggered",
    occurredAt: "2026-08-12T02:00:00Z",
    ...over,
  } as LifecycleRecord;
}

describe("which lines in a shared sink are ours", () => {
  test("a well-formed record is recognised", () => {
    expect(isLifecycleRecord(rec({ recordId: id(1) }))).toBe(true);
  });

  test("foreign lines are skipped, not reported as corrupt", () => {
    // The sink is SHARED - the same JSONL the alert observer writes to,
    // and an operator may have pointed other things at it. Rendering an
    // Alertmanager payload as a lifecycle record would be nonsense.
    const lines = [
      { parsed: { alerts: [{ status: "firing" }] } },
      { parsed: rec({ recordId: id(1) }) },
      { parsed: undefined },
      { parsed: "a bare string" },
    ];
    expect(readRecords(lines).map((r) => r.recordId)).toEqual([id(1)]);
  });

  test("a record with the right keys but a wrong-shaped id is not ours", () => {
    // Structural, not a single-field guess: a partial match is exactly
    // how a foreign document gets misclassified.
    expect(isLifecycleRecord({ ...rec({ recordId: id(1) }), recordId: "cron-1" })).toBe(false);
    expect(isLifecycleRecord({ ...rec({ recordId: id(1) }), plane: "billing" })).toBe(false);
    expect(isLifecycleRecord({ ...rec({ recordId: id(1) }), type: "CronTriggered" })).toBe(false);
    expect(isLifecycleRecord({ ...rec({ recordId: id(1) }), version: 2 })).toBe(false);
  });
});

describe("ordering a trace", () => {
  test("follows causation, not timestamps", () => {
    // The load-bearing decision. Clocks across planes are NOT
    // synchronised, and two records in the same millisecond have no
    // meaningful order - `causationId` is the only ordering that is
    // actually true. Here the child's timestamp is EARLIER than its
    // parent's, which a timestamp sort would render as cause following
    // effect.
    const parent = rec({ recordId: id(1), occurredAt: "2026-08-12T02:00:05Z" });
    const child = rec({
      recordId: id(2),
      causationId: id(1),
      plane: "tool",
      type: "tool.started",
      occurredAt: "2026-08-12T02:00:01Z",
    });
    expect(orderTrace([child, parent]).map((r) => r.recordId)).toEqual([id(1), id(2)]);
  });

  test("siblings fall back to time, which is where clocks are reliable", () => {
    const parent = rec({ recordId: id(1), occurredAt: "2026-08-12T02:00:00Z" });
    const later = rec({ recordId: id(2), causationId: id(1), occurredAt: "2026-08-12T02:00:09Z" });
    const sooner = rec({ recordId: id(3), causationId: id(1), occurredAt: "2026-08-12T02:00:02Z" });
    expect(orderTrace([parent, later, sooner]).map((r) => r.recordId)).toEqual([id(1), id(3), id(2)]);
  });

  test("a record whose parent is absent is a root, never dropped", () => {
    // A partial trace is NORMAL - the observer may have been enabled
    // mid-flight. Losing records to make the tree tidy is the worst
    // possible trade in a diagnostic tool.
    const orphan = rec({ recordId: id(2), causationId: id(9) });
    expect(orderTrace([orphan]).map((r) => r.recordId)).toEqual([id(2)]);
  });

  test("a cycle truncates rather than hanging", () => {
    // Cannot happen in a well-formed trace. A diagnostic tool that hangs
    // on malformed input is worse than one that truncates.
    const a = rec({ recordId: id(1), causationId: id(2) });
    const b = rec({ recordId: id(2), causationId: id(1) });
    const out = orderTrace([a, b]);
    expect(out.length).toBeLessThanOrEqual(2);
  });

  test("depth is the causal depth", () => {
    const root = rec({ recordId: id(1) });
    const mid = rec({ recordId: id(2), causationId: id(1) });
    const leaf = rec({ recordId: id(3), causationId: id(2) });
    const d = depths(orderTrace([root, mid, leaf]));
    expect([d.get(id(1)), d.get(id(2)), d.get(id(3))]).toEqual([0, 1, 2]);
  });
});

describe("summarising traces", () => {
  test("one failure makes the trace failed, however many successes", () => {
    const s = summarise([
      rec({ recordId: id(1), outcome: "success" }),
      rec({ recordId: id(2), outcome: "failure" }),
      rec({ recordId: id(3), outcome: "success" }),
    ]);
    expect(s[0]!.outcome).toBe("failure");
  });

  test("refused outranks success but not failure", () => {
    // `refused` is a working system saying no; `failure` is breakage.
    // Showing the second when both happened is the useful choice.
    expect(summarise([rec({ recordId: id(1), outcome: "refused" }), rec({ recordId: id(2), outcome: "success" })])[0]!.outcome).toBe("refused");
    expect(summarise([rec({ recordId: id(1), outcome: "refused" }), rec({ recordId: id(2), outcome: "failure" })])[0]!.outcome).toBe("failure");
  });

  test("no terminal record means open, not failed", () => {
    expect(summarise([rec({ recordId: id(1) })])[0]!.outcome).toBe("open");
  });

  test("testRun distinguishes a manual run from an autonomous one", () => {
    // #349's exit proof turns on exactly this: one trace triggered by a
    // human, one by the scheduler, distinguishable in the RECORDS.
    const manual = summarise([rec({ recordId: id(1), testRun: "proof-1" })])[0]!;
    const auto = summarise([rec({ recordId: id(2), traceId: id(8) })])[0]!;
    expect(manual.testRun).toBe("proof-1");
    expect(auto.testRun).toBeUndefined();
  });

  test("newest trace first", () => {
    const older = rec({ recordId: id(1), traceId: id(7), occurredAt: "2026-08-12T01:00:00Z" });
    const newer = rec({ recordId: id(2), traceId: id(8), occurredAt: "2026-08-12T03:00:00Z" });
    expect(summarise([older, newer]).map((s) => s.traceId)).toEqual([id(8), id(7)]);
  });
});

describe("--since", () => {
  const NOW = Date.parse("2026-08-12T03:00:00Z");

  test("parses the usual durations", () => {
    expect(parseSince("90s")).toBe(90_000);
    expect(parseSince("30m")).toBe(1_800_000);
    expect(parseSince("2h")).toBe(7_200_000);
    expect(parseSince("7d")).toBe(604_800_000);
    expect(Number.isNaN(parseSince("soon"))).toBe(true);
  });

  test("filters on occurredAt, not recordedAt", () => {
    // The operator is asking when things HAPPENED. The gap between the
    // two fields is the observer's lag - filtering on `recordedAt` would
    // hide exactly the records a backed-up sink is late to write.
    const old = rec({
      recordId: id(1),
      occurredAt: "2026-08-12T01:00:00Z",
      recordedAt: "2026-08-12T02:59:59Z",
    });
    const recent = rec({ recordId: id(2), occurredAt: "2026-08-12T02:59:00Z" });
    expect(since([old, recent], 1_800_000, NOW).map((r) => r.recordId)).toEqual([id(2)]);
  });

  test("an unparseable timestamp is excluded rather than assumed recent", () => {
    const bad = rec({ recordId: id(1), occurredAt: "whenever" });
    expect(since([bad], 3_600_000, NOW)).toEqual([]);
  });
});

describe("redaction is checked at READ time too", () => {
  test("content smuggled into detail is reported", () => {
    // The schema forbids it at write time, but this reader consumes a
    // file on disk that anything with the path could have appended to.
    const r = rec({ recordId: id(1), detail: { content: "the actual message" } as never });
    expect(redactionViolations(r)).toEqual(["detail.content"]);
  });

  test("a credential-shaped key is reported whatever its case", () => {
    const r = rec({ recordId: id(1), detail: { Authorization: "Bearer x" } as never });
    expect(redactionViolations(r)).toEqual(["detail.Authorization"]);
  });

  test("an actor reference carrying anything but kind/ref/label is reported", () => {
    const r = rec({ recordId: id(1), redactedSource: { kind: "user", ref: "1", username: "calvin" } as never });
    expect(redactionViolations(r)).toEqual(["redactedSource.username"]);
  });

  test("a clean record reports nothing", () => {
    const r = rec({
      recordId: id(1),
      detail: { exitCode: 1, attempt: 2 },
      redactedTarget: { kind: "channel", ref: "140", label: "#manager" },
    });
    expect(redactionViolations(r)).toEqual([]);
  });
});

describe("redaction covers every output path (#349)", () => {
  // Codex found this reviewing wave 2: the human renderer withheld
  // forbidden values and `--json` serialised the record whole - so
  // `hg communication trace --json` disclosed exactly what the guard
  // existed to contain. A guard written against one output path is not a
  // guard.

  test("a forbidden detail value is replaced, and its key kept", () => {
    const r = rec({ recordId: id(1), detail: { content: "the actual message", exitCode: 1 } as never });
    const safe = redactForOutput(r);
    expect(safe.detail!["content"]).toBe("[redacted: forbidden by lifecycle-record/v1alpha1]");
    // The key stays: dropping it would hide that something is writing
    // content into a metadata-only record, which is the fact worth
    // surfacing.
    expect(Object.keys(safe.detail!)).toContain("content");
    // Legitimate scalars are untouched.
    expect(safe.detail!["exitCode"]).toBe(1);
  });

  test("a forbidden actor field is replaced, kind and ref survive", () => {
    const r = rec({
      recordId: id(1),
      redactedSource: { kind: "user", ref: "289374650192837465", username: "calvin" } as never,
    });
    const safe = redactForOutput(r);
    expect((safe.redactedSource as never as Record<string, unknown>)["username"]).toBe(
      "[redacted: forbidden by lifecycle-record/v1alpha1]",
    );
    expect(safe.redactedSource!.kind).toBe("user");
    expect(safe.redactedSource!.ref).toBe("289374650192837465");
  });

  test("a clean record is returned unchanged, by identity", () => {
    // Cheap, and it means the common path allocates nothing.
    const r = rec({ recordId: id(1), detail: { exitCode: 0 } });
    expect(redactForOutput(r)).toBe(r);
  });

  test("no forbidden value survives anywhere in the serialised record", () => {
    // The property that actually matters, checked against the whole
    // JSON rather than field by field.
    const r = rec({
      recordId: id(1),
      detail: { content: "SECRET-BODY", authorization: "Bearer SECRET-TOKEN" } as never,
      redactedTarget: { kind: "channel", ref: "140", email: "SECRET-ADDRESS" } as never,
    });
    const serialised = JSON.stringify(redactForOutput(r));
    for (const leaked of ["SECRET-BODY", "SECRET-TOKEN", "SECRET-ADDRESS"]) {
      expect({ leaked, present: serialised.includes(leaked) }).toEqual({ leaked, present: false });
    }
  });
});
