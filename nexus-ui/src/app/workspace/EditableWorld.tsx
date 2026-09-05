// The editing layer over CanvasWorld: the Miro press grammar, one
// coalesced edit per gesture, marquee on shift, nudges, delete-as-
// reference-removal, Escape as the one-key exit. All transient state
// lives in the SessionStore; every mutation goes through the document
// funnel with a coalesce key.
import { React } from "../../sdk";
import type { DocumentStore, WorkspaceSheet } from "../../stores/document";
import type { SessionStore } from "../../stores/session";
import { GRID } from "./geometry";
import { cardKey, marqueeHits, memberPress, pruneSelection } from "./selection";
import { addConnection, addNote, addShape, deleteAnyMembers, memberPositions, moveAnyMembers, resizeMember } from "./objects";
import { copySelection, paste } from "./clipboard";
import { mintId } from "./mint";

export interface EditGestures {
  onMemberPointerDown: (
    key: string,
    e: {
      button: number;
      shiftKey: boolean;
      clientX: number;
      clientY: number;
      stopPropagation: () => void;
      /** For pointer capture at drag start - a drag that leaves the
       * member (or the canvas) must not silently end mid-gesture. */
      pointerId?: number;
      currentTarget?: unknown;
    },
  ) => void;
  onBackgroundPointerDown: (world: { x: number; y: number }, e: { shiftKey: boolean }) => boolean;
  /** Deltas derive from the gesture's OWN press origin - the member's
   * stopPropagation means the canvas never saw the press. */
  /** Corner-grip press on a selected note/shape: one coalesced resize
   * per gesture, same discipline as move. */
  onResizeGripPointerDown: (
    key: string,
    e: { button: number; clientX: number; clientY: number; stopPropagation: () => void; pointerId?: number; currentTarget?: unknown },
  ) => void;
  onPointerMoveClient: (clientX: number, clientY: number, toWorld: (x: number, y: number) => { x: number; y: number }) => void;
  onPointerUp: () => void;
  /** pointercancel: the browser took the gesture (OS gesture, lost
   * device). Nothing commits - a cancelled placement places nothing. */
  onPointerCancel: () => void;
}

export function useEditGestures(
  docStore: DocumentStore,
  session: SessionStore,
  sheet: WorkspaceSheet,
  kindOf: (ref: string) => string | undefined,
  zoom: number,
): EditGestures {
  const gesture = React.useRef<
    | { kind: "move"; base: Map<string, { x: number; y: number }>; nonce: string; sx: number; sy: number }
    | { kind: "marquee"; x0: number; y0: number; baseSel: ReadonlySet<string> }
    | { kind: "place"; tool: "note" | "shape" | "text"; world: { x: number; y: number } }
    | { kind: "resize"; key: string; baseW: number; baseH: number; sx: number; sy: number; nonce: string }
    | null
  >(null);
  const sheetRef = React.useRef(sheet);
  sheetRef.current = sheet;
  const marqueeRef = React.useRef(session.marquee);
  marqueeRef.current = session.marquee;

  // Keyboard: nudges coalesce under "nudge"; Delete is one edit; Escape
  // is the one-key exit; select-all covers every member.
  React.useEffect(() => {
    if (!session.editing) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        session.resetSession();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        // Every member, connections included - they are first-class
        // selectable/deletable now.
        const all = new Set(memberPositions(sheetRef.current).keys());
        for (const c of sheetRef.current.connections ?? []) all.add(`conn:${c.id}`);
        session.setSelection(all);
        return;
      }
      // History bindings live ABOVE the selection guard - undo needs no
      // selection. The store no-ops on empty stacks, so a stray press
      // cannot flip a pristine doc to "unsaved".
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) docStore.redo();
        else docStore.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        docStore.redo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        if (session.clipboard) {
          e.preventDefault();
          let pastedSel: Set<string> = new Set();
          docStore.mutateSheet(sheetRef.current.id, (s) => {
            const r = paste(s, session.clipboard!, mintId);
            pastedSel = r.selection;
            return r.sheet;
          });
          session.setSelection(pastedSel);
        }
        return;
      }
      if (session.selection.size === 0) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        session.setClipboard(copySelection(sheetRef.current, session.selection));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const clip = copySelection(sheetRef.current, session.selection);
        let pastedSel: Set<string> = new Set();
        docStore.mutateSheet(sheetRef.current.id, (s) => {
          const r = paste(s, clip, mintId);
          pastedSel = r.selection;
          return r.sheet;
        });
        session.setSelection(pastedSel);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        docStore.mutateSheet(sheetRef.current.id, (s) => deleteAnyMembers(s, session.selection));
        session.setSelection(new Set());
        return;
      }
      const step = e.shiftKey ? GRID : 1;
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = d[e.key];
      if (delta) {
        e.preventDefault();
        const base = new Map([...memberPositions(sheetRef.current)].filter(([k]) => session.selection.has(k)));
        docStore.mutateSheet(sheetRef.current.id, (s) => moveAnyMembers(s, base, delta[0], delta[1]), "nudge");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, docStore]);

  // Undo, redo, adopt and delete can all strand selection keys on
  // members that no longer exist; prune whenever the sheet changes.
  React.useEffect(() => {
    const pruned = pruneSelection(sheet, session.selection);
    if (pruned) session.setSelection(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  return {
    onMemberPointerDown: (key, e) => {
      if (!session.editing || e.button === 1) return; // middle button pans from anywhere
      e.stopPropagation();
      // Connect tool: click-A-then-B, both land in one commit; a
      // half-picked endpoint dies with resetSession.
      if (session.tool === "connect") {
        if (session.pendingFrom === null) session.setPendingFrom(key);
        else {
          const from = session.pendingFrom;
          docStore.mutateSheet(sheetRef.current.id, (s) => addConnection(s, mintId("conn-"), from, key));
          session.setPendingFrom(null);
        }
        return;
      }
      const { selection, drag } = memberPress(session.selection, key, e.shiftKey);
      session.setSelection(selection);
      if (drag) {
        const base = new Map([...memberPositions(sheetRef.current)].filter(([k]) => selection.has(k)));
        // A connections-only selection has no positions to move; an
        // empty-base "move" would still rebuild every array per pointer
        // event - junk undo entries from dragging a wire.
        if (base.size === 0) return;
        // Capture on the member (its stopPropagation means the canvas
        // never saw this press); captured events still bubble, so the
        // canvas move/up handlers keep driving the gesture.
        if (e.pointerId !== undefined) {
          (e.currentTarget as { setPointerCapture?: (id: number) => void } | undefined)?.setPointerCapture?.(e.pointerId);
        }
        gesture.current = {
          kind: "move",
          base,
          nonce: `move:${Math.floor(performance.now())}`,
          sx: e.clientX,
          sy: e.clientY,
        };
      }
    },
    onBackgroundPointerDown: (world, e) => {
      if (!session.editing) return false;
      // A placement tool armed: the placement (and its inline editor)
      // commits on pointer UP - the carried #576 lesson: an editor
      // mounted mid-press is blurred by the press's own focus action.
      if (session.tool === "note" || session.tool === "shape" || session.tool === "text") {
        gesture.current = { kind: "place", tool: session.tool, world };
        return true;
      }
      if (!e.shiftKey) session.setSelection(new Set());
      // Marquee when shift is held (multiselect); otherwise the caller
      // pans - background press clears, then the gesture decides.
      if (e.shiftKey) {
        gesture.current = { kind: "marquee", x0: world.x, y0: world.y, baseSel: session.selection };
        session.setMarquee({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
        return true;
      }
      return false;
    },
    onResizeGripPointerDown: (key, e) => {
      if (!session.editing || e.button !== 0) return;
      e.stopPropagation();
      const s = sheetRef.current;
      let base: { w: number; h: number } | null = null;
      if (key.startsWith("note:")) {
        const n = (s.notes ?? []).find((x) => `note:${x.id}` === key);
        if (n) base = { w: n.w ?? 180, h: n.h ?? 110 };
      } else if (key.startsWith("shape:")) {
        const sh = (s.shapes ?? []).find((x) => `shape:${x.id}` === key);
        if (sh) base = { w: sh.w, h: sh.h };
      }
      if (!base) return;
      if (e.pointerId !== undefined) {
        (e.currentTarget as { setPointerCapture?: (id: number) => void } | undefined)?.setPointerCapture?.(e.pointerId);
      }
      gesture.current = { kind: "resize", key, baseW: base.w, baseH: base.h, sx: e.clientX, sy: e.clientY, nonce: `resize:${Math.floor(performance.now())}` };
    },
    onPointerMoveClient: (clientX, clientY, toWorld) => {
      const g = gesture.current;
      if (!g) return;
      if (g.kind === "move") {
        docStore.mutateSheet(
          sheetRef.current.id,
          (s) => moveAnyMembers(s, g.base, (clientX - g.sx) / zoom, (clientY - g.sy) / zoom),
          g.nonce,
        );
      } else if (g.kind === "resize") {
        docStore.mutateSheet(
          sheetRef.current.id,
          (s) => resizeMember(s, g.key, g.baseW + (clientX - g.sx) / zoom, g.baseH + (clientY - g.sy) / zoom),
          g.nonce,
        );
      } else if (g.kind === "marquee") {
        const world = toWorld(clientX, clientY);
        session.setMarquee({ x0: g.x0, y0: g.y0, x1: world.x, y1: world.y });
      }
    },
    onPointerUp: () => {
      const g = gesture.current;
      if (g?.kind === "place") {
        const { tool, world } = g;
        // One press, one object: the tool disarms to "select" so the next
        // press acts on what was just made instead of placing another.
        if (tool === "note") {
          const id = mintId("note-");
          docStore.mutateSheet(sheetRef.current.id, (s) => addNote(s, id, world.x - 90, world.y - 55));
          session.setEditing2(id);
          session.setSelection(new Set([`note:${id}`]));
        } else if (tool === "shape") {
          const id = mintId("shape-");
          const v = session.shapeV === "rect" ? undefined : session.shapeV;
          docStore.mutateSheet(sheetRef.current.id, (s) => addShape(s, id, world.x - 110, world.y - 70, v));
          session.setSelection(new Set([`shape:${id}`]));
        } else {
          session.setEditing2(`text-new@${world.x},${world.y}`);
        }
        session.setTool("select");
        gesture.current = null;
        return;
      }
      if (g?.kind === "marquee" && marqueeRef.current) {
        const hits = marqueeHits(sheetRef.current, kindOf, marqueeRef.current);
        const next = new Set(g.baseSel);
        for (const h of hits) next.add(h);
        session.setSelection(next);
        session.setMarquee(null);
      }
      gesture.current = null;
    },
    onPointerCancel: () => {
      const g = gesture.current;
      gesture.current = null;
      if (g?.kind === "marquee") session.setMarquee(null);
    },
  };
}

export { cardKey };
