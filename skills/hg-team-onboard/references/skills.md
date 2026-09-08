# Skills and capabilities

## Select from responsibilities

For each agent, map its agreed responsibilities to repo-specific knowledge and reusable
procedures. Search by the task and detected stack, not just the role title. A documentation
team and an incident-response team should not receive the same fixed bundle.

Run the installed Eve CLI from `agents/eve/<name>/src`. Read its bundled `docs/skills.mdx`,
`docs/install-integrations.mdx`, and command help. With versions supporting the skills.sh
registry, the discovery/install flow is:

```bash
npx --no-install eve registry search <task> --registry @skills
npx --no-install eve registry view @skills/<owner>/<repo>/<skill>
npx --no-install eve add @skills/<owner>/<repo>/<skill> --non-interactive
```

Substitute an actual search query and returned skill identifier. Inspect upstream instructions
and supporting files for relevance, license, runtime assumptions, tool requirements, and
conflicts with the repo's instructions. A coding-agent-only workflow may not fit a deployed
Eve agent. Select a small justified set; no suitable upstream match is an acceptable outcome.

If the installed Eve version lacks this integration, use the documented
[skills CLI](https://github.com/vercel-labs/skills) to install the selected package in a temporary
project, then copy its complete reviewed directory into the receiving agent's `agent/skills/`.
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
