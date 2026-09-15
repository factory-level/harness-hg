# Harness Hg public site

Static HTML, CSS and JavaScript. The site introduces Harness Hg, opens the Nexus UI demo,
and points engineers to the local quickstart. It has no runtime dependencies, third-party
scripts, analytics or external font requests.

## Files and ownership

| Path | Purpose |
|---|---|
| `index.html` | Homepage: hero, illustrative fleet scenes, features and demo links |
| `features/`, `about.html` | Current product capabilities and attribution |
| `devlog/` | Historical accounts; use the manual for current behavior |
| `styles.css` | Shared responsive layout, light and dark palettes, local fonts |
| `hero.js` | Illustrative scenes, rolling CLI commands, pause control and menus |
| `theme.js` | Theme preference shared with the manual |
| `contour-sphere.js` | Vendored brand-mark renderer; preserve its source provenance |
| `assets/` | Illustrations, Nexus UI screenshot and social preview PNG |
| `fonts/` | Vendored fonts and their license information |

The homepage has one primary action, **Open the live demo**, repeated at the close.
**Build an agent team** is the secondary action. Feature pages link to their owning manual
page. Keep the existing page URLs when changing headings or navigation labels.

## Copy and taxonomy

Use **Harness Hg**, **Nexus UI**, **Agent Team Repo** and the terms in the
[vocabulary register](../_docs/wiki/vocabulary.md). A bundle is several agents in one runtime
pod; the team repository declares agents, apps and capabilities. Eve is the default harness;
Hermes Agent is deprecated for existing installations.

Describe shipping behavior. Verify commands against `cli/src/commands.ts` and feature claims
against their implementation. Backup availability is separate from recovery evidence. Do not
promise automatic pull requests or backup coverage for undeclared routines.

The animated fleet is an illustration, not command output. Its first command uses the real
`examples/agent-team` quickstart; other paths are illustrative repositories. The static text
and initial command must remain useful with JavaScript disabled.

## Visual maintenance

Keep the existing fonts, contour mark and ownership colors. `--accent` is for graphics;
`--accent-ink` is for readable text. Maintain both light and dark token sets. The contour mark
uses `--mark-ink` and `--mark-spec` from the active palette.

The portrait canvas uses the same media query in `hero.js` and `styles.css`: at most 760px
wide and at least 840px tall. Objects and wires share one stage. Check short phones as well
as tall ones after changing text or coordinates. Preserve keyboard menus, the skip link,
pause controls and reduced-motion behavior.

Asset cache tokens are currently `?v=19`. When changing a shared asset, bump references
across every HTML page and the font URLs in CSS together.

## Build and preview

```bash
make site
mkdir -p /tmp/hg-site-preview
ln -s "$PWD/site" /tmp/hg-site-preview/harness-hg
python3 -m http.server --bind 127.0.0.1 --directory /tmp/hg-site-preview 8080
# Open http://127.0.0.1:8080/harness-hg/
```

Use the `/harness-hg/` prefix to exercise the same links as GitHub Pages. The artifact contains
landing pages at `/harness-hg/`, the manual at `/harness-hg/docs/`, and the fixture-backed
Nexus UI demo at `/harness-hg/demo/`. `landing/index.html` also renders directly from disk,
but the assembled docs and demo are available only after `make site`.

`make landing-check` checks page metadata, local links/assets and scene command syntax.
`make site` also checks landing links against the assembled manual and demo. Browser review
covers desktop/mobile, both themes, keyboard navigation, reduced motion and no JavaScript.

## Social preview

Each page has its own canonical URL, title and description, plus a shared 1200×630 PNG.
Regenerate it from the existing mark and vendored fonts with:

```bash
cd nexus-ui && bun install --frozen-lockfile && cd ..
bun infra/scripts/render-share-card.ts
```

The renderer uses local Chrome (or `HG_CHROME_PATH`) and the repository's existing Playwright
dependency. It makes no external requests. Review the resulting PNG before committing it.
Changing social metadata does not refresh an already cached third-party preview automatically.

## Provenance and publishing

`contour-sphere.js` came from the Claude Design project *Hermes GitOps Nexus specification*.
Its original `Mercury Landing.dc.html` layout is retired. The canvas silhouettes came from
*Canvas Object System copy copy 2.dc.html*. Keep historical names in provenance notes only.
Font licenses live in [fonts/README.md](fonts/README.md); the repository uses Apache-2.0.

The Pages workflow assembles and publishes this directory through `make site`. The private
ops fork is exported to the public repository before a release; the public site must build
without the private maintainer ledgers.
