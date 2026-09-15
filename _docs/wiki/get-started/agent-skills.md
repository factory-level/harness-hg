# Agent Skills

**What this page tells you:** how to give a coding agent team onboarding and the `hg` loops.

A skill is a folder with a `SKILL.md` that tells an agent when and how to do one job. This
repo ships `hg-loops` for the operator loops and `hg-team-onboard` for configuring a repository
as an Eve agent team with its own roles and skills.

## Install

Uses the open skills format and the [skills.sh](https://skills.sh) CLI. Works with Claude
Code, Codex, Cursor and the other agents that CLI supports.

```bash
npx skills add factory-level/harness-hg
```

Choose the skills to install, or select onboarding directly:

```bash
npx skills add factory-level/harness-hg --skill hg-team-onboard
```

Add `-g` to install for every project. Add `-a claude-code` to pick one agent.

## Check it loaded

```bash
npx skills list
```

Your selected skills appear in the list. With `hg-loops`, ask your agent to "validate this
repo with hg" and watch it run `hg validate --dir`.

## Configure a team in your repo

Ask your coding agent to use `hg-team-onboard` with the target checkout and your team's goal.
For example: "Configure this repo with a project manager, customer-service agent, and SRE."
You can choose any roles and team size; the skill derives the team from your requirements.

The skill guides you through a repo-aware survey: goals, roles, work, knowledge sources,
capabilities, autonomy, delivery, and acceptance. It asks a few related questions at a time,
suggests options from the repo, and skips answers you have already supplied. You can revise
answers during onboarding or resume from the saved team document later.

It records your answers and the team specification,
and uses the existing [team scaffold](agent-team-repo.md). It authors repo-specific procedures
and selects relevant upstream skills from skills.sh. Runtime skills live in each Eve agent's
`src/agent/skills/`; the coding assistant's installed onboarding skill is a separate package.

Onboarding preserves existing app files and agent customizations, reconciles workspace
bindings, and checks contracts, builds, skill packaging, and available behavior evaluations.
The resulting team document records skill sources, check results, and integration prerequisites.
This is the conversational workflow for configuring a team repo like `social-media.harness-hg`,
adapted to your own domain and roles. The outcome is validated team source; deployment and
live service activation use the
[operator loops](index.md).

## Version-lock deployed skills

Declare external skills per agent in `harness-hg/skills.yaml` beside its `agent.yaml`, using
the [agent skills contract](../reference/contracts/agent-skills.md). Each package names its
source repository, exact tag or commit, package root, entrypoint, resources and capabilities.

Use `hg skills prepare --dir <repo> --agent <name> --subject <repository-url>#<name>` to stage
the complete package and review fingerprint. Review the content before recording a human
decision with `hg skills approve`. `hg skills install` requires that matching decision in a
bootstrap-owned approval file outside the source repository. Commit the installed content and
generated lock; `hg skills check` verifies it offline. Use `hg help skills` for all flags.

Set the bootstrap source's `skillPolicy.approvals` to require matching approval during team
planning and deployment. Content, version and capability changes invalidate approval.
External requirements derive from the manifest; bootstrap `agents[].skills` lists local skills.
An empty external manifest supports review of local requirements supplied with `--requirements`.
Skills provide instructions; registered tools and permissions still determine what an agent can do.

## Operator guidance

Everything on [Get Started](index.md), compressed: `hg --help` lists commands by loop,
`--json` gives one document, `hg validate` before anything touches a cluster, and an
`unknown` leg is never a pass. The source is
[`skills/hg-loops/SKILL.md`](https://github.com/factory-level/harness-hg/blob/main/skills/hg-loops/SKILL.md).
