# 0180 — The Alert Routing drill-down is a patch-bay switchboard, and its subject is an event

**Decision.** The `#/communication/<sub>` drill-down stops being a flat fan
(emitter card + consumer list) and becomes a **three-zone patch-bay
switchboard**: inbound sources left, the **router spine** center (status lamp,
`dlq N · pending N`, the last fan-out's per-consumer outcome), outbound
consumers right, with **drawn cables** between the zones — live blue, degraded
amber, failed red, declared dashed gray. Its subject is an **event**, in either
direction: an outbound abstracted event (a producer's fan-out, the existing
`#/communication/<producer>` links unchanged) or an **inbound unified webhook**,
which gains its own sub-route `#/communication/in:<id>` (single-segment by
prefix — the router reads only one path part) and turns the inbound-webhook list
rows into links. The view also starts consuming the two served-but-ignored
surfaces: `latestExecution` (per-consumer delivered/failed, #278) and
`GET /nexus/communication/history` (the ADR-114 receipts + delivery pulse, with
a 1h/24h/7d window selector) — the RECENT ACTIVITY strip below the board.
Cable geometry is **index math on a fixed row height** (`PATCH_ROW_H`, shared
with the CSS through one inline custom property): the cable layer is an
ordinary in-flow SVG grid cell, so the style gates (no positioning outside
primitives) hold with no exception. The design pages this changes are
[`_docs/design/nexus-ui/hierarchy.md`](../design/nexus-ui/hierarchy.md) and
[`inventory.md`](../design/nexus-ui/inventory.md) (the FanDetail node and its
inventory rows become the Switchboard tree).

**Reason.** The surface is named a switchboard everywhere but on screen. The
router genuinely is a spine — one inbound event, one correlation id, N
consumers with independent outcomes — and the flat list erased exactly the
facts an operator drills down for: which side of the router a problem is on,
and whether the last real event reached everyone. Both data sources existed and
were already ratified (ADR-114 built the server half; `latestExecution` shipped
with #278) — the UI was the unpaid half. Two honesty rules follow the router's
own contracts rather than inventing new ones: the inbound board joins edges by
the **declared `from.externalInput` identity** (newly carried through
`_project_edge` — matching on event alone can claim another webhook's routes),
and per-receipt outcomes mirror the router's `outcomeOf` verbatim
(success = accepted|delivered, failure = failed|dead-lettered,
queued/duplicate/skipped are **neither** and render as pending — the browser
recomputes the fan-out split from the receipts because the served
delivered/failed counts flatten queued into delivered). Inbound webhooks were the one routing
subject with no detail view at all, and the server's `externalInputs`
projection (`{id, profile, event, verification, accepts}`) was mistyped in the
browser as a fixture-era fiction (`{name, binding, kinds}`), so a real
deployment rendered `undefined` — building the inbound board is also what
forced that fix, along with the provenance-sources type (objects, not strings)
that would have rendered `[object Object]`.

**Cost.**

- **Cable geometry is fixed-row index math, not measured layout.** Rows are
  exactly `PATCH_ROW_H` tall and long ids ellipsize (full value in `title=`).
  A future variable-height row (wrapping labels, per-row expansion) requires
  the named fallback — a ResizeObserver-measured cable layer — which is a new
  decision, not a tweak.
- **`alertHistory` is served and not rendered.** The history endpoint's third
  section (which alerts fired inside the window) has no UI; the remainder is on
  the roadmap. The pulse and receipts sections are rendered.
- **Receipts remain bounded by the router's in-memory ring** ("since router
  start", stated on the strip verbatim from the served `truthfulWindow`) —
  durable history stays #295, unchanged by this ADR.
- **Narrow viewports drop the cables.** Below ~760px the zones stack and the
  SVG cells hide; every fact the cables encode is still on the rows, but the
  patch-bay reading is gone on a phone.
- **The board reads best under ~8 consumers.** Nothing paginates the outbound
  zone; a fleet with a much wider fan-out will get a tall board before anyone
  decides whether to group it.
- **The `in:` prefix shadows one class of producer name.** A producer literally
  named `in:<x>` resolves as itself only while no webhook claims id `<x>`
  (`resolveSwitchboard` tries the webhook first, then the literal producer); a
  fleet declaring both a webhook `x` and a producer `in:x` cannot deep-link the
  producer. Chosen over an escaping scheme because the router reads only one
  path segment and no real producer wears that shape today.
