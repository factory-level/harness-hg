# The destructive test

**Outcome:** proof that the environment survives losing its server, by destroying the
Harness Hg footprint, rebuilding from the authoritative systems alone, and passing the same
proofs.

Run it before calling any environment durable. An untested recovery is a hypothesis.

!!! danger "This destroys a running environment"
    `hg server destroy --nuclear` removes k3s, the timers, the sync-root entries and the
    kubeconfig. It is gated on the sink reporting your named backup restorable, read with the
    reader identity. It wipes `env/` on purpose so cached credentials cannot satisfy the test.

The scope is Harness Hg only: an allowlist under the sync root plus k3s, the user timers and
`~/.kube/config`. Other workloads and the disks are out of reach.

## Prerequisites

- [Install](install.md) completed and `hg launch prove` green.
- A named backup that reads `restorable` in the sink, taken after the fixture below existed.
- A fixture with a known identity in agent data: a seeded marker file. Recovery is proved by
  finding it byte-identical, not by pods being green.
- The operator's decision. The `--backup` flag is the consent.

## 1. Destroy

```bash
HG_RESTORE_READER_SA=<env>-restore-reader@<project>.iam.gserviceaccount.com \
  hg server destroy --host <user@host> --backup <backup-id> --sink gs://<project>-<env>-backup/<env> --nuclear
```

DSTR001..006 verify: port 6443 closed, k3s gone, the sync root empty of owned entries, no
Harness Hg user units, the kubeconfig gone, and the backup still restorable when read from
the operator machine. Save the `--json` output into your evidence directory.

## 2. Restore

Follow [Recovery](recovery.md) on the same, now clean, machine or a different one. The
re-bootstrap writes a new server identity.

## Proof

- [ ] `hg launch prove` green again, no `unknown` leg.
- [ ] `hg platform backup prove` PLAT001..007 pass against the fetched backup.
- [ ] The fixture is present and byte-identical.
- [ ] `hg platform evidence --sink gs://...` uploaded the package with the backup id used.

A cycle that needed any step not written in these runbooks is a failed cycle. Fix the
runbook or the platform, then run it again.
