// hg event / hg chatops - the communication plane's CLI surface (ADR-39).
// This module is the COMMAND layer only: compilation lives in
// topology/communication.ts, identities in topology/envelope.ts, and both
// are the same code the router and eval runner use - no second engine.
//
// This file's commands are the OFFLINE surface: graph inspection, payload
// validation, message rendering. Commands that need a running router
// (emit, status, queue test, ingress test) arrive with the runtime PRs.

import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { CliError, SINK_LOG, jsonOut, loadState, log, ok, warn } from "../lib.ts";
import type { ValidationFinding } from "../platform/index.ts";
import { loadContracts, schemaErrorLines } from "../topology/contract.ts";
import { loadEnvironment } from "../topology/environment.ts";
import { compile, type TopologyPlan } from "../topology/compile.ts";
import type {
  ChatopsSpaceBinding,
  CommunicationPlan,
  ExternalInputBinding,
  ProducerBinding,
  RouteEdge,
} from "../topology/communication.ts";
import { envelopeField, makeEnvelope, signBody, type EventEnvelope } from "../topology/envelope.ts";

// ---------------------------------------------------------------------------
// Loading

export interface CommContext {
  root: string;
  plan: TopologyPlan;
  comm: CommunicationPlan;
  findings: ValidationFinding[];
}

/** Resolve the repository (explicit --dir, else the onboarded root),
 * compile, and require a communication plane. Compilation errors refuse
 * loudly - an inspection surface must never describe a broken graph as
 * routable. */
export function loadComm(dir?: string, environment?: string): CommContext {
  const root = path.resolve(dir ?? loadState().profileDir);
  if (!fs.existsSync(root)) throw new CliError(`no such directory ${root}`);
  const loaded = loadContracts(root);
  const env = loadEnvironment(root, environment);
  const plan = compile(loaded.contracts, env.environment, {
    priorFindings: [...loaded.findings, ...env.findings],
  });
  if (!plan.communication) {
    throw new CliError(
      `${root} declares no communication plane - no apps[].outputs[] or communication block in any contract ` +
        "(contract v3, see agent-bundle-contracts/hermes-gitops-extension/v1alpha3)",
    );
  }
  return { root, plan, comm: plan.communication, findings: plan.findings };
}

/** Match an event reference with or without its version suffix:
 * `observability.alert` matches `observability.alert/v1`. */
export function eventMatches(declared: string, ref: string): boolean {
  return declared === ref || declared.startsWith(`${ref}/`);
}

function requireEvent(ctx: CommContext, ref: string): {
  event: string;
  producers: ProducerBinding[];
  externalInputs: ExternalInputBinding[];
  edges: RouteEdge[];
} {
  const producers = ctx.comm.producers.filter((p) => eventMatches(p.event, ref));
  const externalInputs = ctx.comm.externalInputs.filter((x) => eventMatches(x.event, ref));
  if (producers.length === 0 && externalInputs.length === 0) {
    const known = [
      ...new Set([...ctx.comm.producers.map((p) => p.event), ...ctx.comm.externalInputs.map((x) => x.event)]),
    ].sort();
    throw new CliError(`unknown event ${JSON.stringify(ref)} (declared: ${known.join(", ") || "none"})`);
  }
  const event = producers[0]?.event ?? externalInputs[0]!.event;
  const sources = new Set([...producers.map((p) => p.id), ...externalInputs.map((x) => x.id)]);
  const edges = ctx.comm.edges.filter(
    (e) =>
      (e.from.producer && sources.has(e.from.producer)) ||
      (e.from.externalInput && sources.has(e.from.externalInput)),
  );
  return { event, producers, externalInputs, edges };
}

// ---------------------------------------------------------------------------
// Logical ChatOps message - the provider-neutral shape every plugin
// renders from (spec: routes never carry provider-specific payloads).

export interface LogicalMessage {
  title: string;
  summary: string;
  severity: "info" | "warning" | "critical";
  status?: string;
  facts: Record<string, string>;
  links: { label: string; url: string }[];
  /** Legacy role metadata; Slack delivery does not activate mentions. */
  mention?: { roleId: string };
}

export function renderLogicalMessage(envelope: EventEnvelope): LogicalMessage {
  const data = (envelope.data ?? {}) as Record<string, unknown>;
  const firstAlert = Array.isArray(data["alerts"]) ? (data["alerts"][0] as Record<string, unknown>) : undefined;
  const labels = (firstAlert?.["labels"] ?? {}) as Record<string, unknown>;
  const annotations = (firstAlert?.["annotations"] ?? {}) as Record<string, unknown>;
  const rawSeverity = String(data["severity"] ?? labels["severity"] ?? "info");
  const severity: LogicalMessage["severity"] =
    rawSeverity === "critical" ? "critical" : rawSeverity === "warning" ? "warning" : "info";
  const status = data["status"] !== undefined ? String(data["status"]) : undefined;
  const facts: Record<string, string> = {
    event: envelope.type,
    environment: envelope.hermes.environment,
  };
  if (envelope.subject) facts["subject"] = envelope.subject;
  if (envelope.hermes.producerProfile) facts["profile"] = envelope.hermes.producerProfile;
  return {
    title: String(data["title"] ?? annotations["summary"] ?? envelope.type),
    summary: String(data["summary"] ?? data["message"] ?? annotations["description"] ?? "(no summary)"),
    severity,
    status,
    facts,
    links: [],
  };
}

// ---------------------------------------------------------------------------
// Slack bot-token delivery. Credentials never enter receipts or error messages.
export interface SlackDeliveryReceipt {
  status: "delivered" | "failed";
  classification?: string;
  providerMessageId?: string;
  httpStatus?: number;
}

export function renderSlackMessage(msg: LogicalMessage): Record<string, unknown> {
  const plain = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = [plain(msg.title), `Severity: ${plain(msg.severity)}`, plain(msg.summary),
    ...(msg.status ? [`Status: ${plain(msg.status)}`] : []),
    ...Object.entries(msg.facts).map(([key, value]) => `${plain(key)}: ${plain(value)}`)].filter(Boolean).join("\n").slice(0, 10000);
  return { text, mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false };
}

export async function slackDeliver(token: string, channelId: string, message: LogicalMessage): Promise<SlackDeliveryReceipt> {
  try {
    const api = process.env["HG_SLACK_API_BASE"] ?? "https://slack.com/api";
    const response = await fetch(`${api}/chat.postMessage`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: channelId, ...renderSlackMessage(message) }), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; ts?: string; error?: string };
    if (response.ok && body.ok === true && typeof body.ts === "string" && body.ts) {
      return { status: "delivered", providerMessageId: body.ts, httpStatus: response.status };
    }
    const classification = response.status === 429 || body.error === "ratelimited" ? "rate-limited"
      : response.status === 401 || response.status === 403 || ["invalid_auth", "token_revoked", "account_inactive"].includes(body.error ?? "") ? "credential-rejected"
      : ["channel_not_found", "not_in_channel", "is_archived"].includes(body.error ?? "") ? "unknown-channel"
      : response.status >= 500 ? "provider-5xx" : "provider-rejected";
    return { status: "failed", classification, httpStatus: response.status };
  } catch { return { status: "failed", classification: "unreachable" }; }
}

// Payload -> envelope (offline preview; the router does the same live)

export function envelopeForPayload(
  source: { profile: string; app?: string; output?: string; externalInput?: string; event: string; subject?: string },
  payload: unknown,
  environment = "local",
): EventEnvelope {
  const probe = makeEnvelope({
    type: source.event,
    source: "probe",
    data: payload,
    environment,
  });
  const subject = source.subject ? envelopeField(probe, `data.${source.subject}`) : undefined;
  return makeEnvelope({
    type: source.event,
    source: source.app
      ? `hermes://${source.profile}/apps/${source.app}`
      : `hermes://external/${source.profile}/${source.externalInput}`,
    data: payload,
    environment,
    subject,
    producerProfile: source.app ? source.profile : undefined,
    producerApplication: source.app,
    producerOutput: source.output,
    externalInput: source.externalInput,
    orderingKey: subject,
  });
}

function readPayload(payloadPath: string | undefined, root: string): unknown {
  if (!payloadPath) throw new CliError("--payload <file.json> is required");
  const abs = path.isAbsolute(payloadPath)
    ? payloadPath
    : fs.existsSync(path.resolve(payloadPath))
      ? path.resolve(payloadPath)
      : path.join(root, payloadPath);
  if (!fs.existsSync(abs)) throw new CliError(`payload not found: ${payloadPath}`);
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new CliError(`payload ${payloadPath} is not valid JSON: ${(e as Error).message}`);
  }
}

function validateAgainstEventSchema(
  root: string,
  schemaPath: string | undefined,
  payload: unknown,
): { valid: boolean; errors: string[]; schema?: string } {
  if (!schemaPath) return { valid: true, errors: [] };
  const abs = path.join(root, schemaPath);
  if (!fs.existsSync(abs)) {
    return { valid: false, errors: [`declared event schema ${schemaPath} does not exist in the repository`], schema: schemaPath };
  }
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(abs, "utf8")));
  if (validate(payload)) return { valid: true, errors: [], schema: schemaPath };
  return { valid: false, errors: schemaErrorLines(schemaPath, validate.errors), schema: schemaPath };
}

// ---------------------------------------------------------------------------
// Presentation helpers

function edgeSummary(e: RouteEdge): Record<string, unknown> {
  return {
    id: e.id,
    route: e.route,
    kind: e.kind,
    ...(e.agent
      ? {
          agent: {
            profile: e.agent.profile,
            handler: e.agent.handler,
            instance: e.agent.instance,
            url: e.agent.url,
            session: e.agent.session,
          },
        }
      : {}),
    ...(e.chatops ? { chatops: e.chatops } : {}),
    delivery: e.delivery,
    ...(e.filter ? { filter: e.filter } : {}),
  };
}

function printEdge(e: RouteEdge): void {
  const dest = e.agent
    ? `agent ${e.agent.profile}#${e.agent.handler} (${e.agent.instance}, session ${e.agent.session.mode}${e.agent.session.key ? `:${e.agent.session.key}` : ""})`
    : `chatops ${e.chatops!.space} (${e.chatops!.provider})`;
  const fifo = e.delivery.ordering ? `, fifo:${e.delivery.ordering.key}/${e.delivery.ordering.onFailure}` : "";
  console.log(`    -> ${dest} [${e.delivery.mode}${fifo}]`);
}

// ---------------------------------------------------------------------------
// The running router (hg up's port-forward) - the runtime command surface.

function routerBase(): string {
  const state = loadState();
  const port = state.ports?.router;
  if (!port) {
    throw new CliError(
      "the event router is not running - `hg up` first (the onboarded repo must declare a communication plane)",
    );
  }
  return `http://127.0.0.1:${port}`;
}

export async function routerFetch(pathname: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const base = routerBase();
  let resp: Response | undefined;
  // A kubectl port-forward drops connections transiently around pod
  // rolls (it keeps serving a Terminating pod through its grace period,
  // then errors until re-established) - retry briefly before declaring
  // the router unreachable, so a single blip never fails a long poll.
  for (let attempt = 1; attempt <= 4 && !resp; attempt++) {
    try {
      resp = await fetch(`${base}${pathname}`, init);
    } catch {
      if (attempt === 4) {
        throw new CliError(`event router unreachable at ${base} - is the port-forward alive? (hg up respawns it)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  const text = await resp!.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: resp!.status, body };
}

export interface DeliveryReceipt {
  deliveryId: string;
  kind: string;
  status: string;
  edge: string;
  eventId?: string;
  classification?: string;
  sessionKey?: string;
  orderingKey?: string;
  space?: string;
  transport?: string;
  time?: string;
}

const TERMINAL = new Set(["accepted", "delivered", "failed", "dead-lettered", "duplicate", "skipped"]);

/** Poll the router until every named delivery reaches a terminal state
 * (or the deadline). Returns the latest receipt per delivery id. */
export async function waitForDeliveries(ids: string[], timeoutMs: number): Promise<Map<string, DeliveryReceipt>> {
  const found = new Map<string, DeliveryReceipt>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await routerFetch("/v1/status");
    const receipts = ((body as { receipts?: DeliveryReceipt[] }).receipts ?? []);
    for (const r of receipts) {
      if (ids.includes(r.deliveryId) && TERMINAL.has(r.status)) found.set(r.deliveryId, r);
    }
    if (ids.every((id) => found.has(id))) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return found;
}

// ---------------------------------------------------------------------------
// Queue conformance - one implementation for `hg event queue test` and
// `hg communication prove`. Two interleaved ordering groups: same-key
// FIFO must hold while the second key proves independent progress.

export interface QueueConformanceResult {
  ok: boolean;
  orderingKeys: string[];
  emitted: number;
  deliveries: number;
  settled: number;
  dlq: number;
  failures: string[];
}

export async function runQueueConformance(
  producer: ProducerBinding,
  keyBase: string,
  count: number,
  template: Record<string, unknown> = {},
): Promise<QueueConformanceResult> {
  if (!producer.subject) {
    throw new CliError(`producer ${producer.name} declares no subject dot-path - FIFO by subject cannot be exercised`);
  }
  const emissions: { key: string; seq: number; eventId: string; deliveryIds: string[] }[] = [];
  const keys = [keyBase, `${keyBase}-alt`];
  for (let seq = 0; seq < count; seq++) {
    for (const k of keys) {
      const payload = structuredClone(template);
      const segs = producer.subject.split(".");
      let cursor = payload as Record<string, unknown>;
      for (const seg of segs.slice(0, -1)) cursor = (cursor[seg] ??= {}) as Record<string, unknown>;
      cursor[segs[segs.length - 1]!] = k;
      (payload as Record<string, unknown>)["hgQueueTest"] = { key: k, seq };
      const { status, body } = await routerFetch(producer.ingestPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (status !== 202) throw new CliError(`queue test: router refused emission ${seq} (${status})`);
      const doc = body as { eventId: string; deliveries: DeliveryReceipt[] };
      emissions.push({ key: k, seq, eventId: doc.eventId, deliveryIds: doc.deliveries.map((d) => d.deliveryId) });
    }
  }

  const allIds = emissions.flatMap((e) => e.deliveryIds);
  const terminal = await waitForDeliveries(allIds, 180_000);
  const failures: string[] = [];
  for (const id of allIds) {
    const r = terminal.get(id);
    if (!r) failures.push(`delivery ${id} never reached a terminal state`);
    else if (r.status !== "accepted" && r.status !== "delivered") {
      failures.push(`delivery ${id}: ${r.status}${r.classification ? ` (${r.classification})` : ""}`);
    } else if (r.transport !== "queued") {
      failures.push(`delivery ${id} rode ${r.transport}, not the durable transport`);
    }
  }
  // Same-key FIFO: the receipts ring appends in completion order -
  // compare the eventId subsequences per key on the agent edge.
  const { body: statusBody } = await routerFetch("/v1/status");
  const ring = ((statusBody as { receipts?: DeliveryReceipt[] }).receipts ?? []);
  for (const k of keys) {
    const wanted = new Set(emissions.filter((e) => e.key === k).map((e) => e.eventId));
    const expected = emissions.filter((e) => e.key === k).map((e) => e.eventId);
    const actual = ring
      .filter((r) => r.kind === "agent" && r.status === "accepted" && r.eventId && wanted.has(r.eventId))
      .map((r) => r.eventId!)
      .filter((id, i, all) => all.indexOf(id) === i);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`ordering violated for key ${k}: expected ${expected.join(",")} got ${actual.join(",")}`);
    }
  }
  const { body: dlqBody } = await routerFetch("/v1/dlq");
  const dlq = ((dlqBody as { entries?: unknown[] }).entries ?? []).length;
  if (dlq > 0) failures.push(`${dlq} entry(ies) in the DLQ after a clean run`);
  return {
    ok: failures.length === 0,
    orderingKeys: keys,
    emitted: emissions.length,
    deliveries: allIds.length,
    settled: [...terminal.values()].length,
    dlq,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Typed eval invocation (evals v1alpha2): the runner calls THIS - the
// same producer resolution, schema gate, signing, router, and receipt
// machinery as hg event publish / ingress test. No parallel engine.

export interface EvalInvokeSpec {
  event?: { name: string; from?: string; payload: string; toAgent?: string; toChatops?: string };
  events?: { name: string; from?: string; orderingKey?: string; payloads: string[] };
  externalWebhook?: { binding: string; payload: string; signature?: string; duplicate?: boolean };
}

export interface EvalInvocationResult {
  ok: boolean;
  kind: "event" | "events" | "externalWebhook";
  error?: string;
  eventIds: string[];
  correlationIds: string[];
  deliveryIds: string[];
  /** Terminal receipts for every delivery (or the enqueue receipt when
   * one never settled - status queued then). */
  receipts: DeliveryReceipt[];
  /** The router's raw acceptance/rejection responses, in order. */
  responses: unknown[];
  /** For externalWebhook: the gateway's rejection reason, if rejected. */
  rejectedReason?: string;
}

function readScenarioPayload(scenarioDir: string, root: string, rel: string): unknown {
  const inScenario = path.join(scenarioDir, rel);
  const file = fs.existsSync(inScenario) ? inScenario : path.join(root, rel);
  if (!fs.existsSync(file)) throw new CliError(`invoke payload not found: ${rel}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export async function invokeForEval(
  spec: EvalInvokeSpec,
  opts: { dir?: string; environment?: string; scenarioDir: string },
): Promise<EvalInvocationResult> {
  const ctx = loadComm(opts.dir, opts.environment);
  const base: Omit<EvalInvocationResult, "kind" | "ok"> = {
    eventIds: [],
    correlationIds: [],
    deliveryIds: [],
    receipts: [],
    responses: [],
  };
  const resolveProducer = (name: string, from?: string): ProducerBinding => {
    const { producers } = requireEvent(ctx, name);
    const producer = from ? producers.find((p) => p.name === from || p.id === from) : producers.length === 1 ? producers[0] : undefined;
    if (!producer) {
      throw new CliError(
        from
          ? `invoke: from ${from} matches no producer of ${name}`
          : `invoke: event ${name} needs from: (producers: ${producers.map((p) => p.name).join(", ") || "none"})`,
      );
    }
    return producer;
  };
  const emitOnce = async (
    producer: ProducerBinding,
    payload: unknown,
    narrowing: { toAgent?: string; toChatops?: string } = {},
  ): Promise<{ ok: boolean; error?: string }> => {
    const schemaResult = validateAgainstEventSchema(ctx.root, producer.schema, payload);
    if (!schemaResult.valid) return { ok: false, error: `payload rejected by ${producer.schema}: ${schemaResult.errors[0]}` };
    const qs = new URLSearchParams();
    if (narrowing.toAgent) qs.set("toAgent", narrowing.toAgent);
    if (narrowing.toChatops) qs.set("toChatops", narrowing.toChatops);
    const { status, body } = await routerFetch(`${producer.ingestPath}${qs.size ? `?${qs}` : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    base.responses.push(body);
    if (status !== 202) return { ok: false, error: `router refused (${status})` };
    const doc = body as { eventId: string; correlationId: string; deliveries: DeliveryReceipt[] };
    base.eventIds.push(doc.eventId);
    base.correlationIds.push(doc.correlationId);
    base.deliveryIds.push(...doc.deliveries.map((d) => d.deliveryId));
    base.receipts.push(...doc.deliveries);
    return { ok: true };
  };
  const settle = async (): Promise<void> => {
    const pending = base.receipts.filter((r) => r.status === "queued").map((r) => r.deliveryId);
    if (pending.length === 0) return;
    const terminal = await waitForDeliveries(base.deliveryIds, 180_000);
    base.receipts = base.receipts.map((r) => terminal.get(r.deliveryId) ?? r);
  };

  if (spec.event) {
    const producer = resolveProducer(spec.event.name, spec.event.from);
    const payload = readScenarioPayload(opts.scenarioDir, ctx.root, spec.event.payload);
    const r = await emitOnce(producer, payload, { toAgent: spec.event.toAgent, toChatops: spec.event.toChatops });
    if (!r.ok) return { ...base, kind: "event", ok: false, error: r.error };
    await settle();
    const bad = base.receipts.filter((x) => !["accepted", "delivered", "skipped"].includes(x.status));
    return { ...base, kind: "event", ok: bad.length === 0, ...(bad.length ? { error: `${bad.length} delivery(ies) not clean` } : {}) };
  }

  if (spec.events) {
    const producer = resolveProducer(spec.events.name, spec.events.from);
    for (const rel of spec.events.payloads) {
      const payload = readScenarioPayload(opts.scenarioDir, ctx.root, rel) as Record<string, unknown>;
      if (spec.events.orderingKey && producer.subject) {
        const segs = producer.subject.split(".");
        let cursor = payload;
        for (const seg of segs.slice(0, -1)) cursor = (cursor[seg] ??= {}) as Record<string, unknown>;
        cursor[segs[segs.length - 1]!] = spec.events.orderingKey;
      }
      const r = await emitOnce(producer, payload);
      if (!r.ok) return { ...base, kind: "events", ok: false, error: r.error };
    }
    await settle();
    const bad = base.receipts.filter((x) => !["accepted", "delivered", "skipped"].includes(x.status));
    return { ...base, kind: "events", ok: bad.length === 0, ...(bad.length ? { error: `${bad.length} delivery(ies) not clean` } : {}) };
  }

  if (spec.externalWebhook) {
    const w = spec.externalWebhook;
    const input = ctx.comm.externalInputs.find((x) => x.name === w.binding || x.id === w.binding);
    if (!input) return { ...base, kind: "externalWebhook", ok: false, error: `unknown binding ${w.binding}` };
    const secret = loadState().commExtSecrets?.[input.id];
    if (!secret) return { ...base, kind: "externalWebhook", ok: false, error: `no local binding secret for ${input.id} (hg up provisions it)` };
    const payload = readScenarioPayload(opts.scenarioDir, ctx.root, w.payload);
    const raw = JSON.stringify(payload);
    const mode = w.signature ?? "valid";
    const headers = ((): Record<string, string> => {
      const ts = String(mode === "stale" ? Math.floor(Date.now() / 1000) - 3600 : Math.floor(Date.now() / 1000));
      if (mode === "missing") return { "content-type": "application/json" };
      return {
        "content-type": "application/json",
        "x-webhook-timestamp": ts,
        "x-webhook-signature-v2": signBody(mode === "invalid" ? `${secret}-wrong` : secret, ts, raw),
      };
    })();
    const first = await routerFetch(input.hookPath, { method: "POST", headers, body: raw });
    base.responses.push(first.body);
    const doc = first.body as { reason?: string; eventId?: string; correlationId?: string; deliveries?: DeliveryReceipt[] };
    if (first.status !== 202) {
      // A rejection is a RESULT, not an infrastructure error - the
      // scenario's expect.rejected judges it.
      return { ...base, kind: "externalWebhook", ok: true, rejectedReason: doc.reason };
    }
    base.eventIds.push(doc.eventId!);
    base.correlationIds.push(doc.correlationId!);
    base.deliveryIds.push(...(doc.deliveries ?? []).map((d) => d.deliveryId));
    base.receipts.push(...(doc.deliveries ?? []));
    if (w.duplicate) {
      const replay = await routerFetch(input.hookPath, { method: "POST", headers, body: raw });
      base.responses.push(replay.body);
      const rd = replay.body as { reason?: string };
      if (replay.status !== 409 || rd.reason !== "replay") {
        return { ...base, kind: "externalWebhook", ok: false, error: `duplicate not rejected as replay (${replay.status})` };
      }
    }
    await settle();
    const bad = base.receipts.filter((x) => !["accepted", "delivered", "skipped"].includes(x.status));
    return { ...base, kind: "externalWebhook", ok: bad.length === 0, ...(bad.length ? { error: `${bad.length} delivery(ies) not clean` } : {}) };
  }

  return { ...base, kind: "event", ok: false, error: "invoke: no form given" };
}

/** Runner-checked destination expectations against terminal receipts. */
export function checkExpectations(
  result: EvalInvocationResult,
  expect: { outputs?: ({ agent?: { profile: string } } | { chatops?: string })[]; rejected?: { reason: string } },
): string[] {
  const failures: string[] = [];
  if (expect.rejected) {
    if (result.rejectedReason !== expect.rejected.reason) {
      failures.push(
        `expected rejection ${expect.rejected.reason}, got ${result.rejectedReason ?? "acceptance"}`,
      );
    }
    if (result.receipts.length > 0) failures.push("a rejected request must deliver nothing");
    return failures;
  }
  if (result.rejectedReason) {
    failures.push(`request rejected (${result.rejectedReason}) but the scenario expected deliveries`);
    return failures;
  }
  for (const out of expect.outputs ?? []) {
    if ("agent" in out && out.agent) {
      const hit = result.receipts.some(
        (r) => r.kind === "agent" && r.status === "accepted" && r.edge.includes(`:agent:${out.agent!.profile}`),
      );
      if (!hit) failures.push(`no accepted agent delivery to ${out.agent.profile}`);
    } else if ("chatops" in out && out.chatops) {
      const hit = result.receipts.some((r) => r.space === out.chatops && r.status === "delivered");
      if (!hit) failures.push(`no delivered chatops message to ${out.chatops}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// hg event

export async function cmdEvent(
  json: boolean,
  args: string[],
  opts: {
    dir?: string;
    environment?: string;
    payload?: string;
    from?: string;
    toAgent?: string;
    toChatops?: string;
    correlation?: string;
    delivery?: string;
    orderingKey?: string;
    count?: number;
    signature?: string;
    duplicate?: boolean;
  },
): Promise<void> {
  const [sub, ...restArgs] = args;
  switch (sub) {
    case "list": {
      const ctx = loadComm(opts.dir, opts.environment);
      const events = [
        ...new Set([...ctx.comm.producers.map((p) => p.event), ...ctx.comm.externalInputs.map((x) => x.event)]),
      ]
        .sort()
        .map((event) => {
          const { producers, externalInputs, edges } = requireEvent(ctx, event);
          return {
            event,
            producers: producers.map((p) => p.name),
            externalInputs: externalInputs.map((x) => x.id),
            routes: [...new Set(edges.map((e) => e.route))].sort(),
            outputs: edges.length,
          };
        });
      if (json) jsonOut({ command: "event-list", ok: ctx.plan.ok, events, findings: ctx.findings });
      else {
        for (const e of events) {
          console.log(`${e.event}`);
          for (const p of e.producers) console.log(`  produced by ${p}`);
          for (const x of e.externalInputs) console.log(`  external input ${x}`);
          console.log(`  routes: ${e.routes.join(", ") || "none"} (${e.outputs} output edge(s))`);
        }
        if (!ctx.plan.ok) throw new CliError("event list: the communication graph has errors (see topology plan)");
      }
      return;
    }
    case "inspect":
    case "plan": {
      const ref = restArgs[0];
      if (!ref) throw new CliError(`event ${sub} requires an event name`);
      const ctx = loadComm(opts.dir, opts.environment);
      const { event, producers, externalInputs, edges } = requireEvent(ctx, ref);
      const payload = {
        command: `event-${sub}`,
        ok: ctx.plan.ok,
        event,
        durableProvider: ctx.comm.durableProvider?.plugin,
        producers: producers.map((p) => ({
          name: p.name,
          instance: p.appInstance,
          scope: p.scope,
          ingestUrl: p.ingestUrl,
          ...(p.schema ? { schema: p.schema } : {}),
          ...(p.subject ? { subject: p.subject } : {}),
          inject: p.inject,
          routes: p.routes,
        })),
        externalInputs: externalInputs.map((x) => ({
          id: x.id,
          hookPath: x.hookPath,
          verification: { type: x.verification.type, secretRef: x.verification.secretRef },
          routes: x.routes,
        })),
        edges: edges.map(edgeSummary),
        chatopsSpaces: ctx.comm.chatopsSpaces
          .filter((s) => edges.some((e) => e.chatops?.space === s.id))
          .map((s) => ({ space: s.id, provider: s.provider })),
        findings: ctx.findings,
      };
      if (json) jsonOut(payload);
      else {
        console.log(`${event}${ctx.comm.durableProvider ? `  (durable: ${ctx.comm.durableProvider.plugin})` : ""}`);
        for (const p of payload.producers) {
          console.log(`  producer ${p.name} @ ${p.scope}`);
          console.log(`    ingest ${p.ingestUrl}`);
          if (p.inject) console.log(`    injected at ${p.inject.app}.${p.inject.path}`);
        }
        for (const x of payload.externalInputs) {
          console.log(`  external ${x.id} -> ${x.hookPath} (${x.verification.type})`);
        }
        for (const e of edges) printEdge(e);
        if (!ctx.plan.ok) {
          for (const f of ctx.findings.filter((x) => x.severity === "error")) {
            console.log(`  ERROR ${f.check}: ${f.message}`);
          }
          throw new CliError(`event ${sub}: the communication graph has errors`);
        }
      }
      return;
    }
    case "payload": {
      const [verb, ref] = restArgs;
      if (verb !== "validate" || !ref) throw new CliError("usage: hg event payload validate <event> --payload <file>");
      const ctx = loadComm(opts.dir, opts.environment);
      const { event, producers, externalInputs } = requireEvent(ctx, ref);
      const source = producers[0] ?? externalInputs[0]!;
      const payload = readPayload(opts.payload, ctx.root);
      const result = validateAgainstEventSchema(ctx.root, source.schema, payload);
      const subject = source.subject
        ? envelopeField(makeEnvelope({ type: event, source: "probe", data: payload, environment: "local" }), `data.${source.subject}`)
        : undefined;
      if (json) {
        jsonOut({ command: "event-payload-validate", ok: result.valid, event, schema: result.schema, subject, errors: result.errors });
      } else if (result.valid) {
        ok(`payload validates against ${event}${result.schema ? ` (${result.schema})` : " (no schema declared)"}${subject ? `; subject: ${subject}` : ""}`);
      } else {
        for (const line of result.errors) console.log(`  ${line}`);
      }
      if (!result.valid) throw new CliError(`payload does not validate against ${event}`);
      return;
    }
    case "publish": {
      const ref = restArgs[0];
      if (!ref) throw new CliError("event publish requires an event name");
      const ctx = loadComm(opts.dir, opts.environment);
      const { event, producers } = requireEvent(ctx, ref);
      let producer: ProducerBinding | undefined;
      if (opts.from) {
        producer = producers.find((p) => p.name === opts.from || p.id === opts.from);
        if (!producer) {
          throw new CliError(
            `--from ${opts.from} matches no producer of ${event} (declared: ${producers.map((p) => p.name).join(", ")})`,
          );
        }
      } else if (producers.length === 1) {
        producer = producers[0];
      } else {
        throw new CliError(
          `event ${event} has ${producers.length} producer instance(s) - name one with --from ` +
            `(${producers.map((p) => p.name).join(", ") || "none: external inputs use `hg event ingress test`"})`,
        );
      }
      // The reserved broadcast is a connectivity test - a default payload
      // means `hg event publish agents.all` works bare; any other event
      // still requires an explicit payload.
      const body =
        !opts.payload && event === "agents.all/v1"
          ? { test: true, event: "agents.all/v1", source: "hg event publish" }
          : readPayload(opts.payload, ctx.root);
      // The test path IS the production path: same schema gate the
      // publisher applies, then the real router, publisher URL, and
      // delivery machinery - no in-memory shortcut.
      const schemaResult = validateAgainstEventSchema(ctx.root, producer!.schema, body);
      if (!schemaResult.valid) {
        for (const line of schemaResult.errors) console.log(`  ${line}`);
        throw new CliError(`payload does not validate against ${event} - not emitted`);
      }
      const qs = new URLSearchParams();
      if (opts.toAgent) qs.set("toAgent", opts.toAgent);
      if (opts.toChatops) qs.set("toChatops", opts.toChatops);
      const { status, body: receipt } = await routerFetch(
        `${producer!.ingestPath}${qs.size ? `?${qs}` : ""}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      const doc = receipt as {
        status?: string;
        eventId?: string;
        correlationId?: string;
        deliveries?: { deliveryId: string; kind: string; status: string; edge: string; classification?: string; sessionKey?: string; space?: string }[];
      };
      // Queued deliveries are accepted durably first and delivered by the
      // worker - wait for every delivery to reach a terminal state so the
      // command reports the OUTCOME, not the enqueue.
      if (status === 202 && (doc.deliveries ?? []).some((d) => d.status === "queued")) {
        const terminal = await waitForDeliveries(
          (doc.deliveries ?? []).map((d) => d.deliveryId),
          120_000,
        );
        doc.deliveries = (doc.deliveries ?? []).map((d) => terminal.get(d.deliveryId) ?? d);
      }
      const failed = (doc.deliveries ?? []).filter((d) => d.status === "failed" || d.status === "dead-lettered" || d.status === "queued");
      const okAll = status === 202 && failed.length === 0;
      if (json) {
        jsonOut({ command: "event-emit", ok: okAll, event, producer: producer!.name, httpStatus: status, ...((typeof receipt === "object" && receipt) || {}) });
      } else {
        console.log(`event ${doc.eventId}  correlation ${doc.correlationId}`);
        for (const d of doc.deliveries ?? []) {
          const dest = d.kind === "agent" ? `agent${d.sessionKey ? ` session=${d.sessionKey}` : ""}` : `chatops ${d.space}`;
          console.log(`  ${d.status.padEnd(9)} ${d.deliveryId}  ${dest}${d.classification ? `  (${d.classification})` : ""}`);
        }
        if (okAll) ok(`emitted through ${producer!.name}: ${(doc.deliveries ?? []).length} delivery(ies)`);
      }
      if (!okAll) {
        throw new CliError(
          `event emit: ${status !== 202 ? `router refused (${status})` : `${failed.length} delivery(ies) failed`}`,
        );
      }
      return;
    }
    case "status": {
      const qs = new URLSearchParams();
      if (opts.correlation) qs.set("correlation", opts.correlation);
      if (opts.delivery) qs.set("delivery", opts.delivery);
      const { status, body } = await routerFetch(`/v1/status${qs.size ? `?${qs}` : ""}`);
      if (status !== 200) throw new CliError(`event status: router returned ${status}`);
      if (json) jsonOut({ command: "event-status", ok: true, ...((typeof body === "object" && body) || {}) });
      else console.log(JSON.stringify(body, null, 2));
      return;
    }
    case "queue": {
      const [verb, ref] = restArgs;
      if (verb !== "test" || !ref) throw new CliError("usage: hg event queue test <event> --ordering-key <k> --count <n>");
      const ctx = loadComm(opts.dir, opts.environment);
      const { event, producers } = requireEvent(ctx, ref);
      const producer = opts.from
        ? producers.find((p) => p.name === opts.from)
        : producers.length === 1
          ? producers[0]
          : undefined;
      if (!producer) throw new CliError(`name a producer with --from (${producers.map((p) => p.name).join(", ")})`);
      const template = opts.payload ? (readPayload(opts.payload, ctx.root) as Record<string, unknown>) : {};
      const result = await runQueueConformance(producer, opts.orderingKey ?? "queue-test", opts.count ?? 3, template);
      const report = { command: "event-queue-test", event, producer: producer.name, ...result };
      if (json) jsonOut(report);
      else {
        for (const f of result.failures) console.log(`  FAIL ${f}`);
        if (result.ok) {
          ok(
            `queue test: ${result.emitted} event(s) over ${result.orderingKeys.length} ordering keys - ` +
              "durably accepted, same-key FIFO held, DLQ empty",
          );
        }
      }
      if (!result.ok) throw new CliError(`event queue test: ${result.failures.length} failure(s)`);
      return;
    }
    case "ingress": {
      const [verb, name] = restArgs;
      if (verb !== "test" || !name) {
        throw new CliError(
          "usage: hg event ingress test <binding> --payload <file> [--signature valid|invalid|missing|stale] [--duplicate]",
        );
      }
      const ctx = loadComm(opts.dir, opts.environment);
      const input = ctx.comm.externalInputs.find((x) => x.name === name || x.id === name);
      if (!input) {
        const known = ctx.comm.externalInputs.map((x) => x.name).join(", ") || "none";
        throw new CliError(`unknown external input ${JSON.stringify(name)} (declared: ${known})`);
      }
      const body = readPayload(opts.payload, ctx.root);
      const schemaResult = validateAgainstEventSchema(ctx.root, input.schema, body);
      if (!schemaResult.valid && (opts.signature ?? "valid") === "valid") {
        for (const line of schemaResult.errors) console.log(`  ${line}`);
        throw new CliError(`payload does not validate against ${input.event} - fix it or test a negative mode`);
      }
      const secret = loadState().commExtSecrets?.[input.id];
      if (!secret) {
        throw new CliError(`no local binding secret for ${input.id} - hg up provisions it`);
      }
      const raw = JSON.stringify(body);
      const mode = opts.signature ?? "valid";
      const sign = (signSecret: string, tsOverride?: number): Record<string, string> => {
        const ts = String(tsOverride ?? Math.floor(Date.now() / 1000));
        return {
          "content-type": "application/json",
          "x-webhook-timestamp": ts,
          "x-webhook-signature-v2": signBody(signSecret, ts, raw),
        };
      };
      let headers: Record<string, string>;
      let expect: { status: number; reason?: string };
      switch (mode) {
        case "valid":
          headers = sign(secret);
          expect = { status: 202 };
          break;
        case "invalid":
          headers = sign(`${secret}-wrong`);
          expect = { status: 401, reason: "invalid-signature" };
          break;
        case "missing":
          headers = { "content-type": "application/json" };
          expect = { status: 401, reason: "missing-signature" };
          break;
        case "stale":
          headers = sign(secret, Math.floor(Date.now() / 1000) - 3600);
          expect = { status: 401, reason: "stale-signature" };
          break;
        default:
          throw new CliError(`--signature must be valid|invalid|missing|stale, got ${JSON.stringify(mode)}`);
      }
      const first = await routerFetch(input.hookPath, { method: "POST", headers, body: raw });
      const firstDoc = first.body as {
        status?: string;
        reason?: string;
        eventId?: string;
        correlationId?: string;
        ignoredSelectors?: string[];
        deliveries?: DeliveryReceipt[];
      };
      const checks: { check: string; ok: boolean; detail?: string }[] = [];
      checks.push({
        check: `signature-${mode}`,
        ok: first.status === expect.status && (!expect.reason || firstDoc.reason === expect.reason),
        detail: `router: ${first.status} ${firstDoc.reason ?? firstDoc.status ?? ""}`,
      });
      if (mode === "valid" && first.status === 202) {
        if ((firstDoc.deliveries ?? []).some((d) => d.status === "queued")) {
          const terminal = await waitForDeliveries((firstDoc.deliveries ?? []).map((d) => d.deliveryId), 120_000);
          firstDoc.deliveries = (firstDoc.deliveries ?? []).map((d) => terminal.get(d.deliveryId) ?? d);
        }
        const bad = (firstDoc.deliveries ?? []).filter((d) => !["accepted", "delivered", "skipped"].includes(d.status));
        checks.push({
          check: "deliveries-settled",
          ok: bad.length === 0,
          detail: (firstDoc.deliveries ?? []).map((x) => `${x.kind}:${x.status}`).join(", "),
        });
        if (firstDoc.ignoredSelectors?.length) {
          checks.push({
            check: "payload-selectors-ignored",
            ok: true,
            detail: `router ignored ${firstDoc.ignoredSelectors.join(", ")} - routing is compiled IaC only`,
          });
        }
        if (opts.duplicate) {
          const replayed = await routerFetch(input.hookPath, { method: "POST", headers, body: raw });
          const replayDoc = replayed.body as { reason?: string };
          checks.push({
            check: "replay-rejected",
            ok: replayed.status === 409 && replayDoc.reason === "replay",
            detail: `router: ${replayed.status} ${replayDoc.reason ?? ""}`,
          });
        }
      }
      const okAll = checks.every((c) => c.ok);
      if (json) {
        jsonOut({ command: "event-ingress-test", ok: okAll, binding: input.id, mode, checks, response: firstDoc });
      } else {
        for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.check}${c.detail ? `  (${c.detail})` : ""}`);
        if (okAll) ok(`ingress ${mode}: ${checks.length} check(s) passed`);
      }
      if (!okAll) throw new CliError("event ingress test: checks failed");
      return;
    }
    // ---- #350's required interface, first-class ----------------------
    // `routes`, `test`, `trace`, `dead-letters`, `replay` are the verbs
    // the exit proof names. routes/trace are new views; test/dead-letters/
    // replay are the existing machinery under the required names.
    case "routes": {
      const ctx = loadComm(opts.dir, opts.environment);
      const byRoute = new Map<string, typeof ctx.comm.edges>();
      for (const e of ctx.comm.edges) {
        const list = byRoute.get(e.route) ?? [];
        list.push(e);
        byRoute.set(e.route, list);
      }
      const routes = [...byRoute.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([route, edges]) => ({
        route,
        event: edges[0]!.event,
        // Fan-out stays INDEPENDENT per target - one route to N targets
        // is N edges with N delivery records, never an aggregate (#350).
        targets: edges.map((e) => ({
          edge: e.id,
          kind: e.kind,
          ...(e.agent ? { profile: e.agent.profile, session: e.agent.session.mode } : {}),
          ...(e.chatops ? { space: e.chatops.space } : {}),
          delivery: e.delivery.mode,
          ...(e.delivery.retry ? { retryMaxAttempts: e.delivery.retry.maxAttempts } : {}),
          deadLetter: e.delivery.deadLetter?.enabled === true,
          ...(e.delivery.ordering ? { ordering: e.delivery.ordering.mode } : {}),
        })),
      }));
      if (json) jsonOut({ command: "event-routes", ok: ctx.plan.ok, routes, findings: ctx.findings });
      else {
        for (const r of routes) {
          console.log(`${r.route}  (${r.event})`);
          for (const t of r.targets) {
            const who = t.kind === "agent" ? `agent ${t.profile} (session ${t.session})` : `chatops ${t.space}`;
            console.log(
              `  -> ${who}  ${t.delivery}${t.retryMaxAttempts ? ` retry<=${t.retryMaxAttempts}` : ""}${t.deadLetter ? " dead-letter" : ""}${t.ordering ? ` ${t.ordering}` : ""}`,
            );
          }
        }
        if (!ctx.plan.ok) throw new CliError("event routes: the communication graph has errors (see topology plan)");
      }
      return;
    }
    case "trace": {
      const eventId = restArgs[0];
      if (!eventId) throw new CliError("usage: hg event trace <event-id> [--json]");
      // The router mirrors event.received/rejected + every receipt as
      // delivery.<status> (+ delivery.retrying) to the sink, each
      // carrying the envelope's eventId. This selects that event's whole
      // story - fan-out, retries, dead-lettering, replay - in arrival
      // order (one process wrote them, so its order is meaningful here,
      // unlike the cross-plane lifecycle trace which orders by causation).
      const lines = unwrappedSinkRecords()
        .map((l) => l.parsed as Record<string, unknown> | undefined)
        .filter((p): p is Record<string, unknown> => !!p && p["eventId"] === eventId);
      if (json) {
        jsonOut({ command: "event-trace", eventId, records: lines });
        return;
      }
      if (lines.length === 0) {
        log(`no sink records for event ${eventId} - is the debug observer enabled and the router emitting to it?`);
        return;
      }
      for (const r of lines) {
        const bits = [
          String(r["ts"] ?? ""),
          String(r["kind"] ?? "?"),
          r["edge"] ? `edge=${r["edge"]}` : "",
          r["deliveryId"] ? `delivery=${r["deliveryId"]}` : "",
          r["status"] ? `status=${r["status"]}` : "",
          r["attempt"] !== undefined ? `attempt=${r["attempt"]}` : "",
          r["classification"] ? `(${r["classification"]})` : "",
        ].filter(Boolean);
        console.log(`  ${bits.join("  ")}`);
      }
      return;
    }
    case "test": {
      // hg event test <binding> == the signed deterministic ingress test.
      return cmdEvent(json, ["ingress", "test", ...restArgs], opts);
    }
    case "dead-letters": {
      return cmdEvent(json, ["dlq"], opts);
    }
    case "replay": {
      const id = restArgs[0];
      if (!id) throw new CliError("usage: hg event replay <delivery-id> [--json]");
      return cmdEvent(json, ["dlq", "replay", id], opts);
    }
    case "dlq": {
      const [verb, id] = restArgs;
      if (verb === "replay") {
        const { status, body } = await routerFetch("/v1/dlq/replay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(id ? { deliveryId: id } : {}),
        });
        const doc = body as { status?: string; replayed?: number };
        if (json) jsonOut({ command: "event-dlq-replay", ok: status === 200, ...doc });
        else if (status === 200) ok(`replayed ${doc.replayed} DLQ entry(ies)`);
        if (status !== 200) throw new CliError(`dlq replay: ${doc.status ?? status}`);
        return;
      }
      const { body } = await routerFetch("/v1/dlq");
      if (json) jsonOut({ command: "event-dlq", ok: true, ...((typeof body === "object" && body) || {}) });
      else console.log(JSON.stringify(body, null, 2));
      return;
    }
    default:
      throw new CliError(
        "unknown event subcommand (routes|test|trace|dead-letters|replay|list|inspect|plan|payload validate|publish|status|queue test|ingress test|dlq)",
      );
  }
}

// ---------------------------------------------------------------------------
// hg chatops

function requireSpace(ctx: CommContext, ref: string): ChatopsSpaceBinding {
  const space = ctx.comm.chatopsSpaces.find((s) => s.id === ref);
  if (!space) {
    const known = ctx.comm.chatopsSpaces.map((s) => s.id).sort();
    throw new CliError(`unknown ChatOps space ${JSON.stringify(ref)} (registered: ${known.join(", ") || "none"})`);
  }
  return space;
}

/** Every line in the observer's sink, parsed where possible.
 *
 * Tolerant on purpose: the sink is SHARED (the alert observer writes here
 * too) and append-only, so a malformed or foreign line is normal rather
 * than corruption. `readRecords` does the "is this ours" filtering; this
 * only has to get lines out of the file without throwing. */
function sinkLines(): { parsed: unknown }[] {
  if (!fs.existsSync(SINK_LOG)) return [];
  return fs
    .readFileSync(SINK_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return { parsed: JSON.parse(line) as unknown };
      } catch {
        return { parsed: undefined };
      }
    });
}

/** The sink WRAPS every POST as {ts, method, path, body} (webhook-sink.py)
 * - the record itself lives under `body`. Readers that matched fields at
 * the top level therefore matched nothing on real sink data (Codex
 * catch, and transitively a latent wave-2 bug in the traces reader).
 * This unwraps observer-shaped entries to their body and passes anything
 * else through; the structural filters downstream stay the authority on
 * "is this ours". */
export function unwrapSinkEntry(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const p = parsed as Record<string, unknown>;
  if (typeof p["path"] === "string" && "body" in p && "ts" in p) return p["body"];
  return parsed;
}

export function unwrappedSinkRecords(): { parsed: unknown }[] {
  return sinkLines().map((l) => ({ parsed: unwrapSinkEntry(l.parsed) }));
}

/** Parse the recording sink's JSONL for one space's captured messages -
 * the local, deterministic proof that routing happened. */
export function recordedMessages(space: string): { ts: string; body: Record<string, unknown> }[] {
  const hash = space.indexOf("#");
  const wanted = `/chatops/${encodeURIComponent(space.slice(0, hash))}/${encodeURIComponent(space.slice(hash + 1))}`;
  if (!fs.existsSync(SINK_LOG)) return [];
  return fs
    .readFileSync(SINK_LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { ts: string; path: string; body: Record<string, unknown> })
    .filter((entry) => entry.path === wanted)
    .map(({ ts, body }) => ({ ts, body }));
}

export async function cmdChatops(
  json: boolean,
  args: string[],
  opts: { dir?: string; environment?: string; payload?: string; event?: string },
): Promise<void> {
  const [sub, ...restArgs] = args;
  switch (sub) {
    case "list": {
      const ctx = loadComm(opts.dir, opts.environment);
      const spaces = ctx.comm.chatopsSpaces.map((s) => ({
        space: s.id,
        provider: s.provider,
        // The credential REFERENCE (a Secret name or env var name) is
        // safe to show; the value has no representation anywhere.
        credentialRef: s.credentialRef,
        routes: s.routes,
      }));
      if (json) jsonOut({ command: "chatops-list", ok: ctx.plan.ok, spaces, findings: ctx.findings });
      else {
        for (const s of spaces) {
          console.log(`${s.space}  (${s.provider})  routes: ${s.routes.join(", ")}`);
        }
        if (spaces.length === 0) console.log("no ChatOps spaces referenced by any route");
      }
      return;
    }
    case "plan": {
      const ref = restArgs[0];
      if (!ref) throw new CliError("chatops plan requires a space (<alias>#<destination>)");
      const ctx = loadComm(opts.dir, opts.environment);
      const space = requireSpace(ctx, ref);
      const edges = ctx.comm.edges.filter((e) => e.chatops?.space === space.id);
      const payload = {
        command: "chatops-plan",
        ok: ctx.plan.ok,
        space: space.id,
        provider: space.provider,
        credentialRef: space.credentialRef,
        routes: space.routes,
        edges: edges.map(edgeSummary),
        findings: ctx.findings,
      };
      if (json) jsonOut(payload);
      else {
        console.log(`${space.id}  provider: ${space.provider}`);
        for (const e of edges) printEdge(e);
      }
      return;
    }
    case "render": {
      const ref = restArgs[0];
      if (!ref) throw new CliError("chatops render requires a space (<alias>#<destination>)");
      if (!opts.event) throw new CliError("chatops render requires --event <event>");
      const ctx = loadComm(opts.dir, opts.environment);
      // Rendering must work for ANY registered alias, and also for an
      // unregistered destination on a KNOWN alias (the sandbox channel id
      // is not in any route) - resolve the alias, not the space.
      const hash = ref.indexOf("#");
      if (hash <= 0) throw new CliError(`not a space address: ${ref} (expected <alias>#<destination>)`);
      const alias = ref.slice(0, hash);
      const known = ctx.comm.chatopsSpaces.find((s) => s.alias === alias);
      if (!known) throw new CliError(`unknown ChatOps alias ${JSON.stringify(alias)}`);
      const { event, producers, externalInputs } = requireEvent(ctx, opts.event);
      const source = producers[0] ?? externalInputs[0]!;
      const body = readPayload(opts.payload, ctx.root);
      const schemaResult = validateAgainstEventSchema(ctx.root, source.schema, body);
      if (!schemaResult.valid) {
        for (const line of schemaResult.errors) console.log(`  ${line}`);
        throw new CliError(`payload does not validate against ${event} - refusing to render`);
      }
      const producer = producers[0];
      const envelope = producer
        ? envelopeForPayload(
            { profile: producer.profile, app: producer.app, output: producer.output, event, subject: producer.subject },
            body,
          )
        : envelopeForPayload(
            { profile: externalInputs[0]!.profile, externalInput: externalInputs[0]!.name, event, subject: externalInputs[0]!.subject },
            body,
          );
      const logical = renderLogicalMessage(envelope);
      const preview = known.provider === "slack" ? renderSlackMessage(logical) : logical;
      if (json) {
        jsonOut({ command: "chatops-render", ok: true, space: ref, provider: known.provider, logical, preview });
      } else {
        console.log(JSON.stringify({ space: ref, provider: known.provider, logical, preview }, null, 2));
        ok("rendered (nothing was sent)");
      }
      return;
    }
    case "tail": {
      const ref = restArgs[0];
      if (!ref) throw new CliError("chatops tail requires a space (<alias>#<destination>)");
      const ctx = loadComm(opts.dir, opts.environment);
      requireSpace(ctx, ref);
      const messages = recordedMessages(ref);
      if (json) jsonOut({ command: "chatops-tail", ok: true, space: ref, count: messages.length, messages });
      else {
        for (const m of messages) {
          const msg = (m.body["message"] ?? {}) as Record<string, unknown>;
          const evt = (m.body["event"] ?? {}) as Record<string, unknown>;
          console.log(`${m.ts}  [${msg["severity"] ?? "?"}] ${msg["title"] ?? "(untitled)"}  event=${evt["id"] ?? "?"} corr=${evt["correlationId"] ?? "?"}`);
        }
        ok(`${messages.length} recorded message(s) for ${ref} (${SINK_LOG})`);
      }
      return;
    }
    case "test": {
      const ref = restArgs[0];
      if (!ref) throw new CliError("chatops test requires a space (<alias>#<destination>)");
      // The configured environment binding decides the provider: the
      // recording default flows through the RUNNING router (test path =
      // production path); a Slack binding with an operator-host env
      // credential delivers live from here and records Slack acceptance.
      const ctx = loadComm(opts.dir, opts.environment);
      const hash = ref.indexOf("#");
      if (hash <= 0) throw new CliError(`not a space address: ${ref} (expected <alias>#<destination>)`);
      const alias = ref.slice(0, hash);
      const destination = ref.slice(hash + 1);
      const envConnection = ctx.comm.chatopsSpaces.find((s) => s.alias === alias);
      if (!envConnection) throw new CliError(`unknown ChatOps alias ${JSON.stringify(alias)}`);
      const payload = opts.payload ? readPayload(opts.payload, ctx.root) : undefined;

      if (envConnection.provider === "slack") {
        const envVar = envConnection.credentialRef?.env;
        if (!envVar) {
          throw new CliError(
            `alias ${alias} binds slack through a cluster Secret - hg chatops test needs an env-form credentialRef (the sandbox environment)`,
          );
        }
        const token = process.env[envVar];
        // Fail closed, and never echo anything credential-shaped.
        if (!token) throw new CliError(`slack credential env var ${envVar} is not set - export it and retry`);
        let message: LogicalMessage;
        if (opts.event && payload !== undefined) {
          const { event, producers, externalInputs } = requireEvent(ctx, opts.event);
          const source = producers[0] ?? externalInputs[0]!;
          const producer = producers[0];
          const envelope = producer
            ? envelopeForPayload(
                { profile: producer.profile, app: producer.app, output: producer.output, event, subject: producer.subject },
                payload,
              )
            : envelopeForPayload(
                { profile: externalInputs[0]!.profile, externalInput: externalInputs[0]!.name, event, subject: externalInputs[0]!.subject },
                payload,
              );
          message = renderLogicalMessage(envelope);
        } else {
          message = {
            title: "hg chatops test",
            summary: `test message to ${ref}`,
            severity: "info",
            facts: { event: "hermes.chatops.test/v1", environment: "local" },
            links: [],
          };
        }
        const receipt = await slackDeliver(token, destination, message);
        const result = { command: "chatops-test", ok: receipt.status === "delivered", space: ref, provider: "slack", ...receipt };
        if (json) jsonOut(result);
        else if (receipt.status === "delivered") {
          ok(
            `delivered to ${ref} via slack (provider message ${receipt.providerMessageId}` +
              ")",
          );
        }
        if (receipt.status !== "delivered") {
          throw new CliError(`chatops test: slack delivery failed (${receipt.classification})`);
        }
        return;
      }

      const { status, body } = await routerFetch("/v1/test/chatops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ space: ref, event: opts.event, payload }),
      });
      const doc = body as { status?: string; deliveryId?: string; providerMessageId?: string; provider?: string; classification?: string };
      const okDelivered = status === 200 && doc.status === "delivered";
      if (json) jsonOut({ command: "chatops-test", ok: okDelivered, space: ref, httpStatus: status, ...((typeof body === "object" && body) || {}) });
      else if (okDelivered) {
        ok(`delivered to ${ref} via ${doc.provider} (delivery ${doc.deliveryId}, provider message ${doc.providerMessageId})`);
      }
      if (!okDelivered) {
        throw new CliError(`chatops test: delivery failed (${doc.classification ?? `router ${status}`})`);
      }
      return;
    }
    default:
      throw new CliError("unknown chatops subcommand (list|plan|render|inspect|test)");
  }
}
