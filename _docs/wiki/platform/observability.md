# Observability

**What this page tells you:** what the platform measures, where it lands, and what you get
without asking.

## What you get by default

| Component | Provides |
|---|---|
| **Prometheus** | metric collection and storage, in-cluster |
| **Grafana** | dashboards and alert rule evaluation |
| **Loki** + promtail | log collection and storage, in-cluster, 168 hours |

Every agent ships a dashboard and a rule group as ConfigMaps. Grafana imports them by label.
You declare nothing to get the baseline.

## Metrics

Supporting workloads expose their own metrics and Prometheus scrapes them. An Eve agent
exposes none today. An application can add dashboards by declaring them:
[Declaring capabilities](../agent-team-install/declaring-capabilities.md).

## Logs

A promtail DaemonSet collects every pod's logs into Loki. Being scheduled is what enrolls a
pod. Streams carry `plane=control-plane` or `plane=workload`, so the two never mix in a query.

| Where to read them | For |
|---|---|
| The `hg-control-plane-logs` dashboard | the plane split, prebuilt |
| Grafana Explore, datasource `loki` | anything else |
| `hg logs` | one pod, plus crash context and Argo conditions |

`hg logs` reads kubectl, not Loki. It answers "what did this pod just do".

## Did it land?

Declaring a dashboard and Grafana importing it are two events:

```bash
hg dash list      # declared ConfigMaps vs what Grafana actually imported, by uid
hg dash errors    # broken datasources and expressions
```

## The runtime overlay

Nexus UI and `hg observability` read one document describing every source:

```bash
hg observability inspect     # the workload inventory with live source levels
hg observability prove       # OBS001..OBS010
```

A source nobody configured reads `unknown`, never green. That is the rule the proof checks.

## What is not here

- No traces.
- No SLOs.
- Logs stop at 168 hours and one cluster. Router receipts live in memory.

## Where to go next

- [Alerts and alarms](alerts.md), what fires and where it goes
- [Nexus UI](nexus.md), the surface over this data
- [Testing](testing.md), the proof commands
