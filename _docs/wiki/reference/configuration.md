# Configuration

**What this page tells you:** where each value is set, whether you may override it, and
which value wins when more than one place sets it.

Two chains meet at the record. Confusing them is the usual source of "I set it and nothing
happened".

## An `agents[]` entry

Each `agents[]` entry in the environment spec names what the platform deploys:

| Field | Meaning |
|---|---|
| `agents[].source`, `agents[].ref` | the repository and the commit. Never a moving ref |
| `agents[].subdir` | `agents/eve/<name>/src`. The instance name is the agent directory's basename |
| `agents[].name` | set it when `package.json` `name` differs from the directory |
| `agents[].runtime` | `eve` |
| `agents[].overrides.appValues` | per-instance values an app's `valuesRequired` demands. The only override key for an Eve agent; every other key is refused |

## Chain A: building the record

```text
fleet defaults              (shared across every agent)
      ↓  deep merge
harness-hg/*.yaml           (the agent's own declaration)
      ↓  deep merge
per-instance overrides      (the environment spec; wins)
```

**Dictionaries merge key by key. Lists are replaced wholesale.** An override that sets `apps`
replaces the whole list. To adjust one app's values, use `appValues`, which merges per app:

```bash
pulumi config set --path 'agents[0].overrides.appValues.monitoring.alert.webhookUrl' https://...
```

An `appValues` entry naming an app the agent does not declare is silently ignored, so fleet
defaults can carry fragments only some agents use.

### What an override may never set

`topology`, `endpoints`, `requires`, `apiVersion`, `kind`, `harness`. They are the agent's
own. An override naming one fails with an explanation. An override tunes how an application
runs; it cannot change what it is.

## Chain B: rendering the chart

Argo CD renders the chart with these value files, later wins:

```text
the chart's own values.yaml
      ↓
bootstrap/values/cluster-values.yaml     the environment: providers, image, repo
      ↓
profiles/<name>/profile.yaml             the generated record, under spec:
```

`cluster-values.yaml` sets what is true of the whole environment. The record sets what is
true of one agent. A record cannot change a provider.

## CLI flags

Flags do not enter either chain. Configuration reaches the cluster through Git. The one
exception: `hg topology emit --router-image` and `--observer-url` write top-level chart
values, and only when passed. `hg nexus set` is a local-loop-only override.

## Worked example: where does an alert go?

`monitoring.alert.webhookUrl`, bottom to top:

| Set in | How |
|---|---|
| the chart's `values.yaml` | the default, empty |
| the agent's `harness-hg/apps.yaml` `values` | the author's choice |
| fleet defaults `appValues` | the operator's default for every agent |
| per-instance `overrides.appValues` | wins |

## Where there is no precedence, on purpose

- A capability satisfied by both an agent endpoint and an environment binding fails
  compilation (`TOPO005`).
- An explicit `env` colliding with an `envFrom` key is refused.
- Saving a Nexus UI workspace with a stale revision is rejected, not merged.

## Versions

| What | Where |
|---|---|
| host binaries and control-plane charts | `versions.json`, the only copy |
| contract versions | the schema directory name |
| chart revision | `__CHART_REVISION__` in the destination repo |
| the reconciler | `reconcile.version` in the environment spec |

Environment variables the CLI reads: [CLI reference](cli/index.md#environment-variables).
