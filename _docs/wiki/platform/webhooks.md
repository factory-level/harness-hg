# Webhooks

**What this page tells you:** how a machine outside the environment reaches a webhook
inside it, when every other hostname sits behind a sign-in.

## The problem

Slack, GitHub and the event router's external inputs are called by machines. A machine
cannot sign in to the edge's access policy. An access policy of any kind blocks it.

## The answer: declared no-Access hostnames

`controlPlaneIngress.webhookEndpoints` publishes one hostname per declared webhook with no
access policy in front of it. On those hostnames the request signature verified at the
origin is the only authentication. The set is declared explicitly, and it is small. Read it
as a bounded exception, not the pattern.

```text
provider → https://<webhook>.<zone>  (tunnel, no Access)  → router or agent → signature check
```

| Caller | Lands on | Verified by |
|---|---|---|
| Slack Events API | the agent's Slack Request URL | Slack's signing secret |
| GitHub App | the router's `/v1/connect/github/<name>` | GitHub's HMAC |
| Anything with a shared secret | the router's `/v1/hooks/<slug>` | HMAC-SHA256 |

## What the router needs

The router's own hostname is not a declared webhook endpoint yet. External inputs reach it
through the same tunnel as everything else. Publishing the router as a webhook endpoint is
a [roadmap](../roadmap.md) item.

## Proof

```bash
hg edge prove --stack <stack>     # undeclared hostnames are not published
hg slack prove <env> --agent <name>
hg connection prove
```

## Where to go next

- [Inbound events](inbound-events.md), what happens after the request is verified
- [Tunnels](tunneling.md), the path the hostname rides
