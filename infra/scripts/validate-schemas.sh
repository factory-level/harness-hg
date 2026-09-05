#!/usr/bin/env bash
# Validates every examples/ fixture under agent-bundle-contracts/ and cli/schemas/ against
# its sibling schema.json.
#
# Convention: for a schema at schemas/<group>/<version>/<name>.schema.json, fixtures
# live in schemas/<group>/<version>/examples/*.yaml. Fixtures named "invalid-*" MUST
# fail validation; every other fixture MUST pass. The script asserts both directions
# and exits non-zero if any fixture behaves unexpectedly.
#
# Validator selection:
#   1. `uv run --with check-jsonschema check-jsonschema` (preferred; network-fetched on
#      first run, then cached by uv).
#   2. Fallback: infra/scripts/validate_with_jsonschema.py, a stdlib + pyyaml + jsonschema
#      script, invoked via `uv run` so its two deps are resolved without polluting the
#      system interpreter.
#
# Usage: infra/scripts/validate-schemas.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PASS_COUNT=0
FAIL_COUNT=0
FAILURES=()

# Determine which validator to use, once, up front.
VALIDATOR=""
if uv run --with check-jsonschema check-jsonschema --version >/dev/null 2>&1; then
  VALIDATOR="check-jsonschema"
  echo "Using validator: uv run --with check-jsonschema check-jsonschema"
else
  echo "check-jsonschema unavailable (offline or install failed); falling back to pure-Python validator." >&2
  VALIDATOR="fallback"
  echo "Using validator: uv run ${REPO_ROOT}/scripts/validate_with_jsonschema.py"
fi

run_validator() {
  local schema="$1" fixture="$2"
  if [[ "$VALIDATOR" == "check-jsonschema" ]]; then
    uv run --with check-jsonschema check-jsonschema --schemafile "$schema" "$fixture"
  else
    uv run --with pyyaml --with jsonschema "$REPO_ROOT/infra/scripts/validate_with_jsonschema.py" "$schema" "$fixture"
  fi
}

validate_one() {
  local schema="$1" fixture="$2" expect="$3" # expect: pass|fail
  local basename
  basename="$(basename "$fixture")"

  local output
  if output="$(run_validator "$schema" "$fixture" 2>&1)"; then
    local result="pass"
  else
    local result="fail"
  fi

  if [[ "$result" == "$expect" ]]; then
    echo "OK   [$expect as expected] $fixture"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL [expected $expect, got $result] $fixture"
    echo "$output" | sed 's/^/       /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("$fixture (expected $expect, got $result)")
  fi
}

validate_examples_dir() {
  local schema="$1" examples_dir="$2"

  if [[ ! -f "$schema" ]]; then
    echo "ERROR: schema not found: $schema" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("missing schema: $schema")
    return
  fi
  if [[ ! -d "$examples_dir" ]]; then
    echo "ERROR: examples dir not found: $examples_dir" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("missing examples dir: $examples_dir")
    return
  fi

  local fixture base
  for fixture in "$examples_dir"/*.yaml "$examples_dir"/*.yml; do
    [[ -e "$fixture" ]] || continue
    base="$(basename "$fixture")"
    if [[ "$base" == invalid-* ]]; then
      validate_one "$schema" "$fixture" "fail"
    else
      validate_one "$schema" "$fixture" "pass"
    fi
  done
}

# EVERY frozen version, discovered rather than pinned. A schema directory
# is immutable once a consumer depends on it, so its fixtures have to keep
# passing forever - and this script previously validated exactly one
# version, under a heading naming a different one. A version left behind
# here is a frozen contract nothing checks.
for schema in "$REPO_ROOT"/agent-bundle-contracts/hermesprofile/*/profile.schema.json; do
  version="$(basename "$(dirname "$schema")")"
  echo "== HermesProfile $version =="
  validate_examples_dir "$schema" "$(dirname "$schema")/examples"
  echo
done

echo
echo "== EveAgent v1alpha1 (ADR-149: the Eve runtime's record) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/eveagent/v1alpha1/eveagent.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/eveagent/v1alpha1/examples"

echo
echo "== EveAgent v1alpha2 (ADR-150: + apps and backup, realized by the eve-agent chart) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/eveagent/v1alpha2/eveagent.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/eveagent/v1alpha2/examples"

echo
echo "== Agent runtime manifest v1alpha1 (ADR-153: what the pod actually got) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/agent-runtime/v1alpha1/agent-runtime.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/agent-runtime/v1alpha1/examples"

echo
echo "== HarnessDeclaration v1alpha1 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/harness-declaration/v1alpha1/harness.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/harness-declaration/v1alpha1/examples"

echo
echo "== ClusterValues v1alpha1 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/cluster-values/v1alpha1/cluster-values.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/cluster-values/v1alpha1/examples"

echo
echo "== Hermes GitOps extension v1alpha1 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha1/hermes-gitops.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha1/examples"

echo
echo "== Hermes GitOps extension v1alpha2 (contract version 2) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha2/hermes-gitops.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha2/examples"

echo
echo "== Hermes GitOps extension v1alpha3 (contract version 3: communication plane) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha3/hermes-gitops.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha3/examples"

echo
echo "== Hermes GitOps extension v1alpha4 (contract version 4: optional requirements) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha4/hermes-gitops.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha4/examples"

echo
echo "== Hermes GitOps extension v1alpha5 (contract version 5: runtime block, ADR-149) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha5/hermes-gitops.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/hermes-gitops-extension/v1alpha5/examples"

echo
echo "== Environment capabilities v1alpha1 (#144, ADR-98) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-capabilities/v1alpha1/capabilities.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-capabilities/v1alpha1/examples"

echo
echo "== Environment communication v1alpha1 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-communication/v1alpha1/communication.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-communication/v1alpha1/examples"

echo
echo "== Environment communication v1alpha2: inbound authorization (#348) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-communication/v1alpha2/communication.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-communication/v1alpha2/examples"

echo
echo "== Environment topology v1alpha1 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-topology/v1alpha1/topology.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-topology/v1alpha1/examples/topology"

echo
echo "== Environment policy v1alpha1 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-topology/v1alpha1/policy.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-topology/v1alpha1/examples/policy"

echo
echo "== Topology plan v1alpha1: catalogue provenance =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha1/provenance.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha1/examples/provenance"

echo
echo "== Topology plan v1alpha1: deployment record =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha1/deployment.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha1/examples/deployment"

echo
echo "== Topology plan v1alpha1: plan summary =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha1/plan.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha1/examples/plan"

echo
echo "== Topology plan v1alpha2: deployment record with distribution identity (ADR-123) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha2/deployment.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha2/examples/deployment"

echo
echo "== Topology plan v1alpha3: deployment record with runtime + chart (ADR-149) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha3/deployment.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/topology-plan/v1alpha3/examples/deployment"

echo
echo "== Communication deployment v1alpha1: router record =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha1/deployment.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha1/examples/deployment"

echo
echo "== Communication deployment v1alpha1: router values =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha1/values.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha1/examples/values"

echo
echo "== Communication deployment v1alpha1: plan summary =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha1/plan.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha1/examples/plan"

echo
echo "== Communication deployment v1alpha2: router values (+ environment knobs) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha2/values.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha2/examples/values"

echo
echo "== Bundle destination v1alpha1 (.harness-hg/destination.yaml) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/bundle-destination/v1alpha1/destination.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/bundle-destination/v1alpha1/examples"

echo
echo "== Agent team v1alpha1: team.yaml (team identity, ADR 0178) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/team.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/examples/team"

echo
echo "== Agent team v1alpha1: agent.yaml (per-agent declaration, ADR 0178) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/agent.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/examples/agent"

echo
echo "== Agent team v1alpha1: apps.yaml (team apps + their routes, ADR 0178) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/apps.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/examples/apps"

echo
echo "== Agent team v1alpha1: endpoints.yaml (per-agent endpoints, external inputs + their routes, Hermes expose, ADR 0178) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/endpoints.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/examples/endpoints"

echo
echo "== Agent team v1alpha1: backup.yaml (per-agent backup intent, ADR 0178) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/backup.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/examples/backup"

echo
echo "== Agent team v1alpha1: test.yaml (per-agent dev-loop config, ADR 0178) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/test.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/examples/test"

echo
echo "== Agent team v1alpha1: topology.yaml (target-free team topology, ADR 0178) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/topology.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/agent-team/v1alpha1/examples/topology"

echo
echo "== Environment spec v1alpha2 (+ grants: the bootstrap's half of an agent-team repo, ADR 0178) =="
validate_examples_dir \
  "$REPO_ROOT/cli/schemas/environment/v1alpha2/environment.schema.json" \
  "$REPO_ROOT/cli/schemas/environment/v1alpha2/examples"

echo
echo "== Environment spec v1alpha1 (CLI-only, the #674 source of truth) =="
validate_examples_dir \
  "$REPO_ROOT/cli/schemas/environment/v1alpha1/environment.schema.json" \
  "$REPO_ROOT/cli/schemas/environment/v1alpha1/examples"

echo
echo "== Eval suite v1alpha1 (CLI-only authoring contract) =="
validate_examples_dir \
  "$REPO_ROOT/cli/schemas/evals/v1alpha1/suite.schema.json" \
  "$REPO_ROOT/cli/schemas/evals/v1alpha1/examples/suite"

echo
echo "== Eval scenario v1alpha1 (CLI-only authoring contract) =="
validate_examples_dir \
  "$REPO_ROOT/cli/schemas/evals/v1alpha1/scenario.schema.json" \
  "$REPO_ROOT/cli/schemas/evals/v1alpha1/examples/scenario"

echo
echo "== Eval suite v1alpha2 (typed communication invocation) =="
validate_examples_dir \
  "$REPO_ROOT/cli/schemas/evals/v1alpha2/suite.schema.json" \
  "$REPO_ROOT/cli/schemas/evals/v1alpha2/examples/suite"

echo
echo "== Eval scenario v1alpha2 (typed communication invocation) =="
validate_examples_dir \
  "$REPO_ROOT/cli/schemas/evals/v1alpha2/scenario.schema.json" \
  "$REPO_ROOT/cli/schemas/evals/v1alpha2/examples/scenario"

echo
echo "== Dashboard contribution v1alpha1 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-contribution/v1alpha1/contribution.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-contribution/v1alpha1/examples/contribution"

echo
echo "== Dashboard view v1alpha1 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-contribution/v1alpha1/view.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-contribution/v1alpha1/examples/view"

echo
echo "== Dashboard plan v1alpha1: catalogue provenance =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-plan/v1alpha1/provenance.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-plan/v1alpha1/examples/provenance"

echo
echo "== Dashboard plan v1alpha1: nexus plan =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-plan/v1alpha1/plan.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-plan/v1alpha1/examples/plan"

echo
echo "== Dashboard contribution v1alpha2 (component links, ADR-43) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-contribution/v1alpha2/contribution.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-contribution/v1alpha2/examples/contribution"

echo
echo "== Dashboard view v1alpha2 =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-contribution/v1alpha2/view.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-contribution/v1alpha2/examples/view"

echo
echo "== Dashboard plan v1alpha2: catalogue provenance =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-plan/v1alpha2/provenance.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-plan/v1alpha2/examples/provenance"

echo
echo "== Dashboard plan v1alpha2: nexus plan =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-plan/v1alpha2/plan.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/dashboard-plan/v1alpha2/examples/plan"

echo
echo "== Runtime overlay v1alpha1: the normalized operational document =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha1/overlay.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha1/examples/overlay"

echo
echo "== Runtime overlay v1alpha1: destination-server reconciliation status =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha1/reconciliation-status.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha1/examples/reconciliation-status"

echo
echo "== Runtime overlay v1alpha2: platform backup status (cloud sinks) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha2/platform-backup-status.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha2/examples/platform-backup-status"

echo
echo "== Runtime overlay v1alpha3: platform backup status (ephemeral ledger, #582) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha3/platform-backup-status.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha3/examples/platform-backup-status"

echo
echo "== Panel catalog v1alpha1: the embeddable Grafana panels =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/panel-catalog/v1alpha1/panel-catalog.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/panel-catalog/v1alpha1/examples/catalog"

echo
echo "== Panel catalog v1alpha2: context-aware variables (ADR-100) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/panel-catalog/v1alpha2/panel-catalog.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/panel-catalog/v1alpha2/examples/catalog"

echo
echo "== Runtime overlay v1alpha2: bundle rollup scope (#565/#567) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha2/overlay.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha2/examples/overlay"

echo
echo "== Runtime overlay v1alpha1: platform backup status =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha1/platform-backup-status.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/runtime-overlay/v1alpha1/examples/platform-backup-status"

echo
echo "== Environment bundles v1alpha2: bundled profiles, including webhook targets =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-bundles/v1alpha2/bundles.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-bundles/v1alpha2/examples/bundles"

echo
echo "== Environment bundles v1alpha3: displayName, retired repository fields (#567) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-bundles/v1alpha3/bundles.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-bundles/v1alpha3/examples/bundles"

echo
echo "== Environment bundles v1alpha4: distribution identity =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-bundles/v1alpha4/bundles.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-bundles/v1alpha4/examples/bundles"

echo
echo "== Environment workspaces v1alpha1: deployment-neutral repository bindings =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-workspaces/v1alpha1/workspaces.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-workspaces/v1alpha1/examples/workspaces"

echo
echo "== Communication deployment v1alpha3 (ADR-152: + the connection gateway) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha3/values.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha3/examples/values"

echo
echo "== Environment connections v1alpha1: third-party app registrations bound to profiles (ADR-152) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/environment-connections/v1alpha1/connections.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/environment-connections/v1alpha1/examples/connections"

echo
echo "== Eval result v1alpha1: the publisher contract external harnesses target =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/eval-result/v1alpha1/eval-result.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/eval-result/v1alpha1/examples/eval-result"

echo
echo "== Lifecycle record v1alpha1: the shared telemetry envelope (#349) =="
validate_examples_dir \
  "$REPO_ROOT/agent-bundle-contracts/lifecycle-record/v1alpha1/lifecycle-record.schema.json" \
  "$REPO_ROOT/agent-bundle-contracts/lifecycle-record/v1alpha1/examples"

echo
echo "== Summary: $PASS_COUNT passed, $FAIL_COUNT failed =="

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo
  echo "Failures:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

exit 0
