// The contextual edit bar (#398 carried): ONE bar, whatever is selected;
// items pre-filtered; member nouns resolved ("a menu never decides
// capability"); the closed action union guards affordance sprawl.
import { React } from "../../sdk";
import { Button, ButtonGroup, ToggleButton, ToggleButtonGroup, Toolbar } from "../../primitives";
import type { DocumentStore, WorkspaceSheet } from "../../stores/document";
import type { SessionStore } from "../../stores/session";
import { copySelection, paste } from "./clipboard";
import { mintId } from "./mint";
import { deleteAnyMembers, setTextSize } from "./objects";

function noun(selection: ReadonlySet<string>): string {
  if (selection.size !== 1) return `${selection.size} selected`;
  const key = [...selection][0];
  const nouns: Record<string, string> = { card: "Card", note: "Sticky note", shape: "Shape", text: "Text", conn: "Connection" };
  return nouns[key.split(":")[0]] ?? "Member";
}

export function ContextualBar({
  docStore,
  session,
  sheet,
}: {
  docStore: DocumentStore;
  session: SessionStore;
  sheet: WorkspaceSheet;
}) {
  if (!session.editing || session.selection.size === 0) return null;
  // An armed drawing tool is a different mode - selection actions would
  // be stale noise over it.
  if (session.tool !== null && session.tool !== "select") return null;
  const act = {
    copy: () => session.setClipboard(copySelection(sheet, session.selection)),
    duplicate: () => {
      const clip = copySelection(sheet, session.selection);
      let sel: Set<string> = new Set();
      docStore.mutateSheet(sheet.id, (s) => {
        const r = paste(s, clip, mintId);
        sel = r.selection;
        return r.sheet;
      });
      session.setSelection(sel);
    },
    remove: () => {
      docStore.mutateSheet(sheet.id, (s) => deleteAnyMembers(s, session.selection));
      session.setSelection(new Set());
    },
  };
  const onlyCards = [...session.selection].every((k) => k.startsWith("card:"));
  // A single selected text label gets its size steps here - "resize" for
  // a member whose box is its content.
  const only = session.selection.size === 1 ? [...session.selection][0] : null;
  const textSel = only?.startsWith("text:") ? (sheet.texts ?? []).find((t) => t.id === only.slice(5)) : null;
  return (
    <div className="nx-ctxbar nx-pin-top-center">
      <Toolbar
        label="Edit selection"
        size="sm"
        startContent={<span className="nx-ctxbar-what">{noun(session.selection)}</span>}
        endContent={
          <ButtonGroup label="Selection actions" size="sm">
            {textSel ? (
              <ToggleButtonGroup
                type="single"
                label="Text size"
                size="sm"
                value={textSel.size ?? "md"}
                onChange={(v: string | null) => {
                  if (v) docStore.mutateSheet(sheet.id, (s) => setTextSize(s, textSel.id, v as "sm" | "md" | "lg"));
                }}
              >
                <ToggleButton value="sm" label="S" tooltip="Small" />
                <ToggleButton value="md" label="M" tooltip="Medium" />
                <ToggleButton value="lg" label="L" tooltip="Large" />
              </ToggleButtonGroup>
            ) : null}
            <Button variant="ghost" label="Copy" onClick={act.copy} />
            <Button variant="ghost" label="Duplicate" onClick={act.duplicate} />
            <Button
              variant="destructive"
              label={onlyCards ? "Remove from sheet" : "Delete"}
              tooltip={onlyCards ? "Removes the reference from this sheet. Nothing deployed is touched." : undefined}
              onClick={act.remove}
            />
          </ButtonGroup>
        }
      />
    </div>
  );
}
