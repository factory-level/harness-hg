<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/agent-runtime/v1alpha1/agent-runtime.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Agent runtime manifest

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

**Generated**, and purely descriptive: what one deployed agent got. Engine, resolved source revision, every workspace with the path the pod reads it at, the env variable names it needs, and its bound connections. The eve charts render it into a ConfigMap at `/hg/runtime-manifest.json`; `hg agent inspect` computes the same document offline, and `hg agent prove` compares the two. Names only; no value ever enters it.

Schema: `agent-bundle-contracts/agent-runtime/v1alpha1/agent-runtime.schema.json` — **Agent runtime manifest (/hg/runtime-manifest.json)**

## (root)

GENERATED, and purely DESCRIPTIVE: what one deployed agent actually got. Nothing reads it to decide behaviour, and it must never grow into a second configuration language - every field it carries is already stated somewhere authoritative, and this record is the join.

Two producers write it from one definition: the eve-agent and eve-bundle charts render it into a ConfigMap mounted read-only at /hg/runtime-manifest.json, and `hg agent inspect|render` computes it offline from the same value documents the ApplicationSet layers. `hg eve prove` EVE022 compares the two and names the field that differs, so a drift between chart and CLI is a failing proof rather than a surprise in production.

A ConfigMap rather than a file the boot script writes, because it must answer from the API server while the pod is down or crash-looping - which is when "what did this agent get" is usually the question.

NAMES ONLY. `requiredSecrets` carries variable names and `connections` carries connection and provider names; no value, token or key ever enters this object, because it is a ConfigMap in the agent's namespace and readable by anything that can read that namespace.

Plain values under a single `spec` block, the platform's record convention - no apiVersion, no kind, no CRD.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `contract` | const `agent-runtime/v1alpha1` | **yes** | — | The contract this document claims to be. A bump is a new schema directory, like every other frozen contract here. |
| `spec` | object | **yes** | — | — |

### `spec`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | minLength: 1 | The agent's own name - the profile name, and the record's directory name. |
| `engine` | any | **yes** | enum: `eve`, `hermes` | Which AI harness runs this agent. The first thing a reader of this document needs, and the reason the shape is shared across runtimes at all. |
| `instance` | string | **yes** | minLength: 1 | The Kubernetes-facing identity: `hermes-<name>` or `ag-eve-<name>` standalone, `<bundle-application>-<member>` for a bundled member. |
| `namespace` | string | **yes** | minLength: 1 | The namespace the workload runs in - the bundle's, for a bundled member. |
| `bundle` | string | no | minLength: 1 | The bundle this agent is a member of. ABSENT when the agent is deployed standalone - never an empty string, so "is this bundled" is a key test rather than a value test. |
| `runtimeImage` | string | **yes** | — | The container image the agent process runs, as deployed - including a local-loop dev build, which is the point: the manifest says what runs, not what would run elsewhere. |
| `source` | object | **yes** | — | Where the agent's code came from, resolved. The pod clones this at boot; nothing materializes a second copy. |
| `workspaces` | array of object | **yes** | — | Bound code workspaces, sorted by name. `path` is where the agent actually reads the checkout INSIDE the pod, which is not always the binding's authored mountPath: a standalone Eve agent mounts under /app/workspaces (on its data claim), a bundle honours mountPath at its shared /workspaces claim. Reporting the real path is the whole point. |
| `requiredSecrets` | array of string | **yes** | — | Environment variable NAMES the record requires, sorted and de-duplicated. Never values. |
| `connections` | array of object | **yes** | — | Third-party app registrations bound to this agent, sorted by name. Names only - the credentials live in the platform Secret the projection reads. |
| `apps` | array of string | **yes** | — | Child Helm applications the agent's own chart deploys, sorted. Empty for a bundled member by design: its apps deploy from deployments/apps, not from the bundle chart (EVE020). |

#### `spec.source`

Where the agent's code came from, resolved. The pod clones this at boot; nothing materializes a second copy.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | string | **yes** | — | The git URL the pod clones. |
| `revision` | string | **yes** | — | The resolved commit. A full 40-character sha for anything deployed; the field is a plain string so a manifest rendered from a placeholder record is still readable rather than unrenderable. |
| `subdir` | string | no | minLength: 1 | The agent's directory within the repository (a monorepo of agents). Absent when the repository root IS the project. |

#### `spec.workspaces[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | minLength: 1 | — |
| `path` | string | **yes** | pattern: `^/` | — |
| `access` | any | **yes** | enum: `read-only`, `read-write` | — |
| `repository` | string | **yes** | — | — |
| `revision` | string | **yes** | — | — |

#### `spec.connections[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | minLength: 1 | — |
| `provider` | string | **yes** | minLength: 1 | — |

## Example

`agent-bundle-contracts/agent-runtime/v1alpha1/examples/valid-full.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# A standalone Eve agent with everything the platform can bind: a code
# workspace at the path the pod actually reads it from, the env NAMES its
# record requires, two connections and one child app.
contract: agent-runtime/v1alpha1
spec:
  name: echo
  engine: eve
  instance: ag-eve-echo
  namespace: ag-eve-echo
  runtimeImage: ghcr.io/example/eve-runtime:0.42.0
  source:
    repository: https://github.com/factorylevel/eve-agents.git
    revision: 3f06a1b2c3d4e5f60718293a4b5c6d7e8f901234
    subdir: agents/echo
  workspaces:
    - name: own-source
      path: /app/workspaces/own-source
      access: read-only
      repository: https://github.com/factorylevel/eve-agents.git
      revision: 3f06a1b2c3d4e5f60718293a4b5c6d7e8f901234
  requiredSecrets:
    - AI_GATEWAY_API_KEY
    - DISCORD_BOT_TOKEN
  connections:
    - name: company-discord
      provider: discord
    - name: platform-github
      provider: github
  apps:
    - docs-site
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/agent-runtime/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [agent](../cli/agent.md)

