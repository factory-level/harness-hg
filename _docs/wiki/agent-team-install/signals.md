# Signals: observability, alerts, events and evals

**What this page tells you:** what your application gets for free, and what it can declare
on top.

## Observability: nothing to declare

Every agent gets a dashboard and a rule group by being deployed. Supporting workloads expose
their own metrics and Prometheus scrapes them.

To add your own cards and views, write `agents/eve/<name>/harness-hg/dashboard.yaml`: the
components the agent ships, its people and groups, and where they sit. A card's
`display.icon` names an avatar code. These are data, never code, compiled into the Nexus UI
plan by `hg nexus emit`.

Check what landed with `hg dash list`, which compares declared dashboards against what
Grafana imported by uid.

## Alerts: nothing to declare, tuning allowed

Three shipped alerts apply to your agent automatically. Two business-outcome rules are off by
default because only some applications emit the metric. Turn either on and the platform adds
`BusinessTelemetryMissing`, which fires when the metric stops arriving at all. Thresholds are
yours to tune. See [Alerts and alarms](../platform/alerts.md).

## Events: declared

### Outputs

An app declares a typed event it publishes. `outputs` lives on the app's entry:

```yaml
apps:
  - name: monitoring
    outputs:
      - name: alerts
        event: observability.alert/v1
        subject: namespace
        adapter:
          type: webhook
          inject:
            appValue:
              path: alert.webhookUrl
```

The platform mints the ingest URL and writes it at the path you named. **You never write
the URL.** Declare a `subject` when order matters.

### External inputs

```yaml
# agents/eve/<name>/harness-hg/endpoints.yaml
externalInputs:
  - name: brand-brief
    event: strategy.brief-updated/v1
    subject: repository.full_name
    verification:
      type: github-hmac-sha256
      secretRef:
        name: <secret-name>
        key: <secret-key>
```

Give each input its own secret. Revoking a shared one revokes both.

### Routes

Where events go: fan-out to several agents, keyed sessions, FIFO on a subject, delivery to
ChatOps, dead-letter retention. You declare the shape; the environment binds the provider.
See [Event routing](../platform/webhooks-events.md).

## Evals: declared, never deployed

```text
evals/suite.yaml
evals/scenarios/<name>/scenario.yaml
```

`hg eval --dir <repo>` runs them. Nothing in the cluster reads them. Results publish to
Nexus UI with a scoped token, idempotent on `(componentId, runId)`. See
[Nexus UI](../platform/nexus.md).

## In Nexus UI

| Declared | Appears as |
|---|---|
| Dashboards | cards and relationships on the canvas |
| Outputs and routes | edges in the Alert Routing view |
| External inputs | inbound event objects |
| Evals | results on the Agents view, `stale` after 168 hours |

## The exact fields

[Agent team contract](../reference/contracts/agent-team.md),
[Dashboard contribution](../reference/contracts/dashboard-contribution.md),
[Eval suite](../reference/contracts/evals.md).
