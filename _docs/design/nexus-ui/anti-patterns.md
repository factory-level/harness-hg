# Nexus UI — anti-pattern list

The broken and accidental patterns in `dashboard/src` that the rebuild must NOT recreate. This
list is [#665](https://github.com/factory-level/harness-hg/issues/665)'s third deliverable and
becomes the rebuild's lint list: items marked **[lint]** get a CI-enforced check in `nexus-ui/`
([#667](https://github.com/factory-level/harness-hg/issues/667)); the rest are review criteria
for every screen PR ([#666](https://github.com/factory-level/harness-hg/issues/666)).

A finding worth stating first: the z-index *scale* is NOT on this list. The 11-tier
`--nx-z-*` system is disciplined, test-enforced, and ports as spec — the accidents live around
it.

## 1. In-tree overlays instead of portals

Every overlay renders inside the plugin tree and fights stacking contexts: three documented
`:has()` z-lifts exist purely as workarounds (bead-with-popover, hover-vs-closing-popover with a
known 260ms paint gap, contextual-bar-with-fill-palette), and a runtime effect mutates the
*host's* wrapper z-index. Popovers clip at canvas edges by construction because no collision
handling exists.

**Rule: overlays render through a portal into one root-owned overlay container; a component may
not create a stacking context to win a paint fight. [lint: no `:has(` z rules; no `z-index` in
component styles — see 3]**

## 2. Bespoke overlay and measurement geometry

- Five call sites re-derive client→world math inline around one existing helper.
- The context menu paints unclamped for a frame, then measures itself and re-renders.
- Popover placement is fixed-offset with a manual flip prop instead of measured positioning.
- Fan-detail wires hand-compute endpoints against a hardcoded row height and scroll offset — a
  CSS change silently detaches them.
- The mandala estimates label-dot positions from glyph counts.
- Two independently-mounted fixed bars share a hardcoded `top` and dodge each other via a manual
  `stacked` prop.

**Rule: positioning, anchoring, collision, and dismissal come from the overlay primitives; SVG
annotations derive from measured layout, never character counts or copied row heights.**

## 3. Per-component z-index and positioning literals

Six `zIndex` occurrences in TSX, one `-1` literal in CSS, and 106 `position:` declarations spread
across one 8,097-line stylesheet — stacking and pinning decided at the site of use.

**Rule: a component requests a named layer, never a number; `position: fixed/absolute` lives
only inside primitives. [lint: no `z-index`/`zIndex` literal outside the layer-model file; no
`position: fixed|absolute` outside `primitives/`]**

## 4. The 8,097-line single stylesheet + inline-style leakage

One global CSS file holds 771 classes and every component's rules; 39 inline `style={{}}` objects
carry real styling (fan offsets, mirrored transforms, animation staggers) rather than tokens.
Custom-property injection (`--own`, `--kindhue`, `--sw`) is the *sanctioned* pattern and stays.

**Rule: styles are component-scoped (StyleX/co-located); inline styles only for measured values
and custom-property token passing. [lint: no `style={{` carrying literal colors/geometry]**

## 5. Hardcoded palette values escaping the token system

The edit-mode accent `#d9793c` is hardcoded ~20× (identical in dark — a live theming defect);
legacy literal fallbacks (`#333`, `#d29922`…) linger; one host-shadow token lacks a dark value;
`--nx-display`/`--nx-body` are referenced 31× but never defined.

**Rule: rules never hardcode palette values; every referenced token is defined. [lint: hex/rgb
literals only in the generated theme file]**

## 6. Root-component state concentration

`NexusPage` holds 24 useState + undo + 6 refs and owns routing, theming, persistence, selection,
five overlay pairs, and every sheet mutation; the canvas adds ~15 more state atoms plus six drag
refs; selection lives in two layers at once; clipboard and hover-singleton live in module scope;
ref-smuggled callbacks (`doSaveRef`…) bridge keyboard handlers. Four hand-written reset sites
approximate one missing `resetSession()`.

**Rule: state ownership follows the [#677](https://github.com/factory-level/harness-hg/issues/677)
hierarchy — document store / editor-session store / viewport store / chrome state; no component
reaches around the tree; one reset verb per store.**

## 7. Copy-paste primitives instead of shared ones

The right-drawer grammar is hand-assembled four times; CopyButton exists twice; filter chips are
re-implemented locally; expand affordances differ per view; three near-identical severity-rank
maps; `InlineField`/`InlineEditor` duplicated by documented convention.

**Rule: a pattern used twice becomes a primitive first ("new work has an obvious home"); the
drawer, chips, copy affordances, rank maps, and inline editors each exist exactly once.**

## 8. Duplicated constants and stale twins

`COORD_LIMIT` defined twice; text/note footprints hardcoded in the shell (`200×32` / `180×110`)
as stale duplicates of the geometry module — align/distribute measures differently than
marquee/ports (a live bug the rebuild must not inherit).

**Rule: one constant, one home; geometry comes only from the geometry module.**

## 9. Dead surface retention

Legacy CSS families with no emitting markup; duplicate declaration blocks for the same class;
served `sheet:*` rollups with zero readers; the `contextual` panel flag whose host is gone;
legacy canvas host fallback props.

**Rule: the rebuild ships no rule, prop, or served field without a consumer; discovery of one is
a deletion (or an issue), never a keepsake.**

## 10. Magic numbers standing in for layout

Placement offsets (`-100/-40`, `560/360` + stagger), `fit()` chrome paddings encoding today's
chrome, toolbar `bottom: 60px` clearing a 43px bar, pixel-tuned island corner curls, four
`!important`s on the fit button.

**Rule: chrome-relative geometry derives from layout (or tokens); a number that encodes another
component's size is a dependency, not a constant.**

## 11. Module-scope environment reads

`prefers-reduced-motion` read once at module load (never updates); 404 memo sets and the hover
registry as cross-file invisible coupling.

**Rule: environment preferences are reactive; cross-component coordination lives in the session
store, not module scope.**
