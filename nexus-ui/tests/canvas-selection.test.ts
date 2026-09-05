// The selection grammar's pure contracts (carried semantics).
import { describe, expect, test } from "bun:test";
import { baseOf, cardKey, deleteMembers, marqueeHits, memberPress, moveMembers, selectAll } from "../src/app/workspace/selection";
import type { WorkspaceSheet } from "../src/stores/document";

const sheet: WorkspaceSheet = {
  id: "s",
  name: "S",
  cards: [
    { ref: "a", key: "a#1", x: 0, y: 0 },
    { ref: "a", key: "a#2", x: 500, y: 0 },
    { ref: "b", x: 0, y: 500 },
  ],
};
const kindOf = () => "agent";

describe("the Miro press grammar", () => {
  test("shift toggles and never drags", () => {
    const r = memberPress(new Set(["card:a#1"]), "card:a#2", true);
    expect([...r.selection].sort()).toEqual(["card:a#1", "card:a#2"]);
    expect(r.drag).toBe(false);
  });
  test("pressing a selected member keeps the set and drags it all", () => {
    const sel = new Set(["card:a#1", "card:a#2"]);
    const r = memberPress(sel, "card:a#1", false);
    expect(r.selection).toBe(sel);
    expect(r.drag).toBe(true);
  });
  test("pressing an unselected member selects just it", () => {
    const r = memberPress(new Set(["card:a#1"]), "card:b", false);
    expect([...r.selection]).toEqual(["card:b"]);
    expect(r.drag).toBe(true);
  });
});

describe("instance identity (#546)", () => {
  test("two placements of the same ref select independently", () => {
    expect(cardKey(sheet.cards[0])).not.toBe(cardKey(sheet.cards[1]));
  });
  test("a legacy id-less card keys by its ref (byte-identical round-trips)", () => {
    expect(cardKey(sheet.cards[2])).toBe("card:b");
  });
});

describe("gestures over the document", () => {
  test("moveMembers applies ONE delta from captured bases and clamps", () => {
    const base = baseOf(sheet, new Set(["card:a#1", "card:b"]));
    const moved = moveMembers(sheet, base, 10, 20);
    expect(moved.cards[0]).toMatchObject({ x: 10, y: 20 });
    expect(moved.cards[1]).toMatchObject({ x: 500, y: 0 }); // unselected untouched
    const far = moveMembers(sheet, base, 1e9, 0);
    expect(far.cards[0].x).toBe(100_000);
  });
  test("delete is a reference removal of exactly the selection", () => {
    const next = deleteMembers(sheet, new Set(["card:a#2"]));
    expect(next.cards.map(cardKey)).toEqual(["card:a#1", "card:b"]);
  });
  test("marquee hits approximate footprints; select-all covers every member", () => {
    const hits = marqueeHits(sheet, kindOf, { x0: -10, y0: -10, x1: 50, y1: 50 });
    expect([...hits]).toEqual(["card:a#1"]);
    expect(selectAll(sheet).size).toBe(3);
  });
});

describe("marquee over every kind", () => {
  const rich2: WorkspaceSheet = {
    ...sheet,
    notes: [{ id: "n1", x: 1000, y: 0, text: "" }],
    shapes: [{ id: "sh1", x: 0, y: 1000, w: 220, h: 140 }],
    texts: [{ id: "t1", x: 1000, y: 1000, text: "x" }],
  };
  test("notes, shapes and texts are marquee-selectable, not just cards", () => {
    const all = marqueeHits(rich2, kindOf, { x0: -1, y0: -1, x1: 1300, y1: 1300 });
    expect(all.has("note:n1")).toBe(true);
    expect(all.has("shape:sh1")).toBe(true);
    expect(all.has("text:t1")).toBe(true);
    expect(all.has("card:a#1")).toBe(true);
  });
  test("a rect clear of a member's footprint misses it", () => {
    const hits = marqueeHits(rich2, kindOf, { x0: 990, y0: -1, x1: 1300, y1: 200 });
    expect(hits.has("note:n1")).toBe(true); // note footprint 180x110 at (1000,0)
    expect(hits.has("shape:sh1")).toBe(false);
    expect(hits.has("text:t1")).toBe(false);
  });
});

describe("pruneSelection", () => {
  const rich: WorkspaceSheet = {
    ...sheet,
    notes: [{ id: "n1", x: 0, y: 0, text: "" }],
    connections: [{ id: "c1", from: "card:a#1", to: "card:a#2" }],
  };
  test("stale keys drop; live ones - including connections - survive", () => {
    const { pruneSelection } = require("../src/app/workspace/selection");
    const pruned = pruneSelection(rich, new Set(["card:a#1", "note:n1", "conn:c1", "note:gone", "card:dead"]));
    expect([...pruned!].sort()).toEqual(["card:a#1", "conn:c1", "note:n1"]);
  });
  test("a fully live selection returns null - callers must not churn state", () => {
    const { pruneSelection } = require("../src/app/workspace/selection");
    expect(pruneSelection(rich, new Set(["card:a#1", "conn:c1"]))).toBeNull();
    expect(pruneSelection(rich, new Set())).toBeNull();
  });
});
