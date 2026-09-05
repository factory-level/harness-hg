# Backups and routines

**What this page tells you:** how to declare that your data should survive, and the one thing
people forget.

## What it means

You declare intent: a schedule and a retention. The platform performs the backup. You do not
choose a destination, a bucket or a provider.

## What you write

```yaml
# agents/eve/<name>/harness-hg/backup.yaml
apiVersion: hermes-gitops.factorylevel.dev/agent-team/v1alpha1
kind: Backup
schedule: "0 3 * * *"
retention: 14
```

Only `schedule` is required. `retention` defaults to 7. Declare it whenever your application
has state that Git cannot rebuild.

## The thing people forget

**Producing a backup is not enough. You have to say how it goes back.**

| Your artifact | Restore |
|---|---|
| A volume tarball | works generically |
| Anything else | you must declare a restore hook, `hermes.dev/backup-restore-hook` |

A routine with neither is reported **unrestorable**. It is never restored wrongly and never
skipped silently. If you ship SQLite, snapshot it with SQLite's own backup API inside the
job, never by copying the file.

## What you get

A CronJob per routine, labelled `hermes.dev/backup-routine`, and a coverage row in the
platform's protection ledger. For an Eve agent the routine archives sessions, the sandbox
cache, the checkout and the build stamp. After a restore, the pod rebuilds and sessions from
before the backup answer follow-ups.

This is an **application backup**. The **platform backup** snapshots the whole environment
and is the operator's. Neither rolls up into the other.

## In Nexus UI

A row per routine: last run, whether the artifact verified, and its coverage class. An
unrestorable routine shows as such, never green.

## The exact fields

[Agent team contract](../reference/contracts/agent-team.md). The platform side:
[Backup](../platform/backups.md).
