# Eve agents

**What this page tells you:** what an agent on the Eve harness must contain, what each
declaration means for it, and how to test it. The platform half is
[Eve agent](../platform/runtime-eve.md).

An Eve agent is an npm project under `src/`, with its contract in the `harness-hg/` beside it:

```text
agents/eve/echo/
├── harness-hg/
│   ├── agent.yaml          # harness: eve, envRequires, requires, topology, deployment
│   ├── backup.yaml         # optional: schedule, retention
│   ├── endpoints.yaml      # optional: what the agent exposes, inbound webhooks
│   ├── dashboard.yaml      # optional: the agent's card in Nexus UI
│   └── test.yaml           # optional: hg test placeholders + smoke
└── src/
    ├── package.json        # name = echo; depends on eve at the platform's pin
    ├── package-lock.json   # REQUIRED: the pod installs with npm ci
    ├── agent/
    │   ├── instructions.md # REQUIRED by eve
    │   ├── agent.ts        # model, limits
    │   ├── channels/       # optional: eve.ts for route auth, slack.ts, …
    │   ├── subagents/      # optional
    │   ├── schedules/      # optional: fire in-process in the pod
    │   └── tools/, skills/, hooks/, sandbox.ts, instrumentation.ts
    └── evals/              # optional: eve's own evals (hg agent evals)
```

`examples/agent-team` is the reference copy: exactly what `hg bundle init` writes.

## The three rules

1. **The directory name is the identity.** `agents/eve/<name>` must equal `package.json`
   `name`. It becomes the namespace `ag-eve-<name>`. DNS-1123, at most 40 characters.
2. **`agent.yaml` declares the harness and the environment.** `envRequires` is the whole
   environment contract.
3. **Pin `eve` to the platform's version.** `versions.json` names it. A mismatch is refused
   at emit time with the fix named.

```yaml
apiVersion: hermes-gitops.factorylevel.dev/agent-team/v1alpha1
kind: Agent
harness: eve
envRequires:
  - name: ANTHROPIC_API_KEY
    description: Anthropic API key; agent.ts calls the provider directly.
deployment:
  diskSizeGb: 10
```

## What each declaration means

| Block | For an Eve agent |
|---|---|
| `envRequires` (`agent.yaml`) | The env Secret: model keys, channel secrets, anything `agent/` reads from `process.env` |
| `backup.yaml` | The platform's backup routine over the agent's volume: sessions, sandbox cache, checkout |
| `apps.yaml` (team) | One child Application per entry this agent owns |
| `requires`, `topology` (`agent.yaml`); `endpoints.yaml` | The topology compiler's. `requires` injects a resolved value as env |
| `deployment` (`agent.yaml`) | `diskSizeGb` and `runtimeImageTag` |
| `gitAuthSecretRef` (`agent.yaml`) | The credential for a private source |

A team **bundle** (`bundles.yaml`) puts several Eve agents in one pod. A **workspace binding**
(`workspaces.yaml`) gives an agent a checkout at a pinned commit, reachable through
`EVE_WORKSPACE_<NAME>`.

## Route auth

Eve refuses production traffic without an authenticator. When `agent/channels/eve.ts` is
absent the platform installs its default, which accepts the Basic credential the platform
mints. Write the file only to choose a different policy, and keep the platform's credential
accepted so `hg test` and `hg agent prove` keep working.

Every channel eve documents is a file under `agent/channels/` plus its secrets under
`envRequires`. Slack: eve's channel reads `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, and
the platform provisions the app. See [ChatOps](../platform/chat-conversations.md).

A GitHub App comes through a **connection** the team declares once in
`harness-hg/connections.yaml` and binds to the agent. The keys are projected; you do not list
them under `envRequires`. See [Inbound events](../platform/inbound-events.md).

## Model credential

The example agent calls Anthropic directly, so it needs `ANTHROPIC_API_KEY`. Declare it
under `envRequires`. Locally, `harness-hg/test.yaml` holds a placeholder; the real-turn checks
skip with a message until the pod has a real value:

```bash
hg envfile set ANTHROPIC_API_KEY=<value> --profile <name> --restart
```

## Eve's features on the platform

- **Schedules** fire in-process in the pod. No CronJob. One replica, one firing.
- **Subagents** run as child sessions in the same pod.
- **Hooks** are observe-only; what they print is the pod log.
- **Sandbox**: `justbash()` is the only backend a plain pod runs. It is not isolation.
- **Limits**: set `sessionTimeoutMs` and `maxInputTokensPerSession`; eve never
  garbage-collects the world store.
- **Extensions**: a published extension works; a monorepo extension is not installed.

## Testing it

- **Eve's own evals**: `src/evals/*.eval.ts`. `hg agent evals` runs them from inside the pod.
- **The platform's evals**: `evals/` at the repo root. `hg eval --dir <repo>` sends a prompt
  through the session API and hands the reply to your evaluator.

## The loop

```bash
hg onboard <your-repo>      # discovers agents/eve/*
hg validate                 # the record renders; env contract; eve pin
hg up                       # builds the runtime image, deploys
hg test                     # pods ready, health, info, an authenticated turn
hg agent prove [--deep]     # EVE001..024
hg agent evals              # the agent's own evals
hg backup run --verify      # the routine, and the artifact's contents
hg workspace verify         # every bound checkout at its revision
```

## What your agent got

```bash
hg agent inspect --profile <name>     # OFFLINE: what the platform resolved
hg agent show    --profile <name>     # what the running process reports
hg agent render  --profile <name> --output ./out   # the record + manifest, for CI
```

Neither ever prints a value.

## Not yet

No sandbox isolation, no per-agent tunnel, no second replica, no monorepo extensions. See
the [roadmap](../roadmap.md).
