---
name: Hermes Nexus
description: A warm-paper pastel operations canvas for running an AI-agent fleet — health is the only loud voice.
colors:
  canvas: "#eeeff4"
  paper: "#fbfaf7"
  surface: "#ffffff"
  surface-2: "#f7f8fb"
  surface-3: "#eaecf3"
  ink: "#141824"
  ink-2: "#3e4256"
  muted: "#6d7188"
  hairline: "rgba(20, 24, 36, 0.11)"
  marker: "rgba(20, 24, 36, 0.46)"
  copper: "#b36a33"
  copper-wash: "#fbebdf"
  healthy: "#3e8a6b"
  healthy-wash: "#e4f2eb"
  degraded: "#8a6a18"
  degraded-wash: "#f7efdb"
  unhealthy: "#b8543a"
  unhealthy-wash: "#fae7e1"
  unknown: "#6d7188"
  unknown-wash: "#eceef3"
  paused: "#4a5c8a"
  paused-wash: "#e9edf7"
  comm: "#2f6fe0"
  comm-wash: "#e6edfb"
  sticky: "#f7e6b8"
  sticky-ink: "#3a3210"
  kind-person: "#8ab8d9"
  kind-group: "#d98a8a"
  kind-agent: "#e8a662"
  kind-tool: "#d9c37a"
  kind-external-tool: "#62b8e8"
  kind-comm-in: "#8fd9c9"
  kind-comm-out: "#7ac9f0"
typography:
  display:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 700
  body:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 700
    letterSpacing: "0.08em"
  micro:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "9.5px"
    fontWeight: 600
    letterSpacing: "0.5px"
rounded:
  control: "8px"
  tile: "10px"
  card: "14px"
  sheet: "18px"
  pill: "999px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  button-primary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.copper}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  pill-status:
    backgroundColor: "{colors.healthy-wash}"
    textColor: "{colors.healthy}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "14px 16px"
---

# Design System: Hermes Nexus

## Overview

**Creative North Star: "The Warm-Paper Whiteboard"**

Nexus is a light, pastel operations canvas with its own visual identity: warm paper
grounds, bubbly rounded white cards, soft pastel clusters, and animated routing marks.
It deliberately does not inherit the host dashboard's dark chrome — it owns the whole
viewport, shadows the host tokens at the `.nx-root` scope, and retints everything from
one token block. The mood is a well-kept physical whiteboard in a calm control room:
sticky notes, pencil-grey connector strokes (`--marker`), monogram tiles, and one
living object — the Hermes mercury sphere, drawn live in contour lines, never as a
gloss render.

Color carries exactly two meanings and never mixes them. Pastel hue encodes *kind*
(what an object is: agent, person, tool, communication) at low chroma, muted at rest
and saturated only on hover or open. The five health colors (healthy, degraded,
unhealthy, unknown, paused) are the only status voice on any screen, each shipped as
an ink + wash pair. Everything else is neutral ink on paper, which is what lets one
real problem stand out: healthy noise recedes because it is quiet by construction.

Density is high and confident — the working type ramp lives between 9.5px and 12.5px —
but the composition is centred, generously padded, and pill-shaped, so it reads
friendly rather than cramped. A full dark theme exists as a token-for-token override
(`data-nx-theme="dark"`); every rule in the sheet retints without per-rule edits.

**Key Characteristics:**
- Warm paper + white card surfaces; the accent is a single copper (#b36a33) used sparingly
- Pastel hue = kind; ink/wash pairs = health; those are the only two color languages
- Dense small type (Figtree names/headings, Nunito Sans body), heavy weights (600–700)
- Pill-first form language; soft ambient shadows; no hard edges, no gloss, no gradients
- One ordered layering scale, one centred content measure, one scrollbar treatment

## Colors

A neutral paper world where hue is information: pastels name kinds, ink/wash pairs name
health, and one copper accent names interaction.

### Primary
- **Copper** (`{colors.copper}`, wash `{colors.copper-wash}`): the single interactive
  accent — focus rings, hover borders, primary-button text, the ring token mapped to
  the host. It is warm but low-key; it never competes with health colors.

### Secondary
- **Communication Blue** (`{colors.comm}`, wash `{colors.comm-wash}`): the
  communication domain's pencil — routing edges, comm badges, alert-routing marks.
  The only saturated non-status hue with a fixed meaning.

### Tertiary — the kind pastels
Muted pastels that mean *kind*, applied via `--kindhue` with `color-mix` washes
(≈12–14% into the surface at rest): person `{colors.kind-person}`, group
`{colors.kind-group}`, agent `{colors.kind-agent}`, tool `{colors.kind-tool}`,
external tool `{colors.kind-external-tool}`, comm-in `{colors.kind-comm-in}`,
comm-out `{colors.kind-comm-out}`. The System mandala's ten capability hues are the
same family (soft ~#8a–#d9 range pastels), held at low alpha until hovered or opened.

### Status — the health voice
Five ink + wash pairs, the only status colors anywhere: healthy `{colors.healthy}`,
degraded `{colors.degraded}`, unhealthy `{colors.unhealthy}`, unknown
`{colors.unknown}`, paused `{colors.paused}`. Ink goes on text and dots; the wash is
the pill/bead fill. The mapping is declared once in the stylesheet ("THE CANONICAL
HEALTH MAPPING") — never redeclared per component.

### Neutral
- **Canvas** (`{colors.canvas}`): the app background behind everything.
- **Paper** (`{colors.paper}`): the whiteboard ground; beads, badges and connector
  labels knock out against it.
- **Surface / Surface-2 / Surface-3** (`{colors.surface}` / `{colors.surface-2}` /
  `{colors.surface-3}`): cards, insets, and pressed wells, in that order.
- **Ink / Ink-2 / Muted** (`{colors.ink}` / `{colors.ink-2}` / `{colors.muted}`):
  primary text, secondary text, metadata.
- **Hairline** (`{colors.hairline}`): all borders and dividers; a fainter sibling
  (`rgba(20,24,36,0.06)`) for inner rules.
- **Marker** (`{colors.marker}`): the pencil-grey stroke for hand-drawn connectors.
- **Sticky** (`{colors.sticky}`, ink `{colors.sticky-ink}`): annotation notes only.

### Named Rules
**The Kind-Is-Hue Rule.** Pastel hue means kind and nothing else; health keeps the
only status colors. A component may not use a kind pastel to signal state or a health
color to decorate.

**The Paper Knockout Rule.** `--paper` must match the board background exactly —
every bead and badge halo knocks out against it, and any drift reads as a rendering
fault.

**The Muted-Until-Summoned Rule.** Kind and capability hues sit at low alpha at rest
and reach full strength only on hover, selection, or an open detail.

## Typography

**Display Font:** Figtree (system-ui fallback) — variable 400–800, self-hosted woff2
**Body Font:** Nunito Sans (system-ui fallback) — variable 400–800 + italic, self-hosted
**Label/Mono Font:** none distinct; labels are Nunito Sans, small and tracked

**Character:** Rounded, friendly geometrics at operational density. Figtree carries
every name, heading, and the brand lockup; Nunito Sans carries all running text.
Because the faces are variable, intermediate weights are legal — the canvas uses 650.
Fonts are served from the plugin's own route (CSP is `default-src 'self'`); a context
that cannot serve them falls back to system-ui per glyph.

### Hierarchy
- **Display** (700, 22px, tight −0.015em): view titles ("Agents", "Backups"). A rare
  34px hero exists only on the empty-state/welcome surface.
- **Headline** (700, 14–15px, Figtree): card and section names, drawer titles.
- **Title** (600–700, 12.5–13px): row names, panel heads.
- **Body** (400–600, 11.5–12.5px, Nunito Sans): the workhorse band — table cells,
  descriptions, evidence text.
- **Label** (700, 10.5px, 0.08em, often uppercase): section eyebrows on panels,
  column heads, provenance lines.
- **Micro** (600, 9.5–10px, 0.5px tracking): beads, chips, timestamps.

### Named Rules
**The Two-Faces Rule.** Figtree names things; Nunito Sans explains things. No third
face, no system display font, no monospace ramp.

**The Heavy-Small Rule.** As type gets smaller it gets bolder and more tracked —
never lighter. 700 at 10.5px is normal; 400 below 11px is not.

## Layout

Nexus is a fixed-viewport application (`position: fixed; inset: 0`), not a scrolling
document: views manage their own scroll regions. Top-level content is a **centred
application surface** — every page-content row takes its width from the content
measure and pairs it with `margin-inline: auto`: standard `--nx-measure: 920px`,
narrow 860px, wide 1200px, prose 520px. This governs composition only; text, labels
and table cells stay left-aligned inside the centred surface. Fleet Canvas is the
deliberate exemption — full-bleed by design — and the System mandala centres its
orbital composition in the viewport with a right slide-over for detail.

Spacing rhythm is a soft 4px grid (2/4/6/8/12/16/24 paddings observed); controls sit
at 6px 12px, pills at 2px 9px, cards around 14–16px internal padding. Density is
desktop-first; acceptance covers tablet and 200% zoom, so nothing depends on hover
alone and hit targets stay padded.

Every scroll region shares one scrollbar treatment (`--nx-sb-thumb` /
`--nx-sb-track`, `scrollbar-width: thin`, 10px WebKit rails) — never a per-region
color, and never a `scrollbar-gutter` change that would shift layout.

## Elevation & Depth

Depth is soft and ambient — diffuse, downward, low-alpha shadows on floating
surfaces; hairline borders do the structural work. There are no hard offset shadows
and no gloss anywhere.

Stacking is not ad hoc: every floating surface takes its z-index from the ordered
layering scale `--nx-z-*` (world 0 → world-content → object → object-active →
fixture → badge → panel → chrome → hover → menu → modal 10), with `.nx-root` itself
at 60 — below the host's own modals (>100). Hover surfaces outrank chrome (a
summoned popover beats the header island); panels stay below chrome. The only
literal z-indexes permitted are −1, 0, and `auto` for component-local stacking;
`style-system.test.ts` fails the build if the scale stops ascending.

### Shadow Vocabulary
- **Lift** (`box-shadow: 0 4px 12px rgba(20, 24, 36, 0.07)` — `--shl`): cards and
  small floating chips at rest.
- **Float** (`box-shadow: 0 10px 26px rgba(20, 24, 36, 0.1)` — `--sh`): popovers,
  panels, hover surfaces.
- **Loom** (`box-shadow: 0 24px 56px rgba(20, 24, 36, 0.18)` — `--shx`): modals and
  the highest summoned surfaces.

### Named Rules
**The One-Scale Rule.** A component never picks its own z-index; it names a layer.
That is how badges once ended up above status popovers, and the test now forbids it.

## Shapes

Pill-first: `border-radius: 999px` is the single most common radius in the sheet
(buttons, chips, pills, beads, filters). Containers are bubbly rounded rectangles —
8px controls, 10px tiles, 14px cards (the `--radius` default), 16–18px sheets and
large panels. Dots and status beads are true circles. Borders are 1px hairlines;
kind-colored tiles may carry a 3px top rule in the kind hue. Connector strokes are
pencil-grey, drawn as if by hand on the board. Nothing is sharp-cornered, and the
Hermes mark is pure contour line — concentric traced loops, no fill gradient.

## Components

### Buttons
- **Shape:** full pill (999px), padded 6px 12px, 11.5px text.
- **Default:** white surface, hairline border, ink text; hover shifts the border to
  copper — background does not change.
- **Primary:** same white pill with copper border and copper 600-weight text. There
  is no filled solid button in this system; emphasis is border + text color.
- **Focus:** 2px copper outline, 2px offset (`outline: 2px solid var(--acc)`), the
  app-wide focus convention.
- **Disabled:** reduced opacity, cursor default.

### Pills & Beads (status)
- **Style:** wash background + matching ink text of the same health hue, 999px,
  2px 9px, 10.5px at weight 700.
- **Variants:** healthy/ok, degraded/warn, unhealthy/crit, unknown, paused — the five
  canonical pairs only.
- **Dots:** 9px circles (7px small) in the health ink; degraded/unhealthy carry a
  pulse `::after`. Colors are declared once, at the canonical mapping.

### Chips (filters, workspace)
- **Style:** pill, hairline border, quiet surface; selected (`-on`) fills with the
  accent or kind wash.
- **State:** hover border shift; `focus-visible` copper outline like buttons.

### Cards / Containers
- **Corner Style:** 14px; larger sheets 16–18px.
- **Background:** white `--sf` on the canvas; inset wells use `--sf2`/`--sf3`.
- **Shadow Strategy:** Lift at rest; Float when raised (see Elevation).
- **Border:** 1px hairline; kind tiles add the 3px kind-hue top rule.
- **Identity:** monogram tile + Figtree name is the standard card head.

### Inputs / Fields
- **Style:** hairline stroke on `--sf`/`--sf2`, control radius (8px), body-size text.
- **Focus:** the same 2px copper outline convention; search inputs likewise.

### Navigation & Chrome
- **Style:** a floating header island and rail at the `chrome` layer; header buttons
  are quiet pills with `focus-visible` outlines. Theme toggle stamps
  `data-nx-theme`; stored choice, else dark — no system-preference mode.
- **Keyboard:** every interactive surface has a `focus-visible` rule (60+ in the
  sheet); Escape closes modals and drawers; opening a modal moves focus to its
  close control.

### The Hermes Mark (signature)
A body of mercury described entirely in contour lines — a metaball field traced with
marching squares, drawn live. Two states chosen by size: `HermesMarkLive` (animated,
≥40px — splash, System nucleus at ~150px) and `HermesMark` (still reduced glyph —
nav, ownership markers). Brand scale 128px at density 8. No gloss, no gradients,
nothing pretending to be a photograph. A small still sphere marks Hermes-owned
records wherever they appear.

### The Detail Slide-Over (signature)
Detail is a right slide-over *inside* the view (panel layer), not a page navigation:
evidence, provenance, and vendor names appear only there. Vendors never appear on
the primary surface — capabilities and product responsibilities do.

## Do's and Don'ts

### Do:
- **Do** take every color, radius, shadow, and z-index from the `.nx-root` token
  block; the dark theme only works because rules never hardcode palette values.
- **Do** pair every status ink with its wash (`--ok`/`--oksf` etc.) and keep the
  five health pairs as the only status colors on screen.
- **Do** centre page content with a `--nx-measure*` width + `margin-inline: auto`,
  and give every interactive element the 2px copper `focus-visible` outline.
- **Do** keep motion quick and quiet: 120–200ms eases on borders, opacity, and
  transforms; the only sustained animation is the live Hermes mark and health pulses.
- **Do** render truth: an object with absent sources reads *unknown* (grey), never
  green.

### Don't:
- **Don't** use a kind pastel for state or a health color for decoration — the two
  color languages never mix.
- **Don't** give the mark (or anything else) gloss, gradients, or photographic
  shading; the world is flat ink, wash, and contour line.
- **Don't** pick a literal z-index (beyond −1/0/auto) or restate a per-view content
  width; the layering scale and the measure tokens are the only sources.
- **Don't** put vendor names on a primary surface; they belong inside the detail
  slide-over's evidence panel.
- **Don't** fill buttons solid or introduce sharp corners; emphasis is a copper
  border and heavier text on a pill.
