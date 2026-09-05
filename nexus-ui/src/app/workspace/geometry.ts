// Registered footprints - the ONLY sizes selection, fit and hit-testing
// use (carried verbatim; the card cannot grow past them). One constant,
// one home.
export const FOOTPRINTS: Record<string, { w: number; h: number }> = {
  agent: { w: 264, h: 204 },
  application: { w: 244, h: 76 },
  tool: { w: 244, h: 76 },
  "external-tool": { w: 244, h: 76 },
  person: { w: 84, h: 84 },
  human: { w: 84, h: 84 },
  group: { w: 264, h: 76 },
  "agent-bundle": { w: 268, h: 190 },
  "comm-in": { w: 300, h: 148 },
  "comm-out": { w: 300, h: 148 },
  note: { w: 180, h: 110 },
};

export function sizeOf(kind: string | undefined): { w: number; h: number } {
  return FOOTPRINTS[kind ?? "application"] ?? FOOTPRINTS.application;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.5;
export const WHEEL_FACTOR = 1.12;
export const GRID = 24;
/** Mirrors the backend validator so a drag can never write a coordinate
 * the save rejects. */
export const COORD_LIMIT = 100_000;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fit the world to content: reserve chrome margins, cap zoom at 1.1 so
 * the default state opens calm. Margins are ARGUMENTS (they encode the
 * live chrome, measured by the caller - never constants here). */
export function fitTransform(
  boxes: Box[],
  view: { w: number; h: number },
  margin: { left: number; top: number; right: number; bottom: number },
): { x: number; y: number; zoom: number } {
  if (boxes.length === 0) return { x: view.w / 2, y: view.h / 2, zoom: 1 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const availW = view.w - margin.left - margin.right;
  const availH = view.h - margin.top - margin.bottom;
  const zoom = Math.min(1.1, Math.max(MIN_ZOOM, Math.min(availW / (maxX - minX + 80), availH / (maxY - minY + 80))));
  return {
    x: margin.left + (availW - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: margin.top + (availH - (maxY - minY) * zoom) / 2 - minY * zoom,
    zoom,
  };
}

export function clampCoord(v: number): number {
  return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v));
}

/** Cursor-anchored zoom about a screen point. */
export function zoomAbout(
  t: { x: number; y: number; zoom: number },
  factor: number,
  cx: number,
  cy: number,
): { x: number; y: number; zoom: number } {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.zoom * factor));
  const k = zoom / t.zoom;
  return { x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k, zoom };
}
