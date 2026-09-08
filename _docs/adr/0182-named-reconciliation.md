# 0182 — Named repository reconciliation

## Decision

Extend the CLI design with optional named reconciler instances. The unnamed instance retains
its paths and systemd identity. Named instances isolate checkout, credentials, ledger, timer,
and published status, while all instances in one Harness Hg home share the existing flock.
The environment declares additional instances under `reconcile.instances`.

## Reason

A factory can host teams from multiple source repositories. Watching only one team's branch
leaves another team's changes unapplied. Replacing that watcher interrupts the first team.

## Cost

Applies remain serialized across the environment; a busy lock skips a tick until its next
interval. Operators inspect each instance separately. This does not create a transaction
across repositories or isolate a shared Pulumi stack's failures. Removing an instance removes
its timer but retains its history and data. Existing single-repository configuration migrates
without changing its resource identity.
