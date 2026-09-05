# ChatOps

**What this page tells you:** how an agent behaves in a chat workspace, and why the gateway
belongs to the harness.

An agent in chat behaves like an assistant you already know: you `@mention` it, it answers
in a thread under your message, and you keep talking in that thread.

## The gateway is the harness's

Each harness brings its own chat gateway. The platform does not run one. That is more robust
than a gateway of our own: the harness already knows how to thread, stream, type and ask a
human for input. The platform supplies the transport around it: the app, its credentials,
the public URL, and the proof.

**Slack is the supported surface today.**

## The contract

Every surface follows six rules:

1. Invocation is explicit: an `@mention` or a direct message.
2. The thread is the session.
3. Follow-ups in the thread need no mention.
4. The invoking person is the principal.
5. Acknowledge first, then answer in place.
6. Human-in-the-loop uses the surface's own buttons and modals.

## Slack

Slack's Events API POSTs a mention to a Request URL. The channel file in the agent is four
lines; everything around it is provisioned from the environment spec: the app, its
credentials (captured into encrypted state at creation, never pasted), channel membership
and the event subscription. Declare the `slack:` block and run `pulumi up`.

The Request URL is a hostname with no access policy, because Slack cannot sign in. Slack's
request signature verified at the origin is the authentication. See [Webhooks](webhooks.md).

```bash
hg slack prove <environment> --agent <name>    # SLK001..004
```

Walkthrough: [Slack apps](../runbooks/slack-apps.md).

## Adding a surface

1. A channel file. Use the harness's first-class channel when one exists.
2. A connection provider if the credentials are shared rather than per-agent.
3. Whatever the transport needs: a public Request URL for a webhook surface.

Do not add an abstraction over providers. The six rules are the abstraction.

## Where to go next

- [Inbound events](inbound-events.md), how the credentials and the callbacks arrive
- [Eve agent](runtime-eve.md), the pod the channel runs in
