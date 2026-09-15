<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/eveagent/v1alpha3/eveagent.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# EveAgent record

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

**Generated** by the emitter for an Eve agent: `profiles/<name>/profile.yaml`, plain Helm values for the `eve-agent` chart, never a custom resource. `spec.runtime: eve` is what the agents ApplicationSet routes on. v1alpha2 adds `spec.apps` and `spec.backup`; v1alpha3 adds `spec.overlays` and `spec.overlayTreeHash`, the approved operator overlays, present only when an installation declares them. Older records stay valid.

Schema: `agent-bundle-contracts/eveagent/v1alpha3/eveagent.schema.json` — **EveAgent record v1alpha3 (profiles/<name>/profile.yaml for an Eve agent)**

## (root)

PLAIN HELM VALUES for the eve-agent chart, not a Kubernetes custom resource (there is no EveAgent CRD). The record's identity is its directory name. An Eve agent (the Vercel `eve` framework) is authored as an npm project - package.json plus an agent/ directory - at agents/<name>/ in its source repository, with hermes-gitops.yaml (contractVersion 5, runtime.kind eve) beside package.json. The emitter renders this record from that project at one commit; the pod clones spec.source at spec.sha, runs `npm ci` and `eve build`, and serves the built Nitro server with `eve start`. Compared with the HermesProfile record: spec.runtime is the discriminator the ApplicationSet routes on, env requirements come from hermes-gitops.yaml rather than a distribution manifest, spec.apps (the RESOLVED child helm apps) and spec.backup (archive intent) carry the same shapes as the HermesProfile record and are realized by the eve-agent chart, and there is no expose surface - the ingress path set (/eve/ and /.well-known/workflow/) is owned by the platform and never authored. v1alpha2 = v1alpha1 + apps + backup. v1alpha3 = v1alpha2 + overlays + overlayTreeHash (approved operator overlays), emitted only when an installation declares overlays for the agent; v1alpha2 and v1alpha1 records stay valid (every added key is optional).

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
| `overlays` | array of object | no | minItems: 1 | Operator overlays in application order: source-level overlays first, then agent-level, each in declared order. Compiled by the team compiler from the bootstrap installation plan after human approval, never authored by hand, and emitted only when at least one exists. The build container fetches each source at its commit, verifies contentHash, applies the entries in order with the platform merge implementation, verifies overlayTreeHash over the merged agent/ tree, and only then builds. |
| `overlayTreeHash` | string | no | pattern: `^[a-f0-9]{64}$` | SHA-256 over the merged agent/ directory after every overlay is applied, in the same encoding as contentHash: for every regular file in sorted relative-path order, the byte length and bytes of its path, then the byte length and bytes of its contents. The build container refuses a merged tree that differs. Present exactly when overlays is. |

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

#### `spec.overlays[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `id` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | DNS-label overlay id, unique within the record. |
| `kind` | any | **yes** | enum: `skill`, `tool`, `connection`, `instructions`, `file` | What the overlay changes. skill targets agent/skills/<name>[.md]; tool targets agent/tools/<slug>.(ts|js|mjs); connection targets agent/connections/<name>.(ts|js|mjs); instructions targets agent/instructions.md; file targets any other allowed path under agent/; it never targets skills or instructions, and at agent/tools or agent/connections, or anywhere below them, it may only remove. |
| `mode` | any | **yes** | enum: `append`, `override`, `remove` | append adds an absent target (instructions: appends provenance-marked text); override replaces an existing target; remove deletes an existing target, and for a tool writes Eve's disable stub so the framework tool stays off. |
| `target` | string | **yes** | pattern: `^(?!.*(^|/)\.\.?(/|$))(?!.*//)(?!.*(^|/)(package\.json|package-lock\.json|node_modules|\.eve|\.output|\.git)(/|$))(?!agent/(agent|sandbox)\.(ts|js|mjs)$)(?!agent/channels(/|$))agent/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$`; maxLength: 256 | Path inside the Eve project the overlay writes, always under agent/. The agent definition, the sandbox, channels, package files, node_modules, .eve, .output and .git are never targets, and no segment may be . or .. |
| `source` | object | no | — | Where the overlay content comes from. Absent for remove. |
| `contentHash` | string | no | pattern: `^[a-f0-9]{64}$` | SHA-256 over the content at source.path at source.commit: for every regular file in sorted relative-path order, the byte length and bytes of its path, then the byte length and bytes of its contents (a single file is named by its basename). The build container refuses different content. |
| `gitAuthSecretRef` | string | no | pattern: `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`; maxLength: 253 | Name of a Secret in the instance namespace holding the credential to fetch a PRIVATE source (username+password for https, ssh-privatekey for git@). |

##### `spec.overlays[].source`

Where the overlay content comes from. Absent for remove.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | string | **yes** | pattern: `^(https://[^/@\s?#]+/[^\s?#@]+|git@[^:\s]+:\S+)$` | Credential-free Git URL (https:// or git@host:path), with no user info, query or fragment. |
| `commit` | string | **yes** | pattern: `^[0-9a-f]{40}$` | Full commit SHA the content is fetched at. |
| `path` | string | **yes** | pattern: `^(\.|(?!/)(?!.*(^|/)\.\.?(/|$))(?!.*//)[A-Za-z0-9._/-]*[A-Za-z0-9._-])$`; maxLength: 256 | File or directory inside the repository at commit, or . for its root. |

## Example

`agent-bundle-contracts/eveagent/v1alpha3/examples/valid-full.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

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

