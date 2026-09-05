// Reading lifecycle records back (#349). No `hg communication traces`
// command ships today — `hg communication prove` is this module's only
// caller (the manifest carries `communication prove` alone); the read
// half stays because the prove matrix selects and orders through it.
//
// The records themselves arrive through the passive debug observer's
// existing JSONL sink (`hg debug webhook`, ADR-74). This file is the READ
// half — it selects, orders and renders; it never writes, and nothing it
// does can fail a primary path.
//
// Everything here is pure over an array of parsed lines, so the ordering
// rules and the redaction guard are unit tests rather than something only
// a live fleet exercises.

/** The envelope, as this reader needs it. Mirrors
 * `agent-bundle-contracts/lifecycle-record/v1alpha1/lifecycle-record.schema.json`
 * — the schema is the contract, and `isLifecycleRecord` below is the
 * boundary check that stops a foreign line in a shared sink being read as
 * one of ours. */
export interface LifecycleRecord {
  version: number;
  recordId: string;
  traceId: string;
  correlationId?: string;
  causationId?: string;
  plane: "gateway" | "cron" | "router" | "alert" | "agent" | "tool";
  type: string;
  occurredAt: string;
  recordedAt?: string;
  durationMs?: number;
  outcome?: "success" | "failure" | "refused" | "timeout";
  deploymentRevision?: string;
  profile?: string;
  testRun?: string;
  digest?: string;
  redactedSource?: ActorRef;
  redactedTarget?: ActorRef;
  detail?: Record<string, string | number | boolean>;
}

export interface ActorRef {
  kind: string;
  ref?: string;
  label?: string;
}

const PLANES = new Set(["gateway", "cron", "router", "alert", "agent", "tool"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/** Is this line one of ours?
 *
 * The sink is SHARED — it is the same JSONL the alert observer writes to,
 * and an operator may have pointed other things at it. A reader that
 * assumed every line was a lifecycle record would render nonsense for
 * anything else; one that guessed from a single field would misclassify.
 * So the check is structural and cheap, and anything failing it is
 * skipped rather than reported as corrupt.
 */
export function isLifecycleRecord(value: unknown): value is LifecycleRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r["version"] === 1 &&
    typeof r["recordId"] === "string" &&
    UUID.test(r["recordId"]) &&
    typeof r["traceId"] === "string" &&
    UUID.test(r["traceId"]) &&
    typeof r["plane"] === "string" &&
    PLANES.has(r["plane"]) &&
    typeof r["type"] === "string" &&
    TYPE.test(r["type"]) &&
    typeof r["occurredAt"] === "string"
  );
}

/** Every lifecycle record in a sink dump, foreign lines dropped. */
export function readRecords(lines: { parsed: unknown }[]): LifecycleRecord[] {
  return lines.map((l) => l.parsed).filter(isLifecycleRecord);
}

export interface TraceSummary {
  traceId: string;
  startedAt: string;
  endedAt: string;
  planes: string[];
  records: number;
  /** The most severe outcome seen. A trace with one failure is a failed
   * trace, however many successes it also contains. */
  outcome: "success" | "failure" | "refused" | "timeout" | "open";
  correlationId?: string;
  profile?: string;
  /** Present means a human or harness asked for this run; absent means
   * it happened on its own. #349's exit proof turns on exactly this. */
  testRun?: string;
}

/** Worst-first, because a summary line has room for one verdict and the
 * bad one is the one worth showing. `open` is last: a trace with no
 * terminal record has not failed, it has not finished. */
const OUTCOME_RANK = ["failure", "timeout", "refused", "success"] as const;

export function summarise(records: LifecycleRecord[]): TraceSummary[] {
  const byTrace = new Map<string, LifecycleRecord[]>();
  for (const r of records) {
    const list = byTrace.get(r.traceId);
    if (list) list.push(r);
    else byTrace.set(r.traceId, [r]);
  }

  const out: TraceSummary[] = [];
  for (const [traceId, group] of byTrace) {
    const times = group.map((r) => r.occurredAt).sort();
    const outcomes = group.map((r) => r.outcome).filter(Boolean) as string[];
    const worst = OUTCOME_RANK.find((o) => outcomes.includes(o));
    out.push({
      traceId,
      startedAt: times[0]!,
      endedAt: times[times.length - 1]!,
      planes: [...new Set(group.map((r) => r.plane))].sort(),
      records: group.length,
      outcome: (worst ?? "open") as TraceSummary["outcome"],
      ...(group.find((r) => r.correlationId) ? { correlationId: group.find((r) => r.correlationId)!.correlationId } : {}),
      ...(group.find((r) => r.profile) ? { profile: group.find((r) => r.profile)!.profile } : {}),
      ...(group.find((r) => r.testRun) ? { testRun: group.find((r) => r.testRun)!.testRun } : {}),
    });
  }
  // Newest first: an operator asking "what just happened" wants the last
  // thing, not the first.
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return out;
}

/** Records newer than *sinceMs* milliseconds ago.
 *
 * On `occurredAt`, not `recordedAt`: the operator is asking about when
 * things HAPPENED, and the gap between the two is the observer's lag —
 * filtering on it would hide exactly the records a backed-up sink is late
 * to write.
 */
export function since(records: LifecycleRecord[], sinceMs: number, now: number): LifecycleRecord[] {
  const cutoff = now - sinceMs;
  return records.filter((r) => {
    const t = Date.parse(r.occurredAt);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** Parse `30m`, `2h`, `90s`, `7d` into milliseconds. */
export function parseSince(spec: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(spec.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}

/** One trace, ordered as a CAUSAL tree flattened depth-first.
 *
 * Not by timestamp. Two records emitted in the same millisecond by
 * different planes have no meaningful clock order, and clocks across
 * planes are not synchronised — `causationId` is the only ordering that
 * is actually true. Timestamps break ties among siblings, which is the
 * one place they are reliable.
 *
 * Records whose parent is absent from the trace are treated as roots
 * rather than dropped: a partial trace is normal (the observer may have
 * been enabled mid-flight) and losing records to make the tree tidy would
 * be the worst possible trade in a diagnostic tool.
 */
export function orderTrace(records: LifecycleRecord[]): LifecycleRecord[] {
  const present = new Set(records.map((r) => r.recordId));
  const children = new Map<string, LifecycleRecord[]>();
  const roots: LifecycleRecord[] = [];

  for (const r of records) {
    const parent = r.causationId && present.has(r.causationId) ? r.causationId : null;
    if (parent === null) {
      roots.push(r);
    } else {
      const list = children.get(parent);
      if (list) list.push(r);
      else children.set(parent, [r]);
    }
  }

  const byTime = (a: LifecycleRecord, b: LifecycleRecord) =>
    a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.recordId < b.recordId ? -1 : 1;

  roots.sort(byTime);
  const out: LifecycleRecord[] = [];
  const seen = new Set<string>();

  const walk = (r: LifecycleRecord, depth: number) => {
    // A cycle cannot happen in a well-formed trace, and a diagnostic tool
    // that hangs on malformed input is worse than one that truncates.
    if (seen.has(r.recordId) || depth > 100) return;
    seen.add(r.recordId);
    out.push(r);
    for (const child of (children.get(r.recordId) ?? []).sort(byTime)) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** Depth of each record in the causal tree, for rendering. */
export function depths(ordered: LifecycleRecord[]): Map<string, number> {
  const byId = new Map(ordered.map((r) => [r.recordId, r]));
  const out = new Map<string, number>();
  for (const r of ordered) {
    let depth = 0;
    let cur = r;
    const guard = new Set<string>();
    while (cur.causationId && byId.has(cur.causationId) && !guard.has(cur.recordId)) {
      guard.add(cur.recordId);
      cur = byId.get(cur.causationId)!;
      depth += 1;
      if (depth > 100) break;
    }
    out.set(r.recordId, depth);
  }
  return out;
}

/** Keys a record must never carry, checked at READ time.
 *
 * The schema forbids these at write time, but this reader consumes a file
 * on disk that anything with the path could have appended to. A record
 * carrying content is a redaction failure, and the honest response is to
 * say so rather than print it — printing is what turns a leak into a
 * disclosure. */
const FORBIDDEN_KEYS = ["content", "body", "text", "message", "payload", "token", "authorization"];

export function redactionViolations(record: LifecycleRecord): string[] {
  const found: string[] = [];
  for (const key of Object.keys(record.detail ?? {})) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) found.push(`detail.${key}`);
  }
  for (const [name, ref] of [
    ["redactedSource", record.redactedSource],
    ["redactedTarget", record.redactedTarget],
  ] as const) {
    if (!ref) continue;
    for (const key of Object.keys(ref)) {
      if (!["kind", "ref", "label"].includes(key)) found.push(`${name}.${key}`);
    }
  }
  return found;
}

/** A record with every forbidden field's VALUE replaced.
 *
 * `redactionViolations` reports; this is what makes the report safe to
 * act on. Both output paths go through it, which is the point: the human
 * renderer never printed these values, and `--json` serialised the record
 * whole - so `hg communication trace --json` disclosed exactly what the
 * guard existed to contain. A guard that only covers the output path its
 * author was looking at is not a guard. (Codex, reviewing wave 2.)
 *
 * The KEY is kept and only the value goes. Dropping the field entirely
 * would hide that something is writing content into a metadata-only
 * record, which is the fact worth surfacing.
 */
export function redactForOutput(record: LifecycleRecord): LifecycleRecord {
  const violations = redactionViolations(record);
  if (violations.length === 0) return record;
  const out: LifecycleRecord = { ...record };
  const forbidden = new Set(violations);

  if (record.detail) {
    const detail: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(record.detail)) {
      detail[key] = forbidden.has(`detail.${key}`) ? "[redacted: forbidden by lifecycle-record/v1alpha1]" : value;
    }
    out.detail = detail;
  }
  for (const name of ["redactedSource", "redactedTarget"] as const) {
    const ref = record[name];
    if (!ref) continue;
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ref)) {
      clean[key] = forbidden.has(`${name}.${key}`) ? "[redacted: forbidden by lifecycle-record/v1alpha1]" : value;
    }
    out[name] = clean as unknown as ActorRef;
  }
  return out;
}
