// The health grammar: server-computed levels rendered verbatim - these
// components NEVER derive a level (the truth model in the interaction
// spec). Custom by decision: hollow-dashed unknown, paper-knockout bead
// and the #423 save words are tested product contracts Astryx cannot ship.
import { React } from "../sdk";
import "./primitives.css";

export type HealthLevel = "healthy" | "degraded" | "unhealthy" | "unknown" | "paused";

export function HealthDot({ level, small }: { level: HealthLevel; small?: boolean }) {
  return (
    <span
      className={`nx-dot nx-dot-${level}${small ? " nx-dot-small" : ""}`}
      role="img"
      aria-label={`status: ${level}`}
    />
  );
}

export function StatusPill({ level, children }: { level: HealthLevel; children?: unknown }) {
  return (
    <span className={`nx-pill nx-pill-${level}`}>
      <HealthDot level={level} small />
      {(children ?? level) as React.ReactNode}
    </span>
  );
}

export type SaveState = "saved" | "unsaved" | "saving" | "failed" | "conflict";
/** "local" is presentation-only (demo mode edits never leave the tab);
 * the document store's SaveState union mirrors the wire contract and
 * does not carry it. */
export type SaveWord = SaveState | "local";

const SAVE_WORD: Record<SaveWord, { word: string; tone: "" | "attention" | "alarm" }> = {
  saved: { word: "Saved", tone: "" },
  saving: { word: "Saving…", tone: "" },
  unsaved: { word: "Unsaved changes", tone: "attention" },
  failed: { word: "Save failed", tone: "alarm" },
  conflict: { word: "Conflict", tone: "alarm" },
  local: { word: "Local only (demo)", tone: "attention" },
};

export function StatusWord({ state }: { state: SaveWord }) {
  const { word, tone } = SAVE_WORD[state];
  return <span className={`nx-savestate${tone ? ` nx-savestate-${tone}` : ""}`}>{word}</span>;
}

/** Ownership marker - control-plane-owned. NEVER a health color (#554). */
export function OwnershipSphere() {
  return <span className="nx-own-sphere" role="img" aria-label="control-plane owned" />;
}
