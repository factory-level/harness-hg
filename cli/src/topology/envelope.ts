// The normalized event envelope and its identities (ADR-39, design 06):
// the ONE module that mints event/correlation/delivery IDs, builds
// envelopes, computes session keys, and signs gateway deliveries. The
// CLI, the event router, and the eval runner all import THIS - no
// reimplementation, so a test path is the production path.
//
// Deliberately runtime-side: unlike compile.ts this module uses the clock
// and randomness. Compile-time code must not import the ID minters.

import * as crypto from "node:crypto";

export interface EventEnvelope {
  specversion: "1.0";
  id: string; // evt_... stable producer event ID
  type: string; // observability.alert/v1
  source: string; // hermes://<profile>/apps/<app> or hermes://external/<binding>
  subject?: string;
  time: string; // ISO-8601
  datacontenttype: "application/json";
  hermes: {
    environment: string;
    producerProfile?: string;
    producerApplication?: string;
    producerOutput?: string;
    externalInput?: string;
    correlationId: string;
    causationId?: string;
    orderingKey?: string;
    schema: string; // event contract version = type
  };
  data: unknown;
}

const rand = () => crypto.randomBytes(13).toString("hex");
export const newEventId = () => `evt_${rand()}`;
export const newCorrelationId = () => `corr_${rand()}`;
export const newDeliveryId = () => `delivery_${rand()}`;

export interface EnvelopeInput {
  type: string;
  source: string;
  data: unknown;
  environment: string;
  subject?: string;
  producerProfile?: string;
  producerApplication?: string;
  producerOutput?: string;
  externalInput?: string;
  orderingKey?: string;
  causationId?: string;
  /** Test seam + replay: pass to keep an existing identity. */
  id?: string;
  correlationId?: string;
  time?: string;
}

export function makeEnvelope(input: EnvelopeInput): EventEnvelope {
  return {
    specversion: "1.0",
    id: input.id ?? newEventId(),
    type: input.type,
    source: input.source,
    subject: input.subject,
    time: input.time ?? new Date().toISOString(),
    datacontenttype: "application/json",
    hermes: {
      environment: input.environment,
      producerProfile: input.producerProfile,
      producerApplication: input.producerApplication,
      producerOutput: input.producerOutput,
      externalInput: input.externalInput,
      correlationId: input.correlationId ?? newCorrelationId(),
      causationId: input.causationId,
      orderingKey: input.orderingKey,
      schema: input.type,
    },
    data: input.data,
  };
}

/** Read a session/ordering key field off an envelope: `subject` or a
 * `data.` dot-path. Returns undefined when the field is absent - callers
 * decide whether that is an error (keyed sessions) or fine (no FIFO). */
export function envelopeField(envelope: EventEnvelope, field: string): string | undefined {
  if (field === "subject") return envelope.subject;
  if (!field.startsWith("data.")) return undefined;
  let node: unknown = envelope.data;
  for (const seg of field.slice(5).split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node === undefined || node === null ? undefined : String(node);
}

/** The session key an agent delivery carries: always namespaced by
 * environment, profile, and route (ADR-13's rule made structural), then
 * the mode's discriminator. */
export function sessionKey(
  envelope: EventEnvelope,
  opts: { environment: string; profile: string; route: string; mode: "per-event" | "keyed" | "route"; key?: string },
): string {
  const base = `${opts.environment}/${opts.profile}/${opts.route}`;
  if (opts.mode === "route") return base;
  if (opts.mode === "keyed") {
    const value = opts.key ? envelopeField(envelope, opts.key) : undefined;
    // A keyed session with a missing key falls back to the event id -
    // isolation errs toward MORE sessions, never toward sharing one.
    return `${base}/${value ?? envelope.id}`;
  }
  return `${base}/${envelope.id}`;
}

// ---------------------------------------------------------------------------
// Gateway delivery signing - the exact scheme the Hermes agent gateway
// verifies today (and the marketing-sre relay implements):
// X-Webhook-Signature-V2 = hex(HMAC-SHA256(secret, "<ts>.<body>")).
// The router delivers TO the gateway with this; it never replaces the
// gateway or its verification.

export function signBody(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signedHeaders(secret: string, body: string, now = Date.now()): Record<string, string> {
  const ts = Math.floor(now / 1000).toString();
  return {
    "content-type": "application/json",
    "x-webhook-timestamp": ts,
    "x-webhook-signature-v2": signBody(secret, ts, body),
  };
}

/** Constant-time verify for the same scheme (the router's external
 * gateway uses it for hmac-sha256 external inputs). */
export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): { ok: true } | { ok: false; reason: "stale" | "mismatch" | "malformed" } {
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed" };
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: "stale" };
  const expected = signBody(secret, timestamp, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
