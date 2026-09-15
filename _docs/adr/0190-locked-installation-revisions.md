# 0190 — Locked installation revisions

**Status:** Accepted
**Changes:** `_docs/design/cli.md`, `_docs/design/platform.md`, `_docs/design/vocabulary.md`

## Decision

Installation plan version 2 pins every production input to an immutable revision. A source
`ref` accepts only a tag or a 40-hex commit. The plan names a bootstrap-relative
**installation lock**, written only by `hg team compile`, which records the plan digest, the
commit each source ref resolved to, per-agent runtime pins, and the platform revision with its
predecessor.

Team compilation takes revisions from the lock. It refuses a tag that now resolves to a
different commit and a lock whose plan digest no longer matches the plan. A private
application chart revision is derived from its source's locked commit instead of being
declared separately, so the two cannot disagree. Version 1 plans remain accepted for the local
loop only.

Rolling back an installation is reverting the lock commit in the bootstrap repository.

## Reason

Consumers track `main`, so one plan publishes different commits over time and no committed
file records what was intended. The resolved commit exists only in generated records and an
operator-local ledger. Chart and source revisions are bumped independently. An unattended
watcher cannot safely publish from a moving ref.

## Cost

- Every release needs a tag or commit plus a lock commit; branch tracking ends in production.
- Existing plans migrate to version 2 before a watcher may run them unattended.
- Rollback restores declarations and images only. Agent data volumes, workflow state and
  sessions do not roll back.
- The lock is one more bootstrap file whose integrity rests on repository access control.
