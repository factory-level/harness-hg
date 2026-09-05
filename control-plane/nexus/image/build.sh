#!/usr/bin/env bash
# Usage: control-plane/nexus/image/build.sh [--push] [<registry-tag>]
# Builds the Nexus UI host image. Default tag comes from versions.json's
# nexus pin, which the chart's values.yaml default must equal
# (cli/tests/versions.test.ts). `hg up` builds this tag locally and imports
# it into k3d; a hosted environment pulls the published one.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PUSH=0
[[ "${1:-}" == "--push" ]] && { PUSH=1; shift; }
TAG="${1:-$(python3 -c "import json;print(json.load(open('$ROOT/versions.json'))['nexus']['image'])")}"
docker build -t "$TAG" "$ROOT/control-plane/nexus/image"
[[ $PUSH -eq 1 ]] && docker push "$TAG"
echo "built $TAG"
