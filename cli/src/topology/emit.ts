// hg topology emit: materialize the compiled plan as the generated GitOps
// trees (design 10, ADR-34) - catalog/ (one record per profile: the
// authored contract unchanged under provenance keys) and deployments/
// (agents, apps, endpoints, plan.yaml). The ONLY file-writing module in
// cli/src/topology/.
//
// Atomicity is the emitter's discipline, not a transaction: the whole
// tree is built in memory first; compilation errors refuse BEFORE any
// write; per-file byte-compare skips untouched files; files under the
// managed trees that are not in the new set are deleted; plan.yaml (with
// the inputs hash) is written last. Regenerating twice from identical
// inputs is a zero-diff no-op.

import * as crypto from "node:crypto";
import { agentLayout, teamDir } from "../layout.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { Contract } from "./contract.ts";
import { discoverContractDirs } from "./contract.ts";
import type { Environment } from "./environment.ts";
import type { TopologyPlan } from "./compile.ts";

// Topology owns its generated subtrees EXPLICITLY - never all of
// deployments/, because deployments/dashboard/ belongs to `hg nexus emit`
// (ADR-42) and a whole-tree prune here would silently delete the nexus
// plan on every topology emit. deployments/plan.yaml sits outside every
// managed tree; it is regenerated (never pruned) on each emit.
const MANAGED_TREES = [
  "catalog/profiles",
  "deployments/agents",
  "deployments/apps",
  "deployments/endpoints",
  "deployments/communication",
  "deployments/connections",
];

/** Stable YAML for generated records: sorted keys, no anchors, wide lines
 * (the emitter's determinism discipline, render.py's `width=4096` twin). */
function dump(doc: unknown): string {
  return yamlStringify(doc, { sortMapEntries: true, lineWidth: 0 });
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** The hash that makes staleness DETECTABLE (never scheduled): computed
 * over every input file's content - authored contracts and environment
 * files - so `hg topology doctor`/`hg status` can compare it against a
 * recomputation without re-running the compiler. */
export function inputsHash(root: string, environmentSource?: string): string {
  const parts: string[] = [];
  let contractDirs: { dir: string; subdir: string }[] = [];
  try {
    contractDirs = discoverContractDirs(root);
  } catch {
    // No authored catalogue at this root - the upgrade path's inputs are
    // the gitops repo's own records, hashed below.
  }
  for (const { dir, subdir } of contractDirs) {
    // An Eve project's manifest is package.json (+ the lockfile the pod
    // builds from); a Hermes profile's is distribution.yaml. Hash whichever
    // exists - both are inputs to the deployed state.
    for (const f of ["distribution.yaml", "package.json", "package-lock.json"]) {
      const file = path.join(dir, f);
      if (fs.existsSync(file)) parts.push(`${subdir}/${f}\n${fs.readFileSync(file, "utf8")}`);
    }
    // The contract: one file beside the payload (legacy - its label is the
    // pre-ADR-0178 `${subdir}/hermes-gitops.yaml`, byte-for-byte, so no
    // legacy tree is marked stale by this change) or every file in the
    // agent's harness-hg/ (agent-team layout).
    const layout = agentLayout(dir);
    if (layout.legacy) {
      if (fs.existsSync(layout.agentFile)) {
        parts.push(`${subdir}/hermes-gitops.yaml\n${fs.readFileSync(layout.agentFile, "utf8")}`);
      }
    } else {
      for (const f of fs.readdirSync(layout.contractDir).sort()) {
        const file = path.join(layout.contractDir, f);
        if (fs.statSync(file).isFile()) parts.push(`${path.relative(root, file)}\n${fs.readFileSync(file, "utf8")}`);
      }
    }
  }
  const profilesDir = path.join(root, "profiles");
  if (fs.existsSync(profilesDir)) {
    for (const name of fs.readdirSync(profilesDir).sort()) {
      const rec = path.join(profilesDir, name, "profile.yaml");
      if (fs.existsSync(rec)) parts.push(`profiles/${name}/profile.yaml\n${fs.readFileSync(rec, "utf8")}`);
    }
  }
  const envDir = environmentSource
    ? fs.existsSync(environmentSource) && fs.statSync(environmentSource).isFile()
      ? path.dirname(environmentSource)
      : teamDir(environmentSource)
    : teamDir(root);
  // bundles.yaml and workspaces.yaml are compiled by their own emitters,
  // but they are INPUTS to the deployed state - leaving them out of the
  // hash means an edit never registers as stale in `topology doctor`.
  // The agent-team layout adds team.yaml + apps.yaml (the lifted apps).
  for (const f of ["team.yaml", "apps.yaml", "topology.yaml", "policy.yaml", "communication.yaml", "bundles.yaml", "workspaces.yaml"]) {
    const file = path.join(envDir, f);
    if (fs.existsSync(file)) parts.push(`environment/${f}\n${fs.readFileSync(file, "utf8")}`);
  }
  return sha256(parts.sort().join("\x00"));
}

export interface EmitResult {
  written: string[]; // paths (relative to output) created or updated
  unchanged: string[];
  deleted: string[]; // stale generated files removed
}

/** Build the full generated tree in memory: path -> content. */
export function renderTree(
  root: string,
  contracts: Contract[],
  plan: TopologyPlan,
  env: Environment,
  opts: {
    sourceSha: string;
    environmentSource?: string;
    catalogue?: Map<string, string>;
    /** Upgrade path: each record keeps ITS OWN sha as provenance. */
    sourceShaByProfile?: Map<string, string>;
    /** Environment-specific router image (e.g. a baseline-CPU build) -
     * emitted as a top-level chart value beside spec (ADR-74). */
    routerImage?: string;
    /** Debug-observer / recording sink base URL - emitted as the chart's
     * recordingBase, which the router also mirrors lifecycle records to. */
    observerUrl?: string;
    /** The compiled connections (ADR-152): their per-profile projection
     * files and gateway record join the tree, and the gateway spec rides
     * in every router's values. */
    connections?: { files: Map<string, string>; gateway: unknown[] };
  },
): Map<string, string> {
  const files = new Map<string, string>();

  // catalog/ - TWO plain files per profile: the authored contract copied
  // VERBATIM (any byte sequence round-trips; the authoring schemas
  // already validate it), and a tiny provenance record. No YAML
  // embedding, so the Python emitter produces identical bytes with no
  // shared serializer (ADR-34). The upgrade path supplies reconstructed
  // contents via opts.catalogue instead of authored-root reads.
  const dirBySubdir = opts.catalogue
    ? new Map<string, string>()
    : new Map(discoverContractDirs(root).map((d) => [d.subdir, d.dir] as const));
  for (const c of [...contracts].sort((a, b) => a.profile.localeCompare(b.profile))) {
    const provided = opts.catalogue?.get(c.profile);
    // Agent-team layout: agent.yaml alone (the split's cost, ADR 0178);
    // the inputs hash above covers every sibling file.
    const extFile = provided !== undefined ? "" : agentLayout(dirBySubdir.get(c.subdir) ?? "").agentFile;
    const authored =
      provided ??
      (fs.existsSync(extFile)
        ? fs.readFileSync(extFile, "utf8")
        : "# no hermes-gitops.yaml - the profile declares no infra intent\n");
    files.set(`catalog/profiles/${c.profile}/contract.yaml`, authored);
    // Hand-formatted, byte-matching the Python emitter's f-string - the
    // two languages share no YAML serializer, only this exact shape.
    const sha = opts.sourceShaByProfile?.get(c.profile) ?? opts.sourceSha;
    files.set(
      `catalog/profiles/${c.profile}/provenance.yaml`,
      `profile: ${c.profile}\nsourceSha: "${sha}"\n`,
    );
  }

  // deployments/agents
  const contractByProfile = new Map(contracts.map((c) => [c.profile, c] as const));
  const envInjections = new Map<string, Record<string, string>>();
  for (const b of plan.bindings) {
    if (b.inject.env) {
      const cur = envInjections.get(b.consumer) ?? {};
      cur[b.inject.env] = b.url;
      envInjections.set(b.consumer, cur);
    }
  }
  // Inbound authorization materialization (#348/#476): the declared
  // approved lists become the gateway's ENFORCED allowlist env vars
  // (DISCORD_ALLOWED_USERS/ROLES/CHANNELS - the adapter's deny-by-default
  // gates), applied to every agent instance. This is what closes
  // ADR-96's "authoring `inbound` must not be mistaken for having
  // authorization": the block now IS the allowlist the gateway reads.
  // Identifiers only (snowflakes), already non-sensitive and already in
  // Git in the declaration itself. mentionPolicy/threadPolicy have no
  // adapter env today and stay contract-only. Non-discord providers have
  // no allowlist env mapping yet and are skipped, not guessed at.
  //
  // EXACTLY ONE discord connection may carry inbound (Codex catch): the
  // gateway's allowlist is process-wide, so materializing several
  // connections' lists would merge their security boundaries - a user
  // approved on connection A becoming authorized via connection B. With
  // more than one, NOTHING materializes (the compiler warns via
  // CHATOPS002) - silence in the env, loud in the plan.
  const inboundConns = Object.values(env.communication?.chatopsConnections ?? {}).filter(
    (c) => c.provider === "discord" && c.inbound,
  );
  const inboundEnv: Record<string, string> = {};
  if (inboundConns.length === 1) {
    const inbound = inboundConns[0]!.inbound!;
    for (const [field, varName] of [
      ["approvedUsers", "DISCORD_ALLOWED_USERS"],
      ["approvedRoles", "DISCORD_ALLOWED_ROLES"],
      ["approvedChannels", "DISCORD_ALLOWED_CHANNELS"],
    ] as const) {
      const ids = inbound[field] ?? [];
      if (ids.length > 0) inboundEnv[varName] = [...new Set(ids)].sort().join(",");
    }
  }
  if (Object.keys(inboundEnv).length > 0) {
    for (const a of plan.agents) {
      const cur = envInjections.get(a.id) ?? {};
      // Inbound WINS on collision (Codex catch): a capability injection
      // must never widen or replace an authorization boundary. The
      // compiler additionally refuses such injections outright
      // (RESERVED_INJECT_ENV, TOPO014), so this precedence is the
      // belt to that suspender.
      envInjections.set(a.id, { ...cur, ...inboundEnv });
    }
  }
  for (const a of plan.agents) {
    const id = a.id.replace(/[@/]/g, "-");
    files.set(
      `deployments/agents/${id}/deployment.yaml`,
      dump({
        spec: {
          id: a.id,
          profile: a.profile,
          scope: a.scope,
          ...(a.region ? { region: a.region } : {}),
          target: a.target,
          argoDestination: a.argoDestination,
          namespace: a.namespace,
          application: a.application,
          // The agent runtime and the platform chart that realizes it
          // (ADR-149, topology-plan v1alpha3). Stamped here so the agents
          // ApplicationSet stays dumb: its chart path is
          // the two-parent harness path branch (ADR 0160).
          runtime: contractByProfile.get(a.profile)?.runtime ?? "hermes",
          chart: (contractByProfile.get(a.profile)?.runtime ?? "hermes") === "eve" ? "eve-agent" : "hermes-profile",
          // The installed distribution's identity (bundles.yaml v4):
          // the operational category Nexus groups this agent under,
          // beside the Hermes control plane. Absent when undeclared -
          // the serve-time fallback derives from the source repo stem.
          ...(env.distribution
            ? {
                distribution: {
                  ...(env.distribution.name ? { name: env.distribution.name } : {}),
                  displayName: env.distribution.displayName,
                },
              }
            : {}),
        },
      }),
    );
    const inject = envInjections.get(a.id);
    files.set(
      `deployments/agents/${id}/values.yaml`,
      dump({ spec: { env: inject ?? {} } }),
    );
  }

  // deployments/apps - source coordinates resolved, values = authored
  // values + capability injections merged (the injection MATERIALIZES
  // here; the plan only carried the intent).
  const appValueInjections = new Map<string, Record<string, string>>(); // instance id -> dotpath -> url
  for (const b of plan.bindings) {
    if (b.inject.appValue) {
      const cur = appValueInjections.get(b.consumer) ?? {};
      cur[b.inject.appValue.path] = b.url;
      appValueInjections.set(b.consumer, cur);
    }
  }
  // Producer outputs (ADR-39) inject the generated ingest URL into the
  // PRODUCING app's own values - same mechanism, same guards; collisions
  // with capability injections are already EVENT010 at compile.
  for (const p of plan.communication?.producers ?? []) {
    if (!p.inject) continue;
    const cur = appValueInjections.get(p.appInstance) ?? {};
    cur[p.inject.path] = p.ingestUrl;
    appValueInjections.set(p.appInstance, cur);
  }
  for (const a of plan.apps) {
    const id = a.id.replace(/[@/]/g, "-");
    files.set(
      `deployments/apps/${id}/deployment.yaml`,
      dump({
        spec: {
          id: a.id,
          profile: a.profile,
          app: a.app,
          scope: a.scope,
          ...(a.region ? { region: a.region } : {}),
          target: a.target,
          argoDestination: a.argoDestination,
          namespace: a.namespace,
          application: a.application,
          ...(a.pairedAgent ? { pairedAgent: a.pairedAgent } : {}),
          source:
            a.repo === "local"
              ? { repo: "local", path: a.chart }
              : { repoURL: a.repo.replace(/^oci:\/\//, ""), chart: a.chart, targetRevision: a.version },
        },
      }),
    );
    const authored = contractByProfile.get(a.profile)?.apps.find((x) => x.name === a.app)?.values ?? {};
    const values = structuredClone(authored) as Record<string, unknown>;
    for (const [dotPath, url] of Object.entries(appValueInjections.get(a.id) ?? {})) {
      const segs = dotPath.split(".");
      // Defence in depth (the compiler already rejects these): never walk
      // into the prototype chain.
      if (segs.some((seg) => ["__proto__", "prototype", "constructor"].includes(seg))) {
        throw new Error(`${a.id}: inject path ${dotPath} contains a forbidden segment`);
      }
      let cursor: Record<string, unknown> = values;
      for (const seg of segs.slice(0, -1)) {
        const next = Object.prototype.hasOwnProperty.call(cursor, seg) ? cursor[seg] : undefined;
        if (next !== undefined && (typeof next !== "object" || next === null || Array.isArray(next))) {
          // Clobbering an authored scalar/array MID-path would silently
          // discard configuration - refuse (renderTree runs before any
          // write, so this refusal is still pre-mutation).
          throw new Error(
            `${a.id}: inject path ${dotPath} conflicts with authored values - ` +
              `${seg} is not a mapping (declare the path down to a leaf, or restructure the values)`,
          );
        }
        cursor = (cursor[seg] = (next as Record<string, unknown> | undefined) ?? {});
      }
      cursor[segs[segs.length - 1]!] = url;
    }
    files.set(`deployments/apps/${id}/values.yaml`, dump(values));
  }

  // deployments/endpoints - one record per component instance grouping
  // its endpoints (the future hermes-endpoint chart's input).
  const byOwner = new Map<string, typeof plan.endpoints>();
  for (const e of plan.endpoints) {
    byOwner.set(e.owner, [...(byOwner.get(e.owner) ?? []), e]);
  }
  for (const [owner, endpoints] of [...byOwner.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = endpoints[0]!;
    const id = owner.replace(/[@/]/g, "-");
    files.set(
      `deployments/endpoints/${id}/deployment.yaml`,
      dump({
        spec: {
          id: owner,
          profile: first.profile,
          component: first.component,
          scope: first.scope,
          target: first.target,
          argoDestination: first.argoDestination,
          endpoints: endpoints.map((e) => ({
            name: e.endpoint,
            type: e.type,
            backend: { service: e.service, namespace: e.namespace, port: e.port, path: e.path },
            internalUrl: e.internalUrl,
            ...(e.url ? { url: e.url } : {}),
            ...(e.provides ? { provides: e.provides } : {}),
          })),
        },
      }),
    );
  }

  // deployments/communication (ADR-39) - one record + values pair per
  // router instance. values.yaml is the router's ENTIRE configuration:
  // the hermes-event-router chart consumes it verbatim, so the compiled
  // graph - not the runtime - is the authority on routing. Credential
  // REFERENCES only; a secret value has no path into this tree.
  if (plan.communication) {
    const comm = plan.communication;
    for (const router of comm.routers) {
      const id = router.id.replace(/[@/]/g, "-");
      files.set(
        `deployments/communication/${id}/deployment.yaml`,
        dump({
          spec: {
            id: router.id,
            scope: router.scope,
            ...(router.region ? { region: router.region } : {}),
            target: router.target,
            argoDestination: router.argoDestination,
            namespace: router.namespace,
            application: router.application,
            service: router.service,
          },
        }),
      );
      files.set(
        `deployments/communication/${id}/values.yaml`,
        dump({
          // Optional environment knobs (ADR-74): the ApplicationSet layers
          // this file onto the chart, so top-level keys ARE chart values.
          // Omitted entirely when unset - the default emission stays
          // v1alpha1-shaped.
          ...(opts.routerImage ? { image: opts.routerImage } : {}),
          ...(opts.observerUrl ? { recordingBase: opts.observerUrl } : {}),
          spec: {
            router: { id: router.id, scope: router.scope, namespace: router.namespace, service: router.service },
            ...(opts.connections && opts.connections.gateway.length > 0 ? { connections: opts.connections.gateway } : {}),
            ...(comm.durableProvider ? { durableProvider: comm.durableProvider } : {}),
            chatopsConnections: Object.fromEntries(
              [...comm.chatopsSpaces]
                .map((s) => s.alias)
                .filter((alias, i, all) => all.indexOf(alias) === i)
                .sort()
                .map((alias) => {
                  const space = comm.chatopsSpaces.find((s) => s.alias === alias)!;
                  return [alias, { provider: space.provider, ...(space.credentialRef ? { credentialRef: space.credentialRef } : {}) }];
                }),
            ),
            producers: comm.producers
              .filter((p) => p.router === router.id)
              .map((p) => ({
                id: p.id,
                name: p.name,
                profile: p.profile,
                app: p.app,
                appInstance: p.appInstance,
                output: p.output,
                event: p.event,
                ...(p.schema ? { schema: p.schema } : {}),
                ...(p.subject ? { subject: p.subject } : {}),
                ingestPath: p.ingestPath,
                routes: p.routes,
              })),
            externalInputs: comm.externalInputs.map((x) => ({
              id: x.id,
              profile: x.profile,
              name: x.name,
              event: x.event,
              ...(x.schema ? { schema: x.schema } : {}),
              ...(x.subject ? { subject: x.subject } : {}),
              ...(x.provider ? { provider: x.provider } : {}),
              verification: x.verification,
              ...(x.accepts ? { accepts: x.accepts } : {}),
              hookPath: x.hookPath,
              routes: x.routes,
            })),
            edges: comm.edges
              .filter((e) => e.router === router.id)
              .map((e) => ({
                id: e.id,
                route: e.route,
                profile: e.profile,
                from: {
                  ...(e.from.producer ? { producer: e.from.producer } : {}),
                  ...(e.from.externalInput ? { externalInput: e.from.externalInput } : {}),
                },
                event: e.event,
                ...(e.filter ? { filter: e.filter } : {}),
                kind: e.kind,
                ...(e.agent ? { agent: e.agent } : {}),
                ...(e.chatops ? { chatops: e.chatops } : {}),
                delivery: {
                  mode: e.delivery.mode,
                  retry: e.delivery.retry,
                  deadLetter: {
                    enabled: e.delivery.deadLetter.enabled,
                    ...(e.delivery.deadLetter.retention ? { retention: e.delivery.deadLetter.retention } : {}),
                  },
                  ...(e.delivery.ordering ? { ordering: e.delivery.ordering } : {}),
                },
              })),
          },
        }),
      );
    }
    files.set(
      "deployments/communication/plan.yaml",
      dump({
        version: 1,
        routers: comm.routers.map((r) => r.id),
        producers: comm.producers.map((p) => p.name),
        externalInputs: comm.externalInputs.map((x) => x.id),
        edges: comm.edges.map((e) => e.id),
        chatopsSpaces: comm.chatopsSpaces.map((s) => s.id),
        ...(comm.durableProvider ? { durableProvider: comm.durableProvider.plugin } : {}),
      }),
    );
  }

  // Connections (ADR-152): the projections and the gateway record.
  if (opts.connections) for (const [rel, content] of opts.connections.files) files.set(rel, content);
  // The gateway IS the router: connections without a communication plane
  // still need one router record, the single-layout shape the
  // communication compiler would have produced, with an empty graph.
  if (opts.connections && opts.connections.gateway.length > 0 && !plan.communication?.routers.length) {
    const namespace = "hermes-system";
    files.set(
      "deployments/communication/router/deployment.yaml",
      dump({ spec: { id: "router", scope: "global", target: "in-cluster", argoDestination: "in-cluster", namespace, application: "hermes-event-router", service: "hermes-event-router" } }),
    );
    files.set(
      "deployments/communication/router/values.yaml",
      dump({
        ...(opts.routerImage ? { image: opts.routerImage } : {}),
        ...(opts.observerUrl ? { recordingBase: opts.observerUrl } : {}),
        spec: {
          router: { id: "router", scope: "global", namespace, service: "hermes-event-router" },
          chatopsConnections: {},
          producers: [],
          externalInputs: [],
          edges: [],
          connections: opts.connections.gateway,
        },
      }),
    );
  }

  // plan.yaml last - the whole-fleet summary + the staleness hash.
  files.set(
    "deployments/plan.yaml",
    dump({
      version: 1,
      layout: plan.layout,
      sovereignty: plan.sovereignty,
      inputsHash: inputsHash(root, opts.environmentSource),
      agents: plan.agents.map((a) => a.id),
      apps: plan.apps.map((a) => a.id),
      bindings: plan.bindings.map((b) => ({
        capability: b.capability,
        consumer: b.consumer,
        provider: b.provider,
        url: b.url,
        crossRegion: b.crossRegion,
      })),
      environment: { synthesized: env.synthesized },
    }),
  );

  return files;
}

/** Write the tree: byte-compare, delete stale, report. Refusal on plan
 * errors happens in the CALLER before this ever runs. */
export function writeTree(
  output: string,
  files: Map<string, string | Buffer>,
  trees: string[] = MANAGED_TREES,
): EmitResult {
  const written: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];

  // Delete stale generated files first - NEVER outside the managed
  // trees: a symlink anywhere inside them could redirect the prune (or a
  // write) to an arbitrary directory, so any symlink is a hard refusal
  // before the first mutation.
  for (const tree of trees) {
    const base = path.join(output, tree);
    if (!fs.existsSync(base)) continue;
    if (fs.lstatSync(base).isSymbolicLink()) {
      throw new Error(`refusing to manage ${base}: it is a symlink`);
    }
    for (const entry of fs.readdirSync(base, { recursive: true }) as string[]) {
      const abs = path.join(base, entry);
      if (fs.lstatSync(abs).isSymbolicLink()) {
        throw new Error(`refusing to manage ${path.join(tree, entry)}: symlink inside a generated tree`);
      }
    }
  }
  for (const tree of trees) {
    const base = path.join(output, tree);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { recursive: true }) as string[]) {
      const rel = path.join(tree, entry);
      const abs = path.join(output, rel);
      if (fs.statSync(abs).isDirectory()) continue;
      if (!files.has(rel)) {
        fs.rmSync(abs);
        deleted.push(rel);
      }
    }
  }
  for (const [rel, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const abs = path.join(output, rel);
    // Byte-compare in the content's own domain - reading a binary asset
    // as utf8 would corrupt the comparison, never the file.
    if (
      fs.existsSync(abs) &&
      (typeof content === "string"
        ? fs.readFileSync(abs, "utf8") === content
        : content.equals(fs.readFileSync(abs)))
    ) {
      unchanged.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(rel);
  }
  // Sweep now-empty directories left by deletions - including the managed
  // tree base itself (a fully pruned subsystem leaves no directory behind).
  for (const tree of trees) {
    const base = path.join(output, tree);
    if (!fs.existsSync(base)) continue;
    for (const entry of (fs.readdirSync(base, { recursive: true }) as string[]).sort((a, b) => b.length - a.length)) {
      const abs = path.join(base, entry);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory() && fs.readdirSync(abs).length === 0) {
        fs.rmdirSync(abs);
      }
    }
    if (fs.readdirSync(base).length === 0) fs.rmdirSync(base);
  }
  return { written, unchanged, deleted };
}
