# Conversational onboarding survey

The user should be able to describe the team they want and answer practical questions while
the coding agent translates their answers into a working repository configuration. The
survey is a conversation, not a YAML form or a fixed roster selector.

## Conduct the survey

First inspect the repository and summarize what you found in a few sentences: what the
product does, existing agent roles, knowledge sources, and declared integrations. Use these
facts to prefill the survey. Distinguish discovered facts from suggested defaults.

Ask one to three related questions at a time using the host's question tool when available.
Offer meaningful repo-specific options with a suggested default, and allow free-text answers.
Use ordinary product language; do not ask the user to choose contract versions or file layouts.
Skip questions already answered by the conversation or repo. For a user who supplied a full
brief, summarize it and ask only about consequential gaps. Do not force every survey stage.

Follow these topics in dependency order, adapting questions to the user's answers:

| Topic | Establish | Example question |
|---|---|---|
| Purpose | Audience, outcomes, and what success looks like | What work should this team take off your hands? |
| Roles | Needed specialists, responsibility boundaries, and coordination | Which roles do you want, or would you like a suggested team based on that goal? |
| Work | Inputs, deliverables, ownership, and handoffs | What starts a task, and what should a completed result look like? |
| Knowledge | Repo docs, runbooks, brand/product context, and additional workspaces | Which existing materials should these agents use as their source of truth? |
| Capabilities | Tools, skills, apps, channels, and execution dependencies | Should this role use the repo's existing integration, or only prepare work for a person to action? |
| Autonomy | What agents may execute, what needs review, and escalation recipients | Which outputs can they act on themselves, and which need your review? |
| Delivery | Team source location, GitOps destination, and local setup versus activation | Where should deployment records go, and which connections should remain pending? |
| Acceptance | Representative tasks and observable expected results | What is one real task each role should handle successfully? |

Selecting an integration expresses configuration intent; it does not establish that the
service or credentials exist. Ask for service identifiers and secret variable names when
needed, never secret values in the survey. Repo facts may supply those identifiers already.
Offer skill recommendations after goals and capabilities are known, explaining each skill's
purpose rather than requiring the user to browse a large catalog.

## Turn answers into configuration

Summarize the resulting team, responsibilities, skills, intended handoffs, and pending
connections before authoring. Resolve material unanswered choices, but do not add a separate
permission checkpoint when the user has already authorized configuration and the answers are
sufficient. Continue useful independent work while waiting for missing answers; do not infer
an answer merely from silence.

Keep the answers in the team document along with their resulting configuration decisions:

- Roles become Eve agent projects, instructions, and role-specific evaluations.
- Knowledge sources become packaged references or documented and tested workspace access.
- Procedures become locally owned skills and reviewed upstream skill packages.
- Apps/channels/handoffs become declarations and runtime capabilities only where implementable
  within the agreed scope; otherwise record the required setup and affected behavior.
- Autonomy choices inform actual tool capabilities and execution controls as well as
  instructions. Do not rely on a markdown instruction to enforce a tool permission boundary.
- Acceptance answers become scenarios with expected outputs and validation evidence.

Allow the user to revise answers mid-onboarding and update dependent decisions. On a later
invocation, read the existing team document, inspect drift, and ask about changed requirements
only. Preserve existing customizations and skill versions unless an answer requires a change.

## Example, not a template

For a social-media repo, the survey might uncover a need for strategy coordination, research,
content engagement, and operational support, with shared brand references and publishing
review. A software repo might instead need a project manager, customer-service, and SRE.
A documentation repo might need only a writer and reviewer. The same survey configures all
three; never copy the social-media team's deployment identities or business workflow as defaults.

The final handoff shows the authored configuration and check results, plus remaining live
setup steps. Make clear whether the user has a validated source setup or an activated team.
