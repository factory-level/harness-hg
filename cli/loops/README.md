# The three operator-loop walkthroughs, executable (#670)

ADR 0159 defined the loop SOP and admitted its walkthroughs were "prose
until #670 executes them". These scripts are that execution: each loop's
walkthrough from `_docs/design/cli.md` as a scripted sequence of real
`hg` invocations with asserted outcomes. A red run here blocks a merge
with the same standing as the record `cmp` (`infra/scripts/record-cmp.sh`).

| Loop | Script | Runs where | Make target |
|---|---|---|---|
| dev | `dev-loop.sh` (delegates to `cli/e2e-local.sh`) | throwaway k3d cluster | `make loop-dev` (= `make e2e`) |
| agent-bundle | `agent-bundle-loop.sh` | no cluster, repo-runnable | `make loop-agent-bundle` (in `make test` via e2e-offline's chain) |
| ops | `ops-loop.sh` | the live environment (factory) or any `HG_KUBE_CONTEXT` | `make loop-ops` |

The ops loop asserts the post-day-0 prove segment only; day-0 itself
(root of trust, state stack, environment config) stays a by-hand
procedure until Phase 5 (#674, #676) builds `hg env new`.
