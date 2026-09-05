<!-- GENERATED FILE — DO NOT HAND-EDIT.
     Sources:
       agent-bundle-contracts/runtime-overlay/v1alpha2/overlay.schema.json
       agent-bundle-contracts/runtime-overlay/v1alpha3/platform-backup-status.schema.json
       agent-bundle-contracts/runtime-overlay/v1alpha1/reconciliation-status.schema.json
     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);
     `make docs-drift` (part of `make test`) fails on stale. -->

# Runtime overlay and status records

**What this page tells you:** every field of this contract, with types, constraints and defaults — generated from the frozen schema, so it cannot drift from what validates.

**Runtime, not files** — never committed. The overlay is the response of `GET /nexus/health`: every operational source reports through the same shape, so a source nobody configured reads `unknown` rather than green. The two status records are ConfigMaps (`hermes-platform-backup-status`, `hermes-reconciliation-status`) published by the host-side timers for Nexus to read.

## `overlay` (v1alpha2)

Schema: `agent-bundle-contracts/runtime-overlay/v1alpha2/overlay.schema.json` — **Normalized runtime overlay (GET /nexus/health)**

### (root)

UNLIKE every other schema in this tree, this one describes an API RESPONSE rather than an authored artifact: the one normalized operational document Nexus and the CLI both consume (design 12, design 15). It is never written to Git and never hand-edited. Every operational source - Argo CD, Grafana alerts, uptime, evals, backups, communication, server reconciliation - reports through one Source shape carrying its own adapter status and observation time, so a source that is unconfigured or failed reads unknown instead of disappearing into green. The rollup ladder (unhealthy > degraded > unknown > healthy) is applied HERE, at the producer, and nowhere else: browser and CLI read levels, they never compute them. v1alpha2 (#565/#567): the rollup key space gains the `bundle:<name>` scope (per canonical installed Bundle) and `bucket:unbundled` (agents outside every bundle).

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `nexus.hermes.ai/v1alpha2` | **yes** | — | — |
| `kind` | const `RuntimeOverlay` | **yes** | — | — |
| `observedAt` | any | **yes** | — | When this document was built. Per-source observedAt may be older. |
| `stale` | boolean | **yes** | — | True when any source is serving last-good data. Drives the UI's stale banner, so the banner is a server fact rather than a browser inference from a failed poll. |
| `sources` | object | **yes** | — | Every source kind, always present. A kind with no data path says so through its status; it is never omitted, because an omitted row is indistinguishable from a healthy one. |
| `components` | object | **yes** | — | Workload components only (agents and applications). People and Groups carry no health and are absent by design. |
| `instances` | object | **yes** | — | — |
| `rollups` | object | **yes** | — | Precomputed aggregates, keyed `<scope>:<name>`. `kind:agent` and `kind:application` are the directory rollups; `group:<id>` mirrors the canvas containment fields, computed over ALL members including collapsed ones; `bucket:ungrouped` covers the workload components no group claims (a separate scope so it can never collide with a real group whose id happens to be `ungrouped`). Later milestones register `sheet:<id>` and `nav:<surface>` here - the key space is deliberately open so a new surface needs no schema version. v1alpha2 adds `bundle:<name>` (canonical installed Bundle membership, #567) and `bucket:unbundled`. |
| `integrations` | object | no | — | Legacy summary booleans. Superseded by `sources[].status`; retained so an older browser bundle keeps rendering. |

#### `sources`

Every source kind, always present. A kind with no data path says so through its status; it is never omitted, because an omitted row is indistinguishable from a healthy one.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `argocd` | any | **yes** | — | — |
| `grafana` | any | **yes** | — | — |
| `uptime` | any | **yes** | — | — |
| `eval` | any | **yes** | — | — |
| `backup` | any | **yes** | — | — |
| `communication` | any | **yes** | — | — |
| `reconciliation` | any | **yes** | — | — |

## `platform-backup-status` (v1alpha3)

Schema: `agent-bundle-contracts/runtime-overlay/v1alpha3/platform-backup-status.schema.json` — **Platform backup status (ConfigMap hermes-platform-backup-status)**

### (root)

v1alpha3 (#582) adds `unprotectedByDesign`: the PVC ledger's excused rows, resolved at backup time - the claims the fleet deliberately does not archive, each with its recorded rationale, so Nexus can render intentional gaps as intentional instead of hiding them behind a summary. (v1alpha2 added `gcs` and `gcs-emulated` to destinationClass, and object generations to each component. The emulated value exists because the local loop backs up to fake-gcs-server, and a record reporting plain `gcs` for an emulator would claim off-site durability that does not exist - the one thing an emulation must never be allowed to do.) What the operator host knows about the last PLATFORM backup, published for the in-cluster control plane. The same handshake problem as the reconciliation record: `hg platform backup create` runs on the destination server and writes its manifest to a host directory; Nexus runs in a pod and shares no filesystem with it, so the facts travel as `status.json` in a ConfigMap and are read with the Kubernetes transport every other adapter already uses. It carries no host paths, no archive locations and no credentials - the manifest keeps those, and the manifest never leaves the host. Per-routine facts (schedule, retention, protected paths) are NOT here: those are live CronJob state that Nexus reads directly, and a stale copy of them would be worse than none.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `nexus.hermes.ai/v1alpha3` | **yes** | — | — |
| `kind` | const `PlatformBackupStatus` | **yes** | — | — |
| `observedAt` | any | **yes** | — | When this record was published. A record older than the reader's stale window reads `unknown` - a dead backup timer must not present as protected. |
| `backupId` | string | **yes** | pattern: `^[A-Za-z0-9._-]+$`; maxLength: 120 | The id of the backup this record describes - the scaffold directory name on the host, which is a timestamp, not a path. |
| `createdAt` | any | **yes** | — | When the backup itself was taken. Deliberately separate from observedAt: re-publishing after a restore updates one and not the other. |
| `environment` | string | no | maxLength: 200 | — |
| `destinationClass` | any | no | enum: `local-directory`, `gcs`, `gcs-emulated` | WHERE the backup went, as a class rather than a location. The path or bucket name is a host fact and stays on the host. `gcs-emulated` is a local-loop sink that speaks the GCS API but provides no off-site durability, and every surface must render it differently from `gcs`. |
| `verification` | object | **yes** | — | The two states, kept as two separate facts. `available` means uploaded, checksummed and manifested; `restorable` means a restore actually replayed it. RPO/RTO derive only from `restorable`. |
| `components` | array of object | no | — | One entry per thing the backup covers, in manifest order. Bounded because a ConfigMap is not a database. |
| `summary` | string | no | maxLength: 200 | A scrubbed one-liner. Never command output, a URL, or anything credential-shaped. |
| `version` | string | no | maxLength: 80 | The pinned CLI version that wrote the backup, so an upgrade is visible in the overlay. |
| `unprotectedByDesign` | array of object | no | — | Durable volumes deliberately NOT backed up, each a reviewable claim with its rationale (UNPROTECTED_BY_DESIGN in the CLI's ledger). Bounded; carries claim names and namespaces only - never paths. |

#### `verification`

The two states, kept as two separate facts. `available` means uploaded, checksummed and manifested; `restorable` means a restore actually replayed it. RPO/RTO derive only from `restorable`.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `state` | any | **yes** | enum: `available`, `restorable` | — |
| `restoredAt` | any | no | — | — |
| `durationSeconds` | integer | no | minimum: 0; maximum: 1000000 | Measured restore duration. Absent means `unmeasured` - never render a zero here. |

#### `components[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | string | **yes** | maxLength: 200 | — |
| `kind` | any | **yes** | enum: `volume-archive`, `host-archive`, `declarative` | — |
| `profile` | string | no | maxLength: 120 | — |
| `routine` | string | no | maxLength: 120 | — |
| `sizeKB` | integer | no | minimum: 0; maximum: 1000000000 | — |
| `checksum` | string | no | pattern: `^[0-9a-f]{12}$` | The archive's sha256, abbreviated. Enough to tell two artifacts apart and to show that content WAS verified; not enough to be mistaken for the artifact. |
| `consistency` | string | no | maxLength: 200 | How the artifact was made consistent - the sentence that stops `sha256 matched` being read as `the data is usable`. |
| `detail` | string | no | maxLength: 200 | Scrubbed prose. The writer drops it entirely for host archives, whose detail is a host path. |
| `generation` | string | no | pattern: `^[0-9]{1,32}$` | The object generation a completed upload received. This is what a restore SELECTS by, so it is the difference between 'we have a backup' and 'we can name which one'. Absent for a local-directory sink, which has no such concept. |

#### `unprotectedByDesign[]`

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `claim` | string | **yes** | maxLength: 200 | — |
| `namespace` | string | no | maxLength: 120 | — |
| `reason` | string | **yes** | maxLength: 400 | — |

## `reconciliation-status` (v1alpha1)

Schema: `agent-bundle-contracts/runtime-overlay/v1alpha1/reconciliation-status.schema.json` — **Destination-server reconciliation status (ConfigMap hermes-reconciliation-status)**

### (root)

The handshake between the host reconciler and the in-cluster control plane. `hg reconcile` runs on the destination Linux server; Nexus runs in a pod on a PVC - they share no filesystem, so the reconciler publishes this document as `status.json` in a ConfigMap in the control-plane namespace and Nexus reads it with the same Kubernetes transport the Argo adapter uses. It deliberately does NOT travel through Git: the deployment repository is the reconciler's own input, so committing status there would change the desired SHA and re-trigger reconciliation forever. Every string is written already-scrubbed by the reconciler and re-bounded by the reader, because a ConfigMap is hand-editable.

_Unknown fields are rejected (`additionalProperties: false`)._

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `apiVersion` | const `nexus.hermes.ai/v1alpha1` | **yes** | — | — |
| `kind` | const `ReconciliationStatus` | **yes** | — | — |
| `observedAt` | any | **yes** | — | When the reconciler last completed a tick. A record older than the reader's staleAfterSeconds reads `unknown` - a dead timer must not present as synced. |
| `phase` | any | **yes** | enum: `synced`, `change-detected`, `validating`, `applying`, `waiting-for-argocd`, `degraded`, `failed`, `authentication-required` | The reconciler's state machine. `degraded` means the apply succeeded but Argo CD has not converged; `failed` means the commit was rejected by validation or the apply and is blocked until the desired SHA changes or an operator retries. |
| `desiredSha` | any | no | — | The commit the deployment repository currently points at. |
| `attemptedSha` | any | no | — | — |
| `appliedSha` | any | no | — | The last commit applied SUCCESSFULLY. A failed apply never advances it. |
| `appliedAt` | any | no | — | — |
| `startedAt` | any | no | — | — |
| `finishedAt` | any | no | — | — |
| `attempts` | integer | no | minimum: 0; maximum: 100000 | How many times the blocked commit has been attempted. Present only while blocked. |
| `retryable` | boolean | no | — | Whether `hg reconcile retry` would do anything. |
| `summary` | string | no | maxLength: 200 | A scrubbed one-liner. Never carries command output verbatim, a URL, or anything credential-shaped. |
| `version` | string | no | maxLength: 80 | The pinned reconciler version, so an upgrade is visible in the overlay. |

## Example

`agent-bundle-contracts/runtime-overlay/v1alpha2/examples/overlay/valid-overlay.yaml` — a fixture validated against this exact schema by `make schema-validate`, so it cannot go stale:

```yaml
# A fully populated overlay: one configured source with facts, one serving
# last-good under a stale marker, one failed, and four honestly unconfigured.
# Note what stays true throughout - every source that is not `configured`
# reads `unknown`, never healthy, and the document-level `stale` flag is the
# server telling the UI to raise its banner rather than the browser guessing
# from a failed poll.
apiVersion: nexus.hermes.ai/v1alpha2
kind: RuntimeOverlay
observedAt: "2026-07-31T09:14:00Z"
stale: true
sources:
  argocd:
    kind: argocd
    status: configured
    level: degraded
    summary: 1 of 2 instances requires attention
    observedAt: "2026-07-31T09:14:00Z"
    reasons:
      - message: OutOfSync / Healthy
        instanceId: manager@eu-west
    links:
      - label: Open in Argo CD
        kind: external
        url: https://argocd.example.internal/applications/hermes-manager/hermes-manager-eu-west
        instanceId: manager@eu-west
  grafana:
    kind: grafana
    # observedAt is deliberately older than the document's - that difference
    # IS the staleness the UI renders.
    status: stale
    level: unknown
    summary: last observed 09:02 - Prometheus unreachable
    observedAt: "2026-07-31T09:02:00Z"
  uptime:
    kind: uptime
    status: not configured
    level: unknown
    summary: no external probe series in Prometheus
  eval:
    kind: eval
    status: not configured
    level: unknown
    summary: eval results are not persisted
  backup:
    kind: backup
    status: configured
    level: healthy
    summary: 3 of 3 routines succeeded
    observedAt: "2026-07-31T09:14:00Z"
    links:
      - label: Backup detail
        kind: internal
        href: /#backups
  communication:
    kind: communication
    status: failed
    level: unknown
    summary: router metrics unreachable
  reconciliation:
    kind: reconciliation
    status: configured
    level: healthy
    summary: synced at 4f2c1ab
    observedAt: "2026-07-31T09:13:00Z"
components:
  manager:
    level: degraded
    summary: 1 of 2 instances requires attention
    # One entry per source kind, narrowed to this component. The browser
    # renders these rows verbatim - it has no fallback that could fabricate
    # a missing one.
    sources:
      - kind: argocd
        status: configured
        level: degraded
        summary: 1 of 2 instances requires attention
        observedAt: "2026-07-31T09:14:00Z"
      - kind: grafana
        status: stale
        level: unknown
        summary: last observed 09:02
      - kind: uptime
        status: not configured
        level: unknown
        summary: not configured
      - kind: eval
        status: not configured
        level: unknown
        summary: no runs
      - kind: backup
        status: configured
        level: healthy
        summary: last backup 2h ago
      - kind: communication
        status: failed
        level: unknown
        summary: router metrics unreachable
      - kind: reconciliation
        status: configured
        level: healthy
        summary: synced at 4f2c1ab
instances:
  manager@ca-west:
    level: healthy
    reasons:
      - source: argocd
        message: Synced / Healthy
    observedAt: "2026-07-31T09:14:00Z"
    links:
      - label: Open in Argo CD
        kind: external
        url: https://argocd.example.internal/applications/hermes-manager/hermes-manager-ca-west
  manager@eu-west:
    level: degraded
    reasons:
      - source: argocd
        message: OutOfSync / Healthy
    observedAt: "2026-07-31T09:14:00Z"
rollups:
  # Quoted: the key itself contains a colon.
  "kind:agent":
    level: degraded
    summary: 1 of 1 agent requires attention
    members:
      - manager
  "kind:application":
    level: unknown
    summary: no applications
    members: []
  "group:marketing":
    level: degraded
    summary: 1 of 1 member requires attention
    members:
      - manager
  # v1alpha2 (#565/#567): the canonical-Bundle scope and its unbundled
  # counterpart.
  "bundle:marketing-core":
    level: degraded
    summary: 1 of 1 member requires attention
    members:
      - manager
  "bucket:unbundled":
    level: healthy
    summary: all unbundled agents healthy
    members: []
integrations:
  argocd: true
  grafana: false
  hermesRuntime: false
```

## See also

- [Contract files](index.md) — every contract, who writes it, who reads it.
- `agent-bundle-contracts/runtime-overlay/<version>/examples/` — all fixtures for this contract (`invalid-*` fixtures must fail validation; everything else must pass).
- [observability](../cli/observability.md)
- [reconcile](../cli/reconcile.md)

