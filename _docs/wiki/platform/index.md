# Platform

**What this page tells you:** what Harness Hg gives you, capability by capability, and where
to read more.

The platform takes a declaration in a repository and keeps the workloads running, watched,
reachable and recoverable. You run none of the machinery that does it.

## The capability map

| Capability | What it gives you | Built on |
|---|---|---|
| [GitOps](reconciliation.md) | Declared state becomes running workloads and stays that way | Argo CD, Helm |
| [Observability](observability.md) | Metrics, logs and dashboards for every agent, without asking | Prometheus, Grafana, Loki |
| [Communication](alerts.md) | Alerts reach people; events reach systems, in order and durably | Grafana, the event router, Redis |
| [ChatOps](chat-conversations.md) | An agent holds a conversation where your team already is | Slack |
| [Harness](runtime.md) | The runtime that boots your agent and talks to the platform | Eve |
| [Nexus UI](nexus.md) | One operations surface over all of it | Nexus UI |
| [Secrets](secrets.md) | Values reach workloads and never reach Git | External Secrets Operator |
| [IAM](identity.md) | One sign-in across Nexus UI, Argo CD and Grafana | Dex (OIDC) |
| [Backup](backups.md) | Application routines and whole-environment snapshots | GCS |
| [Networking](topology.md) | Where things run, tunnels in, webhooks in | Cloudflare Tunnel |
| [Testing](testing.md) | Every claim has a proof command | the proof commands |
| [Security](security.md) | What you can and cannot rely on | |

## Why each of these is here

- **Argo CD** reconciles, so nothing pushes to your cluster. The declared state is the only
  state. A record is plain Helm values.
- **Prometheus, Grafana and Loki** give every agent a dashboard, a rule group and a week of
  logs for free.
- **The event router** exists because telling a person and telling a system are different
  jobs. It adds durability, ordering, retries and a dead-letter queue on Redis.
- **Cloudflare Tunnel** makes an endpoint reachable without opening an inbound port.
- **External Secrets Operator** moves values to workloads so they never sit in Git.
- **GCS** holds backups, with separate write and read identities.
- **Nexus UI** reads. It is not a second control plane.

## The platform version

The version in the header of this manual is computed from the commit history, not stored
anywhere. `feat:` bumps minor, `fix:` bumps patch. `v0.Y.Z` is a tagged release;
`v0.Y.Z-dev+<sha>` is a working build. Pinned binaries and charts live in `versions.json`.
Contract versions are directory names and never change once published.

## What the platform does not do

- No traces, no SLOs. Logs stop at 168 hours and one cluster.
- No secret rotation lifecycle.
- No alert severity model, deduplication, silencing or escalation.
- No compatibility matrix between platform and contract versions.

Each limit is stated on the page it belongs to.
