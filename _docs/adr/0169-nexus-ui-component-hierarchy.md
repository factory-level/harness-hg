# ADR 0169 — The Nexus UI hierarchy is decided before the migration

2026-08-25 · executes [#677](https://github.com/factory-level/harness-hg/issues/677), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646). Sits between
the extraction ([ADR 0168](0168-nexus-ui-design-spec.md)) and the rebuild (#666/#668).

## Decision

- The rebuild's structural decomposition is written as
  [`_docs/design/nexus-ui/hierarchy.md`](../design/nexus-ui/hierarchy.md): a
  screen → region → section → component tree covering every `required` inventory item, with
  **five stores** (Data / Document / Session / Viewport / Chrome) owning all state, **one
  portal-rendered OverlayRegion** whose layer assignments are decided in the hierarchy, and the
  data layer touched only at the named seams.
- The load-bearing ownership rules: props/context down, store-verb events up; selection lives in
  SessionStore only; module scope is banned for state; `resetSession()` is the one reset verb;
  invariants re-check inside store verbs.
- **The full migration must not begin until this page is signed off** — #666 and #668 reference
  it as their build contract, and a screen PR that violates the tree is wrong by definition.
- Unplaceable items are findings on the page, not footnotes: the reader-less `sheet:*` rollups,
  the cross-view ops→drawer handoff, the specimen boards' host coupling, and the demo-exit
  lockup are each recorded with a proposed disposition.

## Reason

The old frontend's brittleness was never styling — it was the absence of an overall component
design: no defined parent/child structure, so every surface invented its own geometry, state and
stacking, and one change broke unrelated screens (24 root useState hooks, selection held in two
layers, four hand-written reset sites, three `:has()` stacking workarounds). The extraction says
*what exists*; the primitives supply *building blocks*; this page decides *how they compose*.
Migrating without it would recreate the original failure mode with newer parts.

## Cost

- The tree freezes structural bets (five stores, one overlay portal, layer table) before a line
  of the rebuild exists; a Wave-2/3 discovery that a bet is wrong must come back through this
  ADR's page, which is slower than improvising — deliberately.
- Stacked on the unmerged extraction PR: if the #665 sign-off reclassifies inventory items, this
  page amends before its own sign-off.
- Node names become the rebuild's public vocabulary; renaming after Wave 3 starts is churn
  across every screen PR.
