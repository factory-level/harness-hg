// Whiteboard-object honesty rules, fixture-tested.
import { describe, expect, test } from "bun:test";
import {
  addConnection,
  addNote,
  addText,
  connectionEnds,
  deleteAnyMembers,
  moveAnyMembers,
  memberPositions,
  contentBoxes,
  noteStyle,
  setTextText,
  shapeFillVars,
} from "../src/app/workspace/objects";
import { MAX_NOTES, type WorkspaceSheet } from "../src/stores/document";

const sheet: WorkspaceSheet = {
  id: "s",
  name: "S",
  cards: [{ ref: "a", x: 0, y: 0 }],
  notes: [{ id: "n1", x: 100, y: 100, text: "hi" }],
  shapes: [{ id: "sh1", x: 300, y: 300, w: 220, h: 140 }],
  texts: [{ id: "t1", x: 500, y: 50, text: "label" }],
  connections: [{ id: "c1", from: "card:a", to: "note:n1" }],
};

describe("sticky material", () => {
  test("tilt and paper derive from the id, never random - stable across reloads", () => {
    expect(noteStyle("n1")).toEqual(noteStyle("n1"));
    expect(Math.abs(noteStyle("n1").tilt)).toBeLessThanOrEqual(2.4);
  });
});

describe("connection honesty", () => {
  test("an exact duplicate wire is refused; the reverse direction stays legal", () => {
    const first = addConnection(sheet, "c2", "card:a", "shape:sh1");
    expect(first.connections).toHaveLength(2);
    const withDup = addConnection(first, "c3", "card:a", "shape:sh1");
    expect(withDup.connections).toHaveLength(2); // c2 already says this
    const reverse = addConnection(first, "c4", "shape:sh1", "card:a");
    expect(reverse.connections).toHaveLength(3);
  });
  test("a note is not a terminal - the server's endpoint grammar has no note: key", () => {
    expect(addConnection(sheet, "c2", "card:a", "note:n1")).toBe(sheet);
    expect(addConnection(sheet, "c3", "note:n1", "card:a")).toBe(sheet);
  });
});

describe("contentBoxes", () => {
  test("fit input includes EVERY positioned member kind, not just cards", () => {
    const boxes = contentBoxes(sheet, () => ({ w: 264, h: 250 }), () => "agent");
    // 1 card + 1 note + 1 shape + 1 text
    expect(boxes).toHaveLength(4);
    expect(boxes[1]).toEqual({ x: 100, y: 100, w: 180, h: 110 }); // note defaults
    expect(boxes[2]).toEqual({ x: 300, y: 300, w: 220, h: 140 }); // shape's own size
  });
});

describe("shape fill projection", () => {
  test("a stored palette token projects onto the theme's --shp-* pair", () => {
    expect(shapeFillVars("mint")).toEqual({
      "--shp-stroke": "var(--shp-mint-stroke)",
      "--shp-fill": "var(--shp-mint-fill)",
    });
  });
  test("absent or unknown tokens return {} - the stylesheet default stands, never a minted value", () => {
    expect(shapeFillVars(undefined)).toEqual({});
    expect(shapeFillVars("chartreuse")).toEqual({});
    // A token name is NEVER a color value - reject anything color-shaped.
    expect(shapeFillVars("#ff0000")).toEqual({});
  });
});

describe("abandoned gestures write nothing", () => {
  test("an empty text commit mints nothing", () => {
    expect(addText(sheet, "tx", 0, 0, "   ")).toBe(sheet);
  });
  test("a self-loop connection is refused", () => {
    expect(addConnection(sheet, "cx", "card:a", "card:a")).toBe(sheet);
  });
  test("a wire is not a terminal - conn: endpoints are refused", () => {
    expect(addConnection(sheet, "cx", "conn:c1", "card:a")).toBe(sheet);
    expect(addConnection(sheet, "cx", "card:a", "conn:c1")).toBe(sheet);
  });
  test("the note cap is respected, visible-but-refused", () => {
    const full: WorkspaceSheet = { ...sheet, notes: Array.from({ length: MAX_NOTES }, (_, i) => ({ id: `n${i}`, x: 0, y: 0, text: "" })) };
    expect(addNote(full, "overflow", 0, 0)).toBe(full);
  });
});

describe("shape variants", () => {
  test("a chosen variant is stored; rect stays the absent-field default", async () => {
    const { addShape } = await import("../src/app/workspace/objects");
    const withV = addShape(sheet, "sh2", 0, 0, "diamond");
    expect(withV.shapes?.[1]).toEqual({ id: "sh2", x: 0, y: 0, w: 220, h: 140, v: "diamond" });
    const plain = addShape(sheet, "sh3", 0, 0);
    expect(plain.shapes?.[1]).toEqual({ id: "sh3", x: 0, y: 0, w: 220, h: 140 });
  });
});

describe("resize", () => {
  test("a shape resizes to the absolute size, rounded", async () => {
    const { resizeMember } = await import("../src/app/workspace/objects");
    const next = resizeMember(sheet, "shape:sh1", 300.6, 200.2);
    expect(next.shapes?.[0]).toEqual({ id: "sh1", x: 300, y: 300, w: 301, h: 200 });
  });
  test("a note resizes from its absent-field defaults", async () => {
    const { resizeMember } = await import("../src/app/workspace/objects");
    const next = resizeMember(sheet, "note:n1", 240, 160);
    expect(next.notes?.[0]).toEqual({ id: "n1", x: 100, y: 100, text: "hi", w: 240, h: 160 });
  });
  test("the floor holds - a member can never shrink into a sliver", async () => {
    const { resizeMember, MIN_SIZE } = await import("../src/app/workspace/objects");
    const next = resizeMember(sheet, "shape:sh1", -50, 5);
    expect(next.shapes?.[0].w).toBe(MIN_SIZE.w);
    expect(next.shapes?.[0].h).toBe(MIN_SIZE.h);
  });
  test("unchanged sizes and unknown keys are no-ops", async () => {
    const { resizeMember } = await import("../src/app/workspace/objects");
    expect(resizeMember(sheet, "shape:sh1", 220, 140)).toBe(sheet);
    expect(resizeMember(sheet, "shape:nope", 300, 300)).toBe(sheet);
    expect(resizeMember(sheet, "card:a", 300, 300)).toBe(sheet); // cards have registered footprints
  });
});

describe("text size steps", () => {
  test("a chosen size is stored; md removes the field (absence-as-default)", async () => {
    const { setTextSize } = await import("../src/app/workspace/objects");
    const lg = setTextSize(sheet, "t1", "lg");
    expect(lg.texts?.[0]).toEqual({ id: "t1", x: 500, y: 50, text: "label", size: "lg" });
    const backToMd = setTextSize(lg, "t1", "md");
    expect(backToMd.texts?.[0]).toEqual({ id: "t1", x: 500, y: 50, text: "label" });
  });
  test("unchanged size and unknown ids are no-ops", async () => {
    const { setTextSize } = await import("../src/app/workspace/objects");
    expect(setTextSize(sheet, "t1", "md")).toBe(sheet); // absent already means md
    expect(setTextSize(sheet, "nope", "lg")).toBe(sheet);
  });
});

describe("text label editing", () => {
  test("setTextText replaces the text of the named label only", () => {
    const next = setTextText(sheet, "t1", "renamed");
    expect(next.texts).toEqual([{ id: "t1", x: 500, y: 50, text: "renamed" }]);
  });
  test("clearing a label deletes it - an empty label is not a member", () => {
    const next = setTextText(sheet, "t1", "   ");
    expect(next.texts).toEqual([]);
  });
  test("an unknown id changes nothing", () => {
    expect(setTextText(sheet, "nope", "x")).toBe(sheet);
  });
  test("committing unchanged text is a no-op, not an edit", async () => {
    const { setNoteText } = await import("../src/app/workspace/objects");
    expect(setNoteText(sheet, "n1", "hi")).toBe(sheet);
    expect(setTextText(sheet, "t1", "label")).toBe(sheet);
  });
});

describe("delete cascades", () => {
  test("deleting an endpoint removes its connections - no orphan wires", () => {
    const next = deleteAnyMembers(sheet, new Set(["note:n1"]));
    expect(next.notes).toEqual([]);
    expect(next.connections).toEqual([]);
    expect(next.cards.length).toBe(1);
  });
  test("deleting the connection alone leaves both endpoints", () => {
    const next = deleteAnyMembers(sheet, new Set(["conn:c1"]));
    expect(next.connections).toEqual([]);
    expect(next.notes?.length).toBe(1);
  });
});

describe("mixed-kind gestures", () => {
  test("one delta moves every selected kind; unselected stay", () => {
    const base = new Map([...memberPositions(sheet)].filter(([k]) => ["note:n1", "shape:sh1"].includes(k)));
    const next = moveAnyMembers(sheet, base, 10, 10);
    expect(next.notes?.[0]).toMatchObject({ x: 110, y: 110 });
    expect(next.shapes?.[0]).toMatchObject({ x: 310, y: 310 });
    expect(next.texts?.[0]).toMatchObject({ x: 500, y: 50 });
  });
  test("connection endpoints resolve centre-to-centre; dangling refs do not render", () => {
    const ends = connectionEnds(sheet, () => ({ w: 100, h: 100 }), sheet.connections![0]);
    expect(ends).toMatchObject({ x1: 50, y1: 50, x2: 150, y2: 150 });
    expect(connectionEnds(sheet, () => ({ w: 0, h: 0 }), { id: "x", from: "note:ghost", to: "card:a" })).toBeNull();
  });
});
