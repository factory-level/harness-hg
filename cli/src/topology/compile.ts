// The topology compiler (design 10, ADR-33): contracts x environment ->
// physical instances, endpoint bindings, capability bindings, URLs, and
// findings with stable TOPO rule ids. Pure functions end to end - no I/O,
// no clock, no randomness; identical inputs produce identical output
// (compile-twice byte-equality is a test).

import * as crypto from "node:crypto";
import type { ValidationFinding } from "../platform/index.ts";
import type {
  AppDecl,
  Contract,
  Endpoint,
  Layout,
  Requirement,
} from "./contract.ts";
import type { Environment, Target } from "./environment.ts";
import { compileCommunication, type CommunicationPlan } from "./communication.ts";

// ---------------------------------------------------------------------------
// Plan types

export interface AgentInstance {
  id: string; // <profile>@<scope>
  profile: string;
  scope: string; // "global" | region | target name
  region?: string;
  target: string;
  argoDestination: string;
  namespace: string;
  application: string; // Argo Application name
}

export interface AppInstance {
  id: string; // <profile>/<app>@<scope>
  profile: string;
  app: string;
  scope: string;
  region?: string;
  target: string;
  argoDestination: string;
  namespace: string;
  application: string;
  chart: string;
  repo: string;
  version?: string;
  pairedAgent?: string; // per-agent apps: the owning AgentInstance id
}

export interface EndpointBinding {
  id: string; // <instanceId>#<endpoint>
  owner: string; // AgentInstance or AppInstance id
  component: string; // "agent" | app name
  profile: string;
  scope: string;
  region?: string;
  target: string;
  argoDestination: string;
  endpoint: string;
  type: Endpoint["type"];
  provides?: string;
  /** Explicit backend routing - the hermes-endpoint chart consumes these
   * verbatim; nothing downstream parses URLs. */
  service: string;
  namespace: string;
  port: number;
  path: string;
  internalUrl: string;
  url?: string; // external projection; absent for internal / no base domain
}

export interface CapabilityBinding {
  capability: string;
  consumer: string; // consuming instance id (agent or app)
  consumerRegion?: string;
  provider: string; // EndpointBinding id
  providerRegion?: string;
  url: string;
  crossRegion: boolean;
  inject: Requirement["inject"];
}

export interface TopologyPlan {
  layout: Layout;
  sovereignty: "permissive" | "strict";
  agents: AgentInstance[];
  apps: AppInstance[];
  endpoints: EndpointBinding[];
  bindings: CapabilityBinding[];
  communication?: CommunicationPlan; // present when any contract declares it (ADR-39)
  findings: ValidationFinding[];
  ok: boolean; // no error-severity findings
}

// ---------------------------------------------------------------------------
// Naming

const K8S_NAME_MAX = 63;

/** Deterministic Kubernetes-name truncation: over-long names keep their
 * head and gain an 8-char sha256 suffix so distinct inputs stay distinct. */
export function k8sName(name: string): string {
  if (name.length <= K8S_NAME_MAX) return name;
  const hash = crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, K8S_NAME_MAX - 9)}-${hash}`;
}

/** Scope elision (D5): in the single layout, Kubernetes identity keeps
 * today's names - hermes-<profile> - so a migration moves zero workloads.
 * Hostnames are NOT elided (they always carry the scope label). */
function elide(layout: Layout): boolean {
  return layout === "single";
}

// ---------------------------------------------------------------------------
// Stage 1: expand multiplicities onto targets

function targetsFor(
  multiplicity: string,
  env: Environment,
): { scope: string; region?: string; target: Target }[] | { error: string } {
  const primaryOf = (regionName: string): Target => {
    const region = env.regions.find((r) => r.name === regionName)!;
    return region.targets.find((t) => t.primary) ?? region.targets[0]!;
  };
  switch (multiplicity) {
    case "singleton": {
      const targetName = env.globalTarget ?? (env.targets.length === 1 ? env.targets[0]!.name : undefined);
      if (!targetName) return { error: "singleton component but the environment declares no globalTarget" };
      const target = env.targets.find((t) => t.name === targetName)!;
      return [{ scope: "global", region: target.region, target }];
    }
    case "per-region":
      if (env.regions.length === 0) return { error: "per-region multiplicity with zero regions" };
      return env.regions.map((r) => ({
        scope: r.name,
        region: r.name,
        target: primaryOf(r.name),
      }));
    case "per-target":
      if (env.targets.length === 0) return { error: "per-target multiplicity with zero targets" };
      return env.targets.map((t) => ({ scope: t.name, region: t.region, target: t }));
    default:
      return { error: `unknown multiplicity ${multiplicity}` };
  }
}

// ---------------------------------------------------------------------------
// URL planning

function externalUrl(
  binding: { endpoint: string; component: string; profile: string; scope: string },
  base: string,
): string {
  // The two-label projection of the dotted logical identity (design 10):
  // one wildcard level under the base domain covers every endpoint.
  return `https://${binding.endpoint}.${binding.component}-${binding.profile}-${binding.scope}.${base}`;
}

function internalUrl(service: string, namespace: string, port: number, urlPath: string): string {
  const suffix = urlPath === "/" ? "" : urlPath;
  return `http://${service}.${namespace}.svc.cluster.local:${port}${suffix}`;
}

// ---------------------------------------------------------------------------
// compile()

export interface CompileOptions {
  layout?: Layout; // simulate without touching the environment file
  /** Loader findings (contract-schema, environment) merged in so ONE
   * place computes plan.ok over everything. */
  priorFindings?: ValidationFinding[];
  /** Argo CD cluster names actually registered with the control plane
   * (#176, TOPO017). When provided, every target's argoDestination must
   * be in this set - a destination Argo has never heard of would create
   * Applications that sit Unknown forever. Absent = the caller cannot
   * know (standalone CLI), and the check does not run; "in-cluster" is
   * always implicitly registered (Argo CD's built-in local name). */
  knownArgoDestinations?: string[];
}

export function compile(
  contracts: Contract[],
  env: Environment,
  options: CompileOptions = {},
): TopologyPlan {
  const layout = options.layout ?? env.layout;
  const findings: ValidationFinding[] = [...(options.priorFindings ?? [])];
  const RESERVED_INJECT_ENV = new Set([
    "DISCORD_ALLOWED_USERS",
    "DISCORD_ALLOWED_ROLES",
    "DISCORD_ALLOWED_CHANNELS",
    "GATEWAY_ALLOWED_USERS",
    "HERMES_OBSERVER_URL",
  ]);

  const err = (profile: string, check: string, message: string, fix?: string) =>
    findings.push({ profile, severity: "error", check, message, fix });

  const sorted = [...contracts].sort((a, b) => a.profile.localeCompare(b.profile));

  // The single layout is DEFINED as one target - with more, scope elision
  // (D5) would collapse distinct placements into one identity. Caught
  // here as the real error rather than as downstream name collisions.
  if (layout === "single" && env.targets.length > 1) {
    err(
      "*",
      "environment",
      `layout single requires exactly one target; the environment declares ${env.targets.length}`,
      "select a multi-target layout, or reduce the environment to one target",
    );
  }

  // TOPO017 (#176) - every target's argoDestination must name a cluster
  // the control plane has actually registered. Registration and
  // consumption were built in separate arcs and never met: an
  // environment could register clusters nothing consumed, and a
  // topology could name destinations nothing registered - the latter
  // creating Applications that sit Unknown forever. Only runs when the
  // caller knows the registration list (the Pulumi preview gate passes
  // it); the standalone CLI cannot know and stays silent.
  if (options.knownArgoDestinations !== undefined) {
    const known = new Set(["in-cluster", ...options.knownArgoDestinations]);
    for (const t of env.targets) {
      if (!known.has(t.argoDestination)) {
        err(
          "*",
          "TOPO017",
          `target ${t.name} names argoDestination ${JSON.stringify(t.argoDestination)}, which is not a ` +
            `registered Argo CD cluster (registered: ${[...known].sort().join(", ")})`,
          `register it in stack config: hermes-gitops-bootstrap:targetClusters[] with name ${JSON.stringify(t.argoDestination)}, or fix the environment/topology.yaml destination`,
        );
      }
    }
  }

  // TOPO001 - the selected layout must be supported by every profile.
  for (const c of sorted) {
    if (!c.supportedLayouts.includes(layout)) {
      err(
        c.profile,
        "TOPO001",
        `layout ${layout} is not in supportedLayouts [${c.supportedLayouts.join(", ")}]`,
        "add the layout to topology.supportedLayouts once the profile is validated for it",
      );
    }
  }

  // --- Stage: expand agents ------------------------------------------------
  const agents: AgentInstance[] = [];
  for (const c of sorted) {
    const placed = targetsFor(c.agent.multiplicity, env);
    if ("error" in placed) {
      err(c.profile, c.agent.multiplicity === "singleton" ? "TOPO002" : "TOPO003", `agent: ${placed.error}`);
      continue;
    }
    for (const p of placed) {
      // ADR-151: the prefix is the runtime's (hermes- / ag-eve-).
      const prefix = c.runtime === "eve" ? "ag-eve-" : "hermes-";
      const bare = elide(layout) ? `${prefix}${c.profile}` : `${prefix}${c.profile}-${p.scope}`;
      agents.push({
        id: elide(layout) ? c.profile : `${c.profile}@${p.scope}`,
        profile: c.profile,
        scope: p.scope,
        region: p.region,
        target: p.target.name,
        argoDestination: p.target.argoDestination,
        namespace: k8sName(bare),
        application: k8sName(bare),
      });
    }
  }

  // --- Stage: expand apps --------------------------------------------------
  const apps: AppInstance[] = [];
  for (const c of sorted) {
    for (const app of c.apps) {
      // TOPO008 - chart-source policy (local charts are always allowed).
      if (
        app.repo !== "local" &&
        env.policy.allowedChartSources.length > 0 &&
        !env.policy.allowedChartSources.some((s) => app.repo.startsWith(s))
      ) {
        err(
          c.profile,
          "TOPO008",
          `app ${app.name}: chart source ${app.repo} is not in environment/policy.yaml allowedChartSources`,
          "add the source to allowedChartSources, or move the chart to an allowed registry",
        );
      }
      if (app.multiplicity === "per-agent") {
        // One instance beside every physical agent instance, in the
        // agent's namespace (today's co-location - monitoring reads
        // same-namespace ConfigMaps).
        for (const agent of agents.filter((a) => a.profile === c.profile)) {
          apps.push({
            id: elide(layout) ? `${c.profile}/${app.name}` : `${c.profile}/${app.name}@${agent.scope}`,
            profile: c.profile,
            app: app.name,
            scope: agent.scope,
            region: agent.region,
            target: agent.target,
            argoDestination: agent.argoDestination,
            namespace: agent.namespace,
            application: k8sName(`${agent.application}-${app.name}`),
            chart: app.chart,
            repo: app.repo,
            version: app.version,
            pairedAgent: agent.id,
          });
        }
        continue;
      }
      const placed = targetsFor(app.multiplicity, env);
      if ("error" in placed) {
        err(c.profile, app.multiplicity === "singleton" ? "TOPO002" : "TOPO003", `app ${app.name}: ${placed.error}`);
        continue;
      }
      for (const p of placed) {
        // D5/D6: single layout keeps today's identity - the app deploys
        // into the (sole) agent's namespace under the legacy child name.
        const soleAgent = agents.find((a) => a.profile === c.profile);
        const single = elide(layout) && soleAgent;
        const bare = single
          ? { ns: soleAgent.namespace, appName: `${soleAgent.application}-${app.name}` }
          : {
              ns: `hermes-app-${c.profile}-${app.name}-${p.scope}`,
              appName: `hermes-app-${c.profile}-${app.name}-${p.scope}`,
            };
        apps.push({
          id: single ? `${c.profile}/${app.name}` : `${c.profile}/${app.name}@${p.scope}`,
          profile: c.profile,
          app: app.name,
          scope: single ? soleAgent.scope : p.scope,
          region: p.region,
          target: p.target.name,
          argoDestination: p.target.argoDestination,
          namespace: k8sName(bare.ns),
          application: k8sName(bare.appName),
          chart: app.chart,
          repo: app.repo,
          version: app.version,
        });
      }
    }
  }

  // TOPO010/TOPO011 - namespace and Application-name collisions. A shared
  // namespace is legal only for instances that DECLARE co-location (an
  // app in its agent's namespace); the guard is per (namespace, owner
  // profile+scope disjointness) on Application names, which must be
  // globally unique in the argocd namespace.
  const appNames = new Map<string, string>();
  for (const inst of [...agents, ...apps]) {
    const prior = appNames.get(inst.application);
    if (prior) {
      err(
        inst.profile,
        "TOPO011",
        `Argo Application name collision: ${inst.application} (${prior} vs ${inst.id})`,
      );
    } else appNames.set(inst.application, inst.id);
  }
  const nsOwners = new Map<string, string>();
  for (const agent of agents) {
    const prior = nsOwners.get(agent.namespace);
    if (prior) {
      err(agent.profile, "TOPO010", `namespace collision: ${agent.namespace} (${prior} vs ${agent.id})`);
    } else nsOwners.set(agent.namespace, agent.id);
  }
  for (const app of apps) {
    // Declared co-location is exempt: a per-agent app in its agent's
    // namespace, or (single layout, D5) any app in its OWN profile's
    // sole agent namespace - exact id match, never a prefix test.
    if (app.pairedAgent || (elide(layout) && nsOwners.get(app.namespace) === app.profile)) continue;
    const prior = nsOwners.get(app.namespace);
    if (prior && prior !== app.id) {
      err(app.profile, "TOPO010", `namespace collision: ${app.namespace} (${prior} vs ${app.id})`);
    } else nsOwners.set(app.namespace, app.id);
  }

  // --- Stage: endpoint bindings + URLs ------------------------------------
  const endpoints: EndpointBinding[] = [];
  const addEndpoint = (
    owner: AgentInstance | AppInstance,
    component: string,
    service: string,
    e: Endpoint,
  ) => {
    const binding: EndpointBinding = {
      id: `${owner.id}#${e.name}`,
      owner: owner.id,
      component,
      profile: owner.profile,
      scope: owner.scope,
      region: owner.region,
      target: owner.target,
      argoDestination: owner.argoDestination,
      endpoint: e.name,
      type: e.type,
      provides: e.provides,
      service,
      namespace: owner.namespace,
      port: e.port,
      path: e.path ?? "/",
      internalUrl: internalUrl(service, owner.namespace, e.port, e.path ?? "/"),
    };
    const base =
      e.type === "private" ? env.dns.privateBaseDomain : e.type === "internal" ? undefined : env.dns.publicBaseDomain;
    if (base) binding.url = externalUrl(binding, base);
    endpoints.push(binding);
  };
  for (const c of sorted) {
    const names = new Set<string>();
    for (const e of c.endpoints) {
      if (names.has(e.name)) err(c.profile, "TOPO009", `duplicate agent endpoint name ${e.name}`);
      names.add(e.name);
      for (const agent of agents.filter((a) => a.profile === c.profile)) {
        // The agent Service is hermes-<name> - the chart's own convention.
        addEndpoint(agent, "agent", agent.namespace, e);
      }
    }
    for (const app of c.apps) {
      const appNames2 = new Set<string>();
      for (const e of app.endpoints) {
        if (appNames2.has(e.name)) err(c.profile, "TOPO009", `duplicate endpoint name ${e.name} in app ${app.name}`);
        appNames2.add(e.name);
        for (const inst of apps.filter((a) => a.profile === c.profile && a.app === app.name)) {
          addEndpoint(inst, app.name, e.service ?? app.name, e);
        }
      }
    }
  }
  // TOPO009 - hostname+path collisions across the whole plan.
  const hostSeen = new Map<string, string>();
  for (const b of endpoints) {
    if (!b.url) continue;
    const prior = hostSeen.get(b.url);
    if (prior) err(b.profile, "TOPO009", `URL collision: ${b.url} (${prior} vs ${b.id})`);
    else hostSeen.set(b.url, b.id);
  }
  // TOPO013 - unverifiable webhooks (schema-enforced for v2; adapted v1
  // files cannot produce webhook endpoints, so this guards future paths).
  for (const c of sorted) {
    for (const e of [...c.endpoints, ...c.apps.flatMap((a) => a.endpoints)]) {
      if (e.type === "webhook" && !e.signature) {
        err(c.profile, "TOPO013", `webhook endpoint ${e.name} declares no signature verification`);
      }
    }
  }

  // TOPO007 - jurisdiction policy.
  if (env.policy.allowedJurisdictions) {
    const allowed = new Set(env.policy.allowedJurisdictions);
    for (const t of env.targets) {
      if (!allowed.has(t.jurisdiction)) {
        err(
          "*",
          "TOPO007",
          `target ${t.name} is in jurisdiction ${t.jurisdiction}, not allowed by environment/policy.yaml`,
        );
      }
    }
  }

  // --- Stage: capability resolution ---------------------------------------
  const bindings: CapabilityBinding[] = [];
  const providers = endpoints.filter((e) => e.provides);
  const boundaryOf = (b: EndpointBinding): string => {
    const c = sorted.find((x) => x.profile === b.profile)!;
    if (b.component === "agent") return c.agent.dataBoundary;
    return c.apps.find((a) => a.name === b.component)?.dataBoundary ?? "target";
  };

  for (const c of sorted) {
    for (const req of c.requires) {
      // Consumers: agent instances for env injection, app instances for
      // appValue injection.
      let consumers: { id: string; region?: string; target: string; argoDestination: string }[];
      let duplicateEnv = false;
      if (req.inject.appValue) {
        const appName = req.inject.appValue.app;
        const forbidden = req.inject.appValue.path
          .split(".")
          .filter((seg) => ["__proto__", "prototype", "constructor"].includes(seg));
        if (forbidden.length > 0) {
          err(
            c.profile,
            "TOPO015",
            `requires[${req.capability}] inject path contains forbidden segment ${forbidden[0]}`,
          );
          continue;
        }
        if (!c.apps.some((a) => a.name === appName)) {
          err(
            c.profile,
            "TOPO015",
            `requires[${req.capability}] injects into app ${appName}, which this profile does not declare`,
          );
          continue;
        }
        consumers = apps.filter((a) => a.profile === c.profile && a.app === appName);
      } else {
        if (req.inject.env) {
          if (c.envRequires.includes(req.inject.env)) {
            err(
              c.profile,
              "TOPO014",
              `requires[${req.capability}] injects env ${req.inject.env}, already declared in env_requires`,
            );
          }
          // Authorization and observability variables are RESERVED
          // (Codex catch): a capability injection targeting the
          // gateway's enforced allowlists could widen or replace an
          // authorization boundary with a URL, silently.
          if (RESERVED_INJECT_ENV.has(req.inject.env)) {
            err(
              c.profile,
              "TOPO014",
              `requires[${req.capability}] injects env ${req.inject.env}, a reserved gateway ` +
                "authorization/observability variable - injections may never write an enforcement input",
              "rename the inject.env target (convention: HERMES_CAP_<NAME>_URL)",
            );
          }
          const dup = c.requires.filter((r) => r.inject.env === req.inject.env);
          if (dup.length > 1) {
            // Report once (via the first); every duplicate still gets its
            // full TOPO004/005/006/012 evaluation below, but none binds -
            // a half-bound duplicate would mask the conflict.
            if (dup[0] === req) {
              err(c.profile, "TOPO014", `two requirements inject the same env ${req.inject.env}`);
            }
            duplicateEnv = true;
          }
        }
        consumers = agents.filter((a) => a.profile === c.profile);
      }

      for (const consumer of consumers) {
        const candidates = providers.filter((p) => {
          if (p.provides !== req.capability) return false;
          if (req.locality === "same-target") return p.target === consumer.target;
          if (req.locality === "same-region") return p.region !== undefined && p.region === consumer.region;
          return true; // global
        });
        // Environment-provided capabilities (ADR-98, #144): the second
        // provider source. An environment binding has no target, so it
        // can never satisfy same-target; same-region matches on the
        // binding's declared region.
        const envCandidates = (env.capabilityBindings ?? []).filter((b) => {
          if (b.capability !== req.capability) return false;
          if (req.locality === "same-target") return false;
          if (req.locality === "same-region") return b.region !== undefined && b.region === consumer.region;
          return true; // global
        });
        // Satisfied by BOTH sources is ambiguity, never precedence: two
        // authorities for one URL is a conflict to resolve in the
        // declarations, not a ranking for the compiler to invent.
        if (candidates.length > 0 && envCandidates.length > 0) {
          err(
            c.profile,
            "TOPO005",
            `capability ${req.capability} for ${consumer.id} is provided by BOTH a profile endpoint ` +
              `(${candidates.map((p) => p.id).join(", ")}) and an environment binding ` +
              `(environment/capabilities.yaml: ${envCandidates[0]!.implementation})`,
            "remove one of the two - the compiler never ranks provider sources",
          );
          continue;
        }
        if (envCandidates.length === 1) {
          const b = envCandidates[0]!;
          const crossRegion =
            b.region !== undefined && consumer.region !== undefined && b.region !== consumer.region;
          if (crossRegion && env.sovereignty === "strict") {
            err(
              c.profile,
              "TOPO006",
              `strict sovereignty: ${consumer.id} depends on environment binding ${req.capability} ` +
                `across regions (${consumer.region} -> ${b.region})`,
              "bind the capability in the consumer's region, or relax sovereignty to permissive",
            );
            continue;
          }
          if (duplicateEnv) continue;
          bindings.push({
            capability: req.capability,
            consumer: consumer.id,
            consumerRegion: consumer.region,
            provider: `environment:${req.capability}`,
            providerRegion: b.region,
            url: b.url,
            crossRegion,
            inject: req.inject,
          });
          continue;
        }
        if (candidates.length === 0) {
          if (req.optional) {
            // v1alpha4: an unsatisfied OPTIONAL requirement is an absent
            // injection, not a broken plan. A warning (never silence)
            // because the operator reading the plan should see WHY the
            // variable is missing - and a consumer that cannot actually
            // tolerate the absence mislabelled its requirement.
            findings.push({
              profile: c.profile,
              severity: "warning",
              check: "TOPO004",
              message:
                `optional capability ${req.capability} (locality ${req.locality}) has no provider ` +
                `reachable from ${consumer.id} - ` +
                `${req.inject.env ?? req.inject.appValue?.path ?? "the injection"} will be absent`,
            });
            continue;
          }
          err(
            c.profile,
            "TOPO004",
            `no provider for capability ${req.capability} (locality ${req.locality}) reachable from ${consumer.id}`,
            "declare a provides: endpoint for it, or widen the locality",
          );
          continue;
        }
        if (candidates.length > 1) {
          err(
            c.profile,
            "TOPO005",
            `ambiguous providers for capability ${req.capability} from ${consumer.id}: ` +
              candidates.map((p) => p.id).join(", "),
          );
          continue;
        }
        const provider = candidates[0]!;
        const crossRegion =
          provider.region !== undefined && consumer.region !== undefined && provider.region !== consumer.region;
        const crossTarget = provider.target !== consumer.target;
        // Every violation is evaluated INDEPENDENTLY (all-findings, never
        // first-error): a broken edge reports everything wrong with it,
        // then binds nothing.
        let broken = duplicateEnv;
        if (crossRegion && env.sovereignty === "strict") {
          broken = true;
          err(
            c.profile,
            "TOPO006",
            `strict sovereignty: ${consumer.id} depends on ${provider.id} across regions ` +
              `(${consumer.region} -> ${provider.region})`,
            "make the provider per-region, or relax sovereignty to permissive",
          );
        }
        // TOPO012 - the provider's declared data boundary must contain its
        // consumers: a region-bounded component consumed cross-region (or
        // a target-bounded one cross-target) is a contradiction in ANY
        // sovereignty mode.
        const boundary = boundaryOf(provider);
        if ((boundary === "region" && crossRegion) || (boundary === "target" && crossTarget)) {
          broken = true;
          err(
            provider.profile,
            "TOPO012",
            `${provider.component} declares dataBoundary ${boundary} but is consumed from ` +
              `${consumer.id} (${boundary === "region" ? "another region" : "another target"})`,
          );
        }
        // TOPO016 - a binding that crosses Argo destinations (different
        // clusters) needs an externally reachable URL: the cluster-DNS
        // fallback only resolves inside the provider's cluster. Targets
        // sharing one destination (deployment cells) keep cluster DNS.
        if (provider.argoDestination !== consumer.argoDestination && !provider.url) {
          broken = true;
          err(
            c.profile,
            "TOPO016",
            `${consumer.id} consumes ${provider.id} on another cluster, but the endpoint has no ` +
              `externally reachable URL (type ${provider.type}, no matching base domain)`,
            "declare dns.publicBaseDomain/privateBaseDomain, or make the endpoint type externally projectable",
          );
        }
        if (broken) continue;
        bindings.push({
          capability: req.capability,
          consumer: consumer.id,
          consumerRegion: consumer.region,
          provider: provider.id,
          providerRegion: provider.region,
          url: provider.url ?? provider.internalUrl,
          crossRegion,
          inject: req.inject,
        });
      }
    }
  }

  // --- Stage: the communication plane (ADR-39) -----------------------------
  // Compiled only when some contract declares it; findings merge into the
  // same pool so ONE place computes ok.
  let communication: CommunicationPlan | undefined;
  if (sorted.some((c) => c.communication || c.apps.some((a) => a.outputs.length > 0))) {
    const sortedAgents = [...agents].sort((a, b) => a.id.localeCompare(b.id));
    const sortedApps = [...apps].sort((a, b) => a.id.localeCompare(b.id));
    const result = compileCommunication(sorted, env, {
      layout,
      agents: sortedAgents,
      apps: sortedApps,
    });
    communication = result.plan;
    findings.push(...result.findings);
  }

  const byId = <T extends { id: string }>(arr: T[]) => [...arr].sort((a, b) => a.id.localeCompare(b.id));
  const plan: TopologyPlan = {
    layout,
    sovereignty: env.sovereignty,
    agents: byId(agents),
    apps: byId(apps),
    endpoints: byId(endpoints),
    bindings: [...bindings].sort((a, b) =>
      `${a.capability}/${a.consumer}`.localeCompare(`${b.capability}/${b.consumer}`),
    ),
    communication,
    findings,
    ok: !findings.some((f) => f.severity === "error"),
  };
  return plan;
}
