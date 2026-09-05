# Outbound events

**What this page tells you:** how a delivery leaves the event router, and what the two kinds
of destination are.

## The outbound processor

A queued event is picked up by the router's consumer, fanned out to every destination its
route names, and delivered one at a time per ordering key. A delivery that fails is retried,
then parked in the dead-letter queue.

```text
queue → fan-out → per-key delivery → agent webhook | chat message
                                   ↘ dead-letter queue (list, replay)
```

## Two kinds of destination

| Edge | Delivers | How |
|---|---|---|
| `agent` | the event to an agent | an HMAC-signed POST to the agent's webhook, with a session key and a delivery id. A 2xx is recorded as accepted |
| `chatops` | a message to a chat space | a generic webhook (the URL is the credential) |

Outbound is **webhook or web request only** today. There is no other transport.

## What is recorded

Every delivery is a record: which bundle produced it, which component carried it, and
whether the destination accepted it. A fan-out to three agents is three records. Nexus UI
draws its Alert Routing view from these records. They live in the router's memory, so the
view answers "what just happened", not "what happened last week".

## Proof

```bash
hg communication prove      # the whole communication matrix
hg event dlq                # what did not get through
```

## Where to go next

- [Event routing](webhooks-events.md), routes and durability
- [ChatOps](chat-conversations.md), how an agent talks in Slack
