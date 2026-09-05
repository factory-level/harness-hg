<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/cluster-values/v1alpha1/cluster-values.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Cluster values

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Written by the **operator** as `bootstrap/values/cluster-values.yaml`: the "where" layer (providers, image, platform repo). Argo CD layers it under every record, so each field is also a Helm value.

Schema: `agent-bundle-contracts/cluster-values/v1alpha1/cluster-values.schema.json` — **ClusterValues**

## (root)

Per-cluster values file (bootstrap/values/cluster-values.yaml) consumed by the Harness Hg Helm chart.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `providers` | object | **yes** | — | Which backend implements each concern for this cluster. Environment-level decisions: a profile record cannot change a provider. |
| `image` | object | no | — | The Hermes agent container image, used by both the bootstrap initContainer and the main container. A record's spec.deployment.baseImageTag, when set, overrides image.tag. |
| `platformRepo` | object | no | — | The platform (factory-level/harness-hg) repo + revision Argo CD renders the hermes-profile chart from - the profiles ApplicationSet's chart source, threaded here so the chart can reuse it as the Application source for spec.apps[] entries with repo: local (local charts ship inside the platform repo and version with it). Scaffolded as the __HERMES_GITOPS_REPO_URL__/__CHART_REVISION__ tokens. |
| `appProject` | object | no | — | Argo CD AppProject configuration for the per-app child Applications the hermes-profile chart renders (one per spec.apps[] entry). sourceRepos is the platform's remote helm repo allowlist: a profile's spec.apps[].repo must appear here (render fails loudly otherwise - hermes.appsGuard); the scaffold renders this list into the sourceRepos of the GitOps repo's bootstrap/project.yaml (the server-side enforcement of the same allowlist) on every reconcile, twinning each oci:// entry with its scheme-less form. repo: local is always allowed and needs no entry. |
| `secretBackend` | object | no | — | Per-provider secret backend configuration; keys correspond to providers.secret values. |
| `cloudflare` | object | no | — | Cloudflare Tunnel ingress configuration (providers.ingress: cloudflare) - consumed by the chart's tunnel Stack CR templates and validated by hermes.cloudflareConfigGuard. Optional; required keys within it are enforced by the guard only when the cloudflare ingress provider is selected. |
| `tailscale` | object | no | — | Tailscale ingress configuration (providers.ingress: tailscale) - consumed by the chart's tailscale sidecar + ExternalSecret templates and validated by hermes.tailscaleConfigGuard. Optional; required keys within it are enforced by the guard only when the tailscale ingress provider is selected. |
| `backup` | object | no | — | Platform-side configuration for the providers.backup pvc destination. The profile record only declares intent (spec.backup schedule and retention); everything here is a cluster concern. |

### `providers`

Which backend implements each concern for this cluster. Environment-level decisions: a profile record cannot change a provider.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `compute` | string | **yes** | enum: `pod` | Compute backend for agent workloads. pod - the chart's StatefulSet - is the only compute path (hermes.computeGuard). |
| `secret` | string | **yes** | enum: `k8s` | Secret backend. k8s materializes secrets via ExternalSecrets reading the in-cluster ClusterSecretStore; configured under secretBackend.k8s. |
| `ingress` | string | **yes** | enum: `ingress`, `cloudflare`, `tailscale`, `none` | Ingress backend for exposed services: ingress (standard Ingress resources), cloudflare (a Cloudflare Tunnel per instance), or none. tailscale is retired - this frozen schema still accepts it, but the chart's own values schema refuses it at render time. |
| `backup` | string | no | enum: `pvc`, `none` | Which backend implements spec.backup intent. pvc archives the instance's data volume into a per-instance backups PVC on the declared schedule; none means the platform offers no backup destination and a profile declaring spec.backup fails the render loudly (hermes.backupGuard). |

### `image`

The Hermes agent container image, used by both the bootstrap initContainer and the main container. A record's spec.deployment.baseImageTag, when set, overrides image.tag.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | string | no | minLength: 1 | Image repository for the Hermes agent container. |
| `tag` | string | no | minLength: 1 | Image tag for the Hermes agent container; overridden per instance by spec.deployment.baseImageTag. |

### `platformRepo`

The platform (factory-level/harness-hg) repo + revision Argo CD renders the hermes-profile chart from - the profiles ApplicationSet's chart source, threaded here so the chart can reuse it as the Application source for spec.apps[] entries with repo: local (local charts ship inside the platform repo and version with it). Scaffolded as the __HERMES_GITOPS_REPO_URL__/__CHART_REVISION__ tokens.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `url` | string | no | minLength: 1 | Git URL of the platform repository the chart is rendered from. Scaffolded as the __HERMES_GITOPS_REPO_URL__ token. |
| `revision` | string | no | minLength: 1 | Git revision (branch, tag or commit) the chart is rendered at. Scaffolded as the __CHART_REVISION__ token. |

### `appProject`

Argo CD AppProject configuration for the per-app child Applications the hermes-profile chart renders (one per spec.apps[] entry). sourceRepos is the platform's remote helm repo allowlist: a profile's spec.apps[].repo must appear here (render fails loudly otherwise - hermes.appsGuard); the scaffold renders this list into the sourceRepos of the GitOps repo's bootstrap/project.yaml (the server-side enforcement of the same allowlist) on every reconcile, twinning each oci:// entry with its scheme-less form. repo: local is always allowed and needs no entry.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | no | minLength: 1 | Name of the Argo CD AppProject the per-app child Applications are created in. |
| `sourceRepos` | array of string | no | — | Remote Helm repositories (https:// or oci://) profiles may pull spec.apps[] charts from. Declared once here; the scaffold renders them into bootstrap/project.yaml's sourceRepos in the GitOps repo (oci:// entries twinned scheme-less). repo: local needs no entry. |

### `secretBackend`

Per-provider secret backend configuration; keys correspond to providers.secret values.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `k8s` | object | no | — | Configuration for providers.secret: k8s. |

#### `secretBackend.k8s`

Configuration for providers.secret: k8s.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `namespace` | string | no | minLength: 1 | Namespace the seeded source Secrets live in. Carried for schema parity - the chart itself does not read it; the cluster-scoped ClusterSecretStore pins its own remoteNamespace server-side. |

### `cloudflare`

Cloudflare Tunnel ingress configuration (providers.ingress: cloudflare) - consumed by the chart's tunnel Stack CR templates and validated by hermes.cloudflareConfigGuard. Optional; required keys within it are enforced by the guard only when the cloudflare ingress provider is selected.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `accountId` | string | no | — | Cloudflare account every hermes-<name>-tunnel Stack provisions its tunnel, DNS and Access resources under. No safe default - the guard fails the render when unset under the cloudflare provider. |
| `zoneId` | string | no | — | ID of the Cloudflare zone tunnel DNS records are created in. Required by the guard when providers.ingress is cloudflare. |
| `zoneName` | string | no | — | Name of the Cloudflare zone (the public domain) tunnel hostnames live under. Required by the guard when providers.ingress is cloudflare. |
| `cloudflaredImage` | object | no | — | The cloudflared sidecar image run beside the agent container under the cloudflare ingress provider. |
| `access` | object | no | — | Cloudflare Access configuration for instances whose expose access policy is idp or mixed. |
| `apiToken` | object | no | — | The Cloudflare API token the tunnel Stack workspaces authenticate to the Cloudflare API with - a fleet-wide shared secret, referenced by key, never by value. |
| `tunnel` | object | no | — | Git identity and workspace settings for the cloudflare-tunnel Pulumi program the rendered tunnel Stack CRs point at. |
| `pulumiBackend` | object | no | — | Pulumi state backend for the tunnel Stack workspaces, config-switched between Pulumi Cloud and a self-managed backend. |

#### `cloudflare.cloudflaredImage`

The cloudflared sidecar image run beside the agent container under the cloudflare ingress provider.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | string | no | minLength: 1 | Image repository for the cloudflared sidecar. |
| `tag` | string | no | minLength: 1 | Image tag for the cloudflared sidecar. |

#### `cloudflare.access`

Cloudflare Access configuration for instances whose expose access policy is idp or mixed.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `idpId` | string | no | — | ID of an existing Cloudflare Access identity-provider integration, created out of band in the Zero Trust dashboard - never created here. Needed only when an installed instance's access policy is idp or mixed; may stay empty for a fleet that only uses service tokens. |

#### `cloudflare.apiToken`

The Cloudflare API token the tunnel Stack workspaces authenticate to the Cloudflare API with - a fleet-wide shared secret, referenced by key, never by value.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `remoteSecretKey` | string | no | minLength: 1 | Key in the remote secret backend holding the shared Cloudflare API token; every instance's ExternalSecret reads the same key (seed once, read everywhere). |

#### `cloudflare.tunnel`

Git identity and workspace settings for the cloudflare-tunnel Pulumi program the rendered tunnel Stack CRs point at.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `projectRepo` | string | no | minLength: 1 | Git URL of the repository holding the cloudflare-tunnel Pulumi program. Defaults to the platform repository itself - override only if you vendor the program elsewhere. |
| `commit` | string | no | — | Commit the tunnel program is pinned at. Takes precedence over branch when both are set (mutually exclusive on the Stack CRD). |
| `branch` | string | no | — | Branch the tunnel program tracks when no commit is pinned. |
| `workspaceServiceAccountName` | string | no | — | Kubernetes ServiceAccount the tunnel Stack's workspace pod runs as. Expected to already exist with Cloudflare API credentials and, for providers.secret k8s, RBAC to write Secrets - the chart creates neither. Empty defaults to the instance's own pod ServiceAccount. |

#### `cloudflare.pulumiBackend`

Pulumi state backend for the tunnel Stack workspaces, config-switched between Pulumi Cloud and a self-managed backend.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `mode` | string | no | enum: `pulumi-cloud`, `self-managed` | Which backend shape is active: pulumi-cloud (a PULUMI_ACCESS_TOKEN Secret) or self-managed (a backend URL plus a passphrase Secret). |
| `pulumiCloud` | object | no | — | Pulumi Cloud backend settings (mode: pulumi-cloud). |
| `selfManaged` | object | no | — | Self-managed backend settings (mode: self-managed). |

##### `cloudflare.pulumiBackend.pulumiCloud`

Pulumi Cloud backend settings (mode: pulumi-cloud).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `remoteSecretKey` | string | no | minLength: 1 | Key in the remote secret backend holding the shared PULUMI_ACCESS_TOKEN. |

##### `cloudflare.pulumiBackend.selfManaged`

Self-managed backend settings (mode: self-managed).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `backendUrl` | string | no | — | Pulumi state backend URL, rendered as PULUMI_BACKEND_URL on the tunnel workspace. |
| `remotePassphraseKey` | string | no | minLength: 1 | Key in the remote secret backend holding the shared Pulumi state passphrase. |

### `tailscale`

Tailscale ingress configuration (providers.ingress: tailscale) - consumed by the chart's tailscale sidecar + ExternalSecret templates and validated by hermes.tailscaleConfigGuard. Optional; required keys within it are enforced by the guard only when the tailscale ingress provider is selected.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `authKey` | object | no | — | The Tailscale auth key the sidecar joins the tailnet with - referenced by remote key, never by value. |
| `tailscaleImage` | object | no | — | The tailscale sidecar image run beside the agent container under the tailscale ingress provider. |

#### `tailscale.authKey`

The Tailscale auth key the sidecar joins the tailnet with - referenced by remote key, never by value.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `remoteSecretKey` | string | no | minLength: 1 | Key in the remote secret backend holding the shared Tailscale auth key. |

#### `tailscale.tailscaleImage`

The tailscale sidecar image run beside the agent container under the tailscale ingress provider.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | string | no | minLength: 1 | Image repository for the tailscale sidecar. |
| `tag` | string | no | minLength: 1 | Image tag for the tailscale sidecar. |

### `backup`

Platform-side configuration for the providers.backup pvc destination. The profile record only declares intent (spec.backup schedule and retention); everything here is a cluster concern.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `image` | object | no | — | Image the archive CronJob runs (tar and sh are all it needs). |
| `pvc` | object | no | — | The per-instance backups PVC (hermes-<name>-backups) archives are written to. |

#### `backup.image`

Image the archive CronJob runs (tar and sh are all it needs).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | string | no | minLength: 1 | Image repository for the backup CronJob. |
| `tag` | string | no | minLength: 1 | Image tag for the backup CronJob. |

#### `backup.pvc`

The per-instance backups PVC (hermes-<name>-backups) archives are written to.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `size` | string | no | pattern: `^[0-9]+(Ki|Mi|Gi|Ti)$` | Requested capacity of the backups PVC, as a Kubernetes quantity (e.g. 5Gi). |
| `storageClassName` | string | no | minLength: 1 | StorageClass of the backups PVC. Unset uses the cluster default StorageClass. |

## Example

`agent-bundle-contracts/cluster-values/v1alpha1/examples/cluster-values-local.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
providers:
  compute: pod
  secret: k8s
  ingress: ingress
image:
  repository: ghcr.io/factory-level/hermes-agent
  tag: latest
platformRepo:
  url: https://github.com/factory-level/hermes-gitops-plugin.git
  revision: main
appProject:
  name: hermes-gitops
  # Remote helm repos profiles may pull spec.apps[] charts from. Declared
  # once here; the scaffold renders them into bootstrap/project.yaml's
  # sourceRepos in the GitOps repo. `repo: local` apps need no entry.
  sourceRepos:
    - https://qdrant.github.io/qdrant-helm
secretBackend:
  k8s:
    namespace: hermes-gitops
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/cluster-values/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).

