// The capability vocabulary (#545, carried verbatim from the shipping
// registry): stable product responsibilities, never vendor names. Each
// inventory workload belongs to exactly ONE slice - the registry test
// pins membership so a new workload gets a real slice instead of
// silently not existing on the mandala. Hues live in design/tokens.json
// (--cap-<id>) - no palette literals in code.
export interface Capability {
  id: string;
  label: string;
  desc: string;
  ring: "inner" | "outer";
  members: string[];
}

export const CAPABILITIES: Capability[] = [
  { id: "synchronization", label: "Synchronization", desc: "Keeps what runs matching what Git declares.", ring: "inner", members: ["reconciler", "argocd"] },
  { id: "routing", label: "Event routing", desc: "Delivers alerts and business events to agents and chat.", ring: "inner", members: ["communication-router", "chatops"] },
  { id: "queueing", label: "Queueing", desc: "Durable delivery between producers and consumers.", ring: "inner", members: ["communication-queue"] },
  { id: "monitoring", label: "Monitoring", desc: "Watches, records and alerts on everything here.", ring: "inner", members: ["prometheus", "grafana", "alertmanager"] },
  { id: "connectivity", label: "Connectivity", desc: "The tunnel between the outside world and the cluster.", ring: "outer", members: ["cloudflare-tunnel"] },
  { id: "ingress", label: "Webhook ingress", desc: "Receives and verifies inbound events.", ring: "outer", members: ["webhook-gateway"] },
  { id: "agent-runtime", label: "Agent runtime", desc: "Hosts the installed agent fleet.", ring: "outer", members: ["hermes-runtime"] },
  { id: "backups", label: "Backups", desc: "Archives state so the fleet can be rebuilt.", ring: "outer", members: ["backup-services"] },
  { id: "people", label: "People & Groups", desc: "Who the fleet works with, and how they are organized.", ring: "outer", members: [] },
  { id: "nexus", label: "Nexus", desc: "This surface: the fleet's own window.", ring: "outer", members: ["nexus"] },
];

export interface Workload {
  id: string;
  title: string;
  role?: string;
  source?: string;
}

/** Every workload in exactly one slice; the leftovers surface as an
 * explicit note, never a silent omission. */
export function unplaced(workloads: Workload[]): Workload[] {
  const claimed = new Set(CAPABILITIES.flatMap((c) => c.members));
  return workloads.filter((w) => !claimed.has(w.id));
}

/** Worst served level over a capability's members; empty = unknown -
 * except People & Groups, whose level is the roster's readability (it
 * has no runtime members by design). */
export function capabilityLevel(
  cap: Capability,
  levelOf: (workloadId: string) => string,
): string {
  if (cap.members.length === 0) return "healthy";
  const rank: Record<string, number> = { healthy: 0, paused: 1, unknown: 2, degraded: 3, unhealthy: 4 };
  return cap.members
    .map(levelOf)
    .reduce((worst, l) => ((rank[l] ?? 2) > (rank[worst] ?? 2) ? l : worst), "healthy");
}
