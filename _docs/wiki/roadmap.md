# Roadmap

**What this page tells you:** what is being worked on, and what is only an idea, so you do
not plan around it.

Nothing outside the **Done** lane is supported today. No dates.

<div class="grid cards kanban" markdown>

-   __Concept__

    ---

    - **Sandboxed agent execution.** Tool calls run in a container or VM, not a
      simulated shell.
    - **More chat surfaces.** Discord, Teams and Telegram beside Slack. Discord is
      not a supported provider today; its former gateway and notification adapters are retired.
    - **More alert destinations.** PagerDuty beside the generic webhook.

-   __Planned__

    ---

    - **A second harness.** The contract is harness-neutral (`hg harness list`); which
      harness comes next is not decided. Hermes Agent is deprecated, not planned.

-   __In progress__

    ---

    - **Platform SRE agent.** An agent that receives platform alerts as events and
      acts on them.

-   __Done__

    ---

    - **Slack ChatOps.** An agent holds a threaded conversation in Slack.

</div>

When an item ships, it moves to the page that owns it and leaves this board.

## Team installation follow-through

The team coordinator needs clean public-install and deployed multi-role acceptance evidence.
Slack-only identity migrations and explicit role removal with retained data remain
follow-through work. The team watcher runs on the destination host; an in-cluster watcher is
not built.

A commit that changes nothing an agent is built from rolls nothing out, but the decision is made
per source. A change to one agent still restarts every agent from the same repository.
Nexus will show why a commit was applied without a rollout; today only the host records the
reason.

An agent's pod will refuse to start when a variable its record requires is unset or empty, and
`hg team status` will name it. Agents will be able to declare credential probes, so a rejected
credential fails the deployment instead of giving a pod that starts and does nothing. Until
then, an encrypted value that is empty, or a revoked credential, is not caught before it runs.

## Agent versions and health

The installation lock will also pin the platform version, so an upgrade or a rollback of the
platform is one commit. A per-agent runtime pin exists, but the platform publishes no second
runtime yet, so nothing can be pinned until one is recorded; promoting a canary is a manual
edit, and Eve's persisted data has no compatibility check across versions. Each agent will
report the version it actually built, and a mismatch will fail the deployment. Overlays will be
proven on a live cluster. A full upgrade published by a team watcher through a pull request has
not run on a local cluster: the local proof moves an agent's source directly and checks the result
with `hg team status`.

## Branch-following workspaces

A workspace that follows a branch refreshes on standalone Eve agents only; a bundled agent
will need a mount that sees the switch. `hg team status` and Nexus will show each workspace's
branch, served commit and freshness beside the agent's version. The refresh container, its
metrics and the `WorkspaceStale` alert are proven against local Git, not yet in a cluster.

## Cluster drift and decommission

Nothing tests, against a real cluster, what happens when someone edits a deployed agent by hand,
deletes it, or installs it again: that its workload is restored, that removing it cleans up
after itself, and that a fresh install starts clean. The test that covered this ran only on the
legacy Hermes runtime and was retired with it. An equivalent for Eve agents is not built.
