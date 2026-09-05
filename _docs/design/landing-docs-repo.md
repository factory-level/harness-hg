# Landing, Docs, and the Repo's OSS Surface

## Landing

`landing/` is the hand-written promotional site and devlog for Harness Hg — static HTML/CSS/
JS, authored directly, independent of the documentation build. It sells the product; it
never substitutes for the manual.

## Docs

`_docs/` is a four-tree system with one direction of flow:

| Tree | Job | Published |
|---|---|---|
| `design/` | desired state (this tree) | no |
| `adr/` | one `NNNN-<name>.md` per change to `design/` — decision, reason, cost | no |
| `architecture/` | as-built, present tense, honest | no |
| `wiki/` | the product manual | **the only published tree** |

The wiki is self-contained — `_docs/mkdocs.yml`, its own theme overrides and assets,
strict build output at `_docs/site/` — and ships in-cluster, version-matched to the running
platform ([#664](https://github.com/factory-level/harness-hg/issues/664)). Its landing
page routes by intent to three loop quickstarts: run / build / configure
([#675](https://github.com/factory-level/harness-hg/issues/675)).

It also publishes **its own source**: every page is served as markdown at its source path,
indexed by `/llms.txt` and concatenated into `/llms-full.txt`, and every page carries a
copy-page action offering the markdown to the clipboard, to a raw view, or to an assistant
([ADR 0176](../adr/0176-wiki-markdown-endpoints.md)). A manual that can only be read as
HTML is a manual that has to be scraped to be checked.

## Repo README and OSS configuration

`README.md` is the authoritative scaffold outline — the target directory structure and the
refactor's status live there, and new work has an obvious home before it is implemented. The
community surface stays current and truthful:

- `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS` carry the harness-hg identity.
- GitHub issues are the work tracker: the final-pass epic
  ([#646](https://github.com/factory-level/harness-hg/issues/646)) with `phase-0`…`phase-5`
  labels ordering the work.
- Cross-repo changes keep the standing rule: platform PR merges first, persona PR second,
  proven by rendering each profile's record before and after and `cmp`-ing them.
