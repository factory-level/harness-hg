# Vocabulary — the canonical register

One name per concept, on every surface: the platform source tree, the emitted destination
repository, the persona repos, control-plane labels and metrics, and the CLI grammar. The
wiki's [`vocabulary.md`](../wiki/vocabulary.md) is the **reader-facing** register and keeps
its own explanations; this page is the **internal** register that governs identifiers. The
two never disagree on a term.

Executed by [#649](https://github.com/factory-level/harness-hg/issues/649); the per-identifier
dispositions (rename / alias / frozen-legacy, each with its owning issue) live in
[`maintainers/final-pass/naming-scheme.md`](../../maintainers/final-pass/naming-scheme.md).

## The register

| Concept | Canonical name | It is | Not called |
|---|---|---|---|
| profile | **agent profile** | one declared agent; one profile becomes one running instance | "agent" alone for the whole deployment |
| bundle | **agent profile bundle** | several profiles sharing one runtime pod, homogeneous per harness | — |
| record | **record** (profile record, EveAgent record) | the generated `spec:`-only values file — data, never hand-authored | manifest, CR |
| distribution | **distribution** | a Hermes persona's installed profile — its `src/` under `agents/hermes/<name>/` in an agent-team repo (legacy: `distributions/<persona>/`) | deployment, release |
| environment | **environment** | one declared destination's full configuration, source-of-truth `environment.yaml` | stack, cluster config |
| destination | **destination** | where agents run — the server and its cluster; its watched repo is the **destination repository** | target environment |
| harness | **harness** | the driver for the platform-infra options: emitter path, image, chart, gateway declaration (`harness/<name>/`) | plugin, runtime |
| runtime | **agent runtime** | the process a harness deploys inside the pod (Eve; Hermes frozen) | harness |
| connection | **connection** | a declared communication edge between agents or workloads — one CLI subject, singular | connections (as a second subject) |
| event | **event** | a typed message on the communication plane, one envelope everywhere ([#655](https://github.com/factory-level/harness-hg/issues/655)) | alert (alerts route; events flow) |
| declaration | **bundle declaration** | what an agent-team repo states about itself: the `harness-hg/` directories at the root and under each agent ([ADR 0178](../adr/0178-agent-team-contract-surface.md)) | `hermes-gitops.yaml` (the frozen legacy filename), `.harness-hg/` (never built) |
| agent-team repository | **agent-team repository** | the repository a team authors: `harness-hg/` + `agents/<harness>/<name>/{harness-hg,src}` | agent application repository, persona repo, bundle repo |

**Harness vs runtime is a real distinction, not a synonym pair.** The harness is the
repo-side driver (what `harness/<name>/` owns); the runtime is the process it puts in the
pod. Eve is both a harness and a runtime; the words still never substitute for each other.

## Rules

- **No new `hermes-*` name for a generic platform concept**, anywhere — source, emitted
  output, labels, metrics, namespaces. Existing ones are dispositioned in the naming-scheme
  ledger; frozen surfaces keep their names until a new contract version replaces them
  ([#651](https://github.com/factory-level/harness-hg/issues/651)).
- **A compatibility alias exists only where a live system references the old name**, and
  each alias carries its removal condition (deleted at the latest by
  [#672](https://github.com/factory-level/harness-hg/issues/672)).
- **Renames are deployment-neutral by proof**: render every profile's record before and
  after, `cmp` byte-identical — or the rename ships with the contract version that changes
  the bytes, never silently.
- **The CLI grammar uses register words as subjects** — one meaning per verb, one directory
  per subject ([#656](https://github.com/factory-level/harness-hg/issues/656),
  [#657](https://github.com/factory-level/harness-hg/issues/657)).
