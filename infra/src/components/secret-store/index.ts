// ClusterSecretStore "hermes-gitops" — ESO's "kubernetes" provider pointed
// at its own cluster: a ServiceAccount + Role + RoleBinding in
// hermes-secrets granting read access to Secrets in that namespace, and a
// ClusterSecretStore authenticating as that ServiceAccount (ESO mints a
// short-lived token for it via the Kubernetes TokenRequest API at fetch
// time — no static credential is stored anywhere).
//
// This is the ONLY secret store: external backends (vault/gsm/sops) were
// removed outright (issue #30 [H1]) — the secrets model is Pulumi-config
// (`pulumi config set --secret`) -> k8s Secret. The store remains for the
// in-cluster cross-namespace copies the Cloudflare tunnel path uses
// (pulumi-backend credential, tunnel token — written to hermes-secrets,
// copied into instance namespaces by per-namespace ExternalSecrets).
//
// Shape validated against
// https://external-secrets.io/latest/provider/kubernetes/
// (auth.serviceAccount, server.caProvider, and the Role's `secrets` +
// `selfsubjectrulesreviews` verbs).

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { Namespaces, HERMES_SECRETS_NS } from "../namespaces/index.ts";

export const STORE_NAME = "hermes-gitops";
export const STORE_SA_NAME = "hermes-gitops-secretstore";
export const STORE_ROLE_NAME = "hermes-gitops-secretstore-reader";

export const API_VERSION = "external-secrets.io/v1";

export interface SecretStoreArgs {
  provider: k8s.Provider;
  namespaces: Namespaces;
  esoRelease: k8s.helm.v3.Release;
}

export class SecretStore extends pulumi.ComponentResource {
  readonly store: k8s.apiextensions.CustomResource;

  constructor(name: string, args: SecretStoreArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:SecretStore", name, {}, opts);
    const dependsOn: pulumi.Resource[] = [args.namespaces.hermesSecrets, args.esoRelease];
    const childOpts = { parent: this, provider: args.provider, dependsOn };

    const serviceAccount = new k8s.core.v1.ServiceAccount(
      "hermes-gitops-secretstore-sa",
      { metadata: { name: STORE_SA_NAME, namespace: HERMES_SECRETS_NS } },
      childOpts,
    );

    const role = new k8s.rbac.v1.Role(
      "hermes-gitops-secretstore-role",
      {
        metadata: { name: STORE_ROLE_NAME, namespace: HERMES_SECRETS_NS },
        rules: [
          { apiGroups: [""], resources: ["secrets"], verbs: ["get", "list", "watch"] },
          {
            apiGroups: ["authorization.k8s.io"],
            resources: ["selfsubjectrulesreviews"],
            verbs: ["create"],
          },
        ],
      },
      childOpts,
    );

    const roleBinding = new k8s.rbac.v1.RoleBinding(
      "hermes-gitops-secretstore-rolebinding",
      {
        metadata: { name: STORE_ROLE_NAME, namespace: HERMES_SECRETS_NS },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: STORE_ROLE_NAME,
        },
        subjects: [
          { kind: "ServiceAccount", name: STORE_SA_NAME, namespace: HERMES_SECRETS_NS },
        ],
      },
      {
        parent: this,
        provider: args.provider,
        dependsOn: [...dependsOn, serviceAccount, role],
      },
    );

    this.store = new k8s.apiextensions.CustomResource(
      "hermes-gitops-clustersecretstore",
      {
        apiVersion: API_VERSION,
        kind: "ClusterSecretStore",
        metadata: { name: STORE_NAME },
        spec: {
          provider: {
            kubernetes: {
              remoteNamespace: HERMES_SECRETS_NS,
              server: {
                caProvider: {
                  type: "ConfigMap",
                  name: "kube-root-ca.crt",
                  key: "ca.crt",
                  namespace: HERMES_SECRETS_NS,
                },
              },
              auth: {
                serviceAccount: { name: STORE_SA_NAME, namespace: HERMES_SECRETS_NS },
              },
            },
          },
        },
      },
      {
        parent: this,
        provider: args.provider,
        dependsOn: [...dependsOn, serviceAccount, role, roleBinding],
      },
    );

    this.registerOutputs({});
  }
}
