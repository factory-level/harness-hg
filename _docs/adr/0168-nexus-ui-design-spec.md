# ADR 0168 — The Nexus UI is specified before it is rebuilt

2026-08-25 · executes [#665](https://github.com/factory-level/harness-hg/issues/665), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646). Introduces
the `_docs/design/nexus-ui/` spec pages that
[#666](https://github.com/factory-level/harness-hg/issues/666)–
[#668](https://github.com/factory-level/harness-hg/issues/668) build against.

## Decision

- The emergent Nexus UI is captured as four spec pages under `_docs/design/nexus-ui/`, expanding
  the [design page](../design/nexus-ui.md): **inventory.md** (every screen/surface/interaction
  exactly once, classified required/convenience/experimental/cruft per the #647 rules),
  **interactions.md** (the desired-behavior contract, mined from the app and the do-not-regress
  epics #540/#558/#584/#428 — which stay open — with precedence newest-wins), **design-system.md**
  (the definitive token/component statement), and **anti-patterns.md** (the rebuild's lint list).
- **The shipped implementation outranks the old design docs.** `DESIGN.md` and
  `.impeccable/design.json` predate merged token work (#548); where they disagree with
  `dashboard/src`, the spec records what ships. Both re-home under `nexus-ui/` with the tree
  (ADR 0157) and are corrected then.
- **The design system is named "Nexus"** — "Hermes Nexus" is a retired `hermes-*` coinage
  (ADR 0158); the naming ledger carries the row.
- The plane-visibility requirement deferred by [ADR 0166](0166-dashboard-planes.md)
  ([#706](https://github.com/factory-level/harness-hg/issues/706)) is written into the spec as a
  required inventory item, not tracked as a side patch.
- The spec is the contract: rebuild output that diverges from it is wrong, and divergence is
  resolved by fixing the code or amending the spec through its own ADR — never by drift.

## Reason

The product design is right; the implementation is brittle — there was never an overall
component design, so one change breaks z-indexes and layouts across the app. Rebuilding from
the running app would recreate the accidents alongside the product. Writing the spec first
separates the two: the inventory says what earns a port, the interaction spec says how it must
behave, the anti-pattern list says what must die, and the sign-off on classification happens
before any screen is rebuilt.

## Cost

- Four more pages to keep true: every deliberate UI change now lands in the spec (via ADR)
  before it lands in `nexus-ui/`, or the spec rots into a second `DESIGN.md`.
- The inventory's classifications freeze judgment calls (demo boards experimental, legacy host
  paths cruft) that a later reader may relitigate — the tables record the class, the PR review
  records the argument.
- `DESIGN.md`/`.impeccable/` stay knowingly stale until the Wave-4 re-home, with only a pointer
  here recording that the spec supersedes them in the interim.
