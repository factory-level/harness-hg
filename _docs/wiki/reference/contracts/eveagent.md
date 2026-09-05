<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/eveagent/v1alpha2/eveagent.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# EveAgent record

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

**Generated** by the emitter for an Eve agent: `profiles/<name>/profile.yaml`, plain Helm values for the `eve-agent` chart, never a custom resource. `spec.runtime: eve` is what the agents ApplicationSet routes on. v1alpha2 adds `spec.apps` and `spec.backup`; v1alpha1 records stay valid.

Schema: `agent-bundle-contracts/eveagent/v1alpha2/eveagent.schema.json` — **EveAgent record v1alpha2 (profiles/<name>/profile.yaml for an Eve agent)**

## (root)

PLAIN HELM VALUES for the eve-agent chart, not a Kubernetes custom resource (there is no EveAgent CRD). The record's identity is its directory name. An Eve agent (the Vercel `eve` framework) is authored as an npm project - package.json plus an agent/ directory - at agents/<name>/ in its source repository, with hermes-gitops.yaml (contractVersion 5, runtime.kind eve) beside package.json. The emitter renders this record from that project at one commit; the pod clones spec.source at spec.sha, runs `npm ci` and `eve build`, and serves the built Nitro server with `eve start`. Compared with the HermesProfile record: spec.runtime is the discriminator the ApplicationSet routes on, env requirements come from hermes-gitops.yaml rather than a distribution manifest, spec.apps (the RESOLVED child helm apps) and spec.backup (archive intent) carry the same shapes as the HermesProfile record and are realized by the eve-agent chart, and there is no expose surface - the ingress path set (/eve/ and /.well-known/workflow/) is owned by the platform and never authored. v1alpha2 = v1alpha1 + apps + backup; v1alpha1 records stay valid (both keys are optional).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `spec` | object | **yes** | — | — |

### `spec`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `persona` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; minLength: 1; maxLength: 40 | The installed instance name - identical to the record's directory name under profiles/ and to the Eve project's package.json name. The chart stamps it on every rendered resource as the persona label. |
| `runtime` | const `eve` | **yes** | — | The agent runtime this record deploys. Always `eve` in this schema; the ApplicationSet selects the chart from it. |
| `source` | string | **yes** | minLength: 1 | Git URL the pod clones, e.g. https://github.com/factorylevel/support-agent.git |
| `ref` | string | no | minLength: 1 | Git ref the emit resolved spec.sha from, recorded for provenance - the pod boots from spec.sha, not from this ref. Omitted when the emit named none. |
| `gitAuthSecretRef` | string | no | minLength: 1 | Name of a Kubernetes Secret in the instance's own namespace holding the credential to clone a PRIVATE spec.source (username+password for https, ssh-privatekey for git@/ssh) - from the v5 extension's gitAuthSecretRef. |
| `sourceSubdir` | string | no | pattern: `^(?!/)(?!.*\.\.)[^\\]+$`; minLength: 1 | Subdirectory of spec.source holding the Eve project (package.json + agent/), conventionally agents/<name>. Omit when the repository root is the project. |
| `sha` | string | **yes** | pattern: `^[0-9a-f]{40}$` | Full commit SHA (40 lowercase hex chars) the pod builds. |
| `envRequires` | array of any | no | — | Every environment variable this agent needs, from hermes-gitops.yaml runtime.envRequires. Same entry shape and conservative defaults as the HermesProfile record: a bare string means `required: true, secret: true`. Drives the env Secret mount; the model credential (AI_GATEWAY_API_KEY or a provider key) is declared here like any other. |
| `apps` | array of object | no | uniqueItems | The RESOLVED helm apps this instance launches, in author order - the emitter has already deep-merged author values + fleet defaults + per-instance appValues overrides into `values`, and every `valuesRequired` dot-path was satisfied pre-render (so that field is dropped from the record). The eve-agent chart renders one Argo CD Application per entry (app-of-apps). |
| `deployment` | object | no | — | Agent pod knobs - pod-compute only. |
| `backup` | object | no | — | Backup intent - schedule and retention only; the destination is a platform concern (providers.backup in cluster-values). |
| `env` | object | no | — | The compiled per-instance overlay: resolved capability values the topology compiler injects, layered last by the ApplicationSet. Never authored by hand. |

#### `spec.apps[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | DNS-label app name, unique within the record. |
| `chart` | string | **yes** | minLength: 1 | Chart name in the remote helm repo, or (for `repo: local`) the chart's path inside the platform/GitOps chart tree. |
| `repo` | string | **yes** | pattern: `^(local|https://\S+|oci://\S+)$` | Helm repo URL (https:// or oci://), or the reserved word `local` (chart ships with the platform/GitOps repo). |
| `version` | string | no | minLength: 1 | Chart version - present for remote repos (the Application's targetRevision), absent for `repo: local`. |
| `values` | object | no | — | The fully-merged chart values (author values + fleet defaults + per-instance overrides), inlined. |

#### `spec.deployment`

Agent pod knobs - pod-compute only.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `runtimeImageTag` | string | no | minLength: 1 | Tag of the eve-runtime container image (Node + the pinned eve CLI) this instance builds and runs with; overrides the platform's pinned tag for both the build initContainer and the main container. |
| `diskSizeGb` | integer | no | minimum: 10 | Size in GiB of the instance's data volume claim (the checkout, node_modules and the Eve workflow store). Default when absent: 10. |

#### `spec.backup`

Backup intent - schedule and retention only; the destination is a platform concern (providers.backup in cluster-values).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `schedule` | string | **yes** | minLength: 1 | Cron expression for the CronJob that archives the instance's data volume. |
| `retention` | integer | no | minimum: 1 | How many of the newest archives are kept; older ones are pruned. Default when absent: 7. |

## Example

`agent-bundle-contracts/eveagent/v1alpha2/examples/valid-full.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
spec:
  persona: echo
  runtime: eve
  source: https://github.com/factorylevel/eve-agents.git
  ref: main
  sourceSubdir: agents/echo
  sha: 3f06a1b2c3d4e5f60718293a4b5c6d7e8f901234
  envRequires:
    - AI_GATEWAY_API_KEY
    - name: ECHO_GREETING
      required: false
      secret: false
      description: Greeting prefix the agent uses.
  deployment:
    runtimeImageTag: 0.42.0
    diskSizeGb: 20
  env:
    OBSERVABILITY_URL: http://hermes-observer.hermes-gitops.svc:9090
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/eveagent/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).

