#!/usr/bin/env bash
# The public tree carries no operator identifiers. This repository is the
# private ops fork; the public snapshot (infra/scripts/public-snapshot.sh)
# excludes the overlay files listed below and runs this gate with no
# exclusions. Everything else must already be clean here, so a leak is
# caught at the PR that introduces it, not at release time.
#
# The patterns are the operator's own: server addresses, cloud project ids,
# Zero Trust team, Slack workspace/channel/user ids, personal addresses, the
# OAuth client id. Add one when a new identifier enters the ops overlay.
set -uo pipefail
cd "$(dirname "$0")/../.."

PATTERN='192\.168\.[0-9]+\.[0-9]+|inferlab-dev|neonware-cloud|T0BSL59DCJK|C0BSV8XLXM1|U0BSZHWPRK8|A0BSW9XNWSX|calvinl|@gmail\.com|982197905155|factory-level@'

# The operator overlay: files the public snapshot does not carry.
OVERLAY=(
  ':(exclude)factory-system-reference.md'
  ':(exclude)infra/environments/factory.yaml'
  ':(exclude)infra/environments/factory-proactive-secrets.py'
  ':(exclude)infra/environments/factory-proactive-volumes.py'
  ':(exclude)infra/environments/factory-proactive-topology.ts'
  ':(exclude)infra/Pulumi.factory.yaml'
  ':(exclude)state/Pulumi.factory.yaml'
  ':(exclude)_old-docs'
  ':(exclude)_docs/adr/CHANGES.md'
  ':(exclude)PRODUCT.md'
  ':(exclude).github/workflows/DISABLED.md'
)
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
  ':(exclude)infra/scripts/check-public-clean.sh'
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
