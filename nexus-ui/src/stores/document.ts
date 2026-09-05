// DocumentStore: THE workspace document - revision CAS, the undo
// reducer, and the #423 save-state machine. The pure parts carry the
// shipped semantics verbatim: bounded snapshot stack (50), coalescing
// keys (one gesture = one undo step), `adopt` clears BOTH stacks (server
// truth replaces local - undoing across someone else's save would
// resurrect state the server never had), `silent` for viewport-class
// state (a pan is not an edit), and callers name EVENTS, never target
// states.
import { React, SDK } from "../sdk";
import { API } from "../api";
import { DEMO_WORKSPACE } from "./demo";
import { fromWire, toWire, type WireWorkspace } from "./wire";

// The model below is the CLIENT's spelling of the document; the server's
// persisted spelling (nested card positions, shape/color, required text
// size, bare wire endpoints) lives in ./wire.ts, which is the only place
// the two meet. Fields the canvas does not draw yet are typed so they
// round-trip untouched rather than being dropped on save.
export interface SheetCard {
  ref: string;
  key?: string; // canvas-instance identity (#546); absent = legacy key==ref
  x: number;
  y: number;
  displayMode?: "badge" | "stack" | "expanded";
}
export interface SheetNote {
  id: string;
  x: number;
  y: number;
  text: string;
  w?: number;
  h?: number;
}
export interface SheetShape {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Absent = rect (absence-as-default: untouched documents round-trip
   * byte-identically, ADR-72). The server's full vocabulary is typed so
   * an arrow or brace written by an older UI survives a save; only the
   * first four have a drawing here. */
  v?: "rect" | "ellipse" | "diamond" | "pill" | "arrow" | "brace-l" | "brace-r";
  fill?: string; // a shapePalette token name, never a color value
  label?: string;
  rotation?: number; // whole degrees 1..359; 0 is spelled by absence
}
export interface SheetText {
  id: string;
  x: number;
  y: number;
  text: string;
  size?: "sm" | "lg"; // absent = md
  font?: string;
}
export interface SheetConnection {
  id: string;
  from: string; // selection keys - instance-scoped endpoints (#546)
  to: string;
  label?: string;
  kind?: string;
  arrows?: string;
}
/** An authored domain object (ADR-87) - persisted, not drawn yet. */
export interface SheetObject {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  url?: string;
  members?: string[];
  icon?: string;
}
/** A canvas group (ADR-72) - persisted, not drawn yet. */
export interface SheetGroup {
  id: string;
  name: string;
  members: string[];
}
export interface SheetViewport {
  x: number;
  y: number;
  zoom: number;
}
export interface WorkspaceSheet {
  id: string;
  name: string;
  mode?: "operational" | "concept";
  cards: SheetCard[];
  notes?: SheetNote[];
  shapes?: SheetShape[];
  texts?: SheetText[];
  connections?: SheetConnection[];
  viewport?: SheetViewport;
  settings?: { sourceBadges: string[] };
  objects?: SheetObject[];
  groups?: SheetGroup[];
}
export interface NexusWorkspace {
  revision: number;
  sheets: WorkspaceSheet[];
  // The server-owned header, carried so a save echoes what was read.
  apiVersion?: string;
  kind?: string;
  environment?: string;
  savedAt?: string;
  savedBy?: string;
  featureFlags?: Record<string, unknown>;
  adoptedRelationships?: boolean;
}

export const MAX_SHEETS = 8; // mirrors plugin_api._MAX_SHEETS
export const MAX_NOTES = 100; // the backend's caps, respected here
export const MAX_OBJECTS = 200; // shapes, texts and connections each

/** A server-legal sheet id from a human name: DNS-label slug (the
 * plugin's ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$, <=63) deduped with -2, -3…
 * An unusable slug falls back to "sheet" - a name is never rejected for
 * its characters. Pure so the tests pin the shapes. */
export function sheetIdFor(name: string, existing: ReadonlySet<string>): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (!slug) slug = "sheet";
  if (!existing.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** The document without one sheet, or null when that would leave none
 * (the server refuses an empty sheet list - a workspace keeps at least
 * one) or when the id names no sheet. Pure; untouched sheets keep their
 * identity so nothing re-renders for no reason. */
export function removeSheetFrom(doc: NexusWorkspace, id: string): NexusWorkspace | null {
  if (doc.sheets.length <= 1 || !doc.sheets.some((s) => s.id === id)) return null;
  return { ...doc, sheets: doc.sheets.filter((s) => s.id !== id) };
}

// ── undo reducer (pure) ────────────────────────────────────────────────
export interface Undoable<T> {
  past: T[];
  value: T;
  future: T[];
  lastKey: string | null;
}
export type UndoAction<T> =
  | { kind: "set"; value: T; coalesceKey?: string }
  | { kind: "silent"; value: T }
  | { kind: "adopt"; value: T }
  | { kind: "undo" }
  | { kind: "redo" };

const UNDO_CAP = 50;

export function undoReduce<T>(s: Undoable<T>, a: UndoAction<T>): Undoable<T> {
  switch (a.kind) {
    case "set": {
      const coalesce = a.coalesceKey !== undefined && a.coalesceKey === s.lastKey;
      const past = coalesce ? s.past : [...s.past, s.value].slice(-UNDO_CAP);
      return { past, value: a.value, future: [], lastKey: a.coalesceKey ?? null };
    }
    case "silent":
      return { ...s, value: a.value };
    case "adopt":
      return { past: [], value: a.value, future: [], lastKey: null };
    case "undo": {
      if (s.past.length === 0) return s;
      const value = s.past[s.past.length - 1];
      return { past: s.past.slice(0, -1), value, future: [s.value, ...s.future], lastKey: null };
    }
    case "redo": {
      if (s.future.length === 0) return s;
      const [value, ...future] = s.future;
      return { past: [...s.past, s.value], value, future, lastKey: null };
    }
  }
}

// ── save-state machine (pure; #423) ────────────────────────────────────
export type SaveState = "saved" | "unsaved" | "saving" | "failed" | "conflict";
/** GET /nexus/workspace serves an ENVELOPE - {workspace, canWrite,
 * role, ...} - and a 409 carries the current doc the same way. The
 * live factory taught us this the hard way (the local acceptance
 * server used to serve the doc bare and the store cast blindly; the
 * first real deployment white-screened on doc.sheets of undefined).
 * Unwrap either shape and refuse anything without a sheets array. What
 * comes back is still the WIRE spelling - run it through fromWire. */
export function unwrapWorkspace(d: unknown): WireWorkspace | null {
  const raw = (d as { workspace?: unknown })?.workspace ?? d;
  const doc = raw as WireWorkspace;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.sheets) || typeof doc.revision !== "number") {
    return null;
  }
  return doc;
}

export type SaveEvent = "edited" | "saveStarted" | "saveSucceeded" | "saveFailed" | "conflictSeen" | "adopted";

/** The HTTP status of a rejected fetchJSON error. The status FIELD is
 * the contract (our standalone shim stamps it); the anchored message
 * prefix ("503 Service Unavailable: …") is the fallback for host SDKs
 * that throw bare Errors. Anchored, so a "409" buried mid-detail can
 * never impersonate a conflict. */
export function httpStatusOf(e: unknown): number | null {
  const s = (e as { status?: unknown })?.status;
  if (typeof s === "number") return s;
  const m = /^(?:Error:\s*)?(\d{3})\b/.exec(String(e));
  return m ? Number(m[1]) : null;
}

export function nextSaveState(s: SaveState, e: SaveEvent): SaveState {
  switch (e) {
    case "edited":
      // An edit landing mid-flight is expressible: saving + edited stays
      // saving; the save handler re-marks unsaved on completion.
      return s === "saving" ? "saving" : "unsaved";
    case "saveStarted":
      return "saving";
    case "saveSucceeded":
      return "saved";
    case "saveFailed":
      return "failed";
    case "conflictSeen":
      return "conflict";
    case "adopted":
      return "saved";
  }
}

// ── the store hook ─────────────────────────────────────────────────────

export interface DocumentStore {
  doc: NexusWorkspace;
  canUndo: boolean;
  canRedo: boolean;
  saveState: SaveState;
  /** Why the last save failed (String(e)); null while none is standing. */
  saveError: string | null;
  conflict: NexusWorkspace | null;
  mutateSheet: (sheetId: string, fn: (s: WorkspaceSheet) => WorkspaceSheet, coalesceKey?: string) => void;
  silentSheet: (sheetId: string, fn: (s: WorkspaceSheet) => WorkspaceSheet) => void;
  /** Append an empty sheet; returns its id (caller navigates), or null
   * at the server's 8-sheet cap / on a blank name. One undo step. */
  addSheet: (name: string) => string | null;
  /** Remove a sheet; false when it is the last one or unknown (the
   * caller navigates away first). One undo step. */
  removeSheet: (id: string) => boolean;
  undo: () => void;
  redo: () => void;
  save: () => void;
  adopt: (doc: NexusWorkspace) => void;
  overwrite: () => void;
}

export function useDocumentStore(demo: boolean): DocumentStore {
  const [u, dispatch] = React.useReducer(
    undoReduce as (s: Undoable<NexusWorkspace>, a: UndoAction<NexusWorkspace>) => Undoable<NexusWorkspace>,
    { past: [], value: DEMO_WORKSPACE, future: [], lastKey: null },
  );
  const [saveState, setSaveState] = React.useState<SaveState>("saved");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<NexusWorkspace | null>(null);
  // The revision the SERVER last confirmed - stamped at send time so undo
  // can never submit a stale revision.
  const revisionRef = React.useRef(DEMO_WORKSPACE.revision);
  const valueRef = React.useRef(u.value);
  valueRef.current = u.value;

  React.useEffect(() => {
    if (demo) return;
    let dead = false;
    SDK.fetchJSON(`${API}/nexus/workspace`).then(
      (d) => {
        if (dead) return;
        const doc = unwrapWorkspace(d);
        if (!doc) return; // shape the store cannot adopt - demo doc stands
        revisionRef.current = doc.revision;
        dispatch({ kind: "adopt", value: fromWire(doc) });
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [demo]);

  const event = (e: SaveEvent) => setSaveState((s) => nextSaveState(s, e));

  const apply = (sheetId: string, fn: (s: WorkspaceSheet) => WorkspaceSheet, coalesceKey?: string, silent?: boolean) => {
    const cur = valueRef.current;
    const next: NexusWorkspace = {
      ...cur,
      sheets: cur.sheets.map((s) => (s.id === sheetId ? fn(s) : s)),
    };
    if (next.sheets.every((s, i) => s === cur.sheets[i])) return; // unchanged: not an edit
    if (silent) dispatch({ kind: "silent", value: next });
    else {
      dispatch({ kind: "set", value: next, coalesceKey });
      event("edited");
    }
  };

  const save = React.useCallback(() => {
    if (demo) return;
    event("saveStarted");
    setSaveError(null);
    const sent = valueRef.current;
    SDK.fetchJSON(`${API}/nexus/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toWire({ ...sent, revision: revisionRef.current })),
    }).then(
      (d) => {
        const doc = d as NexusWorkspace;
        revisionRef.current = doc.revision;
        event(valueRef.current === sent ? "saveSucceeded" : "edited");
      },
      (e) => {
        if (httpStatusOf(e) === 409) {
          event("conflictSeen");
          SDK.fetchJSON(`${API}/nexus/workspace`).then((d) => {
            const doc = unwrapWorkspace(d);
            if (doc) setConflict(fromWire(doc));
          }, () => {});
        } else {
          // A swallowed failure is a silent-loss trap: say why, both to
          // the console and to the UI (the savestate's hover detail).
          console.error("workspace save failed", e);
          setSaveError(String(e));
          event("saveFailed");
        }
      },
    );
  }, [demo]);

  return {
    doc: u.value,
    canUndo: u.past.length > 0,
    canRedo: u.future.length > 0,
    saveState,
    saveError,
    conflict,
    mutateSheet: (id, fn, key) => apply(id, fn, key),
    silentSheet: (id, fn) => apply(id, fn, undefined, true),
    addSheet: (name) => {
      const trimmed = name.trim().slice(0, 80);
      if (!trimmed) return null; // the empty commit mints nothing
      const cur = valueRef.current;
      if (cur.sheets.length >= MAX_SHEETS) return null;
      const id = sheetIdFor(trimmed, new Set(cur.sheets.map((s) => s.id)));
      dispatch({ kind: "set", value: { ...cur, sheets: [...cur.sheets, { id, name: trimmed, cards: [] }] } });
      event("edited");
      return id;
    },
    removeSheet: (id) => {
      const next = removeSheetFrom(valueRef.current, id);
      if (!next) return false;
      dispatch({ kind: "set", value: next });
      event("edited");
      return true;
    },
    undo: () => {
      // Empty-stack presses are no-ops all the way down - firing
      // "edited" here would mark a pristine doc unsaved on a stray ⌘Z.
      if (u.past.length === 0) return;
      dispatch({ kind: "undo" });
      event("edited");
    },
    redo: () => {
      if (u.future.length === 0) return;
      dispatch({ kind: "redo" });
      event("edited");
    },
    save,
    adopt: (doc) => {
      revisionRef.current = doc.revision;
      dispatch({ kind: "adopt", value: doc });
      setConflict(null);
      event("adopted");
    },
    overwrite: () => {
      if (conflict) {
        revisionRef.current = conflict.revision;
        setConflict(null);
        save();
      }
    },
  };
}
