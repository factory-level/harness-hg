# The brand-face inventory (#435, ADR-105)

The deployed Nexus CSP is `default-src 'self'` with no external origins, so the
Google Fonts `@import`/`<link>` were silently refused and every page fell back
to `system-ui`. These woff2 files are the brand faces, self-hosted as a
**platform inventory** — the same ride as `../avatars/`:

- `hg nexus emit` copies them into the gitops repo at
  `deployments/dashboard/assets/fonts/` (`cli/src/nexus/emit.ts`,
  `loadFontInventory`), and their bytes stamp the emit's inputs hash.
- `plugin_api.py` serves them at `GET /nexus/assets/fonts/<name>` behind the
  mirrored validator (`font_asset_error`: woff2 magic, 256KB cap; id-shaped
  stem, symlink refusal).
- `src/style.css`'s `@font-face` rules reference the route by **absolute
  path** — `API_BASE` is the same literal in the standalone shell and the
  Hermes host, so one URL works in both. A context that cannot serve the
  route (demo mode, a first run) falls back to `system-ui` per glyph.

They deliberately do NOT ride the chart or the stylesheet: the chart projects
code through a text ConfigMap that cannot carry binaries, and the Helm release
Secret sits near its 1MiB cap — inlining the faces as data: URIs pushed it
over and broke a factory roll. That history is ADR-105's cost section.

## Files

| file | family | style | axes |
|---|---|---|---|
| `figtree-latin.woff2` | Figtree | normal | wght 400..800 (variable) |
| `nunito-sans-latin.woff2` | Nunito Sans | normal | wght 400..800 (variable) |
| `nunito-sans-latin-italic.woff2` | Nunito Sans | italic | wght 400..800 (variable) |

Latin subsets only — a missing glyph falls through to the system stack per
glyph. There is no Figtree italic on purpose: no rule has ever asked for one.

## Provenance and license

Both families are licensed under the SIL Open Font License 1.1 (free to bundle
and redistribute). Figtree © Erik Kennedy; Nunito Sans © The Nunito Project.
The woff2 files are the latin-subset variable builds served by Google Fonts
(fonts.gstatic.com), fetched 2026-08-13.

## Regeneration

Fetch the css2 stylesheet with a woff2-capable User-Agent and download the
latin-subset URLs it names:

```bash
UA="Mozilla/5.0 ... Chrome/126.0"
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Figtree:wght@400..800&family=Nunito+Sans:ital,wght@0,400..800;1,400..800&display=swap"
# take the url(...) of each block whose unicode-range covers U+0000-00FF
```

Keep the filenames stable — `src/style.css`'s `@font-face` rules and the
pytest sweep name them. Then re-emit (`hg nexus emit`) wherever a gitops repo
serves them.
