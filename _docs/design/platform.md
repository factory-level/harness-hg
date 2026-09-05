# Platform

The platform is a zero-custom-controller GitOps control plane for AI agent teams. Git and
Pulumi own permission and desired state; Argo CD owns convergence; Helm owns workload
realization; the harness owns execution inside the agent. Nothing else runs a control loop,
and no harness is a control-plane authority.

## `bootstrap/` — provisioning

Two Pulumi surfaces, one directory:

- `bootstrap/state-bucket-kms/` — the state backend: per-agent state buckets, deploy service
  accounts, and IAM, rooted in a manually created bucket + KMS key. The root of trust is the
  only by-hand step an operator ever performs
  ([#676](https://github.com/factory-level/harness-hg/issues/676)).
- `bootstrap/platform-infra/` — the Pulumi for Kubernetes and the GitOps emitter. The
  emitter lives **inside the Pulumi code**, not wired into any harness; a shim gates each
  agent's launch on readiness and config gates. The Hermes install-hook/plugin path does not
  exist ([#681](https://github.com/factory-level/harness-hg/issues/681)).

Environments are declared, not configured: `environment.yaml` is the source of truth and
Pulumi stack config is generated from it, never hand-edited
([#674](https://github.com/factory-level/harness-hg/issues/674)).

## `control-plane/` — one directory per platform-owned component

Each component owns its directory, its chart, and its signals
([#658](https://github.com/factory-level/harness-hg/issues/658)):
grafana, prometheus, alertmanager, loki, event-router, alert-router, nexus, wiki, argocd,
external-secrets, dex-sso, tunnel.

- Control-plane and workload planes are separated by namespace and carry plane labels on
  every signal ([#660](https://github.com/factory-level/harness-hg/issues/660)); a
  declaration cannot land an agent in a control-plane namespace.
- Loki aggregates logs from both planes, one label apart, never interleaved by default
  ([#661](https://github.com/factory-level/harness-hg/issues/661)).
- Every component is observable — metrics, alerts, dashboards, logs, health — per the
  coverage inventory ([#662](https://github.com/factory-level/harness-hg/issues/662)),
  and control-plane dashboards are unmistakably distinct from workload dashboards
  ([#663](https://github.com/factory-level/harness-hg/issues/663)).
- The product manual deploys in-cluster, version-matched to the running platform
  ([#664](https://github.com/factory-level/harness-hg/issues/664)).
- The platform repo carries **zero application charts** — application charts live only in
  the persona repos, and a CI gate holds that boundary
  ([#659](https://github.com/factory-level/harness-hg/issues/659)).

## `harness/` — harnesses are drivers

A harness is a driver for the platform-infra options, never a second control plane. The
gateway is part of the harness contract — a harness declares its gateway, and the platform
ships no universal one ([#653](https://github.com/factory-level/harness-hg/issues/653)).
Eve connects through the Vercel AI Gateway
([#654](https://github.com/factory-level/harness-hg/issues/654)). Hermes is frozen
legacy under the harness tree: it works, gains nothing, and its removal is a separate
decision ([#652](https://github.com/factory-level/harness-hg/issues/652)).

## `agent-bundle-contracts/` — the contracts root

Every contract an external repo authors against lives in one top-level root,
`agent-bundle-contracts/` — named for the loop it serves
([#651](https://github.com/factory-level/harness-hg/issues/651)). One event envelope across
every surface — harness, routers, CLI, Nexus, emitted records —
held by contract tests that fail the build on divergence
([#655](https://github.com/factory-level/harness-hg/issues/655)). Frozen schema
version directories never mutate; new names and fields arrive only as new versions.

An agent-team repository has one shape ([ADR 0178](../adr/0178-agent-team-contract-surface.md)):
**`harness-hg/` at any level is exactly what the platform reads**, and everything beside it
belongs to the harness or the team. The root `harness-hg/` holds the team's identity, its
shared apps, the layout it is built for and its relocated environment files; every agent lives
at `agents/<harness>/<name>/` with its own `harness-hg/` (one file per concern) beside the
`src/` payload the harness installs. The harness is read from the path and declared
positively. The team declares what it brings; the environment spec's `grants` declare what
the bootstrap gives it; the compiler unions the two and refuses an overlap. The contracts for
the new shapes live in `agent-team/`; every concern whose shape did not change keeps its
frozen schema under the new path. The retired `.hermes-dist` and the never-built `.harness-hg/`
dot-directory have no successor beyond this.
