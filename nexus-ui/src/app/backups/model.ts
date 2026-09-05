// Backups pure model - the honesty rules as functions, fixture-tested.
// Contracts carried from the shipping view (ADR-52/59/122/123, #582,
// #553, #418): schedule health and artifact verification are two facts
// never merged; aggregation never derivation (empty = unknown); the
// control plane is explicit per-component; cron prose never guesses.

export interface BackupRun {
  name: string;
  state: string;
  startedAt?: string;
}
export interface BackupRoutine {
  id: string;
  title: string;
  componentTitle?: string;
  component?: string;
  namespace?: string;
  group?: string;
  bundle?: string;
  bundleTitle?: string;
  schedule?: string;
  retention?: string;
  destination?: string;
  /** The sink PVC this routine fills; the ledger's "unprotected by
   * design" rationale for it rides along instead of a second row. */
  sink?: string;
  sinkReason?: string;
  protects?: string[];
  restore?: string;
  state: string; // schedule axis
  level: string; // served level - the browser never derives one
  artifact?: { state?: string };
  lastSuccess?: string;
  reason?: string;
  runs?: BackupRun[];
}
export interface UnprotectedComponent {
  id: string;
  title: string;
  kind?: string;
  level?: string;
  reason?: string;
  bundle?: string;
}
export interface BackupsDoc {
  routines: BackupRoutine[];
  unprotected: UnprotectedComponent[];
  counts?: { routines?: number };
  observedAt?: string;
}

// The two pill vocabularies - two DIFFERENT facts, never merged.
export const SCHEDULE_PILL: Record<string, { word: string; level: string }> = {
  healthy: { word: "On schedule", level: "healthy" },
  running: { word: "Running", level: "healthy" },
  late: { word: "Late", level: "degraded" },
  failed: { word: "Failing", level: "unhealthy" },
  disabled: { word: "Disabled", level: "paused" },
  never: { word: "Never run", level: "unknown" },
  archived: { word: "Archived", level: "paused" },
  declarative: { word: "Rebuilt from Git", level: "healthy" },
  ephemeral: { word: "Ephemeral · by design", level: "healthy" },
};
export const ARTIFACT_PILL: Record<string, { word: string; level: string }> = {
  restorable: { word: "Restorable", level: "healthy" },
  unmeasured: { word: "Unmeasured", level: "unknown" },
  unproven: { word: "Not restore-proven", level: "degraded" },
  declarative: { word: "Rebuilt from Git", level: "healthy" },
  none: { word: "Not backed up · by design", level: "paused" },
};

/** ONE status word per row: schedule word if the schedule is broken, else
 * the artifact word when it needs attention, else quiet health. The
 * ADR-52 split stays visible in the drawer. */
export function rowStatus(r: BackupRoutine): { word: string; level: string } {
  const sched = SCHEDULE_PILL[r.state] ?? { word: r.state, level: "unknown" };
  if (sched.level === "unhealthy" || sched.level === "degraded" || sched.level === "unknown") return sched;
  const art = ARTIFACT_PILL[r.artifact?.state ?? "unmeasured"] ?? { word: r.artifact?.state ?? "unmeasured", level: "unknown" };
  if (art.level === "degraded" || art.level === "unknown") return art;
  return { word: sched.word, level: r.level || sched.level };
}

export interface Shelf {
  id: string;
  title: string;
  controlPlane: boolean;
  routines: BackupRoutine[];
  uncovered: UnprotectedComponent[];
}

/** Control plane always leads (explicit per-component - never a blanket
 * row, #582); bundles by title; "Independent components" last. A drawing
 * decision (canvas groups) never mints a shelf (ADR-123). */
export function shelves(doc: BackupsDoc): Shelf[] {
  const cp: Shelf = { id: "control-plane", title: "Harness Hg control plane", controlPlane: true, routines: [], uncovered: [] };
  const byBundle = new Map<string, Shelf>();
  const indep: Shelf = { id: "independent", title: "Independent components", controlPlane: false, routines: [], uncovered: [] };
  const shelfFor = (bundle?: string, bundleTitle?: string, group?: string): Shelf => {
    if (group === "control-plane") return cp;
    if (bundle) {
      let s = byBundle.get(bundle);
      if (!s) {
        s = { id: `bundle:${bundle}`, title: bundleTitle || bundle, controlPlane: false, routines: [], uncovered: [] };
        byBundle.set(bundle, s);
      }
      return s;
    }
    return indep;
  };
  for (const r of doc.routines) shelfFor(r.bundle, r.bundleTitle, r.group).routines.push(r);
  for (const u of doc.unprotected) shelfFor(u.bundle, undefined, undefined).uncovered.push(u);
  const bundles = [...byBundle.values()].sort((a, b) => a.title.localeCompare(b.title));
  return [cp, ...bundles, indep].filter((s) => s.routines.length + s.uncovered.length > 0);
}

const LEVEL_RANK: Record<string, number> = { healthy: 0, paused: 1, unknown: 2, degraded: 3, unhealthy: 4 };

/** Worst-of-children; an EMPTY shelf is unknown - aggregation, never
 * derivation. Uncovered components count as their served level (or
 * degraded when unstated: missing protection is never quiet). */
export function shelfLevel(s: Shelf): string {
  const levels = [
    ...s.routines.map((r) => rowStatus(r).level),
    ...s.uncovered.map((u) => u.level || "degraded"),
  ];
  if (levels.length === 0) return "unknown";
  return levels.reduce((worst, l) => ((LEVEL_RANK[l] ?? 2) > (LEVEL_RANK[worst] ?? 2) ? l : worst), "healthy");
}

/** The ONE verdict sentence - three forms. Schedule breakage and missing
 * coverage are attention; a running-but-unproven artifact is the middle
 * form (its row still says "Not restore-proven" - the verdict and the
 * row answer different questions). */
export function verdict(doc: BackupsDoc): { text: string; level: string } {
  const scheduleBroken = doc.routines.filter((r) => {
    const sched = SCHEDULE_PILL[r.state] ?? { level: "unknown" };
    return ["degraded", "unhealthy", "unknown"].includes(sched.level);
  }).length;
  const attention = scheduleBroken + doc.unprotected.length;
  const total = doc.routines.length;
  if (attention > 0) {
    return { text: `${attention} of ${total + doc.unprotected.length} backup routines need attention.`, level: "unhealthy" };
  }
  const unproven = doc.routines.some(
    (r) =>
      !["restorable", "declarative", "none"].includes(r.artifact?.state ?? "unmeasured") &&
      !["declarative", "ephemeral", "archived"].includes(r.state),
  );
  if (unproven) return { text: `All ${total} running · not all proven restorable.`, level: "degraded" };
  return { text: `All ${total} healthy.`, level: "healthy" };
}

/** Cron prose: the four known 5-field shapes; everything else VERBATIM -
 * "guessing risks stating a schedule the routine doesn't run on". */
export function cronProse(expr?: string): string {
  if (!expr) return "no schedule";
  const m = expr.trim().split(/\s+/);
  if (m.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = m;
  const pad = (h: string, mi: string) => `${h.padStart(2, "0")}:${mi.padStart(2, "0")}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*")
    return `daily at ${pad(hour, min)}`;
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return `hourly at :${min.padStart(2, "0")}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return `weekly on ${days[Number(dow) % 7]} at ${pad(hour, min)}`;
  }
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return `every ${min.slice(2)} minutes`;
  return expr;
}

/** Destinations in durability terms; unknown values verbatim, no gloss. */
export function destinationProse(dest?: string): string {
  switch (dest) {
    case "pvc": return "cluster volume — survives pod restarts, not cluster loss";
    case "gcs": return "Google Cloud Storage — survives cluster loss";
    case "gcs-emulated": return "emulated GCS (local) — test durability only";
    case "local-directory": return "local directory — survives nothing beyond the host";
    default: return dest ?? "unknown destination";
  }
}
