# Build an agent team

**Outcome:** the demo team running on a local throwaway cluster, one edit of yours converging
through the real Git → Argo CD path, and `hg test` green. No accounts, no credentials.

This is the **dev loop**. It assumes [Install the tools](install-the-tools.md) is done.

## The front door

With nothing onboarded yet, one command runs the whole onramp and narrates each step:

```bash
hg dev examples/agent-team
```

That is onboard → up → dev in one command ([hg dev](../reference/cli/dev.md)). The rest of
this page walks the same loop one verb at a time, because you will come back to each one:

```text
hg onboard
hg up
hg test
hg dev
hg status
```

The demo team is two Eve agents, `manager` and `research`, sharing one pod, plus a small test
page the manager owns. It is exactly what `hg bundle init` scaffolds, with a subagent, a
schedule and evals added.

## Onboard, up, test

From the `harness-hg` checkout:

```bash
hg onboard examples/agent-team
hg up
hg test
```

- [`hg onboard`](../reference/cli/onboard.md) registers the demo with the local loop.
- `hg up` creates a k3d cluster, builds the Eve runtime image, renders the demo's records,
  and installs the same control plane a real environment runs: Argo CD, the secrets
  operator, Prometheus and Grafana.
- `hg test` proves each agent registered and actually runs.

Nothing on the internet is touched beyond public container images and the control plane's
own Helm charts. Git remotes are local `file://` repositories. The demo's one API key is a
placeholder from its test config.

`hg validate` is the cluster-free contract gate. Run it any time you want every failure at
once, with the file and field to fix.

## Make a change and watch it converge

The loop's point is the second deploy, not the first. Start the watch loop:

```bash
hg dev
```

Leave it running. In another terminal, edit the demo's page text: in
`examples/agent-team/harness-hg/apps.yaml`, give the `docs-site` app's
`values.page.body` any text you will recognise. `hg dev` narrates what happens next. Your
edit is committed, the record re-renders, and Argo CD syncs it onto the cluster.

Then find the page:

```bash
hg status
```

`hg status` lists what is running and every local URL. The test page is reached directly.
`kubectl get svc -A | grep docs-site` names its Service and namespace; port-forward it and
open it. Your text is what it serves.

## Proof

**Done when** `hg test` exits zero and the test page serves your edit. Two more ways to
poke it:

```bash
hg open                                          # the dashboard URLs, with their logins
hg prompt "the factory hums at night" --profile manager   # a round trip through the agent
hg eval --dir examples/agent-team                # the echoes-verbatim behaviour proof
hg agent prove                                   # the Eve runtime legs, EVE001..024
```

Nexus UI runs in the local loop; `hg open` prints its URL. The hosted [demo](https://factory-level.github.io/harness-hg/demo/) shows it without a cluster.

## Author your own

To start a repo of your own instead of the demo, scaffold one with
[Agent Team Repo](agent-team-repo.md), then point this same loop at it: `hg onboard
<your-repo>`, `hg up`, `hg test`, `hg dev`.. The demo is the scaffold's own
layout, so what you learn here is what you will write.

To run a second loop beside this one, set `HG_CLUSTER_NAME=<name>` and a fresh
`HERMES_GITOPS_HOME`; every `hg` verb, and `hg reset --nuclear`, then acts on that cluster only.

When you are done: `hg down` stops the host-side processes and keeps the cluster.
`hg reset` removes each agent's Application and namespace. `hg reset --nuclear` deletes the
cluster too, and the next `hg up` rebuilds everything.
