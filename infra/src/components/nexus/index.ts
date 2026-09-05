// Nexus, the operator dashboard, installed and configured by the bootstrap
// (ADR-53).
//
// Why Pulumi installs this rather than Argo CD, which reconciles almost
// everything else here: Nexus's configuration IS stage-3 output. Its
// Argo CD and Grafana link bases are the published Cloudflare hostnames
// that only exist once CloudflareIngress has run, and its git credentials
// come from the same stack secret Argo CD's repo creds do. Delivering it
// through the GitOps repo would mean writing those values into git from a
// later stage and syncing on the next pass - the dependency runs the wrong
// way. ADR-53's Cost records the deviation.
//
// What this fixes: `hg up` installs the same chart with argocdBaseUrl and
// grafanaBaseUrl pointing at HOST PORT-FORWARDS (cli/src/platform.ts:1469).
// That is right on a laptop and wrong everywhere else - an Argo-delivered
// environment served a dashboard whose every deep link was 127.0.0.1. The
// Deployment carries hermes.dev/owner: pulumi so `hg up` can see it is not
// the owner and stand down to port-forwarding only.
//
// The chart lives at <repo>/control-plane/nexus/chart - it is a
// projection of control-plane/nexus kept honest by
// infra/scripts/sync-nexus-chart.sh --check.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import {
  controlPlaneHostnames,
  type BootstrapConfig,
} from "../../control-flow/config.ts";

export const NEXUS_NS = "hermes-nexus";
export const NEXUS_RELEASE = "nexus";
export const NEXUS_GITOPS_AUTH_SECRET = "nexus-gitops-auth";
/** Stamped as `hermes.dev/owner` on the Deployment; `hg up` reads it back. */
export const NEXUS_OWNER = "pulumi";

/** <repo>/control-plane/nexus/chart - four levels up from this file.
 *
 * Derived from import.meta.URL, not import.meta.dir: the tests run under
 * bun (where both exist) but `pulumi up` runs this under NODE, where
 * `import.meta.dir` is undefined and path.resolve then throws
 * ERR_INVALID_ARG_TYPE before a single resource is created. Caught by
 * `make verify-git-side`, which is the only gate that executes the
 * program rather than importing it. */
export const NEXUS_CHART_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../control-plane/nexus/chart",
);

/** The projected payload, in the sync script's order (infra/scripts/
 * sync-nexus-chart.sh). Same list, same order as the chart's own
 * checksum/code annotation - a file missing here is a file whose change
 * would not deploy. */
const PROJECTED_FILES = [
  "plugin_api.py",
  "standalone.py",
  "features.json",
  "inventory.json",
  "panels.json",
];

/** The UI bundles, read straight from control-plane/nexus/dist and
 * provisioned as the `nexus-dist` ConfigMap OUTSIDE the Helm release: a
 * chart file lands in the release Secret twice (file + rendered manifest)
 * and the three bundles put it over the 1MiB cap (#804). #807 dropped
 * index.js from the projection believing nothing in-cluster read it -
 * standalone.js is a shell that imports index.js at runtime, and the
 * deployed Nexus served a blank page until the ConfigMap moved out. */
export const NEXUS_DIST_FILES = ["index.js", "standalone.js", "style.css"];
// A NEW name on purpose: the previous chart release owns a ConfigMap
// called nexus-dist, and Pulumi cannot create an object Helm still owns
// (the release depends on this one, so the collision would deadlock the
// migration). Helm deletes its old nexus-dist on the upgrade that stops
// templating it.
export const NEXUS_DIST_CONFIGMAP = "nexus-ui-dist";
export const NEXUS_DIST_PATH = path.resolve(NEXUS_CHART_PATH, "..", "dist");

export function nexusDistData(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of NEXUS_DIST_FILES) {
    const p = path.join(NEXUS_DIST_PATH, name);
    if (!existsSync(p)) throw new Error(`nexus: control-plane/nexus/dist/${name} is missing - rebuild nexus-ui (bun run build && bun run build:standalone)`);
    out[name] = readFileSync(p, "utf8");
  }
  return out;
}

/** sha256 over the projected files AND the chart's own templates. A
 * missing file hashes as empty rather than throwing: the chart is the
 * thing that must be complete, and helm lint / the golden renders already
 * say so - failing here would break `pulumi preview` on a partial
 * checkout for no gain.
 *
 * Templates are hashed for the same reason the projection is: pulumi's
 * helm.Release diffs on chart VERSION + values, so a template edit with
 * an unchanged version reported "everything unchanged" and the cluster
 * kept the old objects - found live twice (the rebuilt-bundle trap, then
 * the ADR-77 RBAC widening that never reached the ClusterRole). */
export function projectedCodeChecksum(): string {
  const h = createHash("sha256");
  for (const name of PROJECTED_FILES) {
    const p = path.join(NEXUS_CHART_PATH, "files", name);
    h.update(existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  }
  // The bundles roll the pod the same way even though they are no longer
  // chart files: the ConfigMap is a separate resource, and a changed mount
  // alone never restarts the process (found live).
  for (const name of NEXUS_DIST_FILES) {
    const p = path.join(NEXUS_DIST_PATH, name);
    h.update(existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  }
  const templatesDir = path.join(NEXUS_CHART_PATH, "templates");
  const templates = existsSync(templatesDir) ? readdirSync(templatesDir).sort() : [];
  for (const name of templates) {
    h.update(name);
    h.update(readFileSync(path.join(templatesDir, name)));
  }
  for (const name of ["values.yaml", "Chart.yaml"]) {
    const p = path.join(NEXUS_CHART_PATH, name);
    h.update(existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  }
  return h.digest("hex");
}

export interface NexusArgs {
  provider: k8s.Provider;
  config: BootstrapConfig;
}

/** `https://<host>` for a published control-plane hostname, or "" when the
 * hostname is not published. Empty is honest: the UI renders no link
 * rather than a dead one. */
export function publishedBaseUrl(cfg: BootstrapConfig, key: string): string {
  if (cfg.controlPlaneIngress.provider !== "cloudflare") return "";
  const hit = controlPlaneHostnames(cfg.controlPlaneIngress, cfg.agents).find(
    (h) => h.key === key,
  );
  return hit === undefined ? "" : `https://${hit.host}`;
}

export class Nexus extends pulumi.ComponentResource {
  readonly release: k8s.helm.v3.Release;
  readonly namespace: k8s.core.v1.Namespace;

  constructor(name: string, args: NexusArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:Nexus", name, {}, opts);
    const cfg = args.config;

    this.namespace = new k8s.core.v1.Namespace(
      "ns-hermes-nexus",
      { metadata: { name: NEXUS_NS } },
      { parent: this, provider: args.provider },
    );

    // Private-repo credentials. The chart hands these to git through a
    // credential helper, never in the clone URL - a URL-embedded token
    // would persist in .git/config on the repo volume. Anonymous stays
    // possible (the local loop clones the host's git:// daemon), so an
    // absent token is a supported configuration, not an error.
    const dependsOn: pulumi.Resource[] = [this.namespace];
    let gitopsAuthSecretName = "";
    if (cfg.gitopsGitToken !== null) {
      const secret = new k8s.core.v1.Secret(
        NEXUS_GITOPS_AUTH_SECRET,
        {
          metadata: {
            name: NEXUS_GITOPS_AUTH_SECRET,
            namespace: NEXUS_NS,
            labels: { "hermes-gitops.factorylevel.dev/managed": "true" },
          },
          // The username is a placeholder GitHub ignores for token auth;
          // the token is the credential.
          stringData: { username: "hermes-gitops", token: cfg.gitopsGitToken },
        },
        {
          parent: this,
          provider: args.provider,
          dependsOn: [this.namespace],
          additionalSecretOutputs: ["stringData", "data"],
        },
      );
      dependsOn.push(secret);
      gitopsAuthSecretName = NEXUS_GITOPS_AUTH_SECRET;
    }

    // The UI bundles as their own ConfigMap (~800KB, under the object cap),
    // never as chart files - see NEXUS_DIST_FILES.
    const dist = new k8s.core.v1.ConfigMap(
      NEXUS_DIST_CONFIGMAP,
      {
        metadata: {
          name: NEXUS_DIST_CONFIGMAP,
          namespace: NEXUS_NS,
          labels: {
            "hermes-gitops.factorylevel.dev/plane": "control-plane",
            "hermes-gitops.factorylevel.dev/component": "nexus",
            "app.kubernetes.io/name": "nexus",
          },
        },
        data: nexusDistData(),
      },
      { parent: this, provider: args.provider, dependsOn: [this.namespace] },
    );
    dependsOn.push(dist);

    this.release = new k8s.helm.v3.Release(
      NEXUS_RELEASE,
      {
        name: NEXUS_RELEASE,
        chart: NEXUS_CHART_PATH,
        namespace: NEXUS_NS,
        values: {
          // The chart defaults to the published Nexus host image
          // (versions.json "nexus"). An environment that publishes its own
          // image names it here; the legacy pluginConfig image still works
          // because the agent image ships the same runtime.
          ...(cfg.pluginConfig.imageRepository || cfg.pluginConfig.imageTag
            ? {
                image: {
                  ...(cfg.pluginConfig.imageRepository ? { repository: cfg.pluginConfig.imageRepository } : {}),
                  ...(cfg.pluginConfig.imageTag ? { tag: cfg.pluginConfig.imageTag } : {}),
                },
              }
            : {}),
          gitopsUrl: cfg.gitopsRepoUrl,
          gitopsBranch: cfg.gitopsBranch,
          gitopsAuth: { secretName: gitopsAuthSecretName },
          // The whole point of ADR-53: real published URLs, not the
          // CLI's port-forwards.
          argocdBaseUrl: publishedBaseUrl(cfg, "argocd"),
          grafanaBaseUrl: publishedBaseUrl(cfg, "grafana"),
          // The embed-health probe reaches Grafana in-cluster (#556): the
          // published base sits behind the edge's Access gate, which the
          // backend carries no identity for - probing it read "denied"
          // and suppressed every frame for browsers whose own Access
          // session would have carried them. The Service name is the
          // bootstrap's own compatibility contract (monitoring-stack's
          // fullnameOverride, ADR-45). Browser-facing URLs are untouched.
          grafanaProbeBaseUrl: "http://monitoring-grafana.hermes-monitoring.svc",
          // In-cluster: the backend reads the API server through its
          // ServiceAccount token, so no kubeContext applies.
          kubeContext: "",
          // Stamps hermes.dev/owner on the Deployment so `hg up` can see
          // it does not own this release and skip its own install.
          owner: NEXUS_OWNER,
          // Pulumi diffs a Release on its INPUTS - it does not hash a local
          // chart's files. So a rebuilt `control-plane/nexus/dist` projected
          // into charts/nexus/files changed nothing: `pulumi up` reported
          // everything unchanged and the cluster kept serving the previous
          // UI (found live). Hashing the projected payload into a value
          // makes the change visible to the diff; the chart's own
          // checksum/code annotation then rolls the pod.
          codeChecksum: projectedCodeChecksum(),
          // What this DEPLOYMENT is allowed to do (ADR-84), from stack
          // config so it is configurable per environment.
          //
          // It cannot be a chart default here and it must not be
          // hard-coded: `hg up` STANDS DOWN when the bootstrap owns the
          // release (ADR-53), so `hg nexus set` never reaches a
          // Pulumi-managed Nexus. A literal in this file would make
          // capabilities unconfigurable for exactly the environments most
          // likely to withhold something. `parseNexusCapabilities`
          // defaults to the production posture, so an operator who sets
          // nothing still gets reset-off and every launch view served.
          capabilities: cfg.nexusCapabilities,
        },
        // The chart ships a backup PVC on a WaitForFirstConsumer
        // storage class whose first consumer is the nightly backup Job -
        // a helm await on it deadlocks every apply for its full timeout.
        // The bootstrap has no readiness gating by design; nexus is no
        // exception (found live: 300s stall per up).
        skipAwait: true,
      },
      { parent: this, provider: args.provider, dependsOn },
    );

    this.registerOutputs({});
  }
}
