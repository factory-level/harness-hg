# Harness Hg agent-bundle contracts

This directory is the **versioned contract** between every component of Harness Hg:
the plugin that renders `profile.yaml` instance records, the GitOps repo those
records get pushed to, and the Helm chart that consumes both `cluster-values.yaml`
and `profile.yaml` as layered values files.

The contract directories are listed below. All but one describe an artifact a
human or a generator **writes** to disk; `runtime-overlay/` is the exception and
says so in its own `description` — it schemas an API *response*, because that
response is a contract between the plugin backend, the browser bundle and the CLI
just as much as a file is.

- `agent-team/v1alpha1/` — **the authored surface of an agent-team repository**
  ([ADR 0178](../_docs/adr/0178-agent-team-contract-surface.md)): `harness-hg/` at any
  level is exactly what the platform reads. Seven schemas, each a `kind` under one
  `apiVersion` (`hermes-gitops.factorylevel.dev/agent-team/v1alpha1`): the team
  (`harness-hg/team.yaml` — identity + the harnesses in use), the per-agent
  declaration (`agents/<harness>/<name>/harness-hg/agent.yaml` — a POSITIVE
  `harness:` that must equal the path segment; env requirements; supported
  layouts), the team's apps with their owner and their routes (`apps.yaml`), the
  agent's endpoints with its inbound routes and the Hermes-only `expose`
  (`endpoints.yaml`), backup, the dev-loop test config (`test.yaml`, the first
  schema that file ever had) and the target-free topology (`topology.yaml` —
  regions, no cluster names; the targets are the environment spec's `grants`,
  `cli/schemas/environment/v1alpha2`). Every concern whose shape did not change
  keeps its frozen schema below and only relocates its file (`bundles`,
  `communication`, `connections`, `workspaces`, `capabilities`, `destination`,
  `dashboard`). The compiler folds these back into the v5 extension shape at
  load time, so every emitted record is unchanged. `$defs` are copied verbatim
  from `hermes-gitops-extension/v1alpha5` rather than `$ref`'d across files.
- `hermesprofile/{v1alpha1,v1alpha2,v1alpha3}/` — the per-agent instance record
  (`profile.yaml`) pushed
  to the GitOps repo, expressed as a JSON Schema (draft 2020-12). The record is
  **plain Helm values**: a single top-level `spec:` block, with no
  `apiVersion`/`kind`/`metadata` envelope (nothing installs a CRD — no
  `HermesProfile` object exists in any cluster). `profile.schema.json` uses
  `additionalProperties: false` throughout (strict rejection of unknown fields)
  and gates `profile.yaml` before it's pushed to the GitOps repo. The record's
  identity is its **directory name** under `profiles/` (read by the
  ApplicationSet as `{{.path.basename}}`); the emitter owns that name and
  enforces its rules (DNS-1123 label, max 40 chars).
  **v1alpha2** removes four fields no consumer ever read
  ([ADR-8](../_docs/adr/CHANGES.md#adr-8), #132):

  | Removed | Why | Successor |
  |---|---|---|
  | `spec.targetCluster` | The ApplicationSet hardcodes `destination.name: in-cluster`; its own comment already said the placement field "was removed" | **Not a record field** (#176, ADR-33): placement is the environment's decision. The profile declares what it supports (`topology.supportedLayouts`, `agent.multiplicity`); `environment/topology.yaml` places instances onto targets; the compiler emits `argoDestination` per instance record and the per-instance ApplicationSets read it. TOPO017 fails preview when a destination names an unregistered cluster |
  | `spec.reach` | Its only key was `regions`, read by nothing | none |
  | `spec.deployment.machineType` | Leftover from the deleted VM compute path | none — pod is the only compute path |
  | `spec.deployment.region` | as above | none |
  | `spec.deployment.diskType` | as above | none |

  **v1alpha3 (current)** widens one field rather than removing any
  ([#141](https://github.com/factory-level/harness-hg/issues/141)):

  | Widened | From | To |
  |---|---|---|
  | `spec.envRequires` | a flat array of names | entries carrying `{name, description?, required, secret}` — **bare names are still valid**, and resolve to `required: true, secret: true` |

  `distribution.yaml` declares each variable with a description and a `required`
  flag; the record stored only the names, so optionality, purpose and the
  secret-versus-config distinction were discarded at the one point they could
  have been written down. Those are the three facts the capability model
  (**#171**) and the secret lifecycle (**#149**) need in order to tell a
  credential from a setting, or a mandatory variable from an optional one.

  Two defaults, both conservative. **`required` absent means required**,
  matching the fork's own `EnvRequirement`. **`secret` absent means secret** —
  `distribution.yaml` has no such field today, so every existing declaration
  resolves that way, and the direction is deliberate: treating a setting as a
  secret costs an ExternalSecret, while treating a secret as config puts its
  value in a rendered manifest.

  **Migrating a v1alpha2 record:** nothing to do. A bare-name array is valid
  v1alpha3 and means exactly what it meant before. The emitter re-renders the
  richer form on the next emit.

  These were not merely unread: the chart's own `values.schema.json` declares
  `spec` as `additionalProperties: false` and never had them, so a record
  carrying one would already fail to render. v1alpha1 stays on disk and
  immutable; nothing writes it any more.

  **What this does NOT remove:** `spec.targetCluster`'s only working consumer
  was the *environment-side* remote-cluster registration
  (`infra/src/control-flow/config.ts` `TargetClusterSpec`,
  `infra/src/components/argocd/index.ts`, which mints the Argo CD cluster
  Secrets). That shipped and is untouched — only the per-record field is gone.
  A literal reading of "delete contract fields nothing reads" would have taken
  the half of the feature that actually works.

- `cluster-values/v1alpha1/` — the per-cluster values file
  (`bootstrap/values/cluster-values.yaml`) consumed by the Helm chart.
  **One retired value lives here by necessity:** `providers.ingress: tailscale`
  and the `tailscale{}` block are removed from the chart per
  [ADR-9](../_docs/adr/CHANGES.md#adr-9) (#131), but this schema is frozen
  and a frozen contract cannot be narrowed — so it still accepts both, and the
  chart is where the refusal happens (`helm template` fails at its own values
  schema with "providers.ingress must be one of the following").
  `plugin/tests/test_values_schema_subset.py` pins the asymmetry in both
  directions. The value goes when this contract next takes a version.
- `hermes-gitops-extension/` — **legacy** (ADR 0178: the `agent-team/` family splits it; this reader stays for unmigrated repos and grows no further version) — the developer-authored `hermes-gitops.yaml` beside
  `distribution.yaml`, in three frozen versions: `v1alpha1` (the five original
  blocks), `v1alpha2` (contract version 2: the five blocks
  validation-compatible - every valid v1 block body stays valid - plus
  `contractVersion`, `topology`, typed `endpoints`, and `requires`), and
  `v1alpha3` (contract version 3, ADR-39: v2 plus the communication plane -
  `apps[].outputs[]` typed event producers and a top-level `communication`
  block of routes and external webhook inputs; the emitter validates and
  STRIPS these, so records stay byte-identical v1 and the agent runtime
  contract - including the agent's own gateway, which the communication
  plane delivers to and never replaces - is untouched), and `v1alpha4`
  (contract version 4 - two changes: `requires[].optional` (#143: an
  unsatisfied optional requirement is a compile WARNING and an absent
  injection, never TOPO004; absent means required), and the legacy
  `expose` block is **removed** (#147, ADR-99: `access.policy` and
  `endpoints[].type` were two exposure models for one surface, and ADR-27
  requires a migration, not an addition). A v4 file carrying `expose`
  rejects. **Adoption order matters**: a v4 record carries no expose
  block, so under the legacy `profiles/*` generator its agent endpoints
  deploy nothing - adopt `contractVersion: 4` only in a repository
  converted to the per-instance generators (`hg gitops upgrade`)), and
  `v1alpha5` (contract version 5, ADR-149: v4 plus an optional top-level
  `runtime` block - `kind: eve` marks the directory as an Eve project
  (package.json + `agent/`) and `runtime.envRequires` is then the whole
  environment contract, there being no distribution.yaml. A v5 file
  without the block is a Hermes profile exactly as under v4; the emitter
  strips the block like every other versioned key, and its Hermes
  pipeline REFUSES a file whose runtime is `eve`).
- `eveagent/v1alpha2/` — v1alpha1 + `spec.apps` (resolved child helm apps, the same
  shape as the HermesProfile record) + `spec.backup` (schedule + retention), both realized
  by the `eve-agent` chart (ADR-150). The emitter writes this version; v1alpha1 records stay
  valid because both keys are optional.
- `eveagent/v1alpha1/` — the record the emitter writes for an agent on the
  Eve runtime (ADR-149): `profiles/<name>/profile.yaml` as plain Helm values
  for `infra/charts/eve-agent`. `spec.runtime: eve` is the discriminator the
  agents ApplicationSet routes on; `spec.envRequires` carries the v5
  extension's `runtime.envRequires` in the HermesProfile entry shape; there
  is no apps/backup/expose surface. The Hermes counterpart is
  `hermesprofile/`.
- `environment-capabilities/v1alpha1/` — the operator-authored
  `environment/capabilities.yaml` (ADR-98, #144): capabilities the environment
  provides, capability name → `{implementation, url, region?}`. The second
  provider source in capability resolution; a capability satisfied by both a
  profile endpoint and an environment binding is TOPO005, never a precedence
  rule. Consumer: the topology compiler.
- `environment-topology/v1alpha1/` — the operator-authored
  `environment/{topology,policy}.yaml` pair in the GitOps repository: what the
  environment is (layout, sovereignty, DNS, regions/targets) and what it allows
  (chart sources, jurisdictions). Their consumer is the topology compiler
  (ADR-33).
- `environment-communication/{v1alpha1,v1alpha2}/` — the operator-authored
  `environment/communication.yaml`: the environment-owned half of the
  communication plane (ChatOps connection aliases with provider plugins and
  credential REFERENCES - never values - plus the durable transport). Read by
  the topology compiler beside `topology.yaml`; absent file = feature off.

  **v1alpha2 (current)** adds `chatopsConnections.<alias>.inbound` (#348): who may
  make a connection DO something — `approvedUsers`, `approvedRoles`,
  `approvedChannels`, `mentionPolicy`, `threadPolicy`. Before this there was **no
  declaration surface for inbound authorization at all**; a connection carried a
  provider and a credential, which is enough to *post* and says nothing about who may
  give instructions.

  **Absent means deny**, never allow: a connection with no `inbound` block accepts
  nothing, which is why an outbound-only connection needs no policy to be safe.
  Identifiers are provider-native ids (a Discord snowflake), never display names — a
  display name is changeable by the person it names, so authorizing one authorizes
  whoever holds it next. An approved user in an unapproved channel is refused: the
  channel is what makes a request auditable by the people who can see it.

  **Migrating a v1alpha1 file:** nothing to do. Every v1alpha1 document is valid
  v1alpha2 and means the same thing — no `inbound` block, so no inbound authority. The
  CLI's environment loader (`cli/src/topology/environment.ts`) validates against v1alpha2
  outright rather than dispatching on a version key the file does not carry.
- `environment-workspaces/v1alpha1/` — the operator-authored
  `environment/workspaces.yaml` (`kind: WorkspaceBindings`, #361): immutable
  Git checkouts as PROFILE capabilities - repositories (url with a pinned or
  application-resolved revision, or `source: self` for the bound profile's
  own distribution repo at its deployed revision; mount; credential
  reference) and explicit repository→profile bindings, independent of
  bundle membership. Read by `cli/src/workspace-bindings.ts`; absent file =
  feature off, and the access default for every profile is none.
- `environment-connections/v1alpha1/` — the operator-authored
  `environment/connections.yaml` (`kind: Connections`, ADR-152): third-party
  app registrations (Discord application, GitHub App) declared ONCE and
  bound to profiles with an inbound routing rule (guilds/channels,
  repositories). Carries no secret material: the keys live in one platform
  Secret `hermes-secrets/connection-<name>` (`hg connection set` /
  `connections.<name>.<KEY>` stack config), projected by ESO into every
  bound profile's namespace as `<instance>-connection-<name>` and into the
  event router, whose gateway route `/v1/connect/<provider>/<name>`
  verifies the provider's signature and forwards verbatim. Read by
  `cli/src/connections.ts`; absent file = feature off, and a profile bound
  to nothing receives nothing.
- `topology-plan/v1alpha1/` — the generated catalogue/deployment records
  `hg topology emit` writes into the GitOps repository (ADR-34): provenance,
  per-instance deployment records, and the plan summary. `v1alpha2`
  (deployment record only, ADR-123) lets agent records carry the installed
  distribution identity; `v1alpha3` (deployment record only, ADR-149) adds
  the agent runtime (`spec.runtime`) and the chart that realizes it
  (`spec.chart`), which the agents ApplicationSet templates its chart path
  from.
- `communication-deployment/{v1alpha1,v1alpha2}/` — the generated
  `deployments/communication/` records (ADR-39): the event-router
  deployment record, its verbatim routing configuration (producers, edges,
  ChatOps connection references, durable provider - credential references
  only), and the plane's plan summary. v1alpha2 (ADR-74, values file only)
  adds two OPTIONAL top-level chart values the emitter writes only when
  `topology emit` is given `--router-image`/`--observer-url`: `image` (an
  environment-specific router image, e.g. the baseline-CPU build) and
  `recordingBase` (the debug-observer/recording sink URL - an http(s) URL
  by pattern, never a credential). A flag-less emission stays
  v1alpha1-shaped byte-for-byte.
- `dashboard-contribution/{v1alpha1,v1alpha2}/` — the persona-authored Nexus
  canvas half: `dashboard/contribution.yaml` (components bound to
  profiles/apps, people, groups, conceptual relationships; v1alpha2 adds
  optional https `links` on components — ADR-43) and `dashboard/views/<view>.yaml`
  (the repository default layout). Data, never code; read by the Nexus
  compiler (ADR-42).
- `dashboard-plan/{v1alpha1,v1alpha2}/` — the generated Nexus records
  (ADR-42): the dashboard-source provenance record and
  `deployments/dashboard/nexus-plan.json`, written by `hg nexus emit`
  (deterministic; runtime health is never written into it; v1alpha2 carries
  the authored component links, `version: 2` only when links are present).
- `runtime-overlay/v1alpha1/` — **an API response, not a file** (ADR-55): the
  normalized operational document `GET /nexus/health` serves, plus the
  `ReconciliationStatus` record the host reconciler publishes into a ConfigMap
  for that document to read. Every operational source reports through one
  `Source` shape carrying its own adapter status, so an unconfigured or failed
  source reads `unknown` instead of vanishing into green. The severity ladder is
  applied by the producer and by nobody else — consumers read levels, they never
  compute them, which is exactly why this is a schema and not an implementation
  detail.

Each version directory contains its schema(s) plus `examples/` fixtures used by
`scripts/validate-schemas.sh` (wired into `make schema-validate` / CI): fixtures
named `invalid-*` must fail validation, everything else must pass.

## Versioning rule

- `lifecycle-record/v1alpha1/` — **the shared telemetry envelope** (#349). One record
  shape for every plane that emits lifecycle telemetry: the Discord gateway, the native
  cron scheduler, the event router, alerting, and agent and tool execution. Deliberately
  **transport-agnostic** — those planes share no bus, store or delivery mechanism, and
  forcing them onto one would couple their failure domains; the envelope exists so a
  trace can be *followed* across them, not so they become one system. `traceId` groups a
  causal chain and `causationId` orders it (without the second, a trace is a bag of events
  and the tree cannot be rebuilt). **Metadata only, at schema level**: actor references
  carry ids rather than content or display names, `detail` accepts scalars only, and a
  `digest` gives content-identity without content — the debug observer writes these to
  disk. `testRun` present means a human or harness asked for the run; absent means it
  happened on its own, which is how #349's autonomous-trigger proof is read.

Schemas are versioned by directory (`v1alpha1`, `v1alpha2`, ...). **Emitted**
documents (records, values files) carry no version marker of their own, so the
version a component validates against is pinned by which schema copy it vendors.
**Authored** files are the one exception. An agent-team repository's
`harness-hg/*.yaml` documents carry `apiVersion` + `kind` (one family version
for the whole repo, ADR 0178). The legacy `hermes-gitops.yaml` may carry a
top-level `contractVersion`, and readers dispatch on that key's VALUE — `5`
validates against `v1alpha5`, `4` against `v1alpha4`, `3` against `v1alpha3`, `2` against `v1alpha2`,
an unmarked file against `v1alpha1`, and no file is valid under more than one (`v1alpha1` rejects
unknown keys; each versioned schema pins its marker with `const`). **Any change that adds,
removes, or narrows a field is a new version directory** — existing version
directories are immutable once other components depend on them. Widening an
existing field (e.g. relaxing a pattern) still warrants a new version unless the
change is provably backward- and forward-compatible for every known consumer.
The one sanctioned exception (ADR-140): **annotation-only edits** — adding or
improving `description`, `title`, or `examples` keys — may land on any version,
provided stripping descriptions from the before/after schemas yields identical
documents, so every validation verdict is provably unchanged.

Downstream consumers (the plugin, the Helm chart, CI in the GitOps repo) vendor a
copy of the schema they validate against rather than fetching it at runtime.
CI in each consuming repo should include a drift check that re-fetches the schema
from this repo (or a pinned commit/tag of it) and diffs it against the vendored
copy, failing the build if they've diverged.

## Secret-naming contract

`spec.envRequires` values are materialized by the infra program as one Kubernetes Secret `hermes-<instance>-env` in the instance's own namespace (`agentSecrets` stack config, issue #38 [K6]) — the workload's `envFrom` references exactly that name (`charts/hermes-profile/templates/pod/statefulset.yaml`). The older per-var kebab convention (`hermes-<instance>-<env-var-lowercased-with-underscores-to-hyphens>`, single key `value`, in `hermes-secrets`) survives only where the Cloudflare tunnel program writes back per-instance credentials; the chart's `hermes.kebab` helper and the tunnel program's `secret_name()` must stay synchronized on that transform.

---

*Path note (final-pass #651, 2026-08-25): this tree was `plugin/schemas/` until the
`agent-bundle-contracts/` move. The frozen `hermesprofile` v1alpha2/v1alpha3 schema
`description` strings still say `plugin/schemas/README.md` — frozen contract bytes are
never edited, so that spelling is permanent and means this file.*
