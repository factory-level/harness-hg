# `landing/` — the Harness Hg site

A brochure site behind a sticky bar (ADR-133): a one-screen hero keeping the rolling-command
demonstration, three value sections, a centered close with the live mark, a features area, an about
page, and a devlog. **No build step, no dependencies, no lockfile — and no external requests.**
Open `index.html` in a browser and it renders; copy this directory to any static host and it is
deployed.

```
landing/
  index.html          the homepage — sticky bar, hero, three value sections, close, footer
  styles.css          every rule, for every page — light `:root`, dark `@media`
  hero.js             the spheres' physics, the rolling command, one builder per object kind, the menu
  contour-sphere.js   the brand mark renderer — vendored verbatim, do not edit
  favicon.svg         the tab icon, and the sticky bar's brand mark
  fonts/              the three vendored latin-subset woff2 (ADR-132)
  about.html          purpose, open-source stance, Factory-level attribution
  features/
    index.html        the features overview
    *.html            five feature pages, one file each
  devlog/
    index.html        the entry list
    *.html            one file per entry
```

## It was rebuilt, not trimmed

The page was a long scrolling argument — a Nexus sheet, nine sections, a footer. ADR-127 rebuilt it as
one screen: `styles.css` and `hero.js` were **rewritten from nothing** at the same paths; `nexus.js`
and `marks.js` are deleted. What carried over is the palette, `contour-sphere.js`, and the concepts.
Do not look for the old rules in here — they are in git history, not in this file.

The palette carried over then and has since been **replaced** (ADR-130): see [the palette](#the-palette).

**It is no longer one screen (ADR-131), and no longer one page (ADR-133).** The hero still holds one
viewport (minus the sticky bar, which its `min-height` subtracts); a brochure now sits below it and
the site has thirteen documents. See [below the hero](#below-the-hero).

## The palette

**Light by default.** `:root` is the light block; the dark rendition is a
`:root[data-theme="dark"]` override further down the same section. The attribute is set before
first paint by `theme.js` (loaded in every document's `<head>`, above the stylesheet): the wiki's
Material toggle persists its choice to localStorage as `__palette`, and on the shared origin the
site honors that choice, falling back to the system preference when nothing is stored. Without
JS the page is light-only. Every document carries `<meta name="color-scheme" content="light dark">`.

The light values are ported from the **Nexus client**, `dashboard/src/style.css:29-88` — the same
canvas object system this board draws, on the ground the client draws it on. `--bg` from the
client's `--bg`, `--panel` from `--paper`, `--card` from `--sf`, `--sunk` from `--sf3`, `--paper`
from `--sticky`, `--accent` from `--acc`.

| Token | Light | Dark | Job |
|---|---|---|---|
| `--bg` | `#EEEFF4` | `#0B0D14` | the page |
| `--panel` | `#FBFAF7` | `#0E121C` | the board |
| `--card` | `#FFFFFF` | `#141824` | an object surface |
| `--sunk` | `#EAECF3` | `#090B11` | a recess (the reserved container) |
| `--ink-6` | `#5F6379` | `#778195` | **the contrast floor** — see below |
| `--accent` | `#B36A33` | `#F5B98C` | ownership graphic: bars, rings, tints, dots, the mark |
| `--accent-ink` | `#965423` | `#F5B98C` | accent **text** |
| `--comm` | `#2F6FE0` | `#8FB0F2` | the readout's 3px spine and rule |
| `--comm-ink` | `#1F56C0` | `#8FB0F2` | the readout's label and count |
| `--mark-ink` | `#B36A33` | `#F5B98C` | the contour sphere's line |
| `--mark-spec` | `#85491D` | `#FFE3D0` | its specular — **darker** than the ink on light |
| `--paper` | `#F7E6B8` | `#2A2517` | the sticky, and nothing else |
| `--line-4` | `rgba(20,24,36,.55)` | `#5A657C` | the connector pencil |

Three rules, and breaking any of them is silent:

1. **`--ink-6` is a contrast floor, not a shade.** It must clear 4.5:1 on all **four** grounds it
   lands on. `#5F6379` measures `--bg` 5.16, `--panel` 5.67, `--card` 5.92, `--sunk` 5.02. The
   client's own `--mut #6D7188` fails three of the four — do not port it.
2. **`--accent` is a graphic and cannot carry type.** `#B36A33` is 3.44:1 at its worst ground: over
   the 3:1 graphics floor, under the 4.5:1 text floor. Text takes `--accent-ink`. `--comm` splits
   the same way. `.skip` paints `--accent-ink` as its *ground*, because nothing clears 4.5:1 over
   `#B36A33` — pure black tops out at 5.03.
3. **Ownership colour never becomes a fill**, on either ground — a 2–3px bar or a 2px ring.

Four consequences worth knowing before you edit:

- **The film grain is dark-only.** Its justification is that five near-black surfaces separated by
  hairlines band on cheap panels; on paper it would read as dirt, so the layer is not painted.
- **The canvas grid is a dot field**, not a two-axis line grid — matching the client's `--dot`.
- **There is a `--radius` scale** (`--r-xs` … `--r-pill`). Every radius used to be a per-object
  literal. Add to the scale rather than typing a new number.
- **The mark's specular polarity inverts.** On light, `--mark-spec` is *darker* than `--mark-ink`:
  light gathering on a light ground has to read as density. `hero.js` reads both off `:root`.

**Two palettes are maintained by hand and nothing checks that they agree.** A token you add to
`:root` alone inherits its light value into dark; a token you add to the `@media` block alone is
undefined on the default path. Add to both, every time.

Three contrast defects lived in the dark theme until ADR-130 and are recorded here so they are not
reintroduced: `.tile__dot--open` at `opacity: .6` (2.51:1), `.comm__head .n` at `opacity: .72`
(4.37:1), and `--line-4` at `#4A5468` (2.46:1 on `--panel`, under the 3:1 floor the wires need).
**Two of the three were an `opacity` on a text rule, not a token** — that is where an audit that
only reads token values will miss things.

## The hero

The live mark, the eyebrow at its side, the claim underneath, then one full-width band: the rolling
command above the Fleet canvas. The mark bookends the page (ADR-134) — it opens the hero at ~73px and
closes the page at up to 216px — and `hero.js` mounts every `[data-sphere]` it finds.
**That order is the argument** — whose it is, what you type, what that put on the board.

The mark used to hold a third of the band beside the canvas, where it out-massed it (ADR-128);
ADR-133 then moved the brand into the bar and the live mark to the close, and the board keeps the
width. **Height, not width, is what makes the board legible** — objects are a fixed pixel size at percentage coordinates, so a wider canvas only
spreads them; `--zb` and the `31vh` height are what bring the type up.

`hermes-hg <verb> <target>` cycles six scenes. **The verb changes rarely and the target rolls
beneath it** — three deploys, two upgrades, one restore.

`hero.js`'s `SCENES` array is the checklist: **none of these commands exist yet**, and nothing
launches until `hg` fulfils them (ADR-70). `hermes-hg` matches no binary either.

### The eight kinds are imported, not invented

The canvas implements **`Canvas Object System copy copy 2.dc.html`** from the Claude Design project
— all eight kinds and all three channels. Do not simplify it back into generic cards:

| Kind | Silhouette |
|---|---|
| Agent profile | tall card, owner's bar, the only lifted object and the only one carrying the mark |
| Tool | wide plaque, owner's bar, tight radius — a nameplate, not a card |
| Reserved profile | recessed container holding link tiles; filled dot = claimed, hollow = unclaimed |
| Person | circle, blue ring, and the only object whose name sits **outside** its shape |
| Group of people | pill, blue ring, avatar stack — the same shape family as a person |
| Agent distribution | a fanned hand of profiles; only the front one is named |
| Communication | clipped, tinted readout; inbound and outbound are mirrors |
| Sticky | square, tilted, italic |

- **Shape means kind.** Eight silhouettes that stay distinguishable when the type is too small to
  read.
- **Colour means ownership, never status.** The bar takes the colour of the domain that ships it;
  people take blue and only people do; the status bead is **neutral grey** so it can never compete
  with ownership. Only a real problem earns a warm colour.
- **Material means authorship.** Published objects are crisp and aligned. The one thing a person
  wrote is paper — tilted, square-cornered, italic. Nothing in between.

Connectors are pencil: straight strokes, an open arrowhead, a lowercase italic verb knocked out of
the paper. No pill, no border, no elbows, and never a status colour.

Two conventions the whole page holds to, and that are easy to break one object at a time:

- **Two shadow weights, both tinted.** `--sh-lift` for the agent profile (the one lifted object)
  and `--sh-low` for everything else. Both are a darker blue-black, not `rgba(0,0,0,…)` — a pure
  black shadow over a tinted surface reads as a grey smudge.
- **One icon stroke weight: 1.5.** The single exception is the connector's arrowhead, which is
  weight 1 to match the wire it terminates (`markerUnits="strokeWidth"` scales it by the line).

**The board is on the sheet's own ground now.** ADR-127 called the dark translation "the one liberty
taken" against a light source sheet; ADR-130 gave it back and the page is light by default. The
sheet's rule survives the move: a full colour wash per kind "collapses in dark mode, where the
apricot surface is nearly black" — so colour stays on a 2–3px bar or a 2px ring and never becomes a
fill. The dark rendition still exists, so the reason still holds.

### Load-bearing details, easy to undo by accident

- **The verb slot is `8ch` wide.** That fixed width is what lets a verb swap animate without
  reflowing the target beside it, which keeps the roll to `transform` and `opacity` and off the
  layout path. Remove the width and the roll starts animating geometry.
- **Wires and objects share one `.canvas__stage`.** Their coordinates are the same percentages, so
  a zoom has to scale both — scale them separately and every connector slides off its endpoints.
- **`overflow-x: clip` lives on `html`, not `body`**, and `.hero` clips too. The ambient blob
  (`.hero::before`) bleeds past the edges on purpose; `body` is not the scroll container, so
  clipping it does nothing, and `overflow-x` alone leaves the vertical bleed adding real page
  height. Measured: 87px of phantom horizontal scroll, then 198px of vertical.
- **Under 760px wide the board goes portrait; under 840px tall it is dropped.** Objects are a fixed
  size at fixed coordinates, so a smaller canvas means less room, not smaller objects — it is never
  shrunk. On a phone tall enough, `hero.js` keeps **objects 0 and 1** of the scene and puts them on
  a diagonal (`PHONE_AT`). Every scene's first two are its subject and the thing it acts on, and
  every scene has a wire between them, so a phone gets a subset of the same claim and not a
  different one (ADR-129). Shorter than 840px there is no room at all: 375×667 overflows by 59px
  with the smallest board worth drawing.
- **The phone gate is written twice.** `PHONE` in `hero.js` and the `@media (max-width: 760px) and
  (min-height: 840px)` rule in `styles.css` are the same query. If they drift, the page draws into
  a hidden box or shows an empty one. Nothing checks it.
- **The pause control is built by `hero.js`, never by the markup.** Without the script nothing
  cycles, so a control for stopping it would name a state that cannot occur. Hovering the command
  still pauses; leaving does not resume a cycle the button stopped.
- **The stage zoom is two variables multiplied** — `--zw` (width) times `--zh` (height). One
  variable cannot express it: the later media query just overwrites the earlier, so a short *and*
  narrow viewport would take whichever rule came last instead of the smaller of the two.
- **Vertical spacing is `vh`-based** (`--pad-y`, `--gap-y`), and the headline is capped by
  `min(vw, vh)`. Every spacing bug this layout had was on a *short* viewport, not a narrow one,
  because only the horizontal axis was fluid. Measured across 29 viewports from 2560×1440 to
  320×568: none overflows in either axis, and every object on every scene clears every board edge
  by ≥11px. Nothing enforces that.
- **The board's `at` percentages are an even distribution, not a composition choice.** Internal gaps
  equal, edge margins at 0.7x an internal gap, computed from each object's measured rendered width.
  Pushing anchors toward the EDGES is the tempting mistake and makes it worse — it turns the spare
  half of the board into one hole instead of rhythm (ADR-129). **A type change moves the widths, so
  it moves these numbers**: they were recomputed by the same method when ADR-130 changed the body
  face, and `PHONE_AT` moved to `[[28, 28], [72, 76]]` with them. Re-measure, do not nudge.
- **`--ink-6` is a contrast floor, not a shade.** See [the palette](#the-palette): it must clear
  4.5:1 on **four** grounds, and lightening or darkening it fails several small text surfaces
  silently and at once. It has been under AA twice already — `#6E778A` at 4.32:1 on the old dark
  `--bg` (ADR-129), and the client's `--mut` would have been under on three grounds (ADR-130).
- **The palette is read from CSS, not repeated in JS.** `hero.js` takes `--mark-ink` and
  `--mark-spec` off `:root` at startup — not `--accent`, because the mark's two values invert
  between grounds and the accent's do not. `#F5B98C` used to be a literal in three places and
  `#FFE3D0` in one, which meant the token could change and the mark would keep the old hue.
- **Type is three families, and mono is not chrome.** Figtree display, Nunito Sans body, JetBrains
  Mono for a literal you would type — two consumption sites, `.cmd` and `.mono`. Before ADR-130 there
  were seven; the eyebrow, the canvas caption, the devlog dates and tags and the post-foot label all
  wore mono as decoration. Do not put mono on a label again.

Everything `hero.js` does is an enhancement. Delete it and the page still renders and still makes
its whole argument — the claim, the paragraph, the links and the status are ordinary markup,
visible by default. What is lost is the demonstration, which is why the demonstration is
`aria-hidden` and restated in static text.

### The paragraph names only fields the record HAS

> Your agent, the apps it runs beside, the secrets it needs and how it is exposed — rendered as **one
> record** and written into Git. **Argo CD** applies it and keeps it applied.

Three nouns, three real keys: `spec.apps[]`, `spec.envRequires[]`, `spec.expose`. All three are in
`agent-bundle-contracts/hermesprofile/v1alpha1/profile.schema.json` and all three are visible in the record
quoted further down the page.

**It said something else until ADR-131, and one third of it was flatly untrue.** It read *"the tools
it ships, the events it publishes and the people who approve it"*:

- **"the people who approve it" does not exist.** `maintainers/gaps.md` marks approval
  **Absent** — "No CODEOWNERS anywhere. No review policy." Line 133 marks branch protection Absent
  and says "The PR rule is client-side convention only."
- **"the tools it ships" is not a field.** `spec` is `additionalProperties: false`. `tools` appears
  in the record exactly once, as an `expose.services[].name` — a **port name**.
- **"the events it publishes" is not in the record.** It is declared in `hermes-gitops.yaml` and the
  emitter strips those blocks before rendering (`plugin/gitops_emitter/render.py`,
  `strip_extension_v3`).

That sentence shipped with ADR-69, survived ADR-127's rebuild and ADR-129's eleven-issue audit, and was
live for the whole life of the page. **Nothing could have caught it — no gate reads this directory.**
Before you write a noun into this paragraph, find the schema key it names.

## Below the hero {#below-the-hero}

**A brochure (ADR-133), built to an external specification.** Three value sections in an alternating
asymmetric grid — visual a third, copy two thirds, sides swapping each row (`.feat` /
`.feat--flip`) — then a centered close (`.sec--cta`) where the live mark mounts large over the two
destinations. The golden-record block and the six-component stack list are **gone from this page**;
mechanics belong to the docs, and each section links out instead of explaining.

The rules the sections hold to:

- **One idea per section**: a short headline, a short paragraph, one visual, one forward link.
- **The visuals are the object grammar**, hand-placed as static vignettes (`.vizboard`, `.vizmap`)
  and captioned `· illustration`. The specification's pixel-art scene is a deferred asset pass —
  swap the vignettes, keep the captions honest.
- **No maturity language, no counts, no YAML.** Alpha status lives in the docs (ADR-133); a version
  pin belongs in `versions.json`; syntax belongs behind the "How bundles work" links.
- **Feature-page claims are checked against `maintainers/gaps.md` when written.** Nothing
  marked Absent may be described as existing; partially-built areas are described at outcome level.
  Nothing re-checks any of this — the no-gate rule of this directory applies to five more pages now.

### The features area, and about

`features/` is an overview plus five pages — agent bundles, fleet canvas, communication, backups,
repository sharing — on one shell: `.pagehead`, why-it-matters, a three-step how-it-fits (`.steps`),
related-capability cards (`.fcards`), and a `.btn` into the matching wiki page. `about.html` carries
the purpose and the **Created by Factory-level** attribution, which the footer repeats on every
page. There is deliberately **no license claim** anywhere — the repository has no license file.

### One primary CTA per page

On the homepage `.btn` appears twice — hero and close — and both go to the docs. Each feature page
has exactly one, into its docs section. Everything else is a plain `.link`. **Do not add competing
buttons**: a page with two identical primary actions has one thing it wants you to do; a page with
three different ones has none.

## Cache tokens

Asset URLs carry `?v=N`. Bump it when you change an asset, or a returning visitor keeps the copy
they cached — it is the only cache control a no-build static site has.

**Bump it in all thirteen documents, not just the one you edited.** The token is written per reference,
so it drifts: the devlog's five files once sat on `?v=3` while `index.html` had reached `?v=6`,
which meant a returning reader saw the current stylesheet on the front page and a stale one on
every entry. Everything is on `?v=18`. Since ADR-132 the token also lives in `styles.css` — the
three `@font-face` `url()`s carry it — so a bump reaches fourteen files, not thirteen.

**Two checks, because the first one has a blind spot it already shipped.** It greps for tokens that
*exist*, so a reference with no token at all is invisible to it — the devlog's five masthead
`<img src="../favicon.svg">` marks were untokenized from the day they were written while this check
printed one line and said clean (ADR-129). Run both:

```bash
grep -rho --include='*.html' --include='*.css' 'v=[0-9]\+' landing | sort -u   # one line, or you have drifted
grep -rhoE --include='*.html' '(src|href)="[^"]*\.(css|js|svg|woff2)"' landing | wc -l   # 0, or an HTML reference is untokenized
grep -rhoE --include='*.css' 'url\("[^"?]*\.woff2"\)' landing | wc -l          # 0, or a font reference is untokenized
```

(`--include='*.html'` because this file's own prose quotes the old tokens.)

## Preview

```bash
make site                            # one origin: landing at /, wiki at /docs/, Nexus UI demo at /demo/
python3 -m http.server -d site 8080  # the docs links (`docs/`, relative) resolve here
xdg-open landing/index.html          # file:// still renders every page; the docs links do not resolve
```

## Provenance

Two files in the Claude Design project *Hermes GitOps Nexus specification*
(`claude.ai/design/p/32e5480a-c013-4f9e-aa71-6caab2f53b5f`) matter here, and they are not equal:

- **`Mercury Landing.dc.html` is retired.** The palette and `contour-sphere.js` came from it and
  nothing else does — no layout, no type scale, no motion, no copy. Re-importing it would not merge
  with this page; it would replace it.
- **`Canvas Object System copy copy 2.dc.html` is live.** The Fleet canvas implements it kind for
  kind, and a change there is a change this page should follow. Nothing enforces that.

`contour-sphere.js` is copied from that project and should be re-copied rather than hand-edited if
the mark changes.

## The devlog is drafted, not dictated

Every entry is sourced from a real commit body or ADR in this repository — the recovery rehearsal
(`#283`), the withdrawn Grafana embed (ADR-44), the bundle NetworkPolicy (`#284`), `versions.json`
(ADR-63). Nothing in them describes work that did not happen.

They are written **in the first person**, drafted from those commits rather than dictated, so the
voice is an approximation. Read them as a first draft to make your own. Nothing links an entry back
to the commit it came from, so a superseded ADR leaves the entry telling the old story.

The prose survived the rebuild byte-for-byte; only the page shell around it changed. One edit has
landed since: ADR-132 thinned the em-dash density in *The copy is always the one that rots* — six
dashes became ordinary punctuation, the two in "someone — me —" stayed.

## What this site does not have

No analytics, no cookies, no forms, no third-party JavaScript — and since ADR-132, **no external
requests at all**. The three faces (Figtree, Nunito Sans, JetBrains Mono) are vendored in
`landing/fonts/`: the exact latin-subset variable woff2 files Google's css2 API served this page,
83KB together, declared in `styles.css` with the unicode-ranges they were served under. Updating a
face is a manual re-download — the same hand-vendored discipline as `contour-sphere.js`. The
devlog's arrows (`←` `→`) were never in the latin range and render in system faces, as they always
did.

**It names the machinery again, and it still carries no counts.** ADR-127 dropped Prometheus, Grafana,
Alertmanager, External Secrets and Cloudflare Tunnel along with the rest of the long page; ADR-131 put
the six components back as a divided list — see [below the hero](#below-the-hero) for the rule that
list holds to.
The gaps count, the decision count, the project's age and the backup honesty the old page led with
are **still gone and should stay gone**: they are the claims that drifted, and nothing checks them.
Naming a component you can point at is a different kind of claim from counting something.

**Every claim here is still hand-maintained and nothing verifies any of it** (ADR-69). Six component
names, six descriptions, three path steps and 33 lines of copied YAML are now riding on a directory
with no gate. If you add a claim, add it knowing that.

It is deployed by `.github/workflows/wiki.yaml` as the root of the GitHub Pages artifact that
`make site` assembles (`infra/scripts/build-site.sh`): this directory at `/`, the wiki at `/docs/`,
the Nexus UI demo at `/demo/`. The docs and demo links are relative (`docs/`, `../docs/`), so they
resolve wherever that artifact is mounted — Pages serves it under `/harness-hg/`. See
[`maintainers/landing.md`](../maintainers/landing.md)
and ADR-69.
