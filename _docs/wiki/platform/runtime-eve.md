# Eve agent

**What this page tells you:** how an agent on the Eve harness is built, booted, secured,
backed up and reached once its record is in Git. Authoring one is
[Eve agents](../agent-team-install/eve-agents.md).

[Eve](https://github.com/vercel/eve) is a filesystem-first framework for durable agents: a
directory of files (`instructions.md`, `tools/`, `channels/`, `schedules/`, `subagents/`)
that `eve build` compiles and `eve start` serves. The platform deploys it with the
`eve-agent` chart, or `eve-bundle` when agents share a pod.

## Naming

An Eve instance is `ag-eve-<name>`: its namespace, Application, Service, StatefulSet and
every derived Secret. A bundle is `ag-eve-<bundle>`.

## The pod

One StatefulSet, one replica, one data volume, two containers on the eve-runtime image:

1. **`build-agent`** (init). If the volume's stamp differs from `spec.sha`, it clones the
   source at that commit, runs `npm ci`, installs the platform's default channel when the
   agent authored none, runs `eve build`, and writes the stamp. Same sha, nothing to do.
2. **`eve-agent`**. `eve start` on port 3000. Health is `GET /eve/v1/health`.

Durable state lives outside the checkout under `/app/state/`, so a new commit never touches
a session. That is also what the backup protects.

## What the agent got

Every pod mounts `/hg/runtime-manifest.json`: engine, resolved revision, workspaces with the
path the pod reads them at, the environment variable **names** it needs, and its bound
connections. Names only, never a value.

```bash
hg agent show    --profile echo      # the manifest + what the running process reports
hg agent inspect --profile echo      # the same manifest, no cluster
```

## The version pin

`versions.json` holds the one Eve version. The image bakes it, the chart defaults to it, and
a project whose lockfile resolves a different `eve` is refused before anything reaches Git.

## Route auth

The chart mints one Basic credential per instance in Secret `ag-eve-<name>-route-auth`. The
pod reads it from a file on every request, so a re-minted Secret needs no restart. `hg`
reads the same Secret. The health route stays public.

## Backup

The agent's `backup` declaration becomes a platform backup routine. The archive holds the
state directory, the checkout and the build stamp. It leaves out what the boot script
rebuilds from the pinned commit. After a restore, sessions from before the backup replay.

## Bundles

A team's `harness-hg/bundles.yaml` puts several Eve agents in one pod. Each member gets its
own port, credential, env Secret and state root on the shared volume. One backup routine
archives the shared volume. Every `hg` command resolves a bundled member to its bundle.

## Workspaces

A [workspace binding](../runbooks/workspace-bindings.md) reaches the pod as a checkout at
the pinned sha. The agent finds it through `EVE_WORKSPACE_<NAME>`. A clone that fails
degrades loudly; `hg workspace verify` reports it.

## Schedules, hooks, sandbox

| Eve feature | On the platform |
|---|---|
| `agent/schedules/` | fire in-process in the pod. One replica, so one firing |
| `agent/hooks/` | observe-only; what they print is the pod log |
| `agent/sandbox.ts` | `justbash()` is the only backend a plain pod runs. It is not isolation |
| `agent/subagents/` | run inside the pod as child sessions |

## Reaching it

The Service exposes 3000. The Ingress forwards two prefixes: `/eve/` and
`/.well-known/workflow/`. Forwarding only the first starts sessions that stall. An Eve agent
is published through the environment's shared tunnel as `<name>.<zone>`; it has no tunnel of
its own. See [Tunnels](tunneling.md).

A production Eve agent also carries a Slack surface on its own no-Access hostname. See
[ChatOps](chat-conversations.md).

## The agent's own evals

`hg agent evals` runs the project's `evals/*.eval.ts` from inside the pod against the served
process. Exit 0 is every gate passed. The platform's own evals (`hg eval`) drive the same
session API from outside.

## Proof

`hg agent prove` reports EVE001..024 per agent: health, the Workflow callback route, the
Basic challenge, a real turn, byte-identical renders, the session and stream contract,
schedules, subagents, the backup ledger, a restore round-trip (`--deep`), workspaces, child
Applications, the runtime manifest, and the chat channel. A leg whose precondition is
absent reports `unknown`, never a pass.
