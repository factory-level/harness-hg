# Nexus UI — desired-interaction spec

How each required surface is *supposed* to behave: the requirement set the rebuild
([#666](https://github.com/factory-level/harness-hg/issues/666) /
[#668](https://github.com/factory-level/harness-hg/issues/668)) is built and reviewed against.
Mined for [#665](https://github.com/factory-level/harness-hg/issues/665) from the running app and
the do-not-regress epics
[#540](https://github.com/factory-level/harness-hg/issues/540) /
[#558](https://github.com/factory-level/harness-hg/issues/558) /
[#584](https://github.com/factory-level/harness-hg/issues/584) /
[#428](https://github.com/factory-level/harness-hg/issues/428) (which stay open — mined, not
closed) plus `maintainers/gaps.md` §12–17 and ADR 0166. Precedence where sources conflict:
newest wins — #584 > #558 > #540 > #428.

## The truth model (global, non-negotiable)

1. **Truth over cosmetic green.** Unknown, stale, and unavailable stay explicit wherever they
   affect a decision. The UI never fabricates healthy state; production failures never fall back
   to demo-healthy fiction. Missing telemetry caps aggregates *worse*, never better.
2. **Server computes, browser renders.** Every health level, ladder, and status is served; the
   browser only aggregates over its own groupings and never derives a level.
3. **Healthy is quiet; attention is loud.** Routine green recedes. Both a quiet-healthy and a
   one-controlled-failure browser scenario must pass review.
4. **Nexus is a projection.** GitOps/bootstrap is authoritative; no Nexus-side CRUD competes with
   it (People & Groups is the canonical example: read-only forever).
5. **Unknown ≠ healthy; unreadable ≠ false.** Empty bucket = unknown; flag-off = "unknown", never
   an empty dash; partial reads say so.
6. **Identity resolution over stale capture.** Drawers hold a fingerprint/id, resolve against the
   current document every render, and show explicit gone-states.
7. **Honest links only.** A reference renders as a link only when it resolves AND its target view
   is reachable; authored links are https-only; server-built URLs for anything with identity.
8. **Deep links survive.** Any demotion of a surface preserves routability or ships a deliberate
   redirect.
9. **Words carry state; color reinforces; color never stands alone.** Ownership markers (the
   Hermes sphere) are never health colors.
10. **Reduced motion respected everywhere** — and inverted only where animation IS the content
    (the avatar gallery's per-tile play).

## Information architecture (#540, as modulated by #558)

Workspace (Fleet Canvas) is the default client surface and the only mandatory day-to-day
destination. Alert Routing, Agents, and Backups remain top-level tabs with the refined UX below —
the #558 "retain and refine" direction governs; #540's open children #541/#543 (collapse to
drill-down-only) stay an explicit open decision, not a rebuild default. System is an operator
surface entered through the brand lockup, never client navigation. The global ops pill is the one
attention aggregate: alerts are the signal; the five-second question ("is anything wrong, where,
what do I click") is answered from the pill and the canvas without opening any other view.

Status-signal budget: a dot exists only where its state changes the user's next local action.
Concretely today: canvas dots on agents and tools only; no dots on nav or sheet tabs; one
aggregate pill in chrome. #542 (the formal budget) remains open — the hierarchy page
([#677](https://github.com/factory-level/harness-hg/issues/677)) assigns the budget per node and
becomes its answer.

## Interaction contracts per surface

Beyond the truth model, the behaviors below are the reviewed product decisions the rebuild
recreates. (The inventory page classifies *what* exists; this section states *how* the required
set behaves.)

### Canvas / Workspace

- The canvas is a communication whiteboard, never runtime topology: duplication and connections
  imply nothing about deployment; card removal is a reference removal and says so.
- One gesture = one undo step (coalescing); one mutation funnel; abandoned gestures write
  nothing; every dialog is non-modal so invariants re-check inside the updater.
- Canvas-instance identity ≠ domain identity (#546): repeated placements are independent
  instances; geometry/selection/connections are instance-scoped, badges/metadata ref-scoped.
- Absence-as-default persistence (ADR-72): defaults are stored as absent fields; untouched
  documents round-trip byte-identically. Byte-exact export; revision CAS with the 409 conflict
  bar (Load theirs = adopt + clear undo; Overwrite = re-PUT carrying their revision).
- Editor geometry is ONE system (#577/#578): resize grips, ports, rotation arm, selection bounds,
  and text placement share one coordinate + layer grammar; handles never collide; proven in a
  real browser at multiple zooms.
- Connectors are Lucidchart-class (#547): forgiving hit targets, per-instance endpoints, editable
  arrowheads, terminals on shapes and text, live wire that commits only over a valid target.
- Client caps mirror server caps by name (sheets 8, notes 100, shapes/texts/connections 200,
  coordinate limit): visible-but-disabled with the reason, never hidden.
- Save is explicit (#423): a save-state machine (saved/unsaved/saving/failed/conflict) whose
  callers name events, never target states; quiet word when clean, button only when actionable.

### Alert Routing

- Two dossiers (Alarms / Events) with the #579 color contract: red-family always for Alarms —
  muted when quiet, materially vibrant when firing; `quiet` is NEVER rendered while an
  authoritative source reports a firing alarm; unknown is not quiet.
- Exceptions-first: business alerts get full rows; platform alerts collapse into one expandable
  summary; standing routes sit behind an explicit expand ("existence is not attention").
- Counts are truthful (`N+` on truncation; partial reads are "not an all-clear"); history windows
  are refetches whose pressed pill reflects the *displayed* window; retention claims never exceed
  what the router actually holds (receipts are restart-volatile until #295).
- One renderer for both planes' source rows; status computed from the FULL edge set while
  destination chips show the section's slice; the fan drill-down is the only graph view and is
  reused by history rows (never a duplicate inline view).

### Backups

- Answer-first: one colored verdict sentence; healthy folds by default; missing coverage,
  missing projection, and intentional ephemeral state are three distinct renderings.
- The control plane is explicit per-component (no blanket "Platform backup" row); workloads roll
  up by installed bundle; a drawing decision (canvas groups) never mints a shelf.
- Schedule health and artifact verification never merge; `restorable` requires a verified
  restore; `available` never renders as success; never-read-back = `unmeasured`.
- Cron prose only for known shapes — otherwise verbatim; destinations described in durability
  terms; the raw restore command is one click away with copy.

### System

- Capability-first vocabulary (10 responsibilities, never vendor names); every inventory workload
  belongs to exactly one slice and unplaced workloads are called out.
- The mandala's attention headline is a control that spotlights the flagged arcs.
- All detail surfaces are the shared right drawer (#574): scrim, Escape, focus-restore,
  background de-emphasized — the dense infrastructure-card wall must not return.
- People & Groups: read-only projection with truthful empty/unavailable states; the persona repo
  is named as the authoring path.

### Agents

- #584 found no new deficiencies: the rebuild regression-checks Agents, it does not redesign it.
  Compact badge-driven rows; badges share the canvas joins so the two can never disagree; facts
  (instances, model, crons, latest eval) live one click away in the drawer.

### Embeds

- Server-built allowlisted URLs only; closed size presets with equal-size placeholders; "Open in
  Grafana" on every frame including failed ones; one blocked-signal shared by banner and frames.
- Reference posture: embeds resolve without a separate Grafana login (#556 supersedes #415);
  production HTTPS/SSO posture stays with #300/#332.
- **Plane visibility (#706, ADR 0166): every surface that embeds a Grafana dashboard/panel shows
  its plane — Control Plane vs Workloads — as a badge or grouping sourced from the plane label.**
  Grafana-side folders are already derived and validation-gated; the rebuild adds the Nexus half.

### Overlay grammar (feeds #677/#667)

Exactly four overlay mechanisms exist and the rebuild keeps the count at four, as primitives:
1. the modal right drawer (one primitive — today hand-rolled four times);
2. the hover popover (single-open registry, close grace, no-portal clipping to fix);
3. the chrome flyout (anchored, outside-press dismiss, non-modal);
4. in-flow expansion (no overlay at all).
Route-level drill-downs are navigation, not overlays. The hash-vs-state rule becomes policy:
surfaces a user shares (fan detail, agent page) are hash-routed; transient evidence (alert/
routine drawers) is state, so closing restores scroll untouched.

## Acceptance inheritance

The rebuild's regression suite adopts the browser-proof floor: four viewports (incl. 200% zoom)
× both themes, no top-level browser scroll, menu layering by `elementFromPoint`, keyboard-only
drawers, reduced-motion gating, frame-src refusal — plus #584's 17-step walkthrough scenario and
the #557 end-to-end green gate as templates. RBAC-in-browser and cross-site cookie enforcement
remain the two named holes (#307/#300) and stay open issues, not silent scope.

## Open decisions — RESOLVED (ADR 0173, 2026-08-27)

All seven ratified as the recorded defaults at the #712 review; the questions stand below as
the record of what was asked, each now carrying its decision.


1. **Nav collapse** — DECIDED: tabs kept, Workspace lands; #541/#543 collapse stays a possible
   later change.
2. **Plane badge scope** — DECIDED: badges on every panel frame only; grouping and alert-row
   marks deferred until plane confusion shows up in use.
3. **Embed acceptance posture** — DECIDED: the suite proves the anonymous-viewer reference
   posture; SSO/HTTPS proofs stay with the deploy-proof issues.
4. **`sheet:*` rollups** — DECIDED: dropped; restore is additive when a sheet-tab affordance is
   designed.
5. **Backups roll-up boundary** — DECIDED: confirmed as shipped (workloads by bundle; control
   plane always explicit per-component).
6. **#544** — DECIDED: closed as satisfied by #545's mandala.
7. **History window promise** — DECIDED: only the router's truthful in-memory window, footer
   stating it, until #295 lands durable records.
