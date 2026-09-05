// Stage 3 workflow: the cluster control plane. Composes the leaf
// components in dependency order (enforced via Pulumi dependsOn, not
// import order): namespaces -> {argocd, eso} -> {secret-store,
// pulumi-operator} -> root-app.

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import {
  ArgoCd,
  Eso,
  Namespaces,
  PulumiOperator,
  RootApp,
  SecretStore,
  AgentSecrets,
  CloudflareIngress,
  Nexus,
  RouterSecrets,
  SlackWorkspace,
  APP_NAME,
  STORE_NAME,
  provisionCluster,
  shouldDeployPko,
  type ClusterResult,
} from "../components/index.ts";
import { gitopsRepoIsPlaceholder, type BootstrapConfig } from "./config.ts";

export interface ControlPlaneResult {
  clusterSecretStoreName: string | null;
  pulumiOperatorDeployed: boolean;
  rootAppDeployed: boolean;
  rootAppName: string | null;
  // Public hostnames published by the control-plane ingress (spec §25):
  // control-plane services + one subdomain per agent. Empty when
  // controlPlaneIngress.provider is "none".
  controlPlaneHostnames: string[];
  // The eval publisher's Access service token (ADR-81): what index.ts
  // exports for HG_CF_ACCESS_CLIENT_ID/_SECRET. null when the ingress is
  // off or nexus is not published.
  evalPublisher: {
    clientId: pulumi.Output<string>;
    clientSecret: pulumi.Output<string>;
  } | null;
}

// Dispatches on clusterProvider (CONFIG_TARGET step 0) via the cluster
// module (issue #4 [A2]): `none` references an existing cluster via the
// configured kubeconfig; the other members PROVISION one and hand back
// its kubeconfig. The provider's kubeconfig being an Output of the
// provisioning resource is what guarantees stage 3 only registers against
// a cluster that exists.
function buildProvider(cfg: BootstrapConfig): { provider: k8s.Provider; cluster: ClusterResult } {
  const cluster = provisionCluster(cfg);
  const args: k8s.ProviderArgs = {};
  if (cluster.kubeconfig !== undefined) {
    args.kubeconfig = cluster.kubeconfig;
  }
  if (cluster.context) {
    args.context = cluster.context;
  }
  const provider = new k8s.Provider("hermes-gitops-k8s", args, { dependsOn: cluster.dependsOn });
  return { provider, cluster };
}

export function runControlPlane(
  cfg: BootstrapConfig,
  // The explicit gitops-scaffold step's resources (issue #12 [B1]) — the
  // hermes-gitops-root Application hard-depends on them, so it only ever
  // references a repo whose bootstrap/ tree is guaranteed present.
  scaffoldResources: pulumi.Resource[] = [],
): ControlPlaneResult {
  const { provider, cluster } = buildProvider(cfg);

  const ns = new Namespaces("namespaces", { provider });

  // Slack workspace provisioning (ADR 0175) — HOISTED above AgentSecrets
  // because its provision Commands are the SOURCE of the twins' SLACK_*
  // pod credentials (secret-marked stdout -> encrypted state -> the env
  // Secret below). Host-side only, needs no k8s provider; the CLI login
  // it depends on is checked fail-loud inside the python.
  const slackWs = cfg.slack.enabled ? new SlackWorkspace("slack-workspace", { config: cfg }) : null;

  // Per-agent env secrets (issue #38 [K6]) — independent of the rest of
  // stage 3 (own namespaces), constructed alongside it so `pulumi up`
  // materializes them in the same run the workloads converge in.
  const agentSecrets = new AgentSecrets("agent-secrets", {
    provider,
    config: cfg,
    kubeconfig: cluster.kubeconfig,
    kubeconfigContext: cluster.context,
    ...(slackWs ? { extraSecrets: slackWs.secrets } : {}),
  });
  // Events attach only after each twin's pod is RUNNING its new signing
  // secret — Slack's url_verification challenge is answered by the pod.
  slackWs?.wireEvents(agentSecrets.rolls);

  const argocd = new ArgoCd("argocd", {
    provider,
    namespaces: ns,
    chartVersion: cfg.versions.argocdChart,
    repoCreds: cfg.argocdRepoCreds,
    gitopsRepoUrl: cfg.gitopsRepoUrl,
    hermesGitopsRepoUrl: cfg.hermesGitopsRepoUrl,
    targetClusters: cfg.targetClusters,
    helmOciRegistries: cfg.helmOciRegistries,
  });

  const eso = new Eso("eso", {
    provider,
    namespaces: ns,
    chartVersion: cfg.versions.esoChart,
  });

  const store = new SecretStore("secret-store", {
    provider,
    namespaces: ns,
    esoRelease: eso.release,
  });

  // Control-plane ingress (spec §25): one Cloudflare Tunnel + Zero Trust
  // Access publishing Grafana/Argo CD (and optionally Hermes) plus one
  // subdomain per agent. Independent of the GitOps repo (its resources
  // live at Cloudflare + a dedicated namespace), so it composes alongside
  // the rest of stage 3 rather than behind root-app.
  let ingressHostnames: string[] = [];
  let evalPublisher: ControlPlaneResult["evalPublisher"] = null;
  if (cfg.controlPlaneIngress.provider === "cloudflare") {
    const ingress = new CloudflareIngress("control-plane-ingress", {
      provider,
      config: cfg,
    });
    ingressHostnames = ingress.hostnames;
    if (ingress.evalPublisherClientId !== null && ingress.evalPublisherClientSecret !== null) {
      evalPublisher = {
        clientId: ingress.evalPublisherClientId,
        clientSecret: ingress.evalPublisherClientSecret,
      };
    }
  }

  // Nexus (ADR-53). Constructed AFTER the ingress block so its link bases
  // read the hostnames CloudflareIngress just published - that ordering is
  // the whole reason the bootstrap owns this release rather than Argo CD.
  // Its own hostname is published by the ingress like any other target;
  // this installs and configures the workload behind it.
  //
  // Skipped on a placeholder repo for the SAME reason root-app is, and it
  // matters more here: Nexus clones the GitOps repo in an initContainer,
  // and a Helm release waits for workload readiness by default. Installing
  // it against an unreachable URL does not degrade - it hangs the whole
  // bootstrap until the release times out, in a configuration this
  // repository explicitly supports (stage 3 before stage 2 has populated a
  // real repo).
  if (gitopsRepoIsPlaceholder(cfg.gitopsRepoUrl)) {
    pulumi.log.info(
      `nexus: gitopsRepoUrl looks like a placeholder (${JSON.stringify(cfg.gitopsRepoUrl)}) ` +
        "- skipping the Nexus release. Set " +
        "hermes-gitops-bootstrap:gitopsRepoUrl to a real repo to enable it.",
    );
  } else {
    new Nexus("nexus", { provider, config: cfg });
  }

  // The event router's per-target signing secrets (ADR-53). Argo delivers
  // the router itself; without this the Secret only ever existed on a
  // laptop, so every agent-edge delivery failed `no-secret` while the
  // workload reported healthy.
  new RouterSecrets("router-secrets", { provider, config: cfg });

  let pko: PulumiOperator | null = null;
  if (shouldDeployPko(cfg.providers.ingress)) {
    pko = new PulumiOperator("pulumi-operator", {
      provider,
      chartVersion: cfg.versions.pkoChart,
    });
  }

  // root-app converges the cluster on whatever the GitOps repo has, so it
  // waits on all of stage 3's other resources, not just Argo CD itself —
  // `pko` is conditionally null and filtered out here.
  let rootDeployed = false;
  if (gitopsRepoIsPlaceholder(cfg.gitopsRepoUrl)) {
    pulumi.log.info(
      `root-app: gitopsRepoUrl looks like a placeholder (${JSON.stringify(cfg.gitopsRepoUrl)}) ` +
        "- skipping hermes-gitops-root Application. Set " +
        "hermes-gitops-bootstrap:gitopsRepoUrl to a real repo to enable it.",
    );
  } else {
    const extraDependsOn: pulumi.Resource[] = [store, ...scaffoldResources];
    if (pko !== null) extraDependsOn.push(pko);
    new RootApp("root-app", {
      provider,
      namespaces: ns,
      gitopsRepoUrl: cfg.gitopsRepoUrl,
      gitopsBranch: cfg.gitopsBranch,
      argocdRelease: argocd.release,
      extraDependsOn,
    });
    rootDeployed = true;
  }

  return {
    clusterSecretStoreName: STORE_NAME,
    pulumiOperatorDeployed: pko !== null,
    rootAppDeployed: rootDeployed,
    rootAppName: rootDeployed ? APP_NAME : null,
    controlPlaneHostnames: ingressHostnames,
    evalPublisher,
  };
}
