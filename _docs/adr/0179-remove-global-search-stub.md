# 0179 — The global search control is removed, not finished

**Decision.** The header's search magnifying glass is **removed** from the Nexus
chrome, together with everything that existed only to hold its place: the
`"search"` member of the chrome-overlay union, the `search` glyph in the icon
vocabulary, the `search` feature-flag record, and the flag's slot in the launch
configuration (`LAUNCH_FLAGS_ON`, `cli/src/launch/prove.ts`). The design pages
this changes are [`_docs/design/nexus-ui/inventory.md`](../design/nexus-ui/inventory.md),
[`hierarchy.md`](../design/nexus-ui/hierarchy.md) and
[`design-system.md`](../design/nexus-ui/design-system.md): the "Search button +
⌘K flyout" inventory row, the SearchButton/SearchFlyout hierarchy nodes and the
CommandPalette design-system verdict all come out. Search is no longer a
designed capability of the dashboard; if it returns it is a new decision with a
new ADR and a new flag id.

**Reason.** What shipped was a dead control. The button toggled
`overlay = "search"` and nothing anywhere rendered that overlay — no palette, no
⌘K handler, no index, no result-to-card focus path. A control that promises a
capability and delivers nothing on click is the exact defect the launch matrix
exists to catch ("a flag whose data path is broken"), yet the flag was listed in
`LAUNCH_FLAGS_ON`, making the stub *launch-required*: every proven deployment
was obliged to show a button that does nothing. The fleet is small enough that
every card is reachable in one or two clicks from Fleet or the Agents
directory; the honest options were to build the palette or remove the promise,
and nothing currently justifies building it.

**Cost.**

- **No find-a-card affordance exists.** On a fleet large enough that scanning
  fails, the operator has no faster path than the Agents directory's filter.
  That is acceptable at today's fleet size and wrong at ten times it; the
  re-introduction trigger is fleet growth, not taste.
- **Reinstating search is a full new decision** — new ADR, new flag id, new
  launch-flag deliberation. Nothing of the stub is kept to make that cheaper,
  because what existed was a button and a name, and keeping either would
  preserve the lie that part of the work is done.
- **`M5 · Search` becomes a milestone with no feature record.** The milestone
  label survives only in history (`CHANGES.md`); the registry no longer carries
  it.
