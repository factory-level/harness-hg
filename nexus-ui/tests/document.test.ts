// DocumentStore pure contracts: the undo reducer's exact rules and the
// #423 save-state machine - carried semantics, fixture-tested.
import { describe, expect, test } from "bun:test";
import { sheetIdFor, nextSaveState, undoReduce, type Undoable } from "../src/stores/document";
import { clampCoord, fitTransform, sizeOf, zoomAbout } from "../src/app/workspace/geometry";

const s0: Undoable<number> = { past: [], value: 0, future: [], lastKey: null };

describe("undo reducer", () => {
  test("consecutive sets sharing a coalesceKey are ONE undo step", () => {
    let s = undoReduce(s0, { kind: "set", value: 1, coalesceKey: "move:g1" });
    s = undoReduce(s, { kind: "set", value: 2, coalesceKey: "move:g1" });
    s = undoReduce(s, { kind: "set", value: 3, coalesceKey: "move:g1" });
    expect(s.past).toEqual([0]);
    expect(undoReduce(s, { kind: "undo" }).value).toBe(0);
  });
  test("undo clears lastKey so the next drag never coalesces across it", () => {
    let s = undoReduce(s0, { kind: "set", value: 1, coalesceKey: "k" });
    s = undoReduce(s, { kind: "undo" });
    s = undoReduce(s, { kind: "redo" });
    s = undoReduce(s, { kind: "set", value: 2, coalesceKey: "k" });
    expect(s.past).toEqual([0, 1]); // did NOT coalesce over the undo
  });
  test("adopt clears BOTH stacks - server truth replaces local", () => {
    let s = undoReduce(s0, { kind: "set", value: 1 });
    s = undoReduce(s, { kind: "undo" });
    s = undoReduce(s, { kind: "adopt", value: 9 });
    expect(s).toEqual({ past: [], value: 9, future: [], lastKey: null });
  });
  test("silent updates the value without an undo entry", () => {
    const s = undoReduce(s0, { kind: "silent", value: 5 });
    expect(s.past).toEqual([]);
    expect(s.value).toBe(5);
  });
  test("the stack is bounded at 50", () => {
    let s = s0;
    for (let i = 1; i <= 60; i++) s = undoReduce(s, { kind: "set", value: i });
    expect(s.past.length).toBe(50);
  });
  test("a set clears the redo future", () => {
    let s = undoReduce(s0, { kind: "set", value: 1 });
    s = undoReduce(s, { kind: "undo" });
    s = undoReduce(s, { kind: "set", value: 7 });
    expect(s.future).toEqual([]);
  });
});

describe("save-state machine (#423)", () => {
  test("callers name events, never target states", () => {
    expect(nextSaveState("saved", "edited")).toBe("unsaved");
    expect(nextSaveState("unsaved", "saveStarted")).toBe("saving");
    expect(nextSaveState("saving", "saveSucceeded")).toBe("saved");
    expect(nextSaveState("saving", "saveFailed")).toBe("failed");
    expect(nextSaveState("saving", "conflictSeen")).toBe("conflict");
  });
  test("an edit landing mid-flight is expressible", () => {
    expect(nextSaveState("saving", "edited")).toBe("saving");
  });
});

describe("geometry", () => {
  test("registered footprints resolve; unknown kinds take the plaque", () => {
    expect(sizeOf("agent")).toEqual({ w: 264, h: 204 });
    expect(sizeOf("person")).toEqual({ w: 84, h: 84 });
    expect(sizeOf("whatever")).toEqual({ w: 244, h: 76 });
  });
  test("fit caps zoom at 1.1 - the default state opens calm", () => {
    const t = fitTransform([{ x: 0, y: 0, w: 100, h: 100 }], { w: 2000, h: 2000 }, { left: 0, top: 0, right: 0, bottom: 0 });
    expect(t.zoom).toBe(1.1);
  });
  test("wheel zoom is cursor-anchored: the point under the cursor stays put", () => {
    const t = { x: 0, y: 0, zoom: 1 };
    const next = zoomAbout(t, 1.12, 500, 300);
    const worldX = (500 - t.x) / t.zoom;
    expect(next.x + worldX * next.zoom).toBeCloseTo(500, 6);
  });
  test("coordinates clamp to the backend limit", () => {
    expect(clampCoord(1e9)).toBe(100_000);
    expect(clampCoord(-1e9)).toBe(-100_000);
  });
});

// The wire envelope (the first factory deployment's white-screen): GET
// /nexus/workspace serves {workspace, canWrite, role, ...}, a 409
// carries the doc the same way, and older/foreign shapes must be
// refused rather than adopted into a crash.
describe("sheetIdFor", () => {
  test("slugifies to the server's DNS-label rule", () => {
    expect(sheetIdFor("Q4 Launch Plan!", new Set())).toBe("q4-launch-plan");
    expect(sheetIdFor("  éé  ", new Set())).toBe("sheet"); // unusable slug falls back
  });
  test("dedupes with a numeric suffix", () => {
    expect(sheetIdFor("Ops", new Set(["ops"]))).toBe("ops-2");
    expect(sheetIdFor("Ops", new Set(["ops", "ops-2"]))).toBe("ops-3");
  });
});

describe("unwrapWorkspace", () => {
  const doc = { apiVersion: "nexus.hermes.ai/v1alpha1", kind: "NexusWorkspace", revision: 3, sheets: [{ id: "main", name: "Main", cards: [] }] };

  test("unwraps the served envelope", async () => {
    const { unwrapWorkspace } = await import("../src/stores/document");
    expect(unwrapWorkspace({ workspace: doc, canWrite: true, role: "owner" })?.revision).toBe(3);
  });

  test("accepts a bare doc (the demo/fixture shape)", async () => {
    const { unwrapWorkspace } = await import("../src/stores/document");
    expect(unwrapWorkspace(doc)?.sheets.length).toBe(1);
  });

  test("refuses shapes without a sheets array instead of crashing later", async () => {
    const { unwrapWorkspace } = await import("../src/stores/document");
    expect(unwrapWorkspace({ workspace: { revision: 1 } })).toBeNull();
    expect(unwrapWorkspace(null)).toBeNull();
    expect(unwrapWorkspace({ detail: "not configured" })).toBeNull();
  });
});

describe("httpStatusOf", () => {
  test("the status field is the contract and wins over the message", async () => {
    const { httpStatusOf } = await import("../src/stores/document");
    expect(httpStatusOf(Object.assign(new Error("500 nope"), { status: 409 }))).toBe(409);
  });
  test("anchored message prefix is the bare-Error fallback", async () => {
    const { httpStatusOf } = await import("../src/stores/document");
    expect(httpStatusOf(new Error("409 Conflict: revision moved"))).toBe(409);
    expect(httpStatusOf("Error: 503 Service Unavailable: not configured")).toBe(503);
  });
  test("a status buried mid-detail never impersonates one", async () => {
    const { httpStatusOf } = await import("../src/stores/document");
    expect(httpStatusOf(new Error("500 Internal: revision 409 stale"))).toBe(500);
    expect(httpStatusOf(new Error("workspace exploded"))).toBeNull();
    expect(httpStatusOf(undefined)).toBeNull();
  });
});
