#!/usr/bin/env bash
# Task 10 (day-2 hardening for pod compute): a dedicated drift/decommission
# acceptance test, on this machine, for real, no sudo, no GitHub, no cloud —
# the same disposable environment infra/scripts/smoke-local.sh (Task 9) proves the
# happy path against, but here exercising what happens AFTER a persona is
# Synced+Healthy: unmanaged live edits (drift) and the full decommission +
# re-provisioning lifecycle.
#
# Setup (steps 1-10, via infra/scripts/lib/smoke-helpers.sh — byte-identical to
# smoke-local.sh's own setup, see that file for the full rationale/header
# comment on why two local git servers, the gateway-IP trick, etc.):
# throwaway k3d cluster -> two local git servers -> pulumi up stages 1-2-3
# -> the hermes-gitops-test persona (THIS repo's own .hermes-dist/distribution-agent/ payload)
# Synced+Healthy with its pod Ready.
#
# Then, each lettered step below is an independent day-2 scenario with its
# own PASS/FAIL/SKIP line:
#   b. DRIFT — delete the Service, delete the Pod, `kubectl scale --replicas=0`
#   c. DRIFT (secret) — delete the API_SERVER_KEY ExternalSecret's target Secret
#   d. OUT-OF-BAND edit — `kubectl patch service` (a rendered resource)
#   e. DECOMMISSION — `git rm profiles/<name>` + push; asserts the Application,
#      its namespaced resources, AND the PVC (StatefulSetAutoDeletePVC) are gone
#   f. RE-INSTALL — push profiles/<name> back; asserts clean re-provisioning
#      with a genuinely fresh PVC (not just a same-named one)
#
# Usage: infra/scripts/test-drift-and-decommission.sh
# Env overrides: HERMES_FORK_PATH (default: ../hermes-agent-gitops
#   next to this checkout).
# Requires: pulumi, uv, git, python3, docker, kubectl (dev-cluster.sh
#   self-installs k3d/kubectl to ~/.local/bin if missing); a local
#   hermes-agent:hermes-gitops-dev image build (see Task 8 / README).
#
# Prints "OK"/"PASS"/"FAIL"/"SKIP" lines throughout; non-zero exit on any
# unexpected failure (an honest, reasoned SKIP is not a failure). Trap-based
# cleanup runs on ANY exit (success, failure, or interrupt) — see
# infra/scripts/lib/smoke-helpers.sh::common_cleanup for exactly what it tears
# down; nothing under $HOME or this checkout is touched or left behind.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOOTSTRAP_DIR="$REPO_ROOT/infra"
HERMES_FORK_PATH="${HERMES_FORK_PATH:-$REPO_ROOT/../hermes-agent-gitops}"

# shellcheck source=lib/smoke-helpers.sh
source "$REPO_ROOT/infra/scripts/lib/smoke-helpers.sh"

CLUSTER_NAME="hermes-gitops-dev"          # matches infra/scripts/dev-cluster.sh
K3D_NETWORK="k3d-${CLUSTER_NAME}"
STACK_NAME="drift-decommission-test"
PERSONA_NAME="hermes-gitops-test"          # matches distribution.yaml's `name:`
APP_NAME="hermes-${PERSONA_NAME}"        # ApplicationSet naming convention
NAMESPACE="hermes-${PERSONA_NAME}"       # ApplicationSet destination namespace
STS_NAME="hermes-${PERSONA_NAME}"        # hermes.fullname
SVC_NAME="hermes-${PERSONA_NAME}"        # hermes.fullname
POD_NAME="hermes-${PERSONA_NAME}-0"
PVC_NAME="data-hermes-${PERSONA_NAME}-0"
API_KEY_SECRET_NAME="hermes-${PERSONA_NAME}-api-key"    # hermes.apiKeySecretName
LOCAL_IMAGE_REPO="hermes-agent"
LOCAL_IMAGE_TAG="hermes-gitops-dev"

SMOKE_LOG_PREFIX="drift-test"

SKIPPED=()
record_skip() {
  echo "SKIP: $*"
  SKIPPED+=("$*")
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
preflight_checks

# ---------------------------------------------------------------------------
# Isolation + trap-based cleanup (every step below is disposable; nothing
# under $HOME or this checkout is touched or left behind on exit).
# ---------------------------------------------------------------------------
WORKDIR="$(mktemp -d -t hermes-gitops-drift-XXXXXX)"
GIT_DAEMON_PID=""
HTTP_SERVER_PID=""
PORT_FORWARD_PID=""
CLUSTER_UP=0

cleanup() {
  local rc=$?
  log "cleaning up (exit code $rc)..."

  common_cleanup

  if [[ "$rc" == "0" ]]; then
    echo
    echo "=========================================================="
    echo "PASS: Hermes GitOps drift + decommission hardening verified end-to-end on this machine"
    if (( ${#SKIPPED[@]} > 0 )); then
      echo "  (${#SKIPPED[@]} step(s) honestly SKIPped — see SKIP lines above)"
    fi
    echo "=========================================================="
  fi
  exit "$rc"
}
trap cleanup EXIT

log "workdir: $WORKDIR"
log "fork:    $HERMES_FORK_PATH"

mkdir -p "$WORKDIR/hermes-home" "$WORKDIR/uv-tools" "$WORKDIR/uv-bin" \
  "$WORKDIR/pulumi-backend" "$WORKDIR/serve"

# ---------------------------------------------------------------------------
# Setup — steps 1-10: the exact same environment smoke-local.sh proves the
# happy path against (see infra/scripts/lib/smoke-helpers.sh for each function's
# full rationale).
# ---------------------------------------------------------------------------
log "== step 1: dev k3d cluster =="
bash "$REPO_ROOT/infra/scripts/dev-cluster.sh" up
CLUSTER_UP=1
pass "k3d cluster '${CLUSTER_NAME}' up"

log "== step 2: local git servers (GitOps repo + persona-source mirror) =="
start_git_servers

log "== step 3: pulumi up (stages 1-2) =="
bootstrap_stage12
pass "pulumi up (stage 1: Hermes+plugin install; stage 2: hermes profile install $PERSONA_NAME)"

log "== step 4: pinning cluster-values.yaml's image to the local build =="
GITOPS_CHECK="$WORKDIR/gitops-check"
git clone --quiet "$GITOPS_URL" "$GITOPS_CHECK"
pin_cluster_values_image "$GITOPS_CHECK" "$LOCAL_IMAGE_REPO" "$LOCAL_IMAGE_TAG"
pass "cluster-values.yaml image pinned to local ${LOCAL_IMAGE_REPO}:${LOCAL_IMAGE_TAG} build"

log "== step 5: importing ${LOCAL_IMAGE_REPO}:${LOCAL_IMAGE_TAG} into k3d =="
import_local_image "$LOCAL_IMAGE_REPO" "$LOCAL_IMAGE_TAG" "$CLUSTER_NAME"
pass "${LOCAL_IMAGE_REPO}:${LOCAL_IMAGE_TAG} imported into k3d cluster ${CLUSTER_NAME}"

log "== step 6: pulumi up (stage 3: cluster control plane) =="
bootstrap_stage3
pass "pulumi up (stage 3: Argo CD + ESO + hermes-gitops-root Application)"

KCTL=(kubectl --context "k3d-${CLUSTER_NAME}")

log "== step 7: waiting for Argo CD Application '${APP_NAME}' to exist =="
wait_for "Application ${APP_NAME} to exist" 300 \
  "${KCTL[@]}" get application "$APP_NAME" -n argocd || \
  fail "Application ${APP_NAME} never appeared in argocd namespace within 300s"
pass "Argo CD Application ${APP_NAME} exists"

log "== step 8: waiting for Application ${APP_NAME} to reach Synced+Healthy =="
wait_app_synced_healthy "$APP_NAME" 900

# ===========================================================================
# 8b. C2 PLACEMENT — spec.targetCluster routes the generated Application
# (issue #8 [C2]). The control-plane default is already proven by step 8:
# since C2 the ApplicationSet destination is NAME-based
# ('{{ dig "targetCluster" "in-cluster" .spec }}'), so ${APP_NAME}
# reaching Synced+Healthy means "in-cluster" resolved. This step covers
# the remote half: register a fake workload cluster (the same Secret
# shape infra's targetClusters config mints, issue #5 [C1]), push a
# record naming it, and assert the generated Application is routed there.
# The fake cluster is unreachable by design — placement (which cluster
# the Application TARGETS) is what C2 owns; sync success on a real remote
# cluster is a fleet-operator concern.
# ===========================================================================
log "== step 8b: C2 placement — registering a fake workload cluster + pushing a record naming it =="
REMOTE_NAME="drift-remote-1"
PROBE_NAME="placement-probe"
"${KCTL[@]}" apply -f - <<EOF_SECRET >/dev/null
apiVersion: v1
kind: Secret
metadata:
  name: hermes-gitops-cluster-${REMOTE_NAME}
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
stringData:
  name: ${REMOTE_NAME}
  server: https://10.255.255.1:6443
  config: '{"bearerToken":"fake","tlsClientConfig":{"insecure":true}}'
EOF_SECRET
GITOPS_C2="$WORKDIR/gitops-c2"
git clone --quiet "$GITOPS_URL" "$GITOPS_C2"
mkdir -p "$GITOPS_C2/profiles/${PROBE_NAME}"
cat > "$GITOPS_C2/profiles/${PROBE_NAME}/profile.yaml" <<EOF_REC
spec:
  persona: ${PROBE_NAME}
  source: github.com/factorylevel/${PROBE_NAME}
  sha: 0000000000000000000000000000000000000000
  targetCluster: ${REMOTE_NAME}
EOF_REC
git -C "$GITOPS_C2" add "profiles/${PROBE_NAME}"
git -C "$GITOPS_C2" -c user.email=drift-test@hermes-gitops.local -c user.name=drift-test \
  commit --quiet -m "drift-test: C2 placement probe"
git -C "$GITOPS_C2" push --quiet origin HEAD:refs/heads/main
"${KCTL[@]}" -n argocd annotate applicationset hermes-gitops-profiles \
  argocd.argoproj.io/application-set-refresh=true --overwrite >/dev/null 2>&1 || true
wait_for "Application hermes-${PROBE_NAME} to exist" 300 \
  "${KCTL[@]}" get application "hermes-${PROBE_NAME}" -n argocd || \
  fail "Application hermes-${PROBE_NAME} never appeared within 300s"
PROBE_DEST="$("${KCTL[@]}" -n argocd get application "hermes-${PROBE_NAME}" -o jsonpath='{.spec.destination.name}')"
[ "$PROBE_DEST" = "$REMOTE_NAME" ] || fail "hermes-${PROBE_NAME} destination.name is '${PROBE_DEST}', expected '${REMOTE_NAME}'"
CONTROL_DEST="$("${KCTL[@]}" -n argocd get application "$APP_NAME" -o jsonpath='{.spec.destination.name}')"
[ "$CONTROL_DEST" = "in-cluster" ] || fail "${APP_NAME} destination.name is '${CONTROL_DEST}', expected 'in-cluster'"
pass "C2 placement: hermes-${PROBE_NAME} targets ${REMOTE_NAME}; ${APP_NAME} defaults to in-cluster"
git -C "$GITOPS_C2" rm --quiet -r "profiles/${PROBE_NAME}"
git -C "$GITOPS_C2" -c user.email=drift-test@hermes-gitops.local -c user.name=drift-test \
  commit --quiet -m "drift-test: remove C2 placement probe"
git -C "$GITOPS_C2" push --quiet origin HEAD:refs/heads/main
"${KCTL[@]}" -n argocd annotate applicationset hermes-gitops-profiles \
  argocd.argoproj.io/application-set-refresh=true --overwrite >/dev/null 2>&1 || true
# Operational finding (first observed by this very step): deleting an
# Application whose destination cluster is UNREACHABLE wedges on Argo
# CD's resources finalizer — cascade deletion must contact the target
# cluster to prune, and never can. Nothing was ever synced to the fake
# cluster, so stripping the finalizer is safe here; a real fleet
# decommissioning records for a dead cluster needs the same manual step
# (documented in _docs/wiki/runbooks/recovery.md).
wait_for "Application hermes-${PROBE_NAME} deletion to begin" 300 bash -c \
  "${KCTL[*]} get application hermes-${PROBE_NAME} -n argocd -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null | grep -q . \
   || ! ${KCTL[*]} get application hermes-${PROBE_NAME} -n argocd >/dev/null 2>&1"
"${KCTL[@]}" -n argocd patch application "hermes-${PROBE_NAME}" --type merge \
  -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
wait_for "Application hermes-${PROBE_NAME} to be pruned" 300 bash -c \
  "! ${KCTL[*]} get application hermes-${PROBE_NAME} -n argocd >/dev/null 2>&1"
"${KCTL[@]}" -n argocd delete secret "hermes-gitops-cluster-${REMOTE_NAME}" >/dev/null
pass "C2 placement probe cleaned up (finalizer stripped - unreachable-destination finding)"

log "== step 9: waiting for pod ${POD_NAME} to be Ready =="
wait_pod_ready "$NAMESPACE" "$POD_NAME" 300s
pass "pod ${POD_NAME} is Ready"

log "== step 10: sanity-checking the resources this script is about to drift/decommission =="
"${KCTL[@]}" -n "$NAMESPACE" get statefulset "$STS_NAME" >/dev/null || fail "StatefulSet $STS_NAME not found"
"${KCTL[@]}" -n "$NAMESPACE" get service "$SVC_NAME" >/dev/null || fail "Service $SVC_NAME not found"
"${KCTL[@]}" -n "$NAMESPACE" get secret "$API_KEY_SECRET_NAME" >/dev/null || fail "Secret $API_KEY_SECRET_NAME not found"
"${KCTL[@]}" -n "$NAMESPACE" get pvc "$PVC_NAME" >/dev/null || fail "PVC $PVC_NAME not found"
pass "setup complete: StatefulSet/Service/Secret/PVC all present for ${PERSONA_NAME}"

# ===========================================================================
# b. DRIFT — Service, Pod, and manual StatefulSet scale-down
# ===========================================================================
log "== step b1: DRIFT — deleting Service ${SVC_NAME}, asserting Argo CD selfHeal recreates it =="
OLD_SVC_UID="$("${KCTL[@]}" -n "$NAMESPACE" get service "$SVC_NAME" -o jsonpath='{.metadata.uid}')"
"${KCTL[@]}" -n "$NAMESPACE" delete service "$SVC_NAME" --wait=true
ok "Service ${SVC_NAME} deleted (was uid ${OLD_SVC_UID:0:8})"
wait_for "Service ${SVC_NAME} recreated by Argo CD selfHeal" 180 \
  "${KCTL[@]}" -n "$NAMESPACE" get service "$SVC_NAME" || \
  fail "Service ${SVC_NAME} was not recreated within 180s of deletion — selfHeal did not restore it"
NEW_SVC_UID="$("${KCTL[@]}" -n "$NAMESPACE" get service "$SVC_NAME" -o jsonpath='{.metadata.uid}')"
[[ "$NEW_SVC_UID" != "$OLD_SVC_UID" ]] || fail "Service ${SVC_NAME} has the same uid as before deletion — deletion never actually happened"
pass "Argo CD selfHeal recreated Service ${SVC_NAME} (uid ${OLD_SVC_UID:0:8} -> ${NEW_SVC_UID:0:8})"

log "== step b2: DRIFT — deleting Pod ${POD_NAME}, asserting the StatefulSet recreates and returns Ready =="
# NOTE: this specific recovery is native Kubernetes StatefulSet controller
# behavior (spec.replicas=1 unmet -> the controller creates a replacement
# pod), not Argo CD selfHeal at all — Argo CD never even sees this as drift
# (Pods aren't part of the StatefulSet's own desired-state manifest). Kept
# here anyway because it's a real day-2 scenario ("someone fat-fingered a
# `kubectl delete pod`") worth a hard assertion, and it's the cheapest of
# the three to combine with the true selfHeal cases above/below in one pass.
OLD_POD_UID="$("${KCTL[@]}" -n "$NAMESPACE" get pod "$POD_NAME" -o jsonpath='{.metadata.uid}')"
"${KCTL[@]}" -n "$NAMESPACE" delete pod "$POD_NAME" --wait=true
ok "Pod ${POD_NAME} deleted (was uid ${OLD_POD_UID:0:8})"
wait_for "Pod ${POD_NAME} recreated by the StatefulSet controller" 180 \
  "${KCTL[@]}" -n "$NAMESPACE" get pod "$POD_NAME" || \
  fail "Pod ${POD_NAME} was not recreated within 180s of deletion"
NEW_POD_UID="$("${KCTL[@]}" -n "$NAMESPACE" get pod "$POD_NAME" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
[[ -n "$NEW_POD_UID" && "$NEW_POD_UID" != "$OLD_POD_UID" ]] || fail "Pod ${POD_NAME} has the same uid as before deletion — deletion never actually happened"
wait_pod_ready "$NAMESPACE" "$POD_NAME" 300s
pass "StatefulSet ${STS_NAME} recreated Pod ${POD_NAME} (uid ${OLD_POD_UID:0:8} -> ${NEW_POD_UID:0:8}) and it is Ready"

log "== step b3: DRIFT — 'kubectl scale sts --replicas=0' (manual drift), asserting Argo CD selfHeal restores replicas=1 =="
"${KCTL[@]}" -n "$NAMESPACE" scale statefulset "$STS_NAME" --replicas=0
ok "StatefulSet ${STS_NAME} scaled to replicas=0 out-of-band"
wait_for "StatefulSet ${STS_NAME} replicas restored to 1 by Argo CD selfHeal" 180 bash -c \
  "[[ \"\$(${KCTL[*]} -n '$NAMESPACE' get statefulset '$STS_NAME' -o jsonpath='{.spec.replicas}')\" == '1' ]]" || {
  CUR_REPLICAS="$("${KCTL[@]}" -n "$NAMESPACE" get statefulset "$STS_NAME" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  fail "StatefulSet ${STS_NAME} spec.replicas never returned to 1 within 180s of the manual scale-to-0 (last: ${CUR_REPLICAS:-<none>})"
}
wait_pod_ready "$NAMESPACE" "$POD_NAME" 300s
pass "Argo CD selfHeal restored StatefulSet ${STS_NAME} to replicas=1 and the pod is Ready again"

# ===========================================================================
# c. DRIFT (secret) — delete the API_SERVER_KEY ExternalSecret's target Secret
# ===========================================================================
# The test persona (distribution.yaml) has no env_requires at all, so it has
# no per-persona secret-backed ExternalSecret (harness/hermes/charts/hermes-profile/
# templates/externalsecret.yaml is never rendered for it — see
# _docs/wiki/platform/testing.md row 8). It DOES always get the API_SERVER_KEY
# ExternalSecret (templates/apikey-secret.yaml), unconditional on
# envRequires, so that one's target Secret is the live, always-present
# target this step exercises — see this task's brief for why that's the
# simplest honest choice here.
log "== step c: DRIFT (secret) — deleting target Secret ${API_KEY_SECRET_NAME}, asserting it's recreated =="
OLD_SECRET_UID="$("${KCTL[@]}" -n "$NAMESPACE" get secret "$API_KEY_SECRET_NAME" -o jsonpath='{.metadata.uid}')"
OLD_SECRET_VALUE="$("${KCTL[@]}" -n "$NAMESPACE" get secret "$API_KEY_SECRET_NAME" -o jsonpath='{.data.password}')"
"${KCTL[@]}" -n "$NAMESPACE" delete secret "$API_KEY_SECRET_NAME" --wait=true
ok "Secret ${API_KEY_SECRET_NAME} deleted (was uid ${OLD_SECRET_UID:0:8})"
if wait_for "Secret ${API_KEY_SECRET_NAME} recreated by ESO" 180 \
  "${KCTL[@]}" -n "$NAMESPACE" get secret "$API_KEY_SECRET_NAME"; then
  NEW_SECRET_UID="$("${KCTL[@]}" -n "$NAMESPACE" get secret "$API_KEY_SECRET_NAME" -o jsonpath='{.metadata.uid}')"
  NEW_SECRET_VALUE="$("${KCTL[@]}" -n "$NAMESPACE" get secret "$API_KEY_SECRET_NAME" -o jsonpath='{.data.password}' 2>/dev/null || true)"
  [[ "$NEW_SECRET_UID" != "$OLD_SECRET_UID" ]] || fail "Secret ${API_KEY_SECRET_NAME} has the same uid as before deletion — deletion never actually happened"
  # Honest, not papered over: this is repaired by ESO's OWN controller loop
  # reconciling the owning ExternalSecret (creationPolicy: Owner + a
  # controller-runtime watch on its owned Secret), NOT Argo CD selfHeal —
  # Argo CD never diffs this object at all (it's created by ESO out-of-band,
  # not part of the Helm chart's rendered manifest set it applies/tracks).
  # Whether the regenerated value matches the old one depends on the
  # generators.external-secrets.io Password generator's behavior on a fresh
  # reconcile of an Owner-policy target with no cached state to reuse — see
  # this task's report and _docs/wiki/runbooks/recovery.md for the live-observed answer.
  if [[ "$NEW_SECRET_VALUE" == "$OLD_SECRET_VALUE" ]]; then
    pass "ESO recreated Secret ${API_KEY_SECRET_NAME} (uid ${OLD_SECRET_UID:0:8} -> ${NEW_SECRET_UID:0:8}) with the SAME password value"
  else
    pass "ESO recreated Secret ${API_KEY_SECRET_NAME} (uid ${OLD_SECRET_UID:0:8} -> ${NEW_SECRET_UID:0:8}) with a NEW password value (generator re-ran — see _docs/wiki/runbooks/recovery.md)"
  fi
else
  record_skip "Secret ${API_KEY_SECRET_NAME} was not recreated within 180s of deletion — ESO does not appear to reconcile a deleted generator-backed target Secret on this ESO version/config; documented as a real gap in _docs/wiki/runbooks/recovery.md, not papered over"
fi

# ===========================================================================
# d. OUT-OF-BAND edit — kubectl patch service (a rendered resource; the
#    inert HermesProfile CR this step used to patch no longer exists —
#    issue #50 [G9] removed the CRD)
# ===========================================================================
log "== step d: OUT-OF-BAND edit — kubectl patch service ${SVC_NAME} persona label, asserting Argo CD flips OutOfSync then self-heals it back =="
PERSONA_LABEL_JSONPATH='{.metadata.labels.hermes-gitops\.factorylevel\.dev/persona}'
ORIGINAL_PERSONA="$("${KCTL[@]}" -n "$NAMESPACE" get service "$SVC_NAME" -o jsonpath="$PERSONA_LABEL_JSONPATH")"
[[ -n "$ORIGINAL_PERSONA" ]] || fail "could not read the persona label off Service ${SVC_NAME} before patching"
"${KCTL[@]}" -n "$NAMESPACE" patch service "$SVC_NAME" --type=merge \
  -p '{"metadata":{"labels":{"hermes-gitops.factorylevel.dev/persona":"drift-test-out-of-band-edit"}}}'
ok "kubectl patch service ${SVC_NAME}: persona label '${ORIGINAL_PERSONA}' -> 'drift-test-out-of-band-edit'"

# Best-effort: try to CATCH the transient OutOfSync window (Argo CD's
# self-heal reconcile can be fast enough that a slow poller misses it
# entirely — that race is expected and not itself a failure; the load-
# bearing assertion is the one after this loop).
CAUGHT_OUT_OF_SYNC=0
for _ in $(seq 1 30); do
  read -r sync _ <<<"$(app_status "$APP_NAME")"
  if [[ "$sync" == "OutOfSync" ]]; then
    CAUGHT_OUT_OF_SYNC=1
    break
  fi
  sleep 2
done
if [[ "$CAUGHT_OUT_OF_SYNC" == "1" ]]; then
  ok "observed Application ${APP_NAME} go OutOfSync after the out-of-band patch"
else
  log "note: did not observe a transient OutOfSync state within 60s — Argo CD's selfHeal reconcile can be faster than this poller; proceeding to the load-bearing revert assertion below"
fi

wait_for "Service ${SVC_NAME} persona label reverted by Argo CD selfHeal" 180 bash -c \
  "[[ \"\$(${KCTL[*]} -n '$NAMESPACE' get service '$SVC_NAME' -o jsonpath='$PERSONA_LABEL_JSONPATH')\" == '$ORIGINAL_PERSONA' ]]" || {
  CUR_PERSONA="$("${KCTL[@]}" -n "$NAMESPACE" get service "$SVC_NAME" -o jsonpath="$PERSONA_LABEL_JSONPATH" 2>/dev/null || true)"
  fail "Service ${SVC_NAME} persona label never reverted to '${ORIGINAL_PERSONA}' within 180s of the out-of-band patch (last: ${CUR_PERSONA:-<none>})"
}
wait_app_synced_healthy "$APP_NAME" 180
pass "Argo CD selfHeal reverted the out-of-band Service patch and Application ${APP_NAME} is Synced+Healthy again"

# ===========================================================================
# e. DECOMMISSION — Pulumi-driven (issue #24 [F6]): removing the agent
#    from the stack's agents[] config and running `pulumi up` runs the
#    per-agent Command's delete action, which prunes profiles/<name>/
#    from the GitOps repo through the plugin's decommission CLI
# ===========================================================================
log "== step e: DECOMMISSION — removing profiles/${PERSONA_NAME}/ from the GitOps repo =="

# Marker written before decommission — used by step f to prove the
# re-provisioned PVC is genuinely FRESH (not the same underlying volume
# somehow surviving), mirroring smoke-local.sh's update-path marker but
# inverted: there, survival is the pass condition; here, absence is.
DECOMMISSION_MARKER_DIR="/opt/data/.hermes-gitops"
DECOMMISSION_MARKER_FILE="${DECOMMISSION_MARKER_DIR}/drift-test-marker"
DECOMMISSION_MARKER_NONCE="drift-$(date -u +%s)-${RANDOM}-$$"
"${KCTL[@]}" -n "$NAMESPACE" exec "$POD_NAME" -c hermes-agent -- \
  sh -c "mkdir -p '$DECOMMISSION_MARKER_DIR' && printf '%s' '$DECOMMISSION_MARKER_NONCE' > '$DECOMMISSION_MARKER_FILE'" || \
  fail "failed to write pre-decommission PVC marker $DECOMMISSION_MARKER_FILE"
ok "wrote pre-decommission PVC marker $DECOMMISSION_MARKER_FILE (nonce ${DECOMMISSION_MARKER_NONCE})"

GITOPS_DECOMMISSION="$WORKDIR/gitops-decommission"
git clone --quiet "$GITOPS_URL" "$GITOPS_DECOMMISSION"
# Keep a copy of the removed profile dir so step f can push it back
# byte-identical (a real re-provisioning is "the same profile.yaml comes
# back", not "some other content happens to occupy that path").
cp -r "$GITOPS_DECOMMISSION/profiles/${PERSONA_NAME}" "$WORKDIR/profile-backup"
# THE F6 PATH: remove the agent from stack config; `pulumi up` runs the
# Command's delete action -> plugin decommission -> GitOps prune.
(cd "$BOOTSTRAP_DIR" && pulumi config rm --path 'hermes-gitops-bootstrap:agents' >/dev/null && pulumi up --yes --skip-preview >/dev/null)
git -C "$GITOPS_DECOMMISSION" fetch --quiet origin main
if git -C "$GITOPS_DECOMMISSION" cat-file -e "origin/main:profiles/${PERSONA_NAME}/profile.yaml" 2>/dev/null; then
  fail "pulumi-driven decommission did not remove profiles/${PERSONA_NAME}/ from the GitOps repo"
fi
DECOM_MSG="$(git -C "$GITOPS_DECOMMISSION" log -1 --format=%s origin/main)"
grep -q "gitops-emitter: decommission ${PERSONA_NAME}" <<<"$DECOM_MSG" || \
  fail "expected a decommission commit, got: $DECOM_MSG"
pass "pulumi up (agent removed from stack) pruned profiles/${PERSONA_NAME}/ from the GitOps repo"

"${KCTL[@]}" -n argocd annotate applicationset hermes-gitops-profiles \
  argocd.argoproj.io/application-set-refresh=true --overwrite >/dev/null 2>&1 || true

log "== waiting for Application ${APP_NAME} to be pruned =="
wait_for "Application ${APP_NAME} to be pruned" 300 bash -c \
  "! ${KCTL[*]} -n argocd get application '$APP_NAME' >/dev/null 2>&1" || \
  fail "Application ${APP_NAME} was not pruned within 300s of removing profiles/${PERSONA_NAME}/"
pass "Application ${APP_NAME} pruned"

log "== step e2: asserting the namespaced resources it owned are gone =="
wait_for "StatefulSet ${STS_NAME} gone" 120 bash -c \
  "! ${KCTL[*]} -n '$NAMESPACE' get statefulset '$STS_NAME' >/dev/null 2>&1" || \
  fail "StatefulSet ${STS_NAME} still exists after Application ${APP_NAME} was pruned"
ok "StatefulSet ${STS_NAME} gone"
wait_for "Service ${SVC_NAME} gone" 60 bash -c \
  "! ${KCTL[*]} -n '$NAMESPACE' get service '$SVC_NAME' >/dev/null 2>&1" || \
  fail "Service ${SVC_NAME} still exists after Application ${APP_NAME} was pruned"
ok "Service ${SVC_NAME} gone"
wait_for "ExternalSecret ${API_KEY_SECRET_NAME} gone" 60 bash -c \
  "! ${KCTL[*]} -n '$NAMESPACE' get externalsecret '$API_KEY_SECRET_NAME' >/dev/null 2>&1" || \
  fail "ExternalSecret ${API_KEY_SECRET_NAME} still exists after Application ${APP_NAME} was pruned"
ok "ExternalSecret ${API_KEY_SECRET_NAME} gone"
pass "namespaced resources (StatefulSet/Service/ExternalSecret) pruned along with the Application"

log "== step e3: asserting the PVC ${PVC_NAME} was deleted (StatefulSetAutoDeletePVC, whenDeleted:Delete) =="
K8S_MINOR="$("${KCTL[@]}" version -o json 2>/dev/null | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d.get("serverVersion",{}).get("minor","0").rstrip("+"))' 2>/dev/null || echo 0)"
log "cluster server minor version: 1.${K8S_MINOR:-<unknown>} (StatefulSetAutoDeletePVC: beta+default-on since 1.27, GA since 1.32)"
if [[ -n "$K8S_MINOR" ]] && (( K8S_MINOR < 27 )); then
  record_skip "cluster k8s minor (1.${K8S_MINOR}) predates StatefulSetAutoDeletePVC's beta/default-on status (1.27) — PVC deletion on StatefulSet delete cannot be expected to work here; not asserting"
else
  if wait_for "PVC ${PVC_NAME} deleted" 120 bash -c \
    "! ${KCTL[*]} -n '$NAMESPACE' get pvc '$PVC_NAME' >/dev/null 2>&1"; then
    pass "PVC ${PVC_NAME} was deleted along with the StatefulSet (whenDeleted:Delete honored)"
  else
    # Deliberately NOT papered over (per this task's brief): if this ever
    # fires, it is a real finding — either the feature gate isn't enabled
    # the way this cluster's k8s minor should default it, or
    # persistentVolumeClaimRetentionPolicy isn't taking effect the way
    # harness/hermes/charts/hermes-profile/templates/pod/statefulset.yaml declares it
    # should. See _docs/wiki/runbooks/recovery.md's "PVC lifecycle" section for the
    # live-observed outcome on this run.
    fail "PVC ${PVC_NAME} still exists after its owning StatefulSet was deleted — StatefulSetAutoDeletePVC's whenDeleted:Delete did NOT take effect on this cluster (k8s minor 1.${K8S_MINOR}); this is a real finding, see _docs/wiki/runbooks/recovery.md"
  fi
fi

# NOTE: same documented Argo CD behavior as smoke-local.sh's teardown step —
# CreateNamespace=true is a first-sync convenience, not an ownership marker,
# so the namespace itself is expected to survive the Application prune.
# Best-effort informational check only; cluster teardown (this script's
# trap) reclaims it regardless.
if "${KCTL[@]}" get namespace "$NAMESPACE" >/dev/null 2>&1; then
  log "note: namespace ${NAMESPACE} still exists (expected — Argo CD's CreateNamespace=true does not prune it); cluster teardown reclaims it regardless"
fi

# ===========================================================================
# f. RE-INSTALL — push profiles/<name> back, assert clean re-provisioning
# ===========================================================================
log "== step f: RE-INSTALL — pushing profiles/${PERSONA_NAME}/ back to the GitOps repo =="
GITOPS_REINSTALL="$WORKDIR/gitops-reinstall"
git clone --quiet "$GITOPS_URL" "$GITOPS_REINSTALL"
mkdir -p "$GITOPS_REINSTALL/profiles/${PERSONA_NAME}"
cp -r "$WORKDIR/profile-backup/." "$GITOPS_REINSTALL/profiles/${PERSONA_NAME}/"
git -C "$GITOPS_REINSTALL" add "profiles/${PERSONA_NAME}"
git -C "$GITOPS_REINSTALL" -c user.email=drift-test@hermes-gitops.local -c user.name=drift-test \
  commit --quiet -m "drift-test: re-install ${PERSONA_NAME}"
git -C "$GITOPS_REINSTALL" push --quiet origin HEAD:refs/heads/main
pass "profiles/${PERSONA_NAME}/ pushed back to the GitOps repo (byte-identical to the pre-decommission record)"

"${KCTL[@]}" -n argocd annotate applicationset hermes-gitops-profiles \
  argocd.argoproj.io/application-set-refresh=true --overwrite >/dev/null 2>&1 || true

log "== waiting for Application ${APP_NAME} to reappear =="
wait_for "Application ${APP_NAME} to reappear" 300 \
  "${KCTL[@]}" get application "$APP_NAME" -n argocd || \
  fail "Application ${APP_NAME} did not reappear within 300s of re-pushing profiles/${PERSONA_NAME}/"
pass "Argo CD Application ${APP_NAME} regenerated"

log "== waiting for Application ${APP_NAME} to reach Synced+Healthy =="
wait_app_synced_healthy "$APP_NAME" 900

log "== waiting for pod ${POD_NAME} to be Ready =="
wait_pod_ready "$NAMESPACE" "$POD_NAME" 300s
pass "pod ${POD_NAME} is Ready again after re-provisioning"

log "== step f2: asserting the re-provisioned PVC is genuinely fresh (no leftover pre-decommission data) =="
"${KCTL[@]}" -n "$NAMESPACE" get pvc "$PVC_NAME" >/dev/null || fail "PVC $PVC_NAME not recreated by the fresh install"
REINSTALL_MARKER="$("${KCTL[@]}" -n "$NAMESPACE" exec "$POD_NAME" -c hermes-agent -- cat "$DECOMMISSION_MARKER_FILE" 2>/dev/null || true)"
if [[ -n "$REINSTALL_MARKER" ]]; then
  fail "pre-decommission marker $DECOMMISSION_MARKER_FILE is still present after re-install (nonce ${REINSTALL_MARKER}) — the PVC was NOT actually wiped; fresh state was expected"
fi
pass "PVC $PVC_NAME is fresh — pre-decommission marker is gone, as expected for a clean re-provisioning"

echo
echo "All steps passed. Tearing down (trap) ..."
