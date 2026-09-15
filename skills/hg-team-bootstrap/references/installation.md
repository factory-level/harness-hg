# Installation plan

Store the YAML in the bootstrap checkout, for example `teams/installation.yaml`. Use version 2
whenever the installation must be reproducible: it pins every source and commits a lock beside it.
Keep the human survey and upstream skill provenance in each team's specification. The CLI
validates the YAML before running source code; `hg help team` describes invocation.

Required fields:

| Field | Meaning |
|---|---|
| `version`, `id` | `1` or `2`, and a stable installation identifier shared by every source watcher |
| `lock` | Version 2 only: bootstrap-relative installation lock path, for example `teams/installation.lock.yaml` |
| `sources[]` | `id`, credential-free `repository`, `ref` (version 2: `refs/tags/<tag>` or a 40-character commit, never a branch), `private`, optional `credentialEnv`, and `agents[]` |
| `sources[].agents[]` | `name`, project `subdir`, `environment` variable names, `tools`, `writablePaths`, and `skills`; private source additionally requires `gitAuthSecretRef` |
| `destination` | GitHub `repository`, `branch`, `credentialEnv`, and explicit `autoMerge` |
| `environment` | Bootstrap-relative environment declaration used by the topology compiler |
| `argoDestinations` | Registered Argo destination names |
| `runtime` | Digest-pinned `image` and `platform` (`linux/amd64` or `linux/arm64`) |
| `bootstrap` | Bootstrap-relative Pulumi `directory` and explicit `stack` |
| `kubeContext` | Explicit cluster context for readiness and acceptance |
| `authorizations` | Only already authorized operations: `provision`, `publish`, `activate`, `acceptance`, `recover` |
| `acceptance[]` | Unique `id`, registered `source` and `agent`, executable `argv`, and `effect` (`read` or `write`) |

Each skill entry declares `path` relative to its runtime project, `revision` (content SHA-256),
`tools`, `files` (project-relative references), `executables`, `writes`, and `scenario` (an
acceptance ID for that agent). Never substitute a 40-character upstream commit for the content
hash. The source specification retains upstream URL, commit, license and adaptation ownership.

Version 2 and the installation lock:

Run `hg team compile --plan <file> --dir <bootstrap-root>` after every change to a version 2
plan. It resolves each source ref, writes the lock with the exact commit per source and the plan
digest, and reports which sources changed. Review the lock diff and commit the plan and the lock
together. `plan`, `apply`, `resume` and `publish` refuse a missing or stale lock and a tag that now
resolves to a different commit; they never republish a different commit silently. Rolling back is
reverting the commit that changed the plan and lock; agent data volumes do not roll back.

Operator overlays:

A source (for every agent) or one agent may declare `overlays[]` to append to, override or remove
that agent's skills, tools, connections, files and instructions without forking the source. Each
entry has `id`, `kind` (`skill`, `tool`, `connection`, `instructions` or `file`), `mode` (`append`,
`override` or `remove`) and a `target` under `agent/`. Every mode except `remove` names a
`source` with a credential-free `repository`, a 40-character `commit` and a `path`; a private
overlay adds both `credentialEnv` (planning fetch) and `gitAuthSecretRef` (the build container).
A skill overlay also declares `skill: {tools, executables, writes, scenario}`. Overlays require the
source's `skillPolicy.approvals`. Run `hg team overlays prepare --plan <file> --dir <root>`, have
a human inspect each staged review, and record the decision with `hg team overlays approve`.
Changed overlay content needs a new approval; a new source commit does not. Skills owned by the
source's skill manifest cannot be overridden or removed, and overlays never add npm dependencies.

Optional settings:

- An agent's `environmentBindings` maps names in its `environment` list to distinct operator
  environment references. Use this when multiple agents require the same variable name but
  different values; never put values in the plan. Startup uses each agent's own mapping.

- `routerImage`, `observerUrl`, `workloadEndpoints` (bootstrap-relative file), and
  `terminalCwds` preserve declared routing, browser destinations and workspace defaults.
- `adoptRevision` names the exact reviewed GitOps commit when adopting existing generated
  files without an ownership manifest. Every existing profile must be registered; a changed
  base or a profile belonging to another source refuses adoption. Unmanaged files are retained.
- An agent's `slack` declares `url` and `signingSecretEnv`. Signed challenges must succeed and
  unsigned requests must fail before activation.
- `integrations[]` references existing provider-owned stacks by `id`, `directory`, `stack`,
  and `configFile` (all paths bootstrap-relative). `provision` and `activate` map provider config
  paths to booleans. `outputs` maps operator environment names to arrays of output-object keys.
  The provider owns app identity, membership, and encrypted one-time credential capture.
- `credentials` specifies the current encrypted bootstrap `configFile` and `bindings`, mapping
  environment names to Pulumi config paths. Values pass over stdin to Pulumi encryption.
  Optional `inputs` maps operator environment names to existing namespace-qualified config
  paths. Hg reads them through Pulumi before source resolution and startup; plaintext stays
  in process memory. Use this to reuse managed credentials across deployments and watchers.
  `secretInputs` can instead reference an existing Kubernetes Secret by explicit `namespace`,
  `secret` and `key`, using the plan's kubeContext. Use only the owning agent's managed Secret;
  the CLI reads named Secrets without listing credentials or writing plaintext files.
- `activeConfig` maps bootstrap config paths to activation booleans. Provisioning uses false;
  activation uses the declared values after signed transport checks.

The operator ledger and encrypted phase configs live under `$HG_HOME/teams/<id>/`, outside
Git. Stage evidence includes exact input fingerprints; failures retain scrubbed diagnostics.
The live acceptance command executes inside the selected agent's workload, with
`HG_TEAM_ACCEPTANCE_ID` set to a stable input/scenario key. Write scenarios must use it for
deduplication after an uncertain interruption. Successful scenarios are retained on resume.

Acceptance stdout is one JSON object: `ok: true`, a nonempty `checks` array whose entries all
have `verdict: pass`, and a nonempty `receipts` array. An exit code alone is not proof. Include
actual role/skill behavior, denied actions, relevant Slack replies/handoffs, source-watcher
updates, and Nexus browser observations in the team's scenarios. Do not fabricate receipts.

Activation gates use namespace-qualified dotted paths (for example
`factory:agents.manager.enabled`) with plain boolean values. Provisioning preserves gates
already enabled in the encrypted baseline or a successful earlier apply. Disabling or deleting
existing identities requires a separate migration workflow. Profile removal is refused.

`team plan` includes the actual destination revision and diff; adoption and ownership conflicts
must be resolved there before provisioning. Acceptance read scenarios rerun on resume. Write
scenarios must deduplicate by `HG_TEAM_ACCEPTANCE_ID`; credential changes require renewed
acceptance evidence with the same operation identity.

For an agent with bootstrap-owned application overrides, carry its existing per-application
values under that agent's `appValues` map. The coordinator passes this through the same
validated emitter merge as the provider's `overrides.appValues`; secret values remain
provider-owned references. Omitting required overrides must be repaired before adoption.

An agent may set `appChartSource: {repository: <own-source-url>, revision: <commit>}`. In a
version 2 plan omit `revision`: the chart revision is always the source's locked commit.
This resolves its local application charts from its own registered private source at an
immutable commit. Hg emits chart source and project settings in that owner's deployment
values overlay, preserves other owners, and captures the source's existing Git credential
into the encrypted bootstrap overlay. Bootstrap creates the owner-specific Argo project
and repository credential; this option does not authorize arbitrary repositories.

Application credentials can use bindings targeting
`hermes-gitops-bootstrap:applicationSecrets.<owner>.<app>.<KEY>`. They materialize separately
as `<agent-namespace>-app-<app>-env`, never in agent runtime environments. Keep these bindings
in every apply/reconciler plan: they are a team-managed encrypted overlay, not an environment
YAML field. Application Secrets are protected against deletion when an overlay is omitted;
intentional removal requires a reviewed provider migration. Applications own rotation and
restart behavior, including preservation of encryption keys.
