# Nexus UI — design system

The de-facto design system, reconciled from the running implementation for
[#665](https://github.com/factory-level/harness-hg/issues/665). Where `DESIGN.md` /
`.impeccable/design.json` and the shipped CSS disagree, **the shipped CSS wins** (the docs
predate the #548 token work). This page is the single statement the rebuild themes Astryx from;
`DESIGN.md` and `.impeccable/` re-home under `nexus-ui/` with the tree (ADR 0157) and are
corrected to match.

Per the canonical vocabulary (ADR 0158) the system is named **Nexus** — the "Hermes Nexus" title
in `DESIGN.md`/`design.json` is a retired `hermes-*` coinage; the ledger row in
`maintainers/final-pass/naming-scheme.md` records the rename.

## North star

**The Warm-Paper Whiteboard.** A light, pastel, paper-textured ops canvas that owns the whole
viewport. Two color languages only: a pastel hue says *what kind* of thing an object is; five
ink/wash pairs say *how it is doing*. Everything else is neutral ink on paper. Copper is the
single interactive accent; communication blue is the single domain accent; apricot is the
edit-mode accent (today an undocumented hardcoded third — tokenized in the rebuild). Healthy is
quiet: a warm dot is the only warm thing on a healthy board.

## Color tokens (definitive; light / dark)

One vocabulary — the rebuild keeps today's CSS names (short, shipped, test-pinned) and retires
the doc-side long names. Dark is a full token-for-token override under the theme attribute;
rules never hardcode palette values.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#eeeff4` | `#0b0d14` | app canvas behind the paper |
| `--paper` | `#fbfaf7` | `#0e1017` | whiteboard ground; badges knock out against it |
| `--sf` / `--sf2` / `--sf3` / `--sf4` | `#ffffff` / `#f7f8fb` / `#eaecf3` / `#f1f3f8` | `#141824` / `#10141e` / `#1c2233` / `#191e2c` | surface steps |
| `--ink` / `--ink2` / `--mut` | `#141824` / `#3e4256` / `#6d7188` | `#ebeaf4` / `#afb0c8` / `#8a8ca6` | text hierarchy |
| `--line` / `--line2` | rgba(20,24,36,.11) / .06 | rgba(175,176,200,.13) / .07 | hairlines |
| `--dot` | rgba(20,24,36,.14) | rgba(175,176,200,.13) | canvas dot grid |
| `--popline` / `--pophov` | rgba(0,0,0,.1) / .05 | rgba(255,255,255,.1) / .06 | popover line/hover |
| `--acc` / `--accsf` | `#b36a33` / `#fbebdf` | `#f5b98c` / `#2d2927` | copper accent + wash |
| `--edit-acc` (NEW) | `#d9793c` | needs a dark value (today's hardcode survives into dark) | edit-mode accent: selection outlines, ports, mode-on |
| `--ok` / `--oksf` | `#3e8a6b` / `#e4f2eb` | `#a9dcc4` / `#1a2620` | healthy |
| `--warn` / `--warnsf` | `#8a6a18` / `#f7efdb` | `#efd9a0` / `#282519` | degraded |
| `--crit` / `--critsf` | `#b8543a` / `#fae7e1` | `#f0a98f` / `#2a1d19` | unhealthy |
| `--unkc` / `--unksf` | `#6d7188` / `#eceef3` | `#8a8ca6` / `#1a1e29` | unknown |
| `--pau` / `--pausf` | `#4a5c8a` / `#e9edf7` | `#9fb6f0` / `#191e2b` | paused |
| `--comm` / `--commsf` / `--commline` | `#2f6fe0` / `#e6edfb` / rgba(47,111,224,.24) | `#8fb0f5` / `#171d2c` / rgba(143,176,245,.28) | communication domain |
| `--sticky` / `--sticky2` / `--stickyink` | `#f7e6b8` / `#dce9c8` / `#3a3210` | `#efd9a0` / `#c7d6ae` / `#2a2410` | sticky-note papers |
| `--marker` | rgba(20,24,36,.46) | rgba(200,202,224,.5) | pencil connector stroke |
| `--nx-sb-thumb/-hover/-track` | ink .22 / .38 / transparent | .24 / .42 / transparent | one scrollbar treatment |

**Kind pastels** (data, injected per element as `--kindhue`, consumed via 12–14% color-mix
washes) — eight kinds, the docs' seven omitted `agent-bundle`:
person `#7a9e7e` · group `#8a7bc8` · agent `#b36a33` · agent-bundle `#e0b06a` · tool `#5b9bd5` ·
external-tool `#6d7a86` · comm-in `#2f6fe0` · comm-out `#2f6fe0`.

**Shape fill palette** (#548, bounded, FillPicker's whole world): apricot `#d9793c` ·
sky `#5b9bd5` · mint `#4caf8e` · rose `#c95f6e` · violet `#8a7bc8` · slate `#6d7a86`, each with a
.13–.15 alpha fill twin. Apricot's stroke doubles as `--edit-acc`.

**Ownership channel** (`--own`, set per canvas node): primary = `--acc`, shared = `--ink2`,
human = `--pau`. Color means ownership on cards — never status.

Retired with the rebuild: the design.json 8-step tonal ramps (nothing consumes them), the host
literal fallbacks (`#333`/`#d29922`/…), and `--color-primary-foreground: #fffdf8`'s missing dark
override (host-token shadowing gets a full dark map or is dropped where the rebuild owns the
page).

## Typography

Figtree (display; variable 400–800) and Nunito Sans (body; variable 400–800 + italic),
self-hosted woff2 (CSP `default-src 'self'` — no font CDNs; ADR-105), `font-display: swap`,
weight 650 in live use. The rebuild DEFINES `--nx-display` / `--nx-body` (today referenced 31×,
defined nowhere, resolving through fallbacks) and adds named size steps replacing per-rule px
(working ramp today ≈ 9.5–12.5px UI text, 13/19/30px canvas text sm/md/lg). Eyebrow style:
uppercase, tracked, `--mut`.

## Elevation, radius, motion, measure

- Shadows, exactly three: `--shl` lift (rest) · `--sh` float (popovers/panels) · `--shx` loom
  (modals); dark redefines all three (deeper, black-based).
- `--radius: 14px` card default; pills fully rounded.
- Motion: 120–200ms eases; named tokens (`--ease-quick`, `--ease-standard`) replace today's
  literals; every animation gated on reduced-motion except where animation is the content.
- Measures: `--nx-measure` 920 / narrow 860 / wide 1200 / prose 520px — centred top-level
  compositions; no raw px widths in view shells.

## The layer scale (feeds #667 — port as spec)

Eleven named tiers, ascending, defined once:
`world 0 · world-content 1 · object 2 · object-active 3 · fixture 4 · badge 5 · panel 6 ·
chrome 7 · hover 8 · menu 9 · modal 10`, plus the host boundary `app-root 60` (above host
chrome, below host modals). Contracts: hover outranks chrome; panel sits below chrome; cards
above shapes/texts; ports ride the badge tier. A component requests a *layer name*, never a
number; the only numeric literals anywhere are `-1/0/auto`
([#667](https://github.com/factory-level/harness-hg/issues/667) makes this lint-enforced). The
rebuild renders overlays through portals into a root-owned overlay container, which retires the
`:has()` stacking lifts and the host z mutation wholesale.

## Theme mechanics

Everything scopes under `.nx-root`; no bare element selectors leak to the host. Theme = stored
choice else **dark**; deliberately no system-preference mode. The toggle stamps
`data-nx-theme="dark"`; in the Astryx rebuild that maps to the scoped theme attribute
(`data-astryx-theme` on `.nx-root` + `data-astryx-media="dark"` — verified in the build spike:
no `:root` rewrite needed, tokens resolve per element via `light-dark()`). The generated theme
file is emitted from `.impeccable/design.json` by `nexus-ui/scripts/gen-theme.ts` and committed,
drift-checked, never hand-edited.

## Component catalog

The 771 shipped `nx-*` classes reduce to ~60 components. Verdicts: **astryx** (themed Astryx
component), **shell** (Astryx container, custom content), **custom** (the product's identity —
built on the tokens/primitives, never from the library). Calvin's depth decision: Astryx
components + custom canvas.

### Primitives

| Component | Verdict | Notes |
|---|---|---|
| Button / IconButton | astryx | pill button; copper border emphasis, never solid |
| Chip / FilterChip / Tag / Kbd | astryx | |
| Input / SearchInput / FormField | astryx | hairline field, copper focus |
| Switch | astryx | |
| StatusPill | astryx | the five ink+wash pairs as variants |
| HealthDot / Bead | custom | hollow-dashed unknown + pulse + paper-knockout halo are tested contracts |
| StatusWord (save grammar) | custom | #423 |
| MonogramTile / Face / Avatar | shell | kind-hue top rule; webp still/animated swap |
| Eyebrow / SectionHead / FactGrid | astryx | typography primitives |
| EmptyState / MissingCard | astryx | |
| Swatch / FillPicker | custom | bounded palette is the product |

### Overlays (all portal-rendered in the rebuild)

| Component | Verdict | Notes |
|---|---|---|
| Drawer (right aside + scrim + dismiss grammar) | shell | ONE primitive replacing four hand-rolled copies |
| Modal / AlertDialog / ConfirmBar / ConflictBar | astryx | |
| Menu / ContextMenu | astryx | items pre-filtered — a menu never decides capability |
| Popover (hover status/badge surfaces) | shell | single-open registry + close grace kept; collision handling gained |
| Flyout (header-anchored: ops) | shell | |
| Toast | astryx | |

### Chrome

| Component | Verdict |
|---|---|
| HeaderIslands / BrandLockup / corner lockup | custom (signature) |
| TabStrip | astryx |
| SheetStrip (editable document tabs) | custom |
| ToolRail / canvas toolbar / zoom island | custom |
| ContextualEditBar (#398 grammar) | custom |
| OpsPanel pill + flyout | shell |
| StaleBanner / DemoBadge | astryx |

### Canvas object system (all custom — the product's identity)

Card (agent/tool/person + kind tiles) · GroupHull/GroupCard · Shape (7 variants + grips/rotor) ·
TextLabel · StickyNote · Connector/Edge/Wire/Ports · Badges (four domains + face stack) ·
Multiplicity chips · SelectionChrome (marquee, grips) · Canvas ground (paper, dot grid, title) ·
InventorySidebar + KindPicker (shell: Astryx drawer/listbox, custom rows).

### View compositions

AgentsDirectory (shell) · AlertRouting list + fan (custom) · CommPanel readouts (custom) ·
RecentActivity/pulse (custom) · Backups view (shell; verdict grammar custom) · SystemMandala
(custom signature) · PeopleField (custom) · Detail page/sections (shell) · Panels/EmbedDebug
(custom plumbing) · FeaturesModal/TokensModal/AvatarGallery (shell) · specimen
boards (custom).

## Style-system gates carried forward

The rebuild keeps test equivalents of every shipped `style-system.test.ts` assertion: the
ascending layer scale + no-literal rule, view-root shells, centred measures + no raw px widths,
the canonical health mapping (hollow unknown, no hex in health rules), the single scrollbar
treatment, and the page-frame contract — plus the new lint from
[#667](https://github.com/factory-level/harness-hg/issues/667) (layer file + positioning confined
to primitives).
