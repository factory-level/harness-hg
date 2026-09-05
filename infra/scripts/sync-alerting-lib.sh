#!/usr/bin/env bash
# charts/{monitoring,fleet-dashboard}/control-plane/alert-router/lib/ are committed
# copies of charts/hermes-alerting (the source of truth). Run after changing the
# library; --check makes it a drift gate (nonzero when a copy differs).
#
# Why copies rather than a fetched dependency: `helm dependency update` runs
# NOWHERE in this repository. Argo CD syncs both consumers from bare Git paths
# (infra/gitops-template/bootstrap/fleet-dashboard.yaml, and the per-profile app
# rendered by harness/hermes/charts/hermes-profile), so nothing would fetch a dependency
# at deploy time. A committed, unpacked subchart is resolved by `helm template`
# with no fetch step, which keeps that deployment model intact.
#
# Same shape as sync-nexus-chart.sh, deliberately.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/control-plane/alert-router/lib"
CONSUMERS=(control-plane/monitoring/chart control-plane/fleet-dashboard/chart)
FILES=(Chart.yaml README.md templates/_alerting.tpl)

if [[ "${1:-}" == "--check" ]]; then
  for c in "${CONSUMERS[@]}"; do
    dst="$ROOT/$c/charts/hermes-alerting"
    for f in "${FILES[@]}"; do
      cmp -s "$SRC/$f" "$dst/$f" || {
        echo "DRIFT: $c/control-plane/alert-router/lib/$f != control-plane/alert-router/lib/$f (run infra/scripts/sync-alerting-lib.sh)"
        exit 1
      }
    done
    # A stray file in a copy is drift too: it would render in one consumer and
    # not the other, which is the exact class of bug this chart exists to end.
    extra="$(cd "$dst" && find . -type f | sed 's|^\./||' | sort | comm -13 <(printf '%s\n' "${FILES[@]}" | sort) -)"
    [[ -z "$extra" ]] || {
      echo "DRIFT: $c/charts/hermes-alerting has files the library does not: $extra"
      exit 1
    }
  done
  echo "OK: hermes-alerting copies in sync"
  exit 0
fi

for c in "${CONSUMERS[@]}"; do
  dst="$ROOT/$c/charts/hermes-alerting"
  rm -rf "$dst"
  mkdir -p "$dst/templates"
  for f in "${FILES[@]}"; do cp "$SRC/$f" "$dst/$f"; done
done
echo "synced hermes-alerting into ${#CONSUMERS[@]} consumer chart(s)"
