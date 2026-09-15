# Landing, Docs, and the Repo's OSS Surface

## Landing

`landing/` is the hand-written promotional site and devlog for Harness Hg — static HTML/CSS/
JS, authored directly, independent of the documentation build. It sells the product; it
never substitutes for the manual. The primary action opens the Nexus UI demo; the secondary
one opens the local agent-team quickstart. Preserve the current visual identity and URLs.

Current product copy uses the vocabulary register and describes implemented behavior.
Animated commands use the shipping CLI grammar; their scenes are explicitly illustrative.
Each page supplies canonical and social metadata with a shared, locally rendered preview
image. The landing gate checks metadata, links, assets and command grammar; browser review
covers responsive layout, themes, keyboard access and reduced motion.

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

`README.md` introduces the product, shows the runnable quickstart, and routes readers to the
manual, demo and contribution instructions. Its repository map describes the current tree.

- Community documents carry the Harness Hg identity and describe the public snapshot workflow.
- The ops fork retains operational documents in its export overlay. Public documentation must
  make sense and build without them.
- `public-snapshot.sh --verify-only` exports committed HEAD and gates the public tree without
  fetching the public Git remote, creating tags or release notes, or publishing. A successful gate leaves a clean export.
- Working command aliases, schemas, API paths and cluster identifiers remain compatible.
  Historical decision and design evidence retain their original names.
