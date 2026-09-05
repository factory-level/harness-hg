# 0176 — The wiki publishes its own markdown, and every page carries a copy-page action

**Decision.** The published wiki serves each page's **markdown source at its own
source path** (`/platform/identity.md` beside `/platform/identity/`), plus
`/llms.txt` (an index of every page with its lede as a one-line summary) and
`/llms-full.txt` (the corpus in one file). A second native `hooks:` entry,
`infra/scripts/mkdocs_llms_hook.py`, captures each page at `on_page_markdown` —
after exclusions and after every other hook has had its say, so what is published
is what the page actually rendered from — and writes all three at
`on_post_build`. No plugin and no new dependency: the `docs` group stays
`mkdocs-material>=9.5` alone, the same reasoning as `mkdocs_version_hook.py`
beside it. Every page then carries a **page-actions bar** — a breadcrumb from
`page.ancestors`, and a split control offering *Copy page*, *View as Markdown*,
*Open in ChatGPT* and *Open in Claude*. The three links are ordinary `href`s
rendered at build time from `page.file.src_uri | url` and `page.canonical_url`,
so nothing has to reconstruct a URL from the directory-URL scheme at runtime;
only the clipboard write and the menu toggle are scripted, delegated and re-bound
per navigation through Material's `document$`. `make wiki-build` asserts
`llms.txt` and `index.md` exist, so a hook that silently stops running fails the
build instead of quietly un-publishing the surface. The design page this changes
is [`_docs/design/landing-docs-repo.md`](../design/landing-docs-repo.md).

**Reason.** The site is HTML and the source is markdown, and until now the only
way to take a page away as markdown was to scrape the rendered page and hope.
That is the wrong shape for how these docs are actually read: the audit that
preceded this work found six pages denying a capability that had shipped, and the
fastest way to check such a claim is to hand the page to something that can read
it. `llms.txt` is becoming the convention for exactly that (AG-UI and Vercel both
publish one), and the cost of joining it here is one hook — the markdown already
exists in memory at build time.

**Cost.**

- **`_docs/site/` roughly doubles in file count** and gains about 630 KB
  (`llms-full.txt` is the bulk of it). That tree ships in the in-cluster wiki
  image ([ADR 0167](0167-wiki-in-cluster.md)), so the image grows with it.
- **The `.md` files are a second indexable surface for the same content**, with no
  canonical tag pointing back at the HTML. If the site is ever indexed publicly,
  that is duplicate content we chose.
- **The summaries in `llms.txt` are only as good as the ledes.** They are parsed
  from each page's `**What this page tells you:**` / `**Outcome:**` opener; a page
  written without one gets a bare title, and nothing fails.
- **`navigation.instant` is now on**, which makes per-page JavaScript a standing
  constraint: anything added later must re-bind through `document$` rather than
  assume one execution per page load. (A single `document` listener does survive
  instant navigation today — measured — so this is a discipline, not a live bug.)
- **The bar is a theme override.** Material for MkDocs warns that MkDocs 2.0
  removes the plugin system and rewrites theming with no migration path. This is
  a small, re-implementable surface — one template, one hook, one script — but it
  is on the wrong side of that boundary, and the pin to Material 9.x is now
  load-bearing for it.
