# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the platform / infrastructure engineer.** They run the cluster and own its GitOps
already — Argo CD, an AppProject, a repo of manifests, a PR review habit. They meet Mercury while
looking for a way to give AI agents a deployment path that fits the machinery they operate rather
than adding machinery beside it. Their first question is not "what can the agent do" but "what does
this put on my cluster, and what do I have to keep running to hold it there".

Agent authors are a real second audience — they write the declaration that becomes the record — but
the platform engineer is who the product is designed for and who approves what lands.

The reference deployment is the "factory" business: a small technical team running four marketing
agents. Its operator installs the reference configuration and works the fleet through Nexus;
Calvin, the business owner, reads the system through the manager agent and Nexus (grade-eight
reading level preferred for updates).

## Product Purpose

Harness Hg is a Hermes Agent plugin that turns an agent declaration into a GitOps record. One
command renders the agent and everything around it into Git as a pull request; Argo CD applies that
record and keeps it applied.

Success is that a fleet of agents is fully described in Git — reviewable, reproducible, and
reversible by revert — with no component of Mercury running a control loop to make that true.

**Nexus is the product's dashboard**: a Fleet Canvas whiteboard, an Agents directory, Alert
Routing, Backups, and the control-plane (System) surface. Its success criterion (epic #558): a new
user installs the reference configuration, opens Nexus, and can understand and demonstrate the
system without implementation noise — one real problem stands out because healthy noise recedes.
Nexus renders truth from authoritative sources and never fabricates state ("truth over cosmetic
green"); provenance is attached to every data section.

## Positioning

**The whole agent, not just the pod.** The agent, the tools it ships, the events it publishes and
the people who approve it are rendered as *one record*. The surrounding fleet is declared rather
than assembled by hand — the thing a neighboring product would have to rebuild, not rename.

Two facts make the claim cheap to trust and belong with it wherever it is made:

- **Nothing here runs a control loop.** Argo CD (ApplicationSet + AppProject) and the External
  Secrets Operator do all reconciliation. There is no custom controller to operate.
- **The record is plain Helm values** — a single top-level `spec:` block, no CRD, no `apiVersion`,
  no `kind`. Every field is already a valid chart value, which is why there is no translation step.

## Operating Context

- **Hermes runs on the operator host, not in-cluster.** It is a git client that renders records.
- The path a command travels: `hermes profile install` → the emitter → a commit or PR in the GitOps
  repo → an ApplicationSet's git-files generator → one Application per record → a StatefulSet plus
  one child Application per app the profile declares.
- The environment (WHERE) and the application (WHAT) are layered as two separate value files, in
  that order. Environment authority and application authority are deliberately not the same surface.
- Operators work through `hg`, the CLI in `cli/`. `hg <subject> prove` is its recurring pattern:
  each subject owns an acceptance matrix returning pass / fail / **unknown** — a check that could
  not run reports `unknown` and never a pass.
- Persona repositories (`<persona>.hermes-gitops`) hold declarations; this repository holds the
  contract and the tool. Validation runs locally from sibling checkouts, in one direction.

### Web surfaces that exist today

| Surface | What it is |
|---|---|
| `landing/` | The public site: a brochure homepage, a features area, an about page and a devlog (ADR-133). No build step, no dependencies, no lockfile. Not deployed by anything in this repository. |
| `control-plane/nexus/` | The Nexus UI plugin for the Hermes web dashboard — an installable unit with a committed `dist/` and a FastAPI router, built from `nexus-ui/`. React arrives from the host SDK (`nexus-ui/src/sdk.ts`), never `import react`; all styling rides the generated theme (`nexus-ui/src/theme/theme.css`) under `nx-*` classes; views are capability- and flag-gated (ADR-43/84). |
| `_docs/` → GitHub Pages | The published wiki, built with mkdocs `--strict`. A separate site from `landing/`. |

## Capabilities and Constraints

- **Beta.** Recorded in the docs; the marketing site no longer states maturity (ADR-133, at the
  design specification's direction).
- **Vocabulary is product law:** "People & Groups", never "cohort"; "Alert Routing" replaced
  "Communication" as the Nexus view (#550); Hermes-owned records are marked by the small Hermes
  sphere. The landing feature page named "Communication" describes the declared event surface
  (the wiki's "Webhooks and events") and predates #550 — a known naming tension.
- **`landing/` has no build step and no dependency manifest.** Opening `index.html` from the
  filesystem renders the finished site; copying the directory to a static host deploys it. Its only
  cache control is a hand-bumped `?v=N` token that must agree across all thirteen documents and the
  stylesheet’s font URLs.
- **No gate covers `landing/`.** No make target, no CI job, no test. Everything true about it is
  true by hand.
- **The landing hero demonstrates a CLI surface that does not exist yet** (ADR-70). The real binary
  is `hg`; `hermes-hg` matches nothing. The recorded launch rule is that nothing launches until `hg`
  fulfils every promise the hero makes, and `hero.js`'s `SCENES` array is that checklist.
- **Schemas are frozen and versioned by directory.** Any change that adds, removes or narrows a
  field is a new version directory.
- **Fail loudly, early.** A missing required secret or unset required value stops the pipeline
  before anything is written to Git, with an actionable fix message. Never soften a hard failure
  into a warning.
- **Secret values never enter Git**, and error paths scrub aggressively.
- **Undecided:** where `landing/` is hosted. It is source here and a deployment target chosen later
  (ADR-69).

## Brand Commitments

- **Name and lockup:** Harness Hg, written as `Hermes` + `Hg` — the element symbol for mercury.
  In Nexus the same identity is `nexus-ui/src/primitives/HermesMark.tsx` (`HermesMarkLive`/`HermesMark`); the
  sphere is the Hermes identity and (#554) the control-plane ownership marker, and ADR-104 added
  animated agent avatars.
- **The mark is the contour sphere** (`landing/contour-sphere.js`), a membrane marched from noise
  onto a `<canvas>` at runtime. It is vendored from the Claude Design project and re-copied rather
  than hand-edited. There is no static export of it, which is why the favicon is a hand-drawn
  16px approximation and why there is no `og:image`.
- **Two type families:** Figtree for display and body, JetBrains Mono for anything that is a literal
  you would type.
- **The canvas object system is imported, not invented.** `Canvas Object System copy copy 2.dc.html`
  in the Claude Design project *Hermes GitOps Nexus specification* is a live source of truth for the
  eight object kinds and their three channels — **shape means kind, colour means ownership and never
  status, material means authorship**. Nothing enforces the coupling.
  (*`Mercury Landing.dc.html` in the same project is retired* — ADR-69.)
- **Voice:** plain, specific, and willing to state its own costs. Every ADR carries a Cost section;
  the devlog is written in the first person and drafted from real commits.

## Evidence on Hand

Real, and citable:

- `_docs/` — 18 design pages, one architecture page per build unit indexed by `BUILT.md`, and
  `gaps.md` recording every deviation and defect.
- `_docs/adr/CHANGES.md` — the decision record, each entry carrying its cost.
- `landing/devlog/` — four entries, each sourced from a real commit body or ADR (`#283`, ADR-44,
  `#284`, ADR-63). No entry describes work that did not happen.
- The Fleet canvas on the landing page, which is labeled *example fleet · illustration* — because it
  is one.

Absent, and never to be invented:

- **No users, adopters, logos, testimonials, case studies, benchmarks or uptime figures exist.**
  Their absence is a fact, not a gap for design to fill.
- No pricing, licensing tier, or deployment claim beyond what is recorded above.

## Product Principles

Nexus-side rules from epic #558, binding wherever they apply: exceptions first (healthy detail
recedes, problems get the visual budget); capabilities before vendors at the first level of
hierarchy; every number inspectable and every claim sourced; the whiteboard communicates and never
mutates runtime topology; quiet green is earned by correct configuration, never rendered
cosmetically. No fabricated metrics anywhere — absences render as "unknown"/"unavailable", never
green.

## Landing-surface Principles

1. **The record is the product.** Everything a fleet is must be visible in Git and reversible by
   revert. A capability that cannot be declared does not exist.
2. **Add no machinery.** Reconciliation belongs to Argo CD and External Secrets. Anything that would
   need a control loop of its own is the wrong answer.
3. **Real artifacts are the proof.** Docs, decisions, the devlog and the object system are what the
   product argues with. Anything shown as a demonstration is labeled as one.
4. **Say the cost.** A deliberate deferral is recorded, not hidden; `unknown` is reported rather
   than rounded to a pass.
5. **Design for the operator's first question** — what this puts on the cluster, and what has to
   keep running to hold it there.

## Accessibility & Inclusion

Browser acceptance for Nexus includes 200% zoom and narrow viewports; interactive elements carry
aria labels. On the landing side, the page's existing behaviour is the working floor and should not regress: a skip link, the self-rewriting demonstration marked
`aria-hidden` with its content restated in static text, full function without JavaScript, and a
single still frame under `prefers-reduced-motion`.
