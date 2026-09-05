# Nexus UI

`nexus-ui/` is the product's frontend: a tree built in Astryx from an explicit design-system
specification, composed hierarchy-first so that a change to one surface cannot silently break
another. The old frontend is retired, never patched in place
([#668](https://github.com/factory-level/harness-hg/issues/668)).

## Hierarchy before migration

The component hierarchy is the build contract
([#677](https://github.com/factory-level/harness-hg/issues/677), stated in
[nexus-ui/hierarchy.md](nexus-ui/hierarchy.md)): every component has
exactly one parent context; state ownership is decided per node and nothing reaches around
the tree; every overlay-capable node takes its layer from the hierarchy, not from itself. No
screen is rebuilt or ported before the hierarchy is signed off.

## Primitives and one layer model

A single primitives catalog — overlays, drawers, modals, popovers, menus, cards, badges,
status states, forms, canvas controls — over one documented stacking scale. No z-index
literal exists outside the layer-model file; a component requests a layer, never a number
([#667](https://github.com/factory-level/harness-hg/issues/667)).

## The spec is the source

The rebuild recreates the product, not the accidents: the extracted design-system spec and
capability inventory ([#665](https://github.com/factory-level/harness-hg/issues/665))
define what exists; Astryx output that diverges from the spec is wrong
([#666](https://github.com/factory-level/harness-hg/issues/666)). The spec itself lives beside
this page (ADR 0168): [inventory](nexus-ui/inventory.md) ·
[interactions](nexus-ui/interactions.md) · [design system](nexus-ui/design-system.md) ·
[anti-patterns](nexus-ui/anti-patterns.md).

## Data boundaries

The tree touches real data only at named seams: the Nexus plugin API, the compiled canvas
plan, Grafana embeds, and the avatar library. Control-plane dashboards read as platform
surfaces, visually distinct from workload dashboards
([#663](https://github.com/factory-level/harness-hg/issues/663)).
