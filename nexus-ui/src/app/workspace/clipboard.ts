// Copy/paste/duplicate + placement - pure. Carried rules: connections
// are not clipboard material; paste mints fresh instance ids and offsets
// 24px and selects the pasted set; a repeated plan reference mints an
// instance key (#546); placement resolution happens in ONE transition so
// one undo removes everything it created.
import type { SheetCard, SheetNote, SheetShape, SheetText, WorkspaceSheet } from "../../stores/document";
import { GRID } from "./geometry";

export interface ClipboardDoc {
  cards: SheetCard[];
  notes: SheetNote[];
  shapes: SheetShape[];
  texts: SheetText[];
}

export function copySelection(sheet: WorkspaceSheet, selection: ReadonlySet<string>): ClipboardDoc {
  return {
    cards: sheet.cards.filter((c) => selection.has(`card:${c.key ?? c.ref}`)),
    notes: (sheet.notes ?? []).filter((n) => selection.has(`note:${n.id}`)),
    shapes: (sheet.shapes ?? []).filter((s) => selection.has(`shape:${s.id}`)),
    texts: (sheet.texts ?? []).filter((t) => selection.has(`text:${t.id}`)),
  };
}

/** Fresh ids from a caller-supplied mint (no clocks in pure code); the
 * pasted set becomes the new selection. Default placement is the carried
 * +24px offset; `at` (a world point - e.g. the right-click position)
 * instead lands the clip's bounding-box top-left THERE, preserving the
 * members' relative arrangement. */
export function paste(
  sheet: WorkspaceSheet,
  clip: ClipboardDoc,
  mint: (prefix: string) => string,
  at?: { x: number; y: number },
): { sheet: WorkspaceSheet; selection: Set<string> } {
  let dx = GRID;
  let dy = GRID;
  if (at) {
    const xs = [...clip.cards, ...clip.notes, ...clip.shapes, ...clip.texts].map((m) => m.x);
    const ys = [...clip.cards, ...clip.notes, ...clip.shapes, ...clip.texts].map((m) => m.y);
    if (xs.length > 0) {
      dx = at.x - Math.min(...xs);
      dy = at.y - Math.min(...ys);
    }
  }
  const sel = new Set<string>();
  const cards = clip.cards.map((c) => {
    const key = mint(`${c.ref}-`);
    sel.add(`card:${key}`);
    return { ...c, key, x: c.x + dx, y: c.y + dy };
  });
  const notes = clip.notes.map((n) => {
    const id = mint("note-");
    sel.add(`note:${id}`);
    return { ...n, id, x: n.x + dx, y: n.y + dy };
  });
  const shapes = clip.shapes.map((s) => {
    const id = mint("shape-");
    sel.add(`shape:${id}`);
    return { ...s, id, x: s.x + dx, y: s.y + dy };
  });
  const texts = clip.texts.map((t) => {
    const id = mint("text-");
    sel.add(`text:${id}`);
    return { ...t, id, x: t.x + dx, y: t.y + dy };
  });
  return {
    sheet: {
      ...sheet,
      cards: [...sheet.cards, ...cards],
      notes: [...(sheet.notes ?? []), ...notes],
      shapes: [...(sheet.shapes ?? []), ...shapes],
      texts: [...(sheet.texts ?? []), ...texts],
    },
    selection: sel,
  };
}

/** Place a plan component by reference; a repeat mints an instance key so
 * the two placements are independent (#546). Legacy first placements
 * keep key==ref absent for byte-identical round-trips. Returns the
 * placed card's selection key part so a drop can SELECT what it made. */
export function placeCard(
  sheet: WorkspaceSheet,
  ref: string,
  x: number,
  y: number,
  mint: (prefix: string) => string,
): { sheet: WorkspaceSheet; key: string } {
  const already = sheet.cards.some((c) => c.ref === ref);
  // The instance key is persisted as the card's `id`, which the server
  // holds to the same DNS-label grammar as a ref - so the separator is a
  // hyphen, never `#` (a `#` key drew fine and then failed every save).
  const card: SheetCard = already ? { ref, key: mint(`${ref}-`), x, y } : { ref, x, y };
  return { sheet: { ...sheet, cards: [...sheet.cards, card] }, key: card.key ?? ref };
}
