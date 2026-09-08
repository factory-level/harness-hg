// The communication compiler (ADR-39): contract v3 communication blocks x
// environment/communication.yaml x the topology plan -> producer bindings,
// route delivery edges, ChatOps space bindings, external input bindings,
// router instances, and findings with stable EVENT/CHATOPS rule ids.
//
// Pure functions, same discipline as compile.ts: no I/O, no clock, no
// randomness. compile() calls compileCommunication() so ONE plan carries
// everything and ONE place computes ok.
//
// The plane's destination for an agent edge is a handler on the target
// profile's OWN Hermes gateway (a declared webhook endpoint whose path is
// /webhooks/<handler>) - the router delivers TO the gateway, exactly as
// the marketing-sre relay does today. It is not a replacement for the
// gateway, and there is no fallback profile: an edge that cannot bind to
// a declared handler is an error, never a guess.

import type { ValidationFinding } from "../platform/index.ts";
import type {
  AgentOutputTarget,
  Contract,
  DeliveryPolicy,
  ExternalInputDecl,
  RouteDecl,
  SessionPolicy,
} from "./contract.ts";
import type { EnvCommunication, Environment } from "./environment.ts";
import type { AgentInstance, AppInstance } from "./compile.ts";
import { k8sName } from "./compile.ts";

// ---------------------------------------------------------------------------
// Plan types

export interface RouterInstance {
  id: string; // router@<scope>
  scope: string; // "global" | region name
  region?: string;
  target: string;
  argoDestination: string;
  namespace: string; // hermes-system, or hermes-system-<region>
  service: string; // hermes-event-router
  application: string;
}

export interface ProducerBinding {
  id: string; // <appInstanceId>#<output>
  name: string; // <profile>/<app>#<output> - the logical producer the CLI addresses
  profile: string;
  app: string;
  appInstance: string;
  output: string;
  event: string;
  schema?: string;
  subject?: string; // payload dot-path -> envelope.subject
  scope: string;
  region?: string;
  router: string; // RouterInstance id this producer publishes through
  ingestPath: string; // /v1/events/<slug> on the router
  ingestUrl: string; // full in-cluster URL, injected at inject.path
  inject?: { app: string; path: string }; // the producing app's own values
  routes: string[]; // route names consuming this output (EVENT001 when empty)
}

export interface ExternalInputBinding {
  id: string; // <profile>/<name>
  profile: string;
  name: string;
  event: string;
  schema?: string;
  subject?: string;
  provider?: string;
  verification: ExternalInputDecl["verification"];
  accepts?: string[];
  hookPath: string; // /v1/hooks/<slug> on the shared gateway (the router)
  routes: string[];
}

export interface ResolvedDelivery {
  mode: "direct" | "queued";
  retry: { maxAttempts: number; backoff: "fixed" | "exponential" };
  deadLetter: { enabled: boolean; retention?: string };
  ordering?: { mode: "fifo"; key: string; onFailure: "block" | "dead-letter-and-continue" };
}

export interface AgentEdgeTarget {
  profile: string;
  handler: string;
  instance: string; // AgentInstance id - resolved physically, no fallback
  namespace: string;
  service: string; // the agent's own gateway Service
  port: number; // from the declared webhook endpoint
  path: string; // /webhooks/<handler>
  url: string; // in-cluster URL of the gateway route
  signature: string; // the endpoint's declared scheme (hmac-sha256)
  secretName: string; // <namespace>-env - the profile's WEBHOOK_SECRET home
  session: { mode: SessionPolicy["mode"]; key?: string };
}

export interface ChatopsEdgeTarget {
  space: string; // <alias>#<destination>
  alias: string;
  destination: string;
  provider: string; // resolved plugin (recording locally)
}

export interface RouteEdge {
  id: string; // <profile>/<route>@<scope>-><n>
  route: string;
  profile: string; // route-owning profile
  scope: string;
  region?: string;
  router: string; // RouterInstance id that executes this edge
  from: { producer?: string; externalInput?: string }; // binding ids
  event: string;
  filter?: Record<string, string | number | boolean>;
  kind: "agent" | "chatops";
  agent?: AgentEdgeTarget;
  chatops?: ChatopsEdgeTarget;
  delivery: ResolvedDelivery;
}

export interface ChatopsSpaceBinding {
  id: string; // <alias>#<destination>
  alias: string;
  destination: string;
  provider: string;
  credentialRef?: { name?: string; key?: string; env?: string };
  routes: string[]; // auto-registration: referencing a space IS registering it
}

export interface CommunicationPlan {
  routers: RouterInstance[];
  producers: ProducerBinding[];
  externalInputs: ExternalInputBinding[];
  edges: RouteEdge[];
  chatopsSpaces: ChatopsSpaceBinding[];
  durableProvider?: { plugin: string; config?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Durable provider capability table. A route asking for a capability the
// selected plugin lacks fails compilation (EVENT007) - a requested
// guarantee is never silently weakened. dapr.* rows arrive with the cloud
// phase; the contract is this table, not the transport.

export interface ProviderCapabilities {
  queued: boolean;
  orderedByKey: boolean;
  deadLetter: boolean;
  replay: boolean;
  deduplication: boolean;
}

export const DURABLE_PROVIDERS: Record<string, ProviderCapabilities> = {
  "redis-streams": {
    queued: true,
    orderedByKey: true,
    deadLetter: true,
    replay: true,
    deduplication: true,
  },
};

const DEFAULT_RETRY = { maxAttempts: 5, backoff: "exponential" as const };

/** The reserved broadcast event (ADR-77's reservation, made real): one
 * test event every distribution ships, fanned out by the router to every
 * webhook-capable profile. Persona declarations may not claim the name -
 * the platform synthesizes the producer and the edges. */
export const RESERVED_BROADCAST_EVENT = "agents.all/v1";
const RESERVED_EVENT_RE = /^agents\.all(\/|$)/;

export function slug(id: string): string {
  return id.replace(/[@/#]/g, "-");
}

function routerUrl(router: RouterInstance, urlPath: string): string {
  return `http://${router.service}.${router.namespace}.svc.cluster.local${urlPath}`;
}

function resolveDelivery(
  routeDefault: DeliveryPolicy | undefined,
  override: DeliveryPolicy | undefined,
): ResolvedDelivery {
  const d = override ?? routeDefault;
  return {
    mode: d?.mode ?? "direct",
    retry: {
      maxAttempts: d?.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
      backoff: d?.retry?.backoff ?? DEFAULT_RETRY.backoff,
    },
    deadLetter: {
      enabled: d?.deadLetter?.enabled ?? d?.mode === "queued",
      retention: d?.deadLetter?.retention,
    },
    ordering: d?.ordering
      ? {
          mode: "fifo",
          key: d.ordering.key,
          onFailure: d.ordering.onFailure ?? "dead-letter-and-continue",
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// compileCommunication()

export function compileCommunication(
  contracts: Contract[],
  env: Environment,
  topo: { layout: string; agents: AgentInstance[]; apps: AppInstance[] },
): { plan: CommunicationPlan; findings: ValidationFinding[] } {
  const findings: ValidationFinding[] = [];
  const err = (profile: string, check: string, message: string, fix?: string) =>
    findings.push({ profile, severity: "error", check, message, fix });
  const warn = (profile: string, check: string, message: string) =>
    findings.push({ profile, severity: "warning", check, message });

  const sorted = [...contracts].sort((a, b) => a.profile.localeCompare(b.profile));
  const elide = topo.layout === "single";

  const comm = env.communication;

  // --- Routers: one per scope that hosts any producer or agent. Locally
  // (single layout) that is exactly one, in hermes-system. Multi-region
  // environments get one per region so events stay region-local unless a
  // route explicitly crosses.
  const routers: RouterInstance[] = [];
  const routerFor = (scope: string, region: string | undefined, target: string, argoDestination: string): RouterInstance => {
    const existing = routers.find((r) => r.scope === scope);
    if (existing) return existing;
    const bare = elide ? "hermes-system" : `hermes-system-${scope}`;
    const router: RouterInstance = {
      id: elide ? "router" : `router@${scope}`,
      scope,
      region,
      target,
      argoDestination,
      namespace: k8sName(bare),
      service: "hermes-event-router",
      application: k8sName(elide ? "hermes-event-router" : `hermes-event-router-${scope}`),
    };
    routers.push(router);
    return router;
  };

  // --- Producers: one binding per physical instance of each app that
  // declares outputs.
  const producers: ProducerBinding[] = [];
  for (const c of sorted) {
    for (const app of c.apps) {
      const seen = new Set<string>();
      for (const out of app.outputs) {
        if (seen.has(out.name)) {
          err(c.profile, "EVENT004", `app ${app.name} declares output ${out.name} twice`);
          continue;
        }
        seen.add(out.name);
        // EVENT014 - the agents.all namespace is platform-reserved: the
        // broadcast is synthesized below, and a persona-declared twin
        // would be a second authority for the same event name.
        if (RESERVED_EVENT_RE.test(out.event)) {
          err(
            c.profile,
            "EVENT014",
            `app ${app.name} output ${out.name} declares event ${out.event} - agents.all is ` +
              "platform-reserved (the broadcast is synthesized; personas cannot produce it)",
          );
          continue;
        }
        // EVENT010 - the output's inject path must not collide with a
        // capability injection into the same app (both write the same
        // dot-path of the same values).
        const injectPath = out.adapter?.inject?.appValue?.path;
        if (injectPath) {
          const clash = c.requires.find(
            (r) => r.inject.appValue?.app === app.name && r.inject.appValue.path === injectPath,
          );
          if (clash) {
            err(
              c.profile,
              "EVENT010",
              `app ${app.name} output ${out.name} injects at ${injectPath}, ` +
                `which requires[${clash.capability}] also injects - one URL would clobber the other`,
            );
          }
        }
        for (const inst of topo.apps.filter((a) => a.profile === c.profile && a.app === app.name)) {
          const router = routerFor(inst.scope, inst.region, inst.target, inst.argoDestination);
          const id = `${inst.id}#${out.name}`;
          const ingestPath = `/v1/events/${slug(id)}`;
          producers.push({
            id,
            name: `${c.profile}/${app.name}#${out.name}`,
            profile: c.profile,
            app: app.name,
            appInstance: inst.id,
            output: out.name,
            event: out.event,
            schema: out.schema,
            subject: out.subject,
            scope: inst.scope,
            region: inst.region,
            router: router.id,
            ingestPath,
            ingestUrl: routerUrl(router, ingestPath),
            inject: injectPath ? { app: app.name, path: injectPath } : undefined,
            routes: [],
          });
        }
      }
    }
  }

  // --- External inputs: bound to the shared gateway (the router). Under a
  // multi-scope layout they live on every router - the binding id, not the
  // instance, is the public identity.
  const externalInputs: ExternalInputBinding[] = [];
  for (const c of sorted) {
    const seen = new Set<string>();
    for (const ext of c.communication?.externalInputs ?? []) {
      if (seen.has(ext.name)) {
        err(c.profile, "EVENT004", `externalInputs declares ${ext.name} twice`);
        continue;
      }
      seen.add(ext.name);
      if (RESERVED_EVENT_RE.test(ext.event)) {
        err(
          c.profile,
          "EVENT014",
          `externalInput ${ext.name} declares event ${ext.event} - agents.all is ` +
            "platform-reserved (the broadcast is synthesized; personas cannot ingest it)",
        );
        continue;
      }
      const id = `${c.profile}/${ext.name}`;
      externalInputs.push({
        id,
        profile: c.profile,
        name: ext.name,
        event: ext.event,
        schema: ext.schema,
        subject: ext.subject,
        provider: ext.provider,
        verification: ext.verification,
        accepts: ext.accepts,
        hookPath: `/v1/hooks/${slug(id)}`,
        routes: [],
      });
    }
  }

  // --- ChatOps spaces: auto-registered from route references.
  const chatopsSpaces = new Map<string, ChatopsSpaceBinding>();
  const resolveSpace = (profile: string, route: string, space: string): ChatopsEdgeTarget | undefined => {
    const hash = space.indexOf("#");
    const alias = space.slice(0, hash);
    const destination = space.slice(hash + 1);
    const connection = comm?.chatopsConnections[alias];
    if (!connection) {
      err(
        profile,
        "CHATOPS001",
        comm
          ? `route ${route} references ChatOps alias ${alias}, not declared in environment/communication.yaml`
          : `route ${route} references ChatOps space ${space}, but the environment declares no communication.yaml`,
        "declare the connection alias (provider + credentialRef) in environment/communication.yaml",
      );
      return undefined;
    }
    if (!["recording", "slack", "generic-webhook"].includes(connection.provider)) {
      err(profile, "CHATOPS001", `route ${route}: unsupported provider; Discord is roadmap-only`);
      return undefined;
    }
    let binding = chatopsSpaces.get(space);
    if (!binding) {
      binding = {
        id: space,
        alias,
        destination,
        provider: connection.provider,
        credentialRef: connection.credentialRef,
        routes: [],
      };
      chatopsSpaces.set(space, binding);
    }
    if (!binding.routes.includes(route)) binding.routes.push(route);
    return { space, alias, destination, provider: connection.provider };
  };

  // --- Delivery capability enforcement (EVENT006/EVENT007).
  const requireDurable = (profile: string, route: string, delivery: ResolvedDelivery): boolean => {
    if (delivery.mode !== "queued") return true;
    const plugin = comm?.durableProvider?.plugin;
    if (!plugin) {
      err(
        profile,
        "EVENT006",
        `route ${route} requires queued delivery, but the environment declares no durableProvider`,
        "declare durableProvider in environment/communication.yaml (local: redis-streams)",
      );
      return false;
    }
    const caps = DURABLE_PROVIDERS[plugin];
    if (!caps) {
      err(profile, "EVENT007", `route ${route}: unknown durable provider plugin ${plugin}`);
      return false;
    }
    const needed: (keyof ProviderCapabilities)[] = ["queued"];
    if (delivery.ordering) needed.push("orderedByKey");
    if (delivery.deadLetter.enabled) needed.push("deadLetter");
    const missing = needed.filter((cap) => !caps[cap]);
    if (missing.length > 0) {
      err(
        profile,
        "EVENT007",
        `route ${route} requires ${missing.join(", ")}, but provider ${plugin} does not provide it`,
        "select a provider with the capability, or relax the route's delivery policy",
      );
      return false;
    }
    return true;
  };

  // --- Agent target resolution: the fail-closed core. The target profile's
  // own contract must declare a webhook endpoint at /webhooks/<handler>;
  // the physical instance is same-region first, else the profile's sole
  // global/singleton instance - never "the first available".
  const resolveAgent = (
    ownerProfile: string,
    route: string,
    scope: string,
    region: string | undefined,
    target: AgentOutputTarget,
  ): AgentEdgeTarget | undefined => {
    const targetContract = sorted.find((c) => c.profile === target.profile);
    if (!targetContract) {
      err(ownerProfile, "EVENT003", `route ${route} targets profile ${target.profile}, which does not exist`);
      return undefined;
    }
    const handlerPath = `/webhooks/${target.handler}`;
    const endpoint = targetContract.endpoints.find((e) => e.type === "webhook" && e.path === handlerPath);
    if (!endpoint) {
      err(
        ownerProfile,
        "EVENT003",
        `route ${route} targets handler ${target.handler} on ${target.profile}, but that profile ` +
          `declares no webhook endpoint at ${handlerPath} - there is no fallback, the edge does not bind`,
        `declare an endpoints[] entry {type: webhook, path: ${handlerPath}, signature: hmac-sha256} in ${target.profile}`,
      );
      return undefined;
    }
    const instances = topo.agents.filter((a) => a.profile === target.profile);
    const sameRegion = instances.filter((a) => a.region !== undefined && a.region === region);
    const globals = instances.filter((a) => a.scope === "global");
    const candidates = sameRegion.length > 0 ? sameRegion : globals.length > 0 ? globals : instances.length === 1 ? instances : [];
    if (candidates.length !== 1) {
      err(
        ownerProfile,
        "EVENT011",
        candidates.length === 0
          ? `route ${route}: no ${target.profile} instance reachable from scope ${scope} ` +
              `(no same-region instance, no global instance) - no fallback is attempted`
          : `route ${route}: ambiguous ${target.profile} instances from scope ${scope}: ` +
              candidates.map((a) => a.id).join(", "),
      );
      return undefined;
    }
    const inst = candidates[0]!;
    const session = target.session ?? { mode: "per-event" as const };

    // A BUNDLED target does not have the per-profile namespace and
    // Service this URL is otherwise built from - bundling retires both -
    // so addressing it that way resolves to something that does not
    // exist. Redirect to the bundle's own Service, and fail closed when
    // the bundle has not published a port for it: a route that compiles
    // to a dead URL is worse than one that refuses to compile.
    const bundled = env.bundledProfiles?.[target.profile];
    if (bundled) {
      if (bundled.webhookPort === undefined) {
        err(
          ownerProfile,
          "EVENT003",
          `route ${route} targets ${target.profile}, which is bundled into ${bundled.bundle} - ` +
            `bundling retires its own Service, so the bundle must declare where its gateway listens`,
          `add webhookPort: ${endpoint.port} to profiles[${target.profile}] in environment/bundles.yaml ` +
            `(and set version: 2)`,
        );
        return undefined;
      }
      return {
        profile: target.profile,
        handler: target.handler,
        instance: inst.id,
        namespace: bundled.namespace,
        service: bundled.service,
        port: bundled.webhookPort,
        path: handlerPath,
        url: `http://${bundled.service}.${bundled.namespace}.svc.cluster.local:${bundled.webhookPort}${handlerPath}`,
        signature: endpoint.signature ?? "hmac-sha256",
        // The bundle copies each profile's env Secret into its own
        // namespace under the declared name.
        secretName: bundled.envSecretRef ?? `${bundled.namespace}-env`,
        session: { mode: session.mode, key: session.key },
      };
    }

    return {
      profile: target.profile,
      handler: target.handler,
      instance: inst.id,
      namespace: inst.namespace,
      service: inst.namespace, // the agent Service shares the instance name (compile.ts convention)
      port: endpoint.port,
      path: handlerPath,
      url: `http://${inst.namespace}.${inst.namespace}.svc.cluster.local:${endpoint.port}${handlerPath}`,
      signature: endpoint.signature ?? "hmac-sha256",
      secretName: `${inst.namespace}-env`, // the instance's env Secret (WEBHOOK_SECRET)
      session: { mode: session.mode, key: session.key },
    };
  };

  // --- Routes -> edges.
  const edges: RouteEdge[] = [];
  for (const c of sorted) {
    const routeNames = new Set<string>();
    for (const route of c.communication?.routes ?? []) {
      if (routeNames.has(route.name)) {
        err(c.profile, "EVENT004", `routes declares ${route.name} twice`);
        continue;
      }
      routeNames.add(route.name);

      // Resolve the source to one or more (scope-bound) origins.
      let origins: { producer?: ProducerBinding; externalInput?: ExternalInputBinding; scope: string; region?: string; router: RouterInstance }[] = [];
      if (route.from.externalInput) {
        const ext = externalInputs.find((x) => x.profile === c.profile && x.name === route.from.externalInput);
        if (!ext) {
          err(c.profile, "EVENT002", `route ${route.name} references unknown externalInput ${route.from.externalInput}`);
          continue;
        }
        ext.routes.push(route.name);
        // External events enter at the shared gateway; edges execute on
        // every router (locally: the one).
        const anchor = topo.agents[0] ?? topo.apps[0];
        const router =
          routers[0] ??
          routerFor(
            elide ? (anchor?.scope ?? "global") : (anchor?.region ?? "global"),
            anchor?.region,
            anchor?.target ?? "in-cluster",
            anchor?.argoDestination ?? "in-cluster",
          );
        origins = [{ externalInput: ext, scope: router.scope, region: router.region, router }];
      } else {
        const matched = producers.filter(
          (p) => p.profile === c.profile && p.app === route.from.app && p.output === route.from.output,
        );
        if (matched.length === 0) {
          err(
            c.profile,
            "EVENT002",
            `route ${route.name} references ${route.from.app}#${route.from.output}, ` +
              `which no declared app output matches`,
          );
          continue;
        }
        for (const p of matched) p.routes.push(route.name);
        origins = matched.map((p) => ({
          producer: p,
          scope: p.scope,
          region: p.region,
          router: routers.find((r) => r.id === p.router)!,
        }));
      }

      const routeFifoKey = route.delivery?.ordering?.key;
      for (const origin of origins) {
        route.outputs.forEach((out, i) => {
          const delivery = resolveDelivery(route.delivery, out.agent?.delivery ?? out.delivery);
          if (!requireDurable(c.profile, route.name, delivery)) return;
          const base = {
            route: route.name,
            profile: c.profile,
            scope: origin.scope,
            region: origin.region,
            router: origin.router.id,
            from: { producer: origin.producer?.id, externalInput: origin.externalInput?.id },
            event: origin.producer?.event ?? origin.externalInput!.event,
            filter: route.filter,
            delivery,
          };
          if (out.agent) {
            const agent = resolveAgent(c.profile, route.name, origin.scope, origin.region, out.agent);
            if (!agent) return;
            // 11.4: order narrower than the session mixes unrelated
            // context into one conversation - legal, but worth a warning.
            if (routeFifoKey && agent.session.mode === "route") {
              warn(
                c.profile,
                "EVENT013",
                `route ${route.name}: FIFO orders by ${routeFifoKey} but the ${agent.profile} session ` +
                  `is route-wide - ordered delivery, mixed agent context`,
              );
            }
            edges.push({
              id: `${c.profile}/${route.name}@${origin.scope}->${i}:agent:${out.agent.profile}`,
              ...base,
              kind: "agent",
              agent,
            });
          } else if (out.chatops) {
            const chatops = resolveSpace(c.profile, route.name, out.chatops);
            if (!chatops) return;
            edges.push({
              id: `${c.profile}/${route.name}@${origin.scope}->${i}:chatops:${slug(out.chatops)}`,
              ...base,
              kind: "chatops",
              chatops,
            });
          }
        });
      }
    }
  }

  // --- The reserved broadcast (agents.all/v1). Synthesized per router:
  // a platform-owned producer whose id sorts LAST among producers, and
  // one DIRECT edge to every webhook-capable profile's first declared
  // handler - a connectivity test wants the synchronous answer "is every
  // agent reachable NOW", so no queue, no retry masking, per-event
  // sessions. Profiles without a webhook endpoint are skipped with a
  // warning, never an error: the broadcast covers what can receive.
  if (routers.length > 0 && sorted.length > 0) {
    const warned = new Set<string>();
    for (const router of routers) {
      const producerId = elide ? "zzz-platform#agents-all" : `zzz-platform@${router.scope}#agents-all`;
      const ingestPath = `/v1/events/${slug(producerId)}`;
      const broadcastEdges: RouteEdge[] = [];
      for (const c of sorted) {
        const webhooks = c.endpoints
          .filter((e) => e.type === "webhook" && e.path.startsWith("/webhooks/"))
          .sort((a, b) => a.path.localeCompare(b.path));
        if (webhooks.length === 0) {
          if (!warned.has(c.profile)) {
            warned.add(c.profile);
            warn(
              c.profile,
              "EVENT015",
              `agents.all broadcast skips ${c.profile}: no webhook endpoint declared - ` +
                "the reserved test event cannot reach this profile",
            );
          }
          continue;
        }
        const handler = webhooks[0]!.path.slice("/webhooks/".length);
        // The broadcast must never fail a graph that compiled without it:
        // a profile unresolvable from this scope is skipped, and any
        // findings resolveAgent pushed on the way are withdrawn.
        const before = findings.length;
        const agent = resolveAgent("platform", "agents-all", router.scope, router.region, {
          profile: c.profile,
          handler,
          session: { mode: "per-event" },
        });
        if (!agent) {
          findings.length = before;
          if (!warned.has(c.profile)) {
            warned.add(c.profile);
            warn(
              c.profile,
              "EVENT015",
              `agents.all broadcast skips ${c.profile}: not resolvable from scope ${router.scope}`,
            );
          }
          continue;
        }
        broadcastEdges.push({
          id: `platform/agents-all@${router.scope}->${broadcastEdges.length}:agent:${c.profile}`,
          route: "agents-all",
          profile: "platform",
          scope: router.scope,
          region: router.region,
          router: router.id,
          from: { producer: producerId, externalInput: undefined },
          event: RESERVED_BROADCAST_EVENT,
          filter: undefined,
          kind: "agent",
          agent,
          delivery: {
            mode: "direct",
            retry: { maxAttempts: 1, backoff: "fixed" },
            deadLetter: { enabled: false, retention: undefined },
          },
        });
      }
      if (broadcastEdges.length === 0) continue;
      producers.push({
        id: producerId,
        name: elide ? "platform#agents-all" : `platform@${router.scope}#agents-all`,
        profile: "platform",
        app: "platform",
        appInstance: elide ? "platform" : `platform@${router.scope}`,
        output: "agents-all",
        event: RESERVED_BROADCAST_EVENT,
        schema: undefined,
        subject: undefined,
        scope: router.scope,
        region: router.region,
        router: router.id,
        ingestPath,
        ingestUrl: routerUrl(router, ingestPath),
        inject: undefined,
        routes: ["agents-all"],
      });
      edges.push(...broadcastEdges);
    }
  }

  // EVENT001 - an output nothing consumes is declared intent going
  // nowhere. A warning: producers may legitimately precede their routes.
  for (const p of producers) {
    if (p.routes.length === 0) {
      warn(p.profile, "EVENT001", `output ${p.name} is declared but no route consumes it`);
    }
  }

  const byId = <T extends { id: string }>(arr: T[]) => [...arr].sort((a, b) => a.id.localeCompare(b.id));
  return {
    plan: {
      routers: byId(routers),
      producers: byId(producers),
      externalInputs: byId(externalInputs),
      edges: byId(edges),
      chatopsSpaces: byId([...chatopsSpaces.values()]),
      durableProvider: comm?.durableProvider,
    },
    findings,
  };
}
