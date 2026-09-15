# Skills and capabilities

## Approval and version locking

Use `hg help skills` to check the installed CLI. External runtime packages use the independent
`hermes-gitops.factorylevel.dev/agent-skills/v1alpha1` contract, kind `AgentSkills`, in
`agents/eve/<agent>/harness-hg/skills.yaml`. Each entry declares `name`, `source`, `resources`,
`tools`, `executables`, `writes` and `scenario`. Source declares a credential-free repository,
package root, relative SKILL.md entrypoint, and an exact tag or 40-hex commit. Shared plugin
references belong under the selected package root and must be included in resources.

Run `hg skills prepare --dir <source> --agent <agent> --subject <repository-url>#<agent>`.
It stages complete packages outside the source repository and emits a review fingerprint and
resolved lock without executing or installing the skill. Present the complete staged content,
license, recipient, version and capabilities. When approval is required, obtain explicit approval
of that exact content. A project plan does not approve unseen instructions. Never self-approve.

After explicit approval, use `hg skills approve --review <review.json>
--approval-file <bootstrap-file> --approver <human> --fingerprint <reviewed-sha256>`.
Then `hg skills install --dir <source> --agent <agent> --review <review.json>
--approval-file <bootstrap-file>` and `hg skills check --dir <source> --agent <agent>`.
Commit the installed package and generated skills.lock.yaml. Keep approval records outside
the source repository. Ordinary preparation preserves locks; upgrades require `--update <names>`.

Local procedures also require review when requested. Stage them outside discovery paths first.
Include local requirements with `--requirements <yaml-file>` when preparing a review; an empty
external manifest supports local-only reviews. Set the bootstrap source's
`skillPolicy.approvals` to its approval file. External requirements derive from the manifest;
only local requirements belong in bootstrap agents[].skills. Content or capability changes
invalidate approval. Coding-assistant skill updates are a separate approval decision.

## Select from responsibilities

For each agent, map its agreed responsibilities to repo-specific knowledge and reusable
procedures. Search by the task and detected stack, not just the role title. A documentation
team and an incident-response team should not receive the same fixed bundle.

Run the installed Eve CLI from `agents/eve/<name>/src`. Read its bundled `docs/skills.mdx`,
`docs/install-integrations.mdx`, and command help. With versions supporting the skills.sh
registry, the discovery flow is:

```bash
npx --no-install eve registry search <task> --registry @skills
npx --no-install eve registry view @skills/<owner>/<repo>/<skill>
```

Substitute an actual search query and returned skill identifier. Inspect upstream instructions
and supporting files for relevance, license, runtime assumptions, tool requirements, and
conflicts with the repo's instructions. A coding-agent-only workflow may not fit a deployed
Eve agent. Select a small justified set; no suitable upstream match is an acceptable outcome.

If the installed Eve version lacks registry discovery, inspect upstream repositories directly
and use the version-locked `hg skills` lifecycle above for installation.
Do not upgrade the runtime to obtain an installer. Keep the package self-contained; do not
leave a symlink to a developer's global skills directory or a temporary staging directory.

Review installer changes before running the agent. A setup continuation may request credentials,
linking, or service activation: record the missing requirement rather than automatically
expanding onboarding into provisioning. Report network/authentication failures explicitly and
continue independent local authoring; do not describe an unavailable package as installed.

## Package and maintain

Eve discovers runtime skills under each project's `agent/skills/`. Installing this onboarding
skill in the target's `.agents/skills/` makes it available to the coding assistant; that alone
does not equip its deployed agents. Each intended recipient must receive its own runtime skill
package, or an explicitly configured shared extension supported by the installed Eve version.

For a locally authored package, use `agent/skills/<skill-name>/SKILL.md` with YAML `name` and
`description` frontmatter. Write the description as a precise activation condition. Link
supporting references where needed, and include scripts only when executable behavior is
necessary and verified. Keep local adaptations in separate repo-owned skills instead of
editing vendored upstream instructions in place.

Preserve upstream references, scripts, assets, and license files. In the team specification,
record each skill's recipient, installed path, purpose, source URL, ownership (local/upstream),
and resolved revision or content hash. Preserve installer-created lock/provenance files where
available; do not invent entries in an installer's lock format. Commit the reviewed package
content, so a clean checkout does not depend on an unpinned download at runtime.

If a selected name already exists, inspect its provenance. Reuse the same package, or resolve
the collision explicitly without replacing a locally customized skill. Do not refresh
upstream content on an ordinary onboarding rerun; upgrades are a separate requested change.

## Capability check

Skills supply instructions, not tools or permissions. For each selected skill, check whether
the receiving agent has its required tools, sandbox support, executable dependencies, and
repository access. Configure locally available capabilities with the installed Eve docs;
record external setup dependencies and affected behavior as pending. Do not copy local
credential values, assume access to the host shell, or claim a support channel or incident
integration works because its procedure is installed.

In the installation requirements, enumerate every installed skill, its project-relative
directory, content SHA-256, required tools, referenced files, executables, write destinations,
and a representative deployed acceptance scenario. Compute the content hash with
`hg team inspect <skill-directory> --json`, not a guessed upstream commit.
Keep upstream URL/revision and license provenance in the human specification as well.
`hg team plan` rejects missing references, escaping symlinks, content drift, and undeclared
installed skills. Production startup checks executables; deployed scenarios must exercise
real tools and permission denials. Declared capability names alone do not prove runtime access.
