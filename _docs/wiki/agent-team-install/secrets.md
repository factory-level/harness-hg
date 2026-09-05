# Secrets

**What this page tells you:** how to ask for a secret, and why you never supply one.

## What it means

You declare the environment variables your agent needs, **by name**. You never declare a
value, and you never say where a value comes from.

## What you write

```yaml
# agents/eve/<name>/harness-hg/agent.yaml
envRequires:
  - name: SLACK_BOT_TOKEN
    description: posts to the team channel
    required: true
    secret: true
```

A bare string means `required: true, secret: true`. `required: false` is a real choice: your
code has to handle the variable being absent. Write the `description` for someone who does
not know your application. It is all an operator sees.

For a private source repository, `gitAuthSecretRef` names a Secret in your namespace. A
name, not a credential. On the local loop, `hg envfile set GIT_TOKEN=<token> --profile <name>`
fills it for an HTTPS source on the next `hg up`.

## What you get

One Secret per instance, `ag-eve-<name>-env`, mounted with `envFrom`. **A missing required
value stops the install before anything is written to Git**, naming what is missing. You
will not find it as a crash-looping pod.

The platform decides where values come from, how they travel, and when. Nothing you declare
changes that. An override cannot decide you do not need a secret.

## In Nexus UI

Nothing, on purpose. Names appear in the agent's configuration summary. Values never leave
the cluster.

## The exact fields

[Agent team contract](../reference/contracts/agent-team.md). The platform side:
[Secrets](../platform/secrets.md).
