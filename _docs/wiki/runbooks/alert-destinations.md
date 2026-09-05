# Alert destinations

**Outcome:** platform alerts arrive somewhere a person or an agent will see them, proven by
making a real alert fire and watching it land.

The model: [Alerts and alarms](../platform/alerts.md). The supported destination is a
**generic JSON webhook**. Anything that accepts a JSON POST works: a Slack incoming webhook,
an on-call tool's webhook, your own endpoint.

Nothing watches from outside the cluster. A dead cluster alerts nobody.

## Which path do you want?

| You want | Path |
|---|---|
| the shipped per-agent alerts delivered somewhere | 1, the normal case, one value |
| cluster-level alerts (node, etcd, apiserver) | not available; they route to `null` |
| alerts to reach an agent, durably | 4, the event router |

## Path 1: the Grafana contact point

All six shipped rules go here. They never enter Alertmanager.

```bash
pulumi config set --path 'agents[<i>].overrides.appValues.monitoring.alert.webhookUrl' https://<your-endpoint>
pulumi up --cwd infra
```

For every agent at once, put the same key in your fleet defaults `appValues`. The
per-instance override wins. On a generated stack, author it in
`infra/environments/<env>.yaml` and `hg env apply <env>`.

Fleet budget alerts are a second value in the fleet-dashboard chart. Set it the same way.

## Path 4: the event router

For alerts an agent should act on, with queueing, retries and a dead-letter queue. The
router's ingest URL is compiled into the record as Grafana's `alert.webhookUrl` from the
producing app's declared output. Nothing else sets it.

```bash
hg topology emit --dir <repo> [--output <destination-clone>]
```

## Rotating a destination

A webhook URL with a token in it is a credential. Set the new one the same way, prove, then
retire the old endpoint. Never commit a webhook URL.

## Common failures

| Symptom | Cause |
|---|---|
| nothing arrives, render succeeded | you configured Alertmanager; use path 1 |
| build fails: rule enabled with no receiver | configure a destination or disable the rule |
| node or etcd alerts never arrive | expected; no fleet-level receiver exists |
| firing arrives, resolved does not | the destination drops the resolve payload; alarms never clear |
| business alerts never fire | off by default, and they read a metric your app may not emit |

## Proof

Make an alert fire. Scale an agent to zero, wait out the five-minute pending window, and
confirm the alert lands. Scale it back and confirm the resolve lands too.

```bash
kubectl scale statefulset ag-eve-<name> --replicas=0 -n ag-eve-<name>
# wait 5 minutes; the alert arrives at your destination
kubectl scale statefulset ag-eve-<name> --replicas=1 -n ag-eve-<name>
```

Or let the proof do it:

```bash
hg communication prove --dir <repo> --require-live-grafana
```

**Done when** both the firing and the resolved notification arrive.
