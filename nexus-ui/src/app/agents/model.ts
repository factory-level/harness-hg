// Agents directory pure model. Contracts carried: the browser reads
// SERVER rollups (`bundle:<id>` / `bucket:unbundled`) and never computes
// an aggregate (#565/#567); flag-off attachment data reads "unknown",
// never an empty dash; deploy identity resolves bundle-first then
// namespace (ADR-28's bundleOf).

import type { HealthOverlay, NexusData } from "../../stores/data";

export interface AgentEntry {
  id: string;
  title: string;
  kind: string;
  description?: string;
  namespace?: string;
}

export interface BundleGroup {
  id: string; // "bundle:<id>" | "bucket:unbundled"
  title: string;
  agents: AgentEntry[];
}

export function agentEntries(data: NexusData): AgentEntry[] {
  return (data.plan?.components ?? [])
    .filter((c) => c.kind === "agent" || c.kind === undefined)
    .map((c) => ({ id: c.id, title: c.title ?? c.id, kind: c.kind ?? "agent" }));
}

export function bundleOf(data: NexusData, id: string): { id: string; title: string } | null {
  for (const b of data.bundles) {
    const members = (b as { members?: string[] }).members;
    if (members?.includes(id)) return { id: b.id, title: b.title ?? b.id };
  }
  return null;
}

export function groups(data: NexusData): BundleGroup[] {
  const byBundle = new Map<string, BundleGroup>();
  const unbundled: BundleGroup = { id: "bucket:unbundled", title: "Unbundled", agents: [] };
  for (const a of agentEntries(data)) {
    const b = bundleOf(data, a.id);
    if (!b) {
      unbundled.agents.push(a);
      continue;
    }
    let g = byBundle.get(b.id);
    if (!g) {
      g = { id: `bundle:${b.id}`, title: b.title, agents: [] };
      byBundle.set(b.id, g);
    }
    g.agents.push(a);
  }
  const bundles = [...byBundle.values()].sort((a, b) => a.title.localeCompare(b.title));
  return [...bundles, ...(unbundled.agents.length ? [unbundled] : [])];
}

/** The group pill reads the SERVED rollup; absence is unknown - the
 * browser never folds member levels itself. */
export function groupLevel(health: HealthOverlay | null, groupId: string): string {
  return health?.rollups?.[groupId]?.level ?? "unknown";
}

export function agentLevel(health: HealthOverlay | null, id: string): string {
  return health?.components?.[id]?.level ?? "unknown";
}

export interface Filters {
  level: string | null;
  bundle: string | null;
}

export function applyFilters(gs: BundleGroup[], health: HealthOverlay | null, f: Filters): BundleGroup[] {
  return gs
    .filter((g) => !f.bundle || g.id === f.bundle)
    .map((g) => ({
      ...g,
      agents: g.agents.filter((a) => !f.level || agentLevel(health, a.id) === f.level),
    }))
    .filter((g) => g.agents.length > 0);
}
