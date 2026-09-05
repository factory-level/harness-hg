# Vocabulary

**What this page tells you:** the one name these docs use for each concept, and where
to read more.

## The names

| Term | Means |
|---|---|
| **Harness Hg** | The product: a GitOps control plane for agent applications. `hg` is the command. Mercury's symbol is Hg |
| **`hg`** | The operator CLI. Every command belongs to one of the three loops. [CLI reference](reference/cli/index.md) |
| **`hermes-gitops`** | An internal identifier you will still see in paths, a file name and a Secret name. Not a product |

## Things you deploy

| Term | Means |
|---|---|
| **Agent application** | An agent plus everything it needs: workloads, databases, dashboards, backup jobs, network paths. You never deploy a lone agent. [Agent Team Install](agent-team-install/index.md) |
| **Agent** | One declared agent: its persona, settings and needs. One agent becomes one running instance. Its identity is its directory name |
| **Agent Team Repo** | The repository you write. One `harness-hg/` folder at the root for the team, one inside each `agents/<harness>/<name>/` for the agent, the code in `src/` beside it. [Repository scaffolds](reference/repo-scaffolds.md) |
| **Harness** | The runtime that boots an agent and talks to the platform. Each harness ships a harness declaration. Types: **Eve** (default), **Hermes Agent** (deprecated). [Harness](platform/runtime.md) |
| **Eve agent** | An agent on Eve: an npm project in `agents/eve/<name>/src/`. Deployed as `ag-eve-<name>`. [Eve agents](agent-team-install/eve-agents.md) |
| **Subagent** | Eve's unit of composition inside one agent: its own folder, model, instructions and tools. Runs inside the parent's pod |
| **Bundle** | Several agents sharing one runtime pod. A bundled agent gives up its own Application, namespace and Service |
| **Record** | The generated file the platform writes for an agent: plain Helm values with one `spec:` block. Never hand-written. [Profile record](reference/profile-record.md) |

## Places

| Term | Means |
|---|---|
| **Platform** / **Control plane** | What Harness Hg supplies and runs: Argo CD, Prometheus, Grafana, Loki, the secrets operator, Dex, the event router, Nexus UI. [Platform](platform/index.md) |
| **Plane** | The label that keeps control-plane and workload apart on every surface |
| **Destination** | Where your agents run: the server and its cluster |
| **Destination repository** | The Git repository Argo CD watches. Mostly generated. Not your Agent Team Repo |

## Capabilities

| Term | Means |
|---|---|
| **Capability** | Something an application needs without naming a provider: `object-storage`, not a bucket |
| **Endpoint** | A declared reachable address for a workload. The agent owns it; an override cannot change it |
| **Secrets** | Values that reach a workload and never enter Git. You declare names; the platform moves values. [Secrets](platform/secrets.md) |
| **Tunnel** | Reachability without opening an inbound port. Off by default. [Tunnels](platform/tunneling.md) |
| **Sign-in** | One identity across Nexus UI, Argo CD and Grafana. Identity is shared; permissions are not. [Identity](platform/identity.md) |
| **Backup routine** | An application-declared backup: what to capture, how often, how it restores. The platform backup snapshots the whole environment. [Backups](platform/backups.md) |
| **Alert routing** | How a fired alert reaches a destination. [Alerts](platform/alerts.md) |

## Surfaces

| Term | Means |
|---|---|
| **Nexus UI** | The operations surface: the fleet, its communication, agents and backups on a canvas. It reads; it does not deploy. [Nexus UI](nexus-ui/index.md) |
| **Event router** | Routes typed events with durability, ordering, retries and a dead-letter queue. Not the same as alerting |
| **Reconciler** | The timer on the destination host that keeps the destination repository current. Argo CD reconciles inside the cluster |

## Loops

| Loop | Front door | What it is |
|---|---|---|
| **Dev loop** | `hg dev` | Build and test an agent team on a local throwaway cluster. [Build an agent team](get-started/dev-quickstart.md) |
| **Agent Team Repo loop** | `hg bundle init` | Author a repo against the contract, no cluster. [Agent Team Repo](get-started/agent-team-repo.md) |
| **Ops loop** | `hg env new` | Host a real environment and run its proofs. [Host an environment](get-started/host-an-environment.md) |

## States

| Term | Means |
|---|---|
| **`available`** vs **`restorable`** | A backup is available once written. It is restorable only after something has restored from it |
| **`unknown`** | A check that could not run. Never a pass. An aggregate with one is not green |
| **ProofResult** | What a proof command emits: numbered checks, each pass, fail or `unknown` |
| **Contract** | A file whose shape is pinned by a schema. Versioned by directory; published versions never change how they validate. [Contract files](reference/contracts/index.md) |
