# Marketing team

**Goal:** what a production agent team looks like, using the real one.

This is the reference installation, a private team repository:
four agents, two hosted services, and the machinery to keep them running. It is the
reference installation.

## The team

| Agent | Job |
|---|---|
| `marketing-manager` | The one human touchpoint. Dispatches work, holds the calendar, owns sign-off |
| `marketing-research` | Weekly research pass, producing dated candidate sets |
| `marketing-engagement` | Owns publishing. Stages approved work as drafts in Postiz |
| `marketing-sre` | Subscribes to every alarm. Debugs the team's own applications |

Four agents under `agents/eve/`, one `harness-hg/` at the root. One `hg onboard` registers all
four.

## The bundling decision

```yaml
# harness-hg/bundles.yaml
bundles:
  - name: marketing-core
    displayName: Marketing Team
    profiles:
      - name: marketing-manager
      - name: marketing-research
```

**Manager and research share a pod.** They coordinate constantly and idle together.

**Engagement and SRE do not**, for two reasons stated in the declaration:

- SRE must not share a failure domain with the agents it watches.
- Engagement carries Postiz, whose resource shape should not be another agent's problem.

A bundled agent loses its own Application, namespace and Service.

## The hosted software

| Chart | What it is |
|---|---|
| `postiz` | Social publishing. Carries Postgres, Redis and Temporal |
| `content-kanban` | A shared board the team works from |

Both are published as version-pinned OCI charts from the team's own repository. Real
software with real uptime, which is why the team has an SRE agent.

## What the manager declares

- **`apps`**: the kanban board with two endpoints, one private providing the `content-board`
  capability and one authenticated UI; a monitoring app whose `alerts` output is injected
  into `alert.webhookUrl`.
- **`requires`**: `content-board`, injected as an environment variable.
- **`endpoints`**: three webhook handlers, all `hmac-sha256`.
- **`externalInputs`**: a brand brief and a vision update, each with its own secret.
- **`routes`**: five. `brand-brief-fanout` delivers one push to both manager and research,
  keyed sessions, FIFO on the subject, 14-day dead-letter retention.
- **`backup`**: nightly, 14-day retention.

## Repository mounts

| Repository | Mounted to | Purpose |
|---|---|---|
| `vision-manager` (pinned) | manager, research, engagement | `strategy-context` |
| the operation's own source (`source: self`) | `marketing-sre` only | `operation-source` |

The SRE agent does not read the brand brief. The business agents do not read the deployment
configuration. Neither needed a deny rule: default access is none.

## What gets generated

One bundle Application plus two standalone agent Applications, app Applications for the OCI
charts, endpoint records, the router's configuration for five routes and two external
inputs, the Nexus UI plan, and provenance for all of it.

## In Nexus UI

A canvas titled **Social Media Operation**: the four agents, the hosted applications, the
operator as a Person, the team as a Group, and the edges between them. All of it is a
projection of what the repository declares.

## How this differs

Everything the other two omit: hosted services, a bundling decision, several agents that
must coordinate, an SRE agent, and a communication graph with fan-out and ordering. Start
from [minimal](minimal.md) and add these when you acquire them.
