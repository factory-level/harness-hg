#!/usr/bin/env bash
# e2e-offline.sh — the cluster-free half of the end-to-end scaffold
# validation (#669): source → emit → destination, provably, with no
# docker/k3d and no network. The cluster-bearing half is `make e2e`
# (cli/e2e-local.sh); this script is the PR-gate layer and joins
# `make test`.
#
# The chain, in pipeline order:
#   1. `hg validate --dir` over the reference authorings — the clean ones
#      must pass, and distributed-profile must FAIL (its persona-echo
#      deliberately omits a valuesRequired override; a gate that cannot
#      fail is not a gate).
#   2. `hg topology plan --dir` compiles the persona checkout.
#   3. The emitter's own scaffold seeds a token-less file:// destination,
#      `hg topology emit` populates it, `hg gitops doctor` verifies the
#      result with zero findings — the actual production path end to end.
#   4. `hg nexus validate` over the persona's dashboard contributions.
#   5. The persona repo's own acceptance (evals/topology-check.sh) runs
#      against THIS checkout's hg — the cross-repo loop that no CI runs
#      anywhere (CLAUDE.md: it is the entire safety net).
#
# The persona legs need the sibling checkout (PERSONA_DIR, default
# ../my-team next to the platform root). Absent, they
# SKIP LOUDLY and the example-repo legs still gate — a fresh clone of
# just this repo stays runnable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HG=(bun "$ROOT/cli/src/main.ts")
PERSONA_DIR="${PERSONA_DIR:-$ROOT/../my-team}"
FAILURES=0

note() { printf '\n== %s\n' "$*"; }
pass() { printf '   ok: %s\n' "$*"; }
fail() { printf '   FAIL: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. the one-shot contract gate over every reference authoring -----------
note "hg validate --dir: reference authorings"
# agent-team is the ADR 0178 tree (hg bundle init's exact output); the other
# two stay on the legacy layout on purpose - the dual reader's regression guard.
for repo in agent-team eve-agent communication-plane; do
  if "${HG[@]}" validate --dir "$ROOT/examples/$repo" >/dev/null 2>&1; then
    pass "examples/$repo validates clean"
  else
    fail "examples/$repo should validate clean"
  fi
done
# The NEGATIVE leg: a gate that cannot fail proves nothing.
if "${HG[@]}" validate --dir "$ROOT/examples/distributed-profile" >/dev/null 2>&1; then
  fail "examples/distributed-profile validated clean - its deliberate valuesRequired gap should fire"
else
  pass "examples/distributed-profile fails as designed (persona-echo's missing alert.webhookUrl)"
fi

# --- persona legs -----------------------------------------------------------
if [ -d "$PERSONA_DIR" ]; then
  note "hg validate + topology plan: persona checkout ($PERSONA_DIR)"
  if "${HG[@]}" validate --dir "$PERSONA_DIR" >/dev/null 2>&1; then
    pass "persona repo validates clean"
  else
    fail "persona repo should validate clean"
  fi
  if "${HG[@]}" topology plan --dir "$PERSONA_DIR" --json >/dev/null 2>&1; then
    pass "topology plan compiles"
  else
    fail "topology plan should compile"
  fi

  # --- 3. scaffold → emit → doctor: the destination round-trip --------------
  note "scaffold -> emit -> gitops doctor (file:// destination)"
  git init --bare -q "$WORK/dest.git" --initial-branch=main
  if (cd "$ROOT" && GITOPS_REPO_URL="file://$WORK/dest.git" \
      HERMES_GITOPS_REPO_URL="https://github.com/factory-level/harness-hg" \
      CHART_REVISION=main \
      uv run python -m gitops_emitter.scaffold_cli >/dev/null 2>&1); then
    pass "emitter scaffolded the destination"
  else
    fail "emitter scaffold refused"
  fi
  git clone -q "file://$WORK/dest.git" "$WORK/clone"
  if "${HG[@]}" topology emit --dir "$PERSONA_DIR" --output "$WORK/clone" >/dev/null 2>&1; then
    pass "topology emit populated the destination"
  else
    fail "topology emit refused"
  fi
  if "${HG[@]}" gitops doctor "$WORK/clone" >/dev/null 2>&1; then
    pass "gitops doctor: scaffold + emitted tree verify clean"
  else
    "${HG[@]}" gitops doctor "$WORK/clone" 2>&1 | sed 's/^/   /' || true
    fail "gitops doctor found errors in the emitted destination"
  fi

  # --- 4. the dashboard contributions --------------------------------------
  note "hg nexus validate: persona dashboard contributions"
  if "${HG[@]}" nexus validate --source "$PERSONA_DIR" >/dev/null 2>&1; then
    pass "nexus contributions validate"
  else
    fail "nexus contributions should validate"
  fi

  # --- 5. the persona repo's own acceptance ---------------------------------
  note "persona acceptance: evals/topology-check.sh against this checkout's hg"
  if (cd "$PERSONA_DIR" && HG="bun $ROOT/cli/src/main.ts" evals/topology-check.sh >/dev/null 2>&1); then
    pass "topology-check.sh green (goldens, sovereignty refusal, literal counts)"
  else
    fail "topology-check.sh red - run it directly for the findings"
  fi
else
  note "persona checkout absent ($PERSONA_DIR) - SKIPPING the persona legs"
  echo "   the cross-repo loop is the entire persona safety net; run this where the sibling exists"
fi

# --- verdict ----------------------------------------------------------------
echo
if [ "$FAILURES" -gt 0 ]; then
  echo "e2e-offline: $FAILURES failure(s)"
  exit 1
fi
echo "e2e-offline: green (source -> emit -> destination verified without a cluster)"
