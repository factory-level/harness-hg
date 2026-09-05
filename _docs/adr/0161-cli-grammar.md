# ADR 0161 — The hg grammar: one meaning per verb, journeys as data

2026-08-25 · executes [#656](https://github.com/factory-level/harness-hg/issues/656), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646). Follows
the loop SOP ([ADR 0159](0159-loop-sop.md)) and the subject restructure (#657, PR #691).

## Decision

- **The manifest carries the grammar.** `cli/src/commands.ts` gains `loops: Loop[]` per
  command (the ADR 0159 map, now data) and a `VERBS` register: one meaning per verb, where
  a sub's verb is the last word of its name. Both are enforced twice — a typed test
  (`cli/tests/commands-grammar.test.ts`, bidirectional like `main-flags.test.ts`: an
  unregistered verb fails, and so does a hoarded one) and `generate-cli-docs.py`'s
  coverage check, so `make cli-docs-drift` gates every PR. No loop, no merge; no meaning,
  no verb.
- **The colliding verbs get one meaning each**: `emit` writes generated files into a
  repository tree; `publish` sends to a live external surface; `prove` runs an acceptance
  matrix and emits a ProofResult (unknown is never a pass); `doctor` diagnoses
  declared-vs-actual; `restore` replays from a captured artifact.
- **Three renames**, each with a deprecated alias that warns and dies with
  [#672](https://github.com/factory-level/harness-hg/issues/672):
  `hg event emit` → `hg event publish` · `hg chatops inspect` → `hg chatops tail` ·
  `hg platform backup prove-recovery` → `hg platform backup prove` (whose documented
  two-word form now actually dispatches).
- **Help is journey-first.** `hg --help` and the generated CLI reference index group
  commands by primary loop, both derived from the same manifest field.

## Reason

Eleven `prove`s, three `emit`s, three `doctor`s and two `restore`s meant a verb told an
operator nothing until they read the sub's prose. A register with bidirectional enforcement
makes the next colliding verb a red CI run instead of a review argument — and putting the
loop tags in the manifest is what makes ADR 0159's "no loop, no merge" checkable rather
than aspirational.

## Cost

- Aliases are live compatibility paths until #672; each carries a deprecation warning, and
  the manifest documents only the canonical spelling — an operator reading old notes types
  a command the reference no longer lists.
- The verb-is-last-word rule is a convention, not a parser: multiword subs
  (`payload validate`, `queue test`) lean on it reading naturally, and a future sub could
  satisfy the letter while betraying the meaning — the register's prose is still judged in
  review.
- `VERBS` meanings are asserted only by substring in the grammar test; rewording a meaning
  can silently weaken what the test pins.
