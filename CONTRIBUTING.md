# Contributing

Thanks for helping. This page is the whole checklist.

## Before you open a PR

1. **Run the gate.** `make test` is most of it. The TypeScript unit suites are separate:

   ```bash
   make test
   cd cli      && bun install --frozen-lockfile && bun run typecheck && bun test
   cd infra    && bun run typecheck && bun test
   cd nexus-ui && bun run typecheck && bun test
   cd state    && bun run typecheck && bun test
   ```

2. **Use conventional commits.** The platform version is computed from commit subjects:
   `feat:` bumps minor, `fix:` and `perf:` bump patch, a `!` or a `BREAKING CHANGE:` footer
   bumps major. Other types (`docs`, `refactor`, `test`, `chore`, `build`, `ci`) do not move
   it. Subject form: `type(scope): imperative summary`, under 72 characters.

3. **Update the docs in the same PR.** A behaviour change touches at least one of: the owning
   page under `_docs/wiki/`, `maintainers/built.md` (a build unit or its gate), or
   `maintainers/gaps.md` (a gap closed or opened). A change to what the system *should* be
   gets a new `_docs/adr/NNNN-<name>.md` with its cost. The rules are in
   [`_docs/README.md`](_docs/README.md).

4. **Never hand-edit generated files.** `_docs/wiki/reference/cli/`,
   `_docs/wiki/reference/contracts/*.md` (except `index.md`), `reference/profile-record.md`,
   `control-plane/nexus/dist/`, `control-plane/nexus/chart/files/` and the chart goldens are
   regenerated (`make cli-docs`, `make docs`, `bun run build && bun run build:standalone` in
   `nexus-ui/`, `infra/scripts/render-test.sh --update`) and byte-compared by the gate.

## Rules the codebase enforces

- **Schemas are frozen.** A change that adds, removes or narrows a field in
  `agent-bundle-contracts/` is a new version directory. Only `description`, `title` and
  `examples` may change in place. Every constraint ships with an `invalid-*` fixture.
- **Fail loudly, early.** A missing secret or unset required value stops before anything is
  written to Git, with the fix named. Do not soften a hard failure into a warning.
- **Secret values never enter Git.** Not in fixtures, not in examples, not in tests.
- **No operator identifiers in the tree.** `make public-clean` fails on real server
  addresses, cloud project ids, workspace ids or personal addresses. Use `example.dev`,
  `example-project`, `T0123456789`.
- **Version pins live in `versions.json` only.** A second literal copy fails the build.

## Where this repository comes from

This is the public tree of a platform that also runs a private operations fork. `main`
advances by snapshot commits from that fork, each gated by `make test` and the identifier
check before it lands. A PR merged here is ported into the fork before the next snapshot,
so it survives; a snapshot never rewrites history, only adds a commit on top.

## Reviews

Every PR needs one approving review from a code owner (`.github/CODEOWNERS`). Frozen
contracts, the emitter and anything that reaches a cluster get the most scrutiny.

## Reporting problems

Bugs and feature requests: [GitHub issues](https://github.com/factory-level/harness-hg/issues).
Security problems: [`SECURITY.md`](SECURITY.md), never a public issue.
