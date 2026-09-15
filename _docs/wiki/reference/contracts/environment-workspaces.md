<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/environment-workspaces/v1alpha2/workspaces.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Environment workspaces

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Written by the **team** as `harness-hg/workspaces.yaml` (`kind: WorkspaceBindings`): Git checkouts assigned to agents, each pinned to a commit, resolved from a deployed application, or (v1alpha2) tracked on a branch and refreshed in the running pod. A repository reaches an agent only when a binding names both. The default is nothing. v1alpha1 documents stay valid.

Schema: `agent-bundle-contracts/environment-workspaces/v1alpha2/workspaces.schema.json` — **Hermes workspace repository bindings**

## (root)

Operator-authored, deployment-neutral assignment of Git checkouts to Hermes profiles. A repository is available to a profile only when a binding names both; bundle membership, distribution source, credentials, prompts, and event sources grant nothing. The default access for every profile is none. A checkout is pinned to a commit, resolved from a deployed application, or (new in v1alpha2) tracked on a branch and refreshed in the running pod. In an agent-team repository this file lives at `harness-hg/workspaces.yaml`; the legacy path stays readable for repositories not yet migrated.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes.gitops/v1alpha2` | **yes** | — | Contract identifier this document is validated against; unknown versions are refused loudly. |
| `kind` | const `WorkspaceBindings` | **yes** | — | Document kind - always WorkspaceBindings. |
| `repositories` | array of object | **yes** | minItems: 1 | The catalogue of mountable repositories. Declaring one grants nothing: a repository reaches a profile only through a binding. |
| `bindings` | array of object | **yes** | minItems: 1 | Explicit repository-to-profile grants - the only thing that makes a repository reach a profile, independent of bundle membership. |

### `repositories[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | any | **yes** | — | Short name bindings reference this repository by. |
| `source` | any | **yes** | — | Where the checkout comes from: self (the bound profile's own distribution repository) or an explicit url with a pinned, application-resolved or tracked revision. |
| `mount` | object | **yes** | — | Where and how the checkout appears inside a granted profile's runtime. |

#### `repositories[].mount`

Where and how the checkout appears inside a granted profile's runtime.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `path` | string | **yes** | pattern: `^/workspaces/\.?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(/\.?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)*$` | Absolute mount path under /workspaces/ the checkout appears at. |
| `access` | string | **yes** | enum: `read-only`, `read-write` | Whether the profile can write to the checkout: read-only or read-write. |

### `bindings[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | any | **yes** | — | Name of a declared repository this binding grants. |
| `profiles` | array of any | **yes** | minItems: 1; uniqueItems | The profiles granted this repository's mount. |
| `purpose` | any | **yes** | — | Short label naming why the grant exists (e.g. strategy-context); carried through to the compiled binding. |

## Example

`agent-bundle-contracts/environment-workspaces/v1alpha2/examples/workspaces/valid-tracked.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# A tracked repository: brand and company documents whose release channel is
# the main branch. The pod clones the tip at boot and refreshes it every 30
# minutes without restarting; a pinned repository sits beside it unchanged.
apiVersion: hermes.gitops/v1alpha2
kind: WorkspaceBindings

repositories:
  - name: vision
    source:
      url: https://github.com/organization/vision-manager.git
      revision:
        mode: tracked
        branch: main
        refreshInterval: 30m
      authSecretRef: vision-git-auth
    mount:
      path: /workspaces/vision-manager
      access: read-only

  - name: strategy-context
    source:
      url: git@github.com:organization/strategy-context.git
      revision:
        mode: pinned
        sha: 0123456789abcdef0123456789abcdef01234567
      authSecretRef: hermes-strategy-context-git
    mount:
      path: /workspaces/strategy-context
      access: read-only

bindings:
  - repository: vision
    profiles: [marketing-manager, marketing-research]
    purpose: brand-context
  - repository: strategy-context
    profiles: [marketing-manager]
    purpose: strategy-context
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/environment-workspaces/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [workspace](../cli/workspace.md)

