// The badge layer's pure joins, ported from the retired dashboard
// (data.ts producerKeyOf/routesFor, canvas-geometry bindingsFor) - a
// badge is a FIXTURE on the card carrying rows the wire honestly
// serves. A domain with no data source or no rows is ABSENT, never an
// empty circle.
import type { CommEdge } from "../communication/model";
import type { HealthOverlay, PlanComponent } from "../../stores/data";
import type { WorkspaceBinding } from "../../stores/bindings";

export type MountState = "mounted" | "pending" | "unknown";

export interface BadgeRow {
  label: string;
  detail?: string;
  href?: string;
  mount?: MountState;
}
export interface BadgeDomainModel {
  count: number;
  rows: BadgeRow[];
  note?: string;
}
export interface BadgeModel {
  gh?: BadgeDomainModel;
  comm?: BadgeDomainModel;
  iam?: BadgeDomainModel;
  alert?: BadgeDomainModel;
}

/** An application's producer key: `<profile>/<app>` (carried verbatim). */
export function producerKeyOf(c: PlanComponent): string | undefined {
  if (c.kind === "application" && c.bind?.app) return `${c.bind.profile}/${c.bind.app}`;
  return undefined;
}

/** The comm edges this component participates in: an agent RECEIVES
 * (agent edges targeting its profile), an application PRODUCES (edges
 * whose composite producer starts with its key). Carried verbatim. */
export function routesFor(c: PlanComponent, edges: CommEdge[]): CommEdge[] {
  if (c.kind === "agent" && c.bind) {
    const profile = c.bind.profile;
    return edges.filter((e) => e.kind === "agent" && e.target?.profile === profile);
  }
  const key = producerKeyOf(c);
  if (!key) return [];
  return edges.filter((e) => e.producer?.startsWith(`${key}@`) || e.producer?.startsWith(`${key}#`));
}

/** The bindings attached to a profile, deduped per repository; a KNOWN
 * mount state beats unknown (carried from canvas-geometry). */
export function bindingsFor(bindings: WorkspaceBinding[], profile: string): { repository: string; mount: MountState }[] {
  const seen = new Map<string, MountState>();
  for (const b of bindings) {
    for (const t of b.targets ?? []) {
      if (t.profile !== profile) continue;
      const state: MountState = t.mounted === true ? "mounted" : t.mounted === false ? "pending" : "unknown";
      const prior = seen.get(b.repository);
      if (prior === undefined || (prior === "unknown" && state !== "unknown")) seen.set(b.repository, state);
    }
  }
  return [...seen.entries()].map(([repository, mount]) => ({ repository, mount }));
}

/** Published hostnames - the ADR-40 externally reachable endpoint. */
export function publishedHostnames(c: PlanComponent): string[] {
  return (c.instances ?? [])
    .flatMap((i) => i.destinations?.deployed ?? [])
    .filter((d) => d.name === "published" && typeof d.url === "string")
    .map((d) => d.url as string);
}

/** People who may operate this component: human/person components whose
 * accessors[] include its id. */
export function peopleFor(id: string, components: PlanComponent[]): PlanComponent[] {
  return components.filter((p) => (p.kind === "human" || p.kind === "person") && (p.accessors ?? []).includes(id));
}

/** The alerting BELL is earned twice: an alarm-class route targets the
 * agent AND its grafana health source is configured. It never reads
 * firing state - the wire does not serve a per-card join, and the badge
 * must not re-derive the namespace heuristic the server refuses. */
export function alertBell(c: PlanComponent, edges: CommEdge[], health: HealthOverlay | null): CommEdge[] {
  if (c.kind !== "agent") return [];
  const alarmRoutes = routesFor(c, edges).filter((e) => e.alarmClass === true);
  if (alarmRoutes.length === 0) return [];
  const grafana = health?.components?.[c.id]?.sources?.find((s) => s.kind === "grafana");
  return grafana?.status === "configured" ? alarmRoutes : [];
}

export function badgeModel(
  c: PlanComponent,
  ctx: {
    components: PlanComponent[];
    edges: CommEdge[] | null;
    bindings: WorkspaceBinding[] | null;
    health: HealthOverlay | null;
    flags: { gh: boolean; comm: boolean; iam: boolean; alert: boolean };
  },
): BadgeModel {
  const model: BadgeModel = {};

  if (ctx.flags.gh && ctx.bindings !== null) {
    // Two sources, one badge (carried): authored links click through;
    // attached bindings are inert rows wearing the mount tri-state.
    const authored: BadgeRow[] = Object.entries(c.links ?? {}).map(([name, href]) => ({ label: name, href }));
    const attached: BadgeRow[] =
      c.kind === "agent" && c.bind
        ? bindingsFor(ctx.bindings, c.bind.profile).map((b) => ({ label: b.repository, mount: b.mount }))
        : [];
    // The same repository authored AND attached is one fact, not two rows.
    const rows = [...authored.map((a) => {
      const twin = attached.find((b) => b.label === a.href);
      return twin ? { ...a, mount: twin.mount } : a;
    }), ...attached.filter((b) => !authored.some((a) => a.href === b.label))];
    if (rows.length > 0) model.gh = { count: rows.length, rows };
  }

  if (ctx.flags.comm && ctx.edges !== null) {
    const routes = routesFor(c, ctx.edges);
    if (routes.length > 0) {
      model.comm = {
        count: routes.length,
        rows: routes.map((e) => ({
          label: e.route ?? e.event ?? e.id,
          detail: e.kind === "chatops" ? e.target?.space : e.target?.profile ? `→ ${e.target.profile}` : undefined,
        })),
      };
    }
  }

  if (ctx.flags.iam) {
    const hosts = publishedHostnames(c);
    const people = peopleFor(c.id, ctx.components);
    if (hosts.length > 0 || people.length > 0) {
      model.iam = {
        count: hosts.length + people.length,
        rows: [
          ...(hosts.length > 0
            ? hosts.map((h) => ({ label: h, href: h }))
            : [{ label: "none — no published hostname" }]),
          ...people.map((p) => ({ label: p.title ?? p.id, detail: `Person · ${p.personTitle ?? "member"}` })),
        ],
        note: "Access group membership is not reported here yet.",
      };
    }
  }

  if (ctx.flags.alert && ctx.edges !== null) {
    const bells = alertBell(c, ctx.edges, ctx.health);
    if (bells.length > 0) {
      model.alert = {
        count: bells.length,
        rows: bells.map((e) => ({ label: e.event ?? e.id, detail: e.target?.profile ? `→ ${e.target.profile}` : undefined })),
        note: "Routing exists and Grafana is configured; firing state is not readable per card.",
      };
    }
  }

  return model;
}
