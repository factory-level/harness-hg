# Harness

**What this page tells you:** what a harness is, which ones the platform runs, and what the
platform owns versus what the harness owns.

A **harness** is the runtime that runs an agent: it loads the instructions and tools, talks
to a model, keeps session state, and answers on a port. The platform does not run agents
itself. It turns an agent as written in a repository into a record in Git, and Argo CD
converges a pod that runs the harness.

| Harness | Status | Authored as | Page |
|---|---|---|---|
| **Eve** | default | an npm project at `agents/eve/<name>/src/` | [Eve agent](runtime-eve.md) |
| **Hermes Agent** | deprecated: existing installs only, no new capability | a distribution at `agents/hermes/<name>/src/` | |

Every harness ships a [harness declaration](../reference/contracts/harness-declaration.md):
its chart, its gateway, and how `hg` talks to it. The path carries the choice,
`agents/<harness>/<name>/`, and the agent's `harness-hg/agent.yaml` declares it again.

## Who owns what

| The platform | The harness |
|---|---|
| The record in Git, plain Helm values, one per agent | How the agent behaves once it runs |
| The chart that turns the record into one StatefulSet | The process in the pod, its port, its health route |
| The source checkout at one commit, never a moving ref | What it builds from that checkout |
| The environment contract: which variables exist, which are secret | What it does with them |
| The credential the platform uses to reach the agent | Its own authentication of other callers |
| Convergence: a changed record rolls the pod | Session state on the data volume |

## Proof

`hg agent prove` runs each harness's own legs. `hg launch prove` aggregates them.
