#!/usr/bin/env bash
# Build (and optionally push) the baseline event-router image, pins taken
# from versions.json - the one resolved-versions surface (ADR-63).
#   control-plane/event-router/image/build.sh [--push] <registry-tag>
# e.g. control-plane/event-router/image/build.sh --push \
#   us-docker.pkg.dev/inferlab-dev/hermes/hermes-event-router:baseline-1.3.14
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
push=0
if [ "${1:-}" = "--push" ]; then push=1; shift; fi
tag="${1:?usage: build.sh [--push] <registry-tag>}"
bun_version="$(python3 -c "import json;print(json.load(open('$repo_root/versions.json'))['host']['bun'])")"
baseline_sha="$(python3 -c "import json;print(json.load(open('$repo_root/versions.json'))['host']['bunBaselineSha256'])")"
docker build \
  --build-arg "BUN_VERSION=$bun_version" \
  --build-arg "BUN_BASELINE_SHA256=$baseline_sha" \
  -t "$tag" "$here"
if [ "$push" = 1 ]; then docker push "$tag"; fi
echo "built $tag (bun $bun_version baseline)"
