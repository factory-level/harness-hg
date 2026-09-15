# 0193 — Platform revision in the installation lock

**Status:** Accepted
**Changes:** `_docs/design/platform.md`, `_docs/design/cli.md`

## Decision

The platform revision a destination runs is declared in the installation plan as a tag or
commit and resolved into the installation lock (ADR 0190) with the revision it replaces. It is
no longer a free-form stack setting. A team watcher runs `hg` from a checkout of the locked
revision and passes that revision to provisioning, so the compiler that publishes and the
charts Argo CD syncs are the same revision.

Every generated bootstrap file that names the platform revision is managed and rewritten on
emit. The application chart revision moves out of seeded cluster values into a managed platform
values file layered after them. Outside the local loop, a branch revision is refused. The
scaffold manifest records the previous template revision, and `hg gitops doctor` reports a
destination whose platform-sourced Applications disagree on revision.

## Reason

The default revision is `main`. A bump rewrites four managed files and leaves seven seeded
ones, so agents move while the event router, bundles, wiki, Loki, dashboards and application
charts stay behind. No command performs an upgrade and no record supports rollback.

## Cost

- Files an operator could edit after seeding become managed. An edited copy must be adopted
  through a generated change, and later hand edits are refused.
- Tracking platform `main` is limited to the local loop.
- The watcher host keeps one checkout per platform revision in use.
- Control-plane components move together; there is no per-component platform revision.
