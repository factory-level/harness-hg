<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/agent-skills/v1alpha1/manifest.schema.json
       agent-bundle-contracts/agent-skills/v1alpha1/lock.schema.json
       agent-bundle-contracts/agent-skills/v1alpha1/approvals.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Agent skills

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Per-agent external skill installation manifests and immutable content locks. The team owns skills.yaml and skills.lock.yaml; the bootstrap owns human approval records. The CLI stages reviews, installs approved source packages, and verifies them offline.

## `manifest` (v1alpha1)

Schema: `agent-bundle-contracts/agent-skills/v1alpha1/manifest.schema.json` — **AgentSkills**

### (root)

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-skills/v1alpha1` | **yes** | — | — |
| `kind` | const `AgentSkills` | **yes** | — | — |
| `skills` | array of object | **yes** | — | — |

#### `skills[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z][a-z0-9-]{0,62}$` | — |
| `source` | object | **yes** | — | — |
| `resources` | array of string | **yes** | uniqueItems | — |
| `tools` | array of string | **yes** | uniqueItems | — |
| `executables` | array of string | **yes** | uniqueItems | — |
| `writes` | array of string | **yes** | uniqueItems | — |
| `scenario` | string | **yes** | minLength: 1 | — |

##### `skills[].source`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | string | **yes** | pattern: `^(https://[^/@\s]+/[^\s?#]+|git@[^:\s]+:[^\s]+)$` | — |
| `root` | string | **yes** | minLength: 1 | — |
| `entrypoint` | string | **yes** | minLength: 1 | — |
| `ref` | any | **yes** | — | — |

## `lock` (v1alpha1)

Schema: `agent-bundle-contracts/agent-skills/v1alpha1/lock.schema.json` — **AgentSkillsLock**

### (root)

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-skills/v1alpha1` | **yes** | — | — |
| `kind` | const `AgentSkillsLock` | **yes** | — | — |
| `manifest` | string | **yes** | pattern: `^[a-f0-9]{64}$` | — |
| `skills` | array of object | **yes** | — | — |

#### `skills[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z][a-z0-9-]{0,62}$` | — |
| `source` | object | **yes** | — | — |
| `commit` | string | **yes** | pattern: `^[a-f0-9]{40}$` | — |
| `hash` | string | **yes** | pattern: `^[a-f0-9]{64}$` | — |

##### `skills[].source`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `repository` | string | **yes** | pattern: `^(https://[^/@\s]+/[^\s?#]+|git@[^:\s]+:[^\s]+)$` | — |
| `root` | string | **yes** | minLength: 1 | — |
| `entrypoint` | string | **yes** | minLength: 1 | — |
| `ref` | any | **yes** | — | — |

## `approvals` (v1alpha1)

Schema: `agent-bundle-contracts/agent-skills/v1alpha1/approvals.schema.json` — **SkillApprovals**

### (root)

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/agent-skills/v1alpha1` | **yes** | — | — |
| `kind` | const `SkillApprovals` | **yes** | — | — |
| `approvals` | array of object | **yes** | — | — |

#### `approvals[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `subject` | string | **yes** | minLength: 1 | — |
| `fingerprint` | string | **yes** | pattern: `^[a-f0-9]{64}$` | — |
| `approvedBy` | string | **yes** | minLength: 1 | — |
| `approvedAt` | string | **yes** | pattern: `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$` | — |

## Example

`agent-bundle-contracts/agent-skills/v1alpha1/examples/manifest/valid-shared-resources.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
{
  "apiVersion": "hermes-gitops.factorylevel.dev/agent-skills/v1alpha1",
  "kind": "AgentSkills",
  "skills": [
    {
      "name": "research",
      "source": {
        "repository": "https://github.com/example/skills",
        "root": "plugin",
        "entrypoint": "skills/research/SKILL.md",
        "ref": {
          "tag": "v1.0.0"
        }
      },
      "resources": [
        "references"
      ],
      "tools": [
        "search"
      ],
      "executables": [],
      "writes": [],
      "scenario": "research-pass"
    }
  ]
}
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/agent-skills/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [skills](../cli/skills.md)
- [agent skills](../../get-started/agent-skills.md)

