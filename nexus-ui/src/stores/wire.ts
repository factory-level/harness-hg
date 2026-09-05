// The workspace WIRE boundary. plugin_api.py owns the persisted
// NexusWorkspace format (ADR-56: byte-exact export, revision CAS, a closed
// allowlist per kind); the store models the same document the way the
// canvas draws it - flat card coordinates, selection keys on wires,
// absence-as-default on text size. These two functions are the ONLY
// place the two vocabularies meet:
//
//   server                          client
//   card  {ref, position:{x,y}, id?} {ref, key?, x, y}
//   shape {…, label, shape?, color?} {…, label?, v?, fill?}
//   text  {…, size}  (required)      {…, size?}  (absent = md)
//   wire  from/to: bare card key     from/to: card:<key>
//         or shape:/text: prefixed   (shape:/text: unchanged)
//
// Everything the validator allows and the client does not draw (viewport,
// settings, objects, groups, the document header) passes through
// untouched, so a save from this UI never strips what an older one wrote.
// Invariant, pinned by tests/wire.test.ts against a shared fixture the
// server-side suite also reads: toWire(fromWire(w)) deep-equals w for any
// validator-clean w.
import type {
  NexusWorkspace,
  SheetCard,
  SheetConnection,
  SheetShape,
  SheetText,
  WorkspaceSheet,
} from "./document";

export const WIRE_API_VERSION = "nexus.hermes.ai/v1alpha1";
export const WIRE_KIND = "NexusWorkspace";

export interface WireCard {
  ref: string;
  position: { x: number; y: number };
  id?: string;
  displayMode?: SheetCard["displayMode"];
}
export interface WireShape {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  shape?: SheetShape["v"];
  color?: string;
  rotation?: number;
}
export interface WireText {
  id: string;
  x: number;
  y: number;
  text: string;
  size: "sm" | "md" | "lg";
  font?: string;
}
export interface WireConnection {
  id: string;
  from: string;
  to: string;
  label: string;
  kind?: string;
  arrows?: string;
}
export interface WireSheet extends Omit<WorkspaceSheet, "cards" | "shapes" | "texts" | "connections"> {
  cards: WireCard[];
  shapes?: WireShape[];
  texts?: WireText[];
  connections?: WireConnection[];
}
export interface WireWorkspace extends Omit<NexusWorkspace, "sheets"> {
  sheets: WireSheet[];
}

const CARD_PREFIX = "card:";
const isPrefixedMember = (key: string) => key.startsWith("shape:") || key.startsWith("text:");

function cardFromWire(c: WireCard): SheetCard {
  return {
    ref: c.ref,
    ...(c.id !== undefined ? { key: c.id } : {}),
    x: c.position?.x ?? 0,
    y: c.position?.y ?? 0,
    ...(c.displayMode !== undefined ? { displayMode: c.displayMode } : {}),
  };
}
function cardToWire(c: SheetCard): WireCard {
  return {
    ref: c.ref,
    position: { x: c.x, y: c.y },
    ...(c.key !== undefined ? { id: c.key } : {}),
    ...(c.displayMode !== undefined ? { displayMode: c.displayMode } : {}),
  };
}

function shapeFromWire(s: WireShape): SheetShape {
  const { shape, color, ...rest } = s;
  return {
    ...rest,
    ...(shape !== undefined ? { v: shape } : {}),
    ...(color !== undefined ? { fill: color } : {}),
  };
}
function shapeToWire(s: SheetShape): WireShape {
  return {
    id: s.id,
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    label: s.label ?? "",
    ...(s.v !== undefined ? { shape: s.v } : {}),
    ...(s.fill !== undefined ? { color: s.fill } : {}),
    ...(s.rotation !== undefined ? { rotation: s.rotation } : {}),
  };
}

function textFromWire(t: WireText): SheetText {
  const { size, ...rest } = t;
  // The client spells the default by absence (setTextSize drops "md");
  // toWire re-emits the literal the server requires.
  return size === "md" ? rest : { ...rest, size };
}
function textToWire(t: SheetText): WireText {
  return {
    id: t.id,
    x: t.x,
    y: t.y,
    text: t.text,
    size: t.size ?? "md",
    ...(t.font !== undefined ? { font: t.font } : {}),
  };
}

function connectionFromWire(c: WireConnection): SheetConnection {
  const end = (key: string) => (isPrefixedMember(key) ? key : `${CARD_PREFIX}${key}`);
  return { ...c, from: end(c.from), to: end(c.to) };
}
function connectionToWire(c: SheetConnection): WireConnection {
  const end = (key: string) => (key.startsWith(CARD_PREFIX) ? key.slice(CARD_PREFIX.length) : key);
  return {
    id: c.id,
    from: end(c.from),
    to: end(c.to),
    label: c.label ?? "",
    ...(c.kind !== undefined ? { kind: c.kind } : {}),
    ...(c.arrows !== undefined ? { arrows: c.arrows } : {}),
  };
}

// Spread-then-assign on purpose: overwriting a key keeps its position, so
// a server-ordered sheet round-trips byte-identically, while a key the
// source lacks is simply never written (the server defaults it).
function sheetFromWire(s: WireSheet): WorkspaceSheet {
  const { cards, shapes, texts, connections } = s;
  const out = { ...s, cards: (cards ?? []).map(cardFromWire) } as unknown as WorkspaceSheet;
  if (shapes) out.shapes = shapes.map(shapeFromWire);
  if (texts) out.texts = texts.map(textFromWire);
  if (connections) out.connections = connections.map(connectionFromWire);
  return out;
}
function sheetToWire(s: WorkspaceSheet): WireSheet {
  const { cards, shapes, texts, connections } = s;
  const out = { ...s, cards: cards.map(cardToWire) } as unknown as WireSheet;
  if (shapes) out.shapes = shapes.map(shapeToWire);
  if (texts) out.texts = texts.map(textToWire);
  if (connections) out.connections = connections.map(connectionToWire);
  return out;
}

export function fromWire(doc: WireWorkspace): NexusWorkspace {
  return { ...doc, sheets: doc.sheets.map(sheetFromWire) };
}

/** The document as the server persists it. apiVersion/kind are stamped
 * unconditionally: the validator refuses a document without them, and
 * the demo fallback doc carries neither. */
export function toWire(doc: NexusWorkspace): WireWorkspace {
  return { ...doc, apiVersion: WIRE_API_VERSION, kind: WIRE_KIND, sheets: doc.sheets.map(sheetToWire) };
}
