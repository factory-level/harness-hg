# Agent-bundle contracts — as built

The frozen contracts root as it actually stands. The desired state is the
`agent-bundle-contracts/` section of [`../design/platform.md`](../design/platform.md); the diff
is the gap list.

## What exists

- **One top-level root, `agent-bundle-contracts/`**, moved byte-identically from
  `plugin/schemas/` on 2026-08-25 (#651, 391 files, sha256 sweep). Twenty-one contract groups:
  `agent-team` (ADR 0178, 2026-09-02: `team`, `agent`, `apps`, `endpoints`, `backup`, `test`,
  `topology` — the authored surface of an agent-team repository), `agent-runtime`, `cluster-values`, `communication-deployment`, `dashboard-contribution`,
  `dashboard-plan`, `environment-bundles`, `environment-capabilities`,
  `environment-communication`, `environment-connections`, `environment-topology`,
  `environment-workspaces`, `eval-result`, `eveagent`, `harness-declaration`,
  `hermes-gitops-extension`, `hermesprofile`, `lifecycle-record`, `panel-catalog`,
  `runtime-overlay`, `topology-plan`. `README.md` is the router describing each.
- **The immutability rule** (`agent-bundle-contracts/README.md`): any change that adds, removes,
  or narrows a field is a **new version directory**; existing version directories are immutable
  once another component depends on them. The rule is taken literally — the frozen
  `hermesprofile` schema `description` strings still say `plugin/schemas/README.md`, because
  frozen contract bytes are frozen bytes; and `cluster-values/v1alpha1` still accepts the
  retired `tailscale` provider, because a frozen contract cannot be narrowed (the chart is
  where that refusal lives).
- **The fixture gate**: for a schema at `<group>/<version>/<name>.schema.json`, fixtures live in
  `<group>/<version>/examples/*.yaml`; fixtures named `invalid-*` MUST fail validation and every
  other fixture MUST pass — `infra/scripts/validate-schemas.sh` asserts **both directions**
  (`make schema-validate`, in `make test`) over `agent-bundle-contracts/` and `cli/schemas/`.
  The negative fixtures are part of the contract: a schema constraint without an `invalid-*`
  fixture proving the rejection is incomplete.
- **Reference authorings** live in `examples/` at the repo root (`gitops-repo/`, `eve-agent/`,
  `distributed-profile/`, `communication-plane/`, plus the
  `invalid-chart-boundary/` negative tree for the chart gate); `hg validate --dir` and
  `infra/scripts/e2e-offline.sh` drive them as the cluster-free end-to-end, including the leg
  that must FAIL (`distributed-profile`'s persona-echo deliberately omits a `valuesRequired`
  override).
- **`cli/schemas/evals/`** (`v1alpha1`, `v1alpha2`: `suite.schema.json` + `scenario.schema.json`)
  is the one contract that is deliberately **not a deployment surface** — a repo with a broken
  eval declaration deploys identically. It stays under `cli/` rather than this root for exactly
  that reason, while the same fixture gate still validates it.
- **The never-hand-edit list** — generated consumers of these schemas, regenerated when a schema
  changes and drift-gated in `make test`:
  - `_docs/wiki/reference/profile-record.md` and `_docs/wiki/reference/contracts/*.md` (all but
    the hand-written `index.md`) — `make docs`, gated by `docs-drift`.
  - `_docs/wiki/reference/cli/` (the whole directory) — `make cli-docs` from
    `cli/src/commands.ts`, gated by `cli-docs-drift`.
  - `infra/src/control-flow/generated-contract.ts` — `make contract-types`
    (`infra/scripts/generate-contract-types.mjs`), gated by `contract-types-drift`.

## What does not exist yet

- **The `harness-hg/` surface is contracted and read by the CLI and the emitter.**
  The `agent-team/v1alpha1` family and the environment spec's `grants`
  (`cli/schemas/environment/v1alpha2`) exist with fixtures and a generated reference.
  `cli/src/layout.ts` is the one helper every reader routes through: it discovers
  `agents/<harness>/<name>/harness-hg/agent.yaml`, folds the split files plus the team's
  `apps.yaml` into the legacy v5 raw shape (v3 when a Hermes `expose` block is present) and
  re-validates the fold against the frozen extension schema (`cli/tests/layout.test.ts` proves
  a split authoring loads to the same contract as the legacy file). `plugin/gitops_emitter/layout.py`
  is the emitter's half of the same fold (`plugin/tests/test_layout.py` pins a split Eve project
  and a split Hermes v3 profile with `expose` to byte-identical records); the contract directory
  is found beside a `src/` payload, or named by `--contract-dir` / `HERMES_GITOPS_CONTRACT_DIR`
  (what the Pulumi `hermes-agent` component must export, since `hermes profile install --subdir`
  stages `src/` alone), and a `src/` payload with no contract is a refusal - never a record with
  zero apps. `cli/src/topology/environment.ts` `loadEnvironment(root, environment?)` reads every
  team file from `teamDir(root)`; an `--environment` file supplies only the cluster half - a
  legacy `topology.yaml` (files beside it override per file), or an environment spec whose
  `grants` are unioned with the team's target-free `harness-hg/topology.yaml` (TOPO018 for a
  capability bound on both sides, TOPO019 for a region with no target or a grant for no region;
  `cli/tests/env-union.test.ts`). Two bundle-blind defects went with it: the override directory
  used to replace the team dir wholesale, and the full-topology return path never carried
  `bundledProfiles`. The bootstrap's half is built too: `agentInstanceName` skips the `src`
  payload segment, K7 validates `../harness-hg/agent.yaml` for a local `/src` source, and the
  Hermes stage-2 install script clones the source at the resolved sha and exports
  `HERMES_GITOPS_CONTRACT_DIR` so the emitter hook finds the contract `hermes profile install
  --subdir` stages away. The scaffold lands in the follow-on change of ADR 0178. `hg env` dispatches on the
  spec's `apiVersion`. The `.harness-hg/` dot-directory ADR 0157 named was never built.
- The one-event-envelope contract tests across every surface
  ([#655](https://github.com/factory-level/harness-hg/issues/655)) — the envelope exists per
  surface, the cross-surface divergence gate does not.

## Known defects

- The rename freeze is visible on disk: group names carry the old product (`hermesprofile`,
  `hermes-gitops-extension`), and per `maintainers/final-pass/naming-scheme.md` they never
  mutate — new names arrive only as new version directories.
- `hermes-gitops-extension` is the **legacy** per-agent file (ADR 0178): it stays readable for
  unmigrated repositories and grows no further version.
- The `hermes-gitops-extension` `v1alpha3` blocks are validated and then **stripped** by the
  emitter (`plugin/gitops_emitter/render.py` `strip_extension_v3`) so the rendered record stays
  byte-identical to a v1 authoring — surprising, deliberate, and easy to misread as a bug.
