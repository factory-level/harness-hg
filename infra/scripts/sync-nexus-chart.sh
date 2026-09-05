#!/usr/bin/env bash
# control-plane/nexus/chart/files/ is a committed projection of control-plane/nexus (the
# source of truth). Run after changing the plugin or rebuilding dist;
# --check makes it a drift gate (nonzero when the copies differ).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/control-plane/nexus"
DST="$ROOT/control-plane/nexus/chart/files"
# dist/ is deliberately NOT projected: embedding the UI bundles in chart
# files put the Helm release Secret over its 1MiB cap (#804). The bundles
# reach the pod as the externally provisioned `nexus-ui-dist` ConfigMap
# (infra/src/components/nexus/index.ts NEXUS_DIST_FILES; `hg up` in the
# local loop), read straight from control-plane/nexus/dist/.
FILES=(plugin_api.py standalone.py features.json inventory.json panels.json)
if [[ "${1:-}" == "--check" ]]; then
  for f in "${FILES[@]}"; do
    cmp -s "$SRC/$f" "$DST/${f//\//__}" || { echo "DRIFT: control-plane/nexus/chart/files/${f//\//__} != control-plane/nexus/$f (run infra/scripts/sync-nexus-chart.sh)"; exit 1; }
  done
  for stale in "$DST"/dist__*; do
    [[ -e "$stale" ]] && { echo "DRIFT: $stale must not exist - dist is provisioned as a ConfigMap, not chart files (#804)"; exit 1; }
  done
  echo "OK: control-plane/nexus/chart/files in sync"
  exit 0
fi
mkdir -p "$DST"
for f in "${FILES[@]}"; do cp "$SRC/$f" "$DST/${f//\//__}"; done
echo "synced ${#FILES[@]} file(s) into control-plane/nexus/chart/files/"
