# Supporting workloads

**What this page tells you:** how to ship the rest of your application beside the agent.

## What it means

An agent application is the agent plus everything it needs. `apps` is where the rest goes:
databases, queues, boards, publishing tools. Each entry is a Helm release the platform
manages for you, deployed in author order.

## What you write

```yaml
# harness-hg/apps.yaml
apps:
  - name: postiz
    owner: manager
    chart: postiz
    repo: oci://us-docker.pkg.dev/<project>/<repo>/charts
    version: 0.2.1          # REQUIRED for a remote chart
    values: {}
```

You control the charts, their values, their order, `valuesRequired` (dot-paths the operator
must supply, checked before render), per-app `endpoints` and `outputs`.

**A remote chart requires a pinned `version`. A `repo: local` chart forbids one.** Unpinned
is refused, not defaulted.

`deployment` on the agent carries pod knobs for the agent, not the apps: `runtimeImageTag`
and `diskSizeGb`. That is the whole set.

## What you get

One Argo CD Application per app, with its record under `deployments/apps/<name>/`. Charts
may only come from the environment's `sourceRepos` allowlist.

An operator can override `apps`, and **an override replaces the whole list**. Point people
at `appValues`, which adjusts one app's values without redeclaring the list.

## In Nexus UI

Each app is a card with its own health, links and backup coverage row.

## The exact fields

[Agent team contract](../reference/contracts/agent-team.md). The platform side:
[GitOps](../platform/reconciliation.md).
