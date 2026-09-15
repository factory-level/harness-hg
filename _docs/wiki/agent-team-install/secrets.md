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

One Secret per instance, `ag-eve-<name>-env`, mounted with `envFrom`. **A required variable the
installation would not deliver stops `hg team plan`, `apply` and `resume` before anything is
provisioned or published.** The refusal names the agent, the variable, the `agent.yaml` that
declares it, and both fixes: a `credentials.bindings` line, or the `pulumi config set` command.
The same happens when the value is empty plaintext, still an unset placeholder, or a required
secret missing from the agent's `environment` list.

Two things the install cannot see: whether an encrypted value is empty, and whether a
credential is still valid. Both give a pod that starts. A `required: false` variable is never
checked.

The platform decides where values come from, how they travel, and when. Nothing you declare
changes that. An override cannot decide you do not need a secret.

## In Nexus UI

Nothing, on purpose. Names appear in the agent's configuration summary. Values never leave
the cluster.

## The exact fields

[Agent team contract](../reference/contracts/agent-team.md). The platform side:
[Secrets](../platform/secrets.md).
# Managed credentials in team installations

A bootstrap team plan can reuse existing credentials without copying plaintext into source.
`credentials.inputs` maps operator environment names to namespace-qualified Pulumi config paths
in `credentials.configFile`. `credentials.secretInputs` names an existing Kubernetes namespace,
Secret and key when another provider owns delivery. Hg resolves these inputs before source
resolution and production startup, using the plan's stack and Kubernetes context.

An agent's `environmentBindings` maps its runtime variable names to those operator references.
Use distinct references when several agents require names such as SLACK_BOT_TOKEN with different
values. Credential changes invalidate startup evidence. No input value belongs in the plan.

For an existing chart that requires literal credential values, per-agent `appValueBindings`
maps dotted `appValues` paths to managed input names. Each target must be an explicit
`{secret: true}` marker. Hg resolves these from the owning managed Secret, passes values to
the emitter over stdin, and withholds sensitive profile diff sections, including prior values, from preview output. The legacy chart
still consumes those values in generated records; this does not convert it to Secret refs.
Never leave an unresolved marker in chart values or put a credential in the installation file.

Before reading any of these, hg proves it can: the stack's state backend (derived from the
environment's spec, and refused when `PULUMI_BACKEND_URL` says otherwise), the stack, your
Google credentials, and the kube context the plan reads Secrets through. It reports every access
problem at once, then every missing value at once. [Credentials](../runbooks/credentials.md)
lists each refusal and its fix.
