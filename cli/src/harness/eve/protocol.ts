// The Eve session protocol (ADR-149), pure: the NDJSON stream, the 401
// challenge, the accepted-session envelope, and the turn reducer. Nothing
// here touches a cluster or reads a file, which is why the whole protocol
// is unit-tested offline through an injected `fetch` (cli/tests/eve.test.ts).
//
// The driver that port-forwards to a pod is ./driver.ts; the proof matrix
// is ./prove.ts. See ../index.ts for the harness registry these belong to.


export const EVE_PORT = 3000;
export const EVE_ROUTE_AUTH_USERNAME = "agent";
/** The Workflow SDK's callback route under the prefix every ingress must
 * forward; answers an empty POST with 400 (handler mounted), never 404. */
export const WORKFLOW_FLOW_PATH = "/.well-known/workflow/v1/flow";

export type Fetch = typeof fetch;

// ---------------------------------------------------------------------------
// Protocol (pure)

/** One event of an Eve session stream (NDJSON; the subset hg reads). */
export interface StreamEvent {
  type: string;
  data?: { message?: string; finishReason?: string; code?: string; text?: string } & Record<string, unknown>;
  [k: string]: unknown;
}

/** Parse the NDJSON lines of a stream body. Tolerates a trailing partial
 * line (a disconnect mid-event) by dropping it. */
export function parseStreamLines(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as StreamEvent;
      if (ev && typeof ev.type === "string") events.push(ev);
    } catch {
      /* a partial trailing line */
    }
  }
  return events;
}

export interface TurnOutcome {
  /** The final assistant text: the LAST message.completed whose finishReason
   * is not tool-calls, else the last message.completed at all. */
  text: string;
  /** Whether the turn reached turn.completed / session.waiting without a
   * turn.failed or session.failed. */
  completed: boolean;
  failure?: string;
  eventTypes: string[];
}

/** Reduce a stream to a turn outcome. `message.completed` can fire more
 * than once per turn (interim narration before a tool call) - the terminal
 * reply is the one without a tool-call finishReason. */
export function reduceTurn(events: StreamEvent[]): TurnOutcome {
  let text = "";
  let lastAny = "";
  let completed = false;
  let failure: string | undefined;
  for (const ev of events) {
    if (ev.type === "message.completed") {
      const m = ev.data?.message ?? ev.data?.text ?? "";
      if (typeof m === "string" && m) {
        lastAny = m;
        const fr = ev.data?.finishReason;
        if (fr !== "tool-calls" && fr !== "tool_calls") text = m;
      }
    } else if (ev.type === "turn.completed" || ev.type === "session.waiting") {
      completed = true;
    } else if (ev.type === "turn.failed" || ev.type === "session.failed") {
      const code = ev.data?.code ? `${ev.data.code}: ` : "";
      failure = `${code}${ev.data?.message ?? ev.type}`;
    }
  }
  return {
    text: text || lastAny,
    completed: completed && !failure,
    ...(failure ? { failure } : {}),
    eventTypes: events.map((e) => e.type),
  };
}

function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`${EVE_ROUTE_AUTH_USERNAME}:${password}`, "utf8").toString("base64");
}

/** The events that end a turn on the documented stream vocabulary. */
export const TURN_BOUNDARY = new Set(["turn.completed", "session.waiting", "turn.failed", "session.failed"]);

/** Read an NDJSON stream incrementally and stop at the first turn
 * boundary - the stream stays open for follow-ups, so waiting for EOF
 * would wait for the caller's timeout. */
export async function readUntilBoundary(body: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: StreamEvent[] = [];
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const ev of parseStreamLines(lines.join("\n"))) {
      events.push(ev);
      if (TURN_BOUNDARY.has(ev.type)) done = true;
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* closing */
  }
  return events;
}

/** A small typed client over the documented eve channel routes
 * (docs/channels/eve.mdx), pure over `fetch`, for the proof legs. */
export function sessionApi(base: string, password: string, fetchImpl: Fetch = fetch, signal?: AbortSignal) {
  const auth = { authorization: basicAuth(password) };
  const json = async (r: Response): Promise<{ status: number; body: any }> => {
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { status: r.status, body };
  };
  const post = (path: string, payload?: unknown, anonymous = false) =>
    fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(anonymous ? {} : auth) },
      body: payload === undefined ? "{}" : JSON.stringify(payload),
      signal,
    }).then(json);
  return {
    info: (anonymous = false) => fetchImpl(`${base}/eve/v1/info`, { headers: anonymous ? {} : auth, signal }).then(json),
    create: (payload: unknown, anonymous = false) => post("/eve/v1/session", payload, anonymous),
    followUp: (id: string, payload: unknown, anonymous = false) => post(`/eve/v1/session/${encodeURIComponent(id)}`, payload, anonymous),
    cancel: (id: string, anonymous = false) => post(`/eve/v1/session/${encodeURIComponent(id)}/cancel`, {}, anonymous),
    clear: (id: string) => post(`/eve/v1/session/${encodeURIComponent(id)}/clear`, {}),
    compact: (id: string) => post(`/eve/v1/session/${encodeURIComponent(id)}/compact`, {}),
    reset: (id: string, anonymous = false) => post(`/eve/v1/session/${encodeURIComponent(id)}/reset`, { reason: "hg agent prove" }, anonymous),
    stream: async (id: string, anonymous = false): Promise<{ status: number; events: StreamEvent[] }> => {
      const r = await fetchImpl(`${base}/eve/v1/session/${encodeURIComponent(id)}/stream`, { headers: anonymous ? {} : auth, signal });
      if (!r.ok || !r.body) return { status: r.status, events: [] };
      return { status: r.status, events: await readUntilBoundary(r.body) };
    },
    /** The stream from a recorded index (docs: `?startIndex=<count>` rewinds;
     * every event is recorded before its step completes, so a replay from 0
     * is the whole session). */
    streamFrom: async (id: string, startIndex: number): Promise<{ status: number; events: StreamEvent[] }> => {
      const r = await fetchImpl(`${base}/eve/v1/session/${encodeURIComponent(id)}/stream?startIndex=${startIndex}`, { headers: auth, signal });
      if (!r.ok || !r.body) return { status: r.status, events: [] };
      return { status: r.status, events: await readUntilBoundary(r.body) };
    },
  };
}

/** Start a session with one message and read its stream to the turn
 * boundary. Pure over `fetch`. */
export async function runTurn(
  base: string,
  password: string,
  message: string,
  timeoutMs: number,
  fetchImpl: Fetch = fetch,
): Promise<{ ok: boolean; output: string; error?: string; sessionId?: string }> {
  const headers = { "content-type": "application/json", authorization: basicAuth(password) };
  // One deadline for the whole turn - the create included, so a stalled
  // POST can never hang the caller past timeoutMs.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let sessionId: string | undefined;
  try {
    const create = await fetchImpl(`${base}/eve/v1/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message }),
      signal: ctl.signal,
    });
    const createBody = (await create.text()) || "";
    if (create.status === 401 || create.status === 403) {
      return { ok: false, output: "", error: `route auth rejected the minted credential (${create.status})` };
    }
    let parsed: { ok?: boolean; sessionId?: string; status?: string; error?: string } = {};
    try {
      parsed = JSON.parse(createBody);
    } catch {
      /* fallthrough */
    }
    if (!create.ok || parsed.ok !== true || !parsed.sessionId) {
      return {
        ok: false,
        output: "",
        error: `session create returned ${create.status}: ${createBody.slice(0, 200) || "<empty>"}`,
      };
    }
    sessionId = parsed.sessionId;
    const res = await fetchImpl(`${base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`, {
      headers: { authorization: basicAuth(password) },
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      return { ok: false, output: "", error: `stream returned ${res.status}`, sessionId };
    }
    const events = await readUntilBoundary(res.body);
    const outcome = reduceTurn(events);
    if (!outcome.completed) {
      return {
        ok: false,
        output: outcome.text,
        error: outcome.failure ?? `stream ended without a turn boundary (events: ${outcome.eventTypes.join(",") || "none"})`,
        sessionId,
      };
    }
    return { ok: true, output: outcome.text, sessionId };
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    return {
      ok: false,
      output: "",
      error: aborted ? `no turn boundary within ${timeoutMs}ms` : (e as Error).message,
      sessionId,
    };
  } finally {
    clearTimeout(timer);
  }
}

