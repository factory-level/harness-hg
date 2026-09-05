<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Source of truth: agent-bundle-contracts/hermesprofile/v1alpha3/profile.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py).
     `make docs-drift` (part of `make test`) fails the build if this
     file and the schema have diverged. -->

# Profile record reference

This page is generated directly from `agent-bundle-contracts/hermesprofile/v1alpha3/profile.schema.json` — the versioned, frozen contract described in `agent-bundle-contracts/README.md`. It documents the shape of one `HermesProfile` instance record (`profiles/<name>/profile.yaml` in the GitOps repo, produced by `gitops_emitter/render.py` on `hermes profile install`/`update` — see `gitops_emitter/README.md`). If a field described here looks wrong, the schema file is the source of truth, not this page — file the fix there and re-run `make docs`.

Schema `$id`: `https://hermes-gitops.factorylevel.dev/schemas/hermesprofile/v1alpha3/profile.schema.json` — see `agent-bundle-contracts/README.md`'s "Versioning rule" for what a schema change of any kind implies (a new `v1alpha3`+ directory, never editing this one in place).

## (root)

The per-agent instance record (profile.yaml) pushed to the GitOps repo. v1alpha2 removes four fields no consumer read: spec.targetCluster, spec.reach (whose only key was regions), and spec.deployment.{machineType,region,diskType} - leftovers from the deleted VM compute path. See plugin/schemas/README.md for the migration note. Fully-resolved instance record for a single installed Hermes agent — PLAIN HELM VALUES for the hermes-profile chart, not a Kubernetes custom resource (there is no HermesProfile CRD). The record's identity is its directory name (profiles/<name>/profile.yaml, read by the ApplicationSet as {{.path.basename}}); the emitter enforces the name rules (DNS-1123 label, max 40 chars). Desired-state only; no status block.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `spec` | object | **yes** | — | The record's single top-level block. Every field under it doubles as a Helm value for the hermes-profile chart - there is no translation step. |

### `spec`

The record's single top-level block. Every field under it doubles as a Helm value for the hermes-profile chart - there is no translation step.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `persona` | string | **yes** | minLength: 1 | The installed instance name - identical to the record's directory name under profiles/. The chart stamps it on every rendered resource as the persona label. |
| `source` | string | **yes** | minLength: 1 | Git URL or path, e.g. github.com/factorylevel/support-agent |
| `gitAuthSecretRef` | string | no | minLength: 1 | Name of a Kubernetes Secret in the instance's own namespace holding the credential to clone a PRIVATE spec.source: keys username+password (HTTPS PAT) or ssh-privatekey (SSH deploy key). Omit for public sources. |
| `ref` | string | no | minLength: 1 | Git ref the install resolved spec.sha from, recorded for provenance - the pod boots from spec.sha, not from this ref. Omitted when the install named none. |
| `sourceSubdir` | string | no | pattern: `^(?!/)(?!.*\.\.)[^\\]+$`; minLength: 1 | Subdirectory of spec.source containing the distribution (the Hermes fork's --subdir / #subdirectory= install form). The pod boot path installs /tmp/dist/<sourceSubdir> from its clone. Omit for root-layout sources. |
| `sha` | string | **yes** | pattern: `^[0-9a-f]{40}$` | Full commit SHA (40 lowercase hex chars). |
| `distributionVersion` | string | no | minLength: 1 | The version the distribution declared at install time, recorded for provenance. |
| `deployment` | object | no | — | Agent pod knobs - pod-compute only. |
| `apps` | array of object | no | uniqueItems | The RESOLVED helm apps this instance launches, in author order - the emitter has already deep-merged author values + fleet defaults + per-instance appValues overrides into `values`, and every `valuesRequired` dot-path was satisfied pre-render (so that field is dropped from the record). The chart renders one Argo CD Application per entry (app-of-apps). |
| `envRequires` | array of any | no | — | Every environment variable this profile needs, WITH the metadata the declaration carried. v1alpha2 and earlier stored a flat array of names, discarding the description, the required flag and the secret-versus-config distinction - the three facts the capability model and the secret lifecycle need (#141, #171, #149). Both shapes are accepted: a bare string is an entry with name only, and means `required: true, secret: true` by the same conservative default the resolver applies. |
| `expose` | object | no | — | HTTP services on the agent pod to route ingress to, plus the access policy the tunnel ingress applies. |
| `backup` | object | no | — | Backup intent - schedule and retention only; the destination is a platform concern (providers.backup in cluster-values). |

#### `spec.deployment`

Agent pod knobs - pod-compute only.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `baseImageTag` | string | no | minLength: 1 | Tag of the Hermes agent container image this instance runs; overrides the platform's image tag for both the bootstrap initContainer and the main container. |
| `diskSizeGb` | integer | no | minimum: 10 | Size in GiB of the instance's data volume claim. Default when absent: 10. |

#### `spec.apps[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | DNS-label app name, unique within the record. |
| `chart` | string | **yes** | minLength: 1 | Chart name in the remote helm repo, or (for `repo: local`) the chart's path inside the platform/GitOps chart tree. |
| `repo` | string | **yes** | pattern: `^(local|https://\S+|oci://\S+)$` | Helm repo URL (https:// or oci://), or the reserved word `local` (chart ships with the platform/GitOps repo). |
| `version` | string | no | minLength: 1 | Chart version - present for remote repos (the Application's targetRevision), absent for `repo: local`. |
| `values` | object | no | — | The fully-merged chart values (author values + fleet defaults + per-instance overrides), inlined. |

#### `spec.expose`

HTTP services on the agent pod to route ingress to, plus the access policy the tunnel ingress applies.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `services` | array of object | **yes** | minItems: 1 | The exposed services. Each becomes a named port on the instance's Service and a routing rule on the configured ingress provider. |
| `access` | object | no | — | Access control for the exposed services under the Cloudflare tunnel ingress. |

##### `spec.expose.services[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$` | DNS-label service name; becomes the port's name on the instance's Kubernetes Service. |
| `port` | integer | **yes** | minimum: 1; maximum: 65535 | TCP port on the agent pod this service targets. |
| `path` | string | no | pattern: `^/` | HTTP path prefix routed to this service. Default when absent: /. |

##### `spec.expose.access`

Access control for the exposed services under the Cloudflare tunnel ingress.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `policy` | string | no | enum: `service-token`, `idp`, `mixed` | Who may reach the exposed services: service-token = named machine clients, idp = people via the identity provider, mixed = both. Default when absent: service-token. |

#### `spec.backup`

Backup intent - schedule and retention only; the destination is a platform concern (providers.backup in cluster-values).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schedule` | string | **yes** | minLength: 1 | Cron expression for the CronJob that archives the instance's data volume. |
| `retention` | integer | no | minimum: 1 | How many of the newest archives are kept; older ones are pruned. Default when absent: 7. |

## See also

- `agent-bundle-contracts/hermesprofile/v1alpha3/examples/` — fixtures validated against this exact schema by `make schema-validate` (`invalid-*` fixtures must fail; everything else must pass).
- `harness/hermes/identity/examples/persona-echo/` — a realistic, non-minimal `distribution.yaml` (the gitops-emitter INPUT this record is rendered from, not the record itself) and its rendered output (`harness/hermes/identity/examples/rendered/profile-echo.yaml`).
- `maintainers/built.md` — how this record fits into the rest of the system.

