---
name: hg-loops
description: Drive the Harness Hg operator CLI (`hg`) through its three loops - build an agent team locally (dev), author an Agent Team Repo against the contract (agent-bundle), and host a real environment (ops). Use when asked to onboard, validate, deploy, test, prove, or scaffold anything with hg.
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
5. Do not hand-edit generated records. Change the declaration under `harness-hg/` and rerun.

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

```bash
hg bundle init <dir> --agent <name> --gitops <url>
hg validate --dir <dir>
hg topology plan --dir <dir>
hg topology emit --dir <dir> --output <destination-clone>
hg gitops doctor <destination-clone>
```

## The ops loop

```bash
hg env new <name> --dry-run   # print every step; apply nothing
hg env new <name>
hg reconcile status
hg backup verify
hg launch prove
```

The CLI reference is generated from the same manifest the parser uses:
https://factory-level.github.io/harness-hg/docs/reference/cli/
