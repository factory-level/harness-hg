# ADR 0177 — A harness-neutral `hg` surface

**Status:** Accepted
**Changes:** `_docs/design/cli.md` (the loop map and grammar notes)

## Decision

The CLI stops naming runtimes in its command surface. Concretely:

1. **`hg eve prove|evals` becomes `hg agent prove|evals`.** The `agent` subject —
   already engine-neutral for `show|inspect|render|exec` (ADR-153) — gains the
   acceptance verbs. Dispatch is **subject-level**: `hg agent prove` partitions
   the selection by runtime and runs each harness's own matrix. The
   `HarnessDriver` interface stays `{invoke, show, exec}`; ADR-153's refusal to
   put deployment and acceptance behind one interface stands.
2. **The Hermes harness gets a real, minimal matrix** — `HRM001` (the running
   pod answers `agent show` with a coherent snapshot; declared-but-unactivated
   cron is a failure) and `HRM002` (the existing smoke tier passes). Deep Hermes
   acceptance remains `hg test`; the matrix says so. No finding is fabricated:
   `pass | fail | unknown` keeps its meaning, and "not applicable" stays what it
   has always been — an absent subject.
3. **`hg launch prove` registers the `agent` subject for every non-empty
   fleet** (previously only when an Eve agent existed — a Hermes fleet's agent
   runtime was proven by nothing at the launch gate).
4. **`hg cron` and `hg discord` become engine-neutral subjects.** The Hermes
   behavior is unchanged (the fork wrapper; the gateway.log observation). On an
   Eve selection, `cron list|show` project the agent's declared
   `agent/schedules/`; the mutating cron verbs and `discord status` refuse with
   the reason (Eve compiles schedules at build; Discord is owned by the
   connection gateway — `hg connection prove`, EVE021/EVE024). The
   `harness-legacy` loop is left with no members and is retired from the
   grammar's pinned expectation.
5. **New `hg harness list`** — the declared harnesses (`harness/*/harness.yaml`,
   ADR 0162): name, status, gateway kind. The declarations existed with no CLI
   surface.
6. **`--hermes-home` becomes `--harness-home`** on `hg reconcile install`. The
   stored config key `hermesHome` is still read (write-new, read-both); the
   generated unit's `Environment=HERMES_HOME=` line is unchanged — it is an
   internal identifier on live hosts, in the deferred-rename ledger.
7. **Hard rename, no aliases.** The old spellings die in this change, by the
   operator's explicit decision — a deliberate deviation from ADR 0161's
   rename-with-warning-alias precedent. `make retired-paths` keeps the dead
   spellings dead.

## Reason

The product is a GitOps platform for harnesses; the runtime name in a command
was the one place the CLI's engine-neutrality visibly broke, and the asymmetry
was not cosmetic: the only runtime acceptance matrix was named after one
harness, and the launch gate silently skipped the agent-runtime subject for a
fleet on the other. Naming the subject `agent` and dispatching per harness fixes
the name and the hole with the same edit. `cron`/`discord` follow the same rule
`agent apply` already established: engine-neutral surface, honest refusal where
a harness has no such mechanism.

## Cost

- **No bridge for old spellings.** An operator's notes or scripts using
  `hg eve …` or `--hermes-home` fail with usage errors immediately, with no
  deprecation window. This is the accepted price of the hard rename; the 0161
  precedent (warn, then delete) was offered and declined.
- **Frozen contracts keep printing the old spelling.** The immutable
  `agent-runtime/v1alpha1` schema says `hg eve prove`; rather than mint a schema
  version for prose, `check-wiki-commands.py` gains a frozen-tree exemption
  (`agent-bundle-contracts/`, `cli/schemas/`) mirroring `check-retired-paths`'s
  convention. The old spelling survives there as history.
- **HRM001–002 are shallow by design.** They prove the frozen harness is up,
  configured, and converged — not the breadth EVE001–024 proves for Eve. The
  fleet-level truth is unchanged: deep Hermes acceptance is `hg test`.
- **EVE leg ids keep their `EVE` prefix** under the new command name; renaming
  two dozen leg ids would churn every ledger that cites them for zero
  information.
- **`hg harness show` is deferred** until something needs it; `list` ships.
- The `harness-legacy` loop tag remains in the type for the frozen surface that
  may yet move with #652, but nothing carries it after this change.
