// The three namespaces bootstrap stage 3 owns.
//
// Kept as a single ComponentResource exposing the Namespace resources so
// every other component depends on these objects (not on bare
// namespace-name strings), giving Pulumi real dependsOn edges: namespaces
// must exist before anything is installed into them.

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

export const ARGOCD_NS = "argocd";
export const ESO_NS = "external-secrets";
export const HERMES_SECRETS_NS = "hermes-secrets";
export const MONITORING_NS = "hermes-monitoring";

export interface NamespacesArgs {
  provider: k8s.Provider;
}

export class Namespaces extends pulumi.ComponentResource {
  readonly argocd: k8s.core.v1.Namespace;
  readonly externalSecrets: k8s.core.v1.Namespace;
  readonly hermesSecrets: k8s.core.v1.Namespace;
  readonly monitoring: k8s.core.v1.Namespace;
  readonly grafanaAdmin: k8s.core.v1.Secret;

  constructor(name: string, args: NamespacesArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:Namespaces", name, {}, opts);
    const childOpts = { parent: this, provider: args.provider };
    this.argocd = new k8s.core.v1.Namespace(
      "ns-argocd",
      { metadata: { name: ARGOCD_NS } },
      childOpts,
    );
    this.externalSecrets = new k8s.core.v1.Namespace(
      "ns-external-secrets",
      { metadata: { name: ESO_NS } },
      childOpts,
    );
    this.hermesSecrets = new k8s.core.v1.Namespace(
      "ns-hermes-secrets",
      { metadata: { name: HERMES_SECRETS_NS } },
      childOpts,
    );
    // The monitoring namespace exists BEFORE root-app syncs the
    // kube-prometheus-stack Application into it, because Grafana's
    // admin credential (admin.existingSecret, ADR-45 - the committed
    // literal is gone, issue #130) must already be there or the pod
    // never starts. Generated once, held in Pulumi state, never in Git.
    this.monitoring = new k8s.core.v1.Namespace(
      "ns-hermes-monitoring",
      { metadata: { name: MONITORING_NS } },
      childOpts,
    );
    const password = new random.RandomPassword(
      "grafana-admin-password",
      { length: 24, special: false },
      { parent: this },
    );
    this.grafanaAdmin = new k8s.core.v1.Secret(
      "monitoring-grafana-admin",
      {
        metadata: { name: "monitoring-grafana-admin", namespace: MONITORING_NS },
        type: "Opaque",
        stringData: { "admin-user": "admin", "admin-password": password.result },
      },
      { ...childOpts, dependsOn: [this.monitoring] },
    );
    this.registerOutputs({});
  }
}
