# Upgrade or roll back a platform or team

## Outcome

One commit moves an installation to a new platform revision, a new team source commit, or a new
agent runtime — and one commit moves it back. The watcher applies the change, every agent proves
what it built before it serves, and `hg team status` tells you whether the cluster is running what
you asked for.

## Prerequisites

- A **version 2 installation plan** with its committed lock. `hg team compile` writes the lock;
  the plan and the lock are committed together, and every other team command refuses a stale one.
- A **team watcher** on the destination host (`hg reconcile install --kind team`), or an operator
  running `hg team resume` by hand.
- Authorization for what you are about to do, recorded in the plan's `authorizations`.
- `hg team status` green before you start. Upgrading from an unknown state means you cannot tell
  afterwards whether your change helped.

## Move a team to a new source commit

1. Edit the plan's `sources[].ref` to the new tag or commit. Version 2 plans never track a branch.
2. `hg team compile --plan <plan> --dir <bootstrap>` — resolves every ref and rewrites the lock.
3. Review the lock diff. It names exactly what will deploy.
4. Commit the plan and the lock together, and push.

The watcher picks up the commit, publishes the new projection, and Argo CD syncs it. Each agent
rebuilds, writes a build receipt, and refuses to become ready unless the receipt matches what the
record asked for. The PostSync check fails the sync if the rollout, the receipt, health or the
agent's identity disagree.

## Move an installation to a new platform revision

1. Edit the plan's `platform.ref`. The lock records the revision it replaces, which is what a
   rollback returns to.
2. `hg team compile`, review, commit both, push.

The watcher runs `hg` **from the revision the lock names**, not from whatever it has installed, so
the tool that publishes is the one you asked for. It keeps a checkout per revision in use and
drops the rest, so returning to the previous revision costs a checkout rather than a clone.

## Canary one agent onto a new runtime

Give that agent `runtime: {image, eveVersion}` naming a pair the platform publishes, then compile
and commit. Only that agent moves; every other agent stays on the installation default. Promote by
making the pinned version the default and deleting the pin. Roll back by deleting the pin alone.

## Roll back

Revert the lock commit — and the plan commit with it, since the two must agree — then push. The
watcher republishes the previous projection exactly as it published the new one. Rollback is not a
special mode; it is the same path with an earlier commit.

Three things a revert does **not** undo:

- Pulumi releases already applied to the destination.
- An agent's persisted workflow data. Eve has no compatibility check across versions, so a version
  that wrote state a previous version cannot read stays incompatible after the revert.
- Anything already merged into the generated repository by a previous publication.

## Common failures

**The watcher reports pending.** Pending is a wait, not a failure: something only a person, a
merge or time can supply. `hg reconcile status` names the reason and the link — approve the skill
or overlay, merge the pull request, or run the attended command the reason names. The watcher
retries on a growing interval, and `hg reconcile sync` retries now.

**The watcher reports failed.** Something waiting cannot fix: an acceptance scenario that ran and
did not pass, or a credential name the plan needs that the watcher's environment does not carry.
It names the missing *names*, never values. Fix it, then `hg reconcile retry`.

**`hg team status` exits 2.** Something cannot be proven — a missing build receipt, a smoke
result recorded for an earlier sync, an unreadable Application. Each field says why. Exit 2 is not
success with a warning; it means the cluster has not shown you enough to claim the upgrade landed.
An installation with no team watcher is not one of these: its watcher column reads `n/a` and the
verdict does not wait for it.

**An agent never becomes ready after an upgrade.** Its startup check is refusing a build that does
not match the record. `kubectl describe pod` shows the receipt in the build container's
termination message; compare it with the workload's
`harness-hg.factorylevel.dev/source-sha` label.

**The sync fails on the smoke check.** The deployment reached the cluster but could not prove
itself. The failed hook Job stays behind precisely so you can read it:
`kubectl logs job/<agent>-smoke`.

## Proof

```bash
hg reconcile status --instance <name>   # the watcher's phase, and any pending reason
hg team status --plan <plan> --dir <bootstrap> --json
kubectl get applications -A             # every agent Synced
```

## Done when

`hg team status` exits `0`: every agent's Argo Application is synced, a pod at the workload's
revision is ready, and the commit, overlays, Eve release and image it built are the ones the lock
records. Anything less exits `1` (something differs) or `2` (something cannot be proven), and
names which field and why.
