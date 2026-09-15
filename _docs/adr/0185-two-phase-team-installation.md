# 0185 — Two-phase team installation

## Decision

Team onboarding has two user-facing phases: configure the team source, then configure
the bootstrap and apply. Skills invoke supported `hg team` operations. A versioned
installation plan records source identities, capabilities, ownership, authorization and
acceptance requirements; an operator-local ledger records stage evidence and revisions.

GitOps repositories are generated output. Operators and coding assistants change source
declarations, bootstrap configuration or platform code, never manually commit repairs to
GitOps. The publisher produces a coherent transaction containing every affected projection.
Bootstrap and source watchers use the same compiler. Compilation covers all registered
teams before pruning; a failed compilation publishes nothing.

Source checks, production startup, deployment readiness, transport verification, activation
and behavioral acceptance are separate gates. An unavailable or skipped requirement cannot
become a passing result. Resumption checks authoritative state before reusing evidence.

## Reason

Public onboarding issues #1–#13 document missing deployments after profile publication,
private-clone failures, missing production dependencies and separately published Nexus
updates. These are missing orchestration and validation, not extra operator workflows.

## Cost

The compiler must carry ownership and exact revisions across multiple repositories. Existing
environments need explicit source registration before complete generation can safely replace
their projections. Integration providers retain ownership of credentials and activation;
onboarding cannot invent missing access or treat fixtures as live proof. Legacy single-source
commands remain useful for local inspection but are not the production publication path.

Nexus discovers named watcher records by their reconciliation label. Its reader therefore needs
namespace-scoped ConfigMap list permission in addition to existing named reads; it never reads
Kubernetes Secrets. Each record keeps independent staleness and retry context.
