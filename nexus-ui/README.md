# nexus-ui/

The source of Nexus, the operations surface. It builds into `control-plane/nexus/dist/`,
which is committed and byte-compared in CI. Build order matters: `bun run build`, then
`bun run build:standalone`, then `infra/scripts/sync-nexus-chart.sh` to refresh the chart's
projection.

Gate: `bun run typecheck && bun test`; `browser/acceptance.test.ts` drives the machine's own
Chrome through the launch matrix. `design/` holds the design-system spec (ADR 0168) and
review captures. The hosted demo is `vite.demo.config.ts` with the fixture data in
`src/stores/demo.ts`.

Manual: https://factory-level.github.io/harness-hg/docs/nexus-ui/
