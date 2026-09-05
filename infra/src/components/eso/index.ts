// External Secrets Operator install: the `external-secrets` Helm chart,
// pinned, with CRDs installed by the chart itself (installCRDs=true) so the
// secret-store component can create a ClusterSecretStore in the same
// `pulumi up`.

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { Namespaces, ESO_NS } from "../namespaces/index.ts";

export const ESO_CHART_REPO = "https://charts.external-secrets.io";

export interface EsoArgs {
  provider: k8s.Provider;
  namespaces: Namespaces;
  chartVersion: string;
}

export class Eso extends pulumi.ComponentResource {
  readonly release: k8s.helm.v3.Release;

  constructor(name: string, args: EsoArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:Eso", name, {}, opts);
    this.release = new k8s.helm.v3.Release(
      "external-secrets",
      {
        chart: "external-secrets",
        version: args.chartVersion,
        namespace: ESO_NS,
        repositoryOpts: { repo: ESO_CHART_REPO },
        values: { installCRDs: true },
      },
      { parent: this, provider: args.provider, dependsOn: [args.namespaces.externalSecrets] },
    );
    this.registerOutputs({});
  }
}
