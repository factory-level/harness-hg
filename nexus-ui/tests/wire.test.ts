// The workspace WIRE contract: plugin_api.py persists {ref, position}
// cards, `shape`/`color` on shapes, a required text `size`, bare card
// keys on connection endpoints. The store models cards flat and speaks
// selection keys. stores/wire.ts is the one boundary, and these two
// fixtures are shared with plugin/tests/test_nexus_plugin_api.py, which
// proves the server ACCEPTS what toWire emits - so the two sides cannot
// drift apart silently again (the first live deployment stacked every
// card at the origin and rejected every save).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fromWire, toWire, type WireWorkspace } from "../src/stores/wire";
import { removeSheetFrom, unwrapWorkspace, type NexusWorkspace, type WorkspaceSheet } from "../src/stores/document";
import { addConnection, addNote, addShape, addText } from "../src/app/workspace/objects";
import { placeCard } from "../src/app/workspace/clipboard";
import { DEMO_WORKSPACE } from "../src/stores/demo";

const serverText = readFileSync(new URL("./fixtures/workspace-wire.json", import.meta.url), "utf8");
const server = JSON.parse(serverText) as WireWorkspace;
const authored = JSON.parse(readFileSync(new URL("./fixtures/workspace-wire.authored.json", import.meta.url), "utf8"));

describe("fromWire", () => {
  const doc = fromWire(server);
  const sheet = doc.sheets[0];

  test("cards land at their served positions, keyed by the instance id", () => {
    expect(sheet.cards[0]).toEqual({ ref: "manager", x: 420, y: 160 });
    expect(sheet.cards[2]).toEqual({ ref: "research", key: "research-2", x: 810, y: 300, displayMode: "badge" });
    expect("position" in sheet.cards[0]).toBe(false);
  });

  test("shapes speak v/fill; the server's wider vocabulary passes through", () => {
    expect(sheet.shapes?.[0]).toEqual({ id: "region", x: 500, y: 20, w: 360, h: 680, label: "content loop", v: "ellipse", fill: "mint", rotation: 45 });
    expect(sheet.shapes?.[2].v).toBe("brace-l");
  });

  test("an explicit md text size becomes the client's absence-as-default", () => {
    expect(sheet.texts?.[0]).toEqual({ id: "t-md", x: 60, y: 40, text: "The operation" });
    expect(sheet.texts?.[1]).toEqual({ id: "t-lg", x: 0, y: 0, text: "Big", size: "lg", font: "mono" });
  });

  test("bare connection endpoints become card: selection keys; prefixed ones stay", () => {
    expect(sheet.connections?.[0]).toEqual({ id: "conn-1", from: "card:manager", to: "card:research", label: "coordinates" });
    expect(sheet.connections?.[1]).toEqual({ id: "conn-2", from: "card:manager", to: "shape:region", label: "", kind: "observes", arrows: "end" });
    expect(sheet.connections?.[2]).toEqual({ id: "conn-3", from: "text:t-lg", to: "card:research-2", label: "instance" });
  });

  test("notes, viewport, settings, objects and groups are carried verbatim", () => {
    expect(sheet.notes).toEqual(server.sheets[0].notes);
    expect(sheet.viewport).toEqual({ x: -40, y: 12, zoom: 1 });
    expect(sheet.settings).toEqual({ sourceBadges: ["argocd", "grafana"] });
    expect(sheet.objects).toEqual(server.sheets[0].objects);
    expect(sheet.groups).toEqual(server.sheets[0].groups);
    expect(doc.revision).toBe(4);
    expect(doc.adoptedRelationships).toBe(true);
  });
});

describe("toWire", () => {
  test("round-trips a validator-clean document byte-identically", () => {
    expect(JSON.stringify(toWire(fromWire(server)))).toBe(JSON.stringify(JSON.parse(serverText)));
  });

  test("a document authored purely by client actions is what the server-side test accepts", () => {
    const mint = (prefix: string) => `${prefix}2`;
    let sheet: WorkspaceSheet = { id: "mine", name: "Mine", cards: [] };
    sheet = placeCard(sheet, "mkt-manager", 100, 120, mint).sheet;
    sheet = placeCard(sheet, "mkt-manager", 400, 120, mint).sheet;
    sheet = addShape(sheet, "s1", 200, 200, "diamond");
    sheet = addText(sheet, "t1", 10, 10, "Hello");
    sheet = addNote(sheet, "n1", 50, 50);
    sheet = addConnection(sheet, "c1", "card:mkt-manager", "shape:s1");
    const wire = toWire({ revision: 0, sheets: [sheet] });
    expect(wire).toEqual(authored);
    const text = JSON.stringify(wire);
    for (const forbidden of ['"key"', '"v"', '"fill"', '"x":100,"y":120,"ref"', "card:"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("a second copy of a card gets a server-legal instance id (a DNS label, no #)", () => {
    const mint = (prefix: string) => `${prefix}123-4-5`;
    let sheet: WorkspaceSheet = { id: "s", name: "S", cards: [] };
    sheet = placeCard(sheet, "postiz", 0, 0, mint).sheet;
    const { key } = placeCard(sheet, "postiz", 10, 10, mint);
    expect(key).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  });

  test("stamps apiVersion and kind on a document that lacks them (the demo doc)", () => {
    const wire = toWire(DEMO_WORKSPACE as NexusWorkspace);
    expect(wire.apiVersion).toBe("nexus.hermes.ai/v1alpha1");
    expect(wire.kind).toBe("NexusWorkspace");
    expect(wire.sheets[0].cards[0]).toEqual({ ref: "mkt-manager", position: { x: 180, y: 180 } });
  });

  test("unwrapWorkspace still hands back the raw wire shape for fromWire", () => {
    const unwrapped = unwrapWorkspace({ workspace: server, canWrite: true });
    expect(unwrapped).not.toBeNull();
    expect(fromWire(unwrapped!).sheets[0].cards[0].x).toBe(420);
  });
});

describe("removeSheetFrom", () => {
  const doc = fromWire(server);

  test("removes the named sheet and leaves the others by reference", () => {
    const next = removeSheetFrom(doc, "notes");
    expect(next?.sheets.map((s) => s.id)).toEqual(["default"]);
    expect(next?.sheets[0]).toBe(doc.sheets[0]);
  });

  test("refuses the last sheet and an unknown id", () => {
    expect(removeSheetFrom({ revision: 0, sheets: [doc.sheets[0]] }, "default")).toBeNull();
    expect(removeSheetFrom(doc, "nope")).toBeNull();
  });
});

describe("addConnection", () => {
  test("refuses a note endpoint - the server cannot persist one", () => {
    const sheet: WorkspaceSheet = { id: "s", name: "S", cards: [{ ref: "a", x: 0, y: 0 }], notes: [{ id: "n", x: 0, y: 0, text: "" }] };
    expect(addConnection(sheet, "c", "card:a", "note:n")).toBe(sheet);
    expect(addConnection(sheet, "c", "note:n", "card:a")).toBe(sheet);
  });
});
