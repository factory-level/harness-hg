# Install a destination server

**Outcome:** a clean Ubuntu 24.04 x86-64 host becomes a healthy, reachable Harness Hg
environment.

Day 0 is one command, `hg env new`, walked on [Host an environment](../get-started/host-an-environment.md).
This runbook is the detail behind it and the server-side half it hands off to. Every step is
idempotent: fix the named cause and rerun.

Nothing watches this environment from outside it. A dead cluster alerts nobody.

## Prerequisites

- A clean Ubuntu 24.04 x86-64 host with ssh and sudo: at least 4 vCPU, 8 GiB RAM, and a
  second disk with 50 GiB free for the sync root. Preflight fails on each.
- [Google Cloud setup](google-cloud.md) done.
- Every credential in [Credentials](credentials.md) in hand.
- A Git repository the server can pull from and does not serve itself.
- `hg` installed: [Install the tools](../get-started/install-the-tools.md).

## 0. Operator machine, once per environment

```bash
pulumi login gs://<state-bucket>          # a destination server refuses a file:// backend
cd state && pulumi up                     # the backup sink + identity split
```

## 1. Preflight and bootstrap

```bash
hg server preflight --host <user@host>    # SRV000..008; fix what it names, rerun
hg server bootstrap --host <user@host>    # pinned k3s, kubectl, helm, bun; sync root; server id
```

With password-only sudo, the k3s step prints one `ssh -t … sudo …` command to run yourself.
Then rerun bootstrap. Pins come from `versions.json`; nothing installs without a checksum.

## 2. Credentials, before the control plane

```bash
scp shared.env <user@host>:/mnt/ssd/hermes-gitops/env/shared.env
scp <writer-sa-key>.json <user@host>:/mnt/ssd/hermes-gitops/env/
```

The order matters. The secrets store serves only what the bootstrap writes from `env/`.
Credentials placed after `pulumi up` mean agents that cannot authenticate until the next
apply.

## 3. Control plane and reconciliation, on the host

```bash
export HERMES_GITOPS_HOME=/mnt/ssd/hermes-gitops
export HG_KUBE_CONTEXT=default
pulumi up --cwd infra
hg reconcile install --repo <destination-repo-url> --branch main --kube-context default --now
```

## 4. Backups on a schedule

```bash
HG_BACKUP_WRITER_SA=<env>-backup-writer@<project>.iam.gserviceaccount.com \
HG_RESTORE_READER_SA=<env>-restore-reader@<project>.iam.gserviceaccount.com \
  hg platform install-timer --to /mnt/ssd/hermes-gitops/backups --sink gs://<project>-<env>-backup/<env> --now
```

## Common failures

| Symptom | Cause |
|---|---|
| the k3s step stops on sudo | password-only sudo: run the printed command, rerun bootstrap |
| agents cannot authenticate after `pulumi up` | credentials placed after step 2; place them, apply again |
| a pod stuck `Init:` on a missing Secret | a credential with no declared source |
| bootstrap refuses to install something | it cannot checksum it against `versions.json` |

## Rollback

There is no partial rollback. Use the [destructive test](destructive-test.md)'s destroy
step, which removes only what Harness Hg created, and run this runbook again.

## Proof

```bash
hg edge prove --stack <stack>             # after the tunnel runbook
HG_BACKUP_WRITER_SA=... hg platform backup create --to /mnt/ssd/hermes-gitops/backups --sink gs://...
HG_RESTORE_READER_SA=... hg platform verify-restore --from /mnt/ssd/hermes-gitops/backups --sink gs://...
hg launch prove
hg platform evidence --to <dir> --from <backup-dir> --sink gs://...
```

**Done when** `hg launch prove` exits zero with no `unknown` findings, and the backup reads
`restorable` in the sink.
