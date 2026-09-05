// Clipboard + placement pure contracts.
import { describe, expect, test } from "bun:test";
import { copySelection, paste, placeCard } from "../src/app/workspace/clipboard";
import type { WorkspaceSheet } from "../src/stores/document";

const sheet: WorkspaceSheet = {
  id: "s",
  name: "S",
  cards: [{ ref: "a", x: 0, y: 0 }],
  notes: [{ id: "n1", x: 100, y: 100, text: "hi" }],
  connections: [{ id: "c1", from: "card:a", to: "note:n1" }],
};
let n = 0;
const mint = (p: string) => `${p}m${n++}`;

describe("clipboard", () => {
  test("connections are not clipboard material", () => {
    const clip = copySelection(sheet, new Set(["card:a", "note:n1", "conn:c1"]));
    expect(clip.cards.length).toBe(1);
    expect(clip.notes.length).toBe(1);
    expect("connections" in clip).toBe(false);
  });
  test("paste mints fresh ids, offsets 24px, selects the pasted set", () => {
    const clip = copySelection(sheet, new Set(["card:a", "note:n1"]));
    const r = paste(sheet, clip, mint);
    expect(r.sheet.cards.length).toBe(2);
    expect(r.sheet.cards[1].key).toMatch(/^a-m/) // a hyphen, never `#`: the key is persisted as the card id (a DNS label);
    expect(r.sheet.cards[1].x).toBe(24);
    expect(r.sheet.notes?.[1].x).toBe(124);
    expect(r.selection.size).toBe(2);
    for (const k of r.selection) expect(k).toMatch(/^(card|note):/);
  });
  test("paste with a target point lands the clip's bbox top-left THERE, arrangement preserved", () => {
    const clip = copySelection(sheet, new Set(["card:a", "note:n1"]));
    const r = paste(sheet, clip, mint, { x: 500, y: 700 });
    // bbox top-left was (0,0) -> everything translates by (500,700)
    expect(r.sheet.cards[1].x).toBe(500);
    expect(r.sheet.cards[1].y).toBe(700);
    expect(r.sheet.notes?.[1].x).toBe(600); // 100 + 500
    expect(r.sheet.notes?.[1].y).toBe(800);
  });
});

describe("placement (#546)", () => {
  test("the first placement of a ref keeps key absent (byte-identical legacy round-trips)", () => {
    const r = placeCard({ ...sheet, cards: [] }, "b", 10, 10, mint);
    expect(r.sheet.cards[0]).toEqual({ ref: "b", x: 10, y: 10 });
    // ...but the RETURNED key is the ref, so a drop can select what it made.
    expect(r.key).toBe("b");
  });
  test("a repeated reference mints an instance key - independent placements", () => {
    const r = placeCard(sheet, "a", 50, 50, mint);
    expect(r.sheet.cards[1].key).toMatch(/^a-m/) // a hyphen, never `#`: the key is persisted as the card id (a DNS label);
    expect(r.key).toBe(r.sheet.cards[1].key!);
  });
});

describe("mintId", () => {
  test("same-instant mints stay distinct - time alone is not an identity", () => {
    const { mintId } = require("../src/app/workspace/mint");
    const ids = new Set(Array.from({ length: 1000 }, () => mintId("note-")));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id.startsWith("note-")).toBe(true);
  });
});
