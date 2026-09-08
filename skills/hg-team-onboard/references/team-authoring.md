# Team authoring

## Scaffold against the current contract

Read `hg help bundle`, `hg help validate`, and the target's existing declarations. Use the
installed CLI's scaffold rather than copying a production team's channels, credentials,
provider bindings, schedules, or business logic.

Build the agent list from the agreed roles. Names must be unique DNS-1123 labels of at most
40 characters starting with a lowercase letter (the CLI's additional constraint); keep the
directory name, package name, and profile references identical.
For example, the following illustrates one roster, not a default:

```bash
hg bundle init /path/to/target --agents eve:project-manager,eve:customer-service,eve:sre --gitops https://github.com/example/target.gitops.git
```

Replace both paths/URLs and the entire roster with the established inputs. The CLI derives
the team name from the target directory, removing `.harness-hg`; use its naming constraints
when choosing a new directory. For an existing checkout whose basename fails validation,
scaffold in a temporary validly named directory and merge the intended files into the target.
Preserve existing team identity; never rename the application checkout to satisfy the CLI.

The scaffold writes team declarations under `harness-hg/`, and per-agent declarations and
Eve source under `agents/eve/<name>/{harness-hg,src}`. It generates npm lockfiles and validates
the scaffold. It skips existing files, so a successful rerun is not a merge of team settings.

The scaffold generates lockfiles but does not install dependencies. Install each new agent's
locked dependencies (`npm ci` in its `src/` directory) before reading `node_modules/eve/docs/`
or invoking `npx --no-install eve`. For an existing agent, use its package manager and preserve
the lockfile. These installed docs define the runtime APIs for the following authoring steps.

## Existing repositories and repeated onboarding

Inspect potential path collisions before scaffolding. Where existing `harness-hg/`, `agents/`,
or `evals/` content belongs to another system, stage the scaffold separately and resolve the
layout with the user instead of overwriting that system. Do not migrate legacy Hermes agents
implicitly; add Eve agents alongside compatible existing declarations.

After scaffolding, reconcile the actual requested additions:

- Preserve the team identity, GitOps destination/branch, and existing agent customizations.
  Keep `team.yaml`'s harness list consistent with the authored agents.
- Add new agents to applicable workspace bindings without dropping existing profiles or
  duplicating repository entries. New own-source mounts default to read-only; retain existing
  access policies. Avoid whole-repo write access solely because a role might draft changes.
- Merge missing ignore rules for agent `node_modules/`, `.output/`, and `.eve/` into an existing
  `.gitignore`; the scaffold skips it. Preserve existing README and evaluation content.
- Never replace an existing agent merely because its requested role has a matching name.
  Update the agreed responsibilities in place. Resolve incompatible identities before editing.
- A rerun with unchanged requirements should introduce no duplicate declarations, new roles,
  refreshed upstream packages, or unrelated formatting changes.

## Make roles specific to this repo

In each agent's `src/agent/instructions.md`, state its purpose, ownership, expected inputs and
deliverables, evidence sources, handoffs, and completion criteria. Use actual repository paths
and documented service names. Tailor the package description and Nexus card accordingly.
Keep substantial conditional procedures in packaged skills instead of duplicating them in
every instruction file.

For each responsibility, distinguish the procedure from its execution capability. Configure
repo-context access through the installed Eve version's documented workspace/sandbox/tool
surface; a platform mount alone does not prove the model can read it. If all needed context
can be packaged as skill references, use that simpler option and document how to refresh it.
Supporting skill files and executable helpers may require a sandbox; verify against the
installed Eve docs. Never assume the coding assistant's tools exist inside a deployed agent.

Preserve an established model/provider configuration. For new agents, keep the current `hg`
scaffold defaults unless the user chooses otherwise. Declare required environment variables
by name in `agent.yaml`; keep secrets out of tracked files. Keep dependency lockfiles current
and respect the platform's Eve runtime pin.

Document handoffs as intended behavior unless a real transport/tool is implemented and tested.
If essential capabilities require unavailable credentials or external setup, record those
requirements and the affected scenarios. Do not write fictitious endpoints or automatic
schedules to make an otherwise disconnected team appear operational.

See the current [agent-team authoring guide](https://factory-level.github.io/harness-hg/docs/get-started/agent-team-repo/)
for contract details. Leave optional deployment surfaces absent unless the agreed team needs
and can configure them. No new platform schema or CLI command is needed for role variation.
