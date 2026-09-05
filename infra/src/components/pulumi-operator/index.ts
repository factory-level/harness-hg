// Pulumi Kubernetes Operator (PKO) install — CONDITIONAL, and OFF by
// default for local/dev.
//
// Only needed when something in this deployment itself needs to run Pulumi
// programs from inside the cluster: today that's exactly one thing,
// `ingress == cloudflare` (the per-instance Cloudflare Tunnel Stack CR,
// harness/hermes/charts/hermes-profile/templates/tunnel/stack-cloudflare.yaml). The `pod`
// + `ingress`/`none` local-dev combination never triggers this component.
// (PKO's former second consumer, the per-agent VM compute path, was
// removed outright — issue #27 [G8].)
//
// Chart is published as an OCI artifact — confirmed current at
// oci://ghcr.io/pulumi/helm-charts/pulumi-kubernetes-operator, chart
// version 2.7.0 -> operator v2.7.0 (Chart.yaml at
// github.com/pulumi/pulumi-kubernetes-operator, deploy/helm/pulumi-operator),
// checked 2026-07-16.
//
// State-backend Secret plumbing (the PULUMI_ACCESS_TOKEN /
// PULUMI_CONFIG_PASSPHRASE a Stack CR's workspace pod needs) lives in the
// CHART, not here: a Stack CR's envRefs Secret reference is same-namespace
// only (the CRD's cross-namespace `secret.namespace` field is documented
// upstream as deprecated), and each persona's namespace (hermes-<name>) is
// created dynamically by the hermes-gitops-profiles ApplicationSet — this
// component (bootstrap stage 3) only ever creates the three FIXED
// namespaces in components/namespaces, with no visibility into personas
// that don't exist yet. harness/hermes/charts/hermes-profile/templates/tunnel/
// pulumi-backend-cloudflare.yaml solves this instead, by reusing the SAME
// ClusterSecretStore ("hermes-gitops", wired by components/secret-store)
// spec.envRequires already materializes secrets through.

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import type { IngressProvider } from "../../control-flow/config.ts";

export const OCI_CHART = "oci://ghcr.io/pulumi/helm-charts/pulumi-kubernetes-operator";
export const NAMESPACE = "pulumi-kubernetes-operator";

export function shouldDeployPko(ingress: IngressProvider): boolean {
  return ingress === "cloudflare";
}

export interface PulumiOperatorArgs {
  provider: k8s.Provider;
  chartVersion: string;
}

export class PulumiOperator extends pulumi.ComponentResource {
  readonly release: k8s.helm.v3.Release;

  constructor(name: string, args: PulumiOperatorArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:PulumiOperator", name, {}, opts);

    const namespace = new k8s.core.v1.Namespace(
      "ns-pulumi-kubernetes-operator",
      { metadata: { name: NAMESPACE } },
      { parent: this, provider: args.provider },
    );

    this.release = new k8s.helm.v3.Release(
      "pulumi-kubernetes-operator",
      {
        chart: OCI_CHART,
        version: args.chartVersion,
        namespace: NAMESPACE,
      },
      { parent: this, provider: args.provider, dependsOn: [namespace] },
    );

    this.registerOutputs({});
  }
}
