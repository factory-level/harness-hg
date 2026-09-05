// ROUTES is data (#409 carried forward): two independent gates, never
// merged - `flag` (capability shipped, operator overlay) and `capability`
// (deployment allows). A known-but-withheld route resolves to the
// explicit "unavailable" sentinel; an UNKNOWN hash falls back to fleet (a
// typo is not a withdrawal). Ids/hashes are the durable deep-link
// contract - `communication` keeps its id under the Alert Routing title.
import { flagOn, viewAvailable, type NexusData } from "../stores/data";

export interface Route {
  id: string;
  title: string;
  tab: boolean;
  flag?: string;
  capability?: string;
}

export const ROUTES: Route[] = [
  { id: "fleet", title: "Fleet Canvas", tab: true },
  { id: "communication", title: "Alert Routing", tab: true, flag: "communication-view", capability: "communication" },
  { id: "agents", title: "Agents", tab: true, flag: "agents-view", capability: "agents" },
  { id: "backups", title: "Backups", tab: true, flag: "backups-view", capability: "backups" },
  { id: "system", title: "System", tab: false, capability: "system" },
  { id: "avatars", title: "Avatars", tab: false, flag: "avatar-gallery" },
  { id: "embed-debug", title: "Embed debug", tab: false, flag: "embed-debug" },
  { id: "primitives", title: "Primitives", tab: false, flag: "canvas-object-demo" },
];

export function routeGates(data: NexusData, r: Route): { shipped: boolean; allowed: boolean } {
  return {
    shipped: !r.flag || flagOn(data, r.flag),
    allowed: !r.capability || viewAvailable(data, r.id),
  };
}

export interface Resolved {
  view: string;
  sub: string | null;
  title: string;
}

export function resolveRoute(hash: string, data: NexusData): Resolved {
  const parts = hash.replace(/^#\/?/, "").split("/");
  let id = parts[0] || "fleet";
  let sub: string | null = null;
  try {
    sub = parts[1] ? decodeURIComponent(parts[1]) : null;
  } catch {
    sub = null; // malformed escape decodes to "unknown id", never a crash
  }
  const route = ROUTES.find((r) => r.id === id);
  if (!route) return { view: "fleet", sub: null, title: "Fleet Canvas" };
  const { shipped, allowed } = routeGates(data, route);
  if (!shipped || !allowed) return { view: "unavailable", sub: route.id, title: route.title };
  return { view: route.id, sub, title: route.title };
}

export function tabs(data: NexusData): Route[] {
  return ROUTES.filter((r) => r.tab).filter((r) => {
    const g = routeGates(data, r);
    return g.shipped && g.allowed;
  });
}
