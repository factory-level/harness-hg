# ADR 0159 — The loop SOP: no loop, no merge

2026-08-25 · executes [#650](https://github.com/factory-level/harness-hg/issues/650), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646).

## Decision

The three operator loops — **ops** (running your own environment), **dev** (iterating on
the platform), **agent-bundle** (configuring an external repo against the contract) — are
the CLI's acceptance contract, recorded in `_docs/design/cli.md`:

- **Every command declares its loop(s).** The full map (all 40 groups in
  `cli/src/commands.ts`) lives in the design page; zero commands are unclassified. The tags
  become manifest data and the grammar lint enforces them
  ([#656](https://github.com/factory-level/harness-hg/issues/656)).
- **The rule for future commands: no loop, no merge.**
- **Unmapped is the kill list**: CLI `bundle` (ADR-28 preview) and `dash load` die. So do
  the orphaned `uptime-push` helper (`cli/src/uptime-push.ts` — dead heartbeat pushes inside
  `hg platform` backup paths since the `uptime/` cut) and the `external-uptime` Pulumi
  component. All four land on the [#647](https://github.com/factory-level/harness-hg/issues/647)
  sign-off checklist.
- **`harness-legacy` is not the kill list**: `cron`, `discord`, `agent apply` follow the
  frozen Hermes harness ([#652](https://github.com/factory-level/harness-hg/issues/652)).
- **Every loop is walkable end to end with `hg` alone**; the walkthroughs in the design page
  are the acceptance tests [#670](https://github.com/factory-level/harness-hg/issues/670)
  keeps green. Every outside-`hg` step is a gap owned by a phase-5 issue
  ([#673](https://github.com/factory-level/harness-hg/issues/673) /
  [#674](https://github.com/factory-level/harness-hg/issues/674) /
  [#675](https://github.com/factory-level/harness-hg/issues/675) /
  [#676](https://github.com/factory-level/harness-hg/issues/676)); the census found no
  unowned segment, so no new gap issues were filed.

## Reason

The CLI grew ~40 command groups by accretion; without an acceptance contract there is no
principled answer to "does this command belong". The loops are that answer: they are what an
operator actually does, so coverage of the loops is the definition of done for the surface —
and unmapped commands are, by construction, features nobody's loop needs.

## Cost

- The classification is judgment until
  [#656](https://github.com/factory-level/harness-hg/issues/656) turns the tags into
  lint-enforced manifest data — until then the map can silently drift from the code.
- Multi-loop tags dilute the discipline; every "dev · ops" entry is a small admission that
  the verb serves two masters, and the grammar work has to decide whether that is one
  command or two.
- `harness-legacy` deliberately keeps shipping surface that serves no loop — the freeze is
  paid for in help-text and docs noise until Hermes' removal is decided.
- The walkthroughs are prose until [#670](https://github.com/factory-level/harness-hg/issues/670)
  executes them; between now and phase 4 they can rot against reality.
