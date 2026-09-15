#!/usr/bin/env bash
# The public tree carries no operator identifiers. This repository is the
# private ops fork; the public snapshot (infra/scripts/public-snapshot.sh)
# excludes the overlay files listed below and runs this gate with no
# exclusions. Everything else must already be clean here, so a leak is
# caught at the PR that introduces it, not at release time.
#
# Two pattern sources. The built-in one matches identifiers by SHAPE (LAN
# addresses, Slack workspace/channel/user/app ids, personal mail) so this
# script can ship in the snapshot without listing anyone. Operator-specific
# strings (cloud project ids, handles, a Zero Trust team) live in the
# untracked infra/scripts/public-clean.local, one extended-regex per line;
# add one there when a new identifier enters the ops overlay.
set -uo pipefail
cd "$(dirname "$0")/../.."

# Slack ids: a type letter (team, channel, user, app, DM, group, enterprise
# user) then the `0B` allocation era every id in this workspace shares, then
# 8+ upper-alphanumerics, as a whole word. Documentation placeholders such
# as T0123456789 and T0000000000 are deliberately outside the shape; an id
# from another era goes in public-clean.local.
PATTERN='192\.168\.[0-9]+\.[0-9]+|\b[TCUADGW]0B[A-Z0-9]{8,}\b|@[g]mail\.com|[f]actory-level@'
LOCAL="$(dirname "$0")/public-clean.local"
if [ -f "$LOCAL" ]; then
  EXTRA="$(grep -vE '^\s*(#|$)' "$LOCAL" | paste -sd'|' -)"
  [ -n "$EXTRA" ] && PATTERN="$PATTERN|$EXTRA"
fi
# --file <path>: gate one file outside the tree (the release notes).
if [ "${1:-}" = "--file" ]; then
  if grep -nE "$PATTERN" "$2"; then echo "public-clean: operator identifiers in $2"; exit 1; fi
  echo "OK   no operator identifiers in $2"; exit 0
fi

# The operator overlay (public-overlay.txt): files the public snapshot does not carry.
# Absent in the public snapshot (it names the private files), which is exactly
# the no-exclusions posture --strict wants.
OVERLAY=()
[ -f "$(dirname "$0")/public-overlay.txt" ] && \
  mapfile -t OVERLAY < <(grep -vE '^\s*(#|$)' "$(dirname "$0")/public-overlay.txt" | sed 's/^/:(exclude)/')
# Image pins that still name the private registry until the images are
# published to ghcr.io (tracked in the OSS-readiness epic). Each is one line.
ALLOW=(
  ':(exclude)versions.json'
  ':(exclude)harness/eve/charts/eve-agent/values.yaml'
  ':(exclude)harness/eve/charts/eve-bundle/values.yaml'
  ':(exclude)control-plane/wiki/chart/values.yaml'
  ':(exclude)control-plane/event-router/image/build.sh'
  ':(exclude)plugin/tests/chart/golden'
  ':(exclude)control-plane/nexus/dist'
)
if [ "${1:-}" = "--strict" ]; then OVERLAY=(); fi

hits=$(git grep -nIE "$PATTERN" -- . "${OVERLAY[@]}" "${ALLOW[@]}" || true)
if [ -n "$hits" ]; then
  echo "$hits"
  echo
  echo "public-clean: operator identifiers above. Replace with example values, or move the file into the ops overlay."
  exit 1
fi
echo "OK   no operator identifiers outside the ops overlay"
