# Nexus UI — capability inventory

Every screen, surface, and interaction the current `dashboard/src` supports, each exactly once,
classified per the kill-list rules ([#647](https://github.com/factory-level/harness-hg/issues/647)):
**required** (product contract — the rebuild ports it), **convenience** (quality-of-life — ported
when cheap, killed without ceremony otherwise), **experimental** (flag-gated, still proving
itself — ported behind its flag or parked), **cruft** (accident or superseded path — dies with
`dashboard/src`). Extracted for [#665](https://github.com/factory-level/harness-hg/issues/665);
the rebuild ([#666](https://github.com/factory-level/harness-hg/issues/666),
[#668](https://github.com/factory-level/harness-hg/issues/668)) ports only what earns it.

Source of truth for "what exists" is the code, not DESIGN.md (which predates #548). File
references name today's implementation for provenance only — the spec pages, not the old source,
are the rebuild contract.

## Views and routing

Hash-routed (`#/<view>[/<sub>]`), no router dependency; `ROUTES` is data. Two independent gates:
`flag` (capability shipped, operator overlay) and `capability` (deployment allows) — a view needs
both, and a known-but-withheld route renders the explicit "unavailable" page, never a silent
bounce. Unknown hashes fall back to fleet.

| Route | View | Tab? | Gates | Class |
|---|---|---|---|---|
| `#/fleet[/<sheetId>]` | Fleet Canvas | yes | none | required |
| `#/communication[/<source>]` | Alert Routing (id/hash deliberately unrenamed — durable deep-link contract) | yes | flag `communication-view` + capability | required |
| `#/agents[/<id>]` | Agents directory / full-page detail | yes | flag `agents-view` + capability | required |
| `#/backups` | Backups | yes | flag `backups-view` + capability | required |
| `#/system` | System (orbital mandala) — entered via the brand lockup, never a tab | no | capability only | required |
| `#/avatars` | Avatar gallery | no | flag `avatar-gallery` | required (reference surface) |
| `#/objects` | Canvas-object specimen board | no | flag `canvas-object-demo` | experimental (living spec) |
| `#/badges` | Badge specimen board | no | flag `canvas-badge-demo` | experimental (living spec) |
| `#/embed-debug` | Grafana/Argo framing probe | no | flag `embed-debug` | required (diagnostic; ADR-44) |
| `"unavailable"` | withheld-route sentinel page | — | — | required |

Deep-link semantics that must survive: sheet links fall back to the first sheet when the id died;
`#/agents/<id>` closes via `location.replace` so Back never reopens it; malformed escapes decode
to "unknown id", not a crash; cross-view links render as links only when the target view is
itself reachable (honest links).

## Chrome (present across views)

| Surface | Class | Notes |
|---|---|---|
| `.nx-root` viewport takeover (fixed inset-0, app-root z boundary) | required | the "owns the whole viewport" premise |
| Header island, center (brand lockup + tab strip) | required | corner-curl geometry is incidental |
| Brand lockup as the System doorway (#545) | required | capability-gated: non-navigating lockup when withheld |
| Tab strip (`aria-current`; single-view fallback to plain title) | required | NO health dots on tabs (#386/#387) — deliberate removal, do not regrow |
| Fleet tab dot (active-tab marker only) | convenience | |
| Header island, right (theme · gear · ops panel) | required | |
| Ops panel pill + flyout (ADR-103, #406) | required | aggregate attention; Hermes ownership sphere = ownership, never health (#554); alert click hands the fingerprint to Alert Routing |
| Theme toggle (own button, not a menu row; #391) | required | stored choice else dark; deliberately no system-preference mode |
| Settings gear menu | required | Features…, API tokens…, Reset workspace (triple-gated), Avatar codes, Hermes Classic link (legacy bridge: convenience) |
| Features modal (23 switches) | required | |
| API-tokens modal (one-time secret reveal) | required | eval publishing (ADR-57) |
| Demo badge | required | honesty marker; demo mode turns every flag on but never re-enables withheld views |
| Stale-health banner (names dead adapters) | required | poll failure keeps last overlay + raises stale |
| Corner lockup (live mark, every view but System; demo exit link) | convenience | |
| Error boundary + empty/error shell with Retry | required | |
| beforeunload guard (armed only while unsaved) | required | |
| Health poll 15s (pauses hidden tab; single in-flight) | required | |
| Workspace-bindings poll 30s (flag `repository-links`) | required when flagged | |
| Host stacking-context lift (runtime ancestor z mutation) | cruft | host workaround; a rebuild owning its page deletes the class of problem |

## Fleet Canvas

The full brief (gesture-level, with provenance) lives in the extraction working set; this table
is the inventory of record. "Miro grammar" = press semantics: shift toggles, click-selected
drags the set, click-unselected selects-and-drags, background clears-then-marquees-or-pans.

| Surface / interaction | Class | Contract highlights |
|---|---|---|
| Pan/zoom world (wheel zoom cursor-anchored, limits 0.2–2.5; dot grid 24 world units) | required | CSS-transform world, no graph library (ADR-58) |
| Middle-button pan from anywhere (every member yields) | required | cross-mode invariant; skips text inputs (middle-paste) |
| Space-hold pan in edit mode | required | |
| Zoom island (−/%/+/fit) | required | fit reserves chrome, caps zoom 1.1 ("opens calm"); auto-fit when no authored viewport |
| Fitted-view resize follower | convenience | refits only while transform still equals the last fit |
| Per-sheet viewport persistence, written silently | required | "a pan is not an edit" — no undo entry, no unsaved flip |
| Sheet tab strip (hash tabs, rename dbl-click, context menu, × delete, + add) | required | MAX_SHEETS=8 mirrors the API; cap button visible-but-disabled with the reason |
| Sheet create popover (non-modal; invariants re-checked inside the updater) | required | |
| Sheet duplicate (re-mints instance ids, remaps refs; domain refs stay shared) | required | no-aliasing contract |
| Sheet delete via shared ConfirmBar (never window.confirm; ≥1 sheet invariant) | required | |
| Sheet modes operational/concept (`statusless` rendering) | required | presentation-only withholding |
| Per-sheet source-badge filter | experimental | filter rows, never relabel |
| Per-sheet canvas remount; module-scope clipboard survives it | required | reset-on-switch contract |
| Edit toggle (canWrite-gated; three simultaneous signals) | required | viewers never see it |
| Mode-exit reset of all transient tool state | required | "a half-picked connection must not silently resume" |
| View-mode card click opens detail; edit-mode Details is an action | required | one selection = one meaning |
| Insert button (beside the rail, not in it) + InventorySidebar | required (flag `inventory-sidebar`) | 8 frozen kinds, 4 families, no search (#394/#402) |
| Configure-on-drop KindPicker (per-kind candidate sources; agent/tool not inventable) | required | four distinct empty states |
| Placement resolution (pure; one transition = one undo; refusals explicit) | required | |
| Frozen 8-kind registry (person, group, agent, agent-bundle, tool, external-tool, comm-in, comm-out) | required | the freeze is the point (#399) |
| Authorable vs plan-sourced objects (ADR-87); authored health = unknown, never green | required | |
| Retired-kind rendering (explicit card, never a base-kind fallback) | required | |
| Bundle fan (members by reference; honest "no members declared") | required | |
| Comm panels (inbound/outbound readouts) | experimental | registration wiring unfinished by design |
| Orphan card refs (dashed placeholder + "Remove reference") | required | never silently vanish (#274) |
| Sticky notes (deterministic tilt/color from id; corner resize; 100 cap) | required (flag `sticky-notes`) | "material means authorship" |
| Shapes/containers (7 variants, 6-token fill palette, rotation 15°-snap, 200 cap) | required (flag `canvas-objects`) | absence-as-default persistence (ADR-72) |
| Text labels (pointer-up mount; sm/md/lg; 3 fonts; empty commit deletes) | required (flag `canvas-objects`) | deterministic textBox estimate |
| Shapes rail pop-out (geometry off the semantic palette; #560) | required (placement decision) | |
| Canvas title on the paper | convenience | |
| Operator connections (dashed; instance-keyed endpoints; dangling don't render) | required (flag `connections`) | |
| Two creation gestures, one commit (connect-tool + port-drag live wire) | required | abandoned wire writes nothing |
| Connect ports on cards, shapes, texts (round ≠ square resize grips) | required | keyboard-accessible |
| Endpoint re-attach; edge fat-path selection; label editing | required | |
| Typed connections (kind by endpoint pair; dash styling) | experimental (flag `typed-connections`) | |
| Arrowheads none/start/end/both ("end" stored as absence) | required | |
| Edge geometry (box-clipped rays, open chevrons, label spot solver, human-card pads) | required | "pencil, not plumbing" |
| Plan-group containment fields (participation per sheet; ADR-144) | required | |
| Plan-group collapse (starts collapsed; server rollup over ALL members; view state never persisted) | required (flag `group-collapse`) | collapsing never hides a red card |
| Canvas-native groups (hulls; members-not-group selection; collapse) | experimental (flag `canvas-groups`) | membership-recognition rule is a keeper |
| Multiplicity ×N chip / stack / expanded chips (derived, never persisted) | experimental (flag `canvas-multiplicity`) | |
| Unified prefixed-key selection Set (pure, DOM-free) | required | backbone |
| Miro selection grammar + marquee (approximate footprints) | required (flag `canvas-multiselect`) | "a marquee is a gesture, not a measurement" |
| Select-all, arrow nudge (1px / shift 24px, coalesced) | required | |
| Multi-drag (one delta, one coalesced edit per gesture) | required | |
| Grid snap (Alt bypass) | experimental (flag `canvas-layout-aids`) | |
| Delete = one sheet edit; cards are reference removals; edges cascade | required | deployed state never touched |
| Copy/paste/duplicate (session clipboard, not OS; fresh ids; 24px offset) | required | connections are not clipboard material |
| Escape (one-key exit from everything transient) | required | |
| Undo/redo: bounded snapshot stack (50), coalescing keys, `adopt` clears both stacks, `silent` | required | exact rules port verbatim |
| Visible history buttons + ⌘Z/⇧⌘Z/⌘Y; undo marks unsaved | required | |
| One ContextMenu component (pre-filtered items; "a menu never decides capability") | required | |
| Contextual edit bar (#398): one bar, closed action union, member nouns, per-selection segments | required | fleet+editing gated (cross-view mutation guard) |
| Docked inspector (detail aside, passive) | experimental (flag `edit-inspector`) | |
| Hover surfaces: single-open registry, 260ms grace; status popover renders server rows verbatim | required | browser never derives a level |
| Badge popovers (gh/comm/iam/alert + face stack); "none" is a rendered answer | required | |
| Card action links (capped; "+N" is a real link) | required | |
| Save flow: explicit save; save-state machine; revision CAS + conflict bar; adoptServerDoc resets every pointer | required | #423 grammar |
| Reset workspace (DELETE → fresh default; triple-gated + confirm) | required | |
| Toast (2200ms) | convenience | |
| Placing-cursor mode (pointer-events off world children) | required | |
| Attached-repo badge rows (display-only; never canvas nodes/edges — #549) | required | the demotion is the decision |
| Legacy host fallbacks (positions prop, per-array deletes, conn × button) | cruft | fold demos onto the sheet funnel or freeze |

## Cards (canvas objects)

| Surface | Class | Contract |
|---|---|---|
| Registered footprints: agent 264×250 · tool/app 244×76 · person 84×84 · group card 264×76 · bundle fan 268×190 · comm panel 300×208 · note 180×110 · text estimated | required | the only sizes selection/hulls/fit/marquee use |
| Three-channel grammar (ADR-58): shape=kind, color=ownership (`--own`), material=authorship | required | color never means status; healthy is quiet grey |
| Status bead (top-right overhang; absent when statusless/kind-unsupported) | required | dots on agents+tools only (#425) |
| Health levels healthy/degraded/unhealthy/unknown; unknown = dashed ring, never healthy | required | server-computed only |
| Badges: 28px bottom-edge fixtures, paper-knockout halo; four domains + people face-stack | required | canvas-level flags decide which render; bell earned twice |
| Avatar overhang top-left 112px; fixed-height head row; rings fallback; still twins off-canvas | required | canvas is the only animating surface (ADR-146); reduced-motion forces still |
| Unresolved state (class + reason replacing health) | required | |

## Alert Routing

| Surface | Class | Contract |
|---|---|---|
| Fixed page shell (head static, one scroll pane) + read-only pill | required | #412; the page is a projection |
| Provenance strip (quiet when ok, chips only for non-ok sources) + DEMO badge | required | #414 |
| Dossier tabs Alarms/Events (severity tone vs routing blue; words carry state) | required | #564/#579 color contract |
| Dossier orientation sweep on switch | convenience | never a fake loading state |
| Firing alarms: truthful counts (`N+`), partial-read honesty, both-evaluators all-clear copy | required | #579/#618 |
| Business alerts full rows; platform alerts collapse to a summary row expanding in place | required | #407; exceptions-first |
| Alert row (direction glyph, tags, ownership sphere) → AlertDrawer | required | |
| AlertDrawer: rule evidence, named source engine, explicit "No longer observed" gone-state | required | fingerprint identity = full label set + since |
| Ops-panel → drawer handoff (deterministic on fresh navigation) | required | #406 |
| Recent alarm activity: window pills = refetch, pressed shows displayed window | required | #551 pill-truth |
| ALL ALARMS behind explicit expand, owner-bucketed | required | "existence is not attention" |
| Owner buckets: Hermes control plane → bundles → Unbundled; empty vanish; section slice decides | required | #564/#567 |
| Source row (one renderer both planes; status from FULL edge set, destinations sliced) | required | ADR-110 full-vs-sliced split |
| Status pill ladder server-ordered; "Declared"/no-traffic is its own pill | required | #424 |
| Destination chips with resolved agent Faces; unresolved stays text | required | #550 |
| Patch-bay switchboard (inbound zone · router spine · outbound zone, drawn cables; the one graph drill-down, subject = producer or `in:<id>` webhook) | required (behavior) | cable geometry from fixed-row index math (ADR 0180) |
| Outbound rows (delivery semantics, live detail lines, last fan-out outcome chips from `latestExecution`) | required | |
| ProfileTag click-through only when resolvable AND agents view open | required | honest links |
| Recent activity (pulse micro-chart + receipts grouped by correlation id + truthful-window label + 1h/24h/7d selector) | required | #551, ADR-114 |
| History row → same switchboard detail (never a duplicate inline view) | required | |
| Reserved platform events (static, "Reserved" pill) | required (contract display) | |
| Inbound webhook rows (event, accepts, Signed pill, honest empty copy) — each links to its `in:<id>` switchboard | required | |

## Backups

| Surface | Class | Contract |
|---|---|---|
| Fixed shell + verdict line (ONE colored thesis sentence) + fold-healthy toggle | required | no banner strip, no second summary |
| Target filter (substring, "N of M") | convenience | |
| Buckets: control plane always leads (explicit per-component — no blanket "Platform backup" row, #582) → bundles → Independent; canvas groups never mint shelves (ADR-123) | required | server attribution wins |
| Shelf header (worst-of-children dot; aggregation never derivation; empty=unknown; collapsed by default) | required | |
| Routine row (six-cell grid; dot+name, cron prose, last success + runs strip, ONE status word, chevron; whole row is the control) | required | ADR-52 split moved to the drawer |
| Two-axis pills: SCHEDULE (healthy/running/late/disabled/never/failed/archived/declarative/ephemeral) × ARTIFACT (unmeasured/not-restore-proven/restorable/rebuilt-from-git/not-backed-up-by-design) | required | two different facts, never merged; `available` never renders as success |
| Cron prose (four known shapes; verbatim otherwise, raw in drawer) | required | never guess a schedule |
| Destination classes in durability terms; unknown verbatim | required | #418 |
| Runs strip (one dot per retained Job; long window delegated to Grafana) | convenience | |
| Uncovered components inside their bundle's shelf ("No backup" pill + reason) | required | the bundle is the unit of protection |
| RoutineDrawer (facts, both pills explained, protects, restore command + copy, gone-state) | required | resolved against the current doc each render |
| 30s poll + footer sentence | required / convenience | |
| No Grafana embed on Backups | required | #553; catalogued backup panels stay off-view |

## System

| Surface | Class | Contract |
|---|---|---|
| Header + one health headline; headline is a button spotlighting flagged arcs when attention exists | required | |
| Orbital mandala (two tiers: 4 core + 6 outer capabilities; arcs are hit targets; siblings dim) | required (thesis) | geometry mechanism incidental; entry stagger convenience |
| Capability vocabulary: 10 stable product responsibilities, never vendor names; every workload in exactly one slice; unplaced workloads surface explicitly | required | #545/#558 rule 3 |
| Health dot in arc label only when NOT healthy | required | quiet state is the point |
| Nucleus HermesMarkLive (identity in aria-label) | required | brand signature |
| CapabilityPanel = the shared right drawer (never bespoke; #574) with member rows + live role enrichment | required | |
| Agent-runtime extra (installed-fleet face fan, uptime, published workloads) | convenience | |
| Monitoring extra: PanelGrid surface=system under "CONTROL PLANE" rule; renders nothing unless configured | required | evidence on demand |
| People & Groups read-only roster (declared-by lines; persona repo named as the authoring path) | required | #573/#584 — no Add/Create ever; the hardcoded-healthy capability level is a known accident |
| Provenance disclosure (`<details>`) | convenience | |

## Agents

| Surface | Class | Contract |
|---|---|---|
| Directory: filter chips (health, bundle; "N of M" while filtering), column header row | required / convenience | |
| Bundle group sections (server rollups `bundle:<id>` / `bucket:unbundled`; browser never computes an aggregate) | required | #565/#567 |
| Agent row (still avatar — GIFs animate only on canvas; title; deploy cell; badges; status; chevron; five cells match five tracks) | required | the row-wrap defect class must not recur |
| Attachment + communication badges (same Badge + same joins as canvas cards — can never disagree) | required | #552/#549 |
| "repos unknown" cell when flag off (never an empty dash) | required | unreadable reads as unknown |
| Empty states: none-contributed vs none-matching | required | |
| Detail: one component, three postures (aside / page / passive) | required | design-12 |
| Detail header, fact grid (absence stated by unwired adapters), bundle line | required | |
| Tabs: Instances / Metrics / Repositories / Communication / Docs & Runbooks / Uptime / Evals — lazy per-tab fetches | required | "a tab nobody opened should cost no request" |
| Instances tab (per-source reasons; server-built Argo links) | required | client-assembled URLs were an identity bug |
| Repositories: mounted truth first, declared claims second; flag-off ≠ none | required | #361 |
| Uptime MissingCard ("Unknown is not the same as healthy") | required | |
| Evals tab (verdict row + per-run evidence) | required | #280 |
| Link sanitizers (https-only for authored; NEXUS009 thrice-asserted) | required | |
| Canvas-facts section riding the aside | experimental | flag-tied |

## Embeds and diagnostics

| Surface | Class | Contract |
|---|---|---|
| Closed size presets (compact/standard/wide/tall); nothing passes pixels | required | design-14 |
| PanelFrame: same-box fills (not-configured / failed / blocked / iframe); "Open in Grafana" on every panel including failures | required | never a dead end |
| grafanaBlocked signal + EmbedHealthBanner (one signal shared everywhere) | required | #415/C2 |
| PanelGrid (loading/not-configured prose; `contextual` exclusion) | required | the ContextHost server flag is cruft |
| **Plane badge/grouping wherever panels embed** (Control Plane vs Workloads, from the plane label) | required — NEW in the rebuild | [#706](https://github.com/factory-level/harness-hg/issues/706), ADR 0166 |
| Embed-debug probe (uid select, kiosk iframe, Argo blank-is-correct, decision list) | required | the only view allowed to string-build URLs |
| Avatar gallery (animated tiles, copy `display.icon` code, reduced-motion per-tile play) | required | the ONE place animation is the content |

## Feature flags (24)

Default-on today: `canvas-objects`, `canvas-multiselect`, `avatar-gallery`. All flags read true
in demo. The rebuild keeps the flag ids and the two-gate model verbatim (they are the operator
overlay's contract, ADR-43); per-flag surface classifications are already embedded in the tables
above — no flag is itself cruft.

## Explicitly killed (do not port)

- Legacy host fallback props and per-array delete paths on the canvas (demo hosts fold onto the
  sheet funnel or freeze with `dashboard/src`).
- The host stacking-context lift and every `:has()` z-lift workaround (portals + owned page
  dissolve the problem class).
- Legacy CSS families with no emitting markup (`.nx-comm-summary/-edge/...`, `.nx-agents-row/...`),
  duplicate `.nx-popover`/`.nx-embed-debug` declaration blocks.
- `sheet:*` health rollups (served, zero readers) — dropped from the overlay unless the hierarchy
  work ([#677](https://github.com/factory-level/harness-hg/issues/677)) finds a consumer.
- The `contextual` panel flag (its ContextHost is gone).
- Per-tab health dots and the Backups Grafana footer (removed deliberately; listed so they are
  not regrown from old screenshots).
