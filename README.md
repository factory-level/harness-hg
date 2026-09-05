# Harness Hg

Run a team of AI agents on Kubernetes from files in Git.

You describe your team in a repository. Harness Hg turns that into running agents with
monitoring, alerts, backups and network access. Argo CD, Helm and the External Secrets
Operator do the work. There is no controller of ours to learn.

**Status: beta.** A community tool, built while learning to run agent harnesses for real.
Expect rough edges. [Open an issue](https://github.com/factory-level/harness-hg/issues) when
something is missing or wrong.

## Start here

The manual: **https://factory-level.github.io/harness-hg/docs/**

| You want to | Read |
|---|---|
| Build an agent team and run it locally | [Build an agent team](https://factory-level.github.io/harness-hg/docs/get-started/dev-quickstart/) |
| Create your own Agent Team Repo | [Agent Team Repo](https://factory-level.github.io/harness-hg/docs/get-started/agent-team-repo/) |
| Host a real environment | [Host an environment](https://factory-level.github.io/harness-hg/docs/get-started/host-an-environment/) |
| See the operations surface without installing anything | [Demo](https://factory-level.github.io/harness-hg/demo/) |

The short version:

```bash
git clone https://github.com/factory-level/harness-hg
cd harness-hg/cli && bun install --frozen-lockfile && bun link && cd ..
hg onboard examples/agent-team     # the demo team
hg validate                        # the contract gate, no cluster
hg up                              # k3d + Argo CD + Grafana + the agents
hg test
```

## What is in this repository

| Path | What it is |
|---|---|
| `cli/` | `hg`, the operator CLI. Every command belongs to one of three loops: dev, agent-bundle, ops |
| `agent-bundle-contracts/` | the frozen, versioned schemas every declaration is checked against |
| `harness/` | the agent harnesses the platform can run. Eve is the default |
| `control-plane/` | every platform component, one chart each: Argo CD, Grafana, Prometheus, Loki, the event router, Nexus UI, … |
| `infra/` | the Pulumi bootstrap that stands up an environment, and the destination-repo scaffold |
| `plugin/gitops_emitter/` | the emitter: renders records into the destination repository |
| `nexus-ui/` | the operations surface |
| `examples/` | reference repositories, including the demo team |
| `skills/` | agent skills: `npx skills add factory-level/harness-hg` |
| `_docs/` | the manual (`_docs/wiki/`) and the internal design, architecture and decision records |

## Working on it

`make test` is the gate. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the rest: the TypeScript
suites `make test` does not reach, the commit convention the version is derived from, and
the documentation contract in [`_docs/README.md`](_docs/README.md). Security reports go
through [`SECURITY.md`](SECURITY.md).

## License

[Apache 2.0](LICENSE).
