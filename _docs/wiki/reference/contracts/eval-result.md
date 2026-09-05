<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/eval-result/v1alpha1/eval-result.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Eval result batch

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

The body of `POST /nexus/evals/publish`. Frozen because it is the contract an **external harness** targets: anything that can produce this document can publish results without using the CLI.

Schema: `agent-bundle-contracts/eval-result/v1alpha1/eval-result.schema.json` — **EvalResultBatch**

## (root)

One publish of agent eval results. This is the contract an EXTERNAL harness targets, which is why it is frozen here rather than being an internal shape: the CLI validates against this file with ajv and the control plane validates against a hand-written mirror of it, and a test asserts the two agree. Nothing here may carry a filesystem path or secret-bearing evidence - a published result is browser-visible by design.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes.dev/eval-result/v1alpha1` | **yes** | — | Frozen. An unknown version is refused loudly rather than guessed at - the house posture in place of a migration framework. |
| `records` | array of any | **yes** | minItems: 1 | — |

## Example

`agent-bundle-contracts/eval-result/v1alpha1/examples/eval-result/valid-minimal.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# The smallest honest publish: everything optional omitted. A result with
# no score is still a result - `pass` is the claim, a number is not
# required to make it.
apiVersion: hermes.dev/eval-result/v1alpha1
records:
  - runId: run-1
    componentId: marketing-sre
    suite: sre-behaviour
    scenario: acknowledges-alert
    status: pass
    harness: local-harness
    ranAt: "2026-08-01T07:00:00Z"
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/eval-result/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [eval](../cli/eval.md)

