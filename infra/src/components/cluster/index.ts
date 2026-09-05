// The cluster module (issue #4 [A2]) — one provisioning strategy per
// clusterProvider value (CONFIG_TARGET step 0), each producing the
// kubeconfig the rest of the run consumes:
//
//   none           reference an existing cluster via the configured
//                  kubeconfig (a thin strategy, not a bypass — the
//                  dispatcher owns every member)
//   k3s-local      drive infra/scripts/dev-cluster.sh (k3d) via local.Command,
//                  so `pulumi up` alone brings the cluster up — the
//                  script stays the single source of truth for the k3d
//                  incantation, and its new `kubeconfig` subcommand
//                  prints a standalone kubeconfig on stdout for capture
//   gke-autopilot  provision a GKE Autopilot cluster via @pulumi/gcp
//   eks-fargate    provision an EKS/Fargate cluster via @pulumi/eks
//
// The cloud SDKs are OPTIONAL peer dependencies (package.json
// peerDependenciesMeta) loaded lazily at dispatch time — a none/k3s-local
// operator never installs @pulumi/gcp / @pulumi/eks, and Pulumi never
// downloads their provider plugins (it discovers plugins by scanning
// node_modules, so merely listing them as regular dependencies would pull
// hundreds of MB for every operator). Selecting gke-autopilot/eks-fargate
// without the matching package installed fails at preview with the exact
// `bun add` command to run.
//
// Ordering: stage-3 resources register against a k8s.Provider whose
// kubeconfig is an Output of the provisioning resource (the k3d Command's
// stdout / the cloud cluster's outputs), so the cluster necessarily
// exists before anything is installed into it; `dependsOn` carries the
// same edge explicitly.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";
import { findRepoRoot } from "../harness/hermes-install/index.ts";
import { ConfigError, type BootstrapConfig } from "../../control-flow/config.ts";

export interface ClusterResult {
  // undefined => ambient kubeconfig (KUBECONFIG env / ~/.kube/config),
  // exactly the `none`-without-kubeconfigPath behavior.
  kubeconfig: pulumi.Input<string> | undefined;
  context: string | undefined;
  dependsOn: pulumi.Resource[];
}

// Default name for provisioned clusters (gke/eks); k3s-local keeps
// dev-cluster.sh's own hardcoded "hermes-gitops-dev".
export const DEFAULT_CLUSTER_NAME = "hermes-gitops";

/** Lazy, resolution-at-runtime require for the optional cloud SDKs. A
 * plain `import` would make tsc demand the package and make Pulumi's
 * plugin discovery download its provider for every operator. */
function requireOptional(pkg: string, provider: string): any {
  const req = createRequire(import.meta.url);
  try {
    return req(pkg);
  } catch {
    throw new ConfigError(
      `clusterProvider = "${provider}" needs the optional ${pkg} SDK - ` +
        `run: cd infra && bun add ${pkg}`,
    );
  }
}

/** The standard exec-plugin kubeconfig for a GKE cluster (the shape the
 * Pulumi GKE guides emit): gke-gcloud-auth-plugin mints the token, so no
 * static credential is embedded. Exported for unit tests. */
export function gkeKubeconfig(name: string, endpoint: string, caData: string): string {
  return `apiVersion: v1
kind: Config
clusters:
- name: ${name}
  cluster:
    certificate-authority-data: ${caData}
    server: https://${endpoint}
contexts:
- name: ${name}
  context:
    cluster: ${name}
    user: ${name}
current-context: ${name}
users:
- name: ${name}
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
      installHint: Install gke-gcloud-auth-plugin for kubectl by following
        https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl
      provideClusterInfo: true
`;
}

function noneStrategy(cfg: BootstrapConfig): ClusterResult {
  const kubeconfig = cfg.kubeconfigPath
    ? fs.readFileSync(cfg.kubeconfigPath, "utf-8")
    : undefined;
  return {
    kubeconfig,
    context: cfg.kubeconfigContext ?? undefined,
    dependsOn: [],
  };
}

function k3sLocalStrategy(): ClusterResult {
  const repoRoot = findRepoRoot();
  if (repoRoot === null) {
    throw new ConfigError(
      'clusterProvider = "k3s-local" drives infra/scripts/dev-cluster.sh, which ' +
        "could not be located above the running program; run from a " +
        "harness-hg checkout or use a different clusterProvider",
    );
  }
  const script = path.join(repoRoot, "infra", "scripts", "dev-cluster.sh");

  // `up` is idempotent (creates or reuses) and logs to stderr;
  // `kubeconfig` prints a standalone kubeconfig document on stdout — so
  // this Command's stdout IS the kubeconfig. `delete` tears the cluster
  // down with the stack.
  const cmd = new local.Command("cluster-k3s-local", {
    create: `bash "${script}" up 1>&2 && bash "${script}" kubeconfig`,
    update: `bash "${script}" up 1>&2 && bash "${script}" kubeconfig`,
    delete: `bash "${script}" down 1>&2`,
  });

  return { kubeconfig: cmd.stdout, context: undefined, dependsOn: [cmd] };
}

function gkeAutopilotStrategy(): ClusterResult {
  const gcp = requireOptional("@pulumi/gcp", "gke-autopilot");
  const gcpCfg = new pulumi.Config("gcp");
  // Standard provider config namespace — `pulumi config set gcp:project`
  // / `gcp:region`, same keys the @pulumi/gcp provider itself reads.
  const project = gcpCfg.require("project");
  const region = gcpCfg.require("region");
  const name = new pulumi.Config().get("clusterName") || DEFAULT_CLUSTER_NAME;

  const cluster = new gcp.container.Cluster("control-plane", {
    name,
    location: region,
    project,
    enableAutopilot: true,
    // Autopilot manages nodes; deletion protection off so `pulumi
    // destroy` can actually tear the cluster down.
    deletionProtection: false,
  });

  const kubeconfig = pulumi
    .all([cluster.name, cluster.endpoint, cluster.masterAuth])
    .apply(([n, endpoint, auth]: [string, string, { clusterCaCertificate: string }]) =>
      gkeKubeconfig(n as string, endpoint as string, auth.clusterCaCertificate),
    );

  return { kubeconfig, context: undefined, dependsOn: [cluster] };
}

function eksFargateStrategy(): ClusterResult {
  const eks = requireOptional("@pulumi/eks", "eks-fargate");
  const name = new pulumi.Config().get("clusterName") || DEFAULT_CLUSTER_NAME;

  // @pulumi/eks is the official component wrapper (VPC/IAM/auth wiring
  // included); fargate: true runs the default + kube-system profiles on
  // Fargate with no managed node group. Region comes from the standard
  // aws:region config the @pulumi/aws provider reads.
  const cluster = new eks.Cluster("control-plane", {
    name,
    fargate: true,
  });

  const kubeconfig = cluster.kubeconfig.apply((k: unknown) =>
    typeof k === "string" ? k : JSON.stringify(k),
  );

  return { kubeconfig, context: undefined, dependsOn: [cluster] };
}

/** Dispatch on clusterProvider and return the kubeconfig (plus dependency
 * edges) the rest of the run targets. */
export function provisionCluster(cfg: BootstrapConfig): ClusterResult {
  switch (cfg.clusterProvider) {
    case "none":
      return noneStrategy(cfg);
    case "k3s-local":
      return k3sLocalStrategy();
    case "gke-autopilot":
      return gkeAutopilotStrategy();
    case "eks-fargate":
      return eksFargateStrategy();
  }
}
