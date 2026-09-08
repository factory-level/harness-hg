<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/lifecycle-record/v1alpha1/lifecycle-record.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Lifecycle record

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

> This frozen contract includes historical Discord syntax. Current loaders and runtimes reject Discord integrations; they are roadmap-only. Schema acceptance alone does not establish current provider support.

The shared telemetry envelope (#349): one record shape for every plane that emits lifecycle telemetry — the Discord gateway, the native cron scheduler, the event router, alerting, and agent and tool execution. Carries **metadata only**, never message content; a digest stands in for the payload.

Schema: `agent-bundle-contracts/lifecycle-record/v1alpha1/lifecycle-record.schema.json` — **Lifecycle record**

## (root)

ONE record shape for every plane that emits lifecycle telemetry (#349): the Discord gateway, the native cron scheduler, the event router, alerting, and agent and tool execution.

Deliberately transport-agnostic. The planes do not share a bus, a store or a delivery mechanism, and forcing them onto one would couple their failure domains - the point of the shared envelope is that a trace can be FOLLOWED across them, not that they become one system. A record is a fact about something that happened; where it is written is the emitter's business.

Metadata only. Payloads never enter a record: `redactedSource` and `redactedTarget` carry references, and a digest carries content-identity without content. That is a schema-level guarantee rather than a convention, because the debug observer writes these to disk.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `version` | const `1` | **yes** | — | Envelope version. A bump is a new schema directory, like every other frozen contract here. |
| `recordId` | string | **yes** | pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` | This record, uniquely. A UUID rather than a sequence: records are emitted by several processes that share no counter. |
| `traceId` | string | **yes** | pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` | The whole causal chain, from the first inbound event to the last delivery. `hg event status --correlation <id>` selects on exactly this. |
| `correlationId` | string | no | minLength: 1; maxLength: 200 | The external identity a trace corresponds to - a Discord message id, an Alertmanager fingerprint, a cron job name. What an operator holds when they arrive asking about a specific thing. |
| `causationId` | string | no | pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` | The `recordId` of the record that DIRECTLY caused this one. traceId groups; causationId orders - without it a trace is a bag of events and the tree cannot be rebuilt. |
| `plane` | string | **yes** | enum: `gateway`, `cron`, `router`, `alert`, `agent`, `tool` | Which subsystem emitted this. Closed: a new plane is a deliberate contract change, not something a new emitter can introduce by writing an unfamiliar string. |
| `type` | string | **yes** | pattern: `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`; maxLength: 64 | Dotted event name within the plane - `cron.triggered`, `tool.failed`, `agent.completed`. Not enumerated: the ladder is owned by each plane and a frozen list here would make adding a lifecycle step a schema bump. |
| `occurredAt` | string | **yes** | — | When the thing happened, as the emitter saw it. RFC 3339, always UTC. |
| `recordedAt` | string | no | — | When the observer wrote it down. Separate from occurredAt on purpose: the gap IS the observer's lag, and collapsing them hides a backed-up sink. |
| `durationMs` | integer | no | minimum: 0 | For a completion record, how long the thing took. |
| `outcome` | string | no | enum: `success`, `failure`, `refused`, `timeout` | Terminal records only. `refused` is distinct from `failure`: an unauthorized actor or a disabled job is a working system saying no, and lumping it with breakage makes both unreadable. |
| `deploymentRevision` | string | no | minLength: 1; maxLength: 200 | What was running when this happened - a profile record sha, a chart revision. Without it a trace from last week cannot be attributed to the code that produced it. |
| `profile` | string | no | pattern: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; maxLength: 40 | The agent profile this record belongs to, where one applies. |
| `redactedSource` | any | no | — | Where this came from, as a reference. |
| `redactedTarget` | any | no | — | Where it went, as a reference. |
| `digest` | string | no | pattern: `^sha256:[0-9a-f]{64}$` | Content identity WITHOUT content. Proves two records concern the same message, or that a delivered body matches a sent one, while carrying nothing quotable. |
| `testRun` | string | no | minLength: 1; maxLength: 200 | Marks a record as belonging to a deliberate proof run (`hg communication prove`, `hg cron run`). Present means a HUMAN OR HARNESS asked for this; absent means it happened on its own. `hg cron` uses exactly this to tell a manual trigger from an autonomous one, which is #349's exit proof. |
| `detail` | object | no | — | Plane-specific scalars - a job name, an exit code, a queue depth. Scalars only, and bounded: a nested object here is how a payload gets smuggled into a record that promises not to carry one. |

## Example

`agent-bundle-contracts/lifecycle-record/v1alpha1/examples/valid-cron-triggered.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# A scheduled trigger with no human behind it - `testRun` absent is what
# makes it autonomous, which is half of #349's exit proof.
version: 1
recordId: 4f8c1a2e-3b7d-4c9e-8a1f-0b2c3d4e5f60
traceId: 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d
plane: cron
type: cron.triggered
occurredAt: "2026-08-12T02:00:00Z"
recordedAt: "2026-08-12T02:00:00.412Z"
correlationId: communication-proof
deploymentRevision: "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5"
profile: manager
redactedTarget:
  kind: job
  ref: communication-proof
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/lifecycle-record/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).

