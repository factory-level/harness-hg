# Validate the authored team

## Source and contract checks

From the target repo, use the installed `hg` command (or the equivalent command from the
platform checkout) and confirm command syntax with help:

```bash
hg validate --dir .
hg topology plan --dir .
hg topology doctor --dir .
hg workspace doctor --dir .
hg nexus compile --source .
```

Run the existing application's relevant checks when onboarding changes application-facing
configuration. Inspect the final diff for overwritten application content, secret values,
duplicate identities, missing workspace recipients, and untracked dependency/build artifacts.
Confirm the GitOps URL/branch are actual agreed inputs, not scaffold placeholders.

Install each Eve project's locked dependencies and run its build using the repo's package
manager (`npm ci` then `npm run build` for a fresh `hg` scaffold). Inspect compiled skill
discovery and packaged resources: each expected skill should belong to the intended agent,
and referenced resources should survive compilation without machine-local symlink targets.
If build-time prewarming needs unavailable sandbox infrastructure, report that build as
blocked, with the failing prerequisite; contract validation cannot substitute for it.

## Behavior scenarios

Read the installed Eve evaluation guide before authoring tests. Give each role at least one
repo-grounded task with an observable expected deliverable. Include a boundary or handoff
scenario where responsibilities overlap. Test tool behavior with fixtures/mocks when live
services are outside scope; distinguish those results from model/runtime evaluations.

Examples for a project manager, customer-service, and SRE team are backlog prioritization
from repo evidence, an answer grounded in actual product documentation, and an incident
triage plan grounded in a runbook. For other teams, replace these scenarios completely.

Do not treat the scaffold's empty evaluation suite, generated role wording, or a successful
build as evidence of behavior. Run available evaluations; identify skipped/blocked scenarios
and their exact requirements without using production credentials implicitly.

## Completion evidence

Update the team specification with the resulting roster, skill inventory/provenance,
validation commands and outcomes, and any remaining integration setup. Separate:

- Source/contract validation and per-agent build results.
- Behavioral evaluation results, including mock-only coverage and blocked runtime checks.
- Operator steps for deployment and activation, when requested next.

Check that repeating onboarding with the same requirements preserves customized instructions,
installed skill versions, existing agents, and unrelated app files. Extending a team must add
new recipients to applicable workspace bindings without removing the original recipients.

Emitting deployment records and proving a GitOps checkout are separate operator steps. When
explicitly in scope, use `hg topology emit` and `hg gitops doctor` through the existing
agent-bundle loop. Never claim a running or connected team from source checks alone.
