# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How to manage `_docs/design/`, `_docs/architecture/`, and `_docs/adr/`

These three trees are one system with one direction of flow. Get this right before any
non-trivial change:

```
_docs/design/            what the system SHOULD be   (desired state, future-facing)
        │  every change to a design page goes through…
        ▼
_docs/adr/NNNN-<name>.md WHY the destination changed (one file per decision:
        │                decision + reason + COST)
        ▼  …then the work happens, and…
_docs/architecture/      what the system actually IS (as-built, present tense, honest)
```

The rules, in the order you will hit them:

1. **ADRs exist for exactly one thing: a change to `_docs/design/`.** Changing what we
   intend to build? Write the ADR **first**, as its own file —
   `_docs/adr/NNNN-<kebab-name>.md`, next number in sequence, containing decision, reason,
   and mandatory **Cost** — then update the owning `_docs/design/` page to the new
   destination. A design page never changes without an ADR naming why, and an ADR that
   changes no design page is not an ADR.
2. **Built or changed something?** Update `_docs/architecture/` **in the same PR** — present
   tense, defects included. Architecture describes reality even when reality is embarrassing;
   it must never quietly restate the design.
3. **Never cross the streams.** No "planned" or "will" in `architecture/`; no status or
   history in `design/`; no editing an existing ADR (write a new numbered file that
   supersedes it). `_docs/adr/CHANGES.md` is the **frozen legacy ledger** — 154 pre-reorg
   entries with `#adr-N` anchors; read it, cite it, never append to it. New decisions are
   always new `NNNN-<name>.md` files. The diff between `design/` and `architecture/` IS the
   honest gap list —
   `maintainers/gaps.md` keys off exactly that diff, `maintainers/built.md` carries the
   per-build-unit gates.
4. **None of the three publish.** Only `_docs/wiki/` builds to the site; when a capability
   ships, the *wiki* gains the user-facing claim (see the docs-contract section below). The
   wiki never cites an ADR (`make wiki-adr`).

Full contract: [`_docs/README.md`](_docs/README.md).

## The live environment is documented in the ops repo

This public tree carries no environment specifics. Operators of a real environment keep
the as-built record (machines, layout, push conventions, proof commands) in the private
ops fork beside `infra/environments/<name>.yaml`; read it before touching a live
environment and update it in the same change.

**If you are reading this in `factory-level/harness-hg-ops`**, that is the ops fork: full
history plus the operator overlay (`factory-system-reference.md`, the factory env spec and
its two Pulumi configs, `_old-docs/`). The public repo `factory-level/harness-hg` is one
squashed snapshot cut by `infra/scripts/public-snapshot.sh`. Develop here as before; when a
change should go public, re-cut and push the snapshot (main only, tag the version). Nothing
flows the other way yet: public PRs are cherry-picked into this repo by hand.

## Read the docs contract before you build

`_docs/` is the **published product manual** (seven tabs, built by `make wiki-build --strict`),
and two unpublished ledgers under `maintainers/` carry the present-tense honesty. Confusing the
parts will make you write the wrong code or the wrong page:

| Path | Holds | Use it to |
|---|---|---|
| `_docs/wiki/` (Home, Get Started, Platform, Agent Team Install, Nexus, Runbooks, Reference) | **What ships**, written for a beta user. Capability first, provider second; one page, one job; no planned behaviour in present tense. The only published tree — builds via `_docs/mkdocs.yml` to `_docs/site/`. | Describe what you built |
| `maintainers/built.md` | **How the system is actually built** — one row per build unit with its directory, **the gate that would catch a regression in it**, and Solid / Partial / Built / Absent | Orient before touching anything; several rows say *nothing* would catch a regression |
| `maintainers/gaps.md` | **Every deviation and defect**, keyed to the original design sections, with the five statuses (Absent / Partial / Contradicted / Built / Withdrawn) and an owning build unit | Know what is honestly missing |
| `_docs/adr/` | **The decision ledger**: one `NNNN-<name>.md` per decision (decision, reason, mandatory **cost**), each recording a change to `_docs/design/`. `CHANGES.md` is the frozen legacy ledger (154 pre-reorg records) — cite it, never append to it | Understand why something is the way it is |
| `_docs/wiki/roadmap.md` | What is intended and not done | Put the "not yet" there, never on a platform page |

(`_docs/design/` and `_docs/architecture/` were retired in #604 and **recreated 2026-08-25**
as internal trees — desired state and as-built respectively; `_docs/README.md` states the
contract between the four `_docs` trees. `built.md` and `gaps.md` remain the per-build-unit
tables and keep the old section numbering as their spine.)

Before implementing anything non-trivial, check whether an ADR already decided it — several
decisions deliberately contradict current code (all-changes-through-PR, capabilities,
Grafana-not-Alertmanager, session keys carrying the environment, the GitOps repo as a bounded
authoring surface, `spec.placement` replacing `spec.targetCluster`, Eve as the agent runtime with
Hermes legacy).

`_docs/README.md` holds the full editing rules: one page one job, capability before provider,
explicit ownership tables, one canonical term per concept (`_docs/wiki/vocabulary.md`), every runbook
ends in a proof, negative claims need evidence, diagrams rationed to three, prose hard-wrapped at
100 columns, and **generated files are never hand-edited** (`_docs/wiki/reference/profile-record.md`,
`_docs/wiki/reference/contracts/*.md` except `index.md`, all of `_docs/wiki/reference/cli/`).

**Every PR must update these docs.** If a PR changes behaviour, it changes at least one of: the
owning `_docs/` page (what ships changed), `maintainers/built.md` (a build unit or its gate
changed), `maintainers/gaps.md` (a gap closed, narrowed, or opened), or `CHANGES.md` (a new
decision, or an existing one now Accepted). A PR that changes behaviour and touches no doc is
incomplete.

### Graduate a gap in the SAME PR

This is the working rule, not a suggestion. When you build something `gaps.md` lists, the claim
**moves** from ledger to manual with evidence. Four things happen in the pull request that builds it:

1. **The owning `_docs/` page gains the claim** (capability first: a provider name is never the
   name of a feature). A new page goes under an existing tab and into `_docs/mkdocs.yml`'s nav — an
   unregistered page fails the strict build.
2. **`maintainers/built.md` gains or updates the row**, naming the gate. **`gaps.md` loses or
   downgrades the row.** A gap you closed comes out; a gap you *partly* closed becomes **Partial**
   with what remains stated plainly. Never leave a row claiming something is absent when you
   just built it.
3. **What you did NOT build goes to `_docs/wiki/roadmap.md`** — never as a caveat on a platform page.
4. **A decision gets an ADR with its cost.** Every deferral you made deliberately — a mode that
   refuses to render, a schema bump you batched, a chart that has no consumer yet — belongs in
   the ADR's **Cost** section. That section is where an arc's honest remainder lives, and it is
   what the next developer reads to know what they inherited.

A PR that builds a listed capability and graduates nothing is either incomplete, or it built
something nothing asked for — both are worth stopping over.

Open implementation work is tracked in #127–#164, indexed from #126.

## Commands

**`make test` is most of the gate, but not all of it.** Most of this repository is TypeScript
(`cli/`, `infra/`, `nexus-ui/`, `state/`); `make test` reaches the `nexus-ui` suite
(`dashboard-test`) and drives the CLI end-to-end (`e2e-offline`, #669), but it runs none of the
cli/infra/state UNIT suites. `.github/workflows/ci.yaml` carries those as separate bun jobs —
and the workflows are **manually disabled** (#737), so until they return, running the touched
workspace's `typecheck && test` yourself is the whole gate. A green `make test` after a `cli/`
change is necessary, not sufficient.

```bash
make test          # Python + charts + docs: schema-validate + gitops-template-validate
                   # + chart-test + pytest + wheel-smoke + docs-drift + wiki-build
make pytest        # emitter unit tests only
make chart-test    # nexus-chart drift check + helm lint + byte-diff golden renders
make wiki-build    # mkdocs --strict — also the internal-link checker
```

The TypeScript half — run the workspace you changed, both commands:

```bash
cd cli       && bun install --frozen-lockfile && bun run typecheck && bun test
cd infra     && bun run typecheck && bun test
cd nexus-ui  && bun run typecheck && bun test   # + theme drift, dist byte-compare, size budget in CI
cd state     && bun run typecheck && bun test
```

Single test / narrower runs:

```bash
uv run --group dev pytest -q plugin/tests/test_emitter.py -k required_secrets
cd cli   && bun test tests/reconcile.test.ts
cd infra && bun test src/control-flow/config.test.ts
```

Root `pytest` is deliberately scoped to `plugin/tests` (see `pyproject.toml`). The Pulumi
programs under `infra/pulumi/programs/*` are **self-contained uv projects with their own
lockfiles** — collecting them from the root venv fails at import time. Run them in place:
`cd infra/pulumi/programs/cloudflare-tunnel && uv run --group dev pytest`.

Committed artifacts that are regenerated, not hand-edited. Run these when their source changes
and commit the result, or a gate fails:

```bash
infra/scripts/render-test.sh --update    # after an intentional chart template change
make docs                                # after changing profile.schema.json
cd nexus-ui  && bun run build && bun run build:standalone
                                         # control-plane/nexus/dist/ is committed and byte-compared in CI
                                         # (ORDER MATTERS: build, THEN build:standalone)
infra/scripts/sync-nexus-chart.sh        # control-plane/nexus/chart/files/ is a projection of control-plane/nexus
bun cli/src/main.ts env apply <env>      # Pulumi.<env>.yaml (state/ + infra/) are generated from
                                         # infra/environments/<env>.yaml — never hand-edit them (#674)
```

Not in `make test` — needs Docker, takes 10–20 minutes, runs nightly in CI:

```bash
make drift-test        # drift + decommission against a real k3d cluster
make verify-git-side   # bootstrap stages 1–2, no cluster (this IS a PR gate in CI)
make e2e               # the 12-step dev-loop chain (cli/e2e-local.sh) on a throwaway k3d
```

The three operator-loop walkthroughs are executable (ADR 0170): `make loop-dev` /
`make loop-agent-bundle` / `make loop-ops` run the `cli/loops/` scripts; `loop-agent-bundle`
is cluster-free and rides `make test` inside `e2e-offline`. Deployment-neutrality is a
command now, not a hand procedure: `make record-cmp REF_A=<ref> REF_B=<ref>` renders every
persona profile's record at both refs and byte-compares.

## Architecture

A zero-custom-controller GitOps control plane for AI agents. **Nothing here runs a control loop** —
Argo CD (ApplicationSet + AppProject) and the External Secrets Operator do all reconciliation.

The path from a command to a running pod crosses four subsystems; you cannot understand any one of
them alone:

```
hermes profile install
  → gitops_emitter/__init__.py    _on_profile_install() — the registered hook
  → gitops_emitter/harness/hermes.py   emit(): read intent → check secrets →
                                  deep_merge(defaults, extension, overrides) →
                                  resolve_apps → build_record → validate
  → gitops_emitter/gitrepo.py     publish() — commit or PR
  → the GitOps repo               profiles/<name>/profile.yaml
  → infra/gitops-template/bootstrap/applicationset.yaml
                                  git-files generator, one Application per record
  → harness/hermes/charts/hermes-profile   StatefulSet + one child Application per spec.apps[]
```

(Grep the symbol rather than trusting a line number — `maintainers/built.md`'s copy of this
diagram carries line citations that have drifted.)

Load-bearing facts that are not obvious from any single file:

- **The record is plain Helm values.** A single top-level `spec:` block — no `apiVersion`, no
  `kind`, no CRD. Every field under `spec:` is *also* a valid chart value, which is why there is no
  translation step. Its identity is its **directory name** (`{{.path.basename}}`).
- **The ApplicationSet layers two value files in order**: `cluster-values.yaml` (environment, WHERE)
  then `profile.yaml` (application, WHAT). It uses a two-source Application where the second source
  has no `path` and exists only to give `valueFiles` a `$gitops/` root.
- **Pulumi runs three config-gated stages** (`infra/src/index.ts`): install Hermes + plugin on the
  *operator host* → `hermes profile install` per agent → install the in-cluster control plane.
  Stages 1–2 use `local.Command` and need no Kubernetes provider at all.
- **Hermes runs on the operator host, not in-cluster.** It is a git client that renders records.
- **Two intent files, two purposes**: `distribution.yaml` describes what the *Hermes instance*
  needs (upstream-owned shape); `hermes-gitops.yaml` describes the *supporting workloads*.
- **Chart homes are gated now.** Harness charts live under `harness/{eve,hermes}/charts/`,
  control-plane charts under `control-plane/*/chart` — `infra/charts/` was deleted (ADR 0160
  step 3) and `infra/scripts/check-chart-boundary.py` fails any chart outside its class's
  root. `charts/` holds only the #672 record-carried compat trio (`monitoring`,
  `secret-tester`, `test-page`). `control-plane/nexus/chart/files/` is a *committed
  projection* of `control-plane/nexus` — never edit it directly.
- **`versions.json` is the only place a version pin may exist** (ADR-63). `cli/src/lib.ts` and
  `infra/src/control-flow/config.ts` import it, and `cli/tests/versions.test.ts` greps `cli/src`
  and `infra/src` and fails on any second literal copy of a pin. Adding a version to a `.ts`
  file breaks the build by design.

### `hg` — the operator CLI, and the largest surface here

`cli/` builds `hg` (`bun cli/src/main.ts`, a ~1.2k-line dispatcher plus one directory per subject:
`topology/`, `nexus/`, `communication/`, `backup/`, `reconcile/`, `server/`, `edge/`,
`validate/`, `loops/`, …). It is a developer/operator tool, **not part of the runtime** — but it is where most
new capability lands, and its ~26 bun suites are the gate over it.

`hg <subject> prove` is the recurring pattern: each subject owns an acceptance matrix
(`OBS001..`, `LAUNCH001..`, …) that returns pass/fail/**unknown** — a leg that could not run
reports `unknown`, never a pass. `hg launch prove` aggregates every subject's matrix and adds no
checks of its own. Read the command manifest `cli/src/commands.ts` for the full surface; it is the
single source of truth — main.ts derives its parser and usage output from it,
and `make cli-docs` renders `_docs/wiki/reference/cli/` from it.

## Validate external repos with `hg`, locally, before you PR them

This repository owns the **contract** and the **tool**; the persona repositories
(`<persona>.hermes-gitops`) own **declarations**. Validation flows one way — this repo's code
reads their data — and it runs on your machine, from sibling checkouts. **No CI anywhere runs a
persona repo against this one**, so the loop below is the whole safety net. Run it before
opening a PR in either repo.

```bash
# Sibling checkouts. Everything below assumes:
#   ~/Projects/hermes-gitops/{harness-hg,<persona>.hermes-gitops}
cd harness-hg

# 1. Cheapest: does every authored contract still compile, and to WHAT?
bun cli/src/main.ts topology inspect --dir ../<persona>.hermes-gitops
bun cli/src/main.ts topology plan    --dir ../<persona>.hermes-gitops
bun cli/src/main.ts topology doctor  --dir ../<persona>.hermes-gitops   # lint: literals, prose deps

# 2. Does the real emitter still render each record?
uv run python cli/render_record.py --profile ../<persona>.hermes-gitops/distributions/<p> \
  --name <profile-name> --source local-preview --sha 0000000000000000000000000000000000000000

# 3. The persona repo's own acceptance (goldens, sovereignty refusal, literal counts)
(cd ../<persona>.hermes-gitops && evals/topology-check.sh)

# 4. Only when the change should reach a cluster: the local loop
hg onboard ../<persona>.hermes-gitops && hg up && hg test && hg eval --dir ./evals
```

Two disciplines make this trustworthy:

- **Prove deployment-neutrality by diffing rendered records, not by reasoning.** When a persona
  change is supposed to change nothing that deploys (a contract migration, a comment sweep, a
  declaration-only addition), render each profile's record before and after and `cmp` them.
  `git stash` between the two renders. A byte-identical record is the only honest form of "this
  is safe"; anything else is a hope.
- **Platform PR before persona PR, always.** This repo defines the convention the persona repo
  adopts, so a persona PR that depends on unmerged platform code is unreviewable and unmergeable
  in the right order. Land the contract, then land the adoption.

If a persona repo change makes `topology doctor` report something new, fix the declaration —
do not silence the check. The lint exists because the failure modes it names (a copy-pasted
service URL, a dependency living only in `SOUL.md` prose) have all shipped to production here
before.

## Three "plugin" systems — do not conflate them

The word *plugin* means three unrelated things in this repository, and the directories are one
letter apart:

| Path | Extends | Loaded by |
|---|---|---|
| `plugin/` | **Hermes**, the legacy agent runtime — `gitops_emitter` (the frozen schemas moved to `agent-bundle-contracts/`, #651). Both runtime drivers live in `gitops_emitter/harness/` (ADR-153); the same package carries the **Eve** path (`harness/eve.py`, `emit_cli.py`, ADR-149), which is not a plugin of anything: Eve has no install hook, so Pulumi and `hg` call `python -m gitops_emitter.emit_cli` directly | `hermes profile install`, via a Python entry point (Hermes); the `EveAgents` Pulumi component or `hg` (Eve) |
| `claude-plugins/` | **Claude Code** — was the `hermes-dev` skill set; **removed 2026-08-25** in the final-pass first cut (with `.claude-plugin/marketplace.json`) | nothing — `.claude/skills/` is the remaining Claude Code surface |
| `control-plane/nexus/` + `nexus-ui/` | **The Hermes web dashboard** — the Nexus UI plugin (ADR-42): `control-plane/nexus/` is the installable unit (manifest + committed `dist/` + FastAPI router), `nexus-ui/` its rebuilt source (#666) | `hg nexus install --source <persona-repo> --gitops <clone>` (copies it to `~/.hermes/plugins/hermes-gitops/dashboard/`) + `hermes plugins enable hermes-gitops` |

Same split for skills: `harness/hermes/identity/skills/` are **Hermes** agent skills (capability for a running
agent); `.claude/skills/` are **Claude Code** skills (instructions for a coding assistant). The
formats are not interchangeable.

This repository was `factory-level/hermes-gitops-plugin` until 2026-08-25, when the
final-pass rename (#649) made it `factory-level/harness-hg` (old GitHub URLs redirect).
The old name referred to the **Hermes** plugin — it predated the Claude Code one. The product
name is **Harness Hg** (was Hermes Mercury).

## Rules this codebase enforces

- **Schemas are frozen.** `agent-bundle-contracts/` is versioned by directory. Any change that adds,
  removes, or narrows a field is a **new version directory**; existing ones are immutable once a
  consumer depends on them. Read `agent-bundle-contracts/README.md` before touching one, and
  `_docs/wiki/reference/contracts/index.md` for what each of the declaration surfaces actually is. Two
  things surprise people: the extension's `v1alpha3` blocks are validated then **stripped** by
  the emitter (`render.py` `strip_extension_v3`) so the rendered record stays byte-identical to a
  v1 authoring; and `cli/schemas/evals/` is the one contract that is deliberately *not* a
  deployment surface — a repo with a broken one deploys identically.
- **Fail loudly, early.** A missing required secret or an unset required value stops the pipeline
  *before* anything is written to Git, with an actionable fix message. Preserve this — do not
  soften a hard failure into a warning.
- **Negative fixtures are part of the contract.** `invalid-*` examples must fail validation. When
  you add a schema constraint, add the fixture that proves it rejects.
- **Golden renders use the production render path.** `render-test.sh` layers the exact same two
  value files the ApplicationSet does. Never "fix" a golden by editing the expected output — either
  the change is intentional (regenerate) or it is a bug.
- **Secret values never enter Git**, and error paths scrub aggressively
  (`gitrepo.py:40`, `__init__.py:53` deliberately withholds untyped exception strings).

## Commit convention — conventional commits, and they are load-bearing

**The platform version is DERIVED from commit subjects** (`infra/scripts/derive-version.py`,
`make version`): `feat:` → minor, `fix:` / `perf:` → patch, a `!` after the type or a
`BREAKING CHANGE:` footer → major (counted as a minor while the version is 0.x). A mislabeled
commit lies about the version, and an unparseable one is silently invisible to it.

Every commit subject is `type(scope)!: imperative summary`:

- **Version-moving types**: `feat`, `fix`, `perf`.
- **Non-moving types**: `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `style`, `revert`.
- **Scope** is the subject you touched — `cli`, `infra`, `nexus`, `charts`, `emitter`,
  `design`, `adr`, `wiki`, … Optional but preferred: `feat(cli): …`, `docs(adr): …`.
- Breaking changes: `feat(cli)!: …` **and** a `BREAKING CHANGE:` paragraph in the body
  saying what breaks and what to do about it.
- The body says **why**; the subject says what, imperatively, under ~72 chars.

The parser's type pattern is `[a-z]+` — a hyphenated prefix (`final-pass:`) does not parse
and never counts. Use a real type and put the campaign in the scope: `chore(final-pass): …`.

## Code review with Codex

Codex CLI is installed on this machine. **Use it as a second reviewer on non-trivial changes**
before proposing them — it catches things a single pass misses, particularly contract and
cross-subsystem issues:

```bash
codex exec "Review the staged diff in $(pwd) for correctness and contract violations. Read-only."
```

Prefer it for: schema changes, emitter pipeline changes, chart template changes, and anything
touching the platform/application/environment authority boundaries. Treat its findings as input,
not verdicts — verify each against the code before acting.

## Repo quirks

- **`README.md` drifts.** It has been wrong before in both paths *and* described behaviour — a
  recent audit found 8 dead repo-local references plus a whole section describing skill outputs
  that no longer existed. **Verify any claim in it against the code before relying on it**, and
  prefer `_docs/` as the source of truth. Re-run the audit after touching it:
  ```bash
  grep -oE '\]\([^)h][^)]*\)' README.md | tr -d ']()' | while read -r p; do [ -e "$p" ] || echo "BROKEN: $p"; done
  ```
- **The published wiki builds from `_docs/wiki/` only** (to `_docs/site/`). `_old-docs/` is the archived predecessor — not
  built, not published, useful as source material, and known-stale on secrets and multi-cluster.
- **Never commit `node_modules`.** Every JS workspace here commits a lockfile, so dependencies are
  always reproducible with `bun install --frozen-lockfile`. `cli/` had 874 files committed by
  accident (removed in #165) — vendored dependencies are a bug here, not a convention.
- The docs venv can go stale with a shebang pinned to another clone's path:
  `rm -rf .venv && uv sync --group docs`.
- Real Pulumi stack configs are gitignored by design; only `*.example` templates are committed.
