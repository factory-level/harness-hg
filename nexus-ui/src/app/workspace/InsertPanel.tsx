// The insert flow (#392-#402 carried): the semantic palette lists the 8
// frozen kinds by family (no search, no whiteboard tools - drawing lives
// on the rail); picking a plan-sourced kind opens the configure step
// listing REAL plan candidates ("you cannot invent an agent by naming
// one"); placement happens in ONE transition so one undo removes it.
// Candidates are DRAGGABLE tiles - drag onto the board and the drop
// point is the placement, which becomes the selection; click stays as
// the accessible place-at-centre fallback (and selects too).
import { React } from "../../sdk";
import { AgentAvatar, Button, EmptyState, Face, Icon, IconButton } from "../../primitives";
import type { DataStore, PlanComponent } from "../../stores/data";
import type { DocumentStore, WorkspaceSheet } from "../../stores/document";
import type { SessionStore } from "../../stores/session";
import { placeCard } from "./clipboard";
import { mintId } from "./mint";
import { DOMAIN_KINDS, FAMILIES } from "./kinds";
import "./workspace.css";

export function InsertPanel({
  ds,
  docStore,
  sheet,
  session,
  center,
  onClose,
  onDragStart,
}: {
  ds: DataStore;
  docStore: DocumentStore;
  sheet: WorkspaceSheet;
  session: SessionStore;
  center: () => { x: number; y: number };
  onClose: () => void;
  onDragStart: (comp: PlanComponent, e: { clientX: number; clientY: number }) => void;
}) {
  const [pickingKind, setPickingKind] = React.useState<string | null>(null);
  const components = ds.data?.plan?.components ?? [];
  const candidates = pickingKind
    ? components.filter((c) => (c.kind ?? "application") === pickingKind || (pickingKind === "tool" && c.kind === "application"))
    : [];
  const stagger = React.useRef(0);

  const place = (ref: string) => {
    const at = center();
    const n = stagger.current++;
    let key = "";
    docStore.mutateSheet(sheet.id, (s) => {
      const r = placeCard(s, ref, at.x + (n % 5) * 36, at.y + (n % 5) * 28, mintId);
      key = r.key;
      return r.sheet;
    });
    session.setSelection(new Set([`card:${key}`]));
  };

  return (
    <aside className="nx-insert nx-pin-inline-end" aria-label="Insert">
      <header className="nx-insert-head">
        <span>Insert</span>
        <IconButton variant="ghost" size="sm" label="Close insert" icon={<Icon name="close" />} onClick={onClose} />
      </header>
      {pickingKind === null ? (
        FAMILIES.map((f) => (
          <section key={f.id}>
            <h3 className="nx-eyebrow nx-insert-family">{f.label}</h3>
            {DOMAIN_KINDS.filter((k) => k.family === f.id).map((k) => (
              <button key={k.id} type="button" className="nx-insert-kindrow" onClick={() => setPickingKind(k.id)}>
                <span className={`nx-insert-kinddot nx-insert-kinddot-${k.id}`} aria-hidden="true" />
                <span>{k.label}</span>
                <span className="nx-insert-chev"><Icon name="chevron-right" /></span>
              </button>
            ))}
          </section>
        ))
      ) : (
        <section>
          <Button variant="ghost" size="sm" label="All kinds" icon={<Icon name="chevron-left" />} onClick={() => setPickingKind(null)} />
          <h3 className="nx-eyebrow nx-insert-family">{DOMAIN_KINDS.find((k) => k.id === pickingKind)?.label}</h3>
          {candidates.length > 0 ? (
            <p className="nx-insert-hint">Drag onto the board, or click to place.</p>
          ) : null}
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              className="nx-insert-tile"
              onClick={() => place(c.id)}
              onPointerDown={(e: { clientX: number; clientY: number; button: number }) => {
                if (e.button === 0) onDragStart(c, e);
              }}
            >
              <span className="nx-insert-tileava" aria-hidden="true">
                <AgentAvatar code={c.icon} still className="nx-insert-tileart" fallback={<Face id={c.id} title={c.title ?? c.id} />} />
              </span>
              <span className="nx-insert-tilebody">
                <span className="nx-insert-tilename">{c.title ?? c.id}</span>
                <span className="nx-insert-tilekind">{c.kind ?? "application"}</span>
              </span>
            </button>
          ))}
          {candidates.length === 0 ? (
            <EmptyState
              isCompact
              title="Nothing to place"
              description={
                DOMAIN_KINDS.find((k) => k.id === pickingKind)?.planSourced
                  ? "Nothing of this kind exists in the plan — declarations create these, not the canvas."
                  : "Authorable kinds arrive with their flag-gated PR."
              }
            />
          ) : null}
        </section>
      )}
    </aside>
  );
}
