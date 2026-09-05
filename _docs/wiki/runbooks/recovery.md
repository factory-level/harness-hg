# Recovery

**Outcome:** a healthy replacement environment on a clean server, rebuilt from a verified
backup using only Git, remote Pulumi state, the sink, and the credentials you hold.

Nothing is copied from the original server. If this runbook needs something only the dead
machine had, the runbook is wrong.

## Prerequisites

- A clean host, and the credentials from [Credentials](credentials.md).
- A backup that reads `restorable` in the sink, and its **id**. `latest` is not used here.

## The steps, in this order

```bash
# 1. Bootstrap the machine (a new server identity is written)
hg server preflight --host <user@host>
hg server bootstrap --host <user@host>

# 2. Credentials first. The restore will not bring them
scp shared.env <user@host>:/mnt/ssd/hermes-gitops/env/shared.env
scp <writer-sa-key>.json <user@host>:/mnt/ssd/hermes-gitops/env/

# on the host from here:
export HERMES_GITOPS_HOME=/mnt/ssd/hermes-gitops
export HG_KUBE_CONTEXT=default

# 3. Reconcile the remote state onto the new cluster: same stack, never a new one
PULUMI_K8S_DELETE_UNREACHABLE=true pulumi refresh --yes --cwd infra
pulumi up --cwd infra

# 4. Fetch the named backup
HG_RESTORE_READER_SA=<env>-restore-reader@<project>.iam.gserviceaccount.com \
  hg platform fetch <backup-id> --sink gs://<project>-<env>-backup/<env> --to /mnt/ssd/hermes-gitops/backups

# 5. Restore the archived half onto the rebuilt cluster
hg platform restore --from /mnt/ssd/hermes-gitops/backups/<backup-id>

# 6. Reconnect reconciliation
hg reconcile install --repo <destination-repo-url> --kube-context default --now
```

## Why each constraint exists

- **Credentials before `pulumi up`.** The secrets store serves what the bootstrap writes
  from `env/`.
- **Same Pulumi stack, refreshed.** The tunnel, DNS and Access resources are alive; a new
  stack would collide with them. The environment variable drops the dead cluster's
  Kubernetes resources from state so `up` recreates them.
- **An explicit backup id.** Otherwise the CLI takes the newest, and a recovery restores
  something nobody chose.
- **`hg up` is not in this flow.** It builds the local loop. The declared half is Pulumi's;
  the archived half is the restore's.

## When it goes wrong

| Symptom | Cause |
|---|---|
| fetch names other ids | the backup id is wrong; pick from the printed list |
| restore reports a component `failed` | its message names the resource; fix, rerun. A restore repeats whole, never resumes |
| a pod stuck `Init:` on a missing Secret | a credential with no declared source; add it, `pulumi up` |
| a port-forward answers with old data | it survived the rebuild; kill it and re-forward |

## Proof

```bash
hg launch prove
hg platform backup prove --from /mnt/ssd/hermes-gitops/backups/<backup-id>
HG_BACKUP_WRITER_SA=<env>-backup-writer@<project>.iam.gserviceaccount.com \
  hg platform evidence --to <dir> --from <backup-dir> --sink gs://...
```

**Done when** `hg launch prove` is green with no `unknown` leg and `hg platform backup prove`
passes PLAT001..007 against the fetched backup.
