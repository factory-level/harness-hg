# Bootstrap — as built

The provisioning reality: what stands between a fresh GCP project and a converging cluster. The
desired state is the `bootstrap/` section of [`../design/platform.md`](../design/platform.md); the
diff between the two is the gap list.

**The deviation, stated plainly: there is no `bootstrap/` root.** The target scaffold
([ADR 0157](../adr/0157-target-scaffold.md)) places this work at `bootstrap/state-bucket-kms/` and
`bootstrap/platform-infra/`; reality keeps the two pre-refactor roots, `state/` and `infra/`, and
the emitter still lives in `plugin/gitops_emitter/` rather than inside the Pulumi code. The moves
are owned by [#681](https://github.com/factory-level/harness-hg/issues/681) (emitter + shim) and
ride the day-0 work ([#674](https://github.com/factory-level/harness-hg/issues/674),
[#676](https://github.com/factory-level/harness-hg/issues/676)); until they land, this page
describes `infra/` + `state/` because that is what exists.

## What exists

- **`state/` — the state-backend stack** (Pulumi project `hermes-gitops-state`,
  `state/Pulumi.yaml`; bun, `src/index.ts` + `src/config.ts`, `tests/config.test.ts`). It is the
  only stack whose backend is the **manually created** root bucket + KMS key — the one by-hand
  step, documented as literal `gcloud` commands in `state/README.md` (Pulumi cannot store the
  state of the stack that creates the state bucket inside that bucket). Per agent it provisions a
  state bucket, a deploy service account, and IAM; `infra/scripts/agent-backend.sh` is the login
  helper that puts an operator into exactly that backend and identity. It also provisions the
  CMEK backup buckets with the writer/reader identity split (`backupEnvironments`) —
  `maintainers/gaps.md` records that the backup block has never had a live `pulumi up`, so its
  executed path is still the emulator.
- **`infra/` — the platform Pulumi program** (project `hermes-gitops-bootstrap`,
  `infra/Pulumi.yaml`). Entry point `infra/src/index.ts`; **three config-gated stages** (`stages:
  {hermes, agents, cluster}` in stack config, `control-flow/config.ts` `load()`): install the
  Hermes fork + emitter plugin on the operator host → emit per agent (`hermes profile install`,
  or `emit_cli` via the `EveAgents` component for `runtime: eve` entries) → the in-cluster
  control plane (Argo CD, ESO, ClusterSecretStore, optionally PKO, the root Application). Stages
  1–2 are `local.Command` resources and need no Kubernetes provider. One `pulumi up` runs all
  gated stages in order.
- **`infra/src/components/`** — the leaf ComponentResources: `agent-secrets`, `argocd`,
  `cloudflare-ingress`, `cluster`, `eso`, `gitops-scaffold`, `harness/` (`hermes-install`,
  `hermes-agent`, `eve-agent`), `namespaces`, `nexus`, `pulumi-operator`, `reconciler`,
  `root-app`, `router-secrets`, `secret-store`. `infra/src/control-flow/` composes them
  (`hermes.ts`, `control-plane.ts`) over the typed env-config contract (`config.ts`).
  `control-flow/generated-contract.ts` is **generated** by
  `infra/scripts/generate-contract-types.mjs` (`make contract-types`; `contract-types-drift` in
  `make test`) — never hand-edited.
- **The reconciler** (`components/reconciler`, ADR-54): a systemd user timer on the destination
  host applying the *persona* repo from its GitHub remote on a 60s tick. On the factory stack it
  is on (`reconcile: {enabled: true, branch: main, intervalSeconds: 60}` in
  `infra/Pulumi.factory.yaml`, `hermes-gitops-bootstrap:reconcile` block).
- **`infra/gitops-template/`** — the destination-repo scaffold the emitter seeds: `bootstrap/`
  holds `project.yaml`, the profiles `applicationset.yaml` (git-files generator, one
  Application per `profiles/*/profile.yaml`, identity `{{.path.basename}}`), the per-surface
  generators in
  `applicationsets/` (`agents`, `apps`, `bundles`, `communication`, `endpoints`), the
  operator-owned platform Applications (`monitoring-stack.yaml`, `loki.yaml`, `wiki.yaml`,
  `fleet-dashboard.yaml`, `control-plane-observability.yaml`, `identity.yaml`,
  `platform-extras.yaml`), and `values/cluster-values.yaml` — the environment half of the
  two-value-file layering. Gated by `make gitops-template-validate`
  (`infra/scripts/validate-gitops-template.sh`).
- **`infra/scripts/`** — the gate machinery, distinct from the program: schema and template
  validators (`validate-schemas.sh`, `validate-gitops-template.sh`), the chart-boundary gate
  (`check-chart-boundary.py` + `chart-boundary.yaml`), golden renders (`render-test.sh`), the
  offline end-to-end (`e2e-offline.sh`) and the deployment-neutrality proof (`record-cmp.sh`),
  doc-link checking (`check-doc-links.sh`), version derivation (`derive-version.py`), the
  generators (`generate-cli-docs.py`, `generate-schema-docs.py`, `generate-contract-types.mjs`,
  `generate-mark-svg.mjs`), the projections (`sync-nexus-chart.sh`, `sync-alerting-lib.sh`), the
  cluster-bearing suites (`test-drift-and-decommission.sh`, `test-recovery.sh`,
  `verify-bootstrap-git-side.sh`, `eve-boot-test.sh`), the avatar pipeline (`rekey-avatars.py`,
  `gen-avatars.py`), and `server/` with the vendored, sha256-verified k3s installer.
- **`infra/pulumi/programs/cloudflare-tunnel/`** — a self-contained uv project with its own
  lockfile; collecting it from the root venv fails at import time by design (root `pytest` is
  scoped to `plugin/tests`).
- **Authored vs generated**: stack configs are authored — `Pulumi.factory.yaml` is committed
  *with encrypted secrets on purpose* (the recoverable environment definition; GCP KMS), other
  real stack configs are gitignored and only `Pulumi.local.yaml.example` is committed. Generated
  and never hand-edited: `control-flow/generated-contract.ts`, the render-test goldens
  (regenerate with `render-test.sh --update`), and every version pin flows from the repo-root
  `versions.json` (ADR-63; `cli/tests/versions.test.ts` fails on a second literal copy).
- **Gates**: `cd infra && bun run typecheck && bun test` (component suites incl.
  `module-paths.test.ts`, which asserts every `import.meta`-derived path resolves — the gate the
  harness-registry move itself lacked); `make verify-git-side` executes stages 1–2 under node
  with no cluster; `make drift-test` runs drift + decommission against a real k3d cluster
  (Docker, 10–20 min, nightly).

## What does not exist yet

- The `bootstrap/` root and the emitter-inside-Pulumi move, with the `_startup-shim` launch gate
  ([#681](https://github.com/factory-level/harness-hg/issues/681)).
- `environment.yaml` as the declared environment source with generated stack config
  ([#674](https://github.com/factory-level/harness-hg/issues/674)) — today the stack config is
  hand-edited.
- `hg env new` owning day-0 from stack-init onward
  ([#676](https://github.com/factory-level/harness-hg/issues/676)) — today `state/README.md` is
  raw `gcloud` + `pulumi` commands, and today's `hg env` command is an unrelated
  profile-environment-file group (see [cli.md](cli.md)).

## The environment spec (#674)

`infra/environments/<name>.yaml` (schema `cli/schemas/environment/v1alpha1`) is the declared
source of truth for one environment's two stacks; `state/Pulumi.<name>.yaml` and
`infra/Pulumi.<name>.yaml` are generated projections (`hg env apply`; drift gated by
`make test` `env-drift`). Secrets are `{secret: true}` markers — the ciphertext lives only in
the generated files and survives regeneration byte-for-byte. The factory imported clean:
value-identical config, secretsprovider, and encryptedkey across both stacks.
`reconcile.statusNamespace`/`kubeContext` joined the declared surface with the same change
(they were host-only config.json fields before).

## Known defects

- The Pulumi project names are still `hermes-gitops-bootstrap` and `hermes-gitops-state` — the
  product rename stopped at the live-state-migration boundary
  (`maintainers/final-pass/naming-scheme.md` defers it to #676/#674).
- CI is manually disabled repo-wide (`.github/workflows/DISABLED.md`,
  [#737](https://github.com/factory-level/harness-hg/issues/737)), so the infra bun suites and
  the nightly `drift-test` run only when a developer runs them.
- `state/`'s backup-bucket block is code with no live apply behind it — the IAM denials and
  bucket posture have been proven against the emulator only (`maintainers/gaps.md`,
  [#304](https://github.com/factory-level/harness-hg/issues/304)).
