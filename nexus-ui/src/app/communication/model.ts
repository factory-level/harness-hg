// Alert Routing pure model - the honesty contracts as functions.
// Carried: alert identity is the FULL label set + since (name+namespace
// is insufficient - per-pod duplicates); business alerts render full
// rows while platform alerts collapse (#407); owner buckets are three
// canonical shelves and the SECTION's slice decides membership (#564/
// #567); a source row's status reads the FULL edge set while its
// destination chips show the section's slice (ADR-110); the status
// ladder is server-ordered and the browser only aggregates over its own
// grouping (#424).

export interface CommEdge {
  id: string;
  producer: string;
  kind?: string;
  route?: string;
  event?: string;
  delivery?: { mode?: string; deadLetter?: boolean };
  target?: { profile?: string; space?: string; provider?: string; instance?: string };
  /** The server emits a BOOLEAN (an edge routing an alarm class), not a
   * class name - the old string type was a fixture-side fiction. */
  alarmClass?: boolean;
  /** The declared external-input source, when the edge has one (null on
   * the wire otherwise) - the inbound board's join identity. */
  externalInput?: string | null;
  ownership?: string;
  bundle?: string;
  bundleTitle?: string;
}
export interface CommLive {
  status?: string;
  dlqDepth?: number;
  pending?: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}
export interface CommAlerts {
  configured: boolean;
  reachable?: boolean;
  truncated?: boolean;
  unreadable?: boolean;
  firing: CommFiringAlert[];
}
export interface CommFiringAlert {
  name: string;
  namespace?: string;
  severity?: string;
  signal?: string;
  since?: string;
  summary?: string;
  value?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  grafanaUrl?: string;
  ownership?: string;
}
/** The server's projection (`_project_external_input` + edge_owner): the
 * browser learns that a binding exists, what it accepts and how it is
 * verified - never how to call it. */
export interface CommExternalInput {
  id: string;
  profile?: string;
  event?: string;
  verification?: string;
  accepts?: string[];
  ownership?: string;
  bundle?: string;
  bundleTitle?: string;
}
/** A provenance source is a bare state string on older payloads and an
 * object ({family, state, detail}) on current ones. */
export type CommSourceRef = string | { family?: string; state?: string; detail?: string };
/** One consumer's outcome inside a fan-out (`_project_receipt`). */
export interface CommExecutionConsumer {
  edge: string;
  route?: string;
  kind?: string;
  status?: string;
  classification?: string;
  attempt?: number;
  at?: string;
  /** History rows carry the correlation id beside the receipt. */
  correlationId?: string;
}
/** The most recent fan-out, per-consumer and never flattened (#278). */
export interface CommExecution {
  correlationId: string;
  observedAt?: string;
  consumers: CommExecutionConsumer[];
  delivered: number;
  failed: number;
}
export interface CommPulseBucket {
  at?: string;
  delivered: number;
  failed: number;
}
export interface CommHistoryDoc {
  window: "1h" | "24h" | "7d";
  windowSeconds?: number;
  stepSeconds?: number;
  receipts?: { state?: string; truthfulWindow?: string; entries?: CommExecutionConsumer[] };
  pulse?: { state?: string; buckets?: CommPulseBucket[] };
  alertHistory?: { state?: string; entries?: unknown[] };
  provenance?: { observedAt?: string; sources?: Record<string, CommSourceRef> };
}
export interface CommunicationDoc {
  edges: CommEdge[];
  producers?: string[];
  live?: Record<string, CommLive>;
  statusOrder?: string[];
  alerts?: CommAlerts;
  externalInputs?: CommExternalInput[];
  impliedEvents?: { event: string; note?: string }[];
  /** Omitted entirely when the router served no receipts. */
  latestExecution?: CommExecution;
  provenance?: { observedAt?: string; sources?: Record<string, CommSourceRef> };
}

/** The state word behind either provenance shape - "ok" means current. */
export function sourceState(s: CommSourceRef | undefined): string {
  if (s === undefined) return "unknown";
  if (typeof s === "string") return s;
  return s.state ?? "unknown";
}

/** Full-label-set fingerprint - name+namespace is NOT identity. */
export function fingerprint(a: CommFiringAlert): string {
  const labels = Object.entries(a.labels ?? {})
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `${a.name}|${labels}|${a.since ?? ""}`;
}

/** Business alerts render full rows; platform alerts collapse into one
 * expandable summary; the Watchdog dead-man (severity none) is excluded
 * from BOTH (it is certification, not attention). */
export function partitionAlerts(alerts: CommAlerts | undefined): {
  business: CommFiringAlert[];
  platform: CommFiringAlert[];
} {
  const firing = (alerts?.firing ?? []).filter((a) => a.severity !== "none");
  return {
    business: firing.filter((a) => a.signal === "business"),
    platform: firing.filter((a) => a.signal !== "business"),
  };
}

/** Truthful count: "N+" when the server says it truncated. */
export function firingCount(alerts: CommAlerts | undefined): string {
  const n = partitionAlerts(alerts).business.length + partitionAlerts(alerts).platform.length;
  return alerts?.truncated ? `${n}+` : String(n);
}

/** The three canonical shelves; the given slice decides membership; empty
 * buckets vanish. */
export interface OwnerBucket {
  id: string;
  title: string;
  controlPlane: boolean;
  items: CommEdge[];
}
export function ownerBuckets(slice: CommEdge[]): OwnerBucket[] {
  const cp: OwnerBucket = { id: "control-plane", title: "Harness Hg control plane", controlPlane: true, items: [] };
  const byBundle = new Map<string, OwnerBucket>();
  const un: OwnerBucket = { id: "unbundled", title: "Unbundled", controlPlane: false, items: [] };
  for (const e of slice) {
    if (e.ownership === "control-plane") cp.items.push(e);
    else if (e.bundle) {
      let b = byBundle.get(e.bundle);
      if (!b) {
        b = { id: `bundle:${e.bundle}`, title: e.bundleTitle ?? e.bundle, controlPlane: false, items: [] };
        byBundle.set(e.bundle, b);
      }
      b.items.push(e);
    } else un.items.push(e);
  }
  const bundles = [...byBundle.values()].sort((a, b) => a.title.localeCompare(b.title));
  return [cp, ...bundles, un].filter((b) => b.items.length > 0);
}

/** All edges for a producer - the FULL set, never the section's slice:
 * status must not depend on which section renders the row. */
export function fullEdgesOf(doc: CommunicationDoc, producer: string): CommEdge[] {
  return doc.edges.filter((e) => e.producer === producer);
}

export type EdgeStatus = "declared" | "configured" | "stale" | "degraded" | "failed";
/** The browser ranks by the order the document SERVES; this fallback
 * only covers a backend older than the field, and the plugin-API test
 * pins it against the server's EDGE_STATUS_ORDER verbatim. */
const FALLBACK_ORDER: EdgeStatus[] = ["declared", "configured", "stale", "degraded", "failed"];

/** Worst status over the given edges, by the SERVER's order (worst LAST
 * in statusOrder). "declared" (no traffic yet) is its own answer. */
export function producerStatus(doc: CommunicationDoc, producer: string): string {
  const order = doc.statusOrder ?? FALLBACK_ORDER;
  const statuses = fullEdgesOf(doc, producer).map((e) => doc.live?.[e.id]?.status ?? "declared");
  if (statuses.length === 0) return "declared";
  return statuses.reduce((worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst), order[0]);
}

/** Section-scoped destination chips: at most `max`, then "+N". */
export function destinationChips(slice: CommEdge[], max = 2): { shown: string[]; more: number } {
  const dests = [...new Set(slice.map((e) => e.target?.profile ?? e.target?.provider ?? e.target?.space ?? "unrouted"))];
  return { shown: dests.slice(0, max), more: Math.max(0, dests.length - max) };
}

export function producersOf(doc: CommunicationDoc): string[] {
  return [...new Set(doc.edges.map((e) => e.producer))];
}

// ---- The patch-bay switchboard (ADR 0180) ----------------------------
// The drill-down subject is an EVENT: an outbound abstracted event (a
// producer's fan-out) or an inbound unified webhook. Geometry is index
// math on a fixed row height - no runtime measurement - so the cable
// layer stays a pure in-flow SVG.

/** The one geometry constant: row height in px, shared with the CSS via
 * an inline custom property on the board root. */
export const PATCH_ROW_H = 56;

export type SwitchSubject = { kind: "producer"; producer: string } | { kind: "inbound"; id: string };

/** Sub-routes are single-segment (routes.ts reads only parts[1]), so the
 * inbound scheme is a prefix, not a path: `#/communication/in:<id>`.
 * Producer ids contain `/ @ # :` freely - only the `in:` prefix is
 * claimed, and resolveSwitchboard settles a collision: the webhook wins
 * while its id resolves; otherwise the literal producer is tried. */
export function parseCommSub(sub: string): SwitchSubject {
  if (sub.startsWith("in:")) return { kind: "inbound", id: sub.slice(3) };
  return { kind: "producer", producer: sub };
}

/** Sub → board, with the collision fallback: an `in:`-prefixed sub that
 * resolves no webhook is retried as a literal producer name, so a
 * producer that happens to start with `in:` stays reachable. */
export function resolveSwitchboard(doc: CommunicationDoc, sub: string): SwitchboardModel | null {
  const subject = parseCommSub(sub);
  const model = switchboardModel(doc, subject);
  if (model !== null || subject.kind !== "inbound") return model;
  return switchboardModel(doc, { kind: "producer", producer: sub });
}

export type RowLevel = "healthy" | "degraded" | "unhealthy" | "unknown";
/** The one status→level ladder (was duplicated in SourceRow/FanDetail). */
export function statusLevel(status: string): RowLevel {
  if (status === "failed") return "unhealthy";
  if (status === "degraded" || status === "stale") return "degraded";
  if (status === "declared") return "unknown";
  return "healthy";
}

export interface SwitchboardRow {
  id: string;
  label: string;
  detail?: string;
  liveLine?: string;
  status: string;
  level: RowLevel;
  /** True when nothing routes the subject yet - the row states the
   * declared binding, and its cable draws dashed. */
  synthetic?: boolean;
  /** Provider target (leaves the fleet) vs. profile target. */
  external?: boolean;
  outcome?: ExecOutcome | null;
}

export interface SwitchboardSpine {
  status: string;
  level: RowLevel;
  dlq: number;
  pending: number;
  execution?: CommExecution;
}

export interface SwitchboardModel {
  title: string;
  subject: SwitchSubject;
  inbound: SwitchboardRow[];
  outbound: SwitchboardRow[];
  edges: CommEdge[];
  spine: SwitchboardSpine;
}

export type ExecOutcome = "delivered" | "failed" | "pending";

/** One receipt's outcome, mirroring the ROUTER's own outcomeOf contract
 * verbatim: success = accepted|delivered, failure = failed|dead-lettered
 * (the queue kept the body, the consumer still did not get it), and
 * queued/duplicate/skipped are NEITHER - stamping a queued event
 * "delivered" would date the route by its intake, not its outcome. */
export function receiptOutcome(status: string | undefined): ExecOutcome {
  if (status === "accepted" || status === "delivered") return "delivered";
  if (status === "failed" || status === "dead-lettered") return "failed";
  return "pending";
}

/** The last fan-out's outcome for one edge, or null when the execution
 * did not touch it. */
export function executionOutcome(exec: CommExecution | undefined, edgeId: string): ExecOutcome | null {
  const c = exec?.consumers.find((x) => x.edge === edgeId);
  if (!c) return null;
  return receiptOutcome(c.status);
}

/** The browser's own honest split over an execution's consumers. The
 * SERVED delivered/failed counts flatten queued into delivered, so the
 * spine recomputes from the receipts through the same ladder. */
export function executionSplit(exec: CommExecution): { delivered: number; failed: number; pending: number; total: number } {
  const out = { delivered: 0, failed: 0, pending: 0, total: exec.consumers.length };
  for (const c of exec.consumers) out[receiptOutcome(c.status)] += 1;
  return out;
}

function worstStatus(doc: CommunicationDoc, statuses: string[]): string {
  const order = doc.statusOrder ?? FALLBACK_ORDER;
  if (statuses.length === 0) return "declared";
  return statuses.reduce((worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst), order[0]);
}

function edgeRow(doc: CommunicationDoc, e: CommEdge): SwitchboardRow {
  const live = doc.live?.[e.id];
  const status = live?.status ?? "declared";
  const liveBits = [
    live?.dlqDepth ? `dlq ${live.dlqDepth}` : "",
    live?.pending ? `pending ${live.pending}` : "",
    live?.lastSuccessAt ? `delivered ${live.lastSuccessAt}` : live?.lastFailureAt ? `failed ${live.lastFailureAt}` : "no traffic",
  ].filter(Boolean);
  return {
    id: e.id,
    label: e.target?.profile ?? e.target?.provider ?? "unrouted",
    detail: `${e.event ?? e.kind ?? ""} · via ${e.route ?? "direct"}${e.delivery?.deadLetter ? " · replayable" : ""}`,
    liveLine: liveBits.join(" · "),
    status,
    level: statusLevel(status),
    external: !e.target?.profile,
    outcome: executionOutcome(doc.latestExecution, e.id),
  };
}

function spineOf(doc: CommunicationDoc, edges: CommEdge[]): SwitchboardSpine {
  const status = worstStatus(doc, edges.map((e) => doc.live?.[e.id]?.status ?? "declared"));
  const boardIds = new Set(edges.map((e) => e.id));
  const exec = doc.latestExecution;
  const touches = exec?.consumers.some((c) => boardIds.has(c.edge)) ?? false;
  return {
    status,
    level: statusLevel(status),
    dlq: edges.reduce((n, e) => n + (doc.live?.[e.id]?.dlqDepth ?? 0), 0),
    pending: edges.reduce((n, e) => n + (doc.live?.[e.id]?.pending ?? 0), 0),
    execution: touches ? exec : undefined,
  };
}

/** The board for one subject, or null when the subject does not resolve
 * in the served document (a stale link is a state, never a crash). */
export function switchboardModel(doc: CommunicationDoc, subject: SwitchSubject): SwitchboardModel | null {
  if (subject.kind === "producer") {
    const edges = fullEdgesOf(doc, subject.producer);
    if (edges.length === 0) return null;
    const status = producerStatus(doc, subject.producer);
    return {
      title: subject.producer,
      subject,
      inbound: [{
        id: subject.producer,
        label: subject.producer,
        detail: `emitter · ${edges.length} route${edges.length === 1 ? "" : "s"}`,
        status,
        level: statusLevel(status),
      }],
      outbound: edges.map((e) => edgeRow(doc, e)),
      edges,
      spine: spineOf(doc, edges),
    };
  }
  const input = doc.externalInputs?.find((w) => w.id === subject.id);
  if (!input) return null;
  // Join identity first: edges that NAME this input as their source.
  // Only records predating the served externalInput key fall back to
  // event matching (null-guarded - two absent events must never join).
  const named = doc.edges.filter((e) => e.externalInput != null && e.externalInput === input.id);
  const edges = named.length > 0
    ? named
    : doc.edges.filter((e) => input.event != null && e.event === input.event);
  const inStatus = worstStatus(doc, edges.map((e) => doc.live?.[e.id]?.status ?? "declared"));
  const outbound = edges.length > 0
    ? edges.map((e) => edgeRow(doc, e))
    : [{
        id: `declared:${input.id}`,
        label: input.profile ?? "unrouted",
        detail: input.event ? `${input.event} · declared binding` : "declared binding",
        status: "declared",
        level: "unknown" as RowLevel,
        synthetic: true,
      }];
  return {
    title: input.id,
    subject,
    inbound: [{
      id: input.id,
      label: input.id,
      detail: [input.verification ? `${input.verification}-verified` : "unverified", (input.accepts ?? []).join(", ") || "any kind"].join(" · "),
      status: edges.length > 0 ? inStatus : "declared",
      level: edges.length > 0 ? statusLevel(inStatus) : "unknown",
    }],
    outbound,
    edges,
    spine: spineOf(doc, edges),
  };
}
