#!/usr/bin/env bash
# Assemble the published site into ./site/ - one origin, three parts:
#
#   /        landing/            the brochure site
#   /docs/   _docs/site/         the wiki (run `make wiki-build` first)
#   /demo/   nexus-ui demo       the Nexus UI on fixture data, no backend
#
# GitHub Pages serves this artifact under /harness-hg/, so every link in
# every part is relative or /harness-hg/-prefixed - never origin-absolute.
# Preview: `python3 -m http.server -d site` and open /  (the logo and the
# wiki's own links assume the /harness-hg/ prefix and 404 locally; the
# workflow deploys the real thing).
set -euo pipefail
cd "$(dirname "$0")/../.."

test -s _docs/site/index.html || { echo "build-site: run make wiki-build first"; exit 1; }

rm -rf site
mkdir -p site/docs site/demo/api/nexus/assets/avatars site/demo/api/nexus/assets/fonts

cp -r landing/. site/
rm -f site/README.md
cp -r _docs/site/. site/docs/

# The demo: the plugin bundle + stylesheet from control-plane/nexus/dist, the
# shell built fresh (vite.demo.config.ts writes site/demo/demo.js), and the
# avatar library as extensionless files at the exact paths the plugin requests.
# The plugin bundle is rebuilt first and must reproduce the dist on disk - so
# a stale dist fails here instead of shipping an old demo (build, THEN
# standalone: the main build empties the directory). The comparison is
# against the working tree, not the index, so an uncommitted rebuild passes.
before=$(cat control-plane/nexus/dist/index.js control-plane/nexus/dist/standalone.js control-plane/nexus/dist/style.css | sha256sum)
(cd nexus-ui && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null 2>&1 && bun run build:standalone >/dev/null 2>&1 && bun run build:demo >/dev/null)
after=$(cat control-plane/nexus/dist/index.js control-plane/nexus/dist/standalone.js control-plane/nexus/dist/style.css | sha256sum)
[ "$before" = "$after" ] \
  || { echo "build-site: control-plane/nexus/dist did not match nexus-ui/src - it has been rebuilt; commit it"; exit 1; }
cp control-plane/nexus/dist/index.js site/demo/
# The stylesheet names the fonts at the plugin's absolute API path; the
# demo serves them as files beside the page, so rewrite to a relative URL.
sed 's#/api/plugins/hermes-gitops/nexus/assets/fonts/#api/nexus/assets/fonts/#g' \
  control-plane/nexus/dist/style.css > site/demo/style.css
cp control-plane/nexus/fonts/*.woff2 site/demo/api/nexus/assets/fonts/
ids=()
for f in control-plane/nexus/avatars/*.webp; do
  id=$(basename "${f%.webp}")
  cp "$f" "site/demo/api/nexus/assets/avatars/$id"
  case "$id" in *-still) ;; *) ids+=("\"$id\"");; esac
done
printf '{"avatars":[%s]}\n' "$(printf '{"id":%s},' "${ids[@]}" | sed 's/,$//')" \
  > site/demo/api/nexus/assets/avatars.json
cat > site/demo/index.html <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Hg · Nexus UI demo</title><link rel="icon" href="../favicon.svg">
<link rel="stylesheet" href="style.css"></head>
<body><div id="nexus-root"></div><script src="demo.js"></script></body></html>
HTML

echo "site: $(find site -type f | wc -l) files -> ./site/"
