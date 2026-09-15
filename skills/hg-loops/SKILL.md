---
name: hg-loops
description: Operate Harness Hg's local development, contract validation and environment maintenance loops. Route agent-team onboarding and launch requests through hg-team-onboard and hg-team-bootstrap.
---

# hg loops

`hg` is the Harness Hg operator CLI. Every command belongs to one of three loops. Each loop
has one front door and ends in a proof.

| Loop | Front door | Ends with |
|---|---|---|
| dev: run a team on a local throwaway cluster | `hg dev <repo>` | `hg test` exits 0 |
| agent-bundle: author a repo, no cluster | `hg bundle init <dir>` | `hg gitops doctor` reports 0 findings |
| ops: host a real environment | `hg env new <name>` | `hg launch prove` has no failures and no `unknown` legs |

## How to work

1. Run `hg --help`. It lists every command by loop. `hg help <command>` prints one command's
   flags.
2. Prefer `--json`. Every reporting command answers with one JSON document. The few that do
   not (`hg up` is one) say so by name.
3. Gate before you deploy. `hg validate --dir <repo>` needs no cluster and reports every
   failure at once, with the file and field to fix.
4. Never call a proof green with an `unknown` leg. `unknown` means the check could not run.
5. Never manually edit or commit GitOps repositories, including generated compiler output.
   Change source or bootstrap declarations; the supported publisher owns GitOps commits.

## The dev loop

```bash
hg onboard <repo>   # register the repo with the local loop
hg up               # k3d cluster + Argo CD + Grafana + the agents
hg test             # acceptance tiers against every agent
hg dev              # watch loop: an edit commits, renders, and syncs
hg status           # what runs, and every local URL
```

`hg reset` tears the agents down. `hg reset --nuclear` deletes the cluster too.

## The agent-bundle loop

For repo-specific team creation or extension (choosing roles, authoring their instructions,
and installing runtime skills), use `hg-team-onboard` when installed. It handles arbitrary
team composition as phase one; `hg-team-bootstrap` owns phase two through apply and live
acceptance. A launch request continues through both phases. If unavailable, install it with
`npx skills add factory-level/harness-hg --skill hg-team-onboard`, or use the authoring guide:
https://factory-level.github.io/harness-hg/docs/get-started/agent-team-repo/

```bash
hg bundle init <dir> --agent <name> --gitops <url>
hg validate --dir <dir>
hg topology plan --dir <dir>
hg team plan --plan teams/installation.yaml --dir <bootstrap-root>
hg team apply --plan teams/installation.yaml --dir <bootstrap-root>
```

## The ops loop

For external runtime skills, use `hg skills prepare`, review the complete package and resolved
version, record the explicit human decision with `hg skills approve`, then `hg skills install`
and `hg skills check`. Never self-approve or download unpinned skills during runtime startup.
Follow user-required approval gates before updating coding-assistant skills too.

```bash
hg env new <name> --dry-run   # print every step; apply nothing
hg env new <name>
hg reconcile status
hg backup verify
hg launch prove
```

The CLI reference is generated from the same manifest the parser uses:
https://factory-level.github.io/harness-hg/docs/reference/cli/
