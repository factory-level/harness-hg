# CLI — as built

`hg` as it actually stands. The desired state is [`../design/cli.md`](../design/cli.md) (the
three loops, front doors, grammar); the diff is the gap list.

## What exists

- **The manifest everything derives from**: `cli/src/commands.ts` holds every command,
  subcommand, and flag as data, and three consumers render it — `main.ts` (now ~1.2k lines, the
  dispatch only) derives `VALUE_FLAGS`/`JSON_COMMANDS` and its usage output, so an undocumented
  value flag fails to *parse*; `infra/scripts/generate-cli-docs.py` renders
  `_docs/wiki/reference/cli/` and cross-checks the dispatch switch in both directions
  (`make cli-docs`, `cli-docs-drift` in `make test`); `hg help <command>` renders one command's
  detail.
- **One directory per subject** (#657): `cli/src/` holds `agent/`, `auth/`, `backup/`,
  `communication/`, `connection/`, `cron/`, `dash/`, `debug/`, `discord/`, `edge/`, `eval/`,
  `eve/`, `gitops/`, `grafana/`, `harness/`, `launch/`, `local/`, `nexus/`, `observability/`,
  `platform/`, `reconcile/`, `server/`, `topology/`, `validate/`, `workspace/`, plus the shared
  `commands.ts`, `proof.ts`, `lib.ts`, `main.ts`.
- **The grammar is data and it is enforced** ([ADR 0161](../adr/0161-cli-grammar.md)): the
  `VERBS` register in `commands.ts` pins one meaning per verb (a sub's verb is the last word of
  its name), `loops:` tags every command with its journeys, and both are enforced bidirectionally
  by `cli/tests/commands-grammar.test.ts` plus the cli-docs coverage check. The kill list is
  executed: no `bundle` command and no `dash load` exist in the manifest. The three renames
  (`event publish`, `chatops tail`, `platform backup prove`) are canonical-only — the warning
  aliases were deleted by [#672](https://github.com/factory-level/harness-hg/issues/672) and
  `make retired-paths` keeps them dead. ADR 0177 hard-renamed `hg eve prove|evals` to
  `hg agent prove|evals` (no alias, by decision), made `cron`/`discord` engine-neutral (Hermes
  depth, honest refusals on Eve), added `hg harness list`, and renamed `--hermes-home` to
  `--harness-home` (the stored `hermesHome` config key is still read); `hg launch prove` now
  registers the `agent` subject for any non-empty fleet — previously a Hermes-only fleet's
  agent runtime was proven by nothing.
- **The prove convention**: every `prove` verb returns a `ProofResult` (`cli/src/proof.ts`) —
  numbered findings, each `pass | fail | unknown`, and **unknown is never a pass**.
  `hg launch prove` (`cli/src/launch/prove.ts` `proveLaunch()`) aggregates every subject's
  matrix and adds no checks of its own; a subject that cannot run reports `LAUNCH001 unknown`,
  not a pass.
- **The loop front doors, as they stand today**: `hg dev` exists and anchors the dev loop
  (`onboard → up → dev → validate/test/eval → logs/prompt/debug/dash → down/reset`,
  walkable from step ②). `hg env` is now the ENVIRONMENT subject (#674): `plan/apply/import`
  over `infra/environments/<name>.yaml`, generating both stacks' `Pulumi.<name>.yaml`
  projections (drift gated in `make test`); the profile dotenv group moved to `hg envfile`.
  **`hg env new` exists** (#676): preflight (ENV001..ENV006, ProofResult shape, the
  root-of-trust probes riding the same ADC credential pulumi uses) then six probe-idempotent
  steps — state stack init'd in the root backend with the assembled `gcpkms://` provider,
  config generated, `pulumi up`, then the infra stack in its own backend impersonating the
  deploy SA, config + up — each narrating the exact command (env prefixes included;
  `--dry-run` prints the whole hand-executable sequence). Failure names the step; re-run
  resumes by probe. **`hg bundle init` exists** (#673, ADR 0172, ADR 0178): scaffolds a TEAM in
  the agent-team tree (`cli/src/agent-bundle/`, templates in-dir) — `harness-hg/{team,
  destination,workspaces}.yaml`, per Eve agent (`--agent`, or `--agents eve:a,eve:b`)
  `agents/eve/<name>/harness-hg/{agent,backup,test,dashboard}.yaml` + `src/`, `evals/suite.yaml`,
  a README listing every omitted `harness-hg/*.yaml` — omits bundles/apps/communication/
  connections/capabilities/topology/endpoints (absent = honestly off), refuses `hermes:<x>` with
  a copy-from-`examples/` pointer, generates the `npm ci` lockfile, and proves its own output with
  `hg validate --dir` before printing the loop. `examples/agent-team/` is exactly its output for
  two Eve agents and rides `make e2e-offline`; `eve-agent`, `communication-plane` and
  `distributed-profile` stay on the legacy layout as the dual-reader regression guard. `hg --help` leads with the three doors
  (manifest `frontDoor` markers; the docs index derives the same list).
- **The executable walkthroughs** ([ADR 0170](../adr/0170-loop-walkthroughs-executable.md)):
  `cli/loops/{dev,agent-bundle,ops}-loop.sh` run the three loops as real `hg` invocations with
  asserted outcomes, fronted by `make loop-dev` (= `make e2e`, the 12-step `cli/e2e-local.sh`
  chain on a throwaway k3d cluster), `make loop-agent-bundle` (cluster-free, rides `make test`
  via e2e-offline), and `make loop-ops` (the live environment). The scripts, not the design
  prose, are the acceptance surface.
- **The Phase-4 proof surface**:
  - `hg validate --dir <repo>` — the one-shot no-cluster contract gate over a single repo
    (`commands.ts` `validate`), used by e2e-offline over every reference authoring, including
    the leg that must fail.
  - `infra/scripts/e2e-offline.sh` (#669, in `make test`) — source → emit → destination
    with no docker and no network: validate the examples (clean pass + `distributed-profile` FAILS),
    compile the persona checkout, seed a token-less `file://` destination and `hg topology
    emit` into it, `hg gitops doctor` to zero findings, `hg nexus validate`, then the persona
    repo's own `evals/topology-check.sh` against this checkout's `hg` — the cross-repo loop no
    CI runs anywhere. Persona legs skip loudly when the sibling checkout is absent.
  - `infra/scripts/record-cmp.sh <ref-a> <ref-b>` (`make record-cmp`) — deployment-neutrality
    as a command: renders every persona profile's record from two git refs of this repo and
    byte-compares; a non-identical record is enumerated with a diff.
- **The test surface**: ~40 bun suites in `cli/tests/` (`cd cli && bun run typecheck && bun
  test`), including the bidirectional nets `main-flags.test.ts` and `commands-grammar.test.ts`,
  the versions pin sweep, and per-subject suites.

## What does not exist yet

The loop-quickstart docs
([#675](https://github.com/factory-level/harness-hg/issues/675)); the Nexus plugin-id and
control-plane chart-name renames ([#745](https://github.com/factory-level/harness-hg/issues/745),
blocked on fleet convergence #703).

## Known defects

- **`hg auth prove`, `hg grafana prove`, and (by aggregation) `hg launch prove` are
  local-loop-shaped** ([#740](https://github.com/factory-level/harness-hg/issues/740)): they
  assume k3d naming and kubeconfig writes a real environment does not have. `ops-loop.sh` skips
  them against a non-local context with a stated reason, never silently — three of the eight
  ops SOP steps assert nothing against a real environment today.
- **CI is manually disabled repo-wide** (`.github/workflows/DISABLED.md`,
  [#737](https://github.com/factory-level/harness-hg/issues/737)): the cli/infra/state bun
  suites and the nightly `loop-dev` run only when a developer runs them. `make test` reaches
  the CLI end-to-end via `e2e-offline` but none of the unit suites — a green `make test` after
  a `cli/` change is necessary, not sufficient.
