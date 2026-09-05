<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/environment-topology/v1alpha1/topology.schema.json
       agent-bundle-contracts/environment-topology/v1alpha1/policy.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Environment topology and policy

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Written by the **operator**. `environment/topology.yaml` says what the environment is: layout, regions, targets, DNS. `environment/policy.yaml` says what it allows: the chart-source allowlist. Both are read by `hg topology`.

## `topology` (v1alpha1)

Schema: `agent-bundle-contracts/environment-topology/v1alpha1/topology.schema.json` — **Environment topology (environment/topology.yaml)**

### (root)

Operator-owned declaration of what the environment IS: the selected layout, sovereignty mode, DNS domains, and the region/target tree the topology compiler places instances onto. Lives in the GitOps repository beside environment/policy.yaml. This file never names an application - profiles declare what they support (hermes-gitops.yaml contractVersion 2), this file declares what exists, and the compiler is the only thing that combines them. Cross-file rules the schema cannot express (globalTarget names a declared target; argoDestination names a registered Argo CD cluster; jurisdictions satisfy policy.yaml) are compiler validations with stable TOPO rule ids.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | const `1` | **yes** | — | Environment topology contract version. |
| `name` | string | no | minLength: 1 | Optional human name for this environment (e.g. production). |
| `layout` | string | **yes** | enum: `single`, `replicated`, `hub-spoke` | The selected layout. Must be within every deployed profile's supportedLayouts (TOPO001). single collapses every multiplicity to one instance on the sole target. |
| `sovereignty` | object | no | — | How strictly the compiler polices cross-region data movement and jurisdictions. |
| `dns` | object | no | — | Base domains canonical endpoint hostnames are projected under. Absent: no public URLs are planned and private endpoints resolve to Kubernetes DNS. |
| `globalTarget` | string | no | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | The target that hosts singleton components (the hub in hub-spoke). Must name a declared target. Required by the compiler whenever any deployed component is a singleton (TOPO002). |
| `regions` | array of object | **yes** | minItems: 1 | The region/target tree the compiler places instances onto. A region is a jurisdiction boundary holding one or more deployment targets. |

#### `sovereignty`

How strictly the compiler polices cross-region data movement and jurisdictions.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `mode` | string | no | enum: `permissive`, `strict` | permissive: cross-region bindings allowed but every one is labelled in the plan. strict: any cross-region dependency, stretched regional data boundary, or disallowed jurisdiction is a compile ERROR (TOPO006/TOPO007/TOPO012). Default: permissive. |

#### `dns`

Base domains canonical endpoint hostnames are projected under. Absent: no public URLs are planned and private endpoints resolve to Kubernetes DNS.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `publicBaseDomain` | string | no | minLength: 1 | Base domain under which canonical public hostnames are projected (two-label scheme: <endpoint>.<component>-<profile>-<scope>.<base>). Absent: no public URLs are planned. |
| `privateBaseDomain` | string | no | minLength: 1 | Base domain for `private` endpoints. Absent: private endpoints resolve to Kubernetes DNS. |

#### `regions[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | DNS-label region name; becomes the <scope> of per-region instances. |
| `jurisdiction` | string | **yes** | minLength: 2 | Legal jurisdiction of every target in this region (e.g. CA, EU). Checked against policy.yaml allowedJurisdictions (TOPO007). |
| `targets` | array of object | **yes** | minItems: 1 | The deployment targets in this region - the cells instances land on, each mapped to a registered Argo CD cluster. |

##### `regions[].targets[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | Stable target name; becomes the <scope> of per-target instances and the environment/targets/<name>/values.yaml directory. |
| `argoDestination` | string | **yes** | minLength: 1 | Name of the registered Argo CD cluster this target deploys to (a cluster Secret; `in-cluster` for the control-plane cluster). Multiple targets may share one cluster as separate deployment cells - namespaces and identities stay distinct. |
| `primary` | boolean | no | — | The region's primary target - where per-region instances land when the region has several targets. Default: the first target. |

## `policy` (v1alpha1)

Schema: `agent-bundle-contracts/environment-topology/v1alpha1/policy.schema.json` — **Environment policy (environment/policy.yaml)**

### (root)

Operator-owned declaration of what the environment ALLOWS. The compile-time authority for the chart-source allowlist (the Argo CD AppProject's sourceRepos is maintained separately: platform entries templated by the scaffold, remote-chart entries operator-authored in cluster-values) and for the jurisdictions profiles may be placed into. The compiler validates every app's chart source against allowedChartSources before any deployment record is generated (TOPO008) and every target's jurisdiction against allowedJurisdictions (TOPO007).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `allowedChartSources` | array of string | no | uniqueItems | Remote chart sources apps may reference. Absent or empty: only `repo: local` charts are allowed. |
| `allowedJurisdictions` | array of string | no | minItems: 1; uniqueItems | Jurisdictions targets may declare. Absent: every declared jurisdiction is allowed. |

## Example

`agent-bundle-contracts/environment-topology/v1alpha1/examples/topology/valid-single.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# The default environment every bare repo compiles under: one target,
# permissive, no DNS - the shape `hg topology` synthesizes when no
# environment files exist.
version: 1
layout: single
regions:
  - name: local
    jurisdiction: NA
    targets:
      - name: in-cluster
        argoDestination: in-cluster
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/environment-topology/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [topology](../cli/topology.md)

