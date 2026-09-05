# Nexus UI — component hierarchy

The structural decomposition the rebuild composes into, decided before any screen is rebuilt
([#677](https://github.com/factory-level/harness-hg/issues/677)). Introduced by ADR 0169. This
page is the build contract for [#666](https://github.com/factory-level/harness-hg/issues/666)
and [#668](https://github.com/factory-level/harness-hg/issues/668): every component has exactly
one parent context, state ownership is decided per node, every overlay-capable node takes its
layer from here, and nothing reaches around the tree. **No migration work starts before this
page is signed off.**

Names follow the canonical register (ADR 0158): the communication view is **Alert Routing**
(route id `communication` stays — durable deep links), things that run are **agent profiles**,
the drawing surface is the **Fleet Canvas** inside the **Workspace** view. Component names below
are the rebuild's real exported names.

## The tree

Four levels: screen → region → section → component. Leaves compose from the
[design-system catalog](design-system.md) primitives; a screen needing a new primitive adds it to
`primitives/` first. Every `required` item in the [inventory](inventory.md) maps to exactly one
node; the per-screen tables below carry the mapping.

```
NexusRoot                          plugin registration · error boundary · SDK seam
└─ AppShell                        .nx-root · theme attribute · store provider
   ├─ ChromeRegion
   │  ├─ HeaderCenter              BrandLockup(→ System) · TabStrip · DemoBadge
   │  ├─ HeaderRight               ThemeToggle · SettingsMenu · OpsPill
   │  ├─ StaleBanner
   │  └─ CornerLockup              every view except System
   ├─ ViewRegion                   one mounted view, from RouteState
   │  ├─ WorkspaceView             (#/fleet) — the default surface
   │  ├─ AlertRoutingView          (#/communication)
   │  ├─ AgentsView                (#/agents)
   │  ├─ BackupsView               (#/backups)
   │  ├─ SystemView                (#/system)
   │  ├─ AvatarGalleryView · EmbedDebugView · SpecimenViews
   │  └─ UnavailableView           the withheld-route sentinel
   └─ OverlayRegion                the ONE portal container (see Layers)
      overlays MOUNT here; they are OWNED by the nodes that open them
```

## Stores and state ownership

Five stores, provided at `AppShell`. A node reads the stores it names below and nothing else;
writes go through each store's verbs. This dissolves today's 24-useState root and the
four hand-written reset sites.

| Store | Owns | Verbs | Death/reset |
|---|---|---|---|
| **DataStore** | served truth: plan, health overlay (+stale), communication doc, backups doc, bundles, features, capabilities, demo; the 15s/30s polls | `refresh(kind)` | never resets; poll failure keeps last-good + raises stale |
| **DocumentStore** | the `NexusWorkspace` document, revision, undo/redo stacks, save-state machine, conflict doc | `mutateSheet(coalesceKey)` · `adopt` · `silent` · `save` · `undo/redo` | `adopt` clears both stacks (server truth replaces local) |
| **SessionStore** | everything that must die together: selection Set, active tool, pending wire/placement, inline editors, marquee, clipboard, collapse sets, bar draft, kind-drop, insert-sidebar open, edit mode | `resetSession()` — the ONE reset verb | called on: mode exit, sheet switch, doc adoption, navigation away from Workspace |
| **ViewportStore** | per-sheet transform + last-fit baseline | `pan/zoom/fit` — all writes `silent` by contract | per-sheet; a pan is not an edit |
| **ChromeStore** | route (hash), theme, which chrome overlay is open (menu/modals/confirm), the ops→alert-drawer handoff payload | `navigate` · `openOverlay(one at a time)` · `confirm(action)` | route change closes chrome overlays |

Ownership rules (the #677 contract):

- **What flows down is props/context from a store; what flows up is events to a store verb.**
  A child never receives a sibling's setState; the shell never threads its JSX into a view
  (today's `modeControl`/`historyControl` props die — the canvas toolbar is a WorkspaceView
  section that reads DocumentStore itself).
- **Selection lives in SessionStore only** (today it lives in canvas state AND a shell copy).
  The contextual bar, context menus, and inspector are all readers of the same Set.
- **Module scope is banned for state.** The clipboard moves into SessionStore; the hover
  singleton becomes OverlayRegion policy (one hover surface open); 404 memos become DataStore
  cache entries; reduced-motion is a reactive environment read at AppShell.
- **Server caps live in DataStore constants**, mirrored once, named for their API source.
- **Invariants re-check inside store verbs** (non-modal dialogs stay non-modal): sheet cap,
  id uniqueness, ≥1 sheet — the verb refuses, the dialog renders the refusal.

## Layers (from the design-system scale — decided here, never at the component)

All floating surfaces render through `OverlayRegion`'s portal. In-world stacking (object /
object-active / fixture / badge) stays inside the canvas world; everything else:

| Overlay-capable node | Layer |
|---|---|
| Panels docked in a view (insert sidebar, docked inspector) | `panel` |
| Chrome (headers, rails, toolbar, sheets bar, contextual bar, save/conflict/confirm bars) | `chrome` |
| Hover surfaces (status popover, badge popovers, list popover, card-link overflow) | `hover` |
| Menus (settings menu, context menus, sheet-tab menu, chrome flyout: ops) | `menu` |
| Modal surfaces (right drawers: AgentDetail, AlertDrawer, RoutineDrawer, CapabilityPanel; Features/Tokens modals; scrims) | `modal` |
| Toast | `menu` (above hover, below modal — a toast never blocks a drawer) |

Exactly four overlay mechanisms exist (drawer · hover popover · flyout · in-flow expansion, per
the [interaction spec](interactions.md)); each is one primitive from
[#667](https://github.com/factory-level/harness-hg/issues/667). No node may introduce a fifth or
create a stacking context to win a paint fight.

## Data-boundary nodes

The only nodes that touch the real data layer — the seams
[#666](https://github.com/factory-level/harness-hg/issues/666) must respect (ADR 0157):

| Seam | Node | Everything else |
|---|---|---|
| Nexus plugin API (`/nexus*`) | DataStore (polls + lazy per-tab fetches requested through it) | consumes store state |
| Workspace document endpoints (GET/PUT/DELETE, revision CAS) | DocumentStore | |
| Compiled canvas plan (`nexus-plan.json`, served) | arrives inside DataStore's `/nexus` payload | components never re-read it |
| Grafana embeds (`/nexus/panels`, server-built URLs) | PanelsProvider (a DataStore facet) → PanelGrid/PanelFrame | no node string-builds an embed URL (EmbedDebugView's probe is the sole, deliberate exception) |
| Avatar/icon/font assets | AssetProvider (DataStore facet; 404 memo lives here) | Face/Avatar components take resolved URLs |
| Host SDK (React, fetchJSON) | the `sdk.ts` shim seam at NexusRoot | nothing else touches globals |

## Per-screen decomposition

Each table row is a section or component with its state reads (stores) and the inventory items
it absorbs. Overlay-capable nodes name their layer inline.

### WorkspaceView (`#/fleet[/<sheet>]`)

| Region → section → component | Reads | Absorbs (inventory) |
|---|---|---|
| CanvasRegion → CanvasWorld | Document, Session, Viewport | pan/zoom, dot grid, coordinate clamp, placing-cursor mode |
| CanvasWorld → CardNode (agent/tool/person + kind renderers, retired-kind, orphan, unresolved) | Data (health, badges), Document | cards, footprints, ownership channel, beads, badges, avatar overhang |
| CanvasWorld → BundleFan · CommPanel | Data | bundle fan, comm readouts |
| CanvasWorld → GroupField · GroupCard · CanvasGroupHull | Document, Session (collapse) | plan groups, collapse+rollup, canvas groups |
| CanvasWorld → ShapeNode · TextNode · NoteNode | Document, Session | shapes, texts, stickies |
| CanvasWorld → EdgeLayer (Edge, LiveWire, Ports, endpoint handles) | Document, Session | connections, wire gestures, arrowheads, edge geometry |
| CanvasWorld → SelectionChrome (marquee, grips, rotor) | Session | selection visuals, resize/rotate |
| CanvasWorld → MultiplicityChips | Data (instances), Document | ×N chip/stack/expanded |
| CanvasWorld → CanvasTitle | Document | canvas title |
| ToolRegion → ToolRail · ShapesPalette · ZoomIsland · EditModeButton · HistoryButtons · SaveIndicator · InsertButton | Session, Document, Viewport | rail, zoom/fit, edit toggle, undo/redo, save word |
| ToolRegion → ContextualEditBar (layer: chrome) + FillPicker (layer: menu) | Session, Document | the #398 bar, all segments |
| SheetRegion → SheetStrip · SheetTab · SheetAddButton · SheetPopover (layer: menu) | Document, Chrome | sheet tabs, create/rename/duplicate/delete, caps |
| PanelRegion → InsertSidebar (layer: panel) → KindList · KindPicker | Data (candidates), Session | insert flow, configure-on-drop |
| PanelRegion → DockedInspector (layer: panel; AgentDetail passive) | Data, Session, Document | inspector |
| overlays → CardHoverPopover · BadgePopover (layer: hover) · CanvasContextMenu (layer: menu) · Toast · ConfirmBar/ConflictBar (layer: chrome) | Data, Session, Document | hover surfaces, menus, confirm/conflict, toast |

Signal budget: HealthDot on CardNode (agent/tool only) and inside popovers/rollups; nowhere else
in this view. Sheet tabs, nav tabs, tool chrome: never.

### AlertRoutingView (`#/communication[/<source>]`)

| Section → component | Reads | Absorbs |
|---|---|---|
| PageHead → ListHead · ReadOnlyPill · ProvenanceStrip · DemoBadge | Data | fixed shell, provenance honesty |
| DossierTabs → AlarmsTab · EventsTab | Data | #579 color contract, tab state words |
| AlarmsDossier → FiringSection (BusinessAlertRow, PlatformGroupRow expandable) · RecentAlarmActivity (WindowPills) · AllAlarmsSection (expand → OwnerBuckets) | Data, Chrome (ops handoff) | truthful counts, partitioning, window-refetch, owner shelves |
| EventsDossier → SourceRow (StatusPillLadder, DestinationChips w/ Face) · ReservedEventRows · InboundWebhookRows (each a link to its `in:<id>` board) | Data | one renderer both planes, full-vs-sliced |
| Switchboard (routes `#/communication/<producer>` and `#/communication/in:<id>`) → InboundZone · CableLayer · RouterSpine · CableLayer · OutboundZone · PulseStrip (window pills, ReceiptGroups) | Data | the one graph drill-down, subject = an event either direction; cables from fixed-row index math (ADR 0180) |
| overlays → AlertDrawer (layer: modal; holds a fingerprint, gone-state) | Data, Chrome | rule evidence drawer |

### AgentsView (`#/agents[/<id>]`)

| Section → component | Reads | Absorbs |
|---|---|---|
| FilterBar → HealthChips · BundleChips · CountLine | Data | filters, N of M |
| BundleSections → GroupHead (server rollup) · AgentRow (still Face, deploy cell, Badges, StatusCell) | Data | directory rows, shared badge joins, unknown cells |
| AgentDetail (aside layer: modal / page / passive) → DetailHeader · FactGrid · BundleLine · DetailTabs (Instances, Metrics→PanelGrid, Repositories, Communication, Docs & Runbooks, Uptime, Evals) | Data (lazy per-tab through DataStore) | the three-posture detail, per-source truth, sanitized links |

### BackupsView (`#/backups`)

| Section → component | Reads | Absorbs |
|---|---|---|
| PageHead → VerdictLine · FoldToggle · TargetFilter | Data | answer-first, fold healthy |
| BucketShelves → ShelfHeader (worst-of dot) · RoutineRow (six cells, cron prose, runs strip, ONE status word) · UncoveredRow | Data | shelves, two-axis truth, coverage honesty |
| overlays → RoutineDrawer (layer: modal; resolved per render, gone-state) | Data | facts, pills explained, restore command |

### SystemView (`#/system`)

| Section → component | Reads | Absorbs |
|---|---|---|
| SystemHead → AttentionHeadline (button → spotlight) | Data | headline control |
| Mandala → OrbitTiers · CapabilityArc (dot only when not healthy) · Nucleus (HermesMarkLive) | Data | mandala, vocabulary, unplaced-workloads note |
| CapabilityPanel (layer: modal; the shared drawer) → MemberRows · AgentRuntimeExtra · SystemPanels (PanelGrid surface=system) · PeopleField (read-only) · ProvenanceDisclosure | Data | capability drill-down, People & Groups |

### Shared across views

| Component | Parent context | Notes |
|---|---|---|
| PanelGrid → PanelFrame (+ PlaneBadge) · EmbedHealthBanner | any view section given a surface | server URLs only; **PlaneBadge (#706) renders on every frame from the served plane label** |
| Drawer (the one right-drawer primitive) | OverlayRegion, opened by owning nodes | AgentDetail, AlertDrawer, RoutineDrawer, CapabilityPanel are its four contents |
| OpsPill + OpsFlyout (layer: menu) | ChromeRegion | pure consumer of Data; alert click = ChromeStore handoff + navigate |
| SettingsMenu (layer: menu) · FeaturesModal / TokensModal (layer: modal) | ChromeRegion | |
| UnavailableView / AvatarGalleryView / EmbedDebugView / SpecimenViews | ViewRegion | leaf pages; specimens compose production components |

## Findings (things the tree could not place cleanly)

1. **`sheet:*` health rollups** — served with no consumer; no node claims them. Proposed: drop
   from the overlay (open decision 4 on the [interaction spec](interactions.md)).
2. **The ops→alert-drawer handoff** crosses views (pill → Alert Routing's drawer). Placed as
   ChromeStore payload + navigation, not component coupling — the drawer reads the payload once.
3. **Specimen boards** currently ride legacy canvas host props; they re-mount as plain
   ViewRegion pages composing production components through the same stores, or freeze and die
   with `dashboard/src` (classification: experimental — sign-off decides).
4. **The corner lockup's demo-exit link** is the only chrome element whose behavior depends on
   demo mode; kept as a CornerLockup prop from DataStore, noted so it is not lost.
