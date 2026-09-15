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
# The image derives its version from git history, so the build context needs a
# usable .git. In a WORKTREE, .git is a file pointing at the main checkout's
# directory - a path that does not exist inside the container, where `git log`
# then fails sixteen seconds into the build with a Python traceback. Say so
# here instead.
if [[ ! -d "$ROOT/.git" ]]; then
  echo "build.sh: $ROOT/.git is not a directory - the wiki image derives its version from git history, which a linked worktree cannot provide inside the build container." >&2
  echo "          Build from the main checkout, or from a clone of this branch (git clone $ROOT /tmp/<dir>)." >&2
  exit 1
fi
docker build -f "$ROOT/control-plane/wiki/image/Dockerfile" -t "$TAG" "$ROOT"
[[ $PUSH -eq 1 ]] && docker push "$TAG"
echo "built $TAG"
