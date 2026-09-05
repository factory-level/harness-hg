// Whiteboard-object transforms - pure, carried semantics: deterministic
// sticky tilt/paper from the id (never random), abandoned gestures write
// nothing (the callers only invoke these on commit), delete cascades
// connections with dead endpoints, client caps mirror the server's.
import { MAX_NOTES, MAX_OBJECTS, type SheetConnection, type WorkspaceSheet } from "../../stores/document";
import { clampCoord } from "./geometry";

export function noteHash(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** ±2.4° in 0.3° steps + alternating paper - material means authorship,
 * and the material is stable across reloads. */
export function noteStyle(id: string): { tilt: number; alt: boolean } {
  const h = noteHash(id);
  return { tilt: ((h % 17) - 8) * 0.3, alt: h % 2 === 1 };
}

/** A shape's `fill` is a shapePalette TOKEN NAME, never a color value;
 * the renderer projects it onto the theme's --shp-* pair. Unknown or
 * absent tokens return {} and the stylesheet's apricot default stands. */
export const SHAPE_FILLS = ["apricot", "sky", "mint", "rose", "violet", "slate"] as const;
export function shapeFillVars(fill?: string): Record<string, string> {
  if (!fill || !(SHAPE_FILLS as readonly string[]).includes(fill)) return {};
  return { "--shp-stroke": `var(--shp-${fill}-stroke)`, "--shp-fill": `var(--shp-${fill}-fill)` };
}

export function addNote(sheet: WorkspaceSheet, id: string, x: number, y: number): WorkspaceSheet {
  if ((sheet.notes ?? []).length >= MAX_NOTES) return sheet;
  return { ...sheet, notes: [...(sheet.notes ?? []), { id, x: clampCoord(x), y: clampCoord(y), text: "" }] };
}

export function addShape(sheet: WorkspaceSheet, id: string, x: number, y: number, v?: "ellipse" | "diamond" | "pill"): WorkspaceSheet {
  if ((sheet.shapes ?? []).length >= MAX_OBJECTS) return sheet;
  const shape = { id, x: clampCoord(x), y: clampCoord(y), w: 220, h: 140, ...(v ? { v } : {}) };
  return { ...sheet, shapes: [...(sheet.shapes ?? []), shape] };
}

export function addText(sheet: WorkspaceSheet, id: string, x: number, y: number, text: string): WorkspaceSheet {
  // The empty commit mints nothing - an abandoned gesture writes nothing.
  if (!text.trim()) return sheet;
  if ((sheet.texts ?? []).length >= MAX_OBJECTS) return sheet;
  return { ...sheet, texts: [...(sheet.texts ?? []), { id, x: clampCoord(x), y: clampCoord(y), text }] };
}

export function setNoteText(sheet: WorkspaceSheet, id: string, text: string): WorkspaceSheet {
  // Unchanged text is a no-op, not an edit - a blur that commits what
  // was already there must not grind an undo step.
  if (!(sheet.notes ?? []).some((n) => n.id === id && n.text !== text)) return sheet;
  return { ...sheet, notes: (sheet.notes ?? []).map((n) => (n.id === id ? { ...n, text } : n)) };
}

/** Editing an existing label to empty DELETES it - clearing is the
 * delete affordance, mirroring addText's "the empty commit mints
 * nothing" (a label with no text is not a member). */
export function setTextText(sheet: WorkspaceSheet, id: string, text: string): WorkspaceSheet {
  if (!text.trim()) {
    if (!(sheet.texts ?? []).some((t) => t.id === id)) return sheet;
    return { ...sheet, texts: (sheet.texts ?? []).filter((t) => t.id !== id) };
  }
  if (!(sheet.texts ?? []).some((t) => t.id === id && t.text !== text)) return sheet;
  return { ...sheet, texts: (sheet.texts ?? []).map((t) => (t.id === id ? { ...t, text } : t)) };
}

/** Resize floor/ceiling: a member can never shrink into an unclickable
 * sliver or grow past the board's own coordinate discipline. */
export const MIN_SIZE = { w: 60, h: 40 };
const MAX_SIZE = 4000;
const clampSize = (v: number, min: number) => Math.max(min, Math.min(MAX_SIZE, Math.round(v)));

/** Resize a note or shape to an absolute w/h (the gesture computes them
 * from its own base + delta). Unchanged sizes and unknown keys are
 * no-ops - a resize that resizes nothing writes nothing. */
export function resizeMember(sheet: WorkspaceSheet, key: string, w: number, h: number): WorkspaceSheet {
  const cw = clampSize(w, MIN_SIZE.w);
  const ch = clampSize(h, MIN_SIZE.h);
  if (key.startsWith("note:")) {
    const id = key.slice(5);
    if (!(sheet.notes ?? []).some((n) => n.id === id && ((n.w ?? 180) !== cw || (n.h ?? 110) !== ch))) return sheet;
    return { ...sheet, notes: (sheet.notes ?? []).map((n) => (n.id === id ? { ...n, w: cw, h: ch } : n)) };
  }
  if (key.startsWith("shape:")) {
    const id = key.slice(6);
    if (!(sheet.shapes ?? []).some((sh) => sh.id === id && (sh.w !== cw || sh.h !== ch))) return sheet;
    return { ...sheet, shapes: (sheet.shapes ?? []).map((sh) => (sh.id === id ? { ...sh, w: cw, h: ch } : sh)) };
  }
  return sheet;
}

/** Set a text label's size step. "md" REMOVES the field (absence-as-
 * default, ADR-72: untouched documents round-trip byte-identically). */
export function setTextSize(sheet: WorkspaceSheet, id: string, size: "sm" | "md" | "lg"): WorkspaceSheet {
  const target = (sheet.texts ?? []).find((t) => t.id === id);
  if (!target || (target.size ?? "md") === size) return sheet;
  return {
    ...sheet,
    texts: (sheet.texts ?? []).map((t) => {
      if (t.id !== id) return t;
      const { size: _drop, ...rest } = t;
      return size === "md" ? rest : { ...rest, size };
    }),
  };
}

export function addConnection(sheet: WorkspaceSheet, id: string, from: string, to: string): WorkspaceSheet {
  if (from === to) return sheet; // self-loop refused
  // A wire is not a terminal: now that edges are selectable, the connect
  // tool could otherwise mint a dangling wire-to-wire connection that
  // renders nothing and pollutes the doc.
  if (from.startsWith("conn:") || to.startsWith("conn:")) return sheet;
  // A note is not a terminal either: the server's endpoint grammar is a
  // card key or a shape:/text: member, so a note-anchored wire could be
  // drawn but never saved - refused at authoring, not lost at save.
  if (from.startsWith("note:") || to.startsWith("note:")) return sheet;
  // An exact duplicate says nothing new - refused. The REVERSE direction
  // stays legal: a wire each way is a meaningful statement.
  if ((sheet.connections ?? []).some((c) => c.from === from && c.to === to)) return sheet;
  if ((sheet.connections ?? []).length >= MAX_OBJECTS) return sheet;
  return { ...sheet, connections: [...(sheet.connections ?? []), { id, from, to }] };
}

/** Every positioned member's PAINTED bounding box - what "fit the sheet
 * into view" must actually include (fitting only cards loads a notes-
 * and-shapes sheet off-screen). Painted, not footprint: a card's avatar
 * overhangs 36px past its top-left, the badge strip drops ~22px below
 * its bottom edge, and a person's name sits ~44px under the circle -
 * fitting the bare footprints clips those at the viewport edge. Text
 * extent is unmeasurable in pure code; 220x36 approximates a median md
 * label and errs toward margin. */
const OVERHANG = 36; // the avatar's top-left reach
const BADGE_DROP = 22; // badge strip below the bottom edge (+halo)
const PERSON_LABEL = 44; // the outside name block under the circle
export function contentBoxes(
  sheet: WorkspaceSheet,
  sizeOfKind: (kind: string | undefined) => { w: number; h: number },
  kindOf: (ref: string) => string | undefined,
): { x: number; y: number; w: number; h: number }[] {
  return [
    ...sheet.cards.map((c) => {
      const kind = kindOf(c.ref);
      const { w, h } = sizeOfKind(kind);
      const below = kind === "person" || kind === "human" ? PERSON_LABEL : BADGE_DROP;
      return { x: c.x - OVERHANG, y: c.y - OVERHANG, w: w + OVERHANG, h: h + OVERHANG + below };
    }),
    ...(sheet.notes ?? []).map((n) => ({ x: n.x, y: n.y, w: n.w ?? 180, h: n.h ?? 110 })),
    ...(sheet.shapes ?? []).map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })),
    ...(sheet.texts ?? []).map((t) => ({ x: t.x, y: t.y, w: 220, h: 36 })),
  ];
}

/** Delete any member kind in ONE edit; connections touching a deleted
 * endpoint cascade (no orphan wires). */
export function deleteAnyMembers(sheet: WorkspaceSheet, selection: ReadonlySet<string>): WorkspaceSheet {
  const gone = (key: string) => selection.has(key);
  const conns = (sheet.connections ?? []).filter(
    (c: SheetConnection) => !gone(`conn:${c.id}`) && !gone(c.from) && !gone(c.to),
  );
  return {
    ...sheet,
    cards: sheet.cards.filter((c) => !gone(`card:${c.key ?? c.ref}`)),
    notes: (sheet.notes ?? []).filter((n) => !gone(`note:${n.id}`)),
    shapes: (sheet.shapes ?? []).filter((sh) => !gone(`shape:${sh.id}`)),
    texts: (sheet.texts ?? []).filter((t) => !gone(`text:${t.id}`)),
    connections: conns,
  };
}

/** Footprint boxes for HIT-TESTING, one per positioned member - these
 * must agree with the renderer's sizeOfKey (a marquee measures the same
 * world the edges do), never with contentBoxes' fit margins. */
export function memberBoxes(
  sheet: WorkspaceSheet,
  sizeOfKind: (kind: string | undefined) => { w: number; h: number },
  kindOf: (ref: string) => string | undefined,
): Map<string, { x: number; y: number; w: number; h: number }> {
  const m = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const c of sheet.cards) {
    const { w, h } = sizeOfKind(kindOf(c.ref));
    m.set(`card:${c.key ?? c.ref}`, { x: c.x, y: c.y, w, h });
  }
  for (const n of sheet.notes ?? []) m.set(`note:${n.id}`, { x: n.x, y: n.y, w: n.w ?? 180, h: n.h ?? 110 });
  for (const sh of sheet.shapes ?? []) m.set(`shape:${sh.id}`, { x: sh.x, y: sh.y, w: sh.w, h: sh.h });
  for (const t of sheet.texts ?? []) m.set(`text:${t.id}`, { x: t.x, y: t.y, w: 120, h: 24 });
  return m;
}

/** One home per positioned member kind - the shared move map. */
export function memberPositions(sheet: WorkspaceSheet): Map<string, { x: number; y: number }> {
  const m = new Map<string, { x: number; y: number }>();
  for (const c of sheet.cards) m.set(`card:${c.key ?? c.ref}`, { x: c.x, y: c.y });
  for (const n of sheet.notes ?? []) m.set(`note:${n.id}`, { x: n.x, y: n.y });
  for (const sh of sheet.shapes ?? []) m.set(`shape:${sh.id}`, { x: sh.x, y: sh.y });
  for (const t of sheet.texts ?? []) m.set(`text:${t.id}`, { x: t.x, y: t.y });
  return m;
}

export function moveAnyMembers(
  sheet: WorkspaceSheet,
  base: Map<string, { x: number; y: number }>,
  dx: number,
  dy: number,
): WorkspaceSheet {
  const moved = (key: string, x: number, y: number) => {
    const b = base.get(key);
    return b ? { x: clampCoord(b.x + dx), y: clampCoord(b.y + dy) } : { x, y };
  };
  return {
    ...sheet,
    cards: sheet.cards.map((c) => ({ ...c, ...moved(`card:${c.key ?? c.ref}`, c.x, c.y) })),
    notes: (sheet.notes ?? []).map((n) => ({ ...n, ...moved(`note:${n.id}`, n.x, n.y) })),
    shapes: (sheet.shapes ?? []).map((sh) => ({ ...sh, ...moved(`shape:${sh.id}`, sh.x, sh.y) })),
    texts: (sheet.texts ?? []).map((t) => ({ ...t, ...moved(`text:${t.id}`, t.x, t.y) })),
  };
}

/** Centre-to-centre endpoints for rendering a connection; dangling refs
 * simply do not render. */
export function connectionEnds(
  sheet: WorkspaceSheet,
  sizeOfKey: (key: string) => { w: number; h: number },
  c: SheetConnection,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const pos = memberPositions(sheet);
  const a = pos.get(c.from);
  const b = pos.get(c.to);
  if (!a || !b) return null;
  const sa = sizeOfKey(c.from);
  const sb = sizeOfKey(c.to);
  return { x1: a.x + sa.w / 2, y1: a.y + sa.h / 2, x2: b.x + sb.w / 2, y2: b.y + sb.h / 2 };
}
