# Design — the desired state

What Harness Hg is **intended to be**: the deliberate platform, stated as a destination the
work builds toward. Not a history, not a status report — `architecture/` records what is
actually true today, and every change to a page in this tree goes through its own ADR
(`../adr/NNNN-<name>.md`) first.

The destination is executed by the final-pass epic
([#646](https://github.com/factory-level/harness-hg/issues/646)); each page links the issues
that build its pieces.

## Contents

| Page | Destination it states |
|---|---|
| [platform.md](platform.md) | `bootstrap/`, `control-plane/`, `harness/`, `agent-bundle-contracts/` |
| [vocabulary.md](vocabulary.md) | the canonical register: one name per concept, every surface |
| [cli.md](cli.md) | `hg`: the three loops, front doors, grammar, test env |
| [nexus-ui.md](nexus-ui.md) | the rebuilt UI: hierarchy-first, primitives, one layer model |
| [nexus-ui/inventory.md](nexus-ui/inventory.md) | every current surface, classified — what earns a port (#665) |
| [nexus-ui/interactions.md](nexus-ui/interactions.md) | the desired-behavior contract the rebuild is reviewed against |
| [nexus-ui/design-system.md](nexus-ui/design-system.md) | tokens, layer scale, component catalog — what Astryx is themed from |
| [nexus-ui/anti-patterns.md](nexus-ui/anti-patterns.md) | the accidents that must not be recreated — the rebuild's lint list |
| [nexus-ui/hierarchy.md](nexus-ui/hierarchy.md) | the component tree, stores, and layer table — the #666/#668 build contract |
| [landing-docs-repo.md](landing-docs-repo.md) | landing site, docs system, OSS surface |
