# Google Cloud setup

**Outcome:** a Google Cloud project that holds Pulumi state and receives platform backups,
with a writer identity that can add backups but never delete them, and a reader identity
that proves they restore.

Google Cloud is used for state and backups only. It is not a secret store.

## Prerequisites

- A Google Cloud project you own, with billing enabled.
- `gcloud` installed and signed in as someone who can create buckets, service accounts,
  IAM bindings and KMS keys.
- An environment name, `<env>`, of at most 16 characters.

## 1. Application default credentials

```bash
gcloud auth application-default login
gcloud config set project <project>
```

## 2. The Pulumi state bucket

A destination server refuses a `file://` backend. State must live remotely.

```bash
gcloud storage buckets create gs://<state-bucket> --location=us
pulumi login gs://<state-bucket>
```

## 3. The backup sink and the two identities

```bash
cd state
pulumi config set --path 'backupEnvironments[0]' <env>
pulumi up
```

That creates, per environment:

| Resource | Purpose |
|---|---|
| `gs://<project>-<env>-backup` | the sink, versioned, encrypted with a customer-managed key |
| `<env>-backup-writer` | can add objects; can never overwrite or delete |
| `<env>-restore-reader` | can only read |

The reader verifies. So "this backup is restorable" is established by an identity that
could not have written it.

## 4. Give the server the writer key

The backup timer on the host needs the writer key. It goes in `env/`, which is outside every
backup archive.

```bash
scp <writer-sa-key>.json <user@host>:/mnt/ssd/hermes-gitops/env/
```

Then, on the host, activate it for `gcloud` too. Pulumi reads the key file; `gcloud` does
not.

```bash
gcloud auth activate-service-account --key-file=$HERMES_GITOPS_HOME/env/<key>.json
gcloud config set project <project>
```

## 5. The restore reader

The reader has no key. It is impersonated:

```bash
export HG_RESTORE_READER_SA=<env>-restore-reader@<project>.iam.gserviceaccount.com
```

Whoever runs a restore needs `roles/iam.serviceAccountTokenCreator` on it. The `state`
stack grants that to the deployer.

## Common failures

| Symptom | Cause |
|---|---|
| `gcloud storage` denied, Pulumi fine | step 4's `activate-service-account` not run |
| service account id rejected | `<env>` longer than 16 characters |
| the writer cannot overwrite an object | correct, by design |
| verify fails on decryption | the identity lacks `cloudkms.cryptoKeyEncrypterDecrypter` on the key |

## Rotation

The writer key is the only long-lived key. Create the new one, place it, activate it, prove
(below), then delete the old one:

```bash
gcloud iam service-accounts keys create <new>.json --iam-account=<env>-backup-writer@<project>.iam.gserviceaccount.com
scp <new>.json <user@host>:/mnt/ssd/hermes-gitops/env/
gcloud iam service-accounts keys delete <old-key-id> --iam-account=<env>-backup-writer@<project>.iam.gserviceaccount.com
```

## Proof

Not "the bucket exists". A backup round-trips through both identities:

```bash
HG_BACKUP_WRITER_SA=<env>-backup-writer@<project>.iam.gserviceaccount.com \
  hg platform backup create --to /mnt/ssd/hermes-gitops/backups --sink gs://<project>-<env>-backup/<env>

HG_RESTORE_READER_SA=<env>-restore-reader@<project>.iam.gserviceaccount.com \
  hg platform verify-restore --from /mnt/ssd/hermes-gitops/backups --sink gs://<project>-<env>-backup/<env>
```

**Done when the backup reads `restorable` in the sink.** Available means written. Restorable
means it came back.
