<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/bundle-destination/v1alpha1/destination.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Bundle destination

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Authored by the **agent-team repository** as `harness-hg/destination.yaml` (written by `hg bundle init`): where this repo's emitted records go. `hg topology emit` reads it as the default destination when no `--output` names one.

Schema: `agent-bundle-contracts/bundle-destination/v1alpha1/destination.schema.json` — **Bundle destination**

## (root)

The `harness-hg/destination.yaml` file at an agent-team repo's root (the `.harness-hg/` dot-directory was never built - `hg bundle init` #673 wrote there until and that path stays readable): where THIS repo's emitted records go. `hg topology emit` reads it as the default destination when no --output flag names one, so an author can emit without re-typing the GitOps repo every time. Authored by bundle repos - the right tenant for a frozen agent-bundle contract.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/bundle-destination/v1alpha1` | **yes** | — | Pins the contract; the CLI refuses versions it does not implement. |
| `gitops` | object | **yes** | — | — |

### `gitops`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repoUrl` | string | **yes** | pattern: `^(https://|git@|ssh://|file://)`; minLength: 1 | The GitOps destination repository the emitted records are pushed to. A URL, never a local path - the destination is shared truth, not a working copy. |
| `branch` | string | no | minLength: 1 | Branch the records land on. Default main. |

## Example

`agent-bundle-contracts/bundle-destination/v1alpha1/examples/valid-minimal.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
apiVersion: hermes-gitops.factorylevel.dev/bundle-destination/v1alpha1
gitops:
  repoUrl: https://github.com/example/persona.gitops.git
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/bundle-destination/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).

