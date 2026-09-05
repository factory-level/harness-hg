// Alert Routing honesty contracts, fixture-tested.
import { describe, expect, test } from "bun:test";
import {
  destinationChips,
  executionOutcome,
  executionSplit,
  fingerprint,
  firingCount,
  ownerBuckets,
  parseCommSub,
  partitionAlerts,
  producerStatus,
  receiptOutcome,
  resolveSwitchboard,
  sourceState,
  switchboardModel,
  type CommunicationDoc,
} from "../src/app/communication/model";
import { DEMO_COMM, DEMO_COMM_HISTORY } from "../src/stores/demo";

describe("alert identity", () => {
  test("fingerprint carries the FULL label set - name+namespace is insufficient", () => {
    const a = { name: "X", labels: { pod: "x-0", ns: "n" }, since: "1m" };
    const b = { name: "X", labels: { pod: "x-1", ns: "n" }, since: "1m" };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe("partitioning", () => {
  test("business renders full; platform collapses; the Watchdog dead-man is in neither", () => {
    const { business, platform } = partitionAlerts(DEMO_COMM.alerts);
    expect(business.map((a) => a.name)).toEqual(["KubePodCrashLooping"]);
    expect(platform.map((a) => a.name)).toEqual(["NodeDiskPressure"]);
  });
  test("truncated counts read N+", () => {
    expect(firingCount({ configured: true, truncated: true, firing: [{ name: "A" }] })).toBe("1+");
    expect(firingCount(DEMO_COMM.alerts)).toBe("2");
  });
});

describe("owner buckets", () => {
  test("three canonical shelves; the slice decides; empty buckets vanish", () => {
    const buckets = ownerBuckets(DEMO_COMM.edges);
    expect(buckets.map((b) => b.id)).toEqual(["control-plane", "bundle:marketing"]);
    expect(buckets[0].items.map((e) => e.id)).toEqual(["e4"]);
  });
});

describe("full-vs-sliced (ADR-110)", () => {
  test("status reads the FULL edge set regardless of the slice", () => {
    // mkt-engage's only edge is degraded; its status must say so even if
    // a hypothetical section sliced it out.
    // Producer keys are the wire's composite form (<profile>@<scope>#<handler>).
    expect(producerStatus(DEMO_COMM, "mkt-engage@voice#published")).toBe("degraded");
  });
  test("no edges at all reads declared, not healthy", () => {
    expect(producerStatus(DEMO_COMM, "ghost")).toBe("declared");
  });
  test("destination chips cap at two with a truthful +N", () => {
    const { shown, more } = destinationChips(DEMO_COMM.edges, 2);
    expect(shown.length).toBe(2);
    expect(more).toBe(2);
  });
});

// ---- The patch-bay switchboard (ADR 0180) ----------------------------

describe("parseCommSub", () => {
  test("a bare sub is a producer subject", () => {
    expect(parseCommSub("mkt-research@feed#topics")).toEqual({ kind: "producer", producer: "mkt-research@feed#topics" });
  });
  test("the in: prefix names an inbound webhook", () => {
    expect(parseCommSub("in:github-webhook")).toEqual({ kind: "inbound", id: "github-webhook" });
  });
  test("producer ids full of / @ # never collide with the prefix", () => {
    expect(parseCommSub("mkt-manager/postiz@queue#approved")).toEqual({ kind: "producer", producer: "mkt-manager/postiz@queue#approved" });
  });
  test("a producer literally named in:* stays reachable when no webhook claims the id", () => {
    const doc: CommunicationDoc = {
      ...DEMO_COMM,
      edges: [...DEMO_COMM.edges, { id: "e9", producer: "in:relay", target: { profile: "mkt-manager" } }],
    };
    const m = resolveSwitchboard(doc, "in:relay")!;
    expect(m.subject).toEqual({ kind: "producer", producer: "in:relay" });
    // ...but a webhook that DOES resolve wins the prefix.
    expect(resolveSwitchboard(DEMO_COMM, "in:github-webhook")!.subject).toEqual({ kind: "inbound", id: "github-webhook" });
  });
});

describe("producer switchboard", () => {
  test("outbound rows follow the full edge set, in served order", () => {
    const m = switchboardModel(DEMO_COMM, { kind: "producer", producer: "mkt-research@feed#topics" })!;
    expect(m.outbound.map((r) => r.id)).toEqual(["e1"]);
    expect(m.inbound).toHaveLength(1);
    expect(m.inbound[0].label).toBe("mkt-research@feed#topics");
  });
  test("a degraded live status surfaces on the row and the spine", () => {
    const m = switchboardModel(DEMO_COMM, { kind: "producer", producer: "mkt-engage@voice#published" })!;
    expect(m.outbound[0].status).toBe("degraded");
    expect(m.outbound[0].level).toBe("degraded");
    expect(m.spine.status).toBe("degraded");
    expect(m.spine.dlq).toBe(2);
  });
  test("an unknown producer resolves to null, never a crash", () => {
    expect(switchboardModel(DEMO_COMM, { kind: "producer", producer: "ghost" })).toBeNull();
  });
});

describe("inbound switchboard", () => {
  test("outbound rows are the edges NAMING this input, not every event-mate", () => {
    const doc: CommunicationDoc = {
      ...DEMO_COMM,
      // A second webhook sharing the event: matching on event alone
      // would claim e5 for it too.
      edges: [...DEMO_COMM.edges, { id: "e6", producer: "gitlab@hooks#push", event: "code.pushed/v1", target: { profile: "mkt-research" } }],
    };
    const m = switchboardModel(doc, { kind: "inbound", id: "github-webhook" })!;
    expect(m.outbound.map((r) => r.id)).toEqual(["e5"]);
    expect(m.outbound[0].label).toBe("mkt-manager");
    expect(m.inbound[0].detail).toContain("hmac-verified");
  });
  test("records predating the externalInput key fall back to event matching, null-guarded", () => {
    const doc: CommunicationDoc = {
      ...DEMO_COMM,
      edges: DEMO_COMM.edges.map((e) => ({ ...e, externalInput: undefined })),
    };
    expect(switchboardModel(doc, { kind: "inbound", id: "github-webhook" })!.outbound.map((r) => r.id)).toEqual(["e5"]);
    // A null input event must never join edges whose event is also absent.
    const nullDoc: CommunicationDoc = {
      ...DEMO_COMM,
      edges: [{ id: "eN", producer: "p" }],
      externalInputs: [{ id: "bare-hook", profile: "mkt-manager" }],
    };
    const m = switchboardModel(nullDoc, { kind: "inbound", id: "bare-hook" })!;
    expect(m.outbound[0].synthetic).toBe(true);
  });
  test("no matching edge yields one synthetic declared row for the bound profile", () => {
    const doc: CommunicationDoc = {
      ...DEMO_COMM,
      externalInputs: [{ id: "lonely-hook", profile: "mkt-manager", event: "no.such.event/v1" }],
    };
    const m = switchboardModel(doc, { kind: "inbound", id: "lonely-hook" })!;
    expect(m.outbound).toHaveLength(1);
    expect(m.outbound[0].synthetic).toBe(true);
    expect(m.outbound[0].status).toBe("declared");
    expect(m.outbound[0].label).toBe("mkt-manager");
  });
  test("an unknown webhook id resolves to null", () => {
    expect(switchboardModel(DEMO_COMM, { kind: "inbound", id: "ghost-hook" })).toBeNull();
  });
});

describe("executionOutcome", () => {
  const exec = DEMO_COMM.latestExecution!;
  test("delivered and failed read from the consumer's status", () => {
    expect(executionOutcome(exec, "e1")).toBe("delivered");
    expect(executionOutcome(exec, "e3")).toBe("failed");
  });
  test("dead-lettered IS failed - the consumer never got the event", () => {
    expect(executionOutcome({ ...exec, consumers: [{ edge: "e9", status: "dead-lettered" }] }, "e9")).toBe("failed");
  });
  test("queued/duplicate/skipped are NEITHER - the router's own outcomeOf contract", () => {
    for (const status of ["queued", "duplicate", "skipped"]) {
      expect(receiptOutcome(status)).toBe("pending");
    }
    expect(receiptOutcome("accepted")).toBe("delivered");
    expect(executionOutcome({ ...exec, consumers: [{ edge: "e9", status: "queued" }] }, "e9")).toBe("pending");
  });
  test("the browser's split recomputes what the served counts flatten", () => {
    const split = executionSplit({
      correlationId: "c",
      consumers: [
        { edge: "a", status: "delivered" },
        { edge: "b", status: "queued" },
        { edge: "c", status: "dead-lettered" },
      ],
      delivered: 2, // the server counted queued as delivered - the lie
      failed: 1,
    });
    expect(split).toEqual({ delivered: 1, failed: 1, pending: 1, total: 3 });
  });
  test("an edge the execution never touched is null; no execution means no spine line", () => {
    expect(executionOutcome(exec, "e4")).toBeNull();
    expect(executionOutcome(undefined, "e1")).toBeNull();
    const bare = switchboardModel({ ...DEMO_COMM, latestExecution: undefined }, { kind: "producer", producer: "mkt-research@feed#topics" })!;
    expect(bare.spine.execution).toBeUndefined();
  });
  test("the spine carries the execution only when it touches the board's edges", () => {
    const research = switchboardModel(DEMO_COMM, { kind: "producer", producer: "mkt-research@feed#topics" })!;
    expect(research.spine.execution?.correlationId).toBe("corr-demo-1");
    const alarm = switchboardModel(DEMO_COMM, { kind: "producer", producer: "alert-router@routes#alarm" })!;
    expect(alarm.spine.execution).toBeUndefined();
  });
});

describe("spine aggregation", () => {
  test("dlq and pending sum over the board's edges", () => {
    const doc: CommunicationDoc = {
      ...DEMO_COMM,
      live: { ...DEMO_COMM.live, e1: { status: "configured", dlqDepth: 1, pending: 4 } },
    };
    const m = switchboardModel(doc, { kind: "producer", producer: "mkt-research@feed#topics" })!;
    expect(m.spine.dlq).toBe(1);
    expect(m.spine.pending).toBe(4);
  });
  test("the worst level follows the SERVED statusOrder, not an alphabet", () => {
    const doc: CommunicationDoc = {
      ...DEMO_COMM,
      // A server that ranks stale above degraded must be believed.
      statusOrder: ["declared", "configured", "degraded", "failed", "stale"],
      edges: [
        { id: "x1", producer: "p", target: { profile: "a" } },
        { id: "x2", producer: "p", target: { profile: "b" } },
      ],
      live: { x1: { status: "stale" }, x2: { status: "failed" } },
    };
    const m = switchboardModel(doc, { kind: "producer", producer: "p" })!;
    expect(m.spine.status).toBe("stale");
  });
});

describe("sourceState", () => {
  test("a bare string passes through (older payloads)", () => {
    expect(sourceState("ok")).toBe("ok");
    expect(sourceState("unavailable")).toBe("unavailable");
  });
  test("an object reads .state - never [object Object]", () => {
    expect(sourceState({ family: "event-router", state: "ok", detail: "ring" })).toBe("ok");
    expect(sourceState({ family: "prometheus" })).toBe("unknown");
  });
  test("undefined defaults to unknown", () => {
    expect(sourceState(undefined)).toBe("unknown");
  });
});

describe("demo fixture shape", () => {
  test("externalInputs wear the SERVER's projection, not the old fiction", () => {
    const w = DEMO_COMM.externalInputs![0];
    expect(w.id).toBe("github-webhook");
    expect(w.profile).toBe("mkt-manager");
    expect(w.event).toBe("code.pushed/v1");
  });
  test("the history fixture is a coherent 24h document", () => {
    expect(DEMO_COMM_HISTORY.window).toBe("24h");
    expect(DEMO_COMM_HISTORY.pulse!.buckets!.length).toBe(24);
    expect(DEMO_COMM_HISTORY.receipts!.entries!.every((r) => r.edge)).toBe(true);
  });
});
