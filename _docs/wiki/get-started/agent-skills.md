# Agent Skills

**What this page tells you:** how to give a coding agent the `hg` loops as a skill.

A skill is a folder with a `SKILL.md` that tells an agent when and how to do one job. This
repo ships one, `hg-loops`: the three loops, their front doors, and their proofs.

## Install

Uses the open skills format and the [skills.sh](https://skills.sh) CLI. Works with Claude
Code, Codex, Cursor and the other agents that CLI supports.

```bash
npx skills add factory-level/harness-hg
```

Add `-g` to install for every project. Add `-a claude-code` to pick one agent.

## Check it loaded

```bash
npx skills list
```

`hg-loops` is in the list. Then ask your agent to "validate this repo with hg" and watch it
run `hg validate --dir`.

## What the skill knows

Everything on [Get Started](index.md), compressed: `hg --help` lists commands by loop,
`--json` gives one document, `hg validate` before anything touches a cluster, and an
`unknown` leg is never a pass. The source is
[`skills/hg-loops/SKILL.md`](https://github.com/factory-level/harness-hg/blob/main/skills/hg-loops/SKILL.md).
