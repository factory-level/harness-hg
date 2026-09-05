// Argo CD install: the `argo-cd` Helm chart (argo-helm), pinned, plus
// optional repo credential Secrets for the two source repos the hermes-gitops
// AppProject allows (see infra/gitops-template/bootstrap/project.yaml).
//
// Chart/version and the ApplicationSet design it hosts were validated
// against current Argo CD docs before this was written — see
// infra/gitops-template/README.md's "ArgoCD version validated against" section
// for the full evidence trail (git files generator + goTemplate,
// multi-source `$ref` valueFiles support in ApplicationSets, `configs.cm` /
// `configs.params` chart value shape).

import { createHash } from "node:crypto";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { Namespaces, ARGOCD_NS } from "../namespaces/index.ts";
import type {
  ArgoRepoCreds,
  HelmOciRegistrySpec,
  TargetClusterSpec,
} from "../../control-flow/config.ts";

export const ARGOCD_CHART_REPO = "https://argoproj.github.io/argo-helm";

// Custom health check for the pulumi.com/v1 Stack CRD (installed by the
// pulumi-operator component when enabled). Argo CD has no built-in health
// logic for third-party CRDs; without this, a Stack resource shows
// "Healthy" the instant it's created (unknown-kind default), masking real
// failures. Key format (`resource.customizations.health.<group>_<kind>`)
// and the Lua `obj`/`hs.status`/`hs.message` contract confirmed against
// https://argo-cd.readthedocs.io/en/latest/operator-manual/health/.
const PULUMI_STACK_HEALTH_LUA = `
hs = {}
if obj.status ~= nil and obj.status.lastUpdate ~= nil then
  local state = obj.status.lastUpdate.state
  if state == "succeeded" then
    hs.status = "Healthy"
    hs.message = "Pulumi stack update succeeded"
    return hs
  end
  if state == "failed" then
    hs.status = "Degraded"
    hs.message = "Pulumi stack update failed"
    return hs
  end
end
hs.status = "Progressing"
hs.message = "Waiting for pulumi stack update"
return hs
`.trim();

// Works around a real, live-verified Argo CD + StatefulSet interaction
// defect (see infra/scripts/smoke-local.sh): the Kubernetes API server injects
// `apiVersion`, `kind`, and `status: {phase: Pending}` into every
// `spec.volumeClaimTemplates[]` entry when a StatefulSet is read back after
// creation — none of which are present in the Helm-rendered desired-state
// manifest. Argo CD's live-vs-desired diff sees this as permanent,
// un-healable drift, so every hermes-profile StatefulSet is stuck OutOfSync
// forever (confirmed live against Argo CD v3.4.5 / k3s v1.35.5).
// `automated.selfHeal` cannot fix this — the API server keeps re-adding the
// same fields on every read. This is the documented upstream workaround
// (`resource.customizations.ignoreDifferences.<group>_<kind>`,
// https://argo-cd.readthedocs.io/en/latest/user-guide/diffing/), applied
// cluster-wide because every hermes-profile StatefulSet hits the same
// defect.
//
// Scoped with jqPathExpressions to the exact three API-server-injected
// subfields on every array element, NOT the whole spec.volumeClaimTemplates
// array: a blanket jsonPointers form would also mask the one field inside
// that array an operator can legitimately change post-creation —
// spec.resources.requests.storage (the chart's diskSizeGb value) — and
// silently report Synced on real drift. The three-subfield form leaves that
// field fully diffed while still absorbing the injected noise.
// The restartedAt entry: the agent-secrets component rolls a workload on
// secret rotation via `kubectl rollout restart` (issue #38 [K6]), which
// stamps kubectl.kubernetes.io/restartedAt onto the pod template. Without
// this, selfHeal would revert the annotation — rolling the workload a
// SECOND time for every rotation.
const STATEFULSET_IGNORE_DIFFERENCES = `
jqPathExpressions:
- .spec.volumeClaimTemplates[].apiVersion
- .spec.volumeClaimTemplates[].kind
- .spec.volumeClaimTemplates[].status
- .spec.template.metadata.annotations."kubectl.kubernetes.io/restartedAt"
`.trim();

export interface ArgoCdArgs {
  provider: k8s.Provider;
  namespaces: Namespaces;
  chartVersion: string;
  repoCreds: ArgoRepoCreds;
  gitopsRepoUrl: string;
  hermesGitopsRepoUrl: string;
  // Remote workload clusters to register (issue #5 [C1]); empty = today's
  // single in-cluster behavior.
  targetClusters: TargetClusterSpec[];
  // Helm-OCI chart registries to register as repository Secrets (#187);
  // empty = no oci:// apps in the fleet.
  helmOciRegistries: HelmOciRegistrySpec[];
}

/** Stable, collision-free DNS-label slug for a scheme-less OCI registry
 * URL: a readable prefix plus an 8-hex sha256 suffix, because the lossy
 * character mapping alone would collide (`x-y` vs `x/y`). Deliberately
 * duplicated in cli/src/platform.ts (`ociRegistrySlug`) - the CLI is a
 * separate package; keep the two in sync. */
export function ociRegistrySlug(host: string): string {
  const readable = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const hash = createHash("sha256").update(host).digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

// The stringData payload of one argocd.argoproj.io/secret-type=cluster
// Secret (https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/#clusters):
// `name` is what Application destinations reference (records' C3
// spec.targetCluster resolves to it), `server` the API URL, `config` a
// JSON blob carrying the bearer token + TLS posture. Pure function,
// exported for offline tests - secret-wrapping happens at the resource.
export function clusterSecretStringData(
  spec: TargetClusterSpec,
): Record<string, string> {
  const tlsClientConfig: Record<string, unknown> = { insecure: spec.insecure };
  if (spec.caData) {
    tlsClientConfig["caData"] = spec.caData;
  }
  return {
    name: spec.name,
    server: spec.server,
    config: JSON.stringify({ bearerToken: spec.bearerToken, tlsClientConfig }),
  };
}

export class ArgoCd extends pulumi.ComponentResource {
  readonly release: k8s.helm.v3.Release;

  constructor(name: string, args: ArgoCdArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:ArgoCd", name, {}, opts);

    this.release = new k8s.helm.v3.Release(
      "argocd",
      {
        // Pinned, never autonamed: pulumi's suffix (argocd-<hash>) breaks
        // every consumer that addresses services by the documented names -
        // the tunnel's argocd-server.argocd.svc origin 502'd on the first
        // real environment, and a rebuild would mint a NEW suffix, so no
        // recorded override could survive recovery either.
        name: "argocd",
        chart: "argo-cd",
        version: args.chartVersion,
        namespace: ARGOCD_NS,
        repositoryOpts: { repo: ARGOCD_CHART_REPO },
        // No other fields set beyond values/chart/version/namespace/repo:
        // a second `pulumi up` re-diffs against this same fixed input and
        // Helm reports no changes, so the release is a no-op re-apply
        // (verified live against the Python predecessor).
        values: {
          configs: {
            params: {
              // Local/dev: terminate TLS at nothing (no ingress fronting
              // argocd-server in this milestone) and talk to argocd-server
              // over plain HTTP for in-cluster verification (kubectl exec +
              // curl, port-forward). Revisit once providers.ingress wires a
              // real ingress controller in front of it.
              "server.insecure": "true",
            },
            cm: {
              "resource.customizations.health.pulumi.com_Stack": PULUMI_STACK_HEALTH_LUA,
              "resource.customizations.ignoreDifferences.apps_StatefulSet":
                STATEFULSET_IGNORE_DIFFERENCES,
            },
          },
        },
      },
      // deleteBeforeReplace: the chart's children carry FIXED names
      // (ServiceAccount argocd-application-controller...), so a
      // create-first replacement collides with the outgoing release's
      // ownership annotations and can never succeed.
      { parent: this, provider: args.provider, dependsOn: [args.namespaces.argocd], deleteBeforeReplace: true },
    );

    // Repo credential Secrets for the gitops + hermes-gitops repos, created
    // only when a token is configured for each (public repos need none).
    if (args.repoCreds.gitopsToken) {
      this.repoCredSecret(
        args,
        "argocd-repo-creds-gitops",
        "hermes-gitops-repo-creds-gitops",
        args.gitopsRepoUrl,
        args.repoCreds.gitopsUsername,
        args.repoCreds.gitopsToken,
      );
    }
    if (args.repoCreds.hermesGitopsToken) {
      this.repoCredSecret(
        args,
        "argocd-repo-creds-hermes-gitops",
        "hermes-gitops-repo-creds-hermes-gitops",
        args.hermesGitopsRepoUrl,
        args.repoCreds.hermesGitopsUsername,
        args.repoCreds.hermesGitopsToken,
      );
    }

    // Helm-OCI registry registration (#187): one secret-type=repository
    // Secret with enableOCI per declared registry. The Secret's url is
    // SCHEME-LESS - the form the hermes-profile chart renders into child
    // Application repoURLs (Argo CD reads an oci://-schemed repoURL as a
    // native OCI source and ignores `chart:`); the config keeps the
    // oci:// identity. Credentials optional (public registries pull
    // anonymously); the whole stringData is secret-wrapped like the
    // repo-cred Secrets above.
    for (const reg of args.helmOciRegistries) {
      const host = reg.url.slice("oci://".length);
      const slug = ociRegistrySlug(host);
      new k8s.core.v1.Secret(
        `argocd-helm-oci-${slug}`,
        {
          metadata: {
            name: `hermes-gitops-helm-oci-${slug}`,
            namespace: ARGOCD_NS,
            labels: { "argocd.argoproj.io/secret-type": "repository" },
          },
          stringData: pulumi.secret({
            name: `helm-oci-${slug}`,
            url: host,
            type: "helm",
            enableOCI: "true",
            ...(reg.insecure ? { insecure: "true" } : {}),
            ...(reg.username && reg.token
              ? { username: reg.username, password: reg.token }
              : {}),
          }),
        },
        {
          parent: this,
          provider: args.provider,
          dependsOn: [args.namespaces.argocd, this.release],
          additionalSecretOutputs: ["stringData"],
        },
      );
    }

    // Remote workload cluster registration (issue #5 [C1]): one
    // secret-type=cluster Secret per declared cluster. The whole
    // stringData is pulumi.secret-wrapped (the config blob embeds the
    // bearer token) and doubly masked via additionalSecretOutputs, the
    // same belt-and-suspenders as the repo-cred Secrets above.
    for (const spec of args.targetClusters) {
      new k8s.core.v1.Secret(
        `argocd-cluster-${spec.name}`,
        {
          metadata: {
            name: `hermes-gitops-cluster-${spec.name}`,
            namespace: ARGOCD_NS,
            labels: { "argocd.argoproj.io/secret-type": "cluster" },
          },
          stringData: pulumi.secret(clusterSecretStringData(spec)),
        },
        {
          parent: this,
          provider: args.provider,
          dependsOn: [args.namespaces.argocd, this.release],
          additionalSecretOutputs: ["stringData"],
        },
      );
    }

    this.registerOutputs({});
  }

  private repoCredSecret(
    args: ArgoCdArgs,
    resourceName: string,
    secretName: string,
    repoUrl: string,
    username: string,
    token: string,
  ): k8s.core.v1.Secret {
    return new k8s.core.v1.Secret(
      resourceName,
      {
        metadata: {
          name: secretName,
          namespace: ARGOCD_NS,
          labels: { "argocd.argoproj.io/secret-type": "repository" },
        },
        stringData: {
          type: "git",
          url: repoUrl,
          username,
          password: token,
        },
      },
      {
        parent: this,
        provider: args.provider,
        dependsOn: [args.namespaces.argocd, this.release],
        additionalSecretOutputs: ["stringData"],
      },
    );
  }
}
