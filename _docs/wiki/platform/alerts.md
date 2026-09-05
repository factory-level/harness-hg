# Alerts and alarms

**What this page tells you:** which alerts ship, and how one reaches a person or a system.

## The alerts that ship

Every agent gets a rule group as a ConfigMap. Grafana imports it. Three rules are on unless
you turn them off:

| Alert | Fires when | Severity |
|---|---|---|
| `HermesAgentDown` | the agent has no ready replica for 5 minutes | critical |
| `AgentAppUnhealthy` | a supporting workload has unavailable replicas for 5 minutes | critical |
| `SiteVisitsHigh` | request rate crosses a threshold (default 100) | warning |

Three more read a business metric only some applications emit, and are off by default:
`BusinessOutcomeFailures`, `BusinessOutputBelowMinimum`, and `BusinessTelemetryMissing`. The
last one fires on **no data**, so a pipeline that stops reporting does not look like success.

Each rule routes through its own `notification_settings`. No agent edits Grafana's root
policy. A render guard fails the build if a rule is on with no receiver.

## Tuning

You own the thresholds and the on/off switches for your own rules. Set them in the agent's
declaration; the platform renders the rule group. See
[Signals](../agent-team-install/signals.md).

## The routing paths

| # | Path | Carries |
|---|---|---|
| 1 | Grafana rule → contact point → webhook | the six alerts above. The normal case, one value |
| 2 | The same, from the fleet dashboard chart | fleet budget alerts. A second value in a second chart |
| 3 | Prometheus rules → Alertmanager → receiver | cluster-level rules only |
| 4 | Path 1's webhook, pointed at the event router | an alert delivered to an agent, durably |

Paths 1 and 3 are separate systems. The shipped alerts never enter Alertmanager. Path 4 is
path 1 with a different address: the router adds queueing, retries and a dead-letter queue.
See [Event routing](webhooks-events.md).

Cluster-scoped alerts (node, etcd, apiserver) carry no namespace label and route to `null`.
Nothing listens for them today.

## What is missing

- No severity model, deduplication, grouping, silencing or escalation.
- No outside-in watcher. A dead cluster alerts nobody.
- No fleet-level receiver for cluster-scoped alerts.

## Where to go next

- [Alert destinations](../runbooks/alert-destinations.md), connect a path and prove delivery
- [Event routing](webhooks-events.md), the router path 4 uses
- [Configuration](../reference/configuration.md), where `alert.webhookUrl` is set
