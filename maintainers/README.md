# maintainers/

Unpublished ledgers that keep the manual honest. `built.md` has one row per build unit with
the gate that would catch its regression; `gaps.md` lists every deviation and defect with a
status; `observability-coverage.md` does the same per component for metrics and alerts;
`final-pass/` holds the refactor inventory and naming ledger. `_docs/README.md` states how
these relate to the design, architecture and decision trees.

Nothing here publishes. When a gap closes, its row leaves this directory and the claim moves
to the manual in the same PR.
