<!-- covers: landing/ -->
<!-- Lives in maintainers/ since the wiki restructure took _docs/architecture/ apart:
     maintainer truth, beside built.md and gaps.md, outside the published wiki. -->
# The landing page and devlog

**What this page tells you:** what `landing/` is now that it is a brochure site — a sticky bar over
a one-screen hero, three value sections and a centered close, plus a features area, an about page
and the devlog — what the hero demonstrates, what the pages claim, which of those claims nothing
checks, and why nothing here deploys it.

## What it is

`landing/` is the public site for Harness Hg: **a brochure homepage under a sticky bar, a
features area (an overview and five feature pages), an about page, and a devlog** —
[ADR-133](../_docs/adr/CHANGES.md#adr-133). Thirteen HTML documents, one stylesheet, two scripts, three
vendored font files and the favicon; no build step, no dependency manifest, no lockfile. Opening
`index.html` from the filesystem renders the finished site.

**It was rebuilt from the ground up, not trimmed** ([ADR-127](../_docs/adr/CHANGES.md#adr-127)). The page
was previously a long scrolling argument: a full-bleed Nexus sheet on the first screen and nine
sections under it. `styles.css` and `hero.js` are new files at the same paths; `nexus.js` and
`marks.js` are deleted; the devlog documents were re-shelled around unchanged prose. Three things
carried across and nothing else did: the palette, `contour-sphere.js`, and the concepts.

**It is no longer one screen** ([ADR-131](../_docs/adr/CHANGES.md#adr-131)), **and no longer one page**
([ADR-133](../_docs/adr/CHANGES.md#adr-133)). ADR-131 put three sections under the hero; ADR-133 rebuilt those
sections as a brochure and grew the site to thirteen documents behind a shared sticky bar. The hero
still holds exactly one viewport — `.hero` carries `min-height: calc(100dvh - var(--topbar-h) - 1px)`,
the bar's height and border subtracted so "one screen" stays measurably true. See
[below the hero](#below-the-hero).

Asset URLs carry a `?v=N` token. It is the only cache control a no-build static site has, and it is
bumped by hand. **The token is per-reference, not global, and it has drifted before:** the devlog's
five documents once sat on `?v=3` while `index.html` had reached `?v=6`, so a returning reader got
the current stylesheet on the front page and a three-revisions-old one on every entry. All thirteen
documents are on `?v=18`, and a bump is only correct if it reaches all of them — plus `styles.css`
itself since [ADR-132](../_docs/adr/CHANGES.md#adr-132): the three `@font-face` `url()`s carry the token
too, so the set a bump must reach is fourteen files.

**That check had a blind spot, and it shipped one** ([ADR-129](../_docs/adr/CHANGES.md#adr-129)). It greps
for tokens that *exist*, so a reference carrying no token at all is invisible to it: the devlog's
five `<img src="../favicon.svg">` masthead marks were untokenized for the site's whole life while
the check printed one line and reported clean. Both commands are now the check:

```bash
grep -rho --include='*.html' --include='*.css' 'v=[0-9]\+' landing | sort -u   # one line
grep -rhoE --include='*.html' '(src|href)="[^"]*\.(css|js|svg|woff2)"' landing | wc -l   # must be 0
grep -rhoE --include='*.css' 'url\("[^"?]*\.woff2"\)' landing | wc -l          # must be 0
```

It is **not** part of the platform. Nothing here is imported by `cli/`, `infra/`, `plugin/` or
`dashboard/`, nothing reads a record or a contract, and no rendered output depends on it. The
local loop and the bootstrap program do not know it exists.

**No gate.** No `make` target, no CI job and no test touches `landing/`. `make test` and the four
bun workspace jobs in `.github/workflows/ci.yaml` all pass with the directory deleted, malformed or
factually wrong — which matters more here than for external uptime or
the state backend, because this directory makes public claims about the rest of
the repository. See [the unchecked claims](#the-unchecked-claims).

## Files

| Path | Role |
|---|---|
| `landing/index.html` | The homepage — sticky bar, hero, three value sections, the centered close, footer |
| `landing/styles.css` | Every rule, for the hero, the sections and the devlog |
| `landing/hero.js` | The sphere's physics, the rolling command, and one builder per canvas object kind |
| `landing/contour-sphere.js` | The brand-mark renderer — vendored from the design project, not authored here |
| `landing/favicon.svg` | The tab icon, and the sticky bar's brand mark on every page — the mark redrawn by hand for 16px, not an export |
| `landing/fonts/*.woff2` | The three faces, vendored ([ADR-132](../_docs/adr/CHANGES.md#adr-132)) — the latin-subset variable files Google's css2 API served this page, 83KB together, re-downloaded by hand like `contour-sphere.js` |
| `landing/features/index.html` | The features overview |
| `landing/features/*.html` | Five feature pages: agent bundles, fleet canvas, communication, backups, repository sharing |
| `landing/about.html` | Purpose, open-source stance, and the Factory-level attribution |
| `landing/devlog/index.html` | The devlog index |
| `landing/devlog/*.html` | Four entries, one file each |
| `landing/README.md` | Provenance, the preview command, and the load-bearing CSS details |

`favicon.svg` is a hand-drawn approximation, not an export: `contour-sphere.js` marches the real
mark from noise onto a `<canvas>` at runtime, which cannot produce a static icon without the build
step this directory does not have. It is a rim and two offset interior contours — what survives at
16px. The same absence is why `twitter:card` is `summary` rather than `summary_large_image`: there
is no `og:image` to fill a large card, and the large card renders the missing image as blank space.

## Where it came from, and where it went

The page began as a transcription of `Mercury Landing.dc.html` in the Claude Design project *Hermes
GitOps Nexus specification*. **Almost nothing still comes from that file** — the palette and
`contour-sphere.js`, and no layout, type scale, motion or copy. Re-importing it would not merge
with this page; it would replace it.

A *different* file in the same project is a live source, though: `Canvas Object System copy copy
2.dc.html`, which the Fleet canvas implements kind for kind. See
[the eight kinds](#the-fleet-canvas-and-the-eight-kinds).

A **third** source arrived with [ADR-130](../_docs/adr/CHANGES.md#adr-130), and it is not a design file: the
light palette is ported from the Nexus client itself, `dashboard/src/style.css:29-88`. See
[the palette](#the-palette).

The type is **three families** ([ADR-130](../_docs/adr/CHANGES.md#adr-130), `landing/styles.css:120-122`):
**Figtree** carries display, **Nunito Sans** carries body, and **JetBrains Mono** carries a literal
you would type and nothing else. ADR-127's rebuild had narrowed this to two (Figtree doing both
display and body, Nunito Sans gone); ADR-130 reversed that, and its cost section says so. `--mono`
has **two** consumption sites — `.cmd`, the rolling command, and `.mono` in devlog body prose. It
had seven before ADR-130: the eyebrow, the canvas caption, the devlog dates and tags and the
post-foot label were all mono-as-chrome and are sans, sentence case and normal tracking now.

## The palette {#the-palette}

**`landing/` is light by default.** `:root` (`landing/styles.css:30`) is the light palette and the
dark rendition is a `@media (prefers-color-scheme: dark)` override
(`landing/styles.css:146`, closing at 194). All thirteen documents carry
`<meta name="color-scheme" content="light dark">`.

The light values are ported from the Nexus client, `dashboard/src/style.css:29-88` — the same
canvas object system this board draws, on the ground the client draws it on:

| Landing token | Value | Client token |
|---|---|---|
| `--bg` | `#EEEFF4` | `--bg` — the page |
| `--panel` | `#FBFAF7` | `--paper` — the board |
| `--card` | `#FFFFFF` | `--sf` — an object surface |
| `--sunk` | `#EAECF3` | `--sf3` — a recess |
| `--accent` | `#B36A33` | `--acc` — terracotta |
| `--paper` | `#F7E6B8` | `--sticky` — the one material a person writes on |

Three rules govern the block, and each exists because a single value could not do two jobs:

- **`--ink-6` is a contrast floor, not a shade.** At `#5F6379` (`landing/styles.css:59`) it clears
  4.5:1 on **four** grounds: `--bg` 5.16, `--panel` 5.67, `--card` 5.92, `--sunk` 5.02. The
  client's own muted ink `--mut #6D7188` fails three of the four and is deliberately not ported.
- **`--accent` is a graphic; `--accent-ink` is text.** `#B36A33` measures 3.44:1 at its worst
  ground and 3.64:1 on the page — over the 3:1 graphics floor, under the 4.5:1 text floor. Text
  takes `--accent-ink #965423` (`landing/styles.css:66-67`). `--comm` splits the same way into
  `--comm` (the 3px readout spine) and `--comm-ink` (the label and count),
  `landing/styles.css:87-88`. `.skip` paints `--accent-ink` as its *ground*, because nothing clears
  4.5:1 over `#B36A33` — pure black tops out at 5.03.
- **Ownership colour never becomes a fill**, on either ground. A 2–3px bar or a 2px ring, nothing
  else. That rule came from the source sheet's note about dark mode and survives the move to light
  because the dark rendition still exists.

Four things follow from the ground changing:

- **The film grain is dark-only** (`landing/styles.css`, `body::after`, inside its own dark `@media`). Its whole justification is that
  five near-black surfaces separated by hairlines band on cheap panels; on paper the layer is not
  painted at all.
- **The canvas grid is a dot field**, `radial-gradient(var(--grid) 1.2px, transparent 1.2px)` on
  `.canvas::before`, matching the client's `--dot` (`dashboard/src/style.css:26`). It was a
  two-axis line grid.
- **There is a `--radius` scale** (`landing/styles.css:109-115`), where every radius had been a
  per-object literal.
- **The mark's specular polarity inverts.** `hero.js` reads `--mark-ink`/`--mark-spec` off `:root`
  (`landing/hero.js:53-54`), and on light `--mark-spec #85491D` is *darker* than `--mark-ink
  #B36A33` — light gathering on a light ground has to read as density. In dark it is lighter. One
  mechanism, two directions.

**Two full palettes are now maintained by hand, and nothing checks that they agree.** A token added
to `:root` and not to the dark block silently inherits its light value into dark; a token added
only to the dark block is undefined on the default path. This is the same no-gate problem the rest
of the directory has, at twice the surface.

**Dark is now the secondary path.** It is what a reader sees only if their OS asks for it, so an
author working in light can ship a dark regression and never look at it — which is exactly how the
three failures above survived. The values are also copied by hand from `dashboard/src/style.css`
and share no code with it, so a change in the client will not reach here. The resemblance is
stronger than it was; the coupling is still nothing.

## The hero {#the-hero}

One screen under the bar — `min-height: calc(100dvh - var(--topbar-h) - 1px)` on `.hero`, and `dvh`
rather than `vh` because mobile Safari measures `vh` with the URL bar hidden. The live mark leads
([ADR-134](../_docs/adr/CHANGES.md#adr-134)) with the eyebrow at its side and the claim underneath, then a
full-width band holding the rolling command above the Fleet canvas, then one paragraph and the two
actions. The mark **bookends** the homepage — ~73px opening the hero, ~216px closing the page — and
About's head carries it too. Nothing in the hero is centred.

**The order is the argument**, read top to bottom: whose it is, what you type, what that put on the
board.

### The paragraph names only fields the record has {#the-paragraph}

The hero's single paragraph (`landing/index.html:157`) reads:

> Your agent, the apps it runs beside, the secrets it needs and how it is exposed — rendered as **one
> record** and written into Git. **Argo CD** applies it and keeps it applied.

Each noun maps to a key that exists under `spec:` in
`agent-bundle-contracts/hermesprofile/v1alpha1/profile.schema.json` and appears in the record quoted further
down the page: `spec.apps[]`, `spec.envRequires[]`, `spec.expose`.

**It used to say something else, and one third of it was false.** Until
[ADR-131](../_docs/adr/CHANGES.md#adr-131) it read *"Your agent, the tools it ships, the events it publishes
and the people who approve it"*:

| Was claimed | Reality |
|---|---|
| "the people who approve it" | **Does not exist anywhere in the system.** `gaps.md:142` marks approval **Absent** — "No CODEOWNERS anywhere. No review policy." `gaps.md:133` marks branch protection **Absent**: "The PR rule is client-side convention only." |
| "the tools it ships" | **Not a field.** `spec` is `additionalProperties: false` and has no such key. `tools` occurs in the record once, as an `expose.services[].name` — a **port name**. |
| "the events it publishes" | Real as a concept, **not in the record.** It is declared in `hermes-gitops.yaml` and the emitter strips those blocks before rendering (`plugin/gitops_emitter/render.py:266`, `strip_extension_v3`). |

The middle claim shipped with [ADR-69](../_docs/adr/CHANGES.md#adr-69), survived
[ADR-127](../_docs/adr/CHANGES.md#adr-127)'s ground-up rebuild and
[ADR-129](../_docs/adr/CHANGES.md#adr-129)'s eleven-issue audit, and was live for the whole life of the page.
**No gate could have caught it, because no gate reads `landing/`.** It is recorded in full in
[ADR-131](../_docs/adr/CHANGES.md#adr-131) and listed under
[the unchecked claims](#the-unchecked-claims).

The command shares its rule with a **pause control** ([ADR-129](../_docs/adr/CHANGES.md#adr-129)): a 28px
`<button>` carrying `aria-pressed` and an accessible name that changes with its state. It is built
by `hero.js` and is not in the markup — without the script nothing cycles, so a control for
stopping it would name a state that cannot occur. Hovering the command line still pauses, and
leaving no longer resumes a cycle the *button* stopped.

The band was a lopsided two-column grid until ADR-128, with the mark in the narrow side. That cost
the board ~30% of its width and set a 214×214 mark beside a 207px-tall canvas carrying the entire
claim — the decoration out-massed the demonstration. ADR-128 moved the mark to an identity row and
gave the canvas the shell width; ADR-133 removed the row for the sticky bar; ADR-134 brought the live
mark back at the hero's head (`.hero__mark`, ~73px, the headline underneath it) while the close
keeps the large mount (`.cta__mark`, up to 216px).

### The rolling command

`hermes-hg <verb> <target>` cycles six scenes. **The verb changes rarely and the target rolls
beneath it** — three deploys, two upgrades, one restore.

**The commands do not exist**, and neither does the binary. `hg` is the real CLI; `hermes-hg`
matches nothing in `cli/`. That is deliberate and gated — see
[ADR-70](../_docs/adr/CHANGES.md#adr-70) and [ADR-127](../_docs/adr/CHANGES.md#adr-127). `hero.js`'s `SCENES`
array is the checklist the CLI has to satisfy before this page may launch.

### The Fleet canvas, and the eight kinds

What each command draws is the **canvas object system**, imported from `Canvas Object System copy
copy 2.dc.html` in the Claude Design project rather than approximated. Eight kinds, each a
different silhouette: **agent profile** (tall card, owner's bar, the only lifted object and the
only one carrying the mark), **tool** (wide plaque, owner's bar, tight radius — a nameplate, not a
card), **reserved profile** (recessed container holding registerable link tiles; a filled dot is
claimed, a hollow one published and unclaimed), **person** (circle, blue ring, and the only object
whose name sits outside its shape), **group of people** (pill, blue ring, avatar stack — the same
shape family as a person), **agent distribution** (a fanned hand of profiles, only the front one
named), **communication** (a clipped, tinted readout in inbound and outbound mirrors, titled by the
abstract event), and **sticky** (square, tilted, italic).

Three channels, one job each:

| Channel | Means | Consequence here |
|---|---|---|
| Shape | the kind | eight silhouettes that survive zoom; no badge or label is load-bearing |
| Colour | **ownership, never status** | the bar takes the shipping domain's colour; people take blue and only people do; the status bead is **neutral grey** so it cannot compete |
| Material | authorship | published objects are crisp and aligned; the one a person wrote is paper, tilted, italic |

Connectors follow the same sheet: straight strokes, an open arrowhead, and a lowercase italic verb
knocked out of the paper — no pill, no border, no elbows, and never a status colour.

**The board is now on the sheet's own ground.** ADR-127 recorded a dark translation as "the one
liberty taken" against a light source sheet; [ADR-130](../_docs/adr/CHANGES.md#adr-130) gave that liberty
back and the page is light by default — see [the palette](#the-palette). The sheet's rule survives
the move intact: a full colour wash per kind "collapses in dark mode, where the apricot surface is
nearly black", so colour stays on a 2–3px bar or a 2px ring and never becomes a fill. The dark
rendition still exists, so the reason for the rule still exists.

**This makes the design project a source of truth again** — for the object system specifically.
[ADR-69](../_docs/adr/CHANGES.md#adr-69) retired *`Mercury Landing.dc.html`*, and that is still retired;
`Canvas Object System copy copy 2.dc.html` is not. Nothing enforces the coupling.

### Load-bearing implementation details

- **The verb slot is `8ch` wide** (`styles.css`, `.roll--verb`). That fixed width is what lets a
  verb swap animate without reflowing the target beside it, which keeps the roll on `transform` and
  `opacity` and off the layout path. Remove the width and the roll starts animating geometry.
- **Wires and objects share one `.canvas__stage`.** Their coordinates are the same percentages, so
  a zoom must scale both; scaling them separately slides every connector off its endpoints.
- **`overflow-x: clip` is on `html`, not `body`.** The ambient blob (`.hero::before`) reaches past
  the edges on purpose. Clipping `body` alone does not contain it — `html` is the scroll container.
  Measured at 87px of phantom horizontal scroll on a 500px viewport.
- **`.hero` also clips.** `overflow-x` on `html` catches the blob's horizontal bleed but not its
  vertical one, which added 198px of page height under a hero that is exactly one viewport tall.
- **Under 760px wide the canvas becomes a portrait board, and under 840px tall it is dropped.**
  The objects are a fixed size at fixed coordinates, so a smaller canvas is less room rather than
  smaller objects — it is never shrunk into noise. Below 760px wide *and* 840px tall or more,
  `hero.js` keeps **objects 0 and 1** of the scene and places them on a diagonal
  (`PHONE_AT = [[28, 28], [72, 76]]`, `landing/hero.js:35`) in a `clamp(180px, 30vh, 260px)` board.
  Every scene's first
  two objects are its subject and the thing it acts on, and every scene has a wire between them, so
  a phone sees a subset of the same claim ([ADR-129](../_docs/adr/CHANGES.md#adr-129)). Shorter than 840px
  there is genuinely no room — 375×667 overflows by 59px with the smallest board worth drawing — so
  an iPhone SE still gets the command and the paragraph alone.
- **The phone gate is written twice and agreement is not enforced.** `PHONE` in `hero.js` and the
  `@media (max-width: 760px) and (min-height: 840px)` rule in `styles.css` must match; nothing
  checks that they do.
- **The stage zoom is two INDEPENDENT tiers multiplied**, `--zw` for width and `--zh` for height.
  A single variable cannot express it: the later media query would overwrite the earlier one, so a
  short *and* narrow viewport would take whichever rule came last rather than the smaller of the two.
  Since ADR-128 a third constant, `--zb: 1.16`, multiplies through both
  (`landing/styles.css`, `.canvas__stage`) — it is a base, not a tier, so it raises every breakpoint at once and
  the two responsive tiers still take the smaller of the two.

- **Height gates legibility, not width.** Objects are a fixed pixel size, so a wider board spreads
  them while a taller one is what allows the zoom to come up. `.canvas` is `clamp(150px, 31vh,
  330px)`; it was `27vh` before ADR-128. At 1920×1017 the board went 826×207 → 1120×315, and the
  smallest type on it (7.5–8.5px, unchanged in CSS) renders 16% larger.
- **The scene `at` percentages are computed, not composed** — internal gaps equal, edge margins at
  0.7× an internal gap, derived from each object's measured rendered width
  ([ADR-129](../_docs/adr/CHANGES.md#adr-129)). Pushing anchors toward the edges is the tempting mistake and
  makes it worse: it turns the spare half of the board into one hole instead of rhythm. They were
  **recomputed by the same method** when ADR-130's type change moved the object widths, and
  `PHONE_AT` moved with them. Both the widths and the recomputation are hand measurements.

### Spacing is fluid in both axes

Vertical rhythm is driven by `--pad-y` and `--gap-y`, both `vh`-based clamps, and the headline is
bounded by `min(3.9vw, 6.4vh)` so a short wide viewport cannot size it for a screen that is not
there. This was not cosmetic: with fixed vertical spacing the hero overflowed at 960×600, 700×500,
740×420, 375×667, 360×640 and 320×568 — every failure a *short* viewport rather than a narrow one,
because only the horizontal axis was fluid.

Phones ≤560px take their own headline regime (`clamp(1.42rem, 6.6vw, 1.78rem)`): the desktop clamp's
`vw` term collapses far below its floor on a phone, so every width from 320 to 560 got the same
27px — which a 320px screen has no height for.

**Measured across 29 viewports from 2560×1440 to 320×568, none overflows in either axis, and every
scene's every object clears every board edge by ≥11px.** That sweep was driven through same-origin
iframes against a temporary local server; the harness is gone. Nothing enforces it — it is a manual
check, like everything else in this directory.

### Accessibility, as it now stands {#accessibility}

Every text surface on both pages meets **WCAG AA contrast (4.5:1)** on the light default, computed
rather than eyeballed ([ADR-130](../_docs/adr/CHANGES.md#adr-130)). The token that gates it is `--ink-6`,
`#5F6379`, measured against **four** grounds: `--bg` 5.16, `--panel` 5.67, `--card` 5.92 and
`--sunk` 5.02. `--sunk` is the reserved container's recess and is the darkest of the four; ADR-129's
dark audit measured three grounds and never had to count it. The smallest type on the board — a
tool's 9.5px meta line and the 8px registration endpoint on a communication readout — are what
constrain it.

**ADR-129's figures no longer describe the default path.** That audit's `--ink-6` was `#778195` at
4.95/4.78/4.52, measured on the dark ground that is now the override. Every contrast number ADR-69,
ADR-127, ADR-128 and ADR-129 recorded was re-taken by hand for ADR-130; none of them, then or now, is
produced by a gate.

**Three contrast failures were live in the dark theme until ADR-130, and ADR-129's audit missed all
three** — recorded here because the miss is the useful fact, not the fix:

| What | Was | Now |
|---|---|---|
| `.tile__dot--open` — the claimed/unclaimed registration dot | `opacity: .6`, **2.51:1 in dark** (2.37:1 on the new light tile) | opacity gone, 1.5px stroke at full strength |
| `.comm__head .n` — the readout's event count | `opacity: .72`, **4.37:1 in dark**, 3.23:1 on light | `opacity: 1` |
| `--line-4` — the connector pencil, the canvas's whole grammar | `#4A5468`, **2.46:1 on `--panel`**, under the 3:1 graphics floor (`--line-3` was `#3A3F52`, 1.86:1) | lifted in both blocks against their floors (`landing/styles.css:46-47` light, `156-159` dark) |

Two of the three are `opacity` on a text rule rather than a token value, which is where the earlier
audit's method had its blind spot: an opacity composites a colour no token block names. Nothing
greps for it.

Other properties worth stating because none of them is enforced:

| Property | Where |
|---|---|
| The cycle has a keyboard-reachable pause (WCAG 2.2.2) | `hero.js` builds `.cyc` on the command's rule |
| The illustration disclaimer is announced *and* legible (4.78:1) | `aria-hidden` is on `.canvas__stage`, not `.canvas` |
| Every tap target is ≥24px (WCAG 2.5.8) | `padding: 4px 0` on `.link`; `padding: 6px 0` on `.topbar__nav a`; `padding: 5px 0` on `.post__links a`, `.post__nav a` |
| The skip link moves focus, not just scroll | `tabindex="-1"` on every `<main>`, all thirteen documents |
| The Features menu is a `<details>`, not a hover menu | opens on click/Enter without script; Escape-close and outside-click-close are a `hero.js` enhancement (`mountMenus`) |
| Reduced motion stops the cycle entirely and paints one still frame | `hero.js` (`reduce` at `hero.js:15`), and the `@media` block at the end of `styles.css` |

The mark's `<canvas>` is `aria-hidden` and the board is restated in static prose, so a reader with
no script or no sight loses the demonstration and not the argument.

### The sphere

`contour-sphere.js` is **not verbatim** from the design project. The membrane takes a direction and
a strength so it can be pulled toward the visitor's pointer, and gathers light on the pulled side.

- **A directional bulge.** Per grid point, the radius gains `pull · cos³θ` toward the attractor and
  loses a smaller `cos²θ` term opposite it, so volume reads as preserved rather than inflated.
- **A displaced centre**, spring-integrated with under-damping — it lags the pointer, overshoots
  once, and settles. That lag is why it reads as mass rather than as a cursor-follower.
- **An idle drift**, so it is never quite still with no pointer in the room.

**Frame budget.** The membrane is re-marched every frame and the 3-octave noise is the expensive
part, so it runs on a ~33fps tick with its grid capped at 78² (`maxGrid`) while the CSS animations
stay on the compositor. It does not paint while the tab is hidden or the mark is off-screen. Under
`prefers-reduced-motion` it paints one still frame and never starts the loop.

### What is script, and what is not

`hero.js` is **entirely an enhancement**. Without it the page still renders and still makes its
whole argument: the claim, the paragraph, the links and the status are ordinary markup, visible by
default. Nothing is hidden waiting for script to reveal it.

What is lost without it is the demonstration — which is why the demonstration is `aria-hidden` and
restated in static text. It rewrites itself every few seconds, and a live region there would read
the page aloud forever.

Hovering the command line pauses the cycle. That listener is bound to the `.cmd` line and **not**
to the surrounding block: the block spans the command and every shape under it, a large target near
the middle of the screen, and a cursor left parked anywhere in it froze the hero with no way to
tell why.

## Below the hero {#below-the-hero}

**ADR-133 rebuilt everything under the hero as a brochure**, to an external design specification:
three value sections in an alternating asymmetric grid (`.feat`, visual a third / copy two thirds,
sides swapping each row), then a centered close (`.sec--cta`) where the live contour-sphere mark
mounts at up to 216px above the two destinations. The golden-record block, the three-step path
section and the six-component stack list are **gone from the homepage**; what a section needs
beyond one idea now lives on a feature page or in the docs it links to. ADR-133's Cost section
records what removing them cost — including that the one claim a gate stood behind (the record
block) is no longer on the site.

**ADR-147 delivered the asset pass ADR-133's markup reserved.** The three value sections and the
agent-bundles page head now carry generated scene art (`landing/assets/`: the shared office, the
hub-and-spoke of grey tool marks around the mercury mark, the fleet islands, the bundle island) as
plain `<img class="feat__scene">` swaps inside the same figures. The hero's profile cards wear
avatar-inventory GIFs from `landing/avatars/` (rings mark stays the fallback and the no-`icon`
form), and the two person discs wear photographic headshots (`hannah.png`, `jared.png`; initials
fallback on load failure). Nothing checks any of this beyond the fallbacks — a deleted asset
degrades to the pre-ADR-147 form rather than breaking.

The three sections and their visuals:

| Section | Claim | Visual |
|---|---|---|
| Agent bundles | "Install the whole team." | a static board vignette in the object grammar (`.vizboard`) |
| GitOps-native | "Orchestrated by the GitOps tools you already know." | a four-node connection map (`.vizmap`), the pull request as its one accent |
| The product surface | "See the whole fleet." | a board vignette, plus the four-capability list |

The vignettes are **hand-placed static compositions in the same materials the hero's board draws**
— dot field, panel ground, owner's bar, the blue-ringed person, paper — and each is captioned
`· illustration`. The specification's pixel-agent scene is a deferred asset pass; the object
grammar stands in by decision, not accident.

### The features area and about {#the-features-area}

`landing/features/` holds an overview and five feature pages (agent bundles, fleet canvas,
communication, backups, repository sharing), all generated from one shell: sticky bar, a
`.pagehead`, then Why-it-matters, a three-step How-it-fits (reusing `.steps`), related-capability
cards (`.fcards`) and a docs CTA into the matching wiki page. `landing/about.html` carries the
purpose, the open-in-public stance and the **Created by Factory-level** attribution. The pages stop
one level short of the docs on purpose: outcome language, no syntax, no schemas.

**Every factual claim on them was checked against [gaps.md](gaps.md) at writing time** — bundles
(ADR-28/62), the canvas kinds, the event router, `hg backup` and the recovery gate, persona
repositories and distributions all exist — but the claims are prose on an ungated surface, exactly
like everything else here. No license is named anywhere, because the repository has no license
file.

### The close, and the footer

A centered `.sec--cta`: the live mark (`.cta__mark`, mounted by the same `mountSphere` loop as
before — `hero.js` now mounts every `[data-sphere]` on a page), "Build with it. Follow the build.",
and the two destinations. The footer carries Docs, Devlog, Features, About and GitHub, plus
**"Created by Factory-level."**

**The alpha status line is gone from the site** (ADR-133, at the specification's direction): no
"Alpha · single-node runtime" in the hero, the close or the footer. Product status lives in the
docs — [gaps.md](gaps.md) still records the single-node reality — and the marketing surface no
longer states it. The "Decisions" footer link is gone with it; the decision log remains published
in the wiki and is simply no longer a marketing-site destination.

## The devlog {#the-devlog}

`landing/devlog/` holds four entries. Each is **sourced from a real commit body or ADR in this
repository** — the recovery rehearsal that found a hand-created credential (`#283`), the embedded
Grafana panel that was withdrawn ([ADR-44](../_docs/adr/CHANGES.md#adr-44)), the bundle NetworkPolicy
(`#284`), and `versions.json` ([ADR-63](../_docs/adr/CHANGES.md#adr-63)). No entry describes work that did
not happen, and each links the record and the issue it came from. Since ADR-133 the devlog carries
the shared sticky bar instead of its own masthead, and its documents load `hero.js` for the
Features menu's Escape/outside-click behaviour.

The rebuild changed the page shell and left **the prose byte-for-byte**; one edit has landed since —
[ADR-132](../_docs/adr/CHANGES.md#adr-132) thinned the em-dash density in *The copy is always the one that
rots* from ten body dashes to two. Entries are divided rows
rather than cards, and the pull quote is a rule and a weight change rather than a panel.

Two properties worth stating because neither is enforced:

- **The entries are written in the first person**, as the project's author. They were drafted from
  commit bodies rather than dictated, so the voice is an approximation until it is edited.
- **Nothing links an entry to its source commit.** If an ADR is superseded or an issue is closed
  differently, the entry keeps its original telling and nothing notices.

## The unchecked claims {#the-unchecked-claims}

ADR-127's rebuild **removed most of them by removing the claims**, not by verifying them: the gaps
count, the decision count, the age, the illustrated fleet and the sheet's inspector readings are all
gone from the site and have not come back. [ADR-131](../_docs/adr/CHANGES.md#adr-131) then added a new set,
because the sections below the hero make statements about the platform again. What is on the site
now:

[ADR-133](../_docs/adr/CHANGES.md#adr-133) then rebuilt the sections as a brochure, which removed several
of ADR-131's rows the same way ADR-127 removed its predecessors' — by removing the claims. The golden
record block and the six-component list are gone; the feature pages arrived. What is on the site
now:

| Claim | Where | Real source |
|---|---|---|
| The six commands and their drawn results | `hero.js` `SCENES` | **nothing — the CLI has none of these verbs** ([ADR-70](../_docs/adr/CHANGES.md#adr-70)) |
| `hermes-hg` as a binary name | `index.html`, `hero.js` | **nothing — the binary is `hg`** ([ADR-127](../_docs/adr/CHANGES.md#adr-127)) |
| "Argo CD applies it and keeps it applied" | `index.html` note | true of the emitter path, restated by a surface no test reads |
| The hero paragraph's three nouns | `index.html` note | `spec.apps[]`, `spec.envRequires[]`, `spec.expose` — all three real, and **the previous wording was not**; see [the paragraph](#the-paragraph) |
| "No bespoke controller — reconciliation is off-the-shelf" | the GitOps section | true; the same fact [built.md](built.md) states, restated where nothing reads it |
| The three homepage section claims and their vignettes | `index.html` | bundles (ADR-28/62), the path, the canvas grammar — prose and hand-placed illustrations, each captioned `· illustration` |
| Every claim on the five feature pages | `landing/features/` | checked against [gaps.md](gaps.md) at writing time (ADR-133); **no check reads them**, and partially-built areas (canvas kinds, communication narrowing) are described at outcome level only |
| "Created by Factory-level" | footer, all pages; `about.html` | the repository's owner |
| Four devlog entries and their standings | `devlog/` | `CHANGES.md` and the commits cited |

**The golden record block is gone, and with it the only claim a gate stood behind.** While it was on
the page, its caption ("asserted byte-for-byte by `make pytest`") was true of the fixture and not of
the page's hand copy, and the proposed fix — extract the `<pre>`, byte-compare against the fixture —
was never built. ADR-133 removed the block rather than the risk: the docs still own the record, and
the homepage no longer quotes YAML at all. The check is moot for the homepage and still absent for
everything else here.

The old worked example is worth keeping even though its claim is gone from the site: the decision
count was 63 and correct in the design source, and [ADR-69](../_docs/adr/CHANGES.md#adr-69) — the record
for this very page — made it 64 in the same pull request that published it. It was corrected by hand,
because nothing would have caught it. `gaps.md` carries a row for this under
[Known defects](gaps.md#known-defects).

**And the sharpest example is no longer a count.** The hero paragraph claimed for the whole life of
the page that a record carries *"the people who approve it"*, on a system where `gaps.md:142` marks
approval **Absent** and `gaps.md:133` marks branch protection **Absent**. It survived a ground-up
rebuild and a technical audit. A drifted number is embarrassing; a marketing surface describing a
governance mechanism that was never built is a different class of failure, and the directory's
no-gate status is what let it stand.

## What deploys it

Nothing. `.github/workflows/wiki.yaml` publishes this wiki to GitHub Pages from `_docs/`, and the
landing site is a **separate site** — it does not share that root and no second workflow exists.
`landing/` is source in this repository and a deployment target chosen later
([ADR-69](../_docs/adr/CHANGES.md#adr-69)). That later choice now carries a constraint: the
site's 39 docs links are root-relative `/docs/…` paths
([ADR-137](../_docs/adr/CHANGES.md#adr-137)), so the deployment must mount the wiki at `/docs/`
of the origin that serves the landing pages — the shape `make dev-site` already serves locally.

The site makes **no external requests** ([ADR-132](../_docs/adr/CHANGES.md#adr-132)). The three faces —
Figtree, Nunito Sans and JetBrains Mono — are vendored in `landing/fonts/` as the latin-subset
variable woff2 files Google's css2 API served this page, declared in `styles.css` with the
unicode-ranges they were served under and preloaded from each document's head. No analytics, no
cookie, no form, no third-party request of any kind. A face update is a manual re-download, and
nothing checks the vendored files against upstream — the copy-rot ADR-63 ended for version pins
exists here for three binary files, accepted over a third-party runtime dependency.

## Preview

```bash
make dev-site                             # one origin (ADR-136): landing at /, wiki at /docs/, Nexus demo at /demo/
xdg-open landing/index.html               # file:// still renders every page — but the docs links
python3 -m http.server -d landing 8080    # (root-relative /docs/… since ADR-137) resolve only
                                          # where the wiki is mounted at /docs/, i.e. dev-site
```
