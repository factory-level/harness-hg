#!/usr/bin/env bash
# Usage: control-plane/wiki/image/build.sh [--push] [<registry-tag>]
# Builds the wiki image FROM THE REPO ROOT (the site build needs the whole
# tree + git). Default tag comes from versions.json's wiki pin; the image
# self-reports its platform version at /version.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PUSH=0
[[ "${1:-}" == "--push" ]] && { PUSH=1; shift; }
TAG="${1:-$(python3 -c "import json;print(json.load(open('$ROOT/versions.json'))['wiki']['image'])")}"
docker build -f "$ROOT/control-plane/wiki/image/Dockerfile" -t "$TAG" "$ROOT"
[[ $PUSH -eq 1 ]] && docker push "$TAG"
echo "built $TAG"
