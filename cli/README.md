# cli/

`hg`, the operator CLI: `bun src/main.ts`, or `bun link` for a global binary. It is a
developer and operator tool, not part of the runtime. `src/commands.ts` is the single source
of truth for the command surface; `main.ts` derives its parser from it and `make cli-docs`
renders the manual's CLI reference from it.

Gate: `bun run typecheck && bun test` (not reached by `make test`). The loops under
`loops/` are the executable walkthroughs (`make loop-dev` and friends); `e2e-local.sh` is the
full dev-loop chain on a throwaway k3d cluster (`make e2e`).

Manual: https://factory-level.github.io/harness-hg/docs/reference/cli/
