#!/usr/bin/env bash
# Build (and optionally push) the eve-runtime image, the eve pin taken from
# versions.json - the one resolved-versions surface (ADR-63).
#   harness/eve/image/build.sh [--push] [<registry-tag>]
# The tag defaults to <runtimes.eve.imageRepository>:<runtimes.eve.version>,
# which is what harness/eve/charts/eve-agent/values.yaml names; `hg up` builds the
# same Dockerfile as eve-runtime:hermes-gitops-dev for the local k3d loop.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
push=0
if [ "${1:-}" = "--push" ]; then push=1; shift; fi
eve_version="$(python3 -c "import json;print(json.load(open('$repo_root/versions.json'))['runtimes']['eve']['version'])")"
image_repo="$(python3 -c "import json;print(json.load(open('$repo_root/versions.json'))['runtimes']['eve']['imageRepository'])")"
tag="${1:-$image_repo:$eve_version}"
docker build \
  --build-arg "EVE_VERSION=$eve_version" \
  -t "$tag" "$here"
if [ "$push" = 1 ]; then docker push "$tag"; fi
echo "built $tag (eve $eve_version)"
