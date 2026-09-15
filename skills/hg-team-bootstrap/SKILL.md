---
name: hg-team-bootstrap
description: Configure bootstrap-owned integrations and a persisted Harness Hg team installation, then apply and resume its generated publication, runtime checks and live acceptance. Use after team source configuration or to resume an incomplete launch.
---

# Configure bootstrap and apply

This is the second phase of team onboarding. Read the source team's specification and
existing installation requirements first. Discover the bootstrap environment, current team
registry, integration owners, encrypted configuration references, and existing authorization.
Ask only for missing consequential decisions or access; preserve previous survey answers.

Read [installation plans](references/installation.md) before authoring the bootstrap-owned
plan. Use the installed `hg` and `hg help team`; do not require a developer checkout.

1. Register every team sharing the destination, with repository/ref and exact role identities.
   Keep source repositories, bootstrap configuration, and generated GitOps repositories distinct.
2. Resolve credential requirements through the owning provider. Record environment names and
   encrypted config references, never values. Reuse managed integrations; do not adopt another
   app because its display name resembles a role. Preserve unrelated encrypted configuration.
3. For a version 2 plan, run `hg team compile --plan <file> --dir <bootstrap-root>` after every
   plan change and commit the plan with its lock. Run `hg team plan --plan <file> --dir
   <bootstrap-root> --json`. Fix source or bootstrap
   failures before apply. Review the complete projection and any explicit adoption baseline.
4. Within recorded authorization, run `hg team apply` with the same arguments. It validates
   production startup, provisions bootstrap, publishes a coherent GitOps PR, waits for ready
   workloads, verifies transports, applies declared activation gates and runs live scenarios.
5. Inspect `hg team status`; use `hg team resume` after interruption or prerequisite repair.
   Persist progress and report the failing stage, diagnostic artifact and supported repair.

Configure one reconcile watcher of `kind: team` on the bootstrap repository
(`infra.reconcile` or a named instance: `kind: team`, `team: {plan: <bootstrap-relative plan>}`,
optional `environmentFile`). It runs `hg team resume --unattended` on every bootstrap commit;
that needs a version 2 plan with a committed lock. It stops as pending on a missing approval, a
pull request awaiting review, an activation change or a write scenario not marked
`unattended: true`; the operator approves, merges or applies attended, and the next attempt
continues. Preserve other watchers. Do not replace a shared watcher with a single-source
compiler, and do not point several watchers at one installation.

## Completion and boundaries

For sources requiring skill approval, set `sources[].skillPolicy.approvals` to the
bootstrap-relative approval file. Review complete staged packages and fingerprints before
recording an explicit human decision through `hg skills approve`. Never self-approve.
External requirements derive from per-agent locked manifests; only local skills belong in
bootstrap `agents[].skills`. Content, version or capability changes invalidate approval.
Preserve separate user approval requirements for coding-assistant skill updates.

GitOps repositories are generated output. Never manually edit or commit a repair there,
even after running a compiler. Missing automation is a platform defect to fix in source;
customer-specific helpers, copied remote code and hand-built aggregate plans are not remedies.

Do not treat published profiles, namespaces, green builds, ready pods or signed endpoints as
equivalent to an active, behavior-proven team. Every required scenario must pass with receipts.
Unknown stages and pending PR checks remain incomplete. Tests using fixtures are distinct
from deployed evaluations and live Slack replies.

Inspect adoption and migration output before applying it. Source collisions, unregistered
existing profiles, unsupported bundles, or unexplained generated drift must be resolved in
the owning declaration. Do not bypass ownership checks or delete volumes to force progress.

The current CLI supports provider-owned Pulumi gates, not arbitrary account/OAuth setup.
Where a provider cannot capture or reuse a needed credential, report that concrete prerequisite
and continue independent work. Do not claim this limitation or a fixture completes a live gate.
