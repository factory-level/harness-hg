// Workspace (Fleet Canvas) - PR 1 of the canvas rebuild: sheets, the
// pan/zoom world, plan-sourced cards with the three-channel grammar, and
// view-mode selection -> the shared detail drawer. Editing (tools,
// whiteboard objects, connections, selection grammar) is the next PR;
// the sheet funnel and stores are already the real ones.
import { React } from "../../sdk";
import {
  AgentAvatar,
  Banner,
  Button,
  ButtonGroup,
  ConfirmBar,
  ContextMenu,
  Drawer,
  Face,
  HealthDot,
  HoverPopover,
  Icon,
  IconButton,
  RingsMark,
  StatusPill,
  Tab,
  TabList,
  ToggleButton,
  ToggleButtonGroup,
  abbrOf,
} from "../../primitives";
import type { HealthLevel, IconName } from "../../primitives";
import { flagOn, type DataStore, type PlanComponent } from "../../stores/data";
import { useCommDoc } from "../../stores/comm";
import { useWorkspaceBindings } from "../../stores/bindings";
import { badgeModel, peopleFor } from "./badges";
import { CardBadges } from "./CardBadges";
import { MAX_SHEETS, useDocumentStore, type DocumentStore, type WorkspaceSheet } from "../../stores/document";
import { StatusWord } from "../../primitives";
import { GRID, WHEEL_FACTOR, fitTransform, sizeOf, zoomAbout } from "./geometry";
import { useSessionStore, type ShapeVariant, type Tool } from "../../stores/session";
import { useEditGestures, cardKey } from "./EditableWorld";
import { InsertPanel } from "./InsertPanel";
import { ContextualBar } from "./ContextualBar";
import { copySelection, paste, placeCard } from "./clipboard";
import { mintId } from "./mint";
import { deleteAnyMembers } from "./objects";
import { addText, connectionEnds, contentBoxes, memberPositions, noteStyle, setNoteText, setTextText, shapeFillVars } from "./objects";
import { CardDetail } from "./CardDetail";
import "./workspace.css";

export function WorkspaceView({ ds, sub }: { ds: DataStore; sub: string | null }) {
  const demo = ds.data?.demo === true;
  const data = ds.data;
  // The badge layer's shared data: the comm doc (also Alert Routing's)
  // and the workspace bindings, each null when its domain is unserved.
  const commDoc = useCommDoc(demo);
  const bindings = useWorkspaceBindings(demo, data ? flagOn(data, "repository-links") : false);
  const badgeCtx = {
    components: data?.plan?.components ?? [],
    edges: commDoc?.edges ?? null,
    bindings,
    health: ds.health,
    flags: {
      gh: data ? flagOn(data, "repository-links") : false,
      comm: data ? flagOn(data, "communication-view") : false,
      iam: data ? flagOn(data, "iam-badge") : false,
      alert: data ? flagOn(data, "alerting-badge") : false,
    },
  };
  const docStore = useDocumentStore(demo);
  // Drag-to-place from the Insert panel: gesture in a ref (no re-render
  // churn), a small state for the ghost chip. CanvasWorld registers its
  // live geometry (toWorld + rect) so the DROP lands in world coords.
  const canvasApi = React.useRef<{ toWorld: (x: number, y: number) => { x: number; y: number }; rect: () => { left: number; top: number; right: number; bottom: number } } | null>(null);
  const dragGesture = React.useRef<{ comp: PlanComponent; ox: number; oy: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = React.useState<{ title: string; kind: string; x: number; y: number } | null>(null);
  const sheets = docStore.doc.sheets;
  // Active-sheet resolution: dead bookmarks fall back to the first sheet.
  const active: WorkspaceSheet = sheets.find((s) => s.id === sub) ?? sheets[0];
  const [selected, setSelected] = React.useState<string | null>(null);
  const session = useSessionStore();
  const [invOpen, setInvOpen] = React.useState(false);
  const [addingSheet, setAddingSheet] = React.useState(false);
  // The sheet awaiting delete confirmation (by id, so a sheet renamed or
  // removed underneath the bar simply dissolves it).
  const [deletingSheet, setDeletingSheet] = React.useState<string | null>(null);
  const canWrite = ds.data?.canWrite === true || demo; // demo edits stay local
  // The bar exists only while the ORIGINAL conditions still hold - edit
  // mode, write access, and that sheet still being the active one - so a
  // confirmation armed in one context can never fire in another (Codex
  // review); and a sheet switch or leaving edit mode disarms it outright.
  const doomed = deletingSheet && canWrite && session.editing && active.id === deletingSheet ? active : null;
  React.useEffect(() => setDeletingSheet(null), [active.id, session.editing]);
  // Entering edit auto-opens the Insert library; leaving closes it.
  React.useEffect(() => setInvOpen(session.editing), [session.editing]);
  // The panel and the drawing tools are mutually exclusive - two armed
  // "what a press means" surfaces at once is the ambiguity, not either
  // one alone. Arming a drawing tool closes the panel (the reverse edge
  // lives on the Insert toggle below).
  const armedTool = session.tool;
  React.useEffect(() => {
    if (armedTool !== null && armedTool !== "select") setInvOpen(false);
  }, [armedTool]);
  // Mode-exit and sheet-switch reset transient tool state - the ONE verb.
  const activeId = active?.id;
  React.useEffect(() => session.resetSession(), [session.editing, activeId]); // eslint-disable-line
  // The world point under the last right-click - a paste from the
  // context menu lands THERE, not at a blind offset. (Hoisted above the
  // no-sheets return: hooks must not sit behind a conditional.)
  const ctxAt = React.useRef<{ x: number; y: number } | null>(null);

  const startInsertDrag = (comp: PlanComponent, e: { clientX: number; clientY: number }) => {
    dragGesture.current = { comp, ox: e.clientX, oy: e.clientY, moved: false };
  };
  const activeIdRef = React.useRef<string | null>(null);
  activeIdRef.current = active?.id ?? null;
  React.useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragGesture.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.ox, e.clientY - d.oy) <= 4) return;
      d.moved = true;
      setGhost({ title: d.comp.title ?? d.comp.id, kind: d.comp.kind ?? "application", x: e.clientX, y: e.clientY });
    };
    const up = (e: PointerEvent) => {
      const d = dragGesture.current;
      dragGesture.current = null;
      setGhost(null);
      // A press without movement is a CLICK - the tile's own onClick
      // places at centre; an abandoned drag (released off-board) writes
      // nothing.
      if (!d || !d.moved) return;
      const api = canvasApi.current;
      const sheetId = activeIdRef.current;
      if (!api || !sheetId) return;
      const r = api.rect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      // The Insert panel FLOATS over the canvas, so a release over it is
      // geometrically inside the canvas rect - but it is not the board.
      // Whatever chrome is topmost under the pointer decides.
      const topmost = document.elementFromPoint(e.clientX, e.clientY);
      if (topmost?.closest(".nx-insert, .nx-zoomisland, .nx-ws-bottombar")) return;
      const w = api.toWorld(e.clientX, e.clientY);
      const fp = sizeOf(d.comp.kind);
      let key = "";
      docStore.mutateSheet(sheetId, (s) => {
        const res = placeCard(s, d.comp.id, w.x - fp.w / 2, w.y - fp.h / 2, mintId);
        key = res.key;
        return res.sheet;
      });
      session.setSelection(new Set([`card:${key}`]));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [docStore, session]);

  if (!active) return <p className="nx-ws-mut">No sheets in the workspace document.</p>;

  const menuItems =
    session.selection.size > 0
      ? [
          { id: "copy", label: "Copy", onClick: () => session.setClipboard(copySelection(active, session.selection)) },
          {
            id: "duplicate",
            label: "Duplicate",
            onClick: () => {
              const clip = copySelection(active, session.selection);
              let sel: Set<string> = new Set();
              docStore.mutateSheet(active.id, (s) => { const r = paste(s, clip, mintId); sel = r.selection; return r.sheet; });
              session.setSelection(sel);
            },
          },
          {
            id: "delete",
            label: "Delete",
            variant: "destructive" as const,
            onClick: () => {
              docStore.mutateSheet(active.id, (s) => deleteAnyMembers(s, session.selection));
              session.setSelection(new Set());
            },
          },
        ]
      : [
          {
            id: "paste",
            label: "Paste",
            description: session.clipboard ? undefined : "Nothing copied yet",
            isDisabled: !session.clipboard,
            onClick: () => {
              if (!session.clipboard) return;
              let sel: Set<string> = new Set();
              docStore.mutateSheet(active.id, (s) => { const r = paste(s, session.clipboard!, mintId, ctxAt.current ?? undefined); sel = r.selection; return r.sheet; });
              session.setSelection(sel);
            },
          },
        ];
  return (
    <div className="nx-workspace">
      <div className="nx-ws-body nx-anchor-layer">
        {/* The right-click menu is Astryx's; view mode keeps the browser
            menu (isDisabled). Select-under-pointer stays in the canvas's
            own contextmenu handler, which runs first (inner element). */}
        <ContextMenu label="Selection actions" items={menuItems} isDisabled={!session.editing}>
          {/* key: per-sheet remount is the reset-on-switch contract */}
          <CanvasWorld key={active.id} ds={ds} docStore={docStore} sheet={active} session={session} onSelect={setSelected} onContextPoint={(p) => { ctxAt.current = p; }} badgeCtx={badgeCtx} api={canvasApi} dropTarget={ghost !== null} />
        </ContextMenu>
        {session.editing && invOpen ? (
          <InsertPanel
            ds={ds}
            docStore={docStore}
            sheet={active}
            session={session}
            center={() => {
              // The true viewport centre in world coords - the api ref is
              // live CanvasWorld geometry; the fixed point is only the
              // pre-mount fallback.
              const capi = canvasApi.current;
              if (!capi) return { x: 400, y: 300 };
              const r = capi.rect();
              return capi.toWorld((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            }}
            onClose={() => setInvOpen(false)}
            onDragStart={startInsertDrag}
          />
        ) : null}
        <span className="nx-sheetplate nx-pin-bottom-start" onPointerDown={(e: { stopPropagation: () => void }) => e.stopPropagation()}>
          
              <span className="nx-eyebrow nx-sheetstrip-label" aria-hidden="true">Sheets</span>
              <TabList
                value={active.id}
                onChange={(v: string) => { location.hash = `#/fleet/${encodeURIComponent(v)}`; }}
                aria-label="Sheets"
              >
                {sheets.map((s) => (
                  <Tab key={s.id} value={s.id} label={s.name} href={`#/fleet/${encodeURIComponent(s.id)}`} />
                ))}
              </TabList>
              {canWrite && session.editing && !addingSheet ? (
                <button
                  type="button"
                  className="nx-sheettab-add nx-sheettab-delete"
                  aria-label="Delete sheet"
                  disabled={sheets.length <= 1}
                  title={sheets.length <= 1 ? "A workspace keeps at least one sheet" : `Delete sheet "${active.name}"`}
                  onClick={() => setDeletingSheet(active.id)}
                >
                  <Icon name="trash" size={14} />
                </button>
              ) : null}
              {canWrite && !addingSheet ? (
                <button
                  type="button"
                  className="nx-sheettab-add"
                  aria-label="New sheet"
                  disabled={sheets.length >= MAX_SHEETS}
                  title={sheets.length >= MAX_SHEETS ? "8 sheets is the cap — delete or merge sheets first" : "New sheet"}
                  onClick={() => setAddingSheet(true)}
                >
                  <Icon name="add" size={14} />
                </button>
              ) : null}
              {addingSheet ? (
                <input
                  className="nx-sheettab-input"
                  autoFocus
                  placeholder="Sheet name…"
                  maxLength={80}
                  aria-label="New sheet name"
                  onKeyDown={(e: { key: string; currentTarget: { value: string; blur: () => void } }) => {
                    if (e.key === "Escape") {
                      setAddingSheet(false);
                      return;
                    }
                    if (e.key === "Enter") {
                      const id = docStore.addSheet(e.currentTarget.value);
                      setAddingSheet(false);
                      if (id) location.hash = `#/fleet/${encodeURIComponent(id)}`;
                    }
                  }}
                  onBlur={() => {
                    // Blur CANCELS. It used to commit - but a blur is
                    // ambiguous intent, and clicking the canvas
                    // mid-thought minted a sheet AND navigated to it.
                    // Enter is the one commit.
                    setAddingSheet(false);
                  }}
                />
              ) : null}
            
        </span>
        <span className="nx-island nx-ctrlisland nx-pin-bottom-center" onPointerDown={(e: { stopPropagation: () => void }) => e.stopPropagation()}>
          <span className="nx-ws-toolbar">
              {session.editing ? (
                <span className="nx-ws-rail">
                  <ToggleButton
                    label="Insert"
                    icon={<Icon name="insert" className="nx-railglyph" />}
                    tooltip="Place components from the plan"
                    size="sm"
                    isPressed={invOpen}
                    onPressedChange={(p: boolean) => {
                      setInvOpen(p);
                      // Opening the library disarms a drawing tool - the
                      // exclusivity's reverse edge.
                      if (p && session.tool !== null && session.tool !== "select") session.setTool("select");
                    }}
                  />
                  <span className="nx-ws-raildiv" aria-hidden="true" />
                  <ToggleButtonGroup
                    type="single"
                    label="Tools"
                    size="sm"
                    value={session.tool}
                    onChange={(v: string | null) => session.setTool(v as Tool | null)}
                  >
                    {(
                      [
                        { id: "select", label: "Select", icon: "select", tip: "Marquee-select members" },
                        { id: "note", label: "Note", icon: "note", tip: "Sticky note (human-authored paper)" },
                        { id: "shape", label: "Shape", icon: "shape", tip: "Draw a region" },
                        { id: "text", label: "Text", icon: "text", tip: "Text label" },
                        { id: "connect", label: "Connect", icon: "connect", tip: "Wire two members: click A, then B" },
                      ] as { id: Exclude<Tool, null>; label: string; icon: IconName; tip: string }[]
                    ).map((tl) => (
                      <ToggleButton
                        key={tl.id}
                        value={tl.id}
                        label={tl.label}
                        icon={<Icon name={tl.icon} className="nx-railglyph" />}
                        tooltip={tl.tip}
                      />
                    ))}
                  </ToggleButtonGroup>
                  {session.tool === "shape" ? (
                    <>
                      {/* The armed shape tool's variant pop-out
                          (inventory :102) - inline in the rail, so the
                          choice sits beside the tool that consumes it. */}
                      <span className="nx-ws-raildiv" aria-hidden="true" />
                      <ToggleButtonGroup
                        type="single"
                        label="Shape variant"
                        size="sm"
                        value={session.shapeV}
                        onChange={(v: string | null) => {
                          if (v) session.setShapeV(v as ShapeVariant);
                        }}
                      >
                        {(
                          [
                            { id: "rect", label: "Rectangle", icon: "shape-rect" },
                            { id: "ellipse", label: "Ellipse", icon: "shape-ellipse" },
                            { id: "diamond", label: "Diamond", icon: "shape-diamond" },
                            { id: "pill", label: "Pill", icon: "shape-pill" },
                          ] as { id: ShapeVariant; label: string; icon: IconName }[]
                        ).map((sv) => (
                          <ToggleButton
                            key={sv.id}
                            value={sv.id}
                            label={sv.label}
                            icon={<Icon name={sv.icon} className="nx-railglyph" />}
                            tooltip={sv.label}
                          />
                        ))}
                      </ToggleButtonGroup>
                    </>
                  ) : null}
                </span>
              ) : null}
              {canWrite ? (
                <span className={session.editing ? undefined : "nx-editcta"}>
                  <ToggleButton
                    label={session.editing ? "Done" : "Edit board"}
                    icon={<Icon name="edit" />}
                    pressedIcon={<Icon name="check" />}
                    size="sm"
                    isPressed={session.editing}
                    onPressedChange={(p: boolean) => session.setEditing(p)}
                  />
                </span>
              ) : null}
              {session.editing ? (
                <ButtonGroup label="History" size="sm">
                  <IconButton label="Undo" icon={<Icon name="undo" />} isDisabled={!docStore.canUndo} onClick={docStore.undo} />
                  <IconButton label="Redo" icon={<Icon name="redo" />} isDisabled={!docStore.canRedo} onClick={docStore.redo} />
                </ButtonGroup>
              ) : null}
            </span>
          <span className="nx-ws-savestate" title={docStore.saveError ?? undefined}>
              {demo ? (
                // Demo edits never leave the tab; the Save button was a
                // dead control here ("Unsaved changes" forever). Say so.
                <StatusWord state={docStore.saveState === "saved" ? "saved" : "local"} />
              ) : docStore.saveState === "unsaved" || docStore.saveState === "failed" ? (
                <Button variant="primary" size="sm" label="Save" endContent={<StatusWord state={docStore.saveState} />} clickAction={docStore.save} />
              ) : (
                <StatusWord state={docStore.saveState} />
              )}
            </span>
        </span>
      </div>
      {ghost ? (
        <span className={`nx-drag-ghost nx-dragchip nx-cd-${ghost.kind}`} style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">
          {ghost.title}
        </span>
      ) : null}
      <ContextualBar docStore={docStore} session={session} sheet={active} />
      {doomed ? (
        <ConfirmBar
          title={`Delete sheet "${doomed.name}"?`}
          description="Removes this sheet and its references. Nothing deployed is touched; Undo restores it until you save."
          confirmLabel="Delete sheet"
          onCancel={() => setDeletingSheet(null)}
          onConfirm={() => {
            // Land on the previous tab (else the first survivor) BEFORE
            // the sheet goes, so the active-sheet fallback never flickers.
            const idx = sheets.findIndex((s) => s.id === doomed.id);
            const neighbour = sheets[idx - 1] ?? sheets.find((s) => s.id !== doomed.id);
            setDeletingSheet(null);
            if (neighbour) location.hash = `#/fleet/${encodeURIComponent(neighbour.id)}`;
            docStore.removeSheet(doomed.id);
          }}
        />
      ) : null}
      {docStore.conflict ? (
        <Banner
          status="warning"
          title="Workspace conflict"
          description="Someone saved a newer workspace revision."
          endContent={
            <ButtonGroup label="Conflict resolution" size="sm">
              <Button label="Load theirs" onClick={() => docStore.adopt(docStore.conflict!)} />
              <Button variant="destructive" label="Overwrite" onClick={docStore.overwrite} />
            </ButtonGroup>
          }
        />
      ) : null}
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={ds.data?.plan?.components.find((c) => c.id === selected)?.title ?? selected ?? ""}
      >
        {selected ? (
          (() => {
            const comp = ds.data?.plan?.components.find((c) => c.id === selected);
            return comp ? <CardDetail ds={ds} comp={comp} /> : <p className="nx-ws-mut">No longer in the plan.</p>;
          })()
        ) : null}
      </Drawer>
    </div>
  );
}

function CanvasWorld({
  ds,
  docStore,
  sheet,
  session,
  onSelect,
  onContextPoint,
  badgeCtx,
  api,
  dropTarget,
}: {
  ds: DataStore;
  docStore: DocumentStore;
  sheet: WorkspaceSheet;
  session: ReturnType<typeof useSessionStore>;
  onSelect: (ref: string) => void;
  onContextPoint: (p: { x: number; y: number }) => void;
  badgeCtx: Parameters<typeof badgeModel>[1];
  api: { current: { toWorld: (x: number, y: number) => { x: number; y: number }; rect: () => { left: number; top: number; right: number; bottom: number } } | null };
  dropTarget: boolean;
}) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [t, setT] = React.useState(() => sheet.viewport ?? { x: 0, y: 0, zoom: 1 });
  const fitted = React.useRef(sheet.viewport === undefined);
  const drag = React.useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const reportTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const kindOf = (ref: string) => ds.data?.plan?.components.find((p) => p.id === ref)?.kind;
  const gestures = useEditGestures(docStore, session, sheet, kindOf, t.zoom);
  // The connect tool's live wire: the free end follows the pointer while
  // an endpoint is pending. Feedback only - commit stays click-A-then-B.
  const [wireEnd, setWireEnd] = React.useState<{ x: number; y: number } | null>(null);
  React.useEffect(() => {
    if (session.pendingFrom === null) setWireEnd(null);
  }, [session.pendingFrom]);
  const toWorld = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - t.x) / t.zoom, y: (clientY - r.top - t.y) / t.zoom };
  };
  // Expose live geometry to the drag-to-place layer above (the Insert
  // panel is a sibling; the drop must land in THIS world's coords).
  React.useEffect(() => {
    api.current = { toWorld, rect: () => wrapRef.current!.getBoundingClientRect() };
    return () => {
      api.current = null;
    };
  });

  // Auto-fit when no authored viewport - ONCE, at mount (the per-sheet
  // remount is what makes mount-scoped correct; refitting on document
  // changes would move the world under an in-flight drag).
  React.useEffect(() => {
    if (!fitted.current || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    // Fit EVERY positioned member, not just cards - a notes-and-shapes
    // sheet must not open with its content off-screen.
    const boxes = contentBoxes(sheet, sizeOf, kindOf);
    setT(fitTransform(boxes, { w: r.width, h: r.height }, { left: 24, top: 24, right: 24, bottom: 72 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Viewport persists silently, debounced - a pan is not an edit.
  const report = (next: { x: number; y: number; zoom: number }) => {
    if (reportTimer.current) clearTimeout(reportTimer.current);
    reportTimer.current = setTimeout(() => {
      docStore.silentSheet(sheet.id, (s) => ({ ...s, viewport: next }));
    }, 400);
  };

  const onWheel = (e: { deltaY: number; clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const next = zoomAbout(t, e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR, e.clientX - r.left, e.clientY - r.top);
    fitted.current = false;
    setT(next);
    report(next);
  };
  // React ≥17 delegates wheel as a PASSIVE root listener, so a JSX
  // onWheel's preventDefault is a silent no-op - trackpad pinch zoomed
  // the page along with the canvas. A native non-passive listener is
  // the only way to actually claim the gesture; the ref indirection
  // keeps the mount-scoped effect from closing over a stale transform.
  const wheelRef = React.useRef(onWheel);
  wheelRef.current = onWheel;
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      wheelRef.current(e);
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  // Space-hold pan (edit mode): placement is suppressed while held, the
  // press goes straight to pan. Repeat, editors and focused buttons are
  // exempt; a window blur can never wedge the mode on.
  const [spacePan, setSpacePan] = React.useState(false);
  React.useEffect(() => {
    if (!session.editing) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      e.preventDefault();
      setSpacePan(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpacePan(false);
    };
    const off = () => setSpacePan(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", off);
      setSpacePan(false);
    };
  }, [session.editing]);

  const onPointerDown = (e: { button: number; shiftKey: boolean; clientX: number; clientY: number; pointerId: number }) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0 && session.editing && !spacePan) {
      // Background press in edit mode: clears selection, then shift
      // starts a marquee; a plain press falls through to pan.
      const claimed = gestures.onBackgroundPointerDown(toWorld(e.clientX, e.clientY), e);
      if (claimed) {
        // Capture so the gesture survives leaving the canvas or passing
        // under floating chrome; the browser releases on pointer up.
        wrapRef.current?.setPointerCapture(e.pointerId);
        return;
      }
    }
    wrapRef.current?.setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y };
  };
  const onPointerMove = (e: { clientX: number; clientY: number }) => {
    gestures.onPointerMoveClient(e.clientX, e.clientY, toWorld);
    if (session.pendingFrom !== null) setWireEnd(toWorld(e.clientX, e.clientY));
    if (!drag.current) return;
    fitted.current = false;
    const next = { ...t, x: drag.current.ox + e.clientX - drag.current.sx, y: drag.current.oy + e.clientY - drag.current.sy };
    setT(next);
  };
  const onPointerUp = () => {
    gestures.onPointerUp();
    if (drag.current) report(t);
    drag.current = null;
  };
  // A cancelled pointer must not COMMIT anything - pointerup places, a
  // cancel abandons (the browser took the gesture: OS gesture, lost
  // device, interrupted touch).
  const onPointerCancel = () => {
    gestures.onPointerCancel();
    if (drag.current) report(t);
    drag.current = null;
  };
  // Space-pan must beat member presses too: their own handlers
  // stopPropagation, so the bypass has to happen at the member.
  const memberDown = (key: string, e: never) => {
    if (spacePan) return; // fall through: the canvas press pans
    gestures.onMemberPointerDown(key, e);
  };
  // The corner resize grip - rendered on a SELECTED note/shape while no
  // drawing tool is armed (the same condition under which the
  // ContextualBar shows: selection actions, not tool actions).
  const grip = (k: string) =>
    session.editing && session.selection.has(k) && (session.tool === null || session.tool === "select") ? (
      <span
        className="nx-grip"
        aria-hidden="true"
        onPointerDown={(e: never) => {
          if (spacePan) return;
          gestures.onResizeGripPointerDown(k, e);
        }}
      />
    ) : null;

  const statusless = sheet.mode === "concept";
  /** One size resolver for every member key - edges and the live wire
   * must agree on centres. */
  const sizeOfKey = (key: string) => {
    if (key.startsWith("card:")) {
      const card = sheet.cards.find((x) => `card:${x.key ?? x.ref}` === key);
      return sizeOf(kindOf(card?.ref ?? ""));
    }
    if (key.startsWith("note:")) {
      const n = (sheet.notes ?? []).find((x) => `note:${x.id}` === key);
      return { w: n?.w ?? 180, h: n?.h ?? 110 };
    }
    if (key.startsWith("shape:")) {
      const sh = (sheet.shapes ?? []).find((x) => `shape:${x.id}` === key);
      return { w: sh?.w ?? 220, h: sh?.h ?? 140 };
    }
    return { w: 120, h: 24 };
  };
  // Armed tools change what a press means - the cursor must say so, and
  // placement tools claim the press even over a card (click-through).
  const placing = session.editing && session.tool !== null && session.tool !== "select";
  const placeThrough = session.editing && (session.tool === "note" || session.tool === "shape" || session.tool === "text");

  return (
    <div
      ref={wrapRef}
      className={`nx-canvas nx-anchor-layer${placing && !spacePan ? " nx-canvas-placing" : ""}${placeThrough && !spacePan ? " nx-canvas-placing-through" : ""}${dropTarget ? " nx-canvas-droppable" : ""}${spacePan ? " nx-canvas-spacepan" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e: { target: unknown; clientX: number; clientY: number }) => {
        // View mode keeps the browser menu (the wrapping ContextMenu is
        // disabled there). In edit mode this runs BEFORE the wrapper's
        // own handler: select-under-pointer + remember the world point
        // (a paste lands there), then Astryx opens the menu.
        if (!session.editing) return;
        onContextPoint(toWorld(e.clientX, e.clientY));
        const el = (e.target as HTMLElement).closest?.("[data-nx-key]") as HTMLElement | null;
        if (el) {
          const key = el.dataset["nxKey"]!;
          if (!session.selection.has(key)) session.setSelection(new Set([key]));
        }
      }}
      // The dot grid follows the transform - background vars, no repaint.
      style={{
        backgroundSize: `${GRID * t.zoom}px ${GRID * t.zoom}px`,
        backgroundPosition: `${t.x}px ${t.y}px`,
      }}
    >
      <span
        className="nx-island nx-zoomisland nx-pin-top-start"
        onPointerDown={(e: { stopPropagation: () => void }) => e.stopPropagation()}
      >
        <IconButton
          variant="ghost"
          size="sm"
          label="Zoom in"
          icon={<Icon name="zoom-in" />}
          onClick={() => {
            const r = wrapRef.current!.getBoundingClientRect();
            const next = zoomAbout(t, WHEEL_FACTOR, r.width / 2, r.height / 2);
            fitted.current = false;
            setT(next);
            report(next);
          }}
        />
        <IconButton
          variant="ghost"
          size="sm"
          label="Zoom out"
          icon={<Icon name="zoom-out" />}
          onClick={() => {
            const r = wrapRef.current!.getBoundingClientRect();
            const next = zoomAbout(t, 1 / WHEEL_FACTOR, r.width / 2, r.height / 2);
            fitted.current = false;
            setT(next);
            report(next);
          }}
        />
        <IconButton
          variant="ghost"
          size="sm"
          label="Fit to content"
          icon={<Icon name="fit" />}
          onClick={() => {
            const r = wrapRef.current!.getBoundingClientRect();
            const next = fitTransform(contentBoxes(sheet, sizeOf, kindOf), { w: r.width, h: r.height }, { left: 24, top: 24, right: 24, bottom: 72 });
            fitted.current = false;
            setT(next);
            report(next);
          }}
        />
      </span>
      <div className="nx-world" style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.zoom})` }}>
        {sheet.cards.map((c) => {
          const comp = ds.data?.plan?.components.find((p) => p.id === c.ref);
          const kind = comp?.kind ?? "application";
          const { w, h } = sizeOf(kind);
          const level = (ds.health?.components?.[c.ref]?.level ?? "unknown") as HealthLevel;
          const orphan = !comp;
          const k = cardKey(c);
          const isSelected = session.selection.has(k);
          return (
            <button
              key={c.key ?? c.ref}
              type="button"
              className={`nx-cardnode nx-world-item nx-cardnode-${kind}${orphan ? " nx-cardnode-orphan" : ""}${isSelected ? " nx-cardnode-selected" : ""}`}
              data-nx-key={k}
              data-pending={session.pendingFrom === k ? "true" : undefined}
              style={{ left: c.x, top: c.y, width: w, height: h }}
              onPointerDown={(e: never) => memberDown(k, e)}
              onClick={() => (session.editing || orphan ? undefined : onSelect(c.ref))}
              aria-label={comp?.title ?? `${c.ref} (unresolved)`}
            >
              {!statusless && !orphan && (kind === "agent" || kind === "tool" || kind === "application") ? (
                <HoverPopover
                  label={`Status — ${comp?.title ?? c.ref}`}
                  content={
                    <div className="nx-bpop">
                      <StatusPill level={level}>{level}</StatusPill>
                      {ds.health?.components?.[c.ref]?.summary ? (
                        <p className="nx-bpop-note">{ds.health.components[c.ref].summary}</p>
                      ) : null}
                    </div>
                  }
                >
                  {(hover: Record<string, unknown>) => (
                    <span {...hover} className="nx-cardnode-bead nx-fixture">
                      <HealthDot level={level} small />
                    </span>
                  )}
                </HoverPopover>
              ) : null}
              {orphan ? (
                <>
                  <span className="nx-cardnode-title">{c.ref}</span>
                  <span className="nx-ws-mut">no longer in the plan</span>
                </>
              ) : (
                <>
                  <CardFace comp={comp!} kind={kind} bundles={ds.data?.bundles} titleOf={(id) => ds.data?.plan?.components.find((p) => p.id === id)?.title ?? id} />
                  {!statusless ? (
                    <CardBadges
                      model={badgeModel(comp!, badgeCtx)}
                      title={comp!.title ?? comp!.id}
                      people={peopleFor(comp!.id, badgeCtx.components)}
                    />
                  ) : null}
                </>
              )}
            </button>
          );
        })}
        {(sheet.shapes ?? []).map((sh) => {
          const k = `shape:${sh.id}`;
          return (
            <span
              key={sh.id}
              className={`nx-shape nx-world-item nx-shape-${sh.v ?? "rect"}${session.selection.has(k) ? " nx-cardnode-selected" : ""}`}
              data-nx-key={k}
              data-pending={session.pendingFrom === k ? "true" : undefined}
              style={{ left: sh.x, top: sh.y, width: sh.w, height: sh.h, ...shapeFillVars(sh.fill) } as React.CSSProperties}
              onPointerDown={(e: never) => memberDown(k, e)}
            >
              {sh.label ?? ""}
              {grip(k)}
            </span>
          );
        })}
        {/* The edge layer sits AFTER the shapes in the DOM: same z
            token, so document order decides - wires draw over regions
            (pencil over highlighter), never drowned by a fill. */}
        <svg className="nx-edgelayer nx-world-item" aria-hidden="true">
          {(sheet.connections ?? []).map((c) => {
            const ends = connectionEnds(sheet, sizeOfKey, c);
            if (!ends) return null; // dangling refs simply do not render
            const ck = `conn:${c.id}`;
            return (
              <React.Fragment key={c.id}>
                <line className={`nx-edge${session.selection.has(ck) ? " nx-edge-selected" : ""}`} x1={ends.x1} y1={ends.y1} x2={ends.x2} y2={ends.y2} />
                {/* The invisible fat twin: the forgiving hit target that
                    makes the wire selectable (and so deletable). */}
                <line
                  className="nx-edge-hit"
                  data-nx-key={ck}
                  x1={ends.x1}
                  y1={ends.y1}
                  x2={ends.x2}
                  y2={ends.y2}
                  onPointerDown={(e: never) => memberDown(ck, e)}
                />
              </React.Fragment>
            );
          })}
          {(() => {
            // The connect tool's live wire: provisional by material
            // (edit-accent, dashed) - it never carries a label.
            if (session.pendingFrom === null || wireEnd === null) return null;
            const a = memberPositions(sheet).get(session.pendingFrom);
            if (!a) return null;
            const sa = sizeOfKey(session.pendingFrom);
            return <line className="nx-wire" x1={a.x + sa.w / 2} y1={a.y + sa.h / 2} x2={wireEnd.x} y2={wireEnd.y} />;
          })()}
        </svg>
        {(sheet.notes ?? []).map((n) => {
          const st = noteStyle(n.id);
          const k = `note:${n.id}`;
          return (
            <span
              key={n.id}
              className={`nx-note nx-world-item${st.alt ? " nx-note-alt" : ""}${session.selection.has(k) ? " nx-cardnode-selected" : ""}`}
              data-nx-key={k}
              data-pending={session.pendingFrom === k ? "true" : undefined}
              style={{ left: n.x, top: n.y, width: n.w ?? 180, minHeight: n.h ?? 110, rotate: `${st.tilt}deg` }}
              onPointerDown={(e: never) => {
                // A press inside the open editor is text selection, not a
                // move - swallow it (letting it fall through to the canvas
                // would clear selection and pan under the caret).
                const ev = e as { target: unknown; stopPropagation: () => void };
                if ((ev.target as HTMLElement)?.closest?.(".nx-note-editor")) {
                  ev.stopPropagation();
                  return;
                }
                memberDown(k, e);
              }}
              onDoubleClick={() => session.editing && session.setEditing2(n.id)}
            >
              {session.editing2 === n.id ? (
                <textarea
                  className="nx-note-editor"
                  autoFocus
                  defaultValue={n.text}
                  maxLength={2000}
                  onBlur={(e: { target: { value: string } }) => {
                    docStore.mutateSheet(sheet.id, (s) => setNoteText(s, n.id, e.target.value));
                    session.setEditing2(null);
                  }}
                  onKeyDown={(e: { key: string; currentTarget: { blur: () => void } }) => {
                    // Escape COMMITS via blur (discarding typed text was
                    // the silent-loss bug); a second Escape then reaches
                    // the window handler and clears the selection.
                    if (e.key === "Escape") e.currentTarget.blur();
                  }}
                />
              ) : (
                n.text || "…"
              )}
              {grip(k)}
            </span>
          );
        })}
        {(sheet.texts ?? []).map((tx) => {
          const k = `text:${tx.id}`;
          if (session.editing2 === `text@${tx.id}`) {
            // In-place editor for an EXISTING label (the text-new@ input
            // below covers only fresh ones). Clearing the text deletes
            // the label - setTextText's contract.
            return (
              <input
                key={tx.id}
                className="nx-textlabel nx-textlabel-editor nx-world-item"
                style={{ left: tx.x, top: tx.y }}
                autoFocus
                defaultValue={tx.text}
                onBlur={(e: { target: { value: string } }) => {
                  docStore.mutateSheet(sheet.id, (s) => setTextText(s, tx.id, e.target.value));
                  session.setEditing2(null);
                }}
                onKeyDown={(e: { key: string; currentTarget: { blur: () => void } }) => {
                  if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                }}
              />
            );
          }
          return (
            <span
              key={tx.id}
              className={`nx-textlabel nx-world-item nx-textlabel-${tx.size ?? "md"}${session.selection.has(k) ? " nx-cardnode-selected" : ""}`}
              data-nx-key={k}
              data-pending={session.pendingFrom === k ? "true" : undefined}
              style={{ left: tx.x, top: tx.y }}
              onPointerDown={(e: never) => memberDown(k, e)}
              onDoubleClick={() => session.editing && session.setEditing2(`text@${tx.id}`)}
            >
              {tx.text}
            </span>
          );
        })}
        {session.editing2?.startsWith("text-new@") ? (
          <input
            className="nx-textlabel nx-textlabel-editor nx-world-item"
            style={{
              left: Number(session.editing2.slice(9).split(",")[0]),
              top: Number(session.editing2.slice(9).split(",")[1]),
            }}
            autoFocus
            onBlur={(e: { target: { value: string } }) => {
              const [x, y] = session.editing2!.slice(9).split(",").map(Number);
              const text = e.target.value;
              // The empty commit mints nothing.
              const id = mintId("text-");
              docStore.mutateSheet(sheet.id, (s) => addText(s, id, x, y, text));
              if (text.trim()) session.setSelection(new Set([`text:${id}`]));
              session.setEditing2(null);
            }}
            onKeyDown={(e: { key: string; currentTarget: { blur: () => void } }) => {
              if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
            }}
          />
        ) : null}
        {session.marquee ? (
          <span
            className="nx-marquee nx-world-item"
            style={{
              left: Math.min(session.marquee.x0, session.marquee.x1),
              top: Math.min(session.marquee.y0, session.marquee.y1),
              width: Math.abs(session.marquee.x1 - session.marquee.x0),
              height: Math.abs(session.marquee.y1 - session.marquee.y0),
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The per-kind card face (ADR-58, restored): what renders INSIDE the
 * one card element. Kind decides the face; the shell (bead, selection,
 * gestures, aria) stays identical for every kind. */
function CardFace({
  comp,
  kind,
  bundles,
  titleOf,
}: {
  comp: PlanComponent;
  kind: string;
  bundles?: { id: string; title?: string; members?: string[] }[];
  titleOf: (id: string) => string;
}) {
  const title = comp.title ?? comp.id;
  if (kind === "agent") {
    return (
      <>
        <span className="nx-cardnode-head">
          <AgentAvatar code={comp.icon} className="nx-ava-overhang nx-fixture" fallback={<span className="nx-rings-overhang nx-fixture"><RingsMark size={40} /></span>} />
        </span>
        <span className="nx-cardnode-title">{title}</span>
        {comp.description ? <span className="nx-cardnode-desc">{comp.description}</span> : null}
        <span className="nx-cardnode-sub">{kind}</span>
      </>
    );
  }
  if (kind === "person") {
    return (
      <>
        <span className="nx-cardnode-mono">{abbrOf(title)}</span>
        <span className="nx-cardnode-personlabel nx-fixture">
          <span className="nx-cardnode-title">{title}</span>
          <span className="nx-cardnode-sub">Person · {comp.personTitle ?? "member"}</span>
        </span>
      </>
    );
  }
  if (kind === "agent-bundle") {
    const members = bundles?.find((b) => b.id === comp.id)?.members ?? [];
    return (
      <>
        {members.length === 0 ? (
          <span className="nx-hand-ghost">no members declared</span>
        ) : (
          <span className="nx-hand">
            {members.slice(0, 4).map((m, i) => (
              <span key={m} className={`nx-hand-card nx-hand-c${i} nx-fixture`}>
                {i === Math.min(members.length, 4) - 1 ? <span className="nx-hand-name">{titleOf(m)}</span> : null}
              </span>
            ))}
          </span>
        )}
        <span className="nx-cardnode-title">{title}</span>
        <span className="nx-cardnode-sub">{members.length === 1 ? "1 member" : `${members.length} members`}</span>
      </>
    );
  }
  if (kind === "comm-in" || kind === "comm-out") {
    return (
      <>
        <span className="nx-cardnode-sub">{kind === "comm-in" ? <><Icon name="arrow-right" size={12} /> inbound</> : <>outbound <Icon name="arrow-right" size={12} /></>}</span>
        <span className="nx-cardnode-title">{title}</span>
        {comp.description ? <span className="nx-cardnode-desc">{comp.description}</span> : null}
      </>
    );
  }
  // The plaque family: tool, application, external-tool, group - and any
  // kind the registry does not know, which reads as a plain nameplate.
  return (
    <>
      <AgentAvatar code={comp.icon} className="nx-tile-ava" fallback={<Face id={comp.id} title={title} />} />
      <span className="nx-cardnode-body">
        <span className="nx-cardnode-title">{title}</span>
        <span className="nx-cardnode-sub">{kind}</span>
      </span>
    </>
  );
}
