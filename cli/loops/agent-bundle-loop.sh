#!/usr/bin/env bash
# The agent-bundle loop's executable walkthrough (#670): the authoring
# sequence from _docs/design/cli.md as asserted `hg` invocations, over a
# real bundle repo, with NO cluster - everything a bundle author runs
# before their declarations ever meet an environment.
#
#   validate --dir       the one-shot contract gate
#   topology plan        the physical plan compiles
#   observability        the vocabulary joins (levels honestly unknown)
#   nexus compile        dashboard contributions compile
#   workspace doctor     binding declarations are coherent
#   scaffold->emit->     the destination round-trip: the emitter's own
#     gitops doctor      scaffold, `hg topology emit`, zero doctor findings
#
# Target repo: $1, or the sibling persona checkout, or the shipped
# communication-plane example - in that order. The cluster-bearing
# continuation (up/test/eval) is the dev loop (`cli/loops/dev-loop.sh`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HG=(bun "$ROOT/cli/src/main.ts")

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Step 0 (#673): the loop STARTS from its front door - a repo that did
# not exist ten seconds ago, scaffolded by `hg bundle init`, is what the
# whole chain then gates. Pass a repo path to skip init and gate that
# instead (the persona checkout, an example).
REPO="${1:-}"
INIT_RAN=0
if [ -z "$REPO" ]; then
  REPO="$WORK/fresh-bundle"
  INIT_RAN=1
fi

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

echo "agent-bundle loop over $REPO"

if [ "$INIT_RAN" = 1 ]; then
  step "0. the front door: hg bundle init"
  # Two agents: the loop proves the TEAM path (ADR 0178), not a lone agent.
  check "hg bundle init (scaffold + lockfile + self-validate + git init)" \
    "${HG[@]}" bundle init "$REPO" --agents eve:manager,eve:research \
    --gitops "file://$WORK/dest.git"
fi

step "1. the contract gate"
check "hg validate --dir" "${HG[@]}" validate --dir "$REPO"

step "2. the physical plan"
check "hg topology plan --dir --json" "${HG[@]}" topology plan --dir "$REPO" --json

step "3. the observability vocabulary"
check "hg observability inspect" "${HG[@]}" observability inspect

step "4. dashboard contributions"
check "hg nexus compile --source" "${HG[@]}" nexus compile --source "$REPO"

step "5. workspace bindings"
check "hg workspace doctor --dir" "${HG[@]}" workspace doctor --dir "$REPO"

step "6. the destination round-trip (scaffold -> emit -> doctor)"
git init --bare -q "$WORK/dest.git" --initial-branch=main
check "emitter scaffold (file:// destination)" \
  env -C "$ROOT" GITOPS_REPO_URL="file://$WORK/dest.git" \
    HERMES_GITOPS_REPO_URL="https://github.com/factory-level/harness-hg" \
    CHART_REVISION=main \
    uv run python -m gitops_emitter.scaffold_cli
git clone -q "file://$WORK/dest.git" "$WORK/clone"
check "hg topology emit" "${HG[@]}" topology emit --dir "$REPO" --output "$WORK/clone"
check "hg gitops doctor (0 findings)" "${HG[@]}" gitops doctor "$WORK/clone"

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "agent-bundle loop: $FAILURES failure(s)"
  exit 1
fi
echo "agent-bundle loop: green (the authoring walkthrough is walkable end to end)"
