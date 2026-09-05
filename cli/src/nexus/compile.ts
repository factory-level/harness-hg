// The Nexus compiler (design 11, ADR-42): dashboard contributions x the
// compiled topology plan -> one deterministic nexus plan. Pure functions
// end to end - no I/O, no clock, no randomness; identical inputs produce
// identical output (compile-twice byte-equality is a test). Runtime health
// is NEVER computed or written here - the plugin backend layers it on at
// serve time. Findings carry stable NEXUS rule ids, the TOPO convention.
//
//   NEXUS000  authored file fails its published schema (raised by contract.ts)
//   NEXUS001  duplicate id across contributions
//   NEXUS002  relationship endpoint names an unknown id
//   NEXUS003  bind names a profile/app the topology plan does not contain
//   NEXUS004  view node ref names an unknown id
//   NEXUS005  person cohort/accessor names an unknown id
//   NEXUS006  details.endpointNames names an endpoint the profile/app never declared
//   NEXUS007  more than one view carries the same id
//   NEXUS008  operator workload-endpoint hostname is not a bare FQDN
//   NEXUS009  authored link is not a clean https URL (ADR-43: no http,
//             no userinfo, no query, no fragment - the compiler layer of
//             the three-layer link posture)
//   NEXUS010  icon asset is not a genuine bounded PNG/WebP (raised by contract.ts)
//   NEXUS011  duplicate icon stem across dashboard/icons/ directories
//   NEXUS012  icon stem matches no contributed id
//   NEXUS013  agent display.icon names no platform avatar (falls back to
//             the plain card - warn, because pre-avatar personas carry
//             Lucide names here)

import * as crypto from "node:crypto";
import type { ValidationFinding } from "../platform/index.ts";
import type { TopologyPlan } from "../topology/compile.ts";
import type {
  ComponentDecl,
  ContributionDoc,
  DashboardFile,
  DeclaredProfileFacts,
  GroupDecl,
  IconAsset,
  PersonDecl,
  RelationshipDecl,
  ViewDoc,
} from "./contract.ts";

// ---------------------------------------------------------------------------
// Plan types (mirrors of dashboard-plan/v1alpha1/plan.schema.json)

export interface NexusDestinations {
  hermesClassic?: string;
  deployed?: { name: string; url: string }[];
}

export interface NexusInstance {
  id: string;
  scope: string;
  region?: string;
  target?: string;
  application?: string;
  namespace?: string;
  grafanaDashboardUid?: string;
  destinations: NexusDestinations;
}

export interface NexusComponent {
  id: string;
  kind: "agent" | "application" | "human" | "group";
  title: string;
  description?: string;
  icon?: string;
  source?: { id: string; path: string };
  bind?: { profile: string; app?: string };
  links?: { repository?: string; docs?: string; runbook?: string };
  resolved: boolean;
  unresolvedReason?: string;
  groupKind?: "department" | "team" | "system";
  personTitle?: string;
  cohorts?: string[];
  accessors?: string[];
  details?: {
    showCrons?: boolean;
    showConfigSummary?: boolean;
    showAccessors?: boolean;
    showArgoCd?: boolean;
  };
  crons?: { name: string; schedule: string }[];
  configSummary?: DeclaredProfileFacts["config"];
  instances: NexusInstance[];
}

export interface NexusViewNode {
  ref: string;
  position: { x: number; y: number };
  parent?: string;
}

export interface NexusView {
  id: string;
  title?: string;
  nodes: NexusViewNode[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface NexusPlanDoc {
  /** 1 while no v1alpha2 feature is used; 2 once any component carries
   * links - so a v1alpha2 contribution WITHOUT links still emits a plan
   * every v1alpha1 consumer validates. */
  version: 1 | 2;
  inputsHash: string;
  sourceSha: string;
  components: NexusComponent[];
  relationships: { id: string; from: string; to: string; label: string }[];
  view: NexusView;
}

export interface NexusCompileResult {
  plan: NexusPlanDoc;
  /** Icon assets whose stem names a contributed id - the set emit copies
   * into deployments/dashboard/assets/icons/. Deliberately NOT in the
   * plan document: the frozen dashboard-plan schemas stay untouched, the
   * dashboard asks for /nexus/assets/icons/<id> and falls back to the
   * monogram on 404. */
  icons: IconAsset[];
  findings: ValidationFinding[];
  ok: boolean; // no error-severity findings
}

export interface NexusInputs {
  contributions: DashboardFile<ContributionDoc>[];
  views: DashboardFile<ViewDoc>[];
  /** Loaded icon assets (loadDashboard's result spreads them in). */
  icons?: IconAsset[];
  /** The platform avatar inventory's ids (#426). `undefined` means the
   * caller has no inventory in reach (unit contexts) and the selection
   * check is skipped - an empty array means "an inventory with nothing
   * in it" and every agent selection warns. */
  avatarIds?: string[];
  declared: Record<string, DeclaredProfileFacts>;
  topology: TopologyPlan;
  /** profile -> where a BUNDLED profile actually runs (ADR-28). Bundling
   * retires the per-profile Application AND deploys no child apps at
   * all, so without this the plan names an Application, a namespace and
   * a Grafana dashboard that no cluster has - which is what #290 and
   * #301 both are. */
  bundledProfiles?: Record<string, { bundle: string; namespace: string }>;
  /** ADR-40 published hostnames, keyed "<profile>/<app>". Operator/stack
   * data, supplied as a file by the caller - never read from the repo. */
  workloadEndpoints?: Record<string, { hostname: string }>;
  /** Loader findings (NEXUS000) - loadDashboard's result spreads straight
   * into this input, so schema-broken files fail the compile too. */
  findings?: ValidationFinding[];
  sourceSha?: string; // 40-hex; all zeros for an uncommitted local preview
  /** sha256 over the raw input files, computed by the emit layer. The
   * default hashes the canonical JSON of the inputs, which is enough for
   * a pure compile to stay deterministic. */
  inputsHash?: string;
}

// ---------------------------------------------------------------------------
// Grafana uid derivation - the persona chart convention, exactly:
// {{ $n := printf "%s-<chart>" .Release.Name }}{{ trunc 32 $n | trimSuffix "-" }}-dash
// where the release name is the child Application name from the topology plan.

export function grafanaUid(release: string, chart: string): string {
  const base = `${release}-${chartBase(chart)}`.slice(0, 32).replace(/-$/, "");
  return `${base}-dash`;
}

/** An AGENT's dashboard uid. Deliberately NOT grafanaUid().
 *
 * Two charts emit dashboards under two different conventions, and using
 * the wrong one produces a link that 404s while looking perfectly
 * plausible in the plan:
 *
 *   - a persona APP chart keys its uid off the release+chart name
 *     (`trunc 32 (include "postiz.name" .)`) - that is grafanaUid();
 *   - the monitoring chart (control-plane/monitoring/chart), which emits a
 *     per-AGENT dashboard and
 *     keys off `trunc 32 .Release.Namespace` (its _helpers.tpl,
 *     `monitoring.uidbase`).
 *
 * Every agent card pointed at a uid that did not exist until this split
 * was made explicit. Verified against a live cluster: namespace
 * `hermes-marketing-sre` renders uid `hermes-marketing-sre-dash`. */
export function monitoringUid(namespace: string): string {
  return `${namespace.slice(0, 32).replace(/-$/, "")}-dash`;
}

function chartBase(chart: string): string {
  const parts = chart.split("/");
  return parts[parts.length - 1]!;
}

// ---------------------------------------------------------------------------

const ZERO_SHA = "0".repeat(40);

const LINK_KEYS = ["repository", "docs", "runbook"] as const;

/** The compiler layer of the ADR-43 link posture: the schema already
 * admitted only `https://…`; here anything with userinfo, query, fragment
 * or an unparseable shape becomes an error finding (the emit layer
 * refuses on findings, so a dirty link never reaches git). */
function cleanLinks(
  decl: ComponentDecl,
  sourcePath: string,
  err: (source: string, check: string, message: string, fix?: string) => void,
): NexusComponent["links"] {
  if (!decl.links) return undefined;
  const out: Partial<Record<(typeof LINK_KEYS)[number], string>> = {};
  for (const key of LINK_KEYS) {
    const value = decl.links[key];
    if (value === undefined) continue;
    let bad = "";
    try {
      const u = new URL(value);
      if (u.protocol !== "https:") bad = "https only";
      else if (u.username || u.password) bad = "userinfo is not allowed";
      else if (u.search || u.hash) bad = "query and fragment are not allowed";
      else if (!u.hostname) bad = "no hostname";
    } catch {
      bad = "not a parseable URL";
    }
    if (bad) {
      err(
        sourcePath,
        "NEXUS009",
        `component ${decl.id}: links.${key} ${JSON.stringify(value)} - ${bad}`,
        "links must be clean https URLs: no userinfo, no query, no fragment",
      );
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Deterministic auto-placement for components no view positions: a grid
 * in sorted-id order, below any authored nodes. */
const GRID = { cols: 4, dx: 260, dy: 180, x0: 80, y0: 80 };

export function compileNexus(inputs: NexusInputs): NexusCompileResult {
  const findings: ValidationFinding[] = [...(inputs.findings ?? [])];
  const err = (source: string, check: string, message: string, fix?: string) =>
    findings.push({ profile: source, severity: "error", check, message, fix });
  const warn = (source: string, check: string, message: string, fix?: string) =>
    findings.push({ profile: source, severity: "warning", check, message, fix });

  // --- Stage: gather + duplicate detection --------------------------------
  interface Gathered<T> {
    decl: T;
    source: { id: string; path: string };
  }
  const components: Gathered<ComponentDecl>[] = [];
  const people: Gathered<PersonDecl>[] = [];
  const groups: Gathered<GroupDecl>[] = [];
  const relationships: Gathered<RelationshipDecl>[] = [];

  const seen = new Map<string, string>(); // id -> first source path
  const claim = (id: string, sourcePath: string): boolean => {
    const first = seen.get(id);
    if (first !== undefined) {
      err(
        sourcePath,
        "NEXUS001",
        `id ${JSON.stringify(id)} is already contributed by ${first}`,
        "ids are one flat namespace across every contribution file of the repository - rename one",
      );
      return false;
    }
    seen.set(id, sourcePath);
    return true;
  };

  for (const { relPath, doc } of inputs.contributions) {
    const source = { id: doc.metadata.id, path: relPath };
    for (const c of doc.spec.components ?? []) {
      if (claim(c.id, relPath)) components.push({ decl: c, source });
    }
    for (const p of doc.spec.people ?? []) {
      if (claim(p.id, relPath)) people.push({ decl: p, source });
    }
    for (const g of doc.spec.groups ?? []) {
      if (claim(g.id, relPath)) groups.push({ decl: g, source });
    }
    for (const r of doc.spec.relationships ?? []) {
      if (claim(r.id, relPath)) relationships.push({ decl: r, source });
    }
  }

  // Relationship ids share the flat namespace but are not canvas nodes.
  const nodeIds = new Set<string>([
    ...components.map((c) => c.decl.id),
    ...people.map((p) => p.decl.id),
    ...groups.map((g) => g.decl.id),
  ]);

  // --- Stage: icon assets ---------------------------------------------------
  // An icon's filename stem IS its binding - no schema field, no second
  // addressing scheme. Discovery order (repo-level first, then profiles
  // sorted) makes the duplicate-stem winner deterministic.
  const planIcons: IconAsset[] = [];
  const iconStems = new Map<string, string>();
  for (const icon of inputs.icons ?? []) {
    const prior = iconStems.get(icon.stem);
    if (prior !== undefined) {
      warn(icon.relPath, "NEXUS011", `icon ${JSON.stringify(icon.stem)} is already provided by ${prior} - this one is ignored`);
      continue;
    }
    iconStems.set(icon.stem, icon.relPath);
    if (!nodeIds.has(icon.stem)) {
      warn(
        icon.relPath,
        "NEXUS012",
        `icon ${JSON.stringify(icon.stem)} matches no contributed component, person or group`,
        "name the file after the id it faces, or remove it",
      );
      continue;
    }
    planIcons.push(icon);
  }

  // --- Stage: avatar selection (#426) --------------------------------------
  // An agent's display.icon is its avatar-inventory code: the deployed
  // card wears the platform asset it names. Unknown codes fall back to
  // the plain card, so this is a warn - existing personas legitimately
  // still carry Lucide names from the never-rendered icon era. Only
  // agents wear avatars; tool/app display.icon values stay silent.
  if (inputs.avatarIds !== undefined) {
    const knownAvatars = new Set(inputs.avatarIds);
    for (const { decl, source } of components) {
      const code = decl.display?.icon;
      if (decl.kind !== "agent" || !code || knownAvatars.has(code)) continue;
      warn(
        source.path,
        "NEXUS013",
        `agent ${JSON.stringify(decl.id)} selects avatar ${JSON.stringify(code)}, which is not in the platform inventory - the card falls back to plain`,
        inputs.avatarIds.length
          ? `known codes: ${inputs.avatarIds.slice(0, 8).join(", ")}${inputs.avatarIds.length > 8 ? ", …" : ""} (the #/avatars page lists all)`
          : "the inventory is empty - add assets under control-plane/nexus/avatars in the platform repository",
      );
    }
  }

  // --- Stage: referential integrity ---------------------------------------
  for (const { decl, source } of relationships) {
    for (const end of [decl.from, decl.to]) {
      if (!nodeIds.has(end)) {
        err(
          source.path,
          "NEXUS002",
          `relationship ${decl.id}: ${JSON.stringify(end)} is not a contributed component, person or group`,
          "relationships may only connect ids contributed by this repository",
        );
      }
    }
  }
  for (const { decl, source } of people) {
    for (const cohort of decl.cohorts ?? []) {
      if (!groups.some((g) => g.decl.id === cohort)) {
        warn(source.path, "NEXUS005", `person ${decl.id}: cohort ${JSON.stringify(cohort)} is not a contributed group`);
      }
    }
    for (const accessor of decl.accessors ?? []) {
      if (!components.some((c) => c.decl.id === accessor)) {
        warn(source.path, "NEXUS005", `person ${decl.id}: accessor ${JSON.stringify(accessor)} is not a contributed component`);
      }
    }
  }

  // --- Stage: bind resolution against the topology plan -------------------
  const topo = inputs.topology;
  const planComponents: NexusComponent[] = [];

  for (const { decl, source } of components) {
    const base: NexusComponent = {
      id: decl.id,
      kind: decl.kind,
      title: decl.title,
      description: decl.description,
      icon: decl.display?.icon,
      source,
      bind: decl.bind,
      resolved: true,
      details: decl.details
        ? {
            showCrons: decl.details.showCrons,
            showConfigSummary: decl.details.showConfigSummary,
            showAccessors: decl.details.showAccessors,
            showArgoCd: decl.details.showArgoCd,
          }
        : undefined,
      instances: [],
    };
    const links = cleanLinks(decl, source.path, err);
    if (links) base.links = links;

    const endpointsOf = (ownerId: string) => topo.endpoints.filter((e) => e.owner === ownerId);
    const declaredEndpointNames = (ownerId: string) => endpointsOf(ownerId).map((e) => e.endpoint);
    const wantedNames = decl.details?.endpointNames;

    const deployedFor = (ownerId: string, profileApp?: string): { name: string; url: string }[] => {
      const bindings = endpointsOf(ownerId).filter((e) => e.url !== undefined);
      const chosen = wantedNames ? bindings.filter((e) => wantedNames.includes(e.endpoint)) : bindings;
      const out = chosen
        .filter((e) => e.endpoint !== "dashboard") // hermesClassic owns that slot
        .map((e) => ({ name: e.endpoint, url: e.url! }));
      if (profileApp && inputs.workloadEndpoints?.[profileApp]) {
        const hostname = inputs.workloadEndpoints[profileApp]!.hostname;
        // A bare lowercase FQDN, nothing else - a scheme, path, port or
        // whitespace here would mint an unintended destination.
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
          err(
            source.path,
            "NEXUS008",
            `component ${decl.id}: workload endpoint hostname ${JSON.stringify(hostname)} is not a bare FQDN`,
            "fix controlPlaneIngress.workloadEndpoints in the stack config - hostname only, no scheme/path/port",
          );
        } else {
          const url = `https://${hostname}`;
          if (!out.some((d) => d.url === url)) out.push({ name: "published", url });
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    };

    if (decl.kind === "agent") {
      const agentInstances = topo.agents.filter((a) => a.profile === decl.bind.profile);
      if (agentInstances.length === 0) {
        base.resolved = false;
        base.unresolvedReason = `bind names profile ${JSON.stringify(decl.bind.profile)} which the topology plan does not contain`;
        warn(source.path, "NEXUS003", `component ${decl.id}: ${base.unresolvedReason}`, "check the profile name against distributions/*/distribution.yaml");
      }
      for (const a of agentInstances) {
        const classic = endpointsOf(a.id).find((e) => e.endpoint === "dashboard" && e.url !== undefined);
        // The agent's Grafana dashboard is its per-agent monitoring app's
        // (the persona convention); absent that app, no uid is derivable.
        const monitoring = topo.apps.find((x) => x.profile === a.profile && x.app === "monitoring" && x.pairedAgent === a.id);
        // A bundled member runs inside the bundle's Application and
        // namespace; its own were retired with its StatefulSet (ADR-28).
        // And the bundle chart deploys NO child apps, so the monitoring
        // release that would have provisioned a dashboard never exists -
        // naming a uid here is how the plan came to promise a dashboard
        // Grafana returns 404 for (#301).
        const placed = inputs.bundledProfiles?.[a.profile];
        base.instances.push({
          id: a.id,
          scope: a.scope,
          region: a.region,
          target: a.target,
          application: placed ? `hermes-bundle-${placed.bundle}` : a.application,
          namespace: placed ? placed.namespace : a.namespace,
          // The monitoring app's presence decides WHETHER there is a
          // dashboard; the agent's NAMESPACE decides its uid, because
          // the monitoring chart builds the uid from .Release.Namespace.
          // A bundled member's dashboard is the BUNDLE's: its monitoring
          // release deploys into the bundle namespace, and the monitoring chart
          // keys the uid off that namespace. All members share it, which is
          // truthful - they share a pod, so they share every metric on it.
          grafanaDashboardUid: monitoring
            ? monitoringUid(placed ? placed.namespace : a.namespace)
            : undefined,
          destinations: (() => {
            const deployed = deployedFor(a.id);
            return { hermesClassic: classic?.url, deployed: deployed.length > 0 ? deployed : undefined };
          })(),
        });
      }
      const facts = inputs.declared[decl.bind.profile];
      if (facts) {
        if (facts.crons.length > 0) base.crons = facts.crons;
        base.configSummary = facts.config;
      }
      if (wantedNames && agentInstances.length > 0) {
        const known = new Set(agentInstances.flatMap((a) => declaredEndpointNames(a.id)));
        for (const name of wantedNames) {
          if (!known.has(name)) {
            warn(source.path, "NEXUS006", `component ${decl.id}: endpointNames entry ${JSON.stringify(name)} matches no declared endpoint`);
          }
        }
      }
    } else {
      const appInstances = topo.apps.filter((x) => x.profile === decl.bind.profile && x.app === decl.bind.app);
      if (appInstances.length === 0) {
        base.resolved = false;
        base.unresolvedReason = `bind names app ${JSON.stringify(`${decl.bind.profile}/${decl.bind.app}`)} which the topology plan does not contain`;
        warn(source.path, "NEXUS003", `component ${decl.id}: ${base.unresolvedReason}`, "check the app name against the profile's hermes-gitops.yaml apps[]");
      }
      const profileApp = `${decl.bind.profile}/${decl.bind.app}`;
      const appPlaced = inputs.bundledProfiles?.[decl.bind.profile];
      if (appPlaced && appInstances.length > 0) {
        // Declared, compiled, and NOT DEPLOYED. Saying so out loud beats
        // emitting an Application name no cluster has - the surfaces
        // downstream cannot tell the difference between "absent" and
        // "not looked at yet" unless the plan is honest here.
        warn(
          decl.id,
          "bundle-child-app",
          `${profileApp} is declared by a bundled profile, and the bundle chart deploys no child ` +
            "applications - so this app is not deployed and the plan carries no Application or " +
            "dashboard for it",
          `deploy it beside the bundle, or move ${decl.bind.profile} out of the ${appPlaced.bundle} bundle`,
        );
      }
      for (const x of appInstances) {
        base.instances.push({
          id: x.id,
          scope: x.scope,
          region: x.region,
          target: x.target,
          application: appPlaced ? undefined : x.application,
          namespace: appPlaced ? appPlaced.namespace : x.namespace,
          grafanaDashboardUid: appPlaced ? undefined : grafanaUid(x.application, x.chart),
          destinations: (() => {
            const deployed = deployedFor(x.id, profileApp);
            return { deployed: deployed.length > 0 ? deployed : undefined };
          })(),
        });
      }
      if (wantedNames && appInstances.length > 0) {
        const known = new Set(appInstances.flatMap((x) => declaredEndpointNames(x.id)));
        for (const name of wantedNames) {
          if (!known.has(name)) {
            warn(source.path, "NEXUS006", `component ${decl.id}: endpointNames entry ${JSON.stringify(name)} matches no declared endpoint`);
          }
        }
      }
    }
    base.instances.sort((a, b) => a.id.localeCompare(b.id));
    planComponents.push(base);
  }

  for (const { decl, source } of people) {
    planComponents.push({
      id: decl.id,
      kind: "human",
      title: decl.displayName,
      personTitle: decl.title,
      source,
      resolved: true,
      cohorts: decl.cohorts,
      accessors: decl.accessors,
      instances: [],
    });
  }
  for (const { decl, source } of groups) {
    planComponents.push({
      id: decl.id,
      kind: "group",
      title: decl.title,
      groupKind: decl.kind,
      source,
      resolved: true,
      instances: [],
    });
  }
  planComponents.sort((a, b) => a.id.localeCompare(b.id));

  // --- Stage: the view -----------------------------------------------------
  const viewsById = new Map<string, { relPath: string; doc: ViewDoc }>();
  for (const v of inputs.views) {
    const id = v.doc.metadata.id;
    if (viewsById.has(id)) {
      err(v.relPath, "NEXUS007", `view id ${JSON.stringify(id)} is already provided by ${viewsById.get(id)!.relPath}`);
      continue;
    }
    viewsById.set(id, v);
  }
  const chosen = viewsById.get("default") ?? [...viewsById.values()].sort((a, b) => a.doc.metadata.id.localeCompare(b.doc.metadata.id))[0];

  const authoredNodes: NexusViewNode[] = [];
  if (chosen) {
    for (const n of chosen.doc.spec.nodes) {
      if (!nodeIds.has(n.ref)) {
        err(chosen.relPath, "NEXUS004", `view node ${JSON.stringify(n.ref)} is not a contributed component, person or group`);
        continue;
      }
      if (n.parent !== undefined && !groups.some((g) => g.decl.id === n.parent)) {
        err(chosen.relPath, "NEXUS004", `view node ${JSON.stringify(n.ref)}: parent ${JSON.stringify(n.parent)} is not a contributed group`);
        continue;
      }
      authoredNodes.push({ ref: n.ref, position: n.position, parent: n.parent });
    }
  }
  // Deterministic auto-placement for everything the view left out.
  const placed = new Set(authoredNodes.map((n) => n.ref));
  const yBase = authoredNodes.reduce((m, n) => Math.max(m, n.position.y), 0) + GRID.dy;
  const missing = [...nodeIds].filter((id) => !placed.has(id)).sort();
  missing.forEach((id, i) => {
    authoredNodes.push({
      ref: id,
      position: { x: GRID.x0 + (i % GRID.cols) * GRID.dx, y: yBase + Math.floor(i / GRID.cols) * GRID.dy },
    });
  });

  const view: NexusView = {
    id: chosen?.doc.metadata.id ?? "default",
    title: chosen?.doc.metadata.title,
    nodes: authoredNodes,
    viewport: chosen?.doc.spec.viewport,
  };

  // --- Assemble ------------------------------------------------------------
  // Version 2 only when a v1alpha2 feature is actually present in the
  // output: a linkless compile stays byte-identical to the v1alpha1 plan.
  const planVersion: 1 | 2 = planComponents.some((c) => c.links !== undefined) ? 2 : 1;
  const planNoHash = {
    version: planVersion,
    sourceSha: inputs.sourceSha ?? ZERO_SHA,
    components: planComponents,
    relationships: relationships.map(({ decl }) => decl).sort((a, b) => a.id.localeCompare(b.id)),
    view,
  };
  const inputsHash =
    inputs.inputsHash ??
    crypto.createHash("sha256").update(JSON.stringify(planNoHash)).digest("hex");

  return {
    plan: { version: planNoHash.version, inputsHash, sourceSha: planNoHash.sourceSha, components: planNoHash.components, relationships: planNoHash.relationships, view: planNoHash.view },
    icons: planIcons,
    findings,
    ok: !findings.some((f) => f.severity === "error"),
  };
}
