# hermes-alerting

A Helm **library** chart. It renders nothing; it exists so `charts/monitoring` and
`control-plane/fleet-dashboard/chart` stop carrying two copies of the same Grafana
contact-point machinery (#619).

## What is shared, and what is not

Shared, because it was byte-identical in both charts:

| Define | Renders |
|---|---|
| `hermes-alerting.contactPoints` | the whole `contactPoints:` block — both receiver shapes |
| `hermes-alerting.notificationSettings` | the per-rule `notification_settings` block |
| `hermes-alerting.receiversGuard` | the "rules with nowhere to go" render failure |

**Not** shared, because the two charts differ for real reasons:

- **uid prefix.** `charts/monitoring` is one release *per profile namespace*, so
  its uids derive from the namespace. `control-plane/fleet-dashboard/chart` is a cluster
  singleton, so its uids are constants. Grafana treats a changed uid as
  delete-and-create, which resets alert state — so the scheme must stay stable per
  consumer, and therefore stays a parameter.
- **contact-point name.** Same reason.
- **the rules themselves.** Zero overlap: budgets versus health, business outcomes
  and site visits.

Every define takes an explicit dict rather than reading `.Values`, because the two
consumers' value trees are not the same shape.

## How it reaches the consumers

`helm dependency update` runs **nowhere** in this repository — Argo CD syncs both
charts from bare Git paths, so nothing would fetch a dependency at deploy time.
This chart is therefore **committed into each consumer's `charts/` directory** as
an unpacked copy, which `helm template` resolves with no fetch step.

Those copies are generated. Do not edit them:

```bash
make alerting-lib          # regenerate both copies from this directory
make alerting-lib-drift    # fails if a copy has drifted (part of `make test`)
```

## What this does not fix

The two charts remain **separate Helm releases fed by unrelated value channels** —
`pulumi config set --path 'agents[<i>].overrides.appValues.monitoring.alert.webhookUrl'`
for one, a hand-edited `bootstrap/fleet-dashboard.yaml` `valuesObject` for the
other. Sharing a template does not share a value, so an operator still configures
the webhook URL twice. The cross-reference in `charts/monitoring/values.yaml` is
what addresses that; this chart addresses the maintenance half only.
