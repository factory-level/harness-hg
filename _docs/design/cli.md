# CLI — `hg`

`hg` is the operator interface, and its acceptance contract is three walkable loops. Every
command maps to a loop; every loop is walkable end to end with `hg` alone; a command that
serves no loop does not ship ([#650](https://github.com/factory-level/harness-hg/issues/650)).

| Loop | Meaning | Front door |
|---|---|---|
| **ops** | running your own environment | `hg env new` |
| **dev** | iterating on the harness-hg platform | `hg dev` |
| **agent-bundle** | configuring an external repo against the contract | `hg bundle init` |

The front doors are guided orchestrations of the underlying verbs — resumable, idempotent,
and each step names the command it ran, so the entrypoint teaches the loop
([#673](https://github.com/factory-level/harness-hg/issues/673)). `hg env new` owns
day-0 from stack-init onward; only the root of trust stays manual
([#676](https://github.com/factory-level/harness-hg/issues/676)).

## Surface discipline

`hg reconcile` supports optional `--instance <name>` selection for independent repository
watchers on one host (ADR 0182). Each watcher owns its checkout, state, timer, and status;
all watchers in one Harness Hg home serialize applies through the existing lock. Omitting
the flag retains the existing single-repository behavior.

- One meaning per verb, everywhere it appears — `prove`, `emit`, `doctor`, `restore` each
  mean exactly one thing, enforced by lint from the command manifest
  ([#656](https://github.com/factory-level/harness-hg/issues/656)).
- `cli/src` is one directory per subject; the manifest `commands.ts` is the single source
  the parser, help, and docs derive from
  ([#657](https://github.com/factory-level/harness-hg/issues/657)).
- `hg --help` leads with the three front doors and groups the surface by loop.
- Unmapped commands die (`bundle`, `dash load`).

## `cli/test-env/`

Resources that let `hg` launch platform resources and the Nexus dashboard into an ephemeral
test environment for AI harnesses to use — the dev and agent-bundle loops' proving ground,
disposable by design.

## The grammar

One meaning per verb, registered as `VERBS` in `cli/src/commands.ts` (a sub's verb is the
last word of its name) and enforced bidirectionally by `commands-grammar.test.ts` plus the
cli-docs coverage gate ([ADR 0161](../adr/0161-cli-grammar.md)). The pinned meanings:
`emit` writes files into a repo · `publish` sends to a live surface · `prove` emits a
ProofResult · `doctor` diagnoses declared-vs-actual · `restore` replays from an artifact.
Renamed to conform — `event publish`, `chatops tail`, `platform backup prove` (the old
spellings and their warning aliases were deleted by
[#672](https://github.com/factory-level/harness-hg/issues/672); ADR 0161 records the
mapping). The
loop tags below are manifest data (`loops:`), and `hg --help` + the reference index group
by them.

## The loop map

Every command group in `cli/src/commands.ts`, classified. Multi-loop is allowed; `unmapped`
is the kill list; `harness-legacy` follows Hermes into `harness/hermes/`
([#652](https://github.com/factory-level/harness-hg/issues/652)). The tags become manifest
data enforced by the grammar lint ([#656](https://github.com/factory-level/harness-hg/issues/656)).

| Command | Loop(s) | Note |
|---|---|---|
| `onboard` · `up` · `dev` · `test` · `expose` · `down` · `open` · `reset` · `status` · `identity` | dev | the local ephemeral environment, end to end |
| `validate` | dev · agent-bundle | the no-cluster contract gate, both sides of the contract |
| `logs` · `debug` | dev · ops | same verbs, local or live |
| `prompt` | dev · agent-bundle | one prompt against a deployed agent |
| `dash` | dev · ops | `dash load` is **unmapped — dies** |
| `eval` | agent-bundle · dev | the repo's deterministic eval suite |
| `platform` · `launch` · `reconcile` · `edge` · `env` · `connection` · `server` · `grafana` · `auth` · `communication` | ops | environment lifecycle, proofs, backup, tunnel, config |
| `backup` | ops · agent-bundle | routines are bundle-declared, operated by ops |
| `event` | ops · agent-bundle | the communication plane: operate it / declare against it |
| `workspace` | ops · agent-bundle | repository bindings, authored and verified |
| `gitops` · `topology` · `observability` · `nexus` · `chatops` | agent-bundle | the external repo's authoring surface |
| `agent` | ops · dev | engine-neutral incl. `prove`/`evals` (ADR 0177); `apply` refuses on Eve with the reason |
| `harness` | ops | the declared harness registry, listed |
| `cron` | ops · dev | engine-neutral surface; Hermes-native depth, honest refusals on Eve (ADR 0177) |
| `bundle` | **unmapped — dies** | ADR-28 preview, superseded by the real bundle contract |
| `help` | all | meta; leads with the three front doors |

Not a command but on the same kill list: the `uptime-push` helper
(`cli/src/uptime-push.ts`, called from `hg platform` backup paths) and the `external-uptime`
Pulumi component — both orphaned by the `uptime/` cut.

## Walkthroughs — each loop from zero

Every step a human performs outside `hg` is a **gap**; every gap below is owned by a filed
phase-5 issue. Each walkthrough IS an acceptance run (ADR 0170,
[#670](https://github.com/factory-level/harness-hg/issues/670)): the scripts under
`cli/loops/` execute these sequences with asserted outcomes, and the scripts — not this
prose — are the surface a merge must keep green.

| Loop | Executable run | Front door | Gates |
|---|---|---|---|
| dev | `cli/loops/dev-loop.sh` (= `cli/e2e-local.sh`) | `make loop-dev` | nightly (live-loop.yaml) |
| agent-bundle | `cli/loops/agent-bundle-loop.sh` | `make loop-agent-bundle` | `make test` (via e2e-offline) |
| ops | `cli/loops/ops-loop.sh` — the prove segment; portable subset off-loop until #740 | `make loop-ops` | operator-run against the live environment |

(`hg bundle init` is live since ADR 0172; the former ADR-28 `bundle` verb died unmapped in
the loop census, and the two registers are unrelated.)

**ops** — ① root of trust by hand (bucket + KMS — manual **by design**,
[#676](https://github.com/factory-level/harness-hg/issues/676)) → ②③ **`hg env new`**
(ADR 0172): the spec (`environment.yaml`, #674) declares the environment, the front door
inits both stacks with assembled URIs, generates config, runs `pulumi up`, and hands off —
resumable, `--dry-run` hand-executable → ④ `hg server preflight` · `bootstrap` · `register` → ⑤ `hg launch
prove`, `hg edge prove` · `publish` → ⑥ `hg connection set` · `prove`, `hg workspace
verify` → ⑦ `hg platform backup` · `schedule` · `verify`, `hg reconcile status` → ⑧
`hg auth prove`, `hg grafana prove`. Docs land as a loop quickstart
([#675](https://github.com/factory-level/harness-hg/issues/675)).

**dev** — ① toolchain install by hand (`ensureTools` reports every miss at once); cold,
**`hg dev <repo>`** absorbs the rest of the onramp (ADR 0172) → ②
`hg onboard` → `hg up` → `hg dev` (one command when cold) → ③ `hg validate` · `test` · `eval` → ④ `hg logs` ·
`prompt` · `debug` · `dash` → ⑤ `hg open` · `status` → `hg down` · `reset`. Walkable today
from ②.

**agent-bundle** — ① **`hg bundle init <dir>`** (ADR 0172, shape per ADR 0178): the team's
`harness-hg/` (identity, destination, workspaces), one Eve agent under
`agents/eve/<name>/{harness-hg,src}` per `--agents` entry, the lockfile, and a self-run
`hg validate --dir` gate → ② author the declaration (one file per concern; `hg topology emit`
defaults to `harness-hg/destination.yaml`) → ③
`hg validate`, `hg topology plan`, `hg observability` → ④ `hg nexus compile` · `emit`,
`hg chatops plan` · `render` → ⑤ `hg workspace doctor` · `test`, `hg gitops doctor` ·
`upgrade` → ⑥ `hg eval`, `hg prompt` against the test environment. Walkable today from ②.

The phase-5 front doors closed the step-① gaps (ADR 0172); the docs half is
[#675](https://github.com/factory-level/harness-hg/issues/675). Toolchain INSTALLATION and
the root of trust remain by-hand, both by design.
