// Identity marks (ADR-58 §15/16, carried from the retired dashboard's
// cards.tsx): AgentAvatar tries the served art and falls back to the
// mark - the two are NEVER co-rendered. RingsMark is the brand a card
// carries, in currentColor so the consumer's hue var paints it. Face is
// the monogram tile that shows until repository icon art paints and
// REMAINS the face on 404 - a missing icon is not an error state.
import { React } from "../sdk";
import { API } from "../api";

// Read once at module load, like the old dashboard: reduced motion swaps
// every animated avatar for its committed -still twin.
const REDUCED =
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Two-letter monogram: first letters of the first two words, else the
 * first two characters. */
export function abbrOf(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
  return title.trim().slice(0, 2).toUpperCase();
}

/** Four concentric rings + a filled core - the fallback mark an agent
 * card wears when it has no avatar art. Colour rides currentColor. */
export function RingsMark({ size = 52 }: { size?: number }) {
  return (
    <svg className="nx-rings" width={size} height={size} viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r="21" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.9" />
      <circle cx="26" cy="26" r="15" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <circle cx="26" cy="26" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.42" />
      <circle cx="26" cy="26" r="4" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

/** The served avatar art (animated WebP; `-still` twin under reduced
 * motion or on request). On load failure the fallback renders INSTEAD -
 * spec: the rings are a fallback, never an underlay. */
export function AgentAvatar({
  code,
  className,
  fallback,
  still,
}: {
  code?: string;
  className?: string;
  fallback: React.ReactElement | null;
  still?: boolean;
}) {
  const [failed, setFailed] = React.useState(false);
  if (!code || failed) return fallback;
  const name = still || REDUCED ? `${code}-still` : code;
  return (
    <img
      className={className}
      src={`${API}/nexus/assets/avatars/${encodeURIComponent(name)}`}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** Monogram tile with repository icon art layered over it: the monogram
 * shows until the image paints, and remains the face when there is no
 * art to fetch. border-radius inherits so person circles stay round and
 * tool tiles stay rounded with no per-site rules. */
export function Face({ id, title }: { id: string; title: string }) {
  const [failed, setFailed] = React.useState(false);
  return (
    <span className="nx-face" aria-hidden="true">
      <span className="nx-face-mono">{abbrOf(title)}</span>
      {failed ? null : (
        <img
          className="nx-face-img"
          src={`${API}/nexus/assets/icons/${encodeURIComponent(id)}`}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
