# Software project agent

**Goal:** an agent that reasons about a codebase you already have, without that codebase
knowing anything about Harness Hg.

## The idea

Your application repository stays as it is. The agent lives in its own small repository and
is given the codebase as a read-only [repository mount](../repositories.md) at a pinned
revision.

```text
your-webapp/            unchanged
project-agent/          the team you install
  harness-hg/
    team.yaml
    workspaces.yaml     the mount
  agents/eve/project-agent/
    harness-hg/
      agent.yaml
      backup.yaml
      endpoints.yaml
    src/
```

## The declaration

`backup.yaml` is two lines: a schedule and a retention. `endpoints.yaml` carries the webhook,
the input that arrives on it, and the route:

```yaml
apiVersion: hermes-gitops.factorylevel.dev/agent-team/v1alpha1
kind: Endpoints
endpoints:
  - name: hooks
    port: 3000
    type: webhook
    signature: hmac-sha256
externalInputs:
  - name: pr-opened
    event: scm.pull-request/v1
    subject: repository.full_name
    verification:
      type: github-hmac-sha256
      secretRef:
        name: project-agent-scm
        key: webhook-secret
routes:
  - name: pr-review
    from: {externalInput: pr-opened}
    outputs:
      - agent:
          profile: project-agent
          handler: pr-opened
```

- `endpoints` gives the agent a webhook port. The environment decides the rest.
- `externalInputs` is how your forge pushes in. The secret is a reference.
- `subject` keeps events about one repository in order.

## The mount

```yaml
# harness-hg/workspaces.yaml
repositories:
  - name: webapp
    source:
      url: https://github.com/you/your-webapp.git
      revision: { mode: pinned, sha: <40-hex> }
      authSecretRef: webapp-git
    mount:
      access: read-only
bindings:
  - repository: webapp
    profiles: [project-agent]
    purpose: code-context
```

Start read-only. An agent that can write to your codebase is a different risk conversation.
Pinned means its reasoning is reproducible and moving it is an explicit act.

## Where the agent writes

Into its own volume, by default: notes, summaries, working state, protected by its backup
routine. Writing into the mount needs `read-write` and means commits on your repository.
Prefer the first unless you want an agent that commits.

## In Nexus UI

An agent card with a repository badge listing the mount and its revision. The webhook
appears as an inbound event object; the route as an edge in Alert Routing.

## How this differs

It hosts nothing. Its whole operational surface is one mount and one webhook. Compare
[Marketing team](marketing.md), where the opposite is true.
