// Typed configuration for the Hermes GitOps bootstrap Pulumi program — the
// env-config contract of the control-flow layer.
//
// Reads stack config under the `hermes-gitops-bootstrap:` namespace (see
// Pulumi.local.yaml.example at the project root) and validates the
// `providers` enums against the same value set as the canonical
// schemas/cluster-values/v1alpha1/cluster-values.schema.json contract, so a
// typo in stack config fails fast at `pulumi preview` rather than mid-apply.
//
// These enums are hand-mirrored from the schema rather than loaded from it
// at runtime: this program is meant to run against an arbitrary kubeconfig,
// potentially without the rest of the harness-hg repo checked out
// alongside it (e.g. vendored into an operator's own infra repo), so it
// must not have a hard filesystem dependency on schemas/. If the schema's
// provider enums change, update the enums below in the same change.
//
// Everything except `load()` is a PURE function of plain data — no Pulumi
// runtime involved — so the whole validation surface is unit-testable with
// `bun test` (see tests/config.test.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import * as pulumi from "@pulumi/pulumi";
import { parseAgentGitAuth, parseAgentSecrets } from "../components/agent-secrets/index.ts";
import { parseRouterSecrets } from "../components/router-secrets/index.ts";

// Chart versions pinned by default (overridable via stack config). The pin
// values live in versions.json at the repo root - the one resolved-versions
// surface (ADR-63) - so "what version of X does this bootstrap install" has
// one answer shared with the CLI. See infra/gitops-template/README.md for
// the Argo CD evidence trail behind the argocd default.
import versions from "../../../versions.json" with { type: "json" };
/** The Eve runtime pin (ADR-149): the eve release the eve-runtime image
 * ships and the EveAgents emit commands assert against each project's
 * lockfile (--expect-eve-version). */
export const EVE_RUNTIME_VERSION: string = versions.runtimes.eve.version;
export const DEFAULT_ARGOCD_CHART_VERSION = versions.charts.argocd; // argo-helm argo-cd chart -> Argo CD v3.4.5
export const DEFAULT_ESO_CHART_VERSION = versions.charts.eso; // external-secrets chart -> ESO
export const DEFAULT_PKO_CHART_VERSION = versions.charts.pko; // pulumi-kubernetes-operator chart -> PKO

export const DEFAULT_GITOPS_BRANCH = "main";
export const DEFAULT_CHART_REVISION = "main";

// URL substrings that mark a configured repo URL as "not real yet" — used
// to gate hermes-gitops-root off (see components/root-app) rather than create
// an Application doomed to permanently report a missing/unreachable repo.
const PLACEHOLDER_URL_MARKERS = ["example.invalid", "__GITOPS_REPO_URL__", "REPLACE_ME"];

// Which strategy provisions (or merely references) the control-plane
// cluster Argo CD runs on (CONFIG_TARGET step 0): `none` = bring-your-own
// kubeconfig (the default — today's behavior, see A3's docs);
// k3s-local/gke-autopilot/eks-fargate are provisioning strategies the
// cluster module implements (issue #4 [A2]). Deliberately a TOP-LEVEL
// stack key, not part of the providers triad: cloud is used for exactly
// one thing — launching the cluster — while compute/secret/ingress
// select in-cluster behaviors.
export const CLUSTER_PROVIDERS = ["none", "k3s-local", "gke-autopilot", "eks-fargate"] as const;

// The three in-cluster provider vocabularies are GENERATED from the
// canonical schema (ADR-7, #139) - they used to be hand-written mirrors
// of it, and two hand-maintained descriptions of one contract diverge;
// the only question is when. `make contract-types-drift` runs in
// `make test`.
//
// `CLUSTER_PROVIDERS` above stays hand-written on purpose: it is a
// bootstrap-only concept that appears in no record schema, so there is
// nothing to generate it FROM. Generating some of this file and not the
// rest would be worse than generating none of it, unless a reader can
// tell which is which - hence the separate file.
export {
  COMPUTE_PROVIDERS,
  SECRET_PROVIDERS,
  INGRESS_PROVIDERS,
  BACKUP_PROVIDERS,
} from "./generated-contract.ts";
export type {
  ComputeProvider,
  SecretProvider,
  IngressProvider,
  BackupProvider,
} from "./generated-contract.ts";

import {
  COMPUTE_PROVIDERS,
  SECRET_PROVIDERS,
  INGRESS_PROVIDERS,
} from "./generated-contract.ts";
import type {
  ComputeProvider,
  SecretProvider,
  IngressProvider,
} from "./generated-contract.ts";

export type ClusterProvider = (typeof CLUSTER_PROVIDERS)[number];

/** Raised for stack config that fails validation before any resource is
 * registered (as opposed to a Kubernetes-side apply failure). */
export class ConfigError extends Error {}

export interface Providers {
  compute: ComputeProvider;
  secret: SecretProvider;
  ingress: IngressProvider;
}

export interface Versions {
  argocdChart: string;
  esoChart: string;
  pkoChart: string;
}

export interface Stages {
  // Stage 1: install the Hermes fork CLI + the gitops-emitter plugin, and
  // configure the plugin in the operating profile's config.yaml/.env (see
  // components/harness/hermes-install). Defaults on. An operator who already has
  // Hermes + the plugin installed and configured on this machine (e.g.
  // iterating on stage 2 only) can set this false to skip straight to
  // `agents`.
  hermes: boolean;
  // Stage 2: `hermes profile install <source>#<ref>` per entry in the
  // `agents:` stack config list (see components/harness/hermes-agent). Defaults
  // on. Depends on stage 1's resources when stage 1 also runs in this
  // `pulumi up`; when `hermes: false`, stage 2 assumes Hermes + the plugin
  // are already installed and configured by some other means.
  agents: boolean;
  // Stage 3 (this program): cluster control plane.
  cluster: boolean;
}

// Stack config for bootstrap stage 1 (see components/harness/hermes-install).
// Mirrors the fork's own install mechanics rather than inventing new ones:
// `source` is whatever `uv tool install` would accept as its PACKAGE
// argument (a local directory installed with --editable, or a git URL
// optionally combined with `ref`).
// Optional plugin-config fields written to plugins.entries.gitops-emitter
// only when set (issue #13 [E3]); unset keeps load_plugin_config's own
// fallback defaults — the single source of default values.
export interface PluginConfigFields {
  // Publishing posture (issues #17/#21 [F1]/[F3]): "direct" | "pr".
  // Default (when null): "pr" for a github.com gitopsRepoUrl - the
  // resolved bootstrap posture (installs commit direct so a fresh fleet
  // converges; updates open auto-merged PRs) - and "direct" otherwise
  // (non-GitHub remotes have no pulls API).
  mode: string | null;
  // pr mode only: auto-merge update PRs (plugin default true). Set
  // false for a human day-2 review gate.
  prAutoMerge: boolean | null;
  // ADR-2's escape hatch (#140): commit straight to the branch even in
  // `pr` mode. Replaces a carve-out that silently downgraded `pr` to
  // `direct` for install events - an exception keyed on event type,
  // invisible exactly where it mattered. Default OFF; setting it appears
  // in `pulumi preview` as an env var on the config-apply command, and
  // the emitter warns on every use.
  allowDirectCommit: boolean | null;
  profilesPath: string | null;
  defaultsFile: string | null;
  overridesDir: string | null;
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
  imageRepository: string | null;
  imageTag: string | null;
}

export interface HermesInstallConfig {
  // Local path OR git URL of the hermes-agent-gitops fork.
  // Required whenever stages.hermes is true — validated in the
  // hermes-install component (not here), consistent with how root-app
  // keeps its own stage-specific validation local to itself.
  source: string;
  // Git ref (branch/tag/sha) to pin the install to. For a git-URL
  // `source` it becomes the PEP 508 `@<ref>` pin. For a LOCAL-PATH
  // `source` (issue #7 [D3]): unset means the default fast-iteration
  // `--editable` install tracking whatever is on disk (NOT reproducible
  // across machines/checkouts); set, the install comes from the local
  // repo's git database at that ref (`git+file://<path>@<ref>`,
  // non-editable) — reproducible, working-tree-independent, requires the
  // path to be a git repo.
  ref: string;
  // Local path to this repo (harness-hg), whose gitops_emitter/
  // package is `uv tool install --with`'d into the same environment as the
  // fork. Empty string means "use this checked-out repo's own root" —
  // resolved in the hermes-install component (not here) so config.ts keeps
  // its no-filesystem-dependency property.
  pluginPath: string;
  // Passed straight through to plugins.entries.gitops-emitter.scaffold in
  // the operating profile's config.yaml.
  scaffold: boolean;
}

/** The agent runtime an `agents[]` entry runs on (ADR-149). `hermes` is the
 * legacy runtime and the default (stage 2, `hermes profile install`); `eve`
 * is an Eve project at agents[].subdir, emitted by the EveAgents component
 * through the push-driven emit_cli. */
export type AgentRuntime = "hermes" | "eve";

/** The instance-name prefix per runtime (ADR-151) - the same table as
 * cli/src/lib.ts RUNTIME_PREFIX and the charts' fullname helpers. */
export const RUNTIME_PREFIX: Record<AgentRuntime, string> = { hermes: "hermes-", eve: "ag-eve-" };

/** The instance name an agents[] entry deploys as: its explicit `name`,
 * else the last path segment of `subdir` (the agents/<name> convention;
 * for Hermes the distribution's own name, which the hook reads from
 * distribution.yaml - an entry without either is named by its source
 * basename). The agent-team layout's subdir is agents/<harness>/<name>/src
 * (ADR 0178): the payload segment is skipped, the agent directory is the
 * name. Used wherever the bootstrap must name a namespace before the
 * emitter has run. */
export function agentInstanceName(agent: { name: string | null; subdir: string; source: string }): string {
  if (agent.name) return agent.name;
  if (agent.subdir) {
    const segments = agent.subdir.split("/").filter(Boolean);
    if (segments.length > 1 && segments[segments.length - 1] === "src") segments.pop();
    return segments.pop()!;
  }
  return agent.source.split("/").filter(Boolean).pop()!.replace(/\.git$/, "");
}

/** ADR-151: an Eve instance's Secrets land in ag-eve-<name>, and the only
 * way the bootstrap knows an instance is Eve is an agents[] entry whose
 * derived name (agentInstanceName) equals the Secret's key. An Eve project
 * whose package.json name differs from its directory name would otherwise
 * get its Secrets in hermes-<name> and its pod in ag-eve-<name> - a
 * CreateContainerConfigError nobody connects to this config. Refuse it:
 * every agentSecrets/agentGitAuth key must either match a Hermes entry, a
 * recognised control-plane name, or an Eve entry by derived name - and an
 * Eve entry with a subdir whose basename is not a DNS label must set
 * agents[].name. */
export function validateEveSecretOwnership(config: BootstrapConfig): void {
  const eveEntries = config.agents.filter((a) => a.runtime === "eve");
  if (eveEntries.length === 0) return;
  for (const a of eveEntries) {
    const derived = agentInstanceName(a);
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(derived) || derived.length > 40) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agents[] (runtime eve, ${a.source}${a.subdir ? "/" + a.subdir : ""}): ` +
          `cannot derive the instance name (${JSON.stringify(derived)} is not a DNS-1123 label); set agents[].name ` +
          "to the project's package.json name so its Secrets land in ag-eve-<name>",
      );
    }
  }
  const hermesNames = new Set(config.agents.filter((a) => a.runtime === "hermes").map(agentInstanceName));
  const eveNames = new Set(eveEntries.map(agentInstanceName));
  for (const key of [...Object.keys(config.agentSecrets), ...Object.keys(config.agentGitAuth)]) {
    if (eveNames.has(key) || hermesNames.has(key)) continue;
    if (config.agents.some((a) => a.runtime === "hermes" && a.name === null && a.subdir === "")) continue; // a root-layout Hermes entry is named by its distribution, unknown here
    throw new ConfigError(
      `hermes-gitops-bootstrap:agentSecrets/agentGitAuth key ${JSON.stringify(key)} matches no agents[] entry ` +
        `(known: ${[...hermesNames, ...eveNames].sort().join(", ") || "none"}); a stack with Eve agents must be able to ` +
        "tell which runtime owns each Secret, so name the Eve entry (agents[].name) or fix the key",
    );
  }
}

/** Runtime of the agents[] entry that deploys instance `name`, hermes when
 * no entry claims it (control-plane profiles, pre-ADR-149 stacks). */
export function runtimeOfInstance(agents: { name: string | null; subdir: string; source: string; runtime: AgentRuntime }[], name: string): AgentRuntime {
  return agents.find((a) => agentInstanceName(a) === name)?.runtime ?? "hermes";
}
export const AGENT_RUNTIMES: readonly AgentRuntime[] = ["hermes", "eve"];

/** One entry of the `agents:` stack config list (bootstrap stage 2). */
export interface AgentSpec {
  runtime: AgentRuntime;
  source: string;
  ref: string;
  // Subdirectory of the source repo containing the distribution (the
  // fork's `hermes profile install --subdir` form). "" = root layout.
  subdir: string;
  // Overrides `hermes profile install --name` / the distribution's own
  // manifest name. Null means "let the distribution name itself".
  name: string | null;
  // Extension-block overrides (apps/appValues/deployment/expose/
  // gitAuthSecretRef), rendered into the HERMES_GITOPS_OVERRIDES file
  // (see gitops_emitter/README.md's "Override chain"). deep_merge
  // replaces LISTS WHOLESALE, so `overrides.apps` REPLACES the
  // distribution's entire hermes-gitops.yaml `apps:` list - every entry
  // must be complete (name/chart/repo/version). The per-instance channel
  // for satisfying `valuesRequired` paths without touching the list is
  // `overrides.appValues` ({<appName>: values-fragment}, deep-merged
  // onto each app's own values). Null/empty means no per-instance
  // overrides.
  overrides: Record<string, unknown> | null;
}

export interface ArgoRepoCreds {
  gitopsToken: string | null;
  gitopsUsername: string;
  hermesGitopsToken: string | null;
  hermesGitopsUsername: string;
}

// One remote workload cluster to register with Argo CD (issue #5 [C1]):
// minted as an argocd.argoproj.io/secret-type=cluster Secret so
// Applications can target it by NAME (spec.targetCluster, issue #9 [C3];
// read by the parameterized ApplicationSet destination, issue #8 [C2]).
// Credential model: bearer token + CA data (the simplest shape Argo CD's
// cluster Secret `config` blob accepts); `insecure: true` is the
// local/dev escape hatch when no CA bundle is at hand. Registration is
// always explicit operator input - a Theme A-provisioned cluster does
// NOT auto-register.
export interface TargetClusterSpec {
  name: string;
  server: string;
  bearerToken: string;
  caData: string | null;
  insecure: boolean;
}

// One helm-OCI chart registry that profiles' spec.apps[] `repo: oci://…`
// entries pull from (#187). Argo CD needs an
// argocd.argoproj.io/secret-type=repository Secret with enableOCI for
// every helm-OCI registry - without one the scheme-less repoURL the
// hermes-profile chart renders is not recognized as a helm repo. `url`
// keeps the oci:// identity used by records and the sourceRepos
// allowlist; the minted Secret carries the scheme-less form Argo
// expects. Credentials optional (public registries pull anonymously);
// `insecure: true` is the local/dev escape hatch for self-signed
// registries, never a production default. Set tokens with
// `pulumi config set --secret --path 'helmOciRegistries[<i>].token'`.
export interface HelmOciRegistrySpec {
  url: string;
  username: string | null;
  token: string | null;
  insecure: boolean;
}

// Control-plane ingress (spec section 25): publish internal control-plane
// services (Grafana, Argo CD, optionally Hermes) plus ONE SUBDOMAIN PER
// AGENT through a single outbound-only Cloudflare Tunnel, every request
// gated by a Cloudflare Zero Trust Access application at the edge. All of
// it is Pulumi-provisioned (components/cloudflare-ingress); recovery is
// `pulumi up`. Distinct from providers.ingress="cloudflare" (the
// PER-INSTANCE tunnel path via PKO Stack CRs — see
// _docs/wiki/platform/tunneling.md): this block is about the OPERATOR-facing
// control-plane surface, one tunnel for the whole cluster.
export const CONTROL_PLANE_INGRESS_PROVIDERS = ["none", "cloudflare"] as const;
export type ControlPlaneIngressProvider = (typeof CONTROL_PLANE_INGRESS_PROVIDERS)[number];

// One named Zero Trust Access GROUP (cloudflare.ZeroTrustAccessGroup):
// a reusable bundle of identities the per-target policies reference by
// id. Members are OR-combined; a group must have at least one member
// rule (an empty group in an allow policy would lock everyone out).
export interface AccessGroupSpec {
  emails: string[];
  emailDomains: string[];
  serviceTokenIds: string[];
}

// One agent-application workload published through the control-plane
// tunnel (ADR-40): a dedicated public hostname dialing an in-cluster
// origin. Reachability only — Cloudflare Access decides who may connect;
// the application keeps its own authentication and authorization.
export interface WorkloadEndpointSpec {
  // Fully-qualified public hostname (lowercase labels), within zoneName.
  hostname: string;
  // In-cluster origin URL (http:// or https://).
  origin: string;
  // Skip origin TLS verification. Unlike the built-in argocd target this
  // is NOT derived from the scheme — an https origin is verified unless
  // explicitly opted out (self-signed in-cluster certs).
  noTlsVerify: boolean;
}

export interface WebhookEndpointSpec {
  // Fully-qualified public hostname (lowercase labels), within zoneName.
  hostname: string;
  // In-cluster origin URL (http:// or https://).
  origin: string;
  // A webhook endpoint is DELIBERATELY not behind Cloudflare Access: the
  // sender (Slack, GitHub, …) is a machine that cannot pass an identity
  // or service-token challenge, and the provider's request SIGNATURE is
  // the authentication — verified at the origin (eve's channel), not the
  // edge. This is the status.example.dev posture, scoped to one
  // path per hostname. There is no `groups` field by construction.
}

export interface ControlPlaneIngressConfig {
  // "none" (default) disables the whole feature; "cloudflare" provisions
  // the tunnel + Access + DNS + in-cluster cloudflared.
  provider: ControlPlaneIngressProvider;
  accountId: string;
  zoneId: string;
  // The public zone the subdomains live under, e.g. "example.com".
  zoneName: string;
  // Zero Trust team name (<team>.cloudflareaccess.com) — required by the
  // per-rule Access enforcement (originRequest.access.teamName).
  teamName: string;
  // Access session lifetime for every published app.
  sessionDuration: string;
  // Named Access groups, provisioned once and assigned per target via
  // access.groups below — THE way to scope who reaches Grafana vs Argo
  // CD vs which agents (e.g. platform-admins get argocd, a broader
  // viewers group gets grafana, a support team gets its own agent).
  accessGroups: Record<string, AccessGroupSpec>;
  // Who may enter. Two layers, per published hostname:
  //   1. access.groups[<target>] — group NAMES (keys of accessGroups)
  //      whose members may reach that target. Targets: "grafana",
  //      "argocd", "hermes", "agents" (default for every agent
  //      subdomain), "agent:<name>" (one agent, overrides "agents"),
  //      "workload:<agent>/<app>" (one workloadEndpoints entry — NO
  //      fallback: an explicit group list is required).
  //   2. Fallback: targets with NO group assignment use the flat
  //      emailDomain/serviceTokenIds include (the original single-rule
  //      shape - fine for small fleets where everyone sees everything).
  // Every published hostname must end up with at least one include, or
  // config validation fails at preview (an allow policy with no include
  // locks everyone out).
  access: {
    emailDomain: string;
    serviceTokenIds: string[];
    groups: Record<string, string[]>;
    // Optional Google login at the edge (#332): when BOTH are set, the
    // bootstrap provisions a Zero Trust Google identity provider from
    // this OAuth client (created by hand in the Cloud Console - Google
    // exposes no API for it; see runbooks/google-sso.md). The account's
    // existing one-time-PIN method stays offered alongside it - Google
    // is an additional door, never the only one, so a misconfigured
    // client cannot lock the operator out of the edge.
    googleClientId: string;
    googleClientSecret: string;
  };
  // Subdomain LABELS (within zoneName) for the control-plane services;
  // "" disables that service's hostname. hermes is off by default: the
  // Hermes CLI runs host-side (the operating profile), not as an
  // in-cluster Service — point services.hermes somewhere real before
  // enabling it. NOTE this is the Hermes Classic surface only; Nexus
  // moved in-cluster in ADR-48 and has its own entry below.
  hostnames: {
    hermes: string;
    // The Nexus dashboard (ADR-48: charts/nexus in hermes-nexus). Off by
    // default like hermes, but for the opposite reason — the Service is
    // real, so publishing it is a deliberate exposure decision, not a
    // missing origin. Setting this is what gives Nexus an Access
    // application, and what lets the bootstrap hand it real integration
    // URLs instead of the CLI's host port-forwards (ADR-53).
    nexus: string;
    grafana: string;
    argocd: string;
    // Off by default, unlike grafana/argocd. Prometheus has NO
    // authentication of its own, so publishing it makes Access the only
    // gate in front of it rather than a second one - that is a decision
    // an operator opts into, never a default.
    prometheus: string;
  };
  // In-cluster origin URL per service (what cloudflared dials).
  services: {
    hermes: string;
    nexus: string;
    grafana: string;
    argocd: string;
    prometheus: string;
    // Where per-agent subdomain traffic is sent: the cluster's Traefik,
    // which then routes by the profile's EXISTING in-cluster Ingress
    // rules (site at /, secret-tester at /secret-tester, ...).
    traefik: string;
  };
  // One "<agent-name>.<zoneName>" hostname per agents[] entry, routed to
  // services.traefik with the profile's conventional host header
  // ("<agent-name>.<agentHostHeaderDomain>") so the in-cluster Ingress
  // rules match unchanged.
  agentSubdomains: boolean;
  agentHostHeaderDomain: string;
  // Per-workload hostnames, keyed "<agent>/<app>". Each rides the same
  // pipeline as every other published hostname (Access app + policy +
  // DNS record + tunnel ingress rule) and MUST have a matching
  // access.groups["workload:<agent>/<app>"] assignment.
  workloadEndpoints: Record<string, WorkloadEndpointSpec>;
  // No-Access webhook hostnames (ADR 0174): one per provider webhook that
  // must be reachable by an unauthenticated, signed POST. Keyed by a
  // resource-safe name; the value is {hostname, origin}. No Access group
  // by construction.
  webhookEndpoints: Record<string, WebhookEndpointSpec>;
}

// One published hostname, fully resolved: the pure output of
// controlPlaneHostnames() below, consumed by components/cloudflare-ingress
// (one Access app + policy + DNS record + tunnel ingress rule each).
export interface PublishedHostname {
  // Resource-name-safe key ("grafana", "argocd", "hermes", "agent-<name>").
  key: string;
  // Fully-qualified public hostname.
  host: string;
  // In-cluster origin URL.
  service: string;
  // Host header override for traefik-routed agent subdomains.
  hostHeader: string | null;
  // Skip origin TLS verification (Argo CD's self-signed default cert).
  noTlsVerify: boolean;
  // Access group NAMES gating this hostname (resolved from
  // access.groups; empty = fall back to the flat emailDomain/
  // serviceTokenIds include).
  groups: string[];
  // A webhook endpoint published WITHOUT Cloudflare Access (signature is
  // the auth). The ingress component skips the Access app + policy and
  // sets access.required:false for these; `groups` is always empty here.
  noAccess: boolean;
}

export interface BootstrapConfig {
  // See CLUSTER_PROVIDERS above. Defaults to "none" so an unmodified
  // stack file keeps working with no config change.
  clusterProvider: ClusterProvider;
  kubeconfigPath: string | null;
  kubeconfigContext: string | null;
  gitopsRepoUrl: string;
  gitopsBranch: string;
  // Server-side pull-request enforcement on the GitOps repo's default
  // branch (ADR-95, #179). null = the platform does not touch protection
  // at all, which is the shipped default: turning this on changes how an
  // existing environment's reconcile loop behaves, and that is the
  // operator's decision about their own live system.
  gitopsBranchProtection: boolean | null;
  // Approving reviews the protection demands. 0 is the solo-operator
  // posture - a pull request is still REQUIRED, and one person can
  // satisfy it, which is what ADR-2 and ADR-12 actually need.
  gitopsRequiredReviewers: number | null;
  hermesGitopsRepoUrl: string;
  chartRevision: string;
  providers: Providers;
  versions: Versions;
  stages: Stages;
  argocdRepoCreds: ArgoRepoCreds;
  // Remote workload clusters to register as Argo CD cluster Secrets.
  // Default empty = today's single in-cluster behavior. Set bearer tokens
  // with `pulumi config set --secret --path 'targetClusters[<i>].bearerToken'`.
  //
  // This is the ENVIRONMENT side. The per-record half - hermesprofile's
  // spec.targetCluster - was removed in v1alpha2 (#132), and its
  // successor is NOT a record field (#176, ADR-33): placement is the
  // environment's decision. environment/topology.yaml names each
  // target's argoDestination; the topology compiler emits it per
  // instance record; the per-instance ApplicationSets read it. TOPO017
  // (the plan-time preview gate) joins the two sides: a topology
  // destination not registered here fails `pulumi preview`, naming this
  // config key as the fix.
  targetClusters: TargetClusterSpec[];
  // Helm-OCI chart registries profiles pull spec.apps[] charts from,
  // minted as Argo CD repository Secrets in stage 3 (#187). Default
  // empty = no oci:// apps anywhere in the fleet.
  helmOciRegistries: HelmOciRegistrySpec[];
  // {instanceName: {ENV_VAR: value}} — per-agent env secrets, set with
  // `pulumi config set --secret --path 'agentSecrets.<name>.<VAR>'`.
  // Parsed/validated by the agent-secrets component (issue #38 [K6]);
  // read as a PLAIN object here (resource construction needs the keys) —
  // values re-enter secret tracking via pulumi.secret() at the point of
  // use, so state/previews stay ciphertext.
  agentSecrets: Record<string, Record<string, string>>;
  // {secretKey: value} — EXTRA keys merged into the event router's
  // Secret (hermes-event-router-secrets) beside the per-agent
  // WEBHOOK_SECRET entries: external-input signing secrets and chatops
  // webhook-URL credentials. Set with
  // `pulumi config set --secret --path 'routerSecrets.<key>'`.
  // Declared here so hand-patched keys stop being wiped on up (#357).
  routerSecrets: Record<string, string>;
  // {instanceName: {username, password} | {sshPrivateKey}} — private
  // spec.source credentials, materialized as hermes-<name>-git-auth
  // (issue #18 [G1]; set values with `pulumi config set --secret --path
  // 'agentGitAuth.<name>.<field>'`).
  agentGitAuth: Record<string, Record<string, string>>;
  // See PluginConfigFields (issue #13 [E3]).
  pluginConfig: PluginConfigFields;
  // The fleet defaults document (BOTTOM of the emitter's override chain),
  // seeded wholesale to defaults_file by the stage-1 config apply when
  // non-null. null = don't manage the file (hand-authoring stays
  // possible; its absence is a documented no-op).
  fleetDefaults: Record<string, unknown> | null;
  hermesInstall: HermesInstallConfig;
  agents: AgentSpec[];
  // Control-plane ingress via Cloudflare Tunnel + Zero Trust (see
  // ControlPlaneIngressConfig above).
  controlPlaneIngress: ControlPlaneIngressConfig;
  nexusCapabilities: NexusCapabilitiesConfig;
  // Slack workspace provisioning (SlackWorkspace component): per-agent
  // Slack apps via the official Slack CLI + declaratively managed
  // channels/membership. See SlackConfig below.
  slack: SlackConfig;
  // Cloudflare API token the pulumi-cloudflare provider authenticates
  // with (tunnel/DNS/Access management scopes). Required when
  // controlPlaneIngress.provider=cloudflare; set with
  // `pulumi config set --secret hermes-gitops-bootstrap:cloudflareApiToken`.
  cloudflareApiToken: pulumi.Output<string> | null;
  // GITOPS_GIT_TOKEN: push (and, if scaffold, repo-creation) credential for
  // gitopsRepoUrl, written into the operating profile's .env by the
  // hermes-install component. Distinct from argocdRepoCreds.gitopsToken
  // above (that one is a read-only Argo CD repo credential Secret applied
  // to the cluster in stage 3) — same physical PAT may satisfy both in a
  // real fleet, but they're different consumers with different scopes, so
  // kept as separate config keys rather than aliased together.
  gitopsGitToken: pulumi.Output<string> | null;
  // The destination-host reconciler (#271, ADR-54): a systemd user timer
  // driving `hg reconcile`. Declared here so its version, cadence and
  // commands upgrade through `pulumi up` like everything else.
  reconcile: ReconcileStackConfig;
}

export interface ReconcileStackConfig {
  /** Additional independent repository watchers, sharing the default deployment lock. */
  instances?: Record<string, ReconcileStackConfig>;
  enabled: boolean;
  // Pinned version stamped into the unit and the ledger. Changing it and
  // running `pulumi up` IS the upgrade path.
  version: string;
  repoUrl: string;
  branch: string;
  intervalSeconds: number;
  // Preflights and the one mutation command. Empty = the CLI defaults
  // (hg topology doctor + pulumi preview, then pulumi up --yes).
  checks: string[];
  apply: string;
  statusNamespace?: string;
  kubeContext?: string;
}

/** True when gitopsRepoUrl is a known-unreachable placeholder.
 *
 * components/root-app uses this to skip creating the hermes-gitops-root
 * Application entirely rather than create one that will forever report a
 * missing/unreachable repo — useful for stage-3-only verification runs
 * where stage 2 (which actually populates a real GitOps repo) hasn't run
 * yet. */
export function gitopsRepoIsPlaceholder(gitopsRepoUrl: string): boolean {
  return PLACEHOLDER_URL_MARKERS.some((marker) => gitopsRepoUrl.includes(marker));
}

function requireEnum<T extends string>(
  container: Record<string, unknown>,
  key: string,
  valid: readonly T[],
): T {
  if (!(key in container)) {
    throw new ConfigError(
      `hermes-gitops-bootstrap:providers.${key} is required (one of: ${valid.join(", ")})`,
    );
  }
  const raw = container[key];
  if (typeof raw !== "string" || !(valid as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `hermes-gitops-bootstrap:providers.${key} = ${JSON.stringify(raw)} is not valid; ` +
        `expected one of: ${valid.join(", ")}`,
    );
  }
  return raw as T;
}

/** Parse the top-level `clusterProvider` stack key (scalar variant of the
 * providers-triad enum validation; absent means "none"). */
export function parseClusterProvider(raw: unknown): ClusterProvider {
  if (raw === undefined || raw === null || raw === "") return "none";
  if (
    typeof raw !== "string" ||
    !(CLUSTER_PROVIDERS as readonly string[]).includes(raw)
  ) {
    throw new ConfigError(
      `hermes-gitops-bootstrap:clusterProvider = ${JSON.stringify(raw)} is not valid; ` +
        `expected one of: ${CLUSTER_PROVIDERS.join(", ")}`,
    );
  }
  return raw as ClusterProvider;
}

export function parseProviders(raw: Record<string, unknown>): Providers {
  return {
    compute: requireEnum(raw, "compute", COMPUTE_PROVIDERS),
    secret: requireEnum(raw, "secret", SECRET_PROVIDERS),
    ingress: requireEnum(raw, "ingress", INGRESS_PROVIDERS),
  };
}

export function parseVersions(raw: Record<string, unknown>): Versions {
  return {
    argocdChart: (raw["argocdChart"] as string) || DEFAULT_ARGOCD_CHART_VERSION,
    esoChart: (raw["esoChart"] as string) || DEFAULT_ESO_CHART_VERSION,
    pkoChart: (raw["pkoChart"] as string) || DEFAULT_PKO_CHART_VERSION,
  };
}

export function parseStages(raw: Record<string, unknown>): Stages {
  return {
    hermes: Boolean(raw["hermes"] ?? true),
    agents: Boolean(raw["agents"] ?? true),
    cluster: Boolean(raw["cluster"] ?? true),
  };
}

export function isGithubRepoUrl(url: string): boolean {
  return /^(?:https?:\/\/|git@)?(?:www\.)?github\.com[:/]/.test(url.trim());
}

export function parsePluginConfig(raw: Record<string, unknown>): PluginConfigFields {
  const mode = (raw["mode"] as string) ?? null;
  if (mode !== null && mode !== "direct" && mode !== "pr") {
    throw new ConfigError(
      `hermes-gitops-bootstrap:pluginConfig.mode = ${JSON.stringify(mode)} is not valid; ` +
        'expected "direct" or "pr"',
    );
  }
  return {
    mode,
    prAutoMerge: (raw["prAutoMerge"] as boolean) ?? null,
    allowDirectCommit: (raw["allowDirectCommit"] as boolean) ?? null,
    profilesPath: (raw["profilesPath"] as string) ?? null,
    defaultsFile: (raw["defaultsFile"] as string) ?? null,
    overridesDir: (raw["overridesDir"] as string) ?? null,
    gitAuthorName: (raw["gitAuthorName"] as string) ?? null,
    gitAuthorEmail: (raw["gitAuthorEmail"] as string) ?? null,
    imageRepository: (raw["imageRepository"] as string) ?? null,
    imageTag: (raw["imageTag"] as string) ?? null,
  };
}

export function parseFleetDefaults(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      "hermes-gitops-bootstrap:fleetDefaults must be a mapping (the fleet " +
        "defaults.yaml document)",
    );
  }
  return raw as Record<string, unknown>;
}

export function parseHermesInstall(raw: Record<string, unknown>): HermesInstallConfig {
  return {
    source: (raw["source"] as string) || "",
    ref: (raw["ref"] as string) || "",
    pluginPath: (raw["pluginPath"] as string) || "",
    scaffold: Boolean(raw["scaffold"] ?? true),
  };
}

// The override document's allowed shape (issue #34 [K3]): the emitter's
// extension blocks. Validated at PREVIEW so a typo ("deplyoment") fails
// loudly instead of being silently dropped by the merge chain (unknown
// keys never reach the rendered record).
const OVERRIDE_TOP_KEYS = [
  "apps",
  "appValues",
  "backup",
  "deployment",
  "expose",
  "gitAuthSecretRef",
] as const;
// Keys REMOVED by the hermes-gitops.yaml helm-apps contract (v1alpha1
// in-place evolution). Each maps to a message explaining what replaced it,
// so an operator carrying a pre-contract config gets a migration hint
// instead of a bare "unknown key".
const REMOVED_KEYS: Record<string, string> = {
  workloads:
    "the workload menu was removed - declare helm apps in the `apps:` list " +
    "(hermes-gitops.yaml: [{name, chart, repo, version?, values}]) instead",
  reach:
    "multi-region placement was removed - v1 is single-cluster (see the " +
    "hermes-gitops.yaml contract's Removals section)",
  targetCluster:
    "multi-cluster placement was removed - v1 is single-cluster; every " +
    "profile lands on the control-plane cluster (in-cluster)",
  workload_selection:
    "the workload menu was removed - declare helm apps in the `apps:` list " +
    "and override their values via the `apps` override block instead",
};
// deployment lost its VM-era keys (machineType/region/diskType) with the
// pod-only compute contract.
// Contract v2 keys are PROFILE-owned declarations (ADR-33): the
// environment selects a layout in environment/topology.yaml but must not
// be able to widen an endpoint surface or weaken a declared topology or
// data boundary through a per-instance override - so they are rejected in
// overrides with a pointed message rather than a bare "unknown key".
const V2_PROFILE_ONLY_KEYS: Record<string, string> = {
  contractVersion:
    "the contract version is declared in the profile's hermes-gitops.yaml, " +
    "never in an override",
  topology:
    "topology is profile-owned (ADR-33) - the environment selects a layout in " +
    "environment/topology.yaml; an override cannot change what a profile supports",
  endpoints:
    "endpoints are profile-owned (ADR-33) - an override cannot add, remove, or " +
    "retype an endpoint",
  requires:
    "capability requirements are profile-owned (ADR-33) - bindings are resolved " +
    "by the topology compiler, never overridden per instance",
};
const DEPLOYMENT_KEYS = ["baseImageTag", "diskSizeGb"];
const REMOVED_DEPLOYMENT_KEYS: Record<string, string> = {
  machineType: "removed with the per-agent VM compute path - pod compute only",
  region: "removed with the per-agent VM compute path - pod compute only",
  diskType: "removed with the per-agent VM compute path - pod compute only",
};
const EXPOSE_KEYS = ["services", "access"];

// One `apps:` entry (the helm-chart-centric declaration replacing the
// workload menu). `local` is a reserved repo word: the chart ships with
// the platform repo, so `version` is forbidden (it versions with the
// platform); remote repos (https:// or oci://) require `version` for
// deterministic deploys.
const APP_ENTRY_KEYS = ["name", "chart", "repo", "version", "values", "valuesRequired"];
const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Validate one `apps:` list at preview - contract rules 1-3 plus
 * per-entry key/shape checks. `partial: true` is the override-document
 * variant: entries are by-name value patches (deep-merged onto the
 * declared app by the emitter), so only `name` is mandatory and
 * chart/repo/version are validated only when present. Deep
 * valuesRequired satisfaction is validated downstream by the emitter
 * (K5 fail-fast), where fleet defaults + per-instance overrides are in
 * hand. */
export function validateApps(
  raw: unknown,
  where: string,
  partial = false,
  entryKeys: string[] = APP_ENTRY_KEYS,
): void {
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      `${where} must be a list of {name, chart, repo, version?, values?} app entries`,
    );
  }
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const at = `${where}[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${at} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!entryKeys.includes(key)) {
        throw new ConfigError(
          `${at}.${key} is not a recognized app key (allowed: ${entryKeys.join(", ")})`,
        );
      }
    }
    const name = e["name"];
    if (typeof name !== "string" || !DNS_LABEL_RE.test(name)) {
      throw new ConfigError(
        `${at}.name must be a DNS-1123 label (lowercase alphanumerics and '-')`,
      );
    }
    if (seen.has(name)) {
      throw new ConfigError(`${where}: app name "${name}" is declared twice (names must be unique)`);
    }
    seen.add(name);
    const chart = e["chart"];
    if (chart !== undefined || !partial) {
      if (typeof chart !== "string" || chart === "") {
        throw new ConfigError(
          `${at}.chart is required (chart name for a remote repo, chart path for repo: local)`,
        );
      }
    }
    const repo = e["repo"];
    if (repo !== undefined || !partial) {
      if (
        typeof repo !== "string" ||
        (repo !== "local" && !repo.startsWith("https://") && !repo.startsWith("oci://"))
      ) {
        throw new ConfigError(
          `${at}.repo must be "local" or a https:// / oci:// helm repo URL`,
        );
      }
      const version = e["version"];
      if (repo === "local") {
        if (version !== undefined) {
          throw new ConfigError(
            `${at}.version is forbidden for repo: local (local charts version with the platform repo)`,
          );
        }
      } else if ((typeof version !== "string" || version === "") && !(partial && version === undefined)) {
        throw new ConfigError(
          `${at}.version is required for remote helm repos (deterministic deploys)`,
        );
      }
    }
    const values = e["values"];
    if (values !== undefined && (typeof values !== "object" || values === null || Array.isArray(values))) {
      throw new ConfigError(`${at}.values must be a mapping of chart values`);
    }
    const valuesRequired = e["valuesRequired"];
    if (valuesRequired !== undefined) {
      if (!Array.isArray(valuesRequired) || valuesRequired.some((p) => typeof p !== "string" || p === "")) {
        throw new ConfigError(
          `${at}.valuesRequired must be a list of dot-path strings the operator supplies`,
        );
      }
    }
  });
}

export function validateAgentOverrides(
  overrides: Record<string, unknown>,
  where: string,
): void {
  const checkKeys = (obj: Record<string, unknown>, allowed: string[], label: string) => {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        const prefix = `${where}.${label}${label ? "." : ""}${key}`;
        const removed = label === "" ? REMOVED_KEYS[key] : label === "deployment" ? REMOVED_DEPLOYMENT_KEYS[key] : undefined;
        if (removed !== undefined) {
          throw new ConfigError(`${prefix} was removed: ${removed}`);
        }
        const profileOnly = label === "" ? V2_PROFILE_ONLY_KEYS[key] : undefined;
        if (profileOnly !== undefined) {
          throw new ConfigError(`${prefix} is not overridable: ${profileOnly}`);
        }
        throw new ConfigError(
          `${prefix} is not a recognized override ` +
            `key (allowed: ${allowed.join(", ")}) - unknown keys would be silently ` +
            "dropped from the rendered record, so they fail here at preview instead",
        );
      }
    }
  };
  checkKeys(overrides, [...OVERRIDE_TOP_KEYS], "");
  const apps = overrides["apps"];
  if (apps !== undefined) {
    validateApps(apps, `${where}.apps`, /* partial */ true);
  }
  const deployment = overrides["deployment"];
  if (deployment !== undefined) {
    if (typeof deployment !== "object" || deployment === null || Array.isArray(deployment)) {
      throw new ConfigError(`${where}.deployment must be a mapping`);
    }
    checkKeys(deployment as Record<string, unknown>, DEPLOYMENT_KEYS, "deployment");
  }
  const expose = overrides["expose"];
  if (expose !== undefined) {
    if (typeof expose !== "object" || expose === null || Array.isArray(expose)) {
      throw new ConfigError(`${where}.expose must be a mapping`);
    }
    checkKeys(expose as Record<string, unknown>, EXPOSE_KEYS, "expose");
  }
  const gitAuthSecretRef = overrides["gitAuthSecretRef"];
  if (gitAuthSecretRef !== undefined && typeof gitAuthSecretRef !== "string") {
    throw new ConfigError(`${where}.gitAuthSecretRef must be a string (a Secret name)`);
  }
  // appValues: {<appName>: <values fragment>} — the per-app values channel
  // (satisfies valuesRequired; deep-merged by the emitter, lists replaced
  // wholesale). Fragments are free-form chart values, so only the envelope
  // is validated here.
  const appValues = overrides["appValues"];
  if (appValues !== undefined) {
    if (typeof appValues !== "object" || appValues === null || Array.isArray(appValues)) {
      throw new ConfigError(`${where}.appValues must be a mapping of {appName: values}`);
    }
    for (const [appName, fragment] of Object.entries(appValues as Record<string, unknown>)) {
      if (typeof fragment !== "object" || fragment === null || Array.isArray(fragment)) {
        throw new ConfigError(`${where}.appValues.${appName} must be a mapping (chart values)`);
      }
    }
  }
  // backup intent is free-form at this layer; the extension schema owns its shape.
}

export function parseAgent(entry: unknown, index: number): AgentSpec {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new ConfigError(
      `hermes-gitops-bootstrap:agents[${index}] must be a mapping, got ${
        Array.isArray(entry) ? "array" : typeof entry
      }`,
    );
  }
  const e = entry as Record<string, unknown>;
  const source = e["source"];
  if (!source) {
    throw new ConfigError(`hermes-gitops-bootstrap:agents[${index}].source is required`);
  }
  const runtimeRaw = e["runtime"];
  let runtime: AgentRuntime = "hermes";
  if (runtimeRaw !== undefined && runtimeRaw !== null && runtimeRaw !== "") {
    if (typeof runtimeRaw !== "string" || !(AGENT_RUNTIMES as readonly string[]).includes(runtimeRaw)) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agents[${index}].runtime must be one of ` +
          `${AGENT_RUNTIMES.join(", ")} (got ${JSON.stringify(runtimeRaw)})`,
      );
    }
    runtime = runtimeRaw as AgentRuntime;
  }
  const subdirRaw = e["subdir"];
  let subdir = "";
  if (subdirRaw !== undefined && subdirRaw !== null && subdirRaw !== "") {
    if (typeof subdirRaw !== "string") {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agents[${index}].subdir must be a string`,
      );
    }
    if (
      subdirRaw.startsWith("/") ||
      subdirRaw.includes("\\") ||
      subdirRaw.split("/").some((p) => p === "..")
    ) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agents[${index}].subdir must be a relative ` +
          "path inside the source repo (no leading '/', no '..', no backslashes)",
      );
    }
    subdir = subdirRaw.replace(/\/+$/, "");
  }
  if (e["workloads"] !== undefined) {
    throw new ConfigError(
      `hermes-gitops-bootstrap:agents[${index}].workloads was removed: the workload ` +
        "menu is gone - the distribution declares helm apps in its hermes-gitops.yaml " +
        "`apps:` list; per-instance value patches go under overrides.apps",
    );
  }
  const overrides = e["overrides"];
  if (
    overrides !== undefined &&
    overrides !== null &&
    (typeof overrides !== "object" || Array.isArray(overrides))
  ) {
    throw new ConfigError(`hermes-gitops-bootstrap:agents[${index}].overrides must be a mapping`);
  }
  if (overrides !== undefined && overrides !== null) {
    if (runtime === "eve") {
      // The override chain (fleet defaults -> hermes-gitops.yaml ->
      // per-instance overrides) is the Hermes record pipeline's; an Eve
      // record is built from the project's own v5 file alone. The one
      // override that IS an instance fact rather than authoring intent -
      // `appValues`, the per-instance values an app's valuesRequired
      // demands (ADR-150) - is accepted and reaches emit_cli as
      // --app-values; every other key is refused rather than silently
      // ignored.
      const extra = Object.keys(overrides as Record<string, unknown>).filter((k) => k !== "appValues");
      if (extra.length > 0) {
        throw new ConfigError(
          `hermes-gitops-bootstrap:agents[${index}].overrides.${extra[0]} is not supported for ` +
            "runtime: eve - an Eve agent's deployment intent lives in its own hermes-gitops.yaml " +
            "(contractVersion 5); only overrides.appValues applies",
        );
      }
    }
    validateAgentOverrides(
      overrides as Record<string, unknown>,
      `hermes-gitops-bootstrap:agents[${index}].overrides`,
    );
  }
  return {
    runtime,
    source: String(source),
    ref: String(e["ref"] ?? "") || "",
    subdir,
    name: e["name"] ? String(e["name"]) : null,
    overrides:
      overrides !== undefined && overrides !== null
        ? (overrides as Record<string, unknown>)
        : null,
  };
}

export function parseAgents(raw: unknown): AgentSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError("hermes-gitops-bootstrap:agents must be a list");
  }
  return raw.map((entry, i) => parseAgent(entry, i));
}

export function parseArgoRepoCreds(raw: Record<string, unknown>): ArgoRepoCreds {
  return {
    gitopsToken: (raw["gitopsToken"] as string) ?? null,
    gitopsUsername: (raw["gitopsUsername"] as string) ?? "git",
    hermesGitopsToken: (raw["hermesGitopsToken"] as string) ?? null,
    hermesGitopsUsername: (raw["hermesGitopsUsername"] as string) ?? "git",
  };
}

const TARGET_CLUSTER_KEYS = ["name", "server", "bearerToken", "caData", "insecure"];

export function parseTargetClusters(raw: unknown): TargetClusterSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError("hermes-gitops-bootstrap:targetClusters must be a list");
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const where = `hermes-gitops-bootstrap:targetClusters[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${where} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!TARGET_CLUSTER_KEYS.includes(key)) {
        throw new ConfigError(
          `${where}.${key} is not a recognized target-cluster key ` +
            `(allowed: ${TARGET_CLUSTER_KEYS.join(", ")})`,
        );
      }
    }
    const name = e["name"];
    if (typeof name !== "string" || !/^[a-z0-9]([-a-z0-9]{0,38}[a-z0-9])?$/.test(name)) {
      throw new ConfigError(
        `${where}.name must be a DNS-1123 label (max 40 chars) naming this ` +
          "cluster - it is what records reference via spec.targetCluster",
      );
    }
    if (name === "in-cluster") {
      throw new ConfigError(
        `${where}.name "in-cluster" is reserved (Argo CD's name for the ` +
          "control-plane cluster itself - records omit spec.targetCluster to get it)",
      );
    }
    if (seen.has(name)) {
      throw new ConfigError(`${where}.name "${name}" is declared twice`);
    }
    seen.add(name);
    const server = e["server"];
    if (typeof server !== "string" || !/^https:\/\//.test(server)) {
      throw new ConfigError(
        `${where}.server must be the cluster's https:// API server URL`,
      );
    }
    const bearerToken = e["bearerToken"];
    if (typeof bearerToken !== "string" || !bearerToken) {
      throw new ConfigError(
        `${where}.bearerToken is required (a ServiceAccount token Argo CD ` +
          "authenticates to the remote cluster with - set it with " +
          `\`pulumi config set --secret --path 'targetClusters[${i}].bearerToken'\`)`,
      );
    }
    const caData = (e["caData"] as string) ?? null;
    const insecure = (e["insecure"] as boolean) ?? false;
    if (typeof insecure !== "boolean") {
      throw new ConfigError(`${where}.insecure must be a boolean`);
    }
    if (!caData && !insecure) {
      throw new ConfigError(
        `${where} needs either caData (base64 CA bundle) or insecure: true - ` +
          "without both, Argo CD cannot validate the remote API server's TLS " +
          "and every sync would fail at connect time",
      );
    }
    return { name, server, bearerToken, caData, insecure };
  });
}

const HELM_OCI_REGISTRY_KEYS = ["url", "username", "token", "insecure"];

export function parseHelmOciRegistries(raw: unknown): HelmOciRegistrySpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError("hermes-gitops-bootstrap:helmOciRegistries must be a list");
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const where = `hermes-gitops-bootstrap:helmOciRegistries[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${where} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!HELM_OCI_REGISTRY_KEYS.includes(key)) {
        throw new ConfigError(
          `${where}.${key} is not a recognized helm-OCI registry key ` +
            `(allowed: ${HELM_OCI_REGISTRY_KEYS.join(", ")})`,
        );
      }
    }
    const url = e["url"];
    if (typeof url !== "string" || !url.startsWith("oci://") || url === "oci://") {
      throw new ConfigError(
        `${where}.url must be the registry's oci:// URL - the same identity ` +
          "profiles' spec.apps[].repo entries and the sourceRepos allowlist use",
      );
    }
    if (seen.has(url)) {
      throw new ConfigError(`${where}.url "${url}" is declared twice`);
    }
    seen.add(url);
    const username = e["username"] ?? null;
    const token = e["token"] ?? null;
    if (username !== null && (typeof username !== "string" || !username)) {
      throw new ConfigError(`${where}.username must be a non-empty string`);
    }
    if (token !== null && (typeof token !== "string" || !token)) {
      throw new ConfigError(`${where}.token must be a non-empty string`);
    }
    if ((username === null) !== (token === null)) {
      throw new ConfigError(
        `${where} needs username and token together (or neither, for ` +
          "anonymous pulls from a public registry) - set the token with " +
          `\`pulumi config set --secret --path 'helmOciRegistries[${i}].token'\``,
      );
    }
    const insecure = (e["insecure"] as boolean) ?? false;
    if (typeof insecure !== "boolean") {
      throw new ConfigError(`${where}.insecure must be a boolean`);
    }
    return { url, username, token, insecure };
  });
}

const CONTROL_PLANE_INGRESS_KEYS = [
  "provider",
  "accountId",
  "zoneId",
  "zoneName",
  "teamName",
  "sessionDuration",
  "accessGroups",
  "access",
  "hostnames",
  "services",
  "agentSubdomains",
  "agentHostHeaderDomain",
  "workloadEndpoints",
  "webhookEndpoints",
];
const CPI_WEBHOOK_ENDPOINT_KEYS = ["hostname", "origin"];
const CPI_ACCESS_KEYS = [
  "emailDomain",
  "serviceTokenIds",
  "groups",
  "googleClientId",
  "googleClientSecret",
];
const CPI_GROUP_KEYS = ["emails", "emailDomains", "serviceTokenIds"];
// access.groups target keys: fixed control-plane targets, the all-agents
// default, or one agent ("agent:<name>" - the <name> part is validated
// against the agents[] list in controlPlaneHostnames, where both sides
// are in hand).
const CPI_GROUP_TARGETS = ["grafana", "argocd", "hermes", "nexus", "agents"];

function parseStringList(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string" && v)) {
    throw new ConfigError(`${where} must be a list of non-empty strings`);
  }
  return raw as string[];
}

function parseAccessGroups(
  raw: unknown,
  where: string,
): Record<string, AccessGroupSpec> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be a mapping of {groupName: member rules}`);
  }
  const out: Record<string, AccessGroupSpec> = {};
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    const at = `${where}.${name}`;
    if (!/^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?$/.test(name)) {
      throw new ConfigError(
        `${where}: group name ${JSON.stringify(name)} must be alphanumeric-with-hyphens`,
      );
    }
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      throw new ConfigError(`${at} must be a mapping`);
    }
    const e = spec as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!CPI_GROUP_KEYS.includes(key)) {
        throw new ConfigError(
          `${at}.${key} is not a recognized group key (allowed: ${CPI_GROUP_KEYS.join(", ")})`,
        );
      }
    }
    const group: AccessGroupSpec = {
      emails: parseStringList(e["emails"], `${at}.emails`),
      emailDomains: parseStringList(e["emailDomains"], `${at}.emailDomains`),
      serviceTokenIds: parseStringList(e["serviceTokenIds"], `${at}.serviceTokenIds`),
    };
    if (
      group.emails.length === 0 &&
      group.emailDomains.length === 0 &&
      group.serviceTokenIds.length === 0
    ) {
      throw new ConfigError(
        `${at} has no member rule (emails/emailDomains/serviceTokenIds) - an ` +
          "empty group in an allow policy locks everyone out of its targets",
      );
    }
    out[name] = group;
  }
  return out;
}
const CPI_WORKLOAD_ENDPOINT_KEYS = ["hostname", "origin", "noTlsVerify"];

function parseWorkloadEndpoints(
  raw: unknown,
  where: string,
  zoneName: string,
): Record<string, WorkloadEndpointSpec> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `${where} must be a mapping of {"<agent>/<app>": {hostname, origin}}`,
    );
  }
  const out: Record<string, WorkloadEndpointSpec> = {};
  for (const [key, spec] of Object.entries(raw as Record<string, unknown>)) {
    const at = `${where}.${key}`;
    const parts = key.split("/");
    if (parts.length !== 2 || !parts.every((p) => DNS_LABEL_RE.test(p))) {
      throw new ConfigError(
        `${where}: key ${JSON.stringify(key)} must be "<agent>/<app>" ` +
          "(two DNS labels separated by one slash)",
      );
    }
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      throw new ConfigError(`${at} must be a mapping`);
    }
    const e = spec as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!CPI_WORKLOAD_ENDPOINT_KEYS.includes(k)) {
        throw new ConfigError(
          `${at}.${k} is not a recognized key (allowed: ${CPI_WORKLOAD_ENDPOINT_KEYS.join(", ")})`,
        );
      }
    }
    const hostname = e["hostname"];
    const origin = e["origin"];
    if (typeof hostname !== "string" || !hostname) {
      throw new ConfigError(`${at}.hostname is required (a non-empty string)`);
    }
    if (typeof origin !== "string" || !origin) {
      throw new ConfigError(`${at}.origin is required (a non-empty string)`);
    }
    let originUrl: URL | null = null;
    try {
      originUrl = new URL(origin);
    } catch {
      // handled below
    }
    if (
      originUrl === null ||
      (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
      !originUrl.hostname
    ) {
      throw new ConfigError(
        `${at}.origin = ${JSON.stringify(origin)} must be an http:// or ` +
          "https:// URL with a host - other protocols are not supported " +
          "by the control-plane tunnel",
      );
    }
    if (!hostname.split(".").every((label) => DNS_LABEL_RE.test(label))) {
      throw new ConfigError(
        `${at}.hostname = ${JSON.stringify(hostname)} must be a ` +
          "fully-qualified DNS name of lowercase labels (DNS is " +
          "case-insensitive; lowercase keeps the duplicate check honest)",
      );
    }
    if (zoneName && !hostname.endsWith(`.${zoneName}`)) {
      throw new ConfigError(
        `${at}.hostname = ${JSON.stringify(hostname)} is outside the ` +
          `configured zone ${JSON.stringify(zoneName)} - the DNS record ` +
          "can only be created within the zone",
      );
    }
    const noTlsVerify = e["noTlsVerify"] ?? false;
    if (typeof noTlsVerify !== "boolean") {
      throw new ConfigError(`${at}.noTlsVerify must be a boolean`);
    }
    out[key] = { hostname, origin, noTlsVerify };
  }
  return out;
}

/** No-Access webhook endpoints (ADR 0174). Same hostname/origin
 * validation as workload endpoints, but keyed by a single resource-safe
 * label (not "<agent>/<app>"), no TLS-verify knob (in-cluster http), and
 * crucially no Access group. Pure — unit-tested in config.test.ts. */
function parseWebhookEndpoints(
  raw: unknown,
  where: string,
  zoneName: string,
): Record<string, WebhookEndpointSpec> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be a mapping of {"<key>": {hostname, origin}}`);
  }
  const out: Record<string, WebhookEndpointSpec> = {};
  for (const [key, spec] of Object.entries(raw as Record<string, unknown>)) {
    const at = `${where}.${key}`;
    if (!DNS_LABEL_RE.test(key)) {
      throw new ConfigError(`${where}: key ${JSON.stringify(key)} must be a single DNS label`);
    }
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      throw new ConfigError(`${at} must be a mapping`);
    }
    const e = spec as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!CPI_WEBHOOK_ENDPOINT_KEYS.includes(k)) {
        throw new ConfigError(
          `${at}.${k} is not a recognized key (allowed: ${CPI_WEBHOOK_ENDPOINT_KEYS.join(", ")})`,
        );
      }
    }
    const hostname = e["hostname"];
    const origin = e["origin"];
    if (typeof hostname !== "string" || !hostname) {
      throw new ConfigError(`${at}.hostname is required (a non-empty string)`);
    }
    if (typeof origin !== "string" || !origin) {
      throw new ConfigError(`${at}.origin is required (a non-empty string)`);
    }
    let originUrl: URL | null = null;
    try {
      originUrl = new URL(origin);
    } catch {
      // handled below
    }
    if (
      originUrl === null ||
      (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
      !originUrl.hostname
    ) {
      throw new ConfigError(
        `${at}.origin = ${JSON.stringify(origin)} must be an http:// or https:// URL with a host`,
      );
    }
    if (!hostname.split(".").every((label) => DNS_LABEL_RE.test(label))) {
      throw new ConfigError(
        `${at}.hostname = ${JSON.stringify(hostname)} must be a fully-qualified DNS name ` +
          "of lowercase labels",
      );
    }
    if (zoneName && !hostname.endsWith(`.${zoneName}`)) {
      throw new ConfigError(
        `${at}.hostname = ${JSON.stringify(hostname)} is outside the configured zone ` +
          `${JSON.stringify(zoneName)}`,
      );
    }
    out[key] = { hostname, origin };
  }
  return out;
}
const CPI_HOSTNAME_KEYS = ["hermes", "nexus", "grafana", "argocd", "prometheus"];
const CPI_SERVICE_KEYS = ["hermes", "nexus", "grafana", "argocd", "prometheus", "traefik"];

/** Parse + validate the `controlPlaneIngress` stack key. Pure —
 * unit-tested in tests/config.test.ts. Absent config = provider "none"
 * (feature off), keeping an unmodified stack file working unchanged. */
export function parseControlPlaneIngress(raw: unknown): ControlPlaneIngressConfig {
  const where = "hermes-gitops-bootstrap:controlPlaneIngress";
  const defaults: ControlPlaneIngressConfig = {
    provider: "none",
    accountId: "",
    zoneId: "",
    zoneName: "",
    teamName: "",
    sessionDuration: "24h",
    accessGroups: {},
    access: {
      emailDomain: "",
      serviceTokenIds: [],
      groups: {},
      googleClientId: "",
      googleClientSecret: "",
    },
    hostnames: { hermes: "", nexus: "", grafana: "grafana", argocd: "argocd", prometheus: "" },
    services: {
      hermes: "",
      // Nexus runs in-cluster since ADR-48 (charts/nexus, namespace
      // hermes-nexus), so unlike hermes this has a real default origin -
      // only the hostname label needs setting to publish it.
      nexus: "http://nexus.hermes-nexus.svc",
      // The bootstrap's own monitoring stack (bootstrap/monitoring-stack
      // .yaml in the scaffolded GitOps repo) and Argo CD, at their
      // in-cluster Service addresses. Argo CD serves its self-signed cert
      // on https, hence the noTlsVerify handling in controlPlaneHostnames().
      grafana: "http://monitoring-grafana.hermes-monitoring.svc",
      // http, not https: the component runs argocd-server --insecure (TLS
      // terminates at the Cloudflare edge); an https origin gets its
      // handshake reset - found live as a tunnel 502.
      argocd: "http://argocd-server.argocd.svc",
      prometheus: "http://monitoring-prometheus.hermes-monitoring.svc:9090",
      traefik: "http://traefik.kube-system.svc:80",
    },
    webhookEndpoints: {},
    agentSubdomains: true,
    agentHostHeaderDomain: "hermes.local",
    workloadEndpoints: {},
  };
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  const e = raw as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!CONTROL_PLANE_INGRESS_KEYS.includes(key)) {
      throw new ConfigError(
        `${where}.${key} is not a recognized key (allowed: ${CONTROL_PLANE_INGRESS_KEYS.join(", ")})`,
      );
    }
  }
  const provider = (e["provider"] as string) ?? "none";
  if (!(CONTROL_PLANE_INGRESS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ConfigError(
      `${where}.provider = ${JSON.stringify(provider)} is not valid; ` +
        `expected one of: ${CONTROL_PLANE_INGRESS_PROVIDERS.join(", ")}`,
    );
  }
  const sub = (key: string, allowed: string[]): Record<string, unknown> => {
    const value = e[key];
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new ConfigError(`${where}.${key} must be a mapping`);
    }
    const record = value as Record<string, unknown>;
    for (const k of Object.keys(record)) {
      if (!allowed.includes(k)) {
        throw new ConfigError(
          `${where}.${key}.${k} is not a recognized key (allowed: ${allowed.join(", ")})`,
        );
      }
    }
    return record;
  };
  const access = sub("access", CPI_ACCESS_KEYS);
  const hostnames = sub("hostnames", CPI_HOSTNAME_KEYS);
  const services = sub("services", CPI_SERVICE_KEYS);
  const serviceTokenIds = parseStringList(
    access["serviceTokenIds"],
    `${where}.access.serviceTokenIds`,
  );
  const accessGroups = parseAccessGroups(e["accessGroups"], `${where}.accessGroups`);
  const workloadEndpoints = parseWorkloadEndpoints(
    e["workloadEndpoints"],
    `${where}.workloadEndpoints`,
    (e["zoneName"] as string) ?? "",
  );
  const webhookEndpoints = parseWebhookEndpoints(
    e["webhookEndpoints"],
    `${where}.webhookEndpoints`,
    (e["zoneName"] as string) ?? "",
  );
  const rawGroups = access["groups"];
  const groups: Record<string, string[]> = {};
  if (rawGroups !== undefined && rawGroups !== null) {
    if (typeof rawGroups !== "object" || Array.isArray(rawGroups)) {
      throw new ConfigError(
        `${where}.access.groups must be a mapping of {target: [group names]}`,
      );
    }
    for (const [target, names] of Object.entries(rawGroups as Record<string, unknown>)) {
      if (
        !CPI_GROUP_TARGETS.includes(target) &&
        !target.startsWith("agent:") &&
        !target.startsWith("workload:")
      ) {
        throw new ConfigError(
          `${where}.access.groups.${target} is not a recognized target ` +
            `(allowed: ${CPI_GROUP_TARGETS.join(", ")}, "agent:<name>", ` +
            `or "workload:<agent>/<app>")`,
        );
      }
      if (target.startsWith("workload:")) {
        const k = target.slice("workload:".length);
        if (!(k in workloadEndpoints)) {
          throw new ConfigError(
            `${where}.access.groups.${target} names an undeclared workload ` +
              `endpoint - declare it under ${where}.workloadEndpoints.${k} ` +
              "(hostname + origin) or remove the assignment",
          );
        }
      }
      const list = parseStringList(names, `${where}.access.groups.${target}`);
      for (const groupName of list) {
        if (!(groupName in accessGroups)) {
          throw new ConfigError(
            `${where}.access.groups.${target} references group ` +
              `${JSON.stringify(groupName)}, which is not declared under ` +
              `accessGroups (declared: ${Object.keys(accessGroups).sort().join(", ") || "<none>"})`,
          );
        }
      }
      groups[target] = list;
    }
  }
  for (const k of Object.keys(workloadEndpoints)) {
    if (!groups[`workload:${k}`]?.length) {
      throw new ConfigError(
        `${where}.workloadEndpoints.${k} has no access assignment - workload ` +
          "targets have no fallback (the flat emailDomain/serviceTokenIds " +
          `include does not apply); assign an explicit group list under ` +
          `${where}.access.groups["workload:${k}"]`,
      );
    }
  }
  const googleClientId = (access["googleClientId"] as string) ?? "";
  const googleClientSecret = (access["googleClientSecret"] as string) ?? "";
  if (!!googleClientId !== !!googleClientSecret) {
    throw new ConfigError(
      `${where}.access.googleClientId and .googleClientSecret must be set ` +
        "together - a half-configured identity provider fails at login " +
        "time, not preview time",
    );
  }
  const cfg: ControlPlaneIngressConfig = {
    provider: provider as ControlPlaneIngressProvider,
    accountId: (e["accountId"] as string) ?? "",
    zoneId: (e["zoneId"] as string) ?? "",
    zoneName: (e["zoneName"] as string) ?? "",
    teamName: (e["teamName"] as string) ?? "",
    sessionDuration: (e["sessionDuration"] as string) || defaults.sessionDuration,
    accessGroups,
    access: {
      emailDomain: (access["emailDomain"] as string) ?? "",
      serviceTokenIds,
      groups,
      googleClientId,
      googleClientSecret,
    },
    hostnames: {
      hermes: (hostnames["hermes"] as string) ?? defaults.hostnames.hermes,
      nexus: (hostnames["nexus"] as string) ?? defaults.hostnames.nexus,
      grafana: (hostnames["grafana"] as string) ?? defaults.hostnames.grafana,
      argocd: (hostnames["argocd"] as string) ?? defaults.hostnames.argocd,
      prometheus: (hostnames["prometheus"] as string) ?? defaults.hostnames.prometheus,
    },
    services: {
      hermes: (services["hermes"] as string) ?? defaults.services.hermes,
      nexus: (services["nexus"] as string) ?? defaults.services.nexus,
      grafana: (services["grafana"] as string) ?? defaults.services.grafana,
      argocd: (services["argocd"] as string) ?? defaults.services.argocd,
      prometheus: (services["prometheus"] as string) ?? defaults.services.prometheus,
      traefik: (services["traefik"] as string) ?? defaults.services.traefik,
    },
    agentSubdomains: Boolean(e["agentSubdomains"] ?? defaults.agentSubdomains),
    agentHostHeaderDomain:
      (e["agentHostHeaderDomain"] as string) || defaults.agentHostHeaderDomain,
    workloadEndpoints,
    webhookEndpoints,
  };
  if (cfg.provider === "cloudflare") {
    for (const [key, value] of [
      ["accountId", cfg.accountId],
      ["zoneId", cfg.zoneId],
      ["zoneName", cfg.zoneName],
      ["teamName", cfg.teamName],
    ] as const) {
      if (!value) {
        throw new ConfigError(
          `${where}.${key} is required when controlPlaneIngress.provider is "cloudflare"`,
        );
      }
    }
    if (
      !cfg.access.emailDomain &&
      cfg.access.serviceTokenIds.length === 0 &&
      Object.keys(cfg.access.groups).length === 0
    ) {
      throw new ConfigError(
        `${where}.access needs emailDomain, serviceTokenIds and/or groups when ` +
          'provider is "cloudflare" - an Access policy with no include rule ' +
          "locks everyone out (per-hostname coverage is checked at preview too)",
      );
    }
    if (cfg.hostnames.hermes && !cfg.services.hermes) {
      throw new ConfigError(
        `${where}.services.hermes is required when hostnames.hermes is set - ` +
          "in this platform Hermes runs host-side, so there is no safe in-cluster default",
      );
    }
  }
  return cfg;
}

/** Resolve the full published-hostname list (control-plane services +
 * one subdomain per agent) from validated config. Pure — the
 * cloudflare-ingress component turns each entry into an Access app +
 * policy + DNS record + tunnel ingress rule. */
export function controlPlaneHostnames(
  cpi: ControlPlaneIngressConfig,
  agents: AgentSpec[],
): PublishedHostname[] {
  const out: PublishedHostname[] = [];
  const hasFallback =
    Boolean(cpi.access.emailDomain) || cpi.access.serviceTokenIds.length > 0;
  // Groups for a target, with the lockout guard: a hostname whose policy
  // would end up with zero include rules fails here, at preview.
  const resolveGroups = (target: string, fallbackTarget: string | null): string[] => {
    const assigned =
      cpi.access.groups[target] ??
      (fallbackTarget !== null ? cpi.access.groups[fallbackTarget] : undefined) ??
      [];
    if (assigned.length === 0 && !hasFallback) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:controlPlaneIngress: target ${JSON.stringify(target)} ` +
          "has no access.groups assignment and no flat emailDomain/serviceTokenIds " +
          "fallback - its Access policy would have zero include rules (everyone " +
          "locked out); assign a group or set the fallback",
      );
    }
    return assigned;
  };
  const services: Array<[string, string, string]> = [
    ["grafana", cpi.hostnames.grafana, cpi.services.grafana],
    ["argocd", cpi.hostnames.argocd, cpi.services.argocd],
    ["prometheus", cpi.hostnames.prometheus, cpi.services.prometheus],
    ["hermes", cpi.hostnames.hermes, cpi.services.hermes],
    ["nexus", cpi.hostnames.nexus, cpi.services.nexus],
  ];
  for (const [key, label, service] of services) {
    if (!label) continue;
    out.push({
      key,
      host: `${label}.${cpi.zoneName}`,
      service,
      hostHeader: null,
      noTlsVerify: service.startsWith("https://"),
      groups: resolveGroups(key, null),
      noAccess: false,
    });
  }
  if (cpi.agentSubdomains) {
    agents.forEach((agent, i) => {
      if (agent.name === null) {
        // The subdomain is derived from the agent's name, which for a
        // null name only exists after the distribution is fetched — too
        // late for a declarative DNS/Access graph. Loud beats a silently
        // missing subdomain.
        throw new ConfigError(
          `hermes-gitops-bootstrap:agents[${i}].name is required when ` +
            "controlPlaneIngress.agentSubdomains is on (the per-agent " +
            "subdomain is derived from it) - set agents[" +
            i +
            "].name or turn agentSubdomains off",
        );
      }
      out.push({
        key: `agent-${agent.name}`,
        host: `${agent.name}.${cpi.zoneName}`,
        service: cpi.services.traefik,
        hostHeader: `${agent.name}.${cpi.agentHostHeaderDomain}`,
        noTlsVerify: false,
        // Per-agent assignment wins over the all-agents default.
        groups: resolveGroups(`agent:${agent.name}`, "agents"),
        noAccess: false,
      });
    });
  }
  // Workload endpoints (ADR-40), after the agents and sorted by key for
  // a deterministic list. No resolveGroups: workload targets have no
  // fallback by design — parse already guaranteed a non-empty group list.
  const declaredAgents = new Set(
    agents.map((a) => a.name).filter((n): n is string => n !== null),
  );
  for (const k of Object.keys(cpi.workloadEndpoints).sort()) {
    const agentName = k.split("/")[0]!;
    if (!declaredAgents.has(agentName)) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:controlPlaneIngress.workloadEndpoints.${k} names ` +
          "an agent that is not in agents[] - fix the name or remove the endpoint",
      );
    }
    const spec = cpi.workloadEndpoints[k]!;
    out.push({
      key: `workload-${k.replace("/", "-")}`,
      host: spec.hostname,
      service: spec.origin,
      hostHeader: null,
      noTlsVerify: spec.noTlsVerify,
      // Parse guaranteed a non-empty list (workload targets have no fallback).
      groups: cpi.access.groups[`workload:${k}`] ?? [],
      noAccess: false,
    });
  }
  // No-Access webhook endpoints (ADR 0174), sorted for determinism. These
  // publish with NO Access app: signature is the auth. groups stays empty.
  for (const k of Object.keys(cpi.webhookEndpoints).sort()) {
    const spec = cpi.webhookEndpoints[k]!;
    out.push({
      key: `webhook-${k}`,
      host: spec.hostname,
      service: spec.origin,
      hostHeader: null,
      noTlsVerify: false,
      groups: [],
      noAccess: true,
    });
  }
  // Typo protection: an agent:<name> assignment naming an agent that is
  // not in agents[] (or whose subdomain is off) would silently gate
  // nothing. When agentSubdomains is off, control-plane targets are the
  // only valid ones — same rule catches stale agent:* keys then too.
  const agentNames = new Set(
    cpi.agentSubdomains ? agents.map((a) => a.name).filter((n): n is string => n !== null) : [],
  );
  for (const target of Object.keys(cpi.access.groups)) {
    if (target.startsWith("agent:") && !agentNames.has(target.slice("agent:".length))) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:controlPlaneIngress.access.groups.${target} names ` +
          "an agent with no published subdomain (not in agents[], or " +
          "agentSubdomains is off) - fix the name or remove the assignment",
      );
    }
  }
  // A repeated hostname would collapse two targets into one edge entry
  // (last DNS record wins, first ingress rule wins); a repeated key would
  // collide Pulumi resource names (e.g. workloads "a-b/c" and "a/b-c").
  const seenHosts = new Set<string>();
  const seenKeys = new Set<string>();
  for (const entry of out) {
    if (seenHosts.has(entry.host)) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:controlPlaneIngress: hostname ` +
          `${JSON.stringify(entry.host)} is published by more than one target - ` +
          "every published target needs its own hostname",
      );
    }
    if (seenKeys.has(entry.key)) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:controlPlaneIngress: two targets resolve to the ` +
          `same resource key ${JSON.stringify(entry.key)} - rename one so ` +
          "Pulumi resource names stay unique",
      );
    }
    seenHosts.add(entry.host);
    seenKeys.add(entry.key);
  }
  return out;
}

// statusNamespace/kubeContext joined the DECLARED surface with #674 -
// they existed only in the host-side reconcile/config.json before
// (hand-set on factory 2026-08-05), which meant two live-behavior
// fields no environment spec could state.
const RECONCILE_KEYS = ["enabled", "version", "repoUrl", "branch", "intervalSeconds", "checks", "apply", "statusNamespace", "kubeContext", "instances"];

/** Parse + validate the `reconcile` stack key. Pure — unit-tested in
 * config.test.ts. */
export function parseReconcile(raw: unknown): ReconcileStackConfig {
  const where = "hermes-gitops-bootstrap:reconcile";
  const defaults: ReconcileStackConfig = {
    enabled: false,
    version: "unpinned",
    repoUrl: "",
    branch: "main",
    intervalSeconds: 60,
    checks: [],
    apply: "",
  };
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  const e = raw as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!RECONCILE_KEYS.includes(key)) {
      throw new ConfigError(
        `${where}.${key} is not a recognized key (allowed: ${RECONCILE_KEYS.join(", ")})`,
      );
    }
  }
  const out: ReconcileStackConfig = {
    enabled: e["enabled"] === true,
    version: typeof e["version"] === "string" && e["version"] !== "" ? e["version"] : defaults.version,
    repoUrl: typeof e["repoUrl"] === "string" ? e["repoUrl"] : defaults.repoUrl,
    branch: typeof e["branch"] === "string" && e["branch"] !== "" ? e["branch"] : defaults.branch,
    intervalSeconds:
      typeof e["intervalSeconds"] === "number" && e["intervalSeconds"] >= 10
        ? e["intervalSeconds"]
        : defaults.intervalSeconds,
    checks: Array.isArray(e["checks"]) ? e["checks"].map(String) : defaults.checks,
    apply: typeof e["apply"] === "string" ? e["apply"] : defaults.apply,
  };
  if (typeof e["statusNamespace"] === "string" && e["statusNamespace"] !== "") {
    out.statusNamespace = e["statusNamespace"];
  }
  if (typeof e["kubeContext"] === "string" && e["kubeContext"] !== "") {
    out.kubeContext = e["kubeContext"];
  }
  if (out.enabled && !out.repoUrl) {
    throw new ConfigError(
      `${where}.repoUrl is required when reconcile.enabled is true - the timer needs a repository to watch`,
    );
  }
  if (e["instances"] !== undefined) {
    const instances = e["instances"];
    if (!instances || typeof instances !== "object" || Array.isArray(instances)) {
      throw new ConfigError(`${where}.instances must be a mapping of names to watcher configurations`);
    }
    out.instances = {};
    for (const [name, value] of Object.entries(instances)) {
      if (!/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name)) {
        throw new ConfigError(`${where}.instances has an invalid name: ${name}`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value) || "instances" in value) {
        throw new ConfigError(`${where}.instances.${name} must be a watcher mapping without nested instances`);
      }
      out.instances[name] = parseReconcile(value);
    }
  }
  return out;
}

/** What a DEPLOYED Nexus is allowed to do (ADR-84, #403/#409).
 *
 * Stack config rather than a chart default, because a Pulumi-managed
 * Nexus cannot be reached by `hg nexus set`: `hg up` stands down when the
 * release is owned by the bootstrap (ADR-53), so a value hard-coded here
 * would be unconfigurable for exactly the environments that most need to
 * withhold something.
 *
 * The defaults are the PRODUCTION posture, so an operator who sets
 * nothing gets the safe answer: destructive reset off, every launch view
 * served. */
export interface NexusCapabilitiesConfig {
  workspaceReset: boolean;
  views: Record<string, boolean>;
}

const NEXUS_CAPABILITY_KEYS = ["workspaceReset", "views"];
/** Only these views may be withheld - the same closed set the backend
 * enforces (plugin_api.GATEABLE_VIEWS). Fleet Canvas is the product and
 * has no flag. */
const NEXUS_GATEABLE_VIEWS = ["system", "communication", "agents", "backups"];

export function parseNexusCapabilities(raw: unknown): NexusCapabilitiesConfig {
  const where = "hermes-gitops-bootstrap:nexusCapabilities";
  const defaults: NexusCapabilitiesConfig = {
    workspaceReset: false,
    views: Object.fromEntries(NEXUS_GATEABLE_VIEWS.map((v) => [v, true])),
  };
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  const e = raw as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!NEXUS_CAPABILITY_KEYS.includes(key)) {
      throw new ConfigError(
        `${where}.${key} is not a recognized key (allowed: ${NEXUS_CAPABILITY_KEYS.join(", ")})`,
      );
    }
  }
  const out: NexusCapabilitiesConfig = { ...defaults, views: { ...defaults.views } };
  if ("workspaceReset" in e) {
    // A string "true" is the commonest way to write this in stack config
    // and would resolve to `false` at the backend (it demands a real
    // boolean), so it is refused HERE rather than silently ignored three
    // layers later.
    if (typeof e.workspaceReset !== "boolean") {
      throw new ConfigError(`${where}.workspaceReset must be a boolean (got ${typeof e.workspaceReset})`);
    }
    out.workspaceReset = e.workspaceReset;
  }
  if ("views" in e) {
    const v = e.views;
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new ConfigError(`${where}.views must be a mapping`);
    }
    for (const [name, value] of Object.entries(v as Record<string, unknown>)) {
      if (!NEXUS_GATEABLE_VIEWS.includes(name)) {
        throw new ConfigError(
          `${where}.views.${name} is not a gateable view (allowed: ${NEXUS_GATEABLE_VIEWS.join(", ")})`,
        );
      }
      if (typeof value !== "boolean") {
        throw new ConfigError(`${where}.views.${name} must be a boolean (got ${typeof value})`);
      }
      out.views[name] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slack workspace provisioning (the SlackWorkspace component): app-per-agent
// Slack apps created through the OFFICIAL Slack CLI (whose one-time
// `slack login` handshake replaces any app-config-token machinery), plus
// declaratively managed channels + membership via @pulumi/slack.
// Credentials the pods need (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET) do NOT
// live here — they ride the ordinary agentSecrets channel, copied once by
// the operator from each app's settings page (the CLI installs the app,
// so there is no install click; only the copy remains manual).

const SLACK_KEYS = [
  "enabled",
  "teamId",
  "adminUserToken",
  "eventsReady",
  "deleteAppsOnDestroy",
  "cliBin",
  "apps",
  "channels",
];
const SLACK_APP_KEYS = [
  "previousName",
  "displayName",
  "description",
  "botScopes",
  "botEvents",
  "eventsUrl",
  "appId",
];
const SLACK_CHANNEL_KEYS = ["name", "channelId", "topic", "private", "agents", "users"];

export interface SlackAppSpec {
  // Preserve a managed app's provisioning state when its agent is renamed.
  previousName?: string;
  // The Slack app's display name ("Eve Manager") and bot handle are
  // derived: handle = the app key with "marketing-"/"-eve" trimmed is NOT
  // attempted — the manifest uses displayName and a kebab of it.
  displayName: string;
  description: string;
  botScopes: string[];
  // Events the app subscribes to. Only rendered into the manifest when
  // slack.eventsReady is true (Slack challenges the request_url at
  // manifest apply, so events wait for a live endpoint).
  botEvents: string[];
  // This app's full Events request URL, e.g.
  // https://slack-manager.example.dev/eve/v1/slack. One hostname per
  // app: eve mounts /eve/v1/slack at the same path on every agent, so the
  // apps cannot share a hostname. Should match a controlPlaneIngress
  // webhookEndpoints hostname (cross-checked when eventsReady).
  eventsUrl: string;
  // Adopt an existing app instead of creating one (recovery after state
  // loss, or a hand-made app). "" = create through the CLI.
  appId: string;
}

export interface SlackChannelSpec {
  name: string;
  // The existing channel's id (C…). When set, each referenced bot JOINS
  // the channel itself (conversations.join, needs the channels:join
  // scope, public channels only) — no admin user token involved. When
  // unset, the channel is created/adopted via @pulumi/slack, which needs
  // slack.adminUserToken.
  channelId: string;
  topic: string;
  isPrivate: boolean;
  // Agent instance names (keys of slack.apps) whose bots join the channel.
  agents: string[];
  // Human members by Slack user id (U…). Deliberately ids, not emails.
  users: string[];
}

export interface SlackConfig {
  enabled: boolean;
  // The workspace (team) id, e.g. T0123456789. Every CLI call pins it and
  // the bot-identity probe refuses an answer for any other team.
  teamId: string;
  // xoxp user token for the @pulumi/slack provider (channel create/adopt +
  // invites: a bot cannot invite itself, and unarchive-on-adopt is
  // user-token-only). Plain string here (decrypted structured config);
  // re-wrapped pulumi.secret() at the point of use. "" = unset.
  adminUserToken: string;
  // Gate for rendering event subscriptions + request_url into manifests.
  eventsReady: boolean;
  deleteAppsOnDestroy: boolean;
  // The Slack CLI binary ("slack" on PATH by default).
  cliBin: string;
  apps: Record<string, SlackAppSpec>;
  channels: SlackChannelSpec[];
}

const SLACK_TEAM_RE = /^T[A-Z0-9]{5,20}$/;
const SLACK_USER_RE = /^U[A-Z0-9]{5,20}$/;
const SLACK_APP_ID_RE = /^A[A-Z0-9]{5,20}$/;
const SLACK_CHANNEL_ID_RE = /^C[A-Z0-9]{5,20}$/;
const SLACK_CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export function parseSlack(raw: unknown): SlackConfig {
  const where = "hermes-gitops-bootstrap:slack";
  const defaults: SlackConfig = {
    enabled: false,
    teamId: "",
    adminUserToken: "",
    eventsReady: false,
    deleteAppsOnDestroy: false,
    cliBin: "slack",
    apps: {},
    channels: [],
  };
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be a mapping`);
  }
  const e = raw as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!SLACK_KEYS.includes(key)) {
      throw new ConfigError(
        `${where}.${key} is not a recognized key (allowed: ${SLACK_KEYS.join(", ")})`,
      );
    }
  }
  const out: SlackConfig = { ...defaults, apps: {}, channels: [] };
  if ("enabled" in e) {
    if (typeof e.enabled !== "boolean") {
      throw new ConfigError(`${where}.enabled must be a boolean (got ${typeof e.enabled})`);
    }
    out.enabled = e.enabled;
  }
  for (const k of ["teamId", "adminUserToken", "cliBin"] as const) {
    if (k in e) {
      if (typeof e[k] !== "string") {
        throw new ConfigError(`${where}.${k} must be a string`);
      }
      out[k] = e[k] as string;
    }
  }
  for (const k of ["eventsReady", "deleteAppsOnDestroy"] as const) {
    if (k in e) {
      if (typeof e[k] !== "boolean") {
        throw new ConfigError(`${where}.${k} must be a boolean (got ${typeof e[k]})`);
      }
      out[k] = e[k] as boolean;
    }
  }
  if (out.teamId !== "" && !SLACK_TEAM_RE.test(out.teamId)) {
    throw new ConfigError(
      `${where}.teamId ${JSON.stringify(out.teamId)} is not a Slack team id (T…). ` +
        "Careful: a similarly named workspace with a different id is a " +
        "different workspace.",
    );
  }
  if ("apps" in e) {
    const apps = e.apps;
    if (typeof apps !== "object" || apps === null || Array.isArray(apps)) {
      throw new ConfigError(`${where}.apps must be a mapping of instance name -> app spec`);
    }
    const previousNames = new Set<string>();
    for (const [name, rawApp] of Object.entries(apps as Record<string, unknown>)) {
      if (typeof rawApp !== "object" || rawApp === null || Array.isArray(rawApp)) {
        throw new ConfigError(`${where}.apps.${name} must be a mapping`);
      }
      const a = rawApp as Record<string, unknown>;
      for (const key of Object.keys(a)) {
        if (!SLACK_APP_KEYS.includes(key)) {
          throw new ConfigError(
            `${where}.apps.${name}.${key} is not a recognized key ` +
              `(allowed: ${SLACK_APP_KEYS.join(", ")})`,
          );
        }
      }
      const displayName = a.displayName;
      if (typeof displayName !== "string" || displayName === "") {
        throw new ConfigError(`${where}.apps.${name}.displayName is required`);
      }
      const strList = (key: "botScopes" | "botEvents"): string[] => {
        if (!(key in a)) return [];
        const v = a[key];
        if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s === "")) {
          throw new ConfigError(`${where}.apps.${name}.${key} must be a list of strings`);
        }
        return v as string[];
      };
      const appId = typeof a.appId === "string" ? a.appId : "";
      if (appId !== "" && !SLACK_APP_ID_RE.test(appId)) {
        throw new ConfigError(`${where}.apps.${name}.appId must be a Slack app id (A…)`);
      }
      const scopes = strList("botScopes");
      if (a.previousName !== undefined && (typeof a.previousName !== "string" ||
        !/^[a-z0-9][a-z0-9-]*$/.test(a.previousName) || a.previousName in (apps as object))) {
        throw new ConfigError(`${where}.apps.${name}.previousName must name a retired agent, not an active app`);
      }
      if (typeof a.previousName === "string") {
        if (previousNames.has(a.previousName)) {
          throw new ConfigError(`${where}.apps.${name}.previousName is already claimed by another app`);
        }
        previousNames.add(a.previousName);
      }
      if (scopes.length === 0) {
        throw new ConfigError(
          `${where}.apps.${name}.botScopes must name at least one bot scope ` +
            "(an app with no scopes cannot act at all)",
        );
      }
      out.apps[name] = {
        ...(a.previousName ? { previousName: a.previousName as string } : {}),
        displayName,
        description: typeof a.description === "string" ? a.description : "",
        botScopes: scopes,
        botEvents: strList("botEvents"),
        eventsUrl: typeof a.eventsUrl === "string" ? a.eventsUrl : "",
        appId,
      };
    }
  }
  if ("channels" in e) {
    if (!Array.isArray(e.channels)) {
      throw new ConfigError(`${where}.channels must be a list`);
    }
    e.channels.forEach((rawCh, i) => {
      const at = `${where}.channels[${i}]`;
      if (typeof rawCh !== "object" || rawCh === null || Array.isArray(rawCh)) {
        throw new ConfigError(`${at} must be a mapping`);
      }
      const c = rawCh as Record<string, unknown>;
      for (const key of Object.keys(c)) {
        if (!SLACK_CHANNEL_KEYS.includes(key)) {
          throw new ConfigError(
            `${at}.${key} is not a recognized key (allowed: ${SLACK_CHANNEL_KEYS.join(", ")})`,
          );
        }
      }
      const name = c.name;
      if (typeof name !== "string" || !SLACK_CHANNEL_NAME_RE.test(name)) {
        throw new ConfigError(
          `${at}.name must be a Slack channel name (lowercase, no #, got ${JSON.stringify(c.name)})`,
        );
      }
      const ids = (key: "agents" | "users"): string[] => {
        if (!(key in c)) return [];
        const v = c[key];
        if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s === "")) {
          throw new ConfigError(`${at}.${key} must be a list of strings`);
        }
        return v as string[];
      };
      const users = ids("users");
      for (const u of users) {
        if (!SLACK_USER_RE.test(u)) {
          throw new ConfigError(
            `${at}.users entry ${JSON.stringify(u)} is not a Slack user id (U…) - ` +
              "ids, not emails or handles",
          );
        }
      }
      const channelId = typeof c.channelId === "string" ? c.channelId : "";
      if (channelId !== "" && !SLACK_CHANNEL_ID_RE.test(channelId)) {
        throw new ConfigError(`${at}.channelId must be a Slack channel id (C…)`);
      }
      out.channels.push({
        name,
        channelId,
        topic: typeof c.topic === "string" ? c.topic : "",
        isPrivate: c.private === true,
        agents: ids("agents"),
        users,
      });
    });
    const seen = new Set<string>();
    for (const ch of out.channels) {
      if (seen.has(ch.name)) {
        throw new ConfigError(`${where}.channels declares ${ch.name} twice`);
      }
      seen.add(ch.name);
    }
  }
  // Cross-references inside the block (app-to-agent references need the
  // full config and live in validatePrerequisites).
  for (const ch of out.channels) {
    for (const agent of ch.agents) {
      if (!(agent in out.apps)) {
        throw new ConfigError(
          `${where}.channels: ${ch.name} names agent ${JSON.stringify(agent)} ` +
            `but slack.apps declares no app for it (declared: ${
              Object.keys(out.apps).sort().join(", ") || "none"
            })`,
        );
      }
    }
  }
  return out;
}

/** Preview-time prerequisite validation (issue #37 [K5], UX_TARGET
 * point 3): config shapes that guarantee a later failure fail HERE, at
 * graph construction — i.e. already in `pulumi preview`, before anything
 * mutates. Pure — unit-tested in tests/config.test.ts. */
// The K7 developer-packaging contract (issue #52, UX_TARGET section 5):
// a repo's beside-manifest hermes-gitops.yaml carries exactly the extension blocks
// (schemas/hermes-gitops-extension/v1alpha1). For LOCAL-directory agent
// sources this validates at graph construction, i.e. already in
// `pulumi preview` - a broken contract never reaches the cluster. Remote
// git sources are validated by the emitter at `pulumi up` time instead
// (load_extension_file fails the install naming the key; fetching every
// remote repo at preview would make preview network-bound). Value shapes
// beyond the checks here fail downstream where they already fail loudly:
// render.validate() against the profile schema, resolve_apps against the
// apps contract, and _check_required_secrets for undeclared secrets (K5).
export const EXTENSION_KEYS = [
  "apps",
  "backup",
  "deployment",
  "expose",
  "gitAuthSecretRef",
];
// Contract v2 (ADR-33): a file carrying `contractVersion` is validated
// against the v2 key set instead. Only a shallow key check here, exactly
// like v1 - the emitter's jsonschema validation against the vendored
// v1alpha2 schema owns value shapes. Exported (with EXTENSION_KEYS and
// APP_ENTRY_KEYS_V2) for the mirror-guard test that pins these hand
// lists to the schema files' property keys.
export const EXTENSION_KEYS_V2 = [
  ...EXTENSION_KEYS,
  "contractVersion",
  "endpoints",
  "requires",
  "topology",
];
export const APP_ENTRY_KEYS_V2 = [...APP_ENTRY_KEYS, "endpoints", "topology"];

export function validateHermesExtensionFile(
  sourceDir: string,
  where: string,
  subdir = "",
): void {
  // The agent-team layout (ADR 0178): agents/<harness>/<name>/src is the
  // payload and the declaration is ../harness-hg/agent.yaml. The full
  // schema check is the CLI's (hg validate); here the two facts the
  // bootstrap itself depends on are pinned - the file is a mapping of the
  // agent-team contract, and its harness equals the path segment.
  const segments = (subdir || "").split("/").filter(Boolean);
  if (segments.length >= 3 && segments[segments.length - 1] === "src") {
    const agentFile = path.join(sourceDir, ...segments.slice(0, -1), "harness-hg", "agent.yaml");
    if (fs.existsSync(agentFile)) {
      let doc: unknown;
      try {
        doc = parseYaml(fs.readFileSync(agentFile, "utf8"));
      } catch (err) {
        throw new ConfigError(`${where}: ${agentFile} is not valid YAML (${(err as Error).message})`);
      }
      const m = (doc ?? {}) as Record<string, unknown>;
      if (m["apiVersion"] !== "hermes-gitops.factorylevel.dev/agent-team/v1alpha1" || m["kind"] !== "Agent") {
        throw new ConfigError(
          `${where}: ${agentFile} must carry apiVersion hermes-gitops.factorylevel.dev/agent-team/v1alpha1 and kind Agent`,
        );
      }
      const harness = segments[segments.length - 3];
      if (m["harness"] !== harness) {
        throw new ConfigError(
          `${where}: ${agentFile} declares harness ${JSON.stringify(m["harness"])} but the subdir is under agents/${harness}/ - the path and the declaration must agree`,
        );
      }
      return;
    }
  }
  // The extension sits BESIDE distribution.yaml at the dist root: the
  // repo root for root-layout sources, <subdir>/ for subdir-layout ones.
  const filePath = path.join(sourceDir, subdir || ".", "hermes-gitops.yaml");
  if (!fs.existsSync(filePath)) return;
  let doc: unknown;
  try {
    doc = parseYaml(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new ConfigError(
      `${where}: ${filePath} is not valid YAML (${(err as Error).message})`,
    );
  }
  if (doc === null || doc === undefined) return; // an empty extension is valid
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ConfigError(
      `${where}: ${filePath} must be a mapping of extension blocks ` +
        `(allowed: ${EXTENSION_KEYS.join(", ")})`,
    );
  }
  const mapping = doc as Record<string, unknown>;
  // Removed keys first, with a migration hint each (the helm-apps
  // contract's breaking removals), then the generic unknown-key failure.
  for (const key of Object.keys(mapping)) {
    const removed = REMOVED_KEYS[key];
    if (removed !== undefined) {
      throw new ConfigError(`${where}: ${filePath} key \`${key}\` was removed: ${removed}`);
    }
  }
  const isV2 = "contractVersion" in mapping;
  if (isV2 && mapping["contractVersion"] !== 2) {
    throw new ConfigError(
      `${where}: ${filePath} contractVersion must be exactly 2 ` +
        "(v1 files carry no marker at all)",
    );
  }
  const allowedKeys = isV2 ? EXTENSION_KEYS_V2 : EXTENSION_KEYS;
  const unknown = Object.keys(mapping).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${where}: ${filePath} has unknown key(s) ${unknown.sort().join(", ")} ` +
        `(allowed: ${allowedKeys.join(", ")}) - unknown keys would be ` +
        "silently dropped from the rendered record, so packaging fails at preview instead",
    );
  }
  const apps = mapping["apps"];
  if (apps !== undefined) {
    validateApps(apps, `${where}: ${filePath} apps`, false, isV2 ? APP_ENTRY_KEYS_V2 : APP_ENTRY_KEYS);
  }
  const deployment = mapping["deployment"];
  if (deployment !== undefined) {
    if (typeof deployment !== "object" || deployment === null || Array.isArray(deployment)) {
      throw new ConfigError(`${where}: ${filePath} deployment must be a mapping`);
    }
    checkExtensionKeys(deployment as Record<string, unknown>, DEPLOYMENT_KEYS, `${where}: ${filePath} deployment`);
  }
}

function checkExtensionKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const removed = REMOVED_DEPLOYMENT_KEYS[key];
      if (removed !== undefined) {
        throw new ConfigError(`${label}.${key} was removed: ${removed}`);
      }
      throw new ConfigError(
        `${label}.${key} is not a recognized key (allowed: ${allowed.join(", ")})`,
      );
    }
  }
}

export function validatePrerequisites(cfg: BootstrapConfig): void {
  // Installing agents against a real GitOps repo needs the push
  // credential: without it every `hermes profile install` is guaranteed
  // to fail its publish step mid-apply.
  if (
    cfg.stages.agents &&
    cfg.agents.length > 0 &&
    !gitopsRepoIsPlaceholder(cfg.gitopsRepoUrl) &&
    cfg.gitopsGitToken === null
  ) {
    throw new ConfigError(
      "hermes-gitops-bootstrap:gitopsGitToken is required when agents are " +
        "configured against a real gitopsRepoUrl (the plugin pushes each " +
        "profile record with it) - set it with: pulumi config set --secret " +
        "hermes-gitops-bootstrap:gitopsGitToken <token>",
    );
  }
  // Stage 1 needs the fork source; checked here (not only in the
  // hermes-install component) so the failure names the key at preview
  // even when other config errors would surface first.
  if (cfg.stages.hermes && !cfg.hermesInstall.source) {
    throw new ConfigError(
      "hermes-gitops-bootstrap:hermes.source is required when stages.hermes " +
        "is true (local path or git URL of the hermes-agent-gitops fork)",
    );
  }
  // Control-plane ingress: enabling cloudflare without its API token
  // guarantees every cloudflare.* resource fails at apply — fail at
  // preview instead, naming the key. The hostname derivation also runs
  // here so a null agents[].name fails at preview, not mid-apply.
  if (cfg.controlPlaneIngress.provider === "cloudflare") {
    if (cfg.stages.cluster && cfg.cloudflareApiToken === null) {
      throw new ConfigError(
        "hermes-gitops-bootstrap:cloudflareApiToken is required when " +
          'controlPlaneIngress.provider is "cloudflare" - set it with: ' +
          "pulumi config set --secret hermes-gitops-bootstrap:cloudflareApiToken <token>",
      );
    }
    controlPlaneHostnames(cfg.controlPlaneIngress, cfg.agents);
  }
  // Slack: shapes that guarantee a later failure. The CLI login itself is
  // a host file, invisible at preview - the script checks it fail-loud at
  // apply; everything checkable from config is checked here.
  if (cfg.slack.enabled) {
    if (!cfg.slack.teamId) {
      throw new ConfigError(
        "hermes-gitops-bootstrap:slack.teamId is required when slack.enabled " +
          "is true (the workspace every CLI call pins)",
      );
    }
    const eveNames = new Set(
      cfg.agents.filter((a) => a.runtime === "eve" && a.name !== null).map((a) => a.name as string),
    );
    for (const app of Object.keys(cfg.slack.apps)) {
      if (!eveNames.has(app)) {
        throw new ConfigError(
          `hermes-gitops-bootstrap:slack.apps.${app} does not match any ` +
            `runtime: eve agents[] entry (declared eve agents: ${
              [...eveNames].sort().join(", ") || "none"
            }) - a Slack app is an agent's chat surface, not a free-floating bot`,
        );
      }
    }
    const managed = cfg.slack.channels.filter((c) => c.channelId === "");
    if (managed.length > 0 && cfg.slack.adminUserToken === "") {
      throw new ConfigError(
        "hermes-gitops-bootstrap:slack.adminUserToken is required when a " +
          `slack.channels entry has no channelId (${managed
            .map((c) => c.name)
            .join(", ")}): creating/adopting a channel and inviting bots ` +
          "need a user token (a bot cannot invite itself). Either set it " +
          "(pulumi config set --secret --path 'slack.adminUserToken' <xoxp>) " +
          "or pin the existing channel's id so the bots join it themselves",
      );
    }
    for (const ch of cfg.slack.channels) {
      if (ch.channelId === "") continue;
      // Self-join path: every referenced bot needs the channels:join
      // scope, and joining is a public-channel operation.
      if (ch.isPrivate) {
        throw new ConfigError(
          `hermes-gitops-bootstrap:slack.channels ${ch.name}: channelId ` +
            "self-join only works for public channels (a bot cannot join a " +
            "private channel; it must be invited) - drop private or drop " +
            "channelId and provide adminUserToken",
        );
      }
      for (const agent of ch.agents) {
        const scopes = cfg.slack.apps[agent]?.botScopes ?? [];
        if (!scopes.includes("channels:join")) {
          throw new ConfigError(
            `hermes-gitops-bootstrap:slack.apps.${agent} is expected to join ` +
              `#${ch.name} itself (channelId is pinned) but its botScopes ` +
              "lack channels:join - the join would fail missing_scope at apply",
          );
        }
      }
    }
    if (cfg.slack.eventsReady) {
      // Every published webhook hostname, for the cross-block check below.
      const webhookHosts = new Set(
        Object.values(cfg.controlPlaneIngress.webhookEndpoints).map((w) => w.hostname),
      );
      for (const [name, app] of Object.entries(cfg.slack.apps)) {
        if (app.botEvents.length === 0) continue;
        // Slack challenges the request_url at manifest apply, so an app
        // with events needs a real https URL the moment eventsReady flips.
        let host: string;
        try {
          const u = new URL(app.eventsUrl);
          if (u.protocol !== "https:") throw new Error("not https");
          host = u.hostname;
        } catch {
          throw new ConfigError(
            `hermes-gitops-bootstrap:slack.apps.${name}.eventsUrl must be an ` +
              "https:// URL when slack.eventsReady is true (Slack challenges the " +
              "request_url at apply) - set it to this app's webhook hostname " +
              "+ /eve/v1/slack, or drop eventsReady until the endpoint is live",
          );
        }
        // The webhook hostname must actually be published, or Slack's
        // challenge hits nothing. Only enforced when the ingress is on.
        if (
          cfg.controlPlaneIngress.provider === "cloudflare" &&
          !webhookHosts.has(host)
        ) {
          throw new ConfigError(
            `hermes-gitops-bootstrap:slack.apps.${name}.eventsUrl points at ${host}, ` +
              "which no controlPlaneIngress.webhookEndpoints entry publishes - " +
              "declare a webhook endpoint for it (no-Access), or Slack's " +
              "url_verification reaches nothing",
          );
        }
      }
    }
    // ADR 0175: a PROVISIONED app's pod credentials come from the
    // provision Command's state-captured outputs. A leftover
    // config-sourced copy would collide at the env Secret with two
    // sources of truth — refuse it by name. Adopted apps (appId pinned)
    // keep the config channel; that is the escape hatch.
    for (const [name, app] of Object.entries(cfg.slack.apps)) {
      if (app.appId !== "") continue;
      const clash = Object.keys(cfg.agentSecrets[name] ?? {}).filter(
        (v) => v === "SLACK_BOT_TOKEN" || v === "SLACK_SIGNING_SECRET",
      );
      if (clash.length > 0) {
        throw new ConfigError(
          `hermes-gitops-bootstrap:agentSecrets.${name} carries ${clash.join(" + ")}, ` +
            `but slack.apps.${name} is provisioned (no appId pin): its Slack ` +
            "credentials live in Pulumi state as provision outputs (ADR 0175). " +
            "Remove the marker(s) from the environment spec and re-run " +
            "`hg env apply`, or pin appId to adopt a hand-managed app instead",
        );
      }
    }
  }
  // K7: local-directory agent sources get their beside-manifest hermes-gitops.yaml
  // extension validated right here at preview.
  cfg.agents.forEach((agent, i) => {
    const asDir = agent.source.replace(/^file:\/\//, "");
    if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
      validateHermesExtensionFile(
        asDir,
        `hermes-gitops-bootstrap:agents[${i}]`,
        agent.subdir,
      );
    }
  });
}

/** Read + validate the full stack config from the Pulumi runtime. */
export function load(): BootstrapConfig {
  const cfg = new pulumi.Config();

  const providers = parseProviders(cfg.requireObject<Record<string, unknown>>("providers"));
  const versions = parseVersions(cfg.getObject<Record<string, unknown>>("versions") ?? {});
  const stages = parseStages(cfg.getObject<Record<string, unknown>>("stages") ?? {});
  const hermesInstall = parseHermesInstall(cfg.getObject<Record<string, unknown>>("hermes") ?? {});
  const agents = parseAgents(cfg.getObject<unknown>("agents"));
  const argocdRepoCreds = parseArgoRepoCreds(
    cfg.getObject<Record<string, unknown>>("argocdRepoCreds") ?? {},
  );

  const targetClusters = parseTargetClusters(cfg.getObject<unknown>("targetClusters"));

  const gitopsGitToken = cfg.getSecret("gitopsGitToken") ?? null;

  const config: BootstrapConfig = {
    clusterProvider: parseClusterProvider(cfg.get("clusterProvider")),
    kubeconfigPath: cfg.get("kubeconfigPath") ?? null,
    kubeconfigContext: cfg.get("kubeconfigContext") ?? null,
    gitopsRepoUrl: cfg.get("gitopsRepoUrl") || "https://example.invalid/replace-me/gitops.git",
    gitopsBranch: cfg.get("gitopsBranch") || DEFAULT_GITOPS_BRANCH,
    gitopsBranchProtection: cfg.getBoolean("gitopsBranchProtection") ?? null,
    gitopsRequiredReviewers: cfg.getNumber("gitopsRequiredReviewers") ?? null,
    hermesGitopsRepoUrl:
      cfg.get("hermesGitopsRepoUrl") || "https://github.com/factory-level/harness-hg.git",
    chartRevision: cfg.get("chartRevision") || DEFAULT_CHART_REVISION,
    providers,
    versions,
    stages,
    argocdRepoCreds,
    targetClusters,
    helmOciRegistries: parseHelmOciRegistries(cfg.getObject<unknown>("helmOciRegistries")),
    agentSecrets: parseAgentSecrets(cfg.getObject<unknown>("agentSecrets")),
    routerSecrets: parseRouterSecrets(cfg.getObject<unknown>("routerSecrets")),
    agentGitAuth: parseAgentGitAuth(cfg.getObject<unknown>("agentGitAuth")),
    pluginConfig: parsePluginConfig(
      cfg.getObject<Record<string, unknown>>("pluginConfig") ?? {},
    ),
    fleetDefaults: parseFleetDefaults(cfg.getObject<unknown>("fleetDefaults")),
    hermesInstall,
    agents,
    controlPlaneIngress: parseControlPlaneIngress(cfg.getObject<unknown>("controlPlaneIngress")),
    nexusCapabilities: parseNexusCapabilities(cfg.getObject<unknown>("nexusCapabilities")),
    slack: parseSlack(cfg.getObject<unknown>("slack")),
    reconcile: parseReconcile(cfg.getObject<unknown>("reconcile")),
    cloudflareApiToken: cfg.getSecret("cloudflareApiToken") ?? null,
    gitopsGitToken,
  };
  validatePrerequisites(config);
  validateEveSecretOwnership(config);
  return config;
}
