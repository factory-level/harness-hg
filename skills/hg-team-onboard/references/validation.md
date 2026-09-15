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

The production fallback sandbox requires the scaffold's locked `just-bash` dependency.
Bootstrap's `hg team` startup check uses the selected digest-pinned runtime image and
architecture, with no workstation Docker/KVM socket. It builds from a fresh dependency
install and requires `/eve/v1/health` to become ready. A successful build is insufficient.
For private repositories, declare and validate `gitAuthSecretRef`; an existing Secret does
not mount itself into the workload.

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
- The persisted bootstrap handoff and current deployment/activation stage, when in scope.

Check that repeating onboarding with the same requirements preserves customized instructions,
installed skill versions, existing agents, and unrelated app files. Extending a team must add
new recipients to applicable workspace bindings without removing the original recipients.

Bootstrap apply owns complete projection and publication through `hg team`; topology,
workspace and Nexus emission are internal operations, not separate manual commits.
Never claim a running or connected team from source checks alone. A required unknown
stage leaves onboarding incomplete.
