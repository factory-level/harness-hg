#!/usr/bin/env bash
# The dev loop's executable walkthrough (#670): onboard -> up -> dev ->
# test -> eval -> reset, with asserted outcomes at every step.
# cli/e2e-local.sh IS that sequence (12 steps, including the reconcile
# acceptance) - this wrapper exists so the loop has a front door named
# like its SOP entry rather than like a test artifact.
set -euo pipefail
CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Step 0 (#673): the front door's cold-start contract - with nothing
# onboarded, `hg dev` names the onramp instead of a bare failure.
if HERMES_GITOPS_HOME="$(mktemp -d)" bun "$CLI_DIR/src/main.ts" dev 2>&1 | grep -q "hg dev <./path | repo-url>"; then
  echo "PASS: cold \`hg dev\` teaches the onramp (onboard && up && dev)"
else
  echo "FAIL: cold \`hg dev\` did not print the guided onramp" >&2
  exit 1
fi

exec bash "$CLI_DIR/e2e-local.sh" "$@"
