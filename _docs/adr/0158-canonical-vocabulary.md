# ADR 0158 — Canonical vocabulary

2026-08-25 · executes [#649](https://github.com/factory-level/harness-hg/issues/649), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646).

## Decision

`_docs/design/vocabulary.md` becomes the internal register: one canonical name per concept
across the platform source, the emitted destination repository, the persona repos,
control-plane labels/metrics, and the CLI grammar. The wiki's `vocabulary.md` stays the
reader-facing register; the two must never disagree on a term.

The load-bearing calls:

- **Harness ≠ runtime.** The harness is the repo-side driver (`harness/<name>/`: emitter
  path, image, chart, gateway declaration); the runtime is the process it deploys in the
  pod. Eve is both; the words never substitute.
- **The bundle declaration's home is the `.harness-hg/` directory** — persona destination
  config lives there, succeeding both the retired `.hermes-dist` format and, at the next
  contract version, the `hermes-gitops.yaml` filename (frozen legacy until
  [#651](https://github.com/factory-level/harness-hg/issues/651) cuts that version).
- **No new `hermes-*` name for a generic platform concept**, on any surface. Aliases only
  where a live system references the old name, each with a removal condition; all gone by
  [#672](https://github.com/factory-level/harness-hg/issues/672).
- The emitted-output census (goldens + gitops-template, 2026-08-25) added three families to
  the naming-scheme ledger that the first pass missed: the `hermes-gitops.yaml` declaration
  filename, the `hermes_*` Prometheus metric prefixes, and the `hermes-system` /
  `hermes-monitoring` namespaces.

## Reason

Historical naming leaks everywhere: `hermes-*` on generic concepts, source terms differing
from destination terms for the same thing, `connection`/`connections` as two CLI subjects,
and "runtime" and "harness" used interchangeably in some pages and as distinct things in
others. A register with teeth — backed by per-identifier dispositions and the
deployment-neutrality proof — is what lets the phase-1/2 moves rename without breaking
deployed environments.

## Cost

- **Two vocabularies coexist for the whole transition.** Frozen contract surfaces keep
  `hermes-*` names indefinitely (until a new version dir), so greps and docs must qualify
  which register a name belongs to until
  [#672](https://github.com/factory-level/harness-hg/issues/672) collects them.
- Every alias is a live compatibility path someone must remember to remove; the removal
  conditions in the ledger are promises that phase 4 has to collect.
- The wiki register and this register are two files that can drift; keeping them agreeing is
  a manual discipline (a future lint could enforce it, none does today).
- Renaming metric prefixes and namespaces later (with
  [#660](https://github.com/factory-level/harness-hg/issues/660) /
  [#662](https://github.com/factory-level/harness-hg/issues/662)) will break saved Grafana
  queries and any external dashboards pointed at `hermes_*` series.
