# ADR 0178 — Agent-team repositories: the `harness-hg/` contract surface, harness-nested agents, dual ownership with the bootstrap

**Status:** Accepted
**Changes:** `_docs/design/platform.md` (the contracts root), `_docs/design/vocabulary.md`
(distribution, bundle declaration, agent-team repository), `_docs/design/cli.md` (the
agent-bundle loop's step ①)

## Decision

An agent-team repository — the repository a team authors against the platform, called the
"agent application repository" until now — takes one shape, defined by one rule and one new
contract family:

1. **`harness-hg/` at any level is exactly what the platform reads.** Everything beside it
   belongs to the harness or the team. The repository root carries one `harness-hg/` for the
   team; every agent carries one for itself. Nothing else in the tree is a contract.
2. **Agents nest per harness: `agents/<harness>/<name>/`.** The harness is read from the path
   and declared positively in `agent.yaml` (`harness: eve | hermes`, the names under
   `harness/<name>/harness.yaml`, ADR 0162) — never inferred from a marker file, never
   expressed by absence. The `<name>` directory IS the agent's identity and must equal the
   payload's own name (`package.json` for Eve, `distribution.yaml` for Hermes).
3. **`src/` beside `harness-hg/` is the payload the harness installs**: the Eve npm project, or
   the Hermes profile (`distribution.yaml`, `SOUL.md`, `config.yaml`, `skills/`, `cron/`). The
   emitted record's `sourceSubdir` points at it.
4. **The per-agent declaration splits per concern** — `agent.yaml`, `backup.yaml`,
   `endpoints.yaml`, `dashboard.yaml`, `test.yaml` — and **team-shared concerns lift to the
   team's `harness-hg/`**: `team.yaml`, `apps.yaml`, `topology.yaml`, and the relocated
   `bundles.yaml`, `communication.yaml`, `connections.yaml`, `workspaces.yaml`,
   `capabilities.yaml`, `destination.yaml`. Routes live **with their source**: a route from an
   app output sits under that app in `apps.yaml`; a route from an inbound webhook sits in the
   receiving agent's `endpoints.yaml`. `communication.yaml` stays aliases and transport.
5. **Dual ownership with the bootstrap.** The team declares what it brings and needs — its own
   mounts, the layout it is built for (regions, no cluster names), the connections and
   capabilities it requires. The environment spec (`infra/environments/<env>.yaml`, now
   `v1alpha2`) declares what it **grants** — targets per region, DNS, policy, capability
   providers, additional mounts with credentials. The topology compiler unions the halves; a
   name on both sides is a refusal (TOPO018), a team region granted no target is a refusal
   (TOPO019). One `envDir` per repository: team files always come from `harness-hg/`
   (`environment/` for a legacy repo); an `--environment` file supplies the cluster half only.
6. **One new contract family, `agent-bundle-contracts/agent-team/v1alpha1/`**, holding only
   the shapes that are new (team, agent, apps, endpoints, backup, test, target-free topology).
   Every concern whose shape did not change keeps its frozen schema and `$id` and merely
   relocates its authored file. Every new document carries `apiVersion` + `kind`.
7. **`hermes-gitops` is a dead name.** No new file is called `hermes-gitops.yaml`. The legacy
   readers stay: a repository without `harness-hg/team.yaml` is read exactly as before.
8. **Records do not change.** The CLI and the emitter fold the new files into the v5 raw shape
   at load time; `hermesprofile/v1alpha3`, `eveagent/v1alpha2` and `topology-plan/v1alpha3`
   are untouched, and a migrated repository renders byte-identical records (`make record-cmp`
   is the proof).

The target tree, as the contract reference and `repo-scaffolds.md` print it:

```
<team>.harness-hg/
  harness-hg/                  # TEAM contract surface
    team.yaml  topology.yaml  apps.yaml
    bundles.yaml  communication.yaml  connections.yaml  workspaces.yaml  capabilities.yaml
    destination.yaml
  agents/
    eve/<name>/
      harness-hg/              # AGENT contract surface
        agent.yaml  backup.yaml  endpoints.yaml  dashboard.yaml  test.yaml
      src/                     # package.json, agent/
    hermes/<name>/
      harness-hg/  (same five)
      src/                     # distribution.yaml, SOUL.md, config.yaml, skills/, cron/
  charts/  dashboard/  evals/  # team assets, read by convention
  everything else              # the team's own; the platform ignores it
```

**Supersedes** ADR 0158's `.harness-hg/` dot-directory as the bundle-declaration home and
ADR 0172's `.harness-hg/destination.yaml` path (the dot-directory was declared and never built;
the destination file moves to `harness-hg/destination.yaml`, the old path stays readable), and
the `.harness-hg/` line in ADR 0157's target tree. **Amends** ADR-149 (the harness is a
positive declaration by path and `harness:`; the v5 `runtime` block's absence-means-Hermes is
legacy-only), ADR-150 (apps and backup are authored in `apps.yaml` and `backup.yaml`, realized
unchanged), ADR-123 (the distribution identity is `team.yaml` `name`; `bundles.yaml` v1alpha4's
`distribution` block is legacy), ADR-33 (the environment topology gains a target-free team form
whose targets are a bootstrap grant), and ADR 0162 (the declared harness names are the `harness`
enum).

## Reason

The complaint was literal: agent bundles are hard to read. The live team repository was
hand-built convention — Eve under `agents/`, Hermes under `distributions/`, the harness inferred
from which marker file happened to exist, and one 355-line `hermes-gitops.yaml` per agent mixing
apps, endpoints, routes, backup, topology and deployment, with the same shared board declared
under one agent and its routes under another. Cluster topology lived in a directory the default
loader never read, and the one gate that did read it lost `bundles.yaml` and `workspaces.yaml` on
the way, so the committed golden plan was bundle-blind. Harness membership had three key names
across contracts (`runtime`, `engine`, `harness`) and no positive form for Hermes.

This is a contractual developer-experience problem: the contracts define the tree, and the
scaffold follows. One rule a newcomer can hold in their head (`harness-hg/` is what the platform
reads) beats any amount of documentation of the old conventions; one file per concern beats one
file per agent; a positive `harness:` beats inference; and splitting "what the team brings" from
"what the environment grants" gives the two authors — team and operator — their own files with a
refusal, not a precedence rule, where they overlap.

## Cost

- **Two layouts stay readable indefinitely.** Every literal `hermes-gitops.yaml` site in the
  CLI, the emitter and the Pulumi program now routes through one layout helper; the legacy path
  is a branch of it, not a deleted one. `make retired-paths` does not learn the old filename —
  the legacy section of the scaffold reference must still be able to say it.
- **The catalogue's `contract.yaml` is `agent.yaml` alone for a new-layout agent.** The
  catalogue copied the whole authored file byte-for-byte; the split means the per-agent file no
  longer carries apps or routes. Provenance is unchanged (the inputs hash covers every file).
- **The Hermes stage-2 hook sees only the payload.** `hermes profile install --subdir` stages
  `src/` alone, so the emitter cannot find `../harness-hg/` from the payload it is handed. The
  Pulumi `hermes-agent` component clones the source at the sha and exports
  `HERMES_GITOPS_CONTRACT_DIR`; the emitter **refuses** a `src/` payload with no contract rather
  than degrading to a record with zero apps — the silent form of that degradation is an Argo
  prune of the team's board and publisher.
- **A new-layout Hermes agent carries `expose` in `endpoints.yaml`** for as long as the
  destination deploys agent Service ports from the record's `expose` block (the endpoints
  ApplicationSet generator is staged, not promoted, on factory). The compiler refuses the block
  on an Eve agent. It retires with the legacy generator.
- **Grants reach the topology compiler only.** Targets, DNS, policy and capability providers
  are unioned there; `grants.workspaces` is validated by the spec schema and carried on the
  loaded environment, but no consumer compiles it yet - the workspace compiler runs in the local
  loop (`hg up`, `hg validate`, `hg workspace`), which reads no environment spec. Threading it
  is deferred until a bootstrap-granted mount exists.
- **A legacy topology override's directory is still a named environment variant.** A file
  beside the override (`environments/<name>/communication.yaml`) wins for that file alone;
  every other team file comes from the team dir. The old rule replaced the team dir wholesale,
  which is how the persona golden lost its bundles.
- **Hermes agents are not scaffolded.** `hg bundle init --agents hermes:<x>` refuses with the
  copy-from-`examples/` path (ADR 0172's Eve-only rule stands; a scaffold cannot honestly fill
  `env_requires`, a model or skills).
- **`apps.yaml` has one binding: the owner.** An app private to one agent and an app the whole
  team shares are declared the same way; nothing marks the difference beyond the owner.
- **Seven frozen schemas gain a sentence** naming their new home — description-only edits under
  ADR-140, each proven validation-neutral in the change that made them. Their family names
  (`environment-*`) keep saying where the file used to live.
- **The environment spec takes a version** (`cli/schemas/environment/v1alpha2`) for one optional
  block; `hg env` reads both versions and the factory spec is not bumped until it grants
  something.
- **The per-agent `test.yaml` is the first schema that file ever had**, and it is validated by
  `hg validate` only — nothing in the cluster sees it, and its `behavioral` list is still a
  reserved key with no runner, as before.
