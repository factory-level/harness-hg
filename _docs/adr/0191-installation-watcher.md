# 0191 — Installation watcher

**Status:** Accepted
**Changes:** `_docs/design/cli.md`, `_docs/design/platform.md`

## Decision

A named reconciler instance (ADR 0182) may be of kind `team`. A team watcher watches the
**bootstrap** repository, not team sources. Each tick checks out the exact bootstrap commit and
runs `hg team resume --unattended` for one installation, so every publication still goes through
the team compiler (ADR 0185). Watchers remain host services. Their credentials live in an
owner-only environment file, and installation refuses unless that file names every secret the
plan references. Values are never written into the service unit.

Unattended resume exits `0` when the installation is complete, `75` when a human decision or
merge is outstanding, and `1` on failure. Pending retries with capped backoff and never blocks a
commit; failure keeps the existing blocked-commit rule. An unattended run never approves skills
or overlays, never merges a publication whose destination disables auto-merge, never changes
activation inputs, and runs write acceptance scenarios only when the plan opts in.

Status records gain a new schema version carrying the installation, current stage, pending
reason and link, and desired and applied revisions per source, per agent and for the platform.
The status ConfigMap carries a phase label so alerting can select degraded watchers. Readers
accept both status versions. Watchers that run raw provisioning against team sources are
replaced by one team watcher per installation.

## Reason

ADR 0185 routes publication through one compiler, but the only automation today runs raw
provisioning against team repositories, and automatically configured watchers are an open gap.
Operators need a bootstrap commit to be the entire upgrade action, with Argo CD converging the
result.

## Cost

- The watcher host needs the production-startup toolchain (container runtime, Pulumi, uv) and
  every plan credential. In-cluster execution is deferred.
- While pending, each retry repeats provisioning previews. Backoff bounds that cost; it does
  not remove it.
- Command-kind and team-kind status records coexist, so readers carry two schema versions.
- A watcher host outage stops upgrades. Argo CD keeps serving the last published state.
