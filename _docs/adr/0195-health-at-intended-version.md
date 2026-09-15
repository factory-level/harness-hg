# 0195 — Agent health at the intended version

**Status:** Accepted
**Changes:** `_docs/design/platform.md`, `_docs/design/cli.md`, `_docs/design/nexus-ui.md`

## Decision

Each Eve build writes a **build receipt**: source commit, overlay digest, build stamp, the
project's and the image's Eve versions, runtime digest and build time. The receipt is kept on the
data volume and published through the build container's termination message, so pod status
shows it without new permissions.

- The agent's startup probe compares the receipt with the rendered desired values before
  checking health. A mismatched build never becomes ready.
- A PostSync hook Job per agent verifies controller revision, receipt, health and authenticated
  agent info, and fails the sync when any differ.
- Desired versions are labels and annotations on the StatefulSet and pod template under the
  `harness-hg.factorylevel.dev/` prefix. Built values stay in the receipt.
- `hg team status` observes the live cluster, never recovers and never takes the installation
  lock. `--prove` adds the live runtime version and configuration drift proofs. Unknown is never
  a pass.
- Alerts cover Eve agents down, failed smoke checks, stuck rollouts, prolonged OutOfSync,
  Degraded applications, degraded watchers and missing Argo CD metrics.
- Nexus shows desired against built version per agent, and unknown when evidence is missing.

## Reason

Argo CD Healthy means only that the process answers a liveness probe. Version and drift checks
exist but run only inside apply or on demand, team status replays an operator-local ledger, and
no alert or dashboard compares desired and running versions.

## Cost

- Every agent restarts once when the labels and probe land.
- A version mismatch now takes an agent out of service, by design.
- Argo CD reports a failed sync, not Degraded. Degraded would require overriding StatefulSet
  health for every workload, Hermes included.
- The receipt proves what is on disk, not what the runtime loaded; the loaded version still
  needs a session proof.
- The hook runs only on sync. Later drift is caught by the probe on restart and by status and
  alerts.
- A sync timeout applies to every Argo CD Application, and Nexus gains read access to
  StatefulSets.
- New labels use the product prefix beside the frozen `hermes-gitops.` labels until those are
  renamed.
