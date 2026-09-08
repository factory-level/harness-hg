# 0183 — Slack alert delivery

## Decision

Slack is the supported chat provider; Discord support is withdrawn to the roadmap.
The active CLI, provider adapters, templates and supported-feature documentation must not
expose Discord integration. This also removes the Discord subject from `_docs/design/cli.md`.
Historical migration records remain historical evidence.

The event router implements outbound Slack ChatOps delivery using a declared bot credential
reference and channel ID. Grafana producers send their existing typed webhook events through
that route. Runtime-specific namespaces determine agent webhook signing-secret keys.

## Reason

Slack is already a declared connection provider, but the router rejected it as unavailable.
Factory Grafana contact points still sent directly to Discord after the fleet moved to Eve,
while its agent delivery keys retained Hermes namespace names. Declared routing must match
working provider delivery and the actual runtime identities.

## Cost

The router now maintains a Slack Web API adapter and tests both HTTP and Slack JSON failures.
Slack rate limits remain subject to the existing bounded delivery retry/dead-letter policy.
Operators must provision bot membership and explicitly retire old Grafana provisioning files;
removing a chart or contact-point declaration alone does not delete persisted Grafana rules.
