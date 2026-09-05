# Minimal agent

**Goal:** the smallest thing the platform will install and run.

## The repository

```text
my-agent/
  harness-hg/
    team.yaml                        # required: the team's name
  agents/eve/my-agent/
    harness-hg/agent.yaml            # required: the harness
    src/package.json                 # depends on eve at the platform's pin
    src/package-lock.json            # required: the pod runs npm ci
    src/agent/instructions.md        # required by eve
```

`hg bundle init ../my-agent --agent my-agent` writes exactly this.

## The declaration

`harness-hg/team.yaml`:

```yaml
apiVersion: hermes-gitops.factorylevel.dev/agent-team/v1alpha1
kind: AgentTeam
name: my-agent
harnesses: [eve]
```

`agents/eve/my-agent/harness-hg/agent.yaml`:

```yaml
apiVersion: hermes-gitops.factorylevel.dev/agent-team/v1alpha1
kind: Agent
harness: eve
envRequires:
  - ANTHROPIC_API_KEY
```

That is all of it. You get an agent in its own namespace, with its own volume, reconciled
from Git, with the observability baseline and the three shipped alerts. No workloads, no
endpoints, no backup routine, no events.

## Install it

```bash
hg onboard ./my-agent
hg validate
hg up
```

## What gets generated

```text
profiles/my-agent/profile.yaml        the record, plain Helm values
deployments/agents/my-agent/          the deployment record
catalog/profiles/my-agent/            provenance
```

## Prove it is running

```bash
hg test --tier register     # it registered
hg test --tier smoke        # it runs
hg prompt "say hello" --profile my-agent
```

## In Nexus UI

One agent card with health from Argo CD. No workloads, no edges, no backup row, because
you declared none.

## What you gave up

| Not present | Add with |
|---|---|
| A backup routine | [Backups](../backups.md) |
| A reachable endpoint | [Endpoints](../endpoints.md) |
| Supporting services | [Supporting workloads](../workloads.md) |
| Inbound events | [Signals](../signals.md) |

Next: [Software project agent](software-project.md) adds one thing, a repository to read.
