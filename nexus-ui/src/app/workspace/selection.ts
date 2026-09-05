// The selection model - pure and DOM-free (the carried backbone). Every
// selectable thing is a prefixed key ("card:<instanceKey>"); cards key by
// canvas-instance identity (#546), so repeated references select
// independently.
import type { SheetCard, WorkspaceSheet } from "../../stores/document";
import { clampCoord, sizeOf, type Box } from "./geometry";
import { memberBoxes, memberPositions } from "./objects";

export function cardKey(c: SheetCard): string {
  return `card:${c.key ?? c.ref}`;
}

/** The Miro grammar's press decision: shift toggles (no drag); pressing
 * a selected member keeps the set (and drags it all); pressing an
 * unselected one selects just it. Pure - the caller applies the result
 * and starts the drag when `drag` is true. */
export function memberPress(
  selection: ReadonlySet<string>,
  key: string,
  shift: boolean,
): { selection: ReadonlySet<string>; drag: boolean } {
  if (shift) {
    const next = new Set(selection);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return { selection: next, drag: false };
  }
  if (selection.has(key)) return { selection, drag: true };
  return { selection: new Set([key]), drag: true };
}

/** Approximate footprints - "a marquee is a gesture, not a measurement".
 * EVERY positioned kind participates: a marquee that only caught cards
 * silently ignored notes, shapes and texts. */
export function marqueeHits(
  sheet: WorkspaceSheet,
  kindOf: (ref: string) => string | undefined,
  rect: { x0: number; y0: number; x1: number; y1: number },
): Set<string> {
  const minX = Math.min(rect.x0, rect.x1);
  const maxX = Math.max(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1);
  const maxY = Math.max(rect.y0, rect.y1);
  const hits = new Set<string>();
  for (const [k, b] of memberBoxes(sheet, sizeOf, kindOf)) {
    if (b.x < maxX && b.x + b.w > minX && b.y < maxY && b.y + b.h > minY) hits.add(k);
  }
  return hits;
}

/** Base positions captured at pointer-down; one delta moves the whole
 * set through ONE coalesced sheet edit per gesture. */
export function baseOf(sheet: WorkspaceSheet, selection: ReadonlySet<string>): Map<string, { x: number; y: number }> {
  const base = new Map<string, { x: number; y: number }>();
  for (const c of sheet.cards) {
    const k = cardKey(c);
    if (selection.has(k)) base.set(k, { x: c.x, y: c.y });
  }
  return base;
}

export function moveMembers(
  sheet: WorkspaceSheet,
  base: Map<string, { x: number; y: number }>,
  dx: number,
  dy: number,
): WorkspaceSheet {
  return {
    ...sheet,
    cards: sheet.cards.map((c) => {
      const b = base.get(cardKey(c));
      if (!b) return c;
      return { ...c, x: clampCoord(b.x + dx), y: clampCoord(b.y + dy) };
    }),
  };
}

/** Delete = ONE sheet edit; a card deletion is a REFERENCE removal -
 * nothing deployed is touched. */
export function deleteMembers(sheet: WorkspaceSheet, selection: ReadonlySet<string>): WorkspaceSheet {
  return { ...sheet, cards: sheet.cards.filter((c) => !selection.has(cardKey(c))) };
}

export function selectAll(sheet: WorkspaceSheet): Set<string> {
  return new Set(sheet.cards.map(cardKey));
}

/** Selection keys must always point at LIVE members - undo, redo, adopt
 * and delete can all strand them. Returns the pruned set, or null when
 * nothing was stale (callers only setState on a real change). */
export function pruneSelection(sheet: WorkspaceSheet, selection: ReadonlySet<string>): ReadonlySet<string> | null {
  if (selection.size === 0) return null;
  const valid = new Set(memberPositions(sheet).keys());
  for (const c of sheet.connections ?? []) valid.add(`conn:${c.id}`);
  const next = new Set<string>();
  for (const k of selection) if (valid.has(k)) next.add(k);
  return next.size === selection.size ? null : next;
}

export function selectionBoxes(
  sheet: WorkspaceSheet,
  kindOf: (ref: string) => string | undefined,
  selection: ReadonlySet<string>,
): Box[] {
  return sheet.cards
    .filter((c) => selection.has(cardKey(c)))
    .map((c) => {
      const { w, h } = sizeOf(kindOf(c.ref));
      return { x: c.x, y: c.y, w, h };
    });
}
