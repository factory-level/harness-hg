#!/usr/bin/env bash
# The ops loop's executable walkthrough (#670): the post-day-0 PROVE
# segment - every read-only acceptance matrix the operator runs against
# a live environment, sequenced, with the aggregate verdict at the end.
#
# Day-0 itself (root of trust, state stack, environment config, server
# bootstrap) is deliberately NOT here: those steps are by-hand until
# Phase 5 builds `hg env new` (#674, #676) - see the ops walkthrough in
# _docs/design/cli.md for the prose sequence and its numbered gaps.
#
# Runs wherever the operator environment exists:
#   - on a destination server (or any operator host): the kubeconfig context
#     via HG_KUBE_CONTEXT, the Pulumi stack via HG_STACK
#   - against the local loop: no env vars, after `hg up`
#
#   HG_STACK=factory HG_KUBE_CONTEXT=default cli/loops/ops-loop.sh
#
# `edge prove` runs only when HG_STACK is set (it is a Pulumi-facing
# proof); its pulumi-idempotency stage additionally needs the stack's
# kubeconfig, so on a host without it pass HG_EDGE_SKIP_IDEMPOTENCY=1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HG=(bun "$ROOT/cli/src/main.ts")
FAILURES=0

step() { printf '\n== %s\n' "$*"; }
check() { # <label> <cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '   ok: %s\n' "$label"
  else
    printf '   FAIL: %s\n' "$label"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "ops loop (prove segment)${HG_KUBE_CONTEXT:+ against context $HG_KUBE_CONTEXT}"

# Step ① (#673/#676): the ops front door, non-mutating - the dry-run
# prints day-0's exact hand-executable sequence for the declared
# environment (spec: infra/environments/<HG_ENV:-factory>.yaml).
step "the front door: hg env new --dry-run"
check "hg env new ${HG_ENV:-factory} --dry-run" "${HG[@]}" env new "${HG_ENV:-factory}" --dry-run

step "reconciliation is applying"
check "hg reconcile status" "${HG[@]}" reconcile status

step "the connection contract holds"
check "hg connection prove" "${HG[@]}" connection prove

step "backups are real (verify reads evidence, never trust)"
check "hg backup verify" "${HG[@]}" backup verify

step "the runtime overlay is honest"
check "hg observability prove" "${HG[@]}" observability prove

# auth/grafana/launch prove are still LOCAL-LOOP-SHAPED (#740): they
# read the identity install and the Grafana credential drop `hg up`
# writes, which a real environment does not have. Until #740 makes them
# environment-portable they run only when this loop targets the local
# cluster (HG_KUBE_CONTEXT unset). Skipping is stated, never silent.
if [ -z "${HG_KUBE_CONTEXT:-}" ]; then
  step "auth posture"
  check "hg auth prove" "${HG[@]}" auth prove

  step "grafana panels exist"
  check "hg grafana prove" "${HG[@]}" grafana prove
else
  step "auth + grafana prove SKIPPED against $HG_KUBE_CONTEXT - local-loop-shaped until #740"
fi

if [ -n "${HG_STACK:-}" ]; then
  step "the edge answers (stack $HG_STACK)"
  EDGE_FLAGS=(--stack "$HG_STACK" --infra-dir "$ROOT/infra")
  [ -n "${HG_EDGE_SKIP_IDEMPOTENCY:-}" ] && EDGE_FLAGS+=(--skip-idempotency)
  check "hg edge prove" "${HG[@]}" edge prove "${EDGE_FLAGS[@]}"
else
  step "edge prove SKIPPED (set HG_STACK to include it)"
fi

if [ -z "${HG_KUBE_CONTEXT:-}" ]; then
  step "the aggregate: every subject's matrix"
  check "hg launch prove" "${HG[@]}" launch prove
else
  step "launch prove SKIPPED against $HG_KUBE_CONTEXT - aggregates the #740 legs"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "ops loop: $FAILURES failure(s) - a red proof here is an environment finding, not noise"
  exit 1
fi
echo "ops loop: green (the post-day-0 segment proves out)"
