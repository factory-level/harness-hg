# Nexus source sets

`cli/src/nexus/source-set.ts` joins independently validated source declarations and topologies
before calling the existing Nexus compiler. It requires complete profile coverage and exact
repository/revision/runtime/subdirectory matches against the caller's deployment registry. Duplicate identities and
invalid declarations fail the combined result. Each selected source view occupies a deterministic
horizontal section; same-named default views do not overwrite one another. Source environment
bundle placements remain authoritative in both individual and combined compilation.

`infra/environments/nexus-source-set.ts` reads the operator environment registry and emitted
profile records, requires clean source checkouts, and writes only Nexus-managed GitOps files.
It writes nothing on preparation or validation failure. The generated `sources.json` records
each repository SHA and input hash. The existing frozen plan's single SHA is all zeros for a
multi-repository compilation; it does not falsely identify one repository as the complete input.

`bun test cli/tests/nexus-source-set.test.ts` covers sibling retention, source order invariance,
deployment revision mismatch, incomplete coverage, duplicate identity refusal and repository-local
reference validation. Live onboarding and watcher-triggered publication are not established by
these compiler fixtures.

Agent detail panels join live health by declared instance ID, independently of the display
component ID. Each instance shows its application, namespace, target, and observed health;
missing health remains unknown.
