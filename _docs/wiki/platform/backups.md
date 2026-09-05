# Backup

**What this page tells you:** what gets backed up, who decides, and when a backup counts as
something you can restore from.

There are two layers. Most backup questions resolve once you know which one is meant.

| | Application backups | Platform backup |
|---|---|---|
| Covers | one application's data | the whole environment |
| Declared by | your repo | the operator |
| Run by | `hg backup run` | `hg platform backup create` |
| Unit | a **backup routine** | one environment snapshot |

## Who owns what

| The platform owns | Your repo owns |
|---|---|
| Where backups go, and the backend | What to capture, and how often |
| The identities that write and read them | How the artifact restores |
| Scheduling, running, observing, verifying | Whether a routine exists at all |

## Application backups

A routine is what to capture and how often. The platform turns it into a labelled CronJob.

```bash
hg backup list                     # every routine, and how stale each is
hg backup run    --routine <name>
hg backup verify --routine <name>  # open the newest artifact and check it
hg backup export --to <dir>
hg backup restore --routine <name> --from <archive.tar.gz>
```

`verify` opens the artifact. A job that exits 0 and writes an unusable file is the failure
backups actually have.

A volume tarball restores generically. Anything else needs a restore hook, and running one
needs `--allow-restore-hook`. A routine with neither is reported unrestorable, never
restored wrongly. SQLite is snapshotted with its own backup API, never copied live.

An Eve agent's `backup` declaration becomes one of these routines. It protects the agent's
state, checkout and build stamp.

## Platform backup

One backup is one directory: a manifest, the agent volumes, the host state, and a restore
report once a restore has run. The manifest says how each component is covered:
`volume-archive` and `host-archive` mean bytes are in the backup; `declarative` means the
claim is that `hg up` plus Argo CD rebuild it, and `hg platform backup prove` checks that
claim.

### `available` is not `restorable`

- **`available`**: the backup was written to the sink.
- **`restorable`**: a restore has actually run from it.

An untested backup is a hypothesis. `hg platform install-timer` schedules two things: the
backup, and a weekly restore verification. A restore starts from the beginning every time.

### The status record Nexus UI reads

Every `create`, upload and verified restore ends by publishing the backup's record as the
`hermes-platform-backup-status` ConfigMap in the reconciler's `statusNamespace`. That
ConfigMap is all the Backups view knows about the platform backup. Publishing is
best-effort, so a failed publish does not fail a backup that succeeded. It shows up in the
timer's journal, and on the Backups view as "platform backup record is Nh old". Check the
journal first.

A routine's own sink volume is deliberately not archived. `hg platform backup create` exports it.

## Backend

Google Cloud Storage is the only backend. `--sink emulated` is a local fake for development.
Two identities: a writer, and a reader that could not have written. Verification uses the
reader.

## What is not covered

- Secrets. `env/` is outside every archive. Place credentials by hand before a restore.
- In-flight queue entries and consumer offsets. Restoring them would replay deliveries.
- The Pulumi state bucket. A provisioned Slack app's secret lives only there. Treat the
  bucket as a backup subject.

## Where to go next

- [Recovery](../runbooks/recovery.md), restoring an environment in order
- [The destructive test](../runbooks/destructive-test.md), proving it for real
- [Google Cloud setup](../runbooks/google-cloud.md), the sink and the identity split
