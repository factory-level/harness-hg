<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       cli/schemas/evals/v1alpha2/suite.schema.json
       cli/schemas/evals/v1alpha2/scenario.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Eval suite and scenarios

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

Written by the **team** as `evals/suite.yaml` and `evals/scenarios/*/scenario.yaml`. Optional, and not a deployment contract: read by `hg eval --dir` and by nothing in the cluster.

## `suite` (v1alpha2)

Schema: `cli/schemas/evals/v1alpha2/suite.schema.json` — **Eval suite**

### (root)

Root document of an OPTIONAL evals/ directory consumed only by `hg eval --dir` — an eval-authoring contract for the local CLI, never a deployment contract. Nothing in profile installation, rendering, reconciliation or `hg validate` reads this file; a repo without one is fully valid and deployable. It lives outside plugin/schemas/ on purpose: those are frozen deployment surfaces, this versions with the CLI.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `hermes-gitops.factorylevel.dev/evals/v1alpha2` | **yes** | — | Pins the authoring contract this suite was written against; the runner refuses versions it does not implement instead of guessing. |
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 63 | The suite's name, printed in run output and recorded in the result document. |
| `scenarios` | string | no | pattern: `^(?!/)(?!.*\.\.)[^\\]+$`; minLength: 1 | Directory of scenario subdirectories, relative to the suite root and contained within it. Defaults to `scenarios`. |
| `defaults` | object | no | — | Suite-wide fallbacks a scenario may override; a scenario's own field always wins. |

#### `defaults`

Suite-wide fallbacks a scenario may override; a scenario's own field always wins.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `timeout` | integer | no | minimum: 1; maximum: 3600 | Fallback wall-clock budget in seconds for scenarios that declare no timeout of their own. |
| `repeat` | integer | no | minimum: 1; maximum: 100 | Fallback runs-per-invocation for scenarios that declare no repeat of their own. |

## `scenario` (v1alpha2)

Schema: `cli/schemas/evals/v1alpha2/scenario.schema.json` — **Eval scenario (v1alpha2: typed communication invocation)**

### (root)

One deterministic scenario inside an eval suite. v1alpha2 adds typed communication invocation (invoke: event | events | externalWebhook - the runner owns envelope construction, signing, publication and receipts through the SAME engine hg event uses) and runner-checked destination expectations (expect.outputs). `prompt` and `invoke` are mutually exclusive; `evaluate` becomes optional when `expect` carries the whole assertion. The evaluator exit-code protocol is unchanged: 0 pass, 1 assertion failure, anything else evaluator/harness error.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 63 | Unique within the suite (the runner enforces uniqueness across scenarios; the schema cannot see siblings). |
| `profile` | string | **yes** | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 63 | The deployed profile this scenario addresses — resolved against the onboarded catalogue, never an implicit global agent. |
| `description` | string | no | minLength: 1 | Free-text explanation of what the scenario proves, for readers; the runner does not interpret it. |
| `prompt` | string | no | pattern: `^(?!/)(?!.*\.\.)[^\\]+$`; minLength: 1 | Path (relative to the scenario directory, contained within it) to a prompt file the runner sends to the profile before the evaluator runs; the response lands at $HG_EVAL_RESPONSE. Omit when the evaluator owns the invocation itself (webhook, relay, cron). Mutually exclusive with invoke. |
| `evaluate` | string | no | pattern: `^(?!/)(?!.*\.\.)[^\\]+$`; minLength: 1 | Path (relative to the scenario directory, contained within it) to the deterministic evaluator executable. Repository-owned code: untrusted (cloned) sources require --allow-repo-scripts. Optional when expect: carries the whole assertion; required otherwise. |
| `timeout` | integer | no | minimum: 1; maximum: 3600 | Hard wall-clock budget in seconds for one run, prompt included. Defaults to the suite's, then 300. |
| `repeat` | integer | no | minimum: 1; maximum: 100 | Runs per invocation, each recorded independently — for surfacing nondeterminism by hand, not for retry-until-green. |
| `required` | boolean | no | — | Defaults to true. false makes the scenario informational: it runs and reports but never fails the suite. |
| `setup` | array of string | no | — | Shell commands run in order from the scenario directory before each run. Repository-owned code, trust-gated like `evaluate`. |
| `cleanup` | array of string | no | — | Shell commands run from the scenario directory after each run — ALWAYS, including on timeout and evaluator crash. |
| `invoke` | object | no | — | Typed communication invocation, executed by the runner BEFORE the evaluator through the same engine as hg event emit / ingress test. Exactly one form. |
| `expect` | object | no | — | Runner-checked expectations against the invocation's terminal receipts - infrastructure truths (which destinations accepted). Business behavior stays in the evaluator. |

#### `invoke`

Typed communication invocation, executed by the runner BEFORE the evaluator through the same engine as hg event emit / ingress test. Exactly one form.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `event` | object | no | — | Publish one event from a payload file through the communication engine. |
| `events` | object | no | — | A FIFO sequence: payloads emitted in order through the same producer. |
| `externalWebhook` | object | no | — | Deliver a signed request to a declared external webhook binding, exercising the gateway's verification path - including its negative modes. |

##### `invoke.event`

Publish one event from a payload file through the communication engine.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | minLength: 1 | Event type, version suffix optional (observability.alert matches observability.alert/v1). |
| `from` | string | no | minLength: 1 | Producer as <profile>/<app>#<output>; required only when the event has several producers. |
| `payload` | string | **yes** | pattern: `^(?!/)(?!.*\.\.)[^\\]+$`; minLength: 1 | Payload JSON file, relative to the scenario directory and contained within it. |
| `toAgent` | string | no | — | Narrow the fan-out to one agent profile. |
| `toChatops` | string | no | — | Narrow the fan-out to one ChatOps space. |

##### `invoke.events`

A FIFO sequence: payloads emitted in order through the same producer.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | minLength: 1 | Event type, version suffix optional (observability.alert matches observability.alert/v1). |
| `from` | string | no | minLength: 1 | Producer as <profile>/<app>#<output>; required only when the event has several producers. |
| `orderingKey` | string | no | minLength: 1 | Override the producer's subject with this value in every payload - the whole sequence shares one ordering group. |
| `payloads` | array of string | **yes** | minItems: 1 | Ordered payload files; one event is emitted per file, first to last. |

##### `invoke.externalWebhook`

Deliver a signed request to a declared external webhook binding, exercising the gateway's verification path - including its negative modes.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `binding` | string | **yes** | minLength: 1 | An externalInputs[] name declared by the repository. |
| `payload` | string | **yes** | pattern: `^(?!/)(?!.*\.\.)[^\\]+$`; minLength: 1 | Payload JSON file, relative to the scenario directory and contained within it. |
| `signature` | string | no | enum: `valid`, `invalid`, `missing`, `stale` | Default valid. |
| `duplicate` | boolean | no | — | Send the identical signed request twice; the second must be rejected as a replay. |

#### `expect`

Runner-checked expectations against the invocation's terminal receipts - infrastructure truths (which destinations accepted). Business behavior stays in the evaluator.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `outputs` | array of object | no | minItems: 1 | Destinations that must show an accepted terminal receipt; any listed destination without one fails the scenario. |
| `rejected` | object | no | — | For negative externalWebhook modes: the request must be rejected with exactly this reason, and nothing may be delivered. |

##### `expect.outputs[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `agent` | object | no | — | An agent destination: the named profile must show an accepted delivery receipt. |
| `chatops` | string | no | minLength: 1 | <alias>#<destination> |

###### `expect.outputs[].agent`

An agent destination: the named profile must show an accepted delivery receipt.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `profile` | string | **yes** | minLength: 1 | The agent profile name. |

##### `expect.rejected`

For negative externalWebhook modes: the request must be rejected with exactly this reason, and nothing may be delivered.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `reason` | string | **yes** | minLength: 1 | The gateway's classification (invalid-signature, stale-signature, replay, ...). |

## Example

`cli/schemas/evals/v1alpha2/examples/suite/valid-minimal.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# Valid: the smallest legal suite — scenarios/ dir and all defaults implied.
apiVersion: hermes-gitops.factorylevel.dev/evals/v1alpha2
name: persona-echo-evals
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `cli/schemas/evals/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [eval](../cli/eval.md)

