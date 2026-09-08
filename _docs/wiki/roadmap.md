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
