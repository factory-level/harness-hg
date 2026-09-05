# harness/hermes/ — frozen legacy

**The freeze (final-pass epic #646, ADR 0157):** Hermes keeps working and takes **no new
features**. Fixes only where a live environment breaks. Its surfaces — the `hermes-profile`
/ `hermes-bundle` charts, the Hermes-native CLI groups (`hg cron`, `hg discord`,
`hg agent apply` — `harness-legacy` in the loop map), the install-hook emitter path, and
`identity/` — move under this directory as their migration steps land, and change only to
stay working.

**What would unblock removal** (a separate, later decision — explicitly not this epic):
every live Hermes profile migrated to Eve records, the Hermes install-hook emitter path
already deleted by [#681](https://github.com/factory-level/harness-hg/issues/681), and no
persona repo declaring `runtime: hermes`. Until all three hold, deletion is not on any
plan.
