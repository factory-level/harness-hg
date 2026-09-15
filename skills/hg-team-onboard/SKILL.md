---
name: hg-team-onboard
description: Configure an arbitrary Harness Hg agent team through a repo-aware survey, author its runtime skills and acceptance scenarios, and prepare the persisted handoff to bootstrap apply. Use for the source-configuration phase of team onboarding.
---

# Onboard an agent team

Turn the target repository into an Eve agent team using the existing Harness Hg contracts.
Derive the team from the user's purpose: there is no fixed roster, mandatory manager, or
required team size. Project manager, customer-service, and SRE are one possible team.

This skill runs in the coding assistant configuring the repository. The skills it authors or
installs for the deployed agents live in each Eve project's `agent/skills/` directory.

## Survey the user and establish the team

Read [the onboarding survey](references/survey.md) and use it as the conversational front door.
The experience is an LLM working through team configuration with the user, then authoring
the result, as one could configure a repo like `social-media.harness-hg`. Do not assume that
example's marketing roles, tools, or environment apply to another team.

Inspect the target's repo instructions, Git status, application manifests, documentation,
existing `harness-hg/` declarations, agents, and skill provenance before proposing changes.
Do not read secret values to discover integrations. Use declarations and variable names.

Resolve from the repo or conversation, asking only for missing decisions:

- Team purpose, intended users, desired outcomes, and each agent's responsibilities.
- Roles and ownership boundaries; propose roles if the user has supplied only an outcome.
- Expected inputs, outputs, handoffs, tools, and action permissions.
- Target checkout and its separate GitOps destination URL/branch. The target contains agent
  source; the GitOps destination receives generated deployment records.

Record the resulting specification in `docs/agent-team.md`, or update the existing team
document. Include a role table, repo evidence paths, skill inventory and provenance,
survey answers and unresolved questions, capabilities still needing setup, and acceptance
scenarios. Keep this outside `harness-hg/`,
which is a platform contract surface. Do not invent a destination URL or claim a placeholder
is deployable; ask for the real value if it cannot be discovered.

## Author and equip

1. Read [team authoring](references/team-authoring.md) before scaffolding or extending the team.
   Use the installed `hg` command and its help, or a user-supplied platform checkout. If neither
   is available, follow the official [tool installation guide](https://factory-level.github.io/harness-hg/docs/get-started/install-the-tools/).
2. Tailor each agent's instructions, repo context, and role procedures. Read the installed
   `node_modules/eve/docs/README.md` and relevant guides before adding Eve code. Keep the
   runtime pin compatible with the platform; do not upgrade Eve as an onboarding side effect.
3. Read [skills and capabilities](references/skills.md) to stage version-locked upstream skills
   and local procedures. Obtain required approval of exact content before installation.
   Keep coding-assistant and deployed-runtime skill approval decisions separate.
4. Read [validation](references/validation.md), run the applicable checks, and fix failures
   introduced by onboarding. Preserve pre-existing work and report unrelated failures.

## Completion

Deliver the configured team source, its specification, and evidence of validation. Record
the machine-readable installation requirements beside `docs/agent-team.md`: stable source
and role identities, required environment names, Git Secret bindings, actual tools and write
destinations, skill content hashes, and executable live acceptance scenarios. Preserve
already supplied decisions and authorization; do not ask the survey again on resume.
Distinguish
passing static/build checks from runtime evaluations that require credentials or services.
List unresolved prerequisites with concrete next steps; a blocked check is never a pass.

This is phase one of two. For a launch request, continue with `hg-team-bootstrap` in the
bootstrap checkout; source validation is not the end of onboarding. Provisioning,
publication, channel activation and acceptance remain within the user's recorded scope.
A role description or installed skill does not establish an integration or grant permission.

GitOps repositories are generated output. Never manually edit or commit them, including
compiler output prepared in a scratch checkout. Fix the source, bootstrap declaration or
platform operation and let `hg team apply` publish the complete projection. Do not turn
missing automation into a customer-specific script or a third user workflow.
