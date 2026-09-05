# nexus-ui — as built

The rebuilt Nexus frontend's actual present state (the desired state is
[`../design/nexus-ui.md`](../design/nexus-ui.md) + its spec pages; the diff between the two is
the gap list). Updated per PR through the Phase-3 rebuild.

## What exists

- A bun workspace at `nexus-ui/` with its own CI job (typecheck → tests → theme drift → dist
  byte-compare → size budget → chart-sync check). **It IS the product's frontend**: the
  committed dist at `control-plane/nexus/dist` builds from here; `dashboard/` was deleted at
  the #732 flip and the installable unit lives at `control-plane/nexus/`.
- **Theme**: `design/tokens.json` → generated, drift-checked `src/theme/theme.css`. `.nx-root`
  scoped, dark as a full token-for-token override (default dark). The `astryxBridge` section
  maps Astryx's theme vars (`--color-*`, `--font-family-*`, `--radius-container`,
  `--shadow-*`) onto the Nexus tokens as `var()` references — one declaration serves both
  themes, and the unlayered `.nx-root` rule beats theme-neutral's `@layer`ed defaults, so
  Astryx components wear the warm-paper palette. (Before the chrome pass this bridge did not
  exist and Astryx rendered stock-neutral.) The dark edit-accent exists here and nowhere in
  the old UI.
- **Type, fonts, icons** (the 2026-09-01 design pass): `tokens.json` carries the brand faces
  (`fonts`: three latin-subset variable woff2 rendered as `@font-face` over the ADR-105
  asset route — the #732 flip had dropped the old dashboard's rules and its gate, so the
  rebuilt UI rendered in `system-ui` until this pass; `tests/fonts.test.ts` is the gate
  again, and demo mode still falls back per glyph because the route needs a gitops
  repoPath) and the named steps every view composes (`--fs-2xs…4xl`, `--lh-*`, `--track-*`,
  `--radius-sm/md/lg/pill`, `--sp-1…6`, `--nx-header-h`, plus `--font-size-base` bridged so
  Astryx controls share the 13px base). Reduced motion collapses the motion tokens
  themselves in the generated theme. `primitives/Icon.tsx` is the one glyph primitive
  (lucide, a closed meaning vocabulary, one box and stroke); no unicode glyph serves as UI.
  `primitives.css` carries the shared display ramp, eyebrow, view header, state line, chip,
  field, island, shell, back link and facts classes, and a global `:focus-visible` ring —
  the per-view copies (two identical back links, two identical `dt` eyebrows, the
  `.nx-bk-fold` twin of `.nx-chip`, five island shells with three radii) are gone. The
  second pass then finished the lists and the drawer: the Agents directory names its
  columns with an eyebrow header row over fixed trailing tracks (identity takes the slack;
  deployment, attachments and health line up column to column) and wears the shared `Face`
  tile instead of a private monogram; the Backups routine rows sit on the same fixed-track
  grammar; the System view's unplaced workloads are a warning `Banner` under the mandala
  rather than an orphan amber line, and the outer ring's labels anchor outside their ring
  (`lx`/`ly` on the slice, the arc midpoints unchanged) so the two rings' pills never meet
  on the diagonals; a panel's frame box says "Loading panel…" under the iframe until it
  paints; the drawer's Astryx header and its body share one inline edge, and the agent
  drawer opens with an eyebrow-keyed facts list and an Astryx `TabList` for its sections;
  connector strokes (`--marker`) are darker on both grounds. Known remainder: view CSS
  still carries literal paddings off the spacing ramp in places, and a group frame's label
  can still meet a card an operator places under it (positions are data).
- **Build**: Vite 7 IIFE with React resolved from the host SDK global through
  `src/shims/` (jsx-runtime + createPortal reimplemented; createRoot throws). Astryx consumed
  precompiled. Plugin id registered: `hermes-gitops` (renames at the #668 re-home).
- **Primitives** (`src/primitives/`): Drawer (native `<dialog>`, top layer), HoverPopover
  (single-open + 260ms grace), Flyout, health grammar (HealthDot/StatusPill/StatusWord/
  OwnershipSphere), identity marks (AgentAvatar with reduced-motion `-still` swap and
  fallback-instead-of-art on load failure; RingsMark; Face monogram tile with `abbrOf` as the
  one monogram home), HermesMark (carried brand algorithm), Astryx passthrough barrel; style
  gates as bun tests (no z literals outside `src/layers.ts`, positioning confined to
  primitives, no palette literals outside the theme, no `!important`, no module-scope state).
- **Shell** (`src/app/`): DataStore (demo-on-503 only, 15s health poll w/ hidden-tab pause,
  stale banner), ChromeStore (route/theme/one-overlay), data-driven ROUTES with the two gates
  and the unavailable sentinel, ChromeRegion (islands + brand/corner lockups stay custom
  signature; the controls are Astryx since the chrome pass — view tabs are a nav-pattern
  TabList, DEMO DATA a warning Badge, theme/settings are IconButton + a data-mode
  DropdownMenu, the ops pill's surface a render-prop Popover with Item alert rows, the stale
  banner a Banner; the error/withheld/unfilled shells are EmptyState + Button), Astryx
  LayerProvider as the overlay/toast region (an empty toast viewport is hidden by a
  primitives.css rule — UA popover chrome painted it as a phantom square), `#/primitives`
  specimen board, screenshot-pair capture (`browser/capture.ts` → `design/review/`).
  The workspace chrome is Astryx too: bottombar Toolbar (sheet TabList / ToggleButton tool
  rail + ToggleButtonGroup / ButtonGroup undo-redo / primary Save with clickAction spinner),
  Banner conflict bar, pointer-anchored ContextMenu on the canvas (select-under-pointer kept
  in the canvas's own contextmenu handler; view mode keeps the browser menu via isDisabled),
  Toolbar ContextualBar, Item rows in the InsertPanel. `primitives/Flyout` is deleted; the
  acceptance suite addresses the settings menu by `[role="menu"]`, not a bespoke class.
  `browser/serve.ts` also got its stale pre-flip DIST path fixed in the canvas-grammar pass.
  The Fleet Canvas UX pass then closed the audit's four findings: the card drawer renders a
  real detail body (`workspace/CardDetail.tsx` — still avatar art with rings/monogram
  fallback, kind in its hue, StatusPill for deployed kinds only, description, bundle
  membership, declared id; nothing fabricated — the wire scrubs links); the connect tool
  shows its state (pending endpoint wears the edit-accent target ring via `[data-pending]`,
  a dashed edit-accent live wire follows the pointer, Escape cancels through the existing
  resetSession); armed tools set a crosshair and placement tools claim the press even over
  cards (`.nx-canvas-placing[-through]`, the carried old rule); the Insert library FLOATS
  over the canvas (`.nx-pin-inline-end` in primitives.css) instead of reflowing the world
  under the pointer, and the ContextualBar hides while a drawing tool is armed; auto-fit
  includes every positioned member (`contentBoxes` in objects.ts, unit-tested), context-menu
  Paste lands at the right-click's world point (`paste(..., at)`), and an exact-duplicate
  connection is refused (reverse direction stays legal).
  The BADGE layer then returned (ADR-58 §badges): per-card 28px domain fixtures clipped to
  the card's bottom edge with paper-halo knockout (`workspace/CardBadges.tsx` +
  `workspace/badges.ts` pure joins, ported verbatim from the retired dashboard's
  `producerKeyOf`/`routesFor`/`bindingsFor`), gated by the four surviving flags —
  Repositories (`repository-links`: authored sanitized `links` merged with `/nexus/workspaces`
  bindings wearing the mount tri-state, tokenized ok/warn/mut), Communication
  (`communication-view`: the comm doc's edges via the lifted shared `stores/comm.ts` —
  Alert Routing now consumes the same store), IAM (`iam-badge`: published hostnames +
  `accessors[]` people with Face stacks, plus the carried "Access group membership is not
  reported here yet" note), and the Alerting bell (`alerting-badge`: alarm-class routes ∧
  Grafana source configured — it stays neutral and its bubble says firing state is not
  readable per card; the wire deliberately serves no per-card alert join). A domain with no
  data source or no rows is ABSENT, never an empty circle. The status bead gained its hover
  surface back (StatusPill + health summary through HoverPopover). Fixing that exposed two
  latent `HoverPopover` defects: it discarded Astryx's anchor ref (every hover surface
  positioned at the viewport origin) and inherited Popover's autofocus + close button (a
  hover surface is passive now). `PlanComponent` widened to the wire's `bind`/`accessors`/
  `links`/`instances`; the demo comm fixture now speaks the wire's composite producer
  grammar and boolean `alarmClass` (the string was a fixture-side fiction).
  A zoom island (top-start of the canvas: zoom in/out about the centre + fit-to-content,
  thin IconButtons over the tested `zoomAbout`/`fitTransform`/`contentBoxes`) gives the
  wheel gestures visible twins, and the Insert panel's candidates are draggable tiles
  (avatar art + kind sub, pointer-based drag with a kind-hued ghost chip): the drop point
  is the placement and the placed card becomes the selection (`placeCard` returns its key
  now); a release over floating chrome or off-board writes nothing, and click stays as the
  accessible place-at-centre fallback (which also selects). Sheets are creatable from the
  strip (a hanging ghost `+` opens an inline name input; Enter commits through the store's
  `addSheet` - slugified DNS-label id deduped with a numeric suffix, one undo step, refused
  at the server's 8-sheet cap with the cap stated; the empty commit mints nothing) and the
  bottombar centre is the old rail grammar on Astryx behavior: an island of icon-over-label
  tool buttons (Insert across a divider from Select/Note/Shape/Text/Connect - different
  acts, shared region) with per-tool tooltips, entered by a pencil "Edit board" copper CTA
  that becomes a check "Done" while editing. Sheet delete is built: a trash pill beside `+`
  in the strip while editing, a `ConfirmBar` (warning Banner + Keep/Delete pair, never
  `window.confirm`) asks first, the hash lands on the previous tab before the sheet goes, and
  the last sheet keeps the pill disabled with the reason — the server refuses an empty sheet
  list. Deleting is one undo step. Sheet rename/duplicate/reorder remain unbuilt.
  The footer bar is GONE - the docked-chrome pass restored the old board's placement
  wholesale: every control is canvas-pinned chrome (zoom island top-start, the sheets PLATE
  bottom-start - a bounded max(60vw,720px) surface nesting into the canvas corner, pill
  tabs; the hanging-tab experiment is retired - and the control island bottom-centre
  carrying the Edit CTA/rail, undo/redo and the #423 save word). A floating island's height
  change between modes reflows nothing, so entering edit no longer moves the canvas or the
  bar; the canvas takes the full view height.
  The overlap pass then made the layers coexist: auto-fit fits PAINTED boxes (avatar
  overhang, badge drop, person label - `contentBoxes` pads per kind), the demo sheet is
  spaced so no member rests on another, the Insert overlay covers only its own height, and
  the bottombar reserves the corner lockup's lane (closing the known save-word overlap
  defect).
  The design pass then tightened the objects: the agent footprint is 264×204 (was 250 -
  a void sat between description and footer), the rings fallback hangs off the card's
  corner in a paper disc exactly where the avatar overhangs (one anchor for the identity
  slot), the badge strip is labelled pills (domain icon + count) rather than bare glyphs,
  comm panels are 300×148, the sticky paper is retuned per theme (deeper in dark, more
  saturated in light so it no longer melts into the cream), the empty-canvas context menu
  explains its disabled Paste ("Nothing copied yet"), and the live corner mark keeps only
  the canvas's corner - on the list views it sat over rows. The settings menu no longer
  carries the "Features… arrives with its Wave-3 PR" placeholder; the ops pill reads
  "N firing"; the shell's loading state says so instead of painting nothing.

- **Backups view** (`src/app/backups/`): pure model (shelves with control-plane-explicit
  leading, worst-of aggregation with empty=unknown, the two-pill vocabularies, three-form
  verdict, cron-prose-never-guesses, durability-termed destinations — 13 fixture tests),
  fixed-shell view with fold/filter, uncovered rows inside their bundle's shelf, and the
  routine Drawer resolved against the current doc with a gone-state; 30s poll keeping
  last-good on failure.

- **Agents view** (`src/app/agents/`): filter chips, bundle groups on SERVED rollups (the
  browser never folds levels — 6 fixture tests), five-cell rows with still faces + monogram
  fallback and honest "repos unknown" cells, detail in two postures (row drawer + full page
  closing via `location.replace`) with truthful per-tab absence states. Missing vs the old
  view: real instance rows, badges with the shared joins, Metrics/Uptime/Evals tabs.

- **Alert Routing view** (`src/app/communication/`): two dossiers under the #579 color
  contract, full-label-set alert fingerprints, business-full/platform-collapsed partitioning
  with the dead-man excluded, truthful `N+` counts, owner buckets (slice-decided, empty
  vanish), full-vs-sliced source rows (ADR-110), the ops-pill handoff consuming the
  ChromeStore payload, alert-evidence drawer with gone-state, reserved events + inbound
  webhooks (each row linking to its `in:<id>` board), and the patch-bay switchboard
  drill-down (ADR 0180): three zones with drawn cables (in-flow SVG cells, fixed-row index
  geometry), the router spine's dlq/pending counters and last-fan-out split from the served
  `latestExecution`, and the RECENT ACTIVITY strip consuming
  `/nexus/communication/history` — delivery-pulse bars, correlation-grouped receipts
  labeled with the served `truthfulWindow`, a 1h/24h/7d window selector. The history
  payload's `alertHistory` section is served and NOT rendered (roadmap) — 27 fixture
  tests.

- **System view** (`src/app/system/`): the carried 10-capability registry (hues moved into
  design/tokens.json as `--cap-*`; membership uniqueness + vendor-free labels pinned by
  tests), pure polar layout (labels placed by the same math as the arcs — no glyph-count
  estimates), attention-headline spotlight, capability drawer on the shared Drawer, read-only
  People & Groups naming the persona repo as the authoring path, explicit unplaced-workloads
  note. NOT built: the monitoring panels section (arrives with the embeds screen), live role
  enrichment, the provenance disclosure.

- **Workspace view, part 1** (`src/app/workspace/`, `src/stores/document.ts`): the
  DocumentStore with the carried undo reducer (coalescing keys, adopt-clears-both-stacks,
  silent, 50-cap — 6 fixture tests), the #423 save-state machine (events, mid-flight edits),
  revision-CAS save with 409→conflict, the wire boundary (`src/stores/wire.ts`: the store
  models cards flat and wires by selection key; `fromWire` on adopt and `toWire` on save
  translate to the server's persisted spelling — nested card `position`, `shape`/`color`,
  a required text `size`, bare card keys on wire endpoints — and pass everything the
  canvas does not draw through untouched; pinned by a fixture both this suite and the
  plugin-API suite read), pure geometry (footprints, cursor-anchored zoom, calm
  fit, coordinate clamp — 4 tests), the pan/zoom world with dot grid, plan-sourced cards with
  beads and dashed orphan placeholders, per-sheet remount, silent debounced viewport
  persistence, sheet tabs. Part 2 added: the SessionStore
  (selection single-homed, resetSession on mode-exit/sheet-switch), the pure Miro press
  grammar + marquee + nudges + delete-as-reference-removal (8 fixture tests), one coalesced
  edit per drag gesture (browser-proven: exact move, one-step undo restore), the edit/undo/
  save toolbar and the conflict bar (Load theirs / Overwrite). Part 3 added: the whiteboard
  set - sticky notes (deterministic id-derived tilt/paper, 2000-char editor, dbl-click OR
  placement-editor on pointer UP - the carried #576 blur lesson, re-learned via the browser
  smoke), shapes (rect/ellipse/diamond/pill, absence-as-default variant), text labels (empty
  commit mints nothing), operator connections (click-A-then-B, instance-keyed endpoints,
  self-loop refused, dangling refs unrendered, delete cascades - no orphan wires), the tool
  rail, and caps mirroring the server (notes 100, objects 200) - 8 more fixture tests +
  a full whiteboard browser smoke. Part 4 added: the insert flow
  (semantic palette of the frozen 8 kinds by family; plan-sourced kinds placeable by
  reference only with honest empty copy; repeats mint instance keys), the contextual bar
  (one bar, member nouns, Copy/Duplicate/Remove-from-sheet with the nothing-deployed-is-
  touched tooltip), a minimal pointer context menu (select-under-pointer, pre-filtered,
  Paste on background), and the session clipboard (connections are not clipboard material;
  paste mints + offsets + selects) - 4 more fixture tests + an insert/bar browser smoke.
  The flag-gated extras are parked to their own issue (port-drag wire, rotate/fill
  pickers, typed connections, groups, multiplicity, inspector, sheet-management UI, specimens,
  resize follower). An edit-tools correctness pass (2026-09-02) then hardened the grammar:
  placement disarms to Select and selects what it made (an armed tool no longer mints an
  object per click); the note editor commits on Escape (typed text was silently discarded)
  and presses inside it are text selection, not moves; existing text labels edit in place on
  double-click (clearing deletes - `setTextText`); unchanged text commits are no-ops, not
  edits; insert click-to-place lands at the true viewport centre (was a fixed world point,
  frequently off-screen); the Insert panel and the drawing tools are mutually exclusive;
  ⌘Z/⇧⌘Z/⌘Y drive history (the store no-ops on empty stacks), selections prune against the
  post-undo document (`pruneSelection`), and one sequence-carrying `mintId` replaces seven
  inline mints (same-millisecond ids collided); saves are honest (demo reads "Local only
  (demo)" instead of a dead Save button, failures log and ride the savestate title,
  409 detection reads a structured status field - `httpStatusOf` - instead of substring
  matching); connections select and delete through an invisible 14px hit twin (empty-base
  wire "moves" and `conn:` endpoints refused) and wires paint over region fills (DOM order,
  same z token); the marquee hits every positioned kind (`memberBoxes`); the canvas claims
  wheel with a native non-passive listener (React's passive delegation made preventDefault a
  no-op - page pinch-zoom fought the canvas); gestures capture the pointer, so drags survive
  floating chrome and the canvas edge; space-hold pans in edit mode; the shape tool gained
  its four-variant rail picker (rect/ellipse/diamond/pill); and the sheet-name input commits
  on Enter only (blur cancels - it used to mint-and-navigate). Resize followed the pass out
  of the parked set: a selected note or shape carries a corner grip (`resizeMember`, one
  coalesced edit per gesture, 60x40 floor, the note's `w`/`h` finally editable) and a single
  selected text label gets its S/M/L size steps in the ContextualBar (`setTextSize` - "md"
  removes the field, absence-as-default); edge centres read the resized note box. Rotate and
  fill pickers stay parked. Twenty-seven more fixture tests and five fixture-gated edit-mode
  browser probes cover the pass. The canvas-grammar restoration brought the retired board's ADR-58 object
  grammar onto these parts' markup: per-kind silhouettes on the registered footprints (agent
  portrait card with the overhanging animated avatar / rings fallback, name, 3-line clamped
  description; tool/application/group plaques with avatar-or-monogram tiles; the chamfered
  external-tool plaque via clip-path + a `--dsh` drop-shadow token; the person circle with its
  label outside the hit area; the agent-bundle fanned hand fed by the served `bundles` overlay
  with an honest no-members ghost; tinted directional comm panels), colour by KIND (the
  Kind-Is-Hue rule — `--kindhue` set once per kind class from the theme's `--kind-*` tokens;
  the old ownership ternary was deliberately not ported), material by authorship (sticky paper
  italic, dashed = provisional/operator-authored, the quieter 55% dot grid, pencil `--marker`
  edges at dasharray 5 5), and the hover-lift/focus-ring/unresolved-drops-its-shadow finish.
  Stored shape `fill` palette tokens now actually project onto `--shp-*` (they were stored and
  never read). Two latent defects fixed on the way: `.nx-world` had zero extent so the edge
  layer's svg viewport disabled ALL connection rendering, and `browser/serve.ts` still served
  the pre-flip gitignored `nexus-ui/dist`, so the acceptance matrix was testing a stale bundle.
  Evidence: `design/review/canvas-grammar-{old,new}-{dark,light}.png`.

- **Panels + PlaneBadge** (`src/app/panels/`, #706): PanelGrid/PanelFrame on server-built
  URLs with closed size presets, same-box placeholders, ever-present "Open in Grafana", the
  shared blocked signal — and the plane badge on every frame, rendered from the plane the
  plugin API now serves per panel (derived server-side from the platform's promised uids;
  pytest-pinned). Wired into System and the agent detail's Metrics tab.

- **Utility routes**: the avatar gallery (real library listing, reduced-motion inverted into
  per-tile play — reactive environment read, copy `display.icon` codes) and the embed-debug
  framing probe (the one sanctioned URL-builder; Argo blank-is-correct; the reading-a-blank
  decision list).

## What does not exist yet

The flag-gated canvas extras and small conveniences parked in #728; the Alert Routing
`alertHistory` rendering; Features/API-tokens modals; sheet rename, duplicate and
reorder (delete exists); the plugin-id rename (#672 → dated follow-up #745, blocked on fleet convergence); the
live-factory `hg nexus prove` full-matrix run and the SSO/plane deploy proofs (#703 — the
fleet still runs the pre-flip unit until it converges on post-refactor main).

## Known defects

- The server's wider whiteboard vocabulary round-trips but has no drawing here: the
  `arrow`/`brace-l`/`brace-r` shape variants render as plain rectangles, shape `rotation`
  and text `font` are carried but not applied (`workspace.css` styles only rect, ellipse,
  diamond and pill), and a sheet's `objects`, `groups` and `settings` are preserved on save
  without being rendered.
- A wire cannot anchor on a note — the server's endpoint grammar is a card key or a
  `shape:`/`text:` member — so the connect tool refuses a note terminal at authoring; a
  document that already holds one (written by an older UI) still fails validation on save.
- If the initial workspace GET fails with anything but a 503, the store keeps the demo
  document with Save live; the stamped header plus the revision CAS turn that into a 409,
  not a corruption, but it is still a stale-document trap.
- The bottom-edge Banners (the sheet-delete `ConfirmBar`, the workspace conflict banner)
  render under the corner brand mark, which overlaps the trailing button's label at
  narrower viewports (seen live on the factory at ~1530px wide); the buttons still work.
- The ops flyout's alert rows use name+namespace as identity (the old UI's full-label-set
  fingerprint discipline arrives with the Alert Routing screen).
- `HermesMarkLive` runs its rAF loop regardless of `prefers-reduced-motion` (same as the old
  UI); the reactive environment read is TODO with the chrome polish.
