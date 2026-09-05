# Architecture — as built

How Harness Hg **actually is**, in the present tense, defects included. This tree is honest
before it is flattering: when it disagrees with `design/`, the disagreement is the gap list.

The per-build-unit tables live in `maintainers/built.md` (build units + the gate over each)
and `maintainers/gaps.md` (every deviation); this tree is the narrative that indexes them.

## Contents

| Page | Reality it records |
|---|---|
| [platform.md](platform.md) | the whole-platform overview: emission flow, source-of-truth boundaries, the root table, the Eve edge |
| [bootstrap.md](bootstrap.md) | provisioning as built: `infra/` + `state/` (the `bootstrap/` root does not exist) |
| [control-plane.md](control-plane.md) | the fifteen component dirs, `planes.yaml`, the chart-boundary gate, the compat trio |
| [harness.md](harness.md) | `harness/eve` + the frozen `harness/hermes`, the gateway declaration, the runtime drivers |
| [agent-bundle-contracts.md](agent-bundle-contracts.md) | the frozen contracts root, its fixture gate, the never-hand-edit list |
| [cli.md](cli.md) | `hg` as built: the manifest, grammar, prove convention, executable loops, the Phase-4 proof surface |
| [nexus-ui.md](nexus-ui.md) | the rebuilt frontend as it actually stands, per Phase-3 PR |
