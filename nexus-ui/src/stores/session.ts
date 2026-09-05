// SessionStore: everything that must die together (the hierarchy's
// contract) - selection, tool, marquee - with resetSession() as the ONE
// reset verb, called on mode exit, sheet switch, doc adoption, and
// navigation away from the Workspace. Selection lives HERE only.
import { React } from "../sdk";
import type { ClipboardDoc } from "../app/workspace/clipboard";

export type Tool = "select" | "note" | "shape" | "text" | "connect" | null;

/** The shape tool's armed variant; "rect" is the absent-field default
 * (SheetShape.v is only ever the other three). */
export type ShapeVariant = "rect" | "ellipse" | "diamond" | "pill";

export interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SessionStore {
  editing: boolean;
  setEditing: (on: boolean) => void;
  selection: ReadonlySet<string>;
  setSelection: (s: ReadonlySet<string>) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  /** What the armed shape tool will draw. */
  shapeV: ShapeVariant;
  setShapeV: (v: ShapeVariant) => void;
  marquee: Marquee | null;
  setMarquee: (m: Marquee | null) => void;
  /** Connect tool: the picked first endpoint awaiting its pair. */
  pendingFrom: string | null;
  setPendingFrom: (k: string | null) => void;
  /** In-flight inline editor (note/text id). */
  editing2: string | null;
  setEditing2: (id: string | null) => void;
  /** The session clipboard - deliberately not the OS clipboard: no
   * permissions prompt, and it survives the per-sheet remount. */
  clipboard: ClipboardDoc | null;
  setClipboard: (c: ClipboardDoc | null) => void;
  /** Context menu at pointer; items are pre-filtered by the opener. */
  ctxMenu: { x: number; y: number } | null;
  setCtxMenu: (m: { x: number; y: number } | null) => void;
  resetSession: () => void;
}

export function useSessionStore(): SessionStore {
  const [editing, setEditing] = React.useState(false);
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(new Set());
  const [tool, setTool] = React.useState<Tool>(null);
  const [shapeV, setShapeV] = React.useState<ShapeVariant>("rect");
  const [marquee, setMarquee] = React.useState<Marquee | null>(null);
  const [pendingFrom, setPendingFrom] = React.useState<string | null>(null);
  const [editing2, setEditing2] = React.useState<string | null>(null);
  const [clipboard, setClipboard] = React.useState<ClipboardDoc | null>(null);
  const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number } | null>(null);
  const resetSession = React.useCallback(() => {
    setSelection(new Set());
    setTool(null);
    setShapeV("rect");
    setMarquee(null);
    setPendingFrom(null); // a half-picked connection must not silently resume
    setEditing2(null);
    setCtxMenu(null);
    // the clipboard deliberately SURVIVES resets (sheet-switch paste)
  }, []);
  return { editing, setEditing, selection, setSelection, tool, setTool, shapeV, setShapeV, marquee, setMarquee, pendingFrom, setPendingFrom, editing2, setEditing2, clipboard, setClipboard, ctxMenu, setCtxMenu, resetSession };
}
