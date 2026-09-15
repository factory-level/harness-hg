#!/usr/bin/env bash
# Golden-render tests for harness/hermes/charts/hermes-profile, plus helm lint / negative
# render assertions / best-effort kubeconform. Mirrors the shape of
# infra/scripts/validate-schemas.sh and infra/scripts/validate-gitops-template.sh:
# self-installs its one binary dependency (helm) user-local, no sudo.
#
# What "golden" means here: `helm template` output for two profile fixtures -
#   - tests/chart/fixtures/profile-minimal.yaml
#   - tests/chart/fixtures/profile-full.yaml (spec.apps: one remote + one
#     local helm app - the helm-apps contract's rendered-record shape)
# each layered on top of infra/gitops-template/bootstrap/values/cluster-values.yaml
# (the SAME two value files, in the SAME order, that the hermes-gitops-profiles
# ApplicationSet feeds this chart in production - see
# infra/gitops-template/bootstrap/applicationset.yaml's `helm.valueFiles`), with a
# fixed --namespace/--release-name for byte-for-byte determinism, is
# committed under tests/chart/golden/ and diffed on every run. The profile
# fixtures are chart-test-owned (see profile-minimal.yaml's header) so the
# goldens never churn when the canonical schema examples are re-authored.
# profile-full's render also layers tests/chart/fixtures/
# cluster-values-test-extra.yaml - the appProject.sourceRepos allowlist
# entry its remote app needs (see that file's header comment).
#
# Usage:
#   infra/scripts/render-test.sh          # compare against committed goldens (CI mode)
#   infra/scripts/render-test.sh --update # (re)write the golden files from current output
#
# Also runs: `helm lint`, negative-render assertions (unrecognized
# providers.compute values / cloudflare config gaps all fail with a
# readable message; expose
# without an ingress provider renders a Service but no Ingress), and a
# best-effort kubeconform pass (skipped, not failed, if kubeconform can't be
# installed - same convention as infra/scripts/validate-gitops-template.sh).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

CHART_DIR="$REPO_ROOT/harness/hermes/charts/hermes-profile"
ENDPOINT_CHART_DIR="$REPO_ROOT/harness/hermes/charts/hermes-endpoint"
BUNDLE_CHART_DIR="$REPO_ROOT/harness/hermes/charts/hermes-bundle"
GOLDEN_DIR="$REPO_ROOT/plugin/tests/chart/golden"
FIXTURES_DIR="$REPO_ROOT/plugin/tests/chart/fixtures"
CLUSTER_VALUES="$REPO_ROOT/infra/gitops-template/bootstrap/values/cluster-values.yaml"

LOCAL_BIN="${HOME}/.local/bin"
HELM_VERSION="v3.16.4"

UPDATE=0
if [[ "${1:-}" == "--update" ]]; then
  UPDATE=1
fi

FAIL_COUNT=0
log() { echo "[render-test] $*" >&2; }

ensure_helm() {
  export PATH="$LOCAL_BIN:$PATH"
  # Require the PINNED helm version, not just any helm on PATH: helm's
  # values-schema error wording changes across versions (e.g. v3.16
  # "must be one of the following" vs newer "value must be 'pod'"), and
  # the negative-render assertions below grep those messages. CI runners
  # ship a system helm that drifts; pinning keeps this script's output
  # identical everywhere.
  if command -v helm >/dev/null 2>&1 \
      && [[ "$(helm version --template '{{.Version}}' 2>/dev/null)" == "${HELM_VERSION}" ]]; then
    return
  fi
  log "pinned helm ${HELM_VERSION} not found; installing into ${LOCAL_BIN} (no sudo)"
  mkdir -p "$LOCAL_BIN"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/helm.tar.gz" "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz"
  tar -xzf "$tmp/helm.tar.gz" -C "$tmp"
  mv "$tmp/linux-amd64/helm" "$LOCAL_BIN/helm"
  chmod +x "$LOCAL_BIN/helm"
  rm -rf "$tmp"
  hash -r
  if [[ "$(helm version --template '{{.Version}}' 2>/dev/null)" != "${HELM_VERSION}" ]]; then
    log "ERROR: helm on PATH is still not ${HELM_VERSION} after install (PATH ordering?)"
    exit 1
  fi
}

ensure_helm
mkdir -p "$GOLDEN_DIR"

# infra/gitops-template/bootstrap/values/cluster-values.yaml carries unsubstituted
# scaffold tokens (__IMAGE_REPOSITORY__/__IMAGE_TAG__ plus the
# platformRepo __HERMES_GITOPS_REPO_URL__/__CHART_REVISION__ pair - see
# infra/gitops-template/README.md's "Placeholder tokens" table) - it's only ever
# consumed post-substitution in production (the emitter's scaffold step, or
# an operator's real cluster-values.yaml). Same dummy substitution
# convention as infra/scripts/validate-gitops-template.sh, so golden renders are
# deterministic and don't leak an unsubstituted token into committed output.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
SUBSTITUTED_CLUSTER_VALUES="$WORKDIR/cluster-values.yaml"
sed \
  -e 's/__IMAGE_REPOSITORY__/ghcr.io\/dummy\/hermes-agent/g' \
  -e 's/__IMAGE_TAG__/latest/g' \
  -e 's/__HERMES_GITOPS_REPO_URL__/https:\/\/git.example.com\/dummy\/hermes-gitops-plugin.git/g' \
  -e 's/__CHART_REVISION__/main/g' \
  "$CLUSTER_VALUES" > "$SUBSTITUTED_CLUSTER_VALUES"
CLUSTER_VALUES="$SUBSTITUTED_CLUSTER_VALUES"

# ---------------------------------------------------------------------------
# 1. helm lint
# ---------------------------------------------------------------------------
echo "== 1. helm lint =="
if helm lint "$CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml"; then
  echo "OK   helm lint"
else
  echo "FAIL helm lint"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# ---------------------------------------------------------------------------
# 2. golden renders
# ---------------------------------------------------------------------------
echo
echo "== 2. golden renders =="

render_golden() {
  local name="$1"
  local golden="$GOLDEN_DIR/$name.yaml"
  local out
  shift
  out="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent "$@" 2>&1)"
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "FAIL $name: helm template exited $rc"
    echo "$out" | sed 's/^/       /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return
  fi
  if [[ $UPDATE -eq 1 ]]; then
    printf '%s\n' "$out" > "$golden"
    echo "WROTE $golden"
    return
  fi
  if [[ ! -f "$golden" ]]; then
    echo "FAIL $name: no golden file at $golden (run with --update to create it)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return
  fi
  if diff -u "$golden" <(printf '%s\n' "$out") >/tmp/render-test-diff.$$; then
    echo "OK   $name matches $golden"
  else
    echo "FAIL $name differs from $golden:"
    sed 's/^/       /' /tmp/render-test-diff.$$
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  rm -f /tmp/render-test-diff.$$
}

render_golden "valid-minimal" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-minimal.yaml"
render_golden "valid-full" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml"
# Two golden renders cover the providers.ingress=cloudflare tunnel Stack CR
# path - see tests/chart/fixtures/cluster-values-cloudflare.yaml's own
# header comment for why it's a standalone fixture. profile-full.yaml
# already declares spec.expose (services: tools/8080, path /) so no --set
# is needed for that golden; profile-minimal.yaml declares no expose, so
# that golden supplies it via --set.
render_golden "valid-minimal-cloudflare" -f "$FIXTURES_DIR/cluster-values-cloudflare.yaml" -f "$FIXTURES_DIR/profile-minimal.yaml" \
  --set 'spec.expose.services[0].name=tools' --set 'spec.expose.services[0].port=8080'
render_golden "valid-full-cloudflare" -f "$FIXTURES_DIR/cluster-values-cloudflare.yaml" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml"
# The compiled capability-injection overlay (ADR-97): profile-full layered
# with the deployments/agents/<id>/values.yaml shape the topology compiler
# emits - the SAME four-layer order the hermes-gitops-agents ApplicationSet
# uses. The injected variable must render as explicit env on the agent
# container.
render_golden "valid-env-inject" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" -f "$FIXTURES_DIR/agent-env-inject.yaml"
# Apps-suppressed mode (#498): the SAME inputs as valid-full plus the
# appsManagedExternally overlay. Zero Application docs; everything else
# byte-identical to valid-full (asserted below, not just goldened).
render_golden "valid-full-apps-external" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" -f "$FIXTURES_DIR/cluster-values-apps-external.yaml"
# The suppression contract, asserted on the goldens themselves: the
# apps-external golden is EXACTLY valid-full minus its Application docs.
# Anything else differing means the value leaked into a sibling template.
# Runs in BOTH modes - --update is exactly when a bad golden would be
# committed (Codex catch), and both goldens exist by this point either way.
if python3 - "$GOLDEN_DIR/valid-full.yaml" "$GOLDEN_DIR/valid-full-apps-external.yaml" <<'PYEOF'
import sys
full, ext = (open(p).read().split("\n---\n") for p in sys.argv[1:3])
apps = [d for d in full if "\nkind: Application\n" in d]
if not apps:
    sys.exit("valid-full golden carries no Application docs - fixture broke")
if any("\nkind: Application\n" in d for d in ext):
    sys.exit("apps-external golden still renders Application docs")
if [d for d in full if d not in apps] != list(ext):
    sys.exit("apps-external differs from valid-full beyond the Application docs")
PYEOF
then
  echo "OK   appsManagedExternally suppresses exactly the Application docs (#498)"
else
  echo "FAIL appsManagedExternally suppression contract"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
# One golden covers the backup path: spec.backup declared + providers.backup=pvc
# renders the per-instance backups PVC and the archive CronJob.
render_golden "valid-backup" -f "$FIXTURES_DIR/cluster-values-backup.yaml" -f "$FIXTURES_DIR/profile-backup.yaml"
# Two goldens cover the workspace runtime (#362): one pinned read-only
# repository with a credential, and the multi-repository shape with its
# required explicit terminalCwd. Unbound profiles are proved by every
# OTHER golden staying byte-identical.
render_golden "valid-workspace" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-workspace.yaml"
render_golden "valid-workspace-multi" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-workspace-multi.yaml"
echo
echo "-- spec.workspace: real read-only mount, credential only in the init container, terminalCwd guard --"
WS_RENDER="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-workspace.yaml" 2>&1)"
if grep -q "subPath: repos/strategy-context" <<<"$WS_RENDER" \
    && grep -q "readOnly: true" <<<"$WS_RENDER" \
    && grep -q "mountPath: /workspaces/strategy-context" <<<"$WS_RENDER"; then
  echo "OK   workspace renders a subPath mount with real readOnly semantics"
else
  echo "FAIL workspace mount: expected subPath repos/strategy-context with readOnly: true"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
# The credential volume must be consumed by the init container ONLY - the
# agent container sees the checkout, never the key.
WS_AGENT_SECTION="$(sed -n '/name: hermes-agent$/,/name: dashboard$/p' <<<"$WS_RENDER")"
if grep -q "/run/secrets/repositories/strategy-context/git" <<<"$WS_RENDER" \
    && ! grep -q "/run/secrets/repositories" <<<"$WS_AGENT_SECTION"; then
  echo "OK   repository credential mounts only in the sync init container"
else
  echo "FAIL repository credential leaked outside the init container"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if grep -q "name: workspaces" <<<"$WS_RENDER"; then
  echo "OK   workspaces volumeClaimTemplate rendered"
else
  echo "FAIL workspaces volumeClaimTemplate missing"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
# Negative: two repositories WITHOUT terminalCwd refuse to render.
if WS_NEG="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-workspace-multi-nocwd.yaml" 2>&1)"; then
  echo "FAIL two workspace repositories without terminalCwd rendered anyway"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  if grep -q "several repositories need an explicit terminalCwd" <<<"$WS_NEG"; then
    echo "OK   several repositories without terminalCwd refuse to render (failed with expected message)"
  else
    echo "FAIL terminalCwd guard failed with an unexpected message:"
    echo "$WS_NEG" | tail -3 | sed 's/^/       /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi
echo
echo "-- spec.backup + providers.backup=pvc renders backups PVC and CronJob --"
BK_RENDER="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$FIXTURES_DIR/cluster-values-backup.yaml" -f "$FIXTURES_DIR/profile-backup.yaml" 2>&1)"

# Herestrings (<<<) rather than `echo | grep -q` throughout these
# assertions: under `set -o pipefail`, grep -q exits on its first match
# and a large-enough render makes echo die with SIGPIPE, failing the
# whole pipeline (bitten for real when the chart started embedding the
# observer-metrics plugin source and renders grew past the pipe buffer).
if grep -q "^kind: CronJob$" <<<"$BK_RENDER" \
    && grep -q "name: hermes-support-agent-backups$" <<<"$BK_RENDER" \
    && grep -q 'schedule: "0 3 \* \* \*"' <<<"$BK_RENDER"; then
  echo "OK   spec.backup + providers.backup=pvc renders backups PVC and CronJob"
else
  echo "FAIL spec.backup + providers.backup=pvc: expected CronJob, hermes-support-agent-backups PVC and the declared schedule"
  echo "$BK_RENDER" | grep -E "^kind:|name: hermes-support-agent-backup|schedule:" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo
echo
echo "-- compute=pod + ingress=cloudflare renders StatefulSet (with cloudflared sidecar) AND the tunnel Stack --"
CF_POD_RENDER="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$FIXTURES_DIR/cluster-values-cloudflare.yaml" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" 2>&1)"
if grep -q "^kind: StatefulSet$" <<<"$CF_POD_RENDER" \
    && grep -q "^kind: Stack$" <<<"$CF_POD_RENDER" \
    && grep -q "name: cloudflared$" <<<"$CF_POD_RENDER"; then
  echo "OK   compute=pod + ingress=cloudflare renders StatefulSet (cloudflared sidecar) and tunnel Stack"
else
  echo "FAIL compute=pod + ingress=cloudflare: expected StatefulSet+cloudflared sidecar and Stack all present"
  echo "$CF_POD_RENDER" | grep -E "^kind:|name: cloudflared" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo
echo "-- spec.apps render one Argo CD Application each (valid-full) --"
# profile-full declares THREE apps: vector-db (remote https helm repo,
# versioned chart, allow-listed via cluster-values-test-extra.yaml),
# relay (oci:// registry - the allowlist keeps the oci:// identity but
# the rendered source drops the scheme: Argo's helm-OCI contract, #187)
# and docs-site (repo: local -> the platformRepo url/revision threaded
# through cluster-values). Assert all three Applications render with the
# right source shape, land in the argocd namespace, target this profile's
# namespace, and carry the profile/persona labels.
APPS_RENDER="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" 2>&1)"
APP_COUNT="$(echo "$APPS_RENDER" | grep -c "^kind: Application$")"
if [[ "$APP_COUNT" -eq 3 ]] \
    && grep -q "name: hermes-support-agent-vector-db$" <<<"$APPS_RENDER" \
    && grep -q "repoURL: https://qdrant.github.io/qdrant-helm$" <<<"$APPS_RENDER" \
    && grep -q "chart: qdrant$" <<<"$APPS_RENDER" \
    && grep -q "targetRevision: 1.9.1$" <<<"$APPS_RENDER" \
    && grep -q "name: hermes-support-agent-relay$" <<<"$APPS_RENDER" \
    && grep -q "repoURL: ghcr.io/factory-level/charts$" <<<"$APPS_RENDER" \
    && ! grep -q "repoURL: oci://" <<<"$APPS_RENDER" \
    && grep -q "chart: marketing-sre-relay$" <<<"$APPS_RENDER" \
    && grep -q "targetRevision: 0.1.0$" <<<"$APPS_RENDER" \
    && grep -q "name: hermes-support-agent-docs-site$" <<<"$APPS_RENDER" \
    && grep -q "repoURL: https://git.example.com/dummy/hermes-gitops-plugin.git$" <<<"$APPS_RENDER" \
    && grep -q "path: cli/test-env/charts/test-page$" <<<"$APPS_RENDER" \
    && grep -q "valuesObject:" <<<"$APPS_RENDER" \
    && [[ "$(echo "$APPS_RENDER" | awk '/^kind: Application$/,/^---$/' | grep -c 'hermes-gitops.factorylevel.dev/persona: "support-agent"')" -eq 3 ]] \
    && [[ "$(echo "$APPS_RENDER" | grep -c "namespace: argocd$")" -eq 3 ]]; then
  echo "OK   spec.apps render 3 Applications (https remote, oci scheme-less, local path) with profile labels"
else
  echo "FAIL spec.apps: expected 3 Applications (vector-db https, relay oci scheme-less, docs-site local) with the contract source shapes, got $APP_COUNT"
  echo "$APPS_RENDER" | grep -E "^kind:|name: hermes-support-agent-(vector-db|docs-site)|repoURL:|chart: |path: |targetRevision:|namespace: argocd" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo
echo "-- no spec.apps means no Applications (valid-minimal) --"
MIN_RENDER="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-minimal.yaml" 2>&1)"
if ! grep -q "^kind: Application$" <<<"$MIN_RENDER"; then
  echo "OK   profile without apps renders zero Applications (agent pod only)"
else
  echo "FAIL profile without apps: expected zero Application resources"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo
echo "-- env-secret contract validation (valid-full) --"
# spec.envRequires no longer renders an ExternalSecret (issue #38 [K6]):
# the infra program materializes "hermes-<name>-env" directly from
# stack-encrypted config (agentSecrets), and the workload references that
# exact name via envFrom. Assert the chart side of the contract.
FULL_RENDER="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" 2>&1)"
# The API-key generator (apikey-secret.yaml) legitimately renders ONE
# ExternalSecret (generatorRef, no secret store) - assert exactly that
# one remains and that none of them targets the env Secret.
ES_COUNT="$(echo "$FULL_RENDER" | grep -c "^kind: ExternalSecret$")"
if grep -q "name: hermes-support-agent-env" <<<"$FULL_RENDER" \
    && [[ "$ES_COUNT" -eq 1 ]] \
    && ! { grep -A6 "^kind: ExternalSecret$" <<<"$FULL_RENDER" | grep -q "hermes-support-agent-env"; }; then
  echo "OK   valid-full envFrom references hermes-support-agent-env; only the API-key generator ExternalSecret remains"
else
  echo "FAIL valid-full env-secret contract: expected envFrom secretRef hermes-support-agent-env and exactly one (API-key) ExternalSecret, got $ES_COUNT"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# ---------------------------------------------------------------------------
# 3. negative render assertions
# ---------------------------------------------------------------------------
echo
echo "== 3. negative render assertions =="

assert_fails_with() {
  local desc="$1" needle="$2" out rc
  shift 2
  out="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent "$@" 2>&1)"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "FAIL $desc: expected failure, helm template succeeded"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return
  fi
  if grep -qF "$needle" <<<"$out"; then
    echo "OK   $desc (failed with expected message)"
  else
    echo "FAIL $desc: failed, but message didn't contain expected text ($needle):"
    echo "$out" | sed 's/^/       /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# hermes.appsGuard: a remote helm repo that isn't in the platform's
# appProject.sourceRepos allowlist fails the render loudly (naming both
# places to fix) instead of rendering an Application the AppProject would
# refuse to sync. The scaffold-template cluster-values ships an EMPTY
# allowlist, so simply dropping the test-extra layer models it.
assert_fails_with "remote app repo not in the sourceRepos allowlist" \
  "spec.apps[vector-db].repo https://qdrant.github.io/qdrant-helm is not in the platform's allow-list" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-full.yaml"

# hermes.appsGuard: duplicate app names would render two Applications with
# the same metadata.name (silent last-write-wins) - fail instead.
assert_fails_with "duplicate spec.apps names rejected" \
  'app name "vector-db" is declared twice' \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set 'spec.apps[1].name=vector-db'

# hermes.appsGuard: local charts version with the platform repo - a
# version field on a repo:local app is a contract violation.
assert_fails_with "version forbidden for repo:local apps" \
  "spec.apps[docs-site].version is forbidden for repo: local" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set 'spec.apps[2].version=9.9.9'

# hermes.envGuard (ADR-97): a compiled injection whose name collides with
# a declared envRequires entry would SHADOW the secret value (explicit env
# beats envFrom in Kubernetes) - fail instead. profile-full declares
# DISCORD_BOT_TOKEN in envRequires.
assert_fails_with "spec.env colliding with a declared envRequires entry" \
  "would SHADOW the secret value delivered by envFrom" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set 'spec.env.DISCORD_BOT_TOKEN=http://not-a-token/'

# hermes.envGuard: a compiled injection cannot override a variable the
# chart sets itself (the agent's own runtime contract).
assert_fails_with "spec.env colliding with a chart-owned variable" \
  "collides with a variable the chart sets itself" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-minimal.yaml" \
  --set 'spec.env.API_SERVER_KEY=stolen'

# gce/libvirt were REMOVED as compute providers (issue #27 [G8]): the chart
# values schema's compute enum rejects them before any template renders
# (hermes.computeGuard remains as a second line of defense for renders
# that bypass schema validation).
assert_fails_with "providers.compute=libvirt rejected as unrecognized" \
  'providers.compute must be one of the following: "pod"' \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-minimal.yaml" \
  --set providers.compute=libvirt

assert_fails_with "providers.compute=gce rejected as unrecognized" \
  'providers.compute must be one of the following: "pod"' \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-minimal.yaml" \
  --set providers.compute=gce

# providers.ingress=tailscale was REMOVED (ADR-9, #131). The assertion
# inverts: it must now fail as unrecognized like any other unimplemented
# provider, which is what stops a half-implementation from rendering.
assert_fails_with "providers.ingress=tailscale rejected as unrecognized" \
  "providers.ingress must be one of the following" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-minimal.yaml" \
  --set providers.ingress=tailscale

# Unrecognized ingress values still fail as before - at the
# values.schema.json enum, upstream of hermes.ingressGuard (whose own
# unrecognized-value branch stays as defense in depth for schema-less
# renders).
assert_fails_with "providers.ingress=carrier-pigeon rejected as unrecognized" \
  "providers.ingress must be one of the following" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-minimal.yaml" \
  --set providers.ingress=carrier-pigeon

# providers.ingress=cloudflare is IMPLEMENTED - the negative cases below
# exercise hermes.cloudflareConfigGuard.
assert_fails_with "providers.ingress=cloudflare without cloudflare{} config" \
  "requires cluster-values cloudflare.accountId, cloudflare.zoneId, cloudflare.zoneName to be set" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-minimal.yaml" \
  --set providers.ingress=cloudflare

assert_fails_with "providers.ingress=cloudflare without spec.expose" \
  "requires spec.expose.services to be set" \
  -f "$FIXTURES_DIR/cluster-values-cloudflare.yaml" -f "$FIXTURES_DIR/profile-minimal.yaml"

# spec.backup is INTENT; providers.backup is the platform's implementation.
# Declared intent with no platform backing must fail the render loudly
# (hermes.backupGuard) instead of silently deploying without backups.
# providers.backup=none is forced explicitly: the gitops-template scaffold
# defaults to pvc (backups available out of the box), so this negative case
# models a cluster whose operator turned the destination OFF while a profile
# still declares intent.
assert_fails_with "spec.backup declared but providers.backup=none" \
  "declares spec.backup but providers.backup is" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/profile-backup.yaml" \
  --set providers.backup=none

assert_fails_with "providers.ingress=cloudflare access.policy=idp without cloudflare.access.idpId" \
  "requires cluster-values cloudflare.access.idpId" \
  -f "$FIXTURES_DIR/cluster-values-cloudflare.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set 'spec.expose.access.policy=idp'

assert_fails_with "providers.ingress=cloudflare self-managed backend missing backendUrl" \
  "requires cloudflare.pulumiBackend.selfManaged.backendUrl" \
  -f "$FIXTURES_DIR/cluster-values-cloudflare.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set cloudflare.pulumiBackend.selfManaged.backendUrl=""

# gsm/vault/sops were REMOVED as secret providers (issue #30 [H1]) - the
# schemas' secret enum rejects them before any template renders.
assert_fails_with "providers.secret=gsm rejected as unrecognized" \
  'providers.secret must be one of the following: "k8s"' \
  -f "$FIXTURES_DIR/cluster-values-cloudflare.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set providers.secret=gsm

echo
echo "-- providers.ingress=cloudflare providers.compute=pod still defaults workspaceServiceAccountName to hermes.fullname --"
CF_POD_DEFAULT_SA_OUT="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$FIXTURES_DIR/cluster-values-cloudflare.yaml" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set cloudflare.tunnel.workspaceServiceAccountName="" 2>&1)"
if grep -q "^  serviceAccountName: hermes-support-agent$" <<<"$CF_POD_DEFAULT_SA_OUT"; then
  echo "OK   providers.compute=pod + ingress=cloudflare defaults workspaceServiceAccountName to hermes.fullname"
else
  echo "FAIL providers.compute=pod + ingress=cloudflare: expected serviceAccountName to default to hermes.fullname"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

assert_fails_with "expose.services[].name=http is reserved" \
  "name='http' is reserved for the agent API port" \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set 'spec.expose.services[0].name=http'

echo
echo "-- expose without ingress provider renders Service only --"
NO_INGRESS_OUT="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set providers.ingress=none 2>&1)"
if grep -q "^kind: Service$" <<<"$NO_INGRESS_OUT" && ! grep -q "^kind: Ingress$" <<<"$NO_INGRESS_OUT"; then
  echo "OK   expose + providers.ingress=none renders Service, no Ingress"
else
  echo "FAIL expose + providers.ingress=none: expected Service present / Ingress absent"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo
echo "-- expose entry on the built-in gateway port (8642) is deduped in the Service --"
# An expose.services entry on 8642 must NOT re-declare the port the built-in
# `http` entry already serves: ServerSideApply rejects duplicate ports[] keys,
# wedging the sync. Exactly one `port: 8642` may render.
GW_DEDUPE_OUT="$(helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
  --set 'spec.expose.services[0].name=tools' --set 'spec.expose.services[0].port=8642' 2>&1)"
GW_PORT_COUNT="$(grep -c "^      port: 8642$" <<<"$GW_DEDUPE_OUT" || true)"
if [[ "$GW_PORT_COUNT" -eq 1 ]]; then
  echo "OK   expose on 8642 renders exactly one Service port (built-in http)"
else
  echo "FAIL expose on 8642: expected exactly 1 'port: 8642' in the render, got ${GW_PORT_COUNT}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# ---------------------------------------------------------------------------
# 4. kubeconform (best-effort)
# ---------------------------------------------------------------------------

echo
echo "== 3b. hermes-endpoint golden renders =="
endpoint_golden() {
  local name="$1"; shift
  local out
  out="$(helm template ep-test "$ENDPOINT_CHART_DIR" \
    --namespace hermes-endpoints "$@" 2>&1)"
  if [[ $? -ne 0 ]]; then
    echo "FAIL render $name:"; echo "$out" | sed 's/^/       /'; FAIL_COUNT=$((FAIL_COUNT+1)); return
  fi
  local golden="$GOLDEN_DIR/endpoint-$name.yaml"
  if [[ $UPDATE -eq 1 ]]; then
    printf '%s\n' "$out" > "$golden"; log "updated $golden"
  elif ! diff -u "$golden" <(printf '%s\n' "$out") >/dev/null 2>&1; then
    echo "FAIL golden endpoint-$name differs (run with --update if intentional)"
    diff -u "$golden" <(printf '%s\n' "$out") | head -40
    FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   golden endpoint-$name"
  fi
}
endpoint_golden "ingress-full" \
  -f "$FIXTURES_DIR/endpoint-cluster-values-ingress.yaml" \
  -f "$FIXTURES_DIR/endpoint-record-full.yaml"
endpoint_golden "none-full" \
  -f "$FIXTURES_DIR/endpoint-record-full.yaml"
# The six-type contract (#147, ADR-27/35/99), asserted against the render
# rather than trusted to the goldens' diffs: the fixture carries all six
# endpoint types, and exactly two - public and webhook - may produce edge
# objects. authenticated/external rendering an Ingress would be an open
# door where a gate was declared; internal/private rendering anything
# would leak a cluster-DNS-only endpoint to the edge.
EP_RENDER="$(helm template ep-test "$ENDPOINT_CHART_DIR" --namespace hermes-endpoints \
  -f "$FIXTURES_DIR/endpoint-cluster-values-ingress.yaml" -f "$FIXTURES_DIR/endpoint-record-full.yaml" 2>&1)"
EP_INGRESS_COUNT="$(grep -c "^kind: Ingress$" <<<"$EP_RENDER" || true)"
if [[ "$EP_INGRESS_COUNT" == "2" ]] \
    && grep -q 'hermes.dev/endpoint-type: "public"' <<<"$EP_RENDER" \
    && grep -q 'hermes.dev/endpoint-type: "webhook"' <<<"$EP_RENDER" \
    && ! grep -q 'hermes.dev/endpoint-type: "authenticated"' <<<"$EP_RENDER" \
    && ! grep -q 'hermes.dev/endpoint-type: "external"' <<<"$EP_RENDER" \
    && ! grep -q 'hermes.dev/endpoint-type: "internal"' <<<"$EP_RENDER" \
    && ! grep -q 'hermes.dev/endpoint-type: "private"' <<<"$EP_RENDER"; then
  log "OK   six-type contract: exactly public+webhook reach the edge; the other four render nothing"
else
  echo "FAIL six-type contract: expected exactly 2 Ingresses (public, webhook), got $EP_INGRESS_COUNT:"
  grep -E "^kind: Ingress|endpoint-type" <<<"$EP_RENDER" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
# negative: declaring the unimplemented cloudflare mode fails loudly
if helm template ep "$ENDPOINT_CHART_DIR" --set providers.ingress=cloudflare \
    -f "$FIXTURES_DIR/endpoint-record-full.yaml" >/dev/null 2>&1; then
  echo "FAIL endpoint chart accepted providers.ingress=cloudflare (must fail until implemented)"
  FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   cloudflare mode refused (declared follow-up)"
fi

echo
echo "== 3bc. hermes-bundle golden renders =="
# The bundle chart had NO golden and no test of any kind, which is how it
# shipped for a milestone with no backup routine at all - two bundled
# agents unprotected, and nothing to notice (#282).
bundle_golden() {
  local name="$1"; shift
  local out
  out="$(helm template hermes-bundle-marketing-core "$BUNDLE_CHART_DIR" \
    --namespace hermes-marketing-core "$@" 2>&1)"
  if [[ $? -ne 0 ]]; then
    echo "FAIL render bundle-$name:"; echo "$out" | sed 's/^/       /'; FAIL_COUNT=$((FAIL_COUNT+1)); return
  fi
  local golden="$GOLDEN_DIR/bundle-$name.yaml"
  if [[ $UPDATE -eq 1 ]]; then
    printf '%s\n' "$out" > "$golden"; log "updated $golden"
  elif ! diff -u "$golden" <(printf '%s\n' "$out") >/dev/null 2>&1; then
    echo "FAIL golden bundle-$name differs (run with --update if intentional)"
    diff -u "$golden" <(printf '%s\n' "$out") | head -40
    FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   golden bundle-$name"
  fi
}
bundle_golden "backup" \
  -f "$FIXTURES_DIR/cluster-values-backup.yaml" \
  -f "$FIXTURES_DIR/bundle-values.yaml"
bundle_golden "no-sink" -f "$FIXTURES_DIR/bundle-values.yaml"
bundle_golden "networkpolicy" -f "$FIXTURES_DIR/bundle-values.yaml" --set networkPolicy.enabled=true
# Bundling must never be a security DOWNGRADE: the policy has to admit
# every port a member listens on, or turning it on quietly severs them.
np_out="$(helm template b "$BUNDLE_CHART_DIR" -f "$FIXTURES_DIR/bundle-values.yaml" --set networkPolicy.enabled=true 2>&1)"
if grep -q "port: 8642" <<<"$np_out" && grep -q "port: 8644" <<<"$np_out"; then
  log "OK   bundle NetworkPolicy admits every declared member port"
else
  echo "FAIL bundle NetworkPolicy is missing a member's port"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# An unclonable workspace must DEGRADE, never take the pod down: refusing
# to boot over one external checkout takes down every agent in the bundle.
boot_out="$(helm template b "$BUNDLE_CHART_DIR" -f "$FIXTURES_DIR/bundle-values.yaml" 2>&1)"
if grep -q "workspace brand is UNAVAILABLE" <<<"$boot_out" \
   && grep -q "workspace-brand.unavailable" <<<"$boot_out"; then
  log "OK   an unclonable workspace degrades and records why"
else
  echo "FAIL bundle boot does not degrade on an unclonable workspace"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if helm template b "$BUNDLE_CHART_DIR" -f "$FIXTURES_DIR/bundle-values.yaml" 2>&1 | grep -q "kind: NetworkPolicy"; then
  echo "FAIL bundle rendered a NetworkPolicy without opting in"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   NetworkPolicy is opt-in"
fi
# The routine must exist ONLY when the environment offers a sink, and must
# archive the data volume - not the workspaces one, whose restore target
# would be ambiguous beside it.
bundle_out="$(helm template b "$BUNDLE_CHART_DIR" -f "$FIXTURES_DIR/cluster-values-backup.yaml" -f "$FIXTURES_DIR/bundle-values.yaml" 2>&1)"
if grep -q 'hermes.dev/backup-routine' <<<"$bundle_out" \
   && grep -q 'claimName: data-hermes-marketing-core-0' <<<"$bundle_out" \
   && ! grep -q 'claimName: workspaces-' <<<"$bundle_out"; then
  log "OK   bundle backup routine archives the data volume only"
else
  echo "FAIL bundle backup routine missing or archiving the wrong volume"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if helm template b "$BUNDLE_CHART_DIR" -f "$FIXTURES_DIR/bundle-values.yaml" 2>&1 | grep -q 'hermes.dev/backup-routine'; then
  echo "FAIL bundle rendered a backup routine with no sink declared"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   no sink declared -> no bundle backup routine"
fi

echo
echo "== 3bb. nexus golden renders (RBAC + deployment) =="
# The nexus chart had no golden at all, because two of its ConfigMaps embed
# the entire python backend and both JS bundles - half a megabyte that
# would churn on every UI change and get rubber-stamped. --show-only keeps
# the parts a human should actually review: what the pod may READ, and what
# rolls it. The config ConfigMap is asserted by content below rather than
# goldened, for the same size reason.
NEXUS_CHART_DIR="$REPO_ROOT/control-plane/nexus/chart"
nexus_golden() {
  local name="$1" template="$2"
  local out
  if ! out="$(helm template nexus-test "$NEXUS_CHART_DIR" --namespace hermes-gitops \
      --set gitopsUrl=https://git.invalid/gitops.git --show-only "$template" 2>&1)"; then
    echo "FAIL render nexus-$name:"; echo "$out" | sed 's/^/       /'; FAIL_COUNT=$((FAIL_COUNT+1)); return
  fi
  local golden="$GOLDEN_DIR/nexus-$name.yaml"
  if [[ $UPDATE -eq 1 ]]; then
    printf '%s\n' "$out" > "$golden"; log "updated $golden"
  elif ! diff -u "$golden" <(printf '%s\n' "$out") >/dev/null 2>&1; then
    echo "FAIL golden nexus-$name differs (run with --update if intentional)"
    diff -u "$golden" <(printf '%s\n' "$out") | head -40
    FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   golden nexus-$name"
  fi
}
nexus_golden "rbac" "templates/rbac.yaml"
nexus_golden "deployment" "templates/deployment.yaml"

# The overlay's read surface, asserted rather than described: a widening
# here is a widening of what a compromised read-only UI pod can enumerate.
# `pods` (specs only) joined the surface with ADR-77's /nexus/workspaces
# mount-presence check; pod SUBRESOURCES (exec/log/attach) and secrets
# stay forbidden - a spec carries env names and secret references, never
# values, and never a shell.
nexus_rbac="$(helm template nexus-test "$NEXUS_CHART_DIR" --namespace hermes-gitops \
  --set gitopsUrl=https://git.invalid/gitops.git --show-only templates/rbac.yaml 2>/dev/null)"
for forbidden in "secrets" "pods/exec" "pods/log" "pods/attach" '"\*"'; do
  if grep -qE "resources:.*$forbidden" <<<"$nexus_rbac"; then
    echo "FAIL nexus RBAC grants $forbidden - the overlay reads Applications, CronJobs, pod specs and one named ConfigMap only"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
done
# ConfigMap access is allowed ONLY resourceNames-scoped (the reconciliation
# record). A configmaps rule without resourceNames would let the pod read
# every mounted config in the namespace.
if grep -E 'resources:.*configmaps' <<<"$nexus_rbac" >/dev/null; then
  if ! grep -A1 -E 'resources:.*configmaps' <<<"$nexus_rbac" | grep -q 'resourceNames'; then
    echo "FAIL nexus RBAC grants configmaps without resourceNames scoping"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
fi
if grep -qE 'verbs:.*(create|update|patch|delete)' <<<"$nexus_rbac"; then
  echo "FAIL nexus RBAC grants a write verb - Nexus is a projection, never a second authority"
  FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   nexus RBAC is read-only and narrow"
fi

# The config ConfigMap carries what the adapters need. Asserted by content
# (the same file embeds the backend, so a golden would be unreviewable).
nexus_cfg="$(helm template nexus-test "$NEXUS_CHART_DIR" --namespace hermes-gitops \
  --set gitopsUrl=https://git.invalid/gitops.git --set prometheusBaseUrl=http://prom.test:9090 \
  --show-only templates/configmaps.yaml 2>/dev/null)"
for want in "prometheus: {baseUrl: \"http://prom.test:9090\"}" "backupStaleHours: 48"; do
  if ! grep -qF "$want" <<<"$nexus_cfg"; then
    echo "FAIL nexus config is missing: $want"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
done
log "OK   nexus config carries the adapter settings"

echo
echo "== 3bc. monitoring-family golden renders =="
# Gates for the monitoring, fleet-dashboard and observability charts
# (canonical control-plane/ paths): three ConfigMap charts whose entire
# output is dashboard/alert JSON that nothing previously reviewed. One
# fixed render each; the JSON diff IS the review.
family_golden() {
  local name="$1" chart="$2" release="$3" ns="$4"; shift 4
  local out
  if ! out="$(helm template "$release" "$REPO_ROOT/$chart" --namespace "$ns" "$@" 2>&1)"; then
    echo "FAIL render $name:"; echo "$out" | sed 's/^/       /'; FAIL_COUNT=$((FAIL_COUNT+1)); return
  fi
  local golden="$GOLDEN_DIR/$name.yaml"
  if [[ $UPDATE -eq 1 ]]; then
    printf '%s\n' "$out" > "$golden"; log "updated $golden"
  elif ! diff -u "$golden" <(printf '%s\n' "$out") >/dev/null 2>&1; then
    echo "FAIL golden $name differs (run with --update if intentional)"
    diff -u "$golden" <(printf '%s\n' "$out") | head -40
    FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   golden $name"
  fi
}
# Per-profile: a realistic persona namespace, one alert receiver so the
# rules render too (the receivers guard is exercised negatively below).
family_golden "monitoring-profile" "control-plane/monitoring/chart" "monitoring" "hermes-social-media" \
  --set alert.webhookUrl=https://sink.invalid/alerts
# The business-health rules (#408) are off by default, so the golden above
# renders them not at all - and the float64 threshold trap only exists in
# the rendered output. A second render with both on is what makes the
# thresholds reviewable as numbers rather than strings.
family_golden "monitoring-business" "control-plane/monitoring/chart" "monitoring" "hermes-social-media" \
  --set alert.webhookUrl=https://sink.invalid/alerts \
  --set alert.business.failures.enabled=true \
  --set alert.business.failures.event=content.published/v1 \
  --set alert.business.inactivity.enabled=true \
  --set alert.business.inactivity.event=content.published/v1 \
  --set alert.business.inactivity.minCount=3
# The #407 contract, asserted against the render: the inactivity rule
# only evaluates while telemetry is present, and telemetry-missing is
# its OWN rule - never conflated with an idle pipeline.
BIZ_RENDER="$(helm template monitoring "$REPO_ROOT/control-plane/monitoring/chart" --namespace hermes-social-media \
  --set alert.webhookUrl=https://sink.invalid/alerts \
  --set alert.business.failures.enabled=true \
  --set alert.business.failures.event=content.published/v1 \
  --set alert.business.inactivity.enabled=true \
  --set alert.business.inactivity.event=content.published/v1 \
  --set alert.business.inactivity.minCount=3 2>&1)"
if grep -q "BusinessTelemetryMissing" <<<"$BIZ_RENDER" \
    && grep -q 'and on() (sum(hermes_router_up) > 0)' <<<"$BIZ_RENDER" \
    && grep -q "fewer than 3 successful" <<<"$BIZ_RENDER" \
    && grep -q "hermes_business_eventid_varied_total" <<<"$BIZ_RENDER" \
    && grep -q "execErrState: Alerting" <<<"$BIZ_RENDER"; then
  log "OK   business rules: telemetry guard present (and alert-on-exec-error), rate floor renders, durable-dedupe posture stated (#444)"
else
  echo "FAIL business rules: expected telemetry guard + router gate + minCount floor + the #444 dedupe posture"
  grep -E "title:|expr:" <<<"$BIZ_RENDER" | sed 's/^/       /' | head -12
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
# Fleet: two budgets + the fleet-total rule, one receiver.
family_golden "fleet-dashboard" "control-plane/fleet-dashboard/chart" "fleet-dashboard" "hermes-monitoring" \
  --set budgets.social-media=25 --set budgets.event-manager=100 \
  --set alert.fleetBudgetUsd=200 --set alert.webhookUrl=https://sink.invalid/alerts
# Control plane: static, no values beyond defaults.
family_golden "control-plane-observability" "control-plane/observability/chart" \
  "control-plane-observability" "hermes-monitoring"
# Log aggregation (#661): static chart, defaults only.
family_golden "loki" "control-plane/loki/chart" "loki" "hermes-monitoring"
# The in-cluster manual (#664): static chart, defaults only.
family_golden "wiki" "control-plane/wiki/chart" "wiki" "hermes-system"

# The receivers guards must still FAIL a render that would create rules
# with nowhere to send them - an alert with no receiver is a silent no-op,
# and silent is worse than loud. Asserted for both charts that carry one.
if helm template monitoring "$REPO_ROOT/control-plane/monitoring/chart" --namespace hermes-social-media \
    >/dev/null 2>&1; then
  echo "FAIL control-plane/monitoring/chart rendered alert rules with no receiver (receiversGuard is dead)"
  FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   control-plane/monitoring/chart refuses rules with no receiver"
fi
# ...including the case the guard USED to miss (#617): the business rules were
# added after the guard was written and were never added to it, so a profile
# with only a business rule enabled rendered a contact point with an empty
# receivers list and three rules pointing at it. `event` is set so the only
# possible failure is the guard - the `required` on that field would otherwise
# fire first and pass this test for the wrong reason.
BIZ_ONLY_ERR="$(helm template monitoring "$REPO_ROOT/control-plane/monitoring/chart" \
    --namespace hermes-social-media \
    --set alert.siteVisits5m.enabled=false \
    --set alert.health.enabled=false \
    --set alert.business.failures.enabled=true \
    --set alert.business.failures.event=content.published/v1 2>&1 || true)"
if printf '%s' "$BIZ_ONLY_ERR" | grep -qF "alert.webhookUrl is not set"; then
  log "OK   control-plane/monitoring/chart refuses business-only rules with no receiver (#617)"
else
  echo "FAIL control-plane/monitoring/chart rendered business-only rules with no receiver (#617 regressed)"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
# Asking for the Alertmanager path and getting nothing is the same class of
# silence (#620): alertmanager.enabled with only discordUrl set used to render
# NO AlertmanagerConfig at all, and the profile's namespaced stack alerts went
# on reaching the tree's "null" receiver.
AM_DISCORD_ERR="$(helm template monitoring "$REPO_ROOT/control-plane/monitoring/chart" \
    --namespace hermes-social-media \
    --set alert.discordUrl=https://discord.invalid/hook \
    --set alert.alertmanager.enabled=true 2>&1 || true)"
if printf '%s' "$AM_DISCORD_ERR" | grep -qE "Discord is roadmap-only|no Alertmanager receiver URL resolves"; then
  log "OK   control-plane/monitoring/chart refuses alertmanager.enabled with no Alertmanager URL (#620)"
else
  echo "FAIL control-plane/monitoring/chart silently skipped the AlertmanagerConfig (#620 regressed)"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
# ...and the documented escape hatch still works: Grafana-only is a legitimate
# choice, it just has to be stated rather than implied by an empty value.
if helm template monitoring "$REPO_ROOT/control-plane/monitoring/chart" --namespace hermes-social-media \
    --set alert.webhookUrl=https://alerts.invalid/hook \
    --set alert.alertmanager.enabled=false >/dev/null 2>&1; then
  log "OK   charts/monitoring renders Grafana-only when alertmanager is off (#620)"
else
  echo "FAIL charts/monitoring refused a legitimate Grafana-only profile (#620)"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
if helm template fleet "$REPO_ROOT/control-plane/fleet-dashboard/chart" --namespace hermes-monitoring \
    --set budgets.social-media=25 >/dev/null 2>&1; then
  echo "FAIL control-plane/fleet-dashboard/chart rendered budget rules with no receiver (receiversGuard is dead)"
  FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   control-plane/fleet-dashboard/chart refuses rules with no receiver"
fi

# The design-15 stable uids are a platform promise (the embed set and
# `hg test --tier register` both resolve them). Grep the goldens, not the
# templates - what ships is what is checked.
for pair in "control-plane-observability:hg-control-plane-overview" \
            "control-plane-observability:hg-control-plane-reconciliation" \
            "control-plane-observability:hg-backup-history" \
            "fleet-dashboard:hermes-fleet-tco"; do
  g="$GOLDEN_DIR/${pair%%:*}.yaml"; uid="${pair##*:}"
  if [[ -f "$g" ]] && ! grep -q "\"uid\": \"$uid\"" "$g"; then
    echo "FAIL $g does not carry the promised uid $uid"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
done
log "OK   promised dashboard uids present in the goldens"

echo
echo "== 3c. hermes-event-router golden render =="
ROUTER_CHART_DIR="$REPO_ROOT/control-plane/event-router/chart"
ROUTER_VALUES="$REPO_ROOT/agent-bundle-contracts/communication-deployment/v1alpha1/examples/values/valid-full.yaml"
if out="$(helm template router-test "$ROUTER_CHART_DIR" --namespace hermes-system \
    -f "$ROUTER_VALUES" --set recordingBase=http://sink.invalid 2>&1)"; then
  golden="$GOLDEN_DIR/event-router-full.yaml"
  if [[ $UPDATE -eq 1 ]]; then
    printf '%s\n' "$out" > "$golden"; log "updated $golden"
  elif ! diff -u "$golden" <(printf '%s\n' "$out") >/dev/null 2>&1; then
    echo "FAIL golden event-router-full differs (run with --update if intentional)"
    diff -u "$golden" <(printf '%s\n' "$out") | head -40
    FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   golden event-router-full"
  fi
else
  echo "FAIL render event-router-full:"; echo "$out" | sed 's/^/       /'; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# A router with no durableProvider renders NO dead-letter routine: the DLQ
# is the broker's, and a routine whose restore hook names a Deployment
# nothing rendered fails the whole platform restore. This is the shape a
# connections-only router has (ADR-152), and it broke a real
# `hg platform verify-restore` before the gate existed.
NO_BROKER="$(helm template router-test "$ROUTER_CHART_DIR" --namespace hermes-system \
  -f "$ROUTER_VALUES" --set recordingBase=http://sink.invalid --set spec.durableProvider=null 2>&1)"
if grep -q "dlq-backup" <<<"$NO_BROKER"; then
  echo "FAIL event-router: a plane with no durableProvider still renders the dlq routine"
  FAIL_COUNT=$((FAIL_COUNT+1))
elif grep -qE '^  name: .*-redis$' <<<"$NO_BROKER"; then
  echo "FAIL event-router: a plane with no durableProvider still renders redis"
  FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   event-router without a durableProvider renders neither redis nor the dlq routine"
fi

# negative: a bare install (no compiled record) must refuse loudly
if helm template router "$ROUTER_CHART_DIR" >/dev/null 2>&1; then
  echo "FAIL event-router chart rendered without a compiled spec (must refuse)"
  FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   event-router bare install refused (spec required)"
fi

echo
echo "== 3d. nexus golden renders (ADR-48 + ADR-53) =="
NEXUS_CHART_DIR="$REPO_ROOT/control-plane/nexus/chart"
nexus_golden() {
  local name="$1"; shift
  local golden="$GOLDEN_DIR/nexus-$name.yaml"
  local out
  if out="$(helm template nexus "$NEXUS_CHART_DIR" --namespace hermes-nexus "$@" 2>&1)"; then
    if [[ $UPDATE -eq 1 ]]; then
      printf '%s\n' "$out" > "$golden"; log "updated $golden"
    elif [[ ! -f "$golden" ]]; then
      echo "FAIL nexus-$name: no golden at $golden (run with --update to create it)"
      FAIL_COUNT=$((FAIL_COUNT+1))
    elif ! diff -u "$golden" <(printf '%s\n' "$out") >/dev/null 2>&1; then
      echo "FAIL golden nexus-$name differs (run with --update if intentional)"
      diff -u "$golden" <(printf '%s\n' "$out") | head -40
      FAIL_COUNT=$((FAIL_COUNT+1))
    else
      log "OK   golden nexus-$name"
    fi
  else
    echo "FAIL render nexus-$name:"; echo "$out" | sed 's/^/       /'; FAIL_COUNT=$((FAIL_COUNT+1))
  fi
}
# The local loop: anonymous git:// clone, CLI-owned, port-forward URLs.
nexus_golden "cli-owned" --set gitopsUrl=git://10.0.0.1:9418/gitops.git \
  --set argocdBaseUrl=http://127.0.0.1:8080 --set grafanaBaseUrl=http://127.0.0.1:3000
# A real deployment (ADR-53): private repo over https with credentials from
# a Secret, published integration URLs, and the owner stamp `hg up` reads
# back to stand down. These two goldens are the whole point of the pair -
# they are what would catch the token leaking into the clone URL, or the
# owner label silently disappearing.
nexus_golden "pulumi-owned" --set gitopsUrl=https://github.com/org/gitops.git \
  --set gitopsAuth.secretName=nexus-gitops-auth \
  --set argocdBaseUrl=https://argocd.example.com --set grafanaBaseUrl=https://grafana.example.com \
  --set owner=pulumi
# negative: the chart must refuse without a repo to read the plan from -
# a Nexus with no GitOps URL would serve an empty canvas and look fine.
if helm template nexus "$NEXUS_CHART_DIR" >/dev/null 2>&1; then
  echo "FAIL nexus chart rendered without gitopsUrl (must refuse)"
  FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   nexus bare install refused (gitopsUrl required)"
fi

echo
echo "== 3e. eve-agent golden renders (ADR-149) =="
# The Eve runtime's chart. Every golden layers the SAME cluster-values the
# hermes-profile chart consumes first - that is the ApplicationSet's real
# shape, and it proves the chart tolerates the Hermes keys (image,
# platformRepo, appProject, ...) landing under it.
EVE_CHART_DIR="$REPO_ROOT/harness/eve/charts/eve-agent"
eve_golden() {
  local name="$1"; shift
  local out
  out="$(helm template ag-eve-echo "$EVE_CHART_DIR" \
    --namespace ag-eve-echo -f "$CLUSTER_VALUES" "$@" 2>&1)"
  if [[ $? -ne 0 ]]; then
    echo "FAIL render $name:"; echo "$out" | sed 's/^/       /'; FAIL_COUNT=$((FAIL_COUNT+1)); return
  fi
  local golden="$GOLDEN_DIR/eve-$name.yaml"
  if [[ $UPDATE -eq 1 ]]; then
    printf '%s\n' "$out" > "$golden"; log "updated $golden"
  elif ! diff -u "$golden" <(printf '%s\n' "$out") >/dev/null 2>&1; then
    echo "FAIL golden eve-$name differs (run with --update if intentional)"
    diff -u "$golden" <(printf '%s\n' "$out") | head -40
    FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   golden eve-$name"
  fi
}
eve_golden "minimal" -f "$FIXTURES_DIR/eve-record-minimal.yaml"
# The production startup gate's immutable image must reach both build and serve containers.
EVE_MIN_RENDER_EARLY="$(helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-minimal.yaml" 2>&1)"
TEAM_RUNTIME_DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TEAM_DIGEST_RENDER="$(helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
  -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set "runtimeImage.digest=$TEAM_RUNTIME_DIGEST" 2>&1)"
if [[ "$(grep -c "image:.*@$TEAM_RUNTIME_DIGEST" <<<"$TEAM_DIGEST_RENDER")" == "2" ]]; then
  log "OK   eve production digest pins both build and serve images"
else
  echo "FAIL eve runtime digest does not pin both containers"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
  -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set runtimeImage.digest=mutable >/dev/null 2>&1; then
  echo "FAIL eve accepted malformed runtime digest"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve rejects malformed runtime digest"
fi

# A per-agent runtime pin (ADR 0192) tells the BUILD container which eve its
# image must ship; the serving container is unchanged, and an unpinned record
# carries the variable nowhere at all.
EVE_PIN_RENDER="$(helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
  -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set runtimeImage.eveVersion=9.9.9 2>&1)"
if [[ "$(grep -c "name: EXPECTED_EVE_VERSION" <<<"$EVE_PIN_RENDER")" == "1" ]] \
    && grep -A1 "name: EXPECTED_EVE_VERSION" <<<"$EVE_PIN_RENDER" | grep -q '"9.9.9"' \
    && [[ "$(awk '/- name: build-agent/,/- name: eve-agent/' <<<"$EVE_PIN_RENDER" | grep -c 'name: EXPECTED_EVE_VERSION')" == "1" ]]; then
  log "OK   eve runtime pin reaches the build container only"
else
  echo "FAIL eve runtime pin: expected one EXPECTED_EVE_VERSION=9.9.9 in the build container"
  grep -n "EXPECTED_EVE_VERSION" <<<"$EVE_PIN_RENDER" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
# The local loop runs a locally built image whose TAG is a build name, not an Eve
# release (cli/src/platform/index.ts localEveRuntimeImage). The startup gate must
# expect the release the image ships, or every locally deployed agent is refused.
EVE_LOCAL_PIN="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/versions.json'))['runtimes']['eve']['version'])")"
for chart_dir in "$EVE_CHART_DIR" "$REPO_ROOT/harness/eve/charts/eve-bundle"; do
  if [[ "$chart_dir" == "$EVE_CHART_DIR" ]]; then
    LOCAL_RENDER="$(helm template ag-eve-echo "$chart_dir" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-minimal.yaml" \
      --set runtimeImage.tag=hermes-gitops-dev --set runtimeImage.eveVersion="$EVE_LOCAL_PIN" 2>&1)"
  else
    LOCAL_RENDER="$(helm template b "$chart_dir" --namespace b -f "$FIXTURES_DIR/eve-bundle-values.yaml" \
      --set runtimeImage.tag=hermes-gitops-dev --set runtimeImage.eveVersion="$EVE_LOCAL_PIN" 2>&1)"
  fi
  EXPECTED_VALUES="$(grep -A1 "name: HG_EXPECTED_EVE_VERSION" <<<"$LOCAL_RENDER" | grep "value:" | sort -u)"
  if [[ -n "$EXPECTED_VALUES" && "$(wc -l <<<"$EXPECTED_VALUES")" == "1" ]] && grep -q "\"$EVE_LOCAL_PIN\"" <<<"$EXPECTED_VALUES"; then
    log "OK   $(basename "$chart_dir"): a locally tagged image still expects the Eve release it ships"
  else
    echo "FAIL $(basename "$chart_dir"): local image override expects ${EXPECTED_VALUES:-nothing}, not eve $EVE_LOCAL_PIN"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
done
if grep -q "name: EXPECTED_EVE_VERSION" <<<"$EVE_MIN_RENDER_EARLY"; then
  echo "FAIL eve unpinned record renders EXPECTED_EVE_VERSION"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve unpinned record carries no EXPECTED_EVE_VERSION"
fi

# The startup gate (ADR 0195): version metadata on the workload, never on a
# selector; the receipt path and the expected values on the serving container;
# the probe kinds; and the shipped verifier byte-identical to the source file.
EVE_GATE="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-minimal.yaml" 2>&1)"
if python3 - "$EVE_GATE" "$FIXTURES_DIR/eve-record-minimal.yaml" <<'PYMETA'
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.argv[1]) if d]
sha = yaml.safe_load(open(sys.argv[2]))["spec"]["sha"]
sts = next(d for d in docs if d["kind"] == "StatefulSet")
P = "harness-hg.factorylevel.dev/"
for where in (sts["metadata"], sts["spec"]["template"]["metadata"]):
    labels, ann = where.get("labels", {}), where.get("annotations", {})
    assert labels[P + "source-sha"] == sha, labels
    assert labels[P + "eve-version"], labels
    assert ann[P + "build-key"] and ann[P + "runtime-digest"], ann
PYMETA
then
  log "OK   eve version metadata lands on the StatefulSet and the pod template"
else
  echo "FAIL eve version metadata: expected source-sha/eve-version labels and build-key/runtime-digest annotations on both"
  grep -n "harness-hg.factorylevel.dev/" <<<"$EVE_GATE" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
# A version label must never reach a selector: changing one would orphan the workload.
if python3 - "$EVE_GATE" <<'PYGATE'
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.argv[1]) if d and d.get("kind") == "StatefulSet"]
sel = docs[0]["spec"]["selector"]["matchLabels"]
sys.exit(1 if any(k.startswith("harness-hg.factorylevel.dev/") for k in sel) else 0)
PYGATE
then
  log "OK   eve version labels stay out of the selector"
else
  echo "FAIL eve version labels reached the StatefulSet selector"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# Every label value must be a legal Kubernetes label (<=63 chars).
if python3 - "$EVE_GATE" <<'PYLEN'
import sys, yaml
for d in yaml.safe_load_all(sys.argv[1]):
    if not d or d.get("kind") != "StatefulSet": continue
    for where in (d["metadata"].get("labels", {}), d["spec"]["template"]["metadata"].get("labels", {})):
        for k, v in where.items():
            if k.startswith("harness-hg.factorylevel.dev/") and len(str(v)) > 63: sys.exit(1)
PYLEN
then
  log "OK   eve version label values fit the 63-character limit"
else
  echo "FAIL an eve version label value exceeds 63 characters"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if grep -q 'command: \["node", "/scripts/verify-build.mjs"\]' <<<"$EVE_GATE" \
    && [[ "$(grep -c "path: /eve/v1/health" <<<"$EVE_GATE")" == "2" ]] \
    && grep -q "value: /app/.hermes-gitops/build-receipt.json" <<<"$EVE_GATE"; then
  log "OK   eve startup probe execs the build gate; liveness and readiness stay HTTP"
else
  echo "FAIL eve startup gate: expected an exec startupProbe, two HTTP probes and the receipt path"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
# The overlay digest is expected only where overlays exist.
if ! grep -q "name: HG_EXPECTED_OVERLAY_DIGEST" <<<"$EVE_GATE"; then
  log "OK   a record without overlays expects no overlay digest"
else
  echo "FAIL eve record without overlays carries HG_EXPECTED_OVERLAY_DIGEST"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# The gate's own variables are chart-owned: an injected empty value would disable a
# check, and an injected receipt path would point the gate at a file of someone's choosing.
for injected in HG_EXPECTED_SOURCE_SHA HG_EXPECTED_BUILD_KEY HG_EXPECTED_EVE_VERSION HG_BUILD_RECEIPT HG_RUNTIME_DIGEST; do
  if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
      -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set "spec.env.$injected=x" >/dev/null 2>&1; then
    echo "FAIL eve accepted spec.env.$injected, which the startup gate owns"; FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   eve refuses spec.env.$injected"
  fi
done
# A bundle has no single source-sha: each member's desired values ride as annotations.
EVE_BUNDLE_GATE="$(helm template b "$REPO_ROOT/harness/eve/charts/eve-bundle" --namespace b -f "$FIXTURES_DIR/eve-bundle-values.yaml" 2>&1)"
if python3 - "$EVE_BUNDLE_GATE" <<'PYBMETA'
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.argv[1]) if d]
sts = next(d for d in docs if d["kind"] == "StatefulSet")
P = "harness-hg.factorylevel.dev/"
for where in (sts["metadata"], sts["spec"]["template"]["metadata"]):
    ann = where.get("annotations", {})
    assert ann[P + "eve-version"], ann
    for member in ("echo", "greeter"):
        assert ann[f"{P}source-sha.{member}"], ann
        assert ann[f"{P}runtime-digest.{member}"], ann
PYBMETA
then
  log "OK   bundle carries per-member desired versions on the workload and pod template"
else
  echo "FAIL bundle version annotations missing per member"; FAIL_COUNT=$((FAIL_COUNT+1))
fi

# The PostSync smoke check (ADR 0195): a hook Job with its own namespaced,
# read-only ServiceAccount, deleted before each sync and on success - so a
# FAILED job is what stays behind to read.
if python3 - "$EVE_GATE" <<'PYSMOKE'
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.argv[1]) if d]
job = next((d for d in docs if d["kind"] == "Job"), None)
role = next((d for d in docs if d["kind"] == "Role"), None)
assert job and role, "no smoke Job/Role"
ann = job["metadata"]["annotations"]
assert ann["argocd.argoproj.io/hook"] == "PostSync", ann
assert ann["argocd.argoproj.io/hook-delete-policy"] == "BeforeHookCreation,HookSucceeded", ann
assert job["spec"]["backoffLimit"] == 1, job["spec"]
assert job["spec"]["activeDeadlineSeconds"] == 240, job["spec"]
verbs = {(r["apiGroups"][0], tuple(sorted(r["verbs"]))) for r in role["rules"]}
assert verbs == {("", ("get", "list")), ("apps", ("get", "list"))}, verbs
# The Job and the StatefulSet must agree about what this sync deployed.
sts = next(d for d in docs if d["kind"] == "StatefulSet")
served = {e["name"]: e.get("value") for c in sts["spec"]["template"]["spec"]["containers"] for e in c["env"]}
smoke = {e["name"]: e.get("value") for c in job["spec"]["template"]["spec"]["containers"] for e in c["env"]}
for key in [k for k in smoke if k.startswith("HG_EXPECTED_")]:
    assert smoke[key] == served[key], (key, smoke[key], served[key])
PYSMOKE
then
  log "OK   eve smoke hook is a PostSync Job with least-privilege RBAC and the gate's own expectations"
else
  echo "FAIL eve smoke hook shape or expectations"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if python3 - "$EVE_GATE" <<'PYSEL'
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.argv[1]) if d]
job = next(d for d in docs if d["kind"] == "Job")
service = next(d for d in docs if d["kind"] == "Service")
selector = service["spec"]["selector"]
pod = job["spec"]["template"]["metadata"]["labels"]
# A smoke pod has no listener: if the Service could select it, live traffic breaks.
assert not all(pod.get(k) == v for k, v in selector.items()), (selector, pod)
PYSEL
then
  log "OK   the smoke pod can never become an endpoint of the agent Service"
else
  echo "FAIL the agent Service selector matches the smoke pod"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
EVE_NO_SMOKE="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set smoke.enabled=false 2>&1)"
if ! grep -qE "^kind: Job$" <<<"$EVE_NO_SMOKE" && ! grep -q "argocd.argoproj.io/hook" <<<"$EVE_NO_SMOKE"; then
  log "OK   smoke.enabled=false renders no hook at all"
else
  echo "FAIL smoke.enabled=false still renders a hook"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if grep -q "name: HG_MEMBERS" <<<"$EVE_BUNDLE_GATE" && grep -qE "^kind: Job$" <<<"$EVE_BUNDLE_GATE"; then
  log "OK   the bundle smoke hook checks every member"
else
  echo "FAIL bundle smoke hook missing or carries no member list"; FAIL_COUNT=$((FAIL_COUNT+1))
fi

for chart in eve-agent eve-bundle; do
  if cmp -s "$REPO_ROOT/harness/eve/charts/eve-agent/files/smoke.mjs" "$REPO_ROOT/harness/eve/charts/$chart/files/smoke.mjs"; then
    log "OK   $chart ships the same smoke.mjs"
  else
    echo "FAIL $chart/files/smoke.mjs differs from the eve-agent copy"; FAIL_COUNT=$((FAIL_COUNT+1))
  fi
done
for chart in eve-agent eve-bundle; do
  if cmp -s "$REPO_ROOT/harness/eve/charts/eve-agent/files/verify-build.mjs" "$REPO_ROOT/harness/eve/charts/$chart/files/verify-build.mjs"; then
    log "OK   $chart ships the same verify-build.mjs"
  else
    echo "FAIL $chart/files/verify-build.mjs differs from the eve-agent copy"; FAIL_COUNT=$((FAIL_COUNT+1))
  fi
done

eve_golden "full" -f "$FIXTURES_DIR/eve-record-full.yaml"
eve_golden "full-none" -f "$FIXTURES_DIR/eve-record-full.yaml" --set providers.ingress=none
# The two-prefix contract (eve's self-hosting guide): an Ingress that
# forwards /eve/ without /.well-known/workflow/ starts sessions that then
# stall. Asserted against the render, not trusted to the golden diff.
EVE_RENDER="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-full.yaml" 2>&1)"
EVE_PATH_COUNT="$(grep -cE '^\s+- path: ' <<<"$EVE_RENDER" || true)"
if [[ "$EVE_PATH_COUNT" == "2" ]] \
    && grep -qE '^\s+- path: /eve/$' <<<"$EVE_RENDER" \
    && grep -qE '^\s+- path: /\.well-known/workflow/$' <<<"$EVE_RENDER"; then
  log "OK   eve ingress forwards exactly /eve/ and /.well-known/workflow/"
else
  echo "FAIL eve ingress paths: expected exactly /eve/ and /.well-known/workflow/, got $EVE_PATH_COUNT path(s):"
  grep -E '^\s+- path: ' <<<"$EVE_RENDER" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
# envFrom is rendered iff the record declares envRequires (the env Secret
# exists only then - an unconditional secretRef would wedge a no-secret
# agent in CreateContainerConfigError).
if grep -q "name: ag-eve-echo-env" <<<"$EVE_RENDER"; then
  log "OK   eve full record mounts the env Secret"
else
  echo "FAIL eve full record does not reference ag-eve-echo-env"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
EVE_MIN_RENDER="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-minimal.yaml" 2>&1)"
if grep -q "name: ag-eve-echo-env" <<<"$EVE_MIN_RENDER"; then
  echo "FAIL eve minimal record references ag-eve-echo-env without envRequires"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve minimal record mounts no env Secret"
fi
# Operator overlays (ADR 0194): the lines, tree hash, digest and credential
# mounts reach only the build container of a record that declares overlays.
eve_golden "overlays" -f "$FIXTURES_DIR/eve-record-overlays.yaml"
EVE_OV_RENDER="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-overlays.yaml" 2>&1)"
if grep -q "name: EVE_OVERLAYS$" <<<"$EVE_OV_RENDER" \
    && grep -q "harness-hg.factorylevel.dev/overlay-digest:" <<<"$EVE_OV_RENDER" \
    && grep -q "mountPath: /run/secrets/overlays/crm-connection/git" <<<"$EVE_OV_RENDER" \
    && grep -q "name: ov-git-house-rules" <<<"$EVE_OV_RENDER" \
    && ! grep -q "name: EVE_OVERLAY\|harness-hg.factorylevel.dev/overlay-digest:\|name: ov-git-" <<<"$EVE_MIN_RENDER"; then
  log "OK   eve overlays reach only the build container of a record that declares them"
else
  echo "FAIL eve overlay env, digest annotation or credential mount missing, or leaked into a record without overlays"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
for bad in "spec.overlays[0].source.repository=--upload-pack=touch" "spec.overlays[0].source.repository=https://user:not-a-token@github.com/example/agent-skills.git" "spec.overlayTreeHash=null" "spec.overlays[0].source.commit=9b1c2d3" "spec.overlays[1].contentHash=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" "spec.overlays[2].id=Crm_Connection"; do
  if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
      -f "$FIXTURES_DIR/eve-record-overlays.yaml" --set "$bad" >/dev/null 2>&1; then
    echo "FAIL eve chart rendered a malformed overlay record ($bad)"; FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   eve malformed overlay refused ($bad)"
  fi
done
# negatives
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
    -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set spec.sha=null >/dev/null 2>&1; then
  echo "FAIL eve chart rendered a record without spec.sha (must refuse)"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve record without spec.sha refused"
fi
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
    -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set spec.sha=3f06a1b >/dev/null 2>&1; then
  echo "FAIL eve chart accepted a short sha"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve short sha refused"
fi
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
    -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set spec.runtime=hermes >/dev/null 2>&1; then
  echo "FAIL eve chart rendered a spec.runtime=hermes record"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve chart refuses a Hermes record (runtime guard)"
fi
# providers.ingress=cloudflare renders the SAME plain Ingress as "ingress":
# an Eve agent has no per-instance tunnel, it rides the shared control-plane
# tunnel, which rewrites the host header to <name>.<agentHostHeaderDomain> -
# the host below. A cloudflare render that produced NO Ingress would strand
# the tunnel forwarding a host nothing claims, so assert the object exists.
EVE_CF_RENDER="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo \
  -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-full.yaml" \
  --set providers.ingress=cloudflare 2>&1)"
if [[ $? -ne 0 ]]; then
  echo "FAIL eve chart refused providers.ingress=cloudflare:"; echo "$EVE_CF_RENDER" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT+1))
elif ! grep -q "host: echo.hermes.local" <<<"$EVE_CF_RENDER"; then
  echo "FAIL eve cloudflare mode rendered no Ingress at echo.hermes.local (the tunnel's rewrite target)"
  FAIL_COUNT=$((FAIL_COUNT+1))
elif diff -q <(printf '%s\n' "$EVE_CF_RENDER") "$GOLDEN_DIR/eve-full.yaml" >/dev/null 2>&1; then
  # Byte-equality with the "ingress" golden is the real claim: cloudflare adds
  # NOTHING per-instance - no cloudflared sidecar, no tunnel Stack CR. If a
  # per-agent tunnel is ever built for Eve this assertion is what will fail,
  # which is the right place to reconsider it.
  log "OK   eve cloudflare renders byte-identically to ingress (shared tunnel, nothing per-instance)"
else
  echo "FAIL eve cloudflare render differs from the ingress golden - cloudflare must add nothing per-instance:"
  diff -u "$GOLDEN_DIR/eve-full.yaml" <(printf '%s\n' "$EVE_CF_RENDER") | head -30
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
    -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set spec.env.ROUTE_AUTH_BASIC_PASSWORD=x >/dev/null 2>&1; then
  echo "FAIL eve chart let spec.env shadow ROUTE_AUTH_BASIC_PASSWORD"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve envGuard refuses a chart-owned variable in spec.env"
fi
# MCP URLs are validated during eve build, before the runtime container starts.
EVE_CAP_RENDER="$(helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
  -f "$FIXTURES_DIR/eve-record-full.yaml" \
  --set 'spec.env.HERMES_CAP_CRM_URL=http://crm.example:3000/mcp' \
  --set 'spec.env.RUNTIME_ONLY_SETTING=runtime-only' 2>&1)"
if EVE_CAP_RENDER="$EVE_CAP_RENDER" python3 - <<'PYEOF'
import os
s = os.environ["EVE_CAP_RENDER"]
init = s.split("      initContainers:\n", 1)[1].split("      containers:\n", 1)[0]
runtime = s.split("      containers:\n", 1)[1]
for section in (init, runtime):
    assert "name: HERMES_CAP_CRM_URL" in section
    assert 'value: "http://crm.example:3000/mcp"' in section
assert "RUNTIME_ONLY_SETTING" not in init
assert "envFrom:" not in init
assert "secretKeyRef:" not in init
assert "RUNTIME_ONLY_SETTING" in runtime
assert "envFrom:" in runtime
PYEOF
then
  log "OK   Eve build receives capability URL without runtime-only env or Secrets"
else
  echo "FAIL Eve build capability environment"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
for bad in "../../tmp/x" "/abs/path" "agents/./echo" "agents/echo/"; do
  if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" \
      -f "$FIXTURES_DIR/eve-record-minimal.yaml" --set "spec.sourceSubdir=$bad" >/dev/null 2>&1; then
    echo "FAIL eve chart accepted spec.sourceSubdir=$bad"; FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   eve subdirGuard refuses spec.sourceSubdir=$bad"
  fi
done
# ---- ADR-150: apps, backup, workspaces on the Eve chart ----------------
# Same three-app trio as profile-full.yaml, the backup cluster-values and a
# workspace binding, all at once; then apps-suppressed mode must be that
# render minus its Application docs (the #498 contract, same as hermes).
eve_golden "apps-backup" -f "$FIXTURES_DIR/cluster-values-backup.yaml" \
  -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/eve-record-apps-backup.yaml"
eve_golden "apps-external" -f "$FIXTURES_DIR/cluster-values-backup.yaml" \
  -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/eve-record-apps-backup.yaml" \
  -f "$FIXTURES_DIR/cluster-values-apps-external.yaml"
EVE_AB="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo -f "$CLUSTER_VALUES" \
  -f "$FIXTURES_DIR/cluster-values-backup.yaml" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" \
  -f "$FIXTURES_DIR/eve-record-apps-backup.yaml" 2>&1)"
EVE_AB_EXT="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo -f "$CLUSTER_VALUES" \
  -f "$FIXTURES_DIR/cluster-values-backup.yaml" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" \
  -f "$FIXTURES_DIR/eve-record-apps-backup.yaml" -f "$FIXTURES_DIR/cluster-values-apps-external.yaml" 2>&1)"
if [[ "$(grep -c '^kind: Application$' <<<"$EVE_AB")" == "3" ]] \
    && grep -q 'name: ag-eve-echo-vector-db' <<<"$EVE_AB" \
    && grep -q 'repoURL: ghcr.io/factory-level/charts' <<<"$EVE_AB" \
    && grep -q 'path: cli/test-env/charts/test-page' <<<"$EVE_AB"; then
  log "OK   eve record renders three child Applications (https, scheme-less oci, local)"
else
  echo "FAIL eve apps: expected three child Applications"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if [[ "$(grep -c '^kind: Application$' <<<"$EVE_AB_EXT")" == "0" ]] \
    && diff <(grep -v '^kind: Application$' <<<"$EVE_AB" | grep -vE 'templates/apps.yaml' ) \
            <(grep -vE 'templates/apps.yaml' <<<"$EVE_AB_EXT") >/dev/null 2>&1; then
  log "OK   eve appsManagedExternally renders zero Applications, everything else byte-identical"
else
  # The strict byte-compare above cannot hold once the Application docs are
  # removed (their bodies are gone too); assert the weaker, still decisive
  # form: no Application, and the StatefulSet doc is identical.
  if [[ "$(grep -c '^kind: Application$' <<<"$EVE_AB_EXT")" == "0" ]] \
      && diff <(sed -n '/^kind: StatefulSet$/,/^---$/p' <<<"$EVE_AB") \
              <(sed -n '/^kind: StatefulSet$/,/^---$/p' <<<"$EVE_AB_EXT") >/dev/null 2>&1; then
    log "OK   eve appsManagedExternally renders zero Applications; StatefulSet unchanged"
  else
    echo "FAIL eve appsManagedExternally: Applications still rendered or StatefulSet changed"; FAIL_COUNT=$((FAIL_COUNT+1))
  fi
fi
# The backup routine: label, sink, protects, archives the DATA claim and
# never the workspaces claim, and keeps the rebuildable trees out.
if grep -q 'hermes.dev/backup-routine: "true"' <<<"$EVE_AB" \
    && grep -q 'claimName: data-ag-eve-echo-0' <<<"$EVE_AB" \
    && grep -q 'claimName: ag-eve-echo-backups' <<<"$EVE_AB" \
    && ! grep -q 'claimName: workspaces-' <<<"$EVE_AB" \
    && grep -q "exclude='\*/node_modules'" <<<"$EVE_AB" \
    && grep -q "exclude='\*/.output'" <<<"$EVE_AB" \
    && grep -q 'hermes.dev/backup-protects: "state/,src/,.hermes-gitops/installed_sha,.hermes-gitops/build-receipt.json"' <<<"$EVE_AB"; then
  log "OK   eve backup routine archives the data claim only, excludes the rebuildable trees"
else
  echo "FAIL eve backup routine shape"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# Workspaces: a claim, both mounts, one env var per binding, the private
# binding's credential mounted for the init container only.
if grep -q 'name: EVE_WORKSPACE_PLATFORM' <<<"$EVE_AB" \
    && grep -q 'name: EVE_WORKSPACE_NOTES' <<<"$EVE_AB" \
    && grep -q 'mountPath: /run/secrets/repositories/notes/git' <<<"$EVE_AB" \
    && grep -q 'value: "platform https://github.com/factory-level/hermes-gitops-plugin b5113eb5c0ffee00000000000000000000000000 read-only' <<<"$EVE_AB" \
    && [[ "$(grep -c 'name: workspaces$' <<<"$EVE_AB")" -ge 3 ]]; then
  log "OK   eve workspace bindings: claim, mounts, env, per-repo credential"
else
  echo "FAIL eve workspace bindings shape"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# The no-state-loss invariant: the boot script relinks the world store
# outside the checkout (a sha change does rm -rf src/).
if grep -q 'ln -s "$target" "$link"' <<<"$EVE_AB" && grep -q 'STATE_DIR/workflow-data' <<<"$EVE_AB"; then
  log "OK   eve boot keeps .eve/.workflow-data outside the checkout"
else
  echo "FAIL eve boot does not relocate the workflow store"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# negatives for the new surface
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" \
    -f "$FIXTURES_DIR/eve-record-apps-backup.yaml" --set providers.backup=none >/dev/null 2>&1; then
  echo "FAIL eve chart rendered spec.backup with providers.backup=none (must refuse)"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve backup intent without a platform destination refused"
fi
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-backup.yaml" \
    -f "$FIXTURES_DIR/eve-record-apps-backup.yaml" >/dev/null 2>&1; then
  echo "FAIL eve chart rendered a non-allow-listed remote app repo"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve non-allow-listed app repo refused"
fi
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-backup.yaml" \
    -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/eve-record-apps-backup.yaml" \
    --set 'spec.apps[2].name=vector-db' >/dev/null 2>&1; then
  echo "FAIL eve chart rendered duplicate app names"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve duplicate app names refused"
fi
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-backup.yaml" \
    -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/eve-record-apps-backup.yaml" \
    --set 'spec.workspace.repositories[1].name=plat-form' --set 'spec.workspace.repositories[1].sha=0123456789abcdef0123456789abcdef01234567' \
    --set 'spec.workspace.repositories[0].name=plat_form' >/dev/null 2>&1; then
  echo "FAIL eve chart accepted two workspaces mapping to one EVE_WORKSPACE_ variable"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve workspace env-name collision refused"
fi
if helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-backup.yaml" \
    -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/eve-record-apps-backup.yaml" \
    --set spec.env.EVE_WORKSPACE_PLATFORM=/elsewhere >/dev/null 2>&1; then
  echo "FAIL eve chart let spec.env shadow a workspace variable"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve envGuard refuses spec.env shadowing EVE_WORKSPACE_<NAME>"
fi
# ---- ADR 0197: tracked workspaces on the Eve chart -----------------------
# One tracked private binding beside a pinned one. The golden pins the whole
# render; the structural check says what the golden must mean: a sync sidecar on
# the agent's own image, the credential in the build and sync containers only,
# a read-only agent mount, scrape annotations, a WorkspaceStale rule at twice
# the interval that alerts on missing freshness, and a manifest naming the
# channel rather than a commit. The runtime behaviour is workspace-sync-test.sh
# (section 7).
eve_golden "workspace-tracked" -f "$FIXTURES_DIR/eve-record-workspace-tracked.yaml"
TR_FILE="$(mktemp)"
helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo -f "$CLUSTER_VALUES" \
  -f "$FIXTURES_DIR/eve-record-workspace-tracked.yaml" --set networkPolicy.enabled=true > "$TR_FILE" 2>&1 || true
AB_FILE="$(mktemp)"
printf '%s\n' "$EVE_AB" > "$AB_FILE"
if TR_OUT="$(python3 - "$TR_FILE" "$AB_FILE" <<'PYTRACKED'
import json, sys, yaml
problems = []
def load(path):
    return [d for d in yaml.safe_load_all(open(path)) if d]
env = lambda c: {e["name"]: e.get("value") for e in c.get("env", [])}
mounts = lambda c: {m["mountPath"]: m for m in c.get("volumeMounts", [])}
try:
    docs = load(sys.argv[1])
except Exception as exc:
    print(f"the tracked render does not parse: {exc}"); sys.exit(1)
pod = next(d for d in docs if d["kind"] == "StatefulSet")["spec"]["template"]
spec = pod["spec"]
containers = {c["name"]: c for c in spec["containers"]}
build = next(c for c in spec["initContainers"] if c["name"] == "build-agent")
agent, sync = containers["eve-agent"], containers.get("workspace-sync")
TRACKED = "vision https://github.com/factory-level/vision-manager.git main read-only tracked 1800"
if not sync:
    problems.append("no workspace-sync container")
else:
    if sync["image"] != agent["image"]: problems.append("the sync container does not run the agent's image")
    if sync["command"] != ["/bin/sh", "/scripts/workspace-sync.sh", "loop"]: problems.append(f"sync command {sync['command']}")
    if env(sync).get("EVE_WORKSPACE_BINDINGS") != TRACKED: problems.append(f"sync bindings {env(sync).get('EVE_WORKSPACE_BINDINGS')!r}")
    if "/run/secrets/repositories/vision/git" not in mounts(sync): problems.append("the tracked credential is not mounted in the sync container")
    if mounts(sync).get("/app/workspaces", {}).get("readOnly"): problems.append("the sync container cannot write the workspaces claim")
    if not any(p.get("containerPort") == 9464 for p in sync.get("ports", [])): problems.append("no metrics port on the sync container")
if "/run/secrets/repositories/vision/git" not in mounts(build): problems.append("the build container cannot clone the tracked workspace")
if any(p.startswith("/run/secrets/repositories") for p in mounts(agent)): problems.append("a repository credential reaches the agent container")
if mounts(agent).get("/app/workspaces", {}).get("readOnly") is not True: problems.append("the agent's workspaces mount is not read-only though every binding is")
lines = env(build).get("EVE_WORKSPACE_BINDINGS", "").split("\n")
if lines != [TRACKED, "platform https://github.com/factory-level/harness-hg b5113eb5c0ffee00000000000000000000000000 read-only"]:
    problems.append(f"build bindings {lines!r}")
annotations = pod["metadata"].get("annotations", {})
for key, want in {"prometheus.io/scrape": "true", "prometheus.io/port": "9464", "prometheus.io/path": "/metrics",
                  "kubectl.kubernetes.io/default-container": "eve-agent"}.items():
    if annotations.get(key) != want: problems.append(f"pod annotation {key}={annotations.get(key)!r}")
manifest = json.loads(next(d for d in docs if d["kind"] == "ConfigMap" and d["metadata"]["name"].endswith("-runtime-manifest"))["data"]["runtime-manifest.json"])
revisions = {w["name"]: w["revision"] for w in manifest["spec"]["workspaces"]}
if revisions != {"vision": "tracked:main", "platform": "b5113eb5c0ffee00000000000000000000000000"}: problems.append(f"manifest revisions {revisions}")
boot = next(d for d in docs if d["kind"] == "ConfigMap" and d["metadata"]["name"].endswith("-boot"))["data"]
if not {"workspace-sync.sh", "workspace-metrics.mjs"} <= set(boot): problems.append("the boot ConfigMap does not ship the sync files")
alerts = [d for d in docs if d["kind"] == "ConfigMap" and d["metadata"].get("labels", {}).get("grafana_alert") == "1"]
if len(alerts) != 1:
    problems.append(f"{len(alerts)} alert ConfigMaps, want 1")
else:
    rule = yaml.safe_load(next(iter(alerts[0]["data"].values())))["groups"][0]["rules"][0]
    expr = rule["data"][0]["model"]["expr"]
    if not rule["title"].startswith("WorkspaceStale ("): problems.append(f"rule title {rule['title']}")
    if expr != 'max(time() - hg_workspace_last_success_timestamp_seconds{namespace="ag-eve-echo"} - 2 * hg_workspace_refresh_interval_seconds{namespace="ag-eve-echo"})':
        problems.append(f"rule expr {expr}")
    if rule["data"][1]["model"]["conditions"][0]["evaluator"] != {"type": "gt", "params": [0]}: problems.append("rule threshold is not > 0")
    if rule["noDataState"] != "Alerting": problems.append("missing freshness does not alert")
    if rule["notification_settings"]["receiver"] != "ag-eve-echo-alerts": problems.append(f"rule receiver {rule['notification_settings']['receiver']!r}, want the namespace monitoring contact point")
    if len(rule["uid"]) > 40: problems.append("rule uid exceeds Grafana's 40 characters")
policy = next((d for d in docs if d["kind"] == "NetworkPolicy"), None)
if not policy or {p["port"] for p in policy["spec"]["ingress"][0]["ports"]} != {3000, 9464}:
    problems.append("the NetworkPolicy does not admit exactly the agent and metrics ports")
# A pinned-only agent (apps-backup: one read-write binding) gains none of it.
pinned = load(sys.argv[2])
ppod = next(d for d in pinned if d["kind"] == "StatefulSet")["spec"]["template"]
if any(c["name"] == "workspace-sync" for c in ppod["spec"]["containers"]): problems.append("a pinned-only agent renders a sync container")
if "prometheus.io/scrape" in ppod["metadata"].get("annotations", {}): problems.append("a pinned-only agent is annotated for scraping")
if any(d["kind"] == "ConfigMap" and d["metadata"].get("labels", {}).get("grafana_alert") == "1" for d in pinned): problems.append("a pinned-only agent renders WorkspaceStale")
pagent = next(c for c in ppod["spec"]["containers"] if c["name"] == "eve-agent")
if mounts(pagent).get("/app/workspaces", {}).get("readOnly"): problems.append("a read-write binding got a read-only agent mount")
print("; ".join(problems))
sys.exit(1 if problems else 0)
PYTRACKED
)"; then
  log "OK   eve tracked workspace: sync sidecar, credential off the agent, read-only mount, metrics, WorkspaceStale, manifest channel; pinned-only unchanged"
else
  echo "FAIL eve tracked workspace shape: $TR_OUT"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
rm -f "$TR_FILE" "$AB_FILE"
# The chart re-checks the contract where a branch becomes a shell word and a refspec.
TR_NEG_DIR="$(mktemp -d)"
tr_neg() { # slug description yaml-lines-for-the-binding expected-message
  local file="$TR_NEG_DIR/$1.yaml" out
  printf '%s\n' "spec:" "  persona: echo" "  runtime: eve" \
    "  source: https://github.com/factorylevel/eve-agents.git" \
    "  sha: 3f06a1b2c3d4e5f60718293a4b5c6d7e8f901234" "  workspace:" "    repositories:" \
    "      - name: vision" "        source: https://github.com/factory-level/vision-manager.git" \
    "        access: read-only" "$3" > "$file"
  if out="$(helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$file" 2>&1)"; then
    echo "FAIL eve chart rendered a tracked binding with $2"; FAIL_COUNT=$((FAIL_COUNT+1))
  elif grep -q "$4" <<<"$out"; then
    log "OK   eve workspaceGuard refuses a tracked binding with $2"
  else
    echo "FAIL eve tracked guard ($2) failed with an unexpected message:"; tail -2 <<<"$out" | sed 's/^/       /'
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
}
tr_neg dotdot "a '..' branch" $'        tracking:\n          branch: main..release\n          refreshInterval: 30m' "is not a trackable branch name"
tr_neg refs "a refs/heads/ branch" $'        tracking:\n          branch: refs/heads/main\n          refreshInterval: 30m' "is not a trackable branch name"
tr_neg commit "a commit as the branch" $'        tracking:\n          branch: 0123456789abcdef0123456789abcdef01234567\n          refreshInterval: 30m' "is not a trackable branch name"
tr_neg interval "an interval below 5m" $'        tracking:\n          branch: main\n          refreshInterval: 1m' "must be whole minutes (at least 5m)"
tr_neg seconds "an interval in seconds" $'        tracking:\n          branch: main\n          refreshInterval: 900s' "must be whole minutes (at least 5m)"
tr_neg sha "a sha beside the branch" $'        sha: 0123456789abcdef0123456789abcdef01234567\n        tracking:\n          branch: main\n          refreshInterval: 30m' "must not also carry a sha"
rm -rf "$TR_NEG_DIR"
# WorkspaceStale's receiver: the namespace's monitoring contact point (<namespace>-alerts, the
# monitoring chart's name) by default, in whatever namespace the agent lands; an explicit
# alerts.contactPoint overrides it. The receiver is never empty, so there is no silent render.
if TR_CP_NS="$(helm template ag-eve-marketing-sre "$EVE_CHART_DIR" --namespace ag-eve-marketing-sre -f "$CLUSTER_VALUES" \
    -f "$FIXTURES_DIR/eve-record-workspace-tracked.yaml" 2>&1)" \
    && grep -q 'receiver: "ag-eve-marketing-sre-alerts"$' <<<"$TR_CP_NS" \
  && TR_CP_SET="$(helm template ag-eve-echo "$EVE_CHART_DIR" --namespace ag-eve-echo -f "$CLUSTER_VALUES" \
    -f "$FIXTURES_DIR/eve-record-workspace-tracked.yaml" --set alerts.contactPoint=team-pager 2>&1)" \
    && grep -q 'receiver: "team-pager"$' <<<"$TR_CP_SET" && ! grep -q 'ag-eve-echo-alerts' <<<"$TR_CP_SET"; then
  log "OK   eve WorkspaceStale routes to <namespace>-alerts by default, and to alerts.contactPoint when set"
else
  echo "FAIL eve WorkspaceStale receiver: default is not <namespace>-alerts or the override is ignored"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if TR_OPTOUT="$(helm template ag-eve-echo "$EVE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-record-workspace-tracked.yaml" \
    --set alerts.workspaceStale.enabled=false 2>&1)" \
    && ! grep -q 'grafana_alert: "1"' <<<"$TR_OPTOUT" && grep -q 'name: workspace-sync$' <<<"$TR_OPTOUT"; then
  log "OK   eve WorkspaceStale opt-out is explicit and keeps the sync sidecar"
else
  echo "FAIL eve WorkspaceStale opt-out"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# ---- ADR-150: the eve-bundle chart ---------------------------------------
EVE_BUNDLE_CHART_DIR="$REPO_ROOT/harness/eve/charts/eve-bundle"
eve_bundle_golden() {
  local name="$1"; shift
  local out
  out="$(helm template ag-eve-bundle-team "$EVE_BUNDLE_CHART_DIR" --namespace ag-eve-team \
    -f "$CLUSTER_VALUES" "$@" 2>&1)"
  if [[ $? -ne 0 ]]; then
    echo "FAIL render bundle-eve-$name:"; echo "$out" | sed 's/^/       /'; FAIL_COUNT=$((FAIL_COUNT+1)); return
  fi
  local golden="$GOLDEN_DIR/bundle-eve-$name.yaml"
  if [[ $UPDATE -eq 1 ]]; then
    printf '%s\n' "$out" > "$golden"; log "updated $golden"
  elif ! diff -u "$golden" <(printf '%s\n' "$out") >/dev/null 2>&1; then
    echo "FAIL golden bundle-eve-$name differs (run with --update if intentional)"
    diff -u "$golden" <(printf '%s\n' "$out") | head -40
    FAIL_COUNT=$((FAIL_COUNT+1))
  else
    log "OK   golden bundle-eve-$name"
  fi
}
eve_bundle_golden "backup" -f "$FIXTURES_DIR/cluster-values-backup.yaml" -f "$FIXTURES_DIR/eve-bundle-values.yaml"
eve_bundle_golden "no-sink" -f "$FIXTURES_DIR/eve-bundle-values.yaml" --set providers.backup=none
eve_bundle_golden "networkpolicy" -f "$FIXTURES_DIR/eve-bundle-values.yaml" --set networkPolicy.enabled=true
EB="$(helm template ag-eve-bundle-team "$EVE_BUNDLE_CHART_DIR" --namespace ag-eve-team -f "$CLUSTER_VALUES" \
  -f "$FIXTURES_DIR/cluster-values-backup.yaml" -f "$FIXTURES_DIR/eve-bundle-values.yaml" --set networkPolicy.enabled=true 2>&1)"
# Two members: two build inits, two eve containers on distinct ports, two
# route-auth credentials, one Service port and one Ingress host each.
if [[ "$(grep -c '^        - name: build-' <<<"$EB")" == "2" ]] \
    && grep -q 'containerPort: 3000' <<<"$EB" && grep -q 'containerPort: 3100' <<<"$EB" \
    && grep -q 'name: ag-eve-team-echo-route-auth$' <<<"$EB" && grep -q 'name: ag-eve-team-greeter-route-auth$' <<<"$EB" \
    && grep -q 'host: echo.hermes.local' <<<"$EB" && grep -q 'host: greeter.hermes.local' <<<"$EB" \
    && [[ "$(grep -cE '^\s+- path: /\.well-known/workflow/$' <<<"$EB")" == "2" ]]; then
  log "OK   eve bundle: per-member build, port, credential, ingress host (both prefixes)"
else
  echo "FAIL eve bundle member shape"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# The NetworkPolicy admits EVERY member's port (bundling is never a downgrade).
if grep -q 'port: 3000$' <<<"$(sed -n '/^kind: NetworkPolicy$/,/^---$/p' <<<"$EB")" \
    && grep -q 'port: 3100$' <<<"$(sed -n '/^kind: NetworkPolicy$/,/^---$/p' <<<"$EB")"; then
  log "OK   eve bundle NetworkPolicy admits every member port"
else
  echo "FAIL eve bundle NetworkPolicy misses a member port"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# Workspaces: one shared init syncing the bundle's repositories; the
# member that refs one gets the env var and a read-only subPath mount.
if grep -q 'value: workspaces' <<<"$EB" && grep -q 'name: EVE_WORKSPACE_BRAND' <<<"$EB" \
    && grep -q 'subPath: brand' <<<"$EB" && grep -q 'value: "brand https://example.invalid/vision-manager.git 2222222222222222222222222222222222222222 read-only"' <<<"$EB"; then
  log "OK   eve bundle workspaces: shared init, env var, subPath mount"
else
  echo "FAIL eve bundle workspace shape"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
# Backup: the shared data claim, never the workspaces claim; gated on the sink alone.
if grep -q 'claimName: data-ag-eve-team-0' <<<"$EB" && ! grep -q 'claimName: workspaces-' <<<"$EB" \
    && grep -q 'hermes.dev/backup-protects: "members/"' <<<"$EB"; then
  log "OK   eve bundle backup routine archives the shared data claim"
else
  echo "FAIL eve bundle backup shape"; FAIL_COUNT=$((FAIL_COUNT+1))
fi
if helm template x "$EVE_BUNDLE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-bundle-values.yaml" \
    --set providers.backup=none 2>/dev/null | grep -q '^kind: CronJob$'; then
  echo "FAIL eve bundle rendered a routine with no sink"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve bundle without a sink renders no routine"
fi
# negatives
if helm template x "$EVE_BUNDLE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-bundle-values.yaml" --set spec.runtime=hermes >/dev/null 2>&1; then
  echo "FAIL eve bundle accepted a Hermes bundle record"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve bundle refuses spec.runtime=hermes"
fi
if helm template x "$EVE_BUNDLE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-bundle-values.yaml" --set spec.dashboard.enabled=true >/dev/null 2>&1; then
  echo "FAIL eve bundle accepted the Hermes dashboard"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve bundle refuses the Hermes dashboard knob"
fi
if helm template x "$EVE_BUNDLE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-bundle-values.yaml" --set 'spec.profiles[1].apiServerPort=3000' >/dev/null 2>&1; then
  echo "FAIL eve bundle accepted two members on one port"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve bundle refuses a member port collision"
fi
if helm template x "$EVE_BUNDLE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-bundle-values.yaml" --set 'spec.profiles[0].repositoryRefs[0]=nope' >/dev/null 2>&1; then
  echo "FAIL eve bundle accepted an undeclared repositoryRef"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve bundle refuses an undeclared repositoryRef"
fi
if helm template x "$EVE_BUNDLE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-bundle-values.yaml" --set 'spec.profiles[0].overlayTreeHash=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' >/dev/null 2>&1; then
  echo "FAIL eve bundle accepted a member with operator overlays"; FAIL_COUNT=$((FAIL_COUNT+1))
else
  log "OK   eve bundle refuses operator overlays"
fi
# A bundle mounts each workspace through a subPath, which pins the directory at
# member start: an in-pod refresh could never reach it (ADR 0197 cost). Refused.
EB_TRACKED="$(mktemp)"
printf '%s\n' "spec:" "  repositories:" "    - name: brand" "      source: https://example.invalid/vision-manager.git" \
  "      tracking:" "        branch: main" "        refreshInterval: 30m" "      mountPath: /workspaces/brand" \
  "      access: read-only" > "$EB_TRACKED"
if EB_TR_OUT="$(helm template x "$EVE_BUNDLE_CHART_DIR" -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/eve-bundle-values.yaml" -f "$EB_TRACKED" 2>&1)"; then
  echo "FAIL eve bundle accepted a tracked workspace"; FAIL_COUNT=$((FAIL_COUNT+1))
elif grep -q 'repository "brand" tracks a branch' <<<"$EB_TR_OUT"; then
  log "OK   eve bundle refuses a tracked workspace, naming why"
else
  echo "FAIL eve bundle tracked refusal failed with an unexpected message:"; tail -2 <<<"$EB_TR_OUT" | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
rm -f "$EB_TRACKED"
# The two charts run the SAME boot script and default channel, byte for byte.
for f in boot.sh channel-eve.ts overlay-apply.mjs; do
  if cmp -s "$EVE_CHART_DIR/files/$f" "$EVE_BUNDLE_CHART_DIR/files/$f"; then
    log "OK   eve-bundle files/$f == eve-agent files/$f"
  else
    echo "FAIL harness/eve/charts/eve-bundle/files/$f differs from harness/eve/charts/eve-agent/files/$f (copy it)"; FAIL_COUNT=$((FAIL_COUNT+1))
  fi
done
# The default channel the boot script installs is the example's authored
# channel, byte for byte - one source of truth for the platform policy.
if cmp -s "$EVE_CHART_DIR/files/channel-eve.ts" "$REPO_ROOT/examples/eve-agent/agents/echo/agent/channels/eve.ts"; then
  log "OK   eve default channel == examples/eve-agent authored channel"
else
  echo "FAIL harness/eve/charts/eve-agent/files/channel-eve.ts differs from examples/eve-agent/agents/echo/agent/channels/eve.ts"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

echo
echo "== 4. kubeconform (best-effort) =="

KUBECONFORM_VERSION="v0.8.0"
KUBECONFORM_BIN=""
if command -v kubeconform >/dev/null 2>&1; then
  KUBECONFORM_BIN="kubeconform"
elif [[ -x "$LOCAL_BIN/kubeconform" ]]; then
  KUBECONFORM_BIN="$LOCAL_BIN/kubeconform"
else
  log "kubeconform not found; attempting install to $LOCAL_BIN (no sudo)..."
  tmp="$(mktemp -d)"
  URL="https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz"
  if curl -fsSL --max-time 20 -o "$tmp/kubeconform.tar.gz" "$URL" 2>/dev/null \
      && tar -xzf "$tmp/kubeconform.tar.gz" -C "$LOCAL_BIN" kubeconform 2>/dev/null; then
    chmod +x "$LOCAL_BIN/kubeconform"
    KUBECONFORM_BIN="$LOCAL_BIN/kubeconform"
    echo "installed kubeconform $KUBECONFORM_VERSION"
  else
    echo "SKIPPED: kubeconform unavailable (no network or download failed)."
  fi
  rm -rf "$tmp"
fi

if [[ -n "$KUBECONFORM_BIN" ]]; then
  if helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
      -f "$CLUSTER_VALUES" -f "$FIXTURES_DIR/cluster-values-test-extra.yaml" -f "$FIXTURES_DIR/profile-full.yaml" \
      | "$KUBECONFORM_BIN" -strict -summary -ignore-missing-schemas \
          -schema-location default \
          -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'; then
    echo "OK   kubeconform"
  else
    echo "FAIL kubeconform"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

# ---------------------------------------------------------------------------
# 5. boot-script private-source auth behavior (issue #18 [G1])
# ---------------------------------------------------------------------------
echo
echo "== 5. boot-script git-auth behavior =="
if bash "$REPO_ROOT/infra/scripts/boot-auth-test.sh"; then
  echo "OK   boot-auth-test"
else
  echo "FAIL boot-auth-test"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# ---------------------------------------------------------------------------
# 6. operator overlay merge and the boot script's overlay path (ADR 0194)
# ---------------------------------------------------------------------------
echo
echo "== 6. operator overlays: merge rules and boot path =="
if OVERLAY_UNIT_OUT="$(node --test "$REPO_ROOT/infra/scripts/overlay-apply.test.mjs" 2>&1)"; then
  echo "OK   overlay-apply unit tests"
else
  echo "FAIL overlay-apply unit tests"; echo "$OVERLAY_UNIT_OUT" | tail -40 | sed 's/^/       /'
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if bash "$REPO_ROOT/infra/scripts/overlay-boot-test.sh"; then
  echo "OK   overlay-boot-test"
else
  echo "FAIL overlay-boot-test"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# ---------------------------------------------------------------------------
# 7. tracked workspaces: the rendered refresh against local git (ADR 0197)
# ---------------------------------------------------------------------------
echo
echo "== 7. tracked workspaces: first clone, refresh, refusals, metrics =="
if bash "$REPO_ROOT/infra/scripts/workspace-sync-test.sh"; then
  echo "OK   workspace-sync-test"
else
  echo "FAIL workspace-sync-test"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo
echo "== Summary: $FAIL_COUNT failure(s) =="
exit $((FAIL_COUNT > 0 ? 1 : 0))
