# Declaring capabilities

**What this page tells you:** everything your repository can ask the platform for, and which
page explains each one.

The pattern is the same throughout: **you declare a need; the platform decides how to meet
it.** You never name a provider, a namespace or a URL.

## The declarations

Every declaration is a file under a `harness-hg/` folder: the agent's or the team's. One file
per concern. A file you do not write is a feature that is off. This is the complete set.

| Declaration | File | You are asking for | Page |
|---|---|---|---|
| `apps` | team `apps.yaml` | Supporting workloads, each owned by one agent | [Supporting workloads](workloads.md) |
| `endpoints` | agent `endpoints.yaml` | Something of yours becomes reachable | [Endpoints](endpoints.md) |
| `externalInputs`, `routes` | agent `endpoints.yaml`, team `apps.yaml` | Events in, and where they go | [Signals](signals.md) |
| `communication` | team `communication.yaml` | Aliases and durable transport | [Signals](signals.md) |
| `requires` | agent `agent.yaml` | A capability, named without a provider | [Endpoints](endpoints.md) |
| `backup` | agent `backup.yaml` | Your data gets protected | [Backups](backups.md) |
| `deployment` | agent `agent.yaml` | Pod knobs: image tag, disk size | [Supporting workloads](workloads.md) |
| `harness`, `envRequires` | agent `agent.yaml` | Which harness, and the variables it needs | [Eve agents](eve-agents.md) |
| `topology` | agent `agent.yaml`, team `topology.yaml` | Which layouts you support | [Supporting workloads](workloads.md) |
| `gitAuthSecretRef` | agent `agent.yaml` | A credential for a private source | [Secrets](secrets.md) |
| smoke checks, placeholders | agent `test.yaml` | What `hg test` checks locally | [Signals](signals.md) |
| `apiVersion`, `kind` | every file | Which schema the file is | [Contract files](../reference/contracts/index.md) |

Shared with the operator:

| Capability | Declared by | Page |
|---|---|---|
| Repository mounts | the team brings its own in `workspaces.yaml`; the operator grants extras | [Repository mounts](repositories.md) |
| Connections (a GitHub App) | the team declares in `connections.yaml`; the operator supplies the keys | [Inbound events](../platform/inbound-events.md) |
| Secret values | the operator, out of band | [Secrets](secrets.md) |

Free, with nothing to declare: **observability** and **alerts**. See [Signals](signals.md).

## How each page is organised

1. What it means
2. What you write
3. What you get
4. In Nexus UI
5. The exact fields, a link to Reference

## Where to go next

- [Repository scaffolds](../reference/repo-scaffolds.md), where each file goes
- [Contract files](../reference/contracts/index.md), the schemas
