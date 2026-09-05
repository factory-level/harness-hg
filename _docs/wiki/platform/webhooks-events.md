# Event routing

**What this page tells you:** how the platform abstracts events, and how one gets from a
producer to a consumer.

## Events are not alerts

An alert asks a person to look. An event tells a system something happened. The platform
keeps them apart: alerts are [Grafana rules](alerts.md); events go through the **event
router**. An alert can be pointed at the router when an agent should act on it.

## The router

One workload receives typed events, decides where they go, and delivers them. An event is a
typed envelope: a name like `observability.alert/v1`, a payload, and an ordering key.

| Side | What it is | Page |
|---|---|---|
| **Inbound** | three doors an event can enter through | [Inbound events](inbound-events.md) |
| **Routes** | which source goes to which destinations | below |
| **Outbound** | how a delivery leaves: an agent webhook or a chat message | [Outbound events](outbound-events.md) |

## How events are declared

You declare events in the Agent Team Repo. The environment binds them to real providers.
The repo says "deliver this to ChatOps"; the environment says which ChatOps.

| You declare | Where | Means |
|---|---|---|
| An **output** | `outputs[]` on an app | a workload publishes an event; the platform mints its ingest URL and injects it |
| An **external input** | `communication.externalInputs[]` | something outside pushes in, signed |
| A **route** | `communication.routes[]` | one source to one or more destinations |

**You never write a URL.** It does not exist until the topology compiles.

```yaml
outputs:
  - name: alerts
    event: observability.alert/v1
    adapter:
      type: webhook
      inject:
        appValue:
          path: alert.webhookUrl
```

## What a route can express

- **Fan-out.** One inbound push delivered to several agents.
- **Ordering.** FIFO per ordering key, concurrent across keys.
- **Sessions.** Keyed delivery, so related events land in the same agent session.
- **Durability.** Queued delivery with retries and a dead-letter queue.

## Durability

Durable delivery runs on Redis Streams: a consumer group, done-markers with a TTL, retries,
a dead-letter queue you can list and replay, and deduplication over a rolling window.

Without Redis the router still runs, with an in-memory window and no queued delivery. A
route that requires durability refuses to compile rather than degrading quietly.

```bash
hg event list                 # every declared event
hg event queue test           # prove the queue end to end
hg event dlq                  # what failed
hg event dlq replay           # send it again
```

## What is not here

- No event history. Nothing stores delivered events for later query.
- Redis Streams is the only transport.

## Where to go next

- [Inbound events](inbound-events.md), the three doors
- [Outbound events](outbound-events.md), the two delivery kinds
- [Signals](../agent-team-install/signals.md), declaring events in your repo
