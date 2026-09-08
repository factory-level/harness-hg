# 0181 — Proactive Slack operations

## Decision

An operational team owns durable scheduled work and initiates conversations on its
declared chat surface. Delivery receipts, task progress and provider outcomes are
distinct from pod readiness. Slack app manifests enable both events and interactivity
once the receiving endpoint is ready. Schedules and business approval state belong to
the team; the platform provisions credentials, bindings, runtime and monitoring.

For the factory social-media team, Eve takes operational ownership under role names without the legacy
runtime prefix or twin suffix. Board, Postiz and conversation volumes move through
retained-volume rebinding; Slack provisioning aliases preserve existing app identities. A publishing
tool requires an approval of the exact content, media, destinations and time by the
configured Slack user. Message signatures authenticate the sender; they do not grant
publication authority by themselves.

## Reason

The factory had ready pods and working Slack mentions while its check-in and research
jobs were paused and its check-in targeted Discord. The Slack-facing agents were
explicitly non-operational. The operator requested a complete proactive workflow.

## Cost

The team now owns SQLite workflow storage, backups, occurrence deduplication and
provider reconciliation. Ambiguous publication attempts require investigation; they
are never blindly resubmitted. Renaming namespaces requires a coordinated maintenance window, verified backups
and stopped writers before existing volumes can be rebound. Workflow activation requires role credentials and coordinated event routing.

Changes the intended behavior in `../design/chat-surfaces.md`.
