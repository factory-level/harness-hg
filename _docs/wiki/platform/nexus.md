# Nexus UI

**What this page tells you:** what Nexus UI reads, what needs a credential, and how the
platform and Nexus UI trust each other.

**Nexus UI** is the operations surface: a canvas showing the fleet, its communication, its
agents and its backups. It reads from the platform. Nothing you do in it changes what is
deployed. Using it: [Nexus UI](../nexus-ui/index.md).

## What is automatic

| Nexus UI reads | From | Credential |
|---|---|---|
| Application health | the Argo CD API | a mounted service-account token |
| Metrics | in-cluster Prometheus | none |
| Communication activity | the event router | none |
| Backup status | CronJob status | none |
| The canvas | the committed dashboard plan | none |

Router receipts live in memory: that panel answers "what just happened". Backup rows go
stale after 48 hours. Eval results older than 168 hours read `stale`. A source nobody
configured reads `unknown`.

## What you configure: eval publishing

Publishing eval results into Nexus UI needs a token. An owner mints it in the UI. It is
scoped to component ids, may expire, and is shown once. Only a digest is stored. Tokens
begin `hgev_`.

```bash
hg eval --dir <repo>
hg eval publish --control-plane <url> --report <report.json> --component <id>
hg eval results <component> --control-plane <url>
hg eval prove --control-plane <url> --component <id>     # EVALPUB001..004
```

The token comes from `HG_EVAL_TOKEN` or `--token-file`, never an argument. A publish is
idempotent on `(componentId, runId)`, so retrying is safe.

## Two credentials, not one

| Credential | For |
|---|---|
| Eval token (`hgev_`) | machines publishing results |
| OIDC sign-in | people using the UI |

Roles come from the platform, never from a token. See [IAM](identity.md).

## Known gap

There is no eval panel on the canvas yet. Results show on the Agents view.

## Where to go next

- [Credentials](../runbooks/credentials.md), every credential an operator holds
- [Observability](observability.md), the other data Nexus UI renders
