# `_docs/` — the documentation system

Four trees, four jobs (final-pass reorg, 2026-08-25):

| Tree | Holds | Tense | Published? |
|---|---|---|---|
| `wiki/` | **The product manual** — what ships, written for a beta user | present, shipping only | **Yes** — the only published tree; self-contained (own `mkdocs.yml`, `overrides/`, `assets/`), `make wiki-build --strict` |
| `design/` | **Desired state** — what the system is intended to be | future-facing, deliberate | No — internal |
| `architecture/` | **As-built** — how the system actually is today | present, honest | No — internal |
| `adr/` | **The decision ledger** — one `NNNN-<name>.md` per decision, each recording a change to `design/` (decision, reason, mandatory cost). `CHANGES.md` is the frozen pre-reorg ledger: cite, never append | historical, append-only | No — internal; the wiki never cites it (`make wiki-adr`) |

The flow between them: `design/` states the destination → work happens → `architecture/`
records what is now true → every change to a `design/` page lands as a new
`adr/NNNN-<name>.md` first. When as-built matches desired, the two trees say the same thing and the diff between
them **is** the honest gap list (`maintainers/gaps.md` keys off exactly that diff).

The unpublished `maintainers/` ledgers (`built.md`, `gaps.md`) remain the per-build-unit
honesty tables; `architecture/` is the narrative they index into.

This file is for contributors and is excluded from the build (it lives outside
`docs_dir`). Everything below governs **`wiki/`**, the manual.

## The wiki

`wiki/` builds to the site via `mkdocs.yml` beside it (`docs_dir: wiki`) and `make wiki-build`. It is
not a drafting workspace.

## What the site is for

The published wiki is a **product manual for a beta user**, not a record of how the system was
built. A reader should be able to answer seven questions and stop reading:

1. What is Harness Hg? → **Home**
2. I am new — how do I get to a running install? → **Get Started**
3. What does the platform provide and control? → **Platform**
4. What must my agent application repository provide? → **Agent Team Install**
5. How do I watch and operate the result? → **Nexus**
6. How do I perform an operational task? → **Runbooks**
7. What is the exact command, field, or file? → **Reference**

Those seven sections are the entire public navigation. Adding an eighth is a decision, not a
housekeeping change.

## The two levels of precision

Confusing these will make you write the wrong thing.

| Kind | Lives in | Holds |
|---|---|---|
| **Conceptual / task** | Home, Get Started, Platform, Agent Team Install, Nexus, Runbooks | What a thing is, why it exists, how it fits, how to do it |
| **Reference** | Reference | Exact commands, fields, defaults, accepted values, precedence, directory layouts |

**A conceptual page never carries schema-level detail** — it links to Reference instead. A fact
stated in both places will diverge, and the conceptual copy is the one that goes stale.

## Writing rules

The wiki is read by a beta user who wants an answer, not a history. Every page follows these:

- **Answer first.** The first line is one bold sentence saying what the reader gets
  (`**What this page tells you:** …` — the llms index reads that lede). Then the detail.
- **Grade-8 English.** Short words. Short sentences, about fifteen words. One idea per sentence.
- **Say the thing, then stop.** No history, no "why we decided", no hedging, no ADR citations.
  The claim stays; the citation goes. `make wiki-adr` fails the build on any ADR reference.
- **Tables for ownership and options. Prose for one idea. Code blocks for commands.**
- **The names.** The product is **Harness Hg**. The operations surface is **Nexus UI**. The repo
  you write is an **Agent Team Repo**. Agents run on a **harness**; Eve is the default. Hermes
  Agent appears once, on Read this first, as a harness with status *Coming soon*.

## Rules

- **One page, one job.** If a page needs "and also" in its summary, it is two pages.
- **Document what ships.** Planned behaviour is not described in the present tense, and an
  unsupported provider is not given a page. Where a gap matters to an operator, say plainly that it
  does not exist — see the SRE and alerting pages for the tone. `maintainers/gaps.md` is the full
  ledger.
- **Capability first, provider second.** Tunneling is the concept; Cloudflare is an implementation
  of it. Backups are the concept; GCS is a backend. A provider name is never the name of a feature,
  because the conceptual page has to survive the second provider.
- **Ownership must be explicit.** Wherever the platform/repository boundary matters, say which side
  owns the thing. Use a two-column table, not prose.
- **One canonical term per concept.** `vocabulary.md` is the register. Do not invent a synonym on a
  page; add the term there or use the existing one.
- **Every runbook ends in a proof.** A procedure that cannot be verified is not finished. Prefer a
  `hg … prove` verb; if the only check is a human looking at a browser, say so explicitly.
- **Negative claims need evidence too.** "Nothing does X" should say what was searched. An
  unqualified absence is the easiest claim to get wrong and the hardest to notice.
- **Diagrams are rationed.** Three in the whole site: one system flow (Home), one network topology
  (Platform), and at most one lifecycle flow. Use a table for ownership, precedence, and provider
  support. A diagram that restates a list earns nothing.
- **A behaviour change updates the docs.** A pull request that changes behaviour and touches no
  documentation is incomplete.
- **A new decision gets an ADR**, with its cost stated. A decision with no stated cost is usually a
  decision that has not been thought through.

## Outside the published site

`adr/CHANGES.md` keeps its path so its `#adr-N` anchors and existing URLs stay citable from pull
requests and the internal trees, but it sits outside `docs_dir` (`_docs/wiki/`) like the rest of
`adr/`, `design/`, and `architecture/` — and **the wiki does not cite it at all**
(`infra/scripts/check-wiki-adr.sh`). A reader of the manual gets the claim; the ledger is ours.

Two more maintainer documents live in `maintainers/`, **outside this tree** and outside the
published site: `built.md` (the design-to-reality crosswalk) and `gaps.md` (the Absent /
Partial / Contradicted defect ledger). Both are keyed to the current `design/` pages.

Cite them freely from a pull request. Do not cite them from a reader-facing page as though the
reader is expected to follow.

## Mechanics that are easy to break

- **Hard-wrap prose at 100 columns.** Not for rendering — MkDocs does not care — but so a six-word
  change produces a six-word diff. Never wrap table rows or mermaid blocks.
- **`mkdocs.yml` raises `validation.links.anchors` to `warn`** so `--strict` catches a link to a
  renamed heading. Without that setting MkDocs logs it at `info` and the build passes clean.
- **The schema and CLI reference pages are generated. Never hand-edit them.**
  - `reference/profile-record.md` and `reference/contracts/*.md` (all but `index.md`, the
    hand-written router) — run `make docs` after changing any schema under `agent-bundle-contracts/`
    or `cli/schemas/`; `make docs-drift` fails on stale.
  - `reference/cli/` (the whole directory, one page per command) — run `make cli-docs` after
    changing `cli/src/commands.ts`; `make cli-docs-drift` fails on stale, and also fails if a
    dispatch case exists that the manifest never mentions (or vice versa).
- **`make docs` does not build the site.** `docs*` targets are the generators; `wiki*` targets are
  the site.
