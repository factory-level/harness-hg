# ADR 0184: Compile shared Nexus views from a complete source set

## Decision

An operator sharing one GitOps destination between teams compiles all registered sources
together before publishing Nexus. Each checkout must match its profiles' emitted deployment
revision. Missing sources, conflicting identities and invalid declarations refuse the entire
update, retaining the previous plan. Source contributions remain repository-owned.

## Reason

Single-source emission replaces the dashboard plan. Using it during onboarding can hide an
existing team, while compiling a newer checkout can display agents that are not deployed.

## Cost

Operators must resolve clean checkouts for every registered source and publish the resulting
GitOps diff. During a partial rollout with mixed revisions inside one source, emission waits
until that source converges. The frozen plan schema has one source SHA: multi-source output
uses its unknown marker and stores exact provenance in a separate generated JSON file.
This does not add automatic watcher publication, cross-repository conceptual relationships,
or runtime activation. Those remain separate work.

This decision extends `_docs/design/nexus-ui.md`'s compiled-plan boundary.
