# nexus-ui primitives catalog (#667)

The one place a screen gets its building blocks: import from `src/primitives` (the barrel).
A screen needing a new primitive adds it HERE first — "new work has an obvious home". The
style-gates test (`tests/style-gates.test.ts`) enforces the layer/positioning/palette rules;
`src/layers.ts` is the only stacking authority.

## Stacking model

Floating surfaces (drawer, dialog, popover, menu, tooltip, toast) ride the browser **top
layer** through Astryx — they carry no z-index, ever. In-page tiers (canvas world, docked
chrome) request a named layer via `layerVar()` from the `--nx-z-*` scale that
`design/tokens.json` emits. One deliberate global change — a token edit or a layer reorder in
tokens.json — regenerates the theme (`bun run gen-theme`) and propagates everywhere; CI's
drift gate proves the committed theme IS the tokens.

## Custom primitives (the product's identity)

| Primitive | Purpose | Usage |
|---|---|---|
| `Drawer` | THE right-drawer grammar — agent detail, alert evidence, backup routine, capability panel are all this component | `<Drawer open onClose title>…</Drawer>` |
| `HoverPopover` | status/badge hover surfaces: single-open registry + 260ms close grace, top-layer anchored | render-prop trigger + `content` |
| `ConfirmBar` | THE destructive-confirmation grammar — a warning Banner with a keep/confirm pair, non-modal, never `window.confirm` (sheet delete) | `<ConfirmBar title description confirmLabel onConfirm onCancel />` |
| ~~`Flyout`~~ | retired with the Astryx chrome pass — `Popover`/`DropdownMenu` own anchored dismissable surfaces now | — |
| `HealthDot` | server-computed level, verbatim; hollow-dashed unknown | `<HealthDot level="unknown" />` |
| `StatusPill` | the five ink+wash pairs | `<StatusPill level="degraded">3 late</StatusPill>` |
| `StatusWord` | the #423 save grammar (quiet word, louder only when actionable) | `<StatusWord state="unsaved" />` |
| `OwnershipSphere` | control-plane ownership marker — never a health color | `<OwnershipSphere />` |
| `layerVar` / `PAGE_LAYERS` | named in-page stacking requests | `style: { zIndex: layerVar("badge") }` — only inside primitives |
| `AgentAvatar` | the served avatar art (`-still` twin under reduced motion); on load failure the fallback renders INSTEAD — never co-rendered | `<AgentAvatar code={icon} fallback={<RingsMark/>} />` |
| `RingsMark` | the concentric-rings identity mark an agent card wears when it has no art; colour rides currentColor / `--kindhue` | `<RingsMark size={52} />` |
| `Face` | monogram tile with repository icon layered over; the monogram remains the face on 404 | `<Face id={comp.id} title={title} />` |
| `abbrOf` | the two-letter monogram rule, one home | `abbrOf("Marketing Manager") === "MM"` |
| `Icon` | THE glyph primitive: a closed vocabulary of meanings (`chevron-right`, `external`, `undo`, the five tools, the four badge domains) drawn by lucide at one box and stroke, in currentColor — no unicode glyphs as UI anywhere | `<Icon name="chevron-right" />`; `label` makes it a named image |

## Shared type + shell classes (`primitives.css`, design pass 2026-09-01)

Composed by className, not components — a view opens with a header and reuses these instead
of restating sizes. All ride the named steps `design/tokens.json` emits (`--fs-*`, `--lh-*`,
`--track-*`, `--radius-*`, `--sp-*`, `--nx-header-h`).

| Class | Purpose |
|---|---|
| `.nx-h1` / `.nx-h2` / `.nx-h3` | the display ramp (3xl 700 tight / xl 650 / md 650); `h1` had no size anywhere before this |
| `.nx-eyebrow` | the ONE tracked-uppercase label (section kickers, facts keys, kind captions, the sheets label) |
| `.nx-view-head` / `.nx-view-title` / `.nx-lede` | every top-level view's opening: title row, then lede or controls; static above the scrolling list |
| `.nx-state` (+ `-error`) | the one muted sentence for a loading / empty / error note inside a body (a whole empty view uses `EmptyState`) |
| `.nx-chip` / `.nx-field` / `.nx-tag` | toggle pill (filters, folds, drawer sections), text-input pill at the chip's height, inline qualifier |
| `.nx-island` / `.nx-shell` | the floating chrome shell (header islands, canvas control + zoom islands) / the bordered paper group that clips its rows (agent groups, backup shelves) |
| `.nx-back` / `.nx-facts` | the drill-in's way up; eyebrow-keyed definition lists |
| `.nx-root :focus-visible` | one accent ring everywhere; canvas selection's edit-accent ring outranks it |

The brand faces load from here too: `tokens.json` `fonts` renders the three `@font-face`
rules over the ADR-105 asset route (`tests/fonts.test.ts` is the gate — the #732 flip had
dropped both the rules and the gate, so every screen rendered in `system-ui` for a week).

## Astryx passthroughs (themed by the tokens.json `astryxBridge`)

`Button` · `ButtonGroup` · `IconButton` · `Card` · `Badge` · `Item` · `TabList`/`Tab` ·
`Popover` · `Tooltip` · `DropdownMenu` · `ContextMenu` · `Banner` · `EmptyState` ·
`TextInput` · `Switch` · `ToggleButton`/`ToggleButtonGroup` · `Toolbar` · `LayerProvider` ·
`useToast`

Re-exported through the barrel so screens never import `@astryxdesign/core` directly — the
catalog stays the honest inventory, and swapping an implementation touches one file. Since the
chrome pass these have real consumers: the header (TabList, IconButton, Badge, DropdownMenu,
Popover, Banner), the shells (EmptyState, Button), and the workspace bottombar/canvas
(Toolbar, ToggleButton/Group, ButtonGroup, ContextMenu, Item, Banner). The `astryxBridge`
section of `design/tokens.json` maps Astryx's `--color-*`/`--font-family-*`/`--radius-*`/
`--shadow-*` vars onto the Nexus tokens, so Astryx components wear the warm-paper palette in
both themes; `LayerProvider` (mounted in AppShell) is the overlay/toast region.

## Arriving with the Wave-3 screens (declared, not yet built)

Bead placement fixtures beyond the card corner, FillPicker.
Each lands in `src/primitives/` with a row here in the same PR as its first consumer.
(Card geometry lives in `workspace/geometry.ts` FOOTPRINTS; the per-kind card grammar,
Face/MonogramTile, AgentAvatar and RingsMark shipped with the canvas-grammar restoration;
the rail and SheetStrip are the workspace bottombar's pills — the rebuilt shell's deliberate
home for them, styled in `workspace.css`.)
