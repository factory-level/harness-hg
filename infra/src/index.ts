// Hermes GitOps bootstrap — Pulumi entry point (the top-level bootstrap
// control flow).
//
// Three-stage bootstrap sequence (see repo-root README.md for the full
// picture):
//   1. components/harness/hermes-install — install the Hermes fork CLI + the
//      gitops-emitter plugin, then enable + configure the plugin in the
//      operating profile.
//   2. components/harness/hermes-agent — `hermes profile install` per agent -> the
//      plugin creates/populates the GitOps repo.
//   3. control-flow/control-plane — install the cluster control plane
//      (Argo CD, ESO, a ClusterSecretStore, optionally the Pulumi
//      Kubernetes Operator, and the hermes-gitops-root Application), which
//      then converges on whatever stage 2 pushed to the GitOps repo.
//
// Stages are config-gated (`stages: {hermes, agents, cluster}` in stack
// config, see control-flow/config.ts / Pulumi.local.yaml.example) rather
// than argv-gated, so one `pulumi up` runs all three in order. Stages 1-2
// need no Kubernetes provider at all (they're local.Command resources
// shelling out to `uv`/`hermes`), so they run unconditionally ahead of the
// stages.cluster check below — `pulumi preview` with `stages.cluster:
// false` shows only stage 1-2 resources, which is deliberate (see the
// repo-root README's "Stage gating" section).
//
// Structure (components -> control-flow -> index):
//   components/     leaf ComponentResources (namespaces, argocd, eso,
//                   secret-store, pulumi-operator, root-app,
//                   hermes-install, hermes-agent)
//   control-flow/   workflows composing components (hermes stages 1-2,
//                   control-plane stage 3) + the typed env-config contract
//   index.ts        this file: read env-config -> run the workflows in
//                   dependency order -> export

import * as pulumi from "@pulumi/pulumi";
import { ARGOCD_NS, ESO_NS, HERMES_SECRETS_NS, GitopsScaffold, Reconciler } from "./components/index.ts";
import {
  controlPlaneHostnames,
  gitopsRepoIsPlaceholder,
  load,
  runControlPlane,
  runHermesStages,
} from "./control-flow/index.ts";

const cfg = load();

// Target control flow step 1 (issue #12 [B1]): scaffold the GitOps repo as
// an explicit, agent-independent step. Skipped (like the root Application)
// when the configured repo URL is a placeholder.
let scaffoldResources: pulumi.Resource[] = [];
if (gitopsRepoIsPlaceholder(cfg.gitopsRepoUrl)) {
  pulumi.log.info(
    "gitops-scaffold: gitopsRepoUrl looks like a placeholder - skipping the " +
      "explicit scaffold step (and the hermes-gitops-root Application).",
  );
} else {
  scaffoldResources = [new GitopsScaffold("gitops-scaffold", { config: cfg }).command];
}

const hermesStages = runHermesStages(cfg, scaffoldResources);

// The destination-host reconciler (#271, ADR-54): installed AFTER stage 1
// because hermes-profile-config is what puts GITOPS_GIT_TOKEN into the
// operating profile's .env - a timer polling an authenticated remote
// before its credential exists ticks straight into
// authentication-required.
new Reconciler("reconciler", {
  config: cfg,
  dependsOn: hermesStages.stage1Resources,
});

let controlPlane = {
  clusterSecretStoreName: null as string | null,
  pulumiOperatorDeployed: false,
  rootAppDeployed: false,
  rootAppName: null as string | null,
  controlPlaneHostnames: [] as string[],
  evalPublisher: null as import("./control-flow/control-plane.ts").ControlPlaneResult["evalPublisher"],
};
if (cfg.stages.cluster) {
  controlPlane = runControlPlane(cfg, scaffoldResources);
} else {
  pulumi.log.info("stages.cluster is false - bootstrap stage 3 skipped entirely.");
}

// Stack outputs — same names/shapes as the Python predecessor, so scripts
// and docs referencing `pulumi stack output` keep working unchanged.
export const argocd_namespace = ARGOCD_NS;
export const eso_namespace = ESO_NS;
export const hermes_secrets_namespace = HERMES_SECRETS_NS;
export const argocd_chart_version = cfg.versions.argocdChart;
export const eso_chart_version = cfg.versions.esoChart;
export const cluster_secret_store_name = cfg.stages.cluster
  ? controlPlane.clusterSecretStoreName
  : null;
export const pulumi_operator_deployed = controlPlane.pulumiOperatorDeployed;
export const root_app_deployed = controlPlane.rootAppDeployed;
export const root_app_name = controlPlane.rootAppName;
// Control-plane ingress (spec §25): the public hostnames published
// through the Cloudflare Tunnel — control-plane services + one subdomain
// per agent. Empty list when controlPlaneIngress.provider is "none".
export const control_plane_hostnames = controlPlane.controlPlaneHostnames;
// Edge live verification (`hg edge prove`): {key, host, noAccess} per
// published hostname, unconditionally when the tunnel is on. The key
// encodes the kind ("workload-<agent>-<app>" vs "agent-<name>" vs
// grafana/argocd/hermes vs "webhook-<name>"); noAccess marks the webhook
// hostnames published WITHOUT an Access app (ADR 0174 - the provider's
// request signature is their auth), which the prove must expect to answer
// unauthenticated rather than challenge.
export const edge_targets =
  cfg.controlPlaneIngress.provider === "cloudflare"
    ? controlPlaneHostnames(cfg.controlPlaneIngress, cfg.agents).map(({ key, host, noAccess }) => ({
        key,
        host,
        noAccess,
      }))
    : [];

