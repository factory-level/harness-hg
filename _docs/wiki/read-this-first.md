# Read this first

**What this page tells you:** what Harness Hg is, which harnesses it runs, and what is
ours versus your harness's.

## A platform for harnesses

Harness Hg is a GitOps control plane for agent applications. A declaration in a
repository becomes a running, monitored, backed-up, reachable deployment on Kubernetes.
Nexus UI sits on top so you can watch it.

Agents run on a **harness**: the runtime that boots the agent and talks to the platform.
Every harness is held to one contract, the
[harness declaration](reference/contracts/harness-declaration.md).

| Harness | Status |
|---|---|
| **Eve** | Default. Where new capability lands. Needs no fork and no extra install |
| **Hermes Agent** | Deprecated. Existing installs keep running; no new capability lands here, and `hg bundle init` refuses it |

One agent on your laptop does not need this. A team of agents running somewhere
permanent, kept in sync from Git, does.

### Where the name comes from

Mercury is the element with the symbol **Hg**, and `hg` is the command you type. Like
mercury, the platform is fluid: **H**arness **G**itOps gives capability to agents wherever
they run.

## What is upstream and what is ours

| Area | Your harness | Harness Hg |
|---|---|---|
| Agent loop, memory, skills, tools | ✅ | — |
| Chat gateway (Slack and others) | ✅ | — |
| GitOps lifecycle, records, contracts | — | ✅ |
| Helm charts, reconciliation, control plane | — | ✅ |
| Observability, alerts, backups, tunnels, secrets | — | ✅ |
| Nexus UI | — | ✅ |
| The `hg` CLI | — | ✅ |

## Where to go next

- [Harness Hg](index.md), the whole model on one page
- [Vocabulary](vocabulary.md), one name per concept
- [Agent Team Install](agent-team-install/index.md), what your repository must contain
- [Install a destination server](runbooks/install.md), standing one up
