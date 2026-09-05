#!/usr/bin/env bash
# THE session's headline acceptance test (Task 9 / Milestone 6): the ENTIRE
# Hermes GitOps loop, on this machine, for real, no sudo, no GitHub, no cloud:
#
#   pulumi up (stages 1-2: real fork Hermes + real gitops-emitter plugin)
#     -> GitOps repo populated (bootstrap/ scaffold incl. the monitoring
#        pair + profiles/hermes-gitops-test/profile.yaml)
#     -> pulumi up (stage 3: Argo CD + ESO, on a k3d cluster)
#     -> Argo CD's hermes-gitops-profiles ApplicationSet syncs the persona
#     -> the hermes-profile Helm chart renders a real pod + one Application
#        per app (site, test-page, monitoring, secret-tester)
#     -> the MkDocs site served through the real Ingress/Traefik path
#     -> the demo secret delivered into the pod env and verified by the
#        secret SHA tester page (two payloads, checksum only in git)
#     -> Grafana fires SiteVisitsHigh (threshold from the Pulumi override),
#        HermesAgentDown, and AgentAppUnhealthy - each asserted CAUSALLY
#        at a local webhook sink (and mirrored to Discord when
#        DISCORD_WEBHOOK_URL is exported)
#
# The persona installed is THIS REPOSITORY ITSELF: its distribution payload
# under .hermes-dist/distribution-agent/ (installed via the fork's --subdir
# form, agents[0].subdir) makes harness-hg an installable Hermes
# profile distribution named "hermes-gitops-test" — one demo secret
# (SMOKE_DEMO_SECRET, exercising the agentSecrets chain), no LLM
# required. infra/scripts/verify-bootstrap-git-side.sh proved
# stages 1-2 in isolation (no cluster); this script proves the WHOLE loop,
# stage 3 included, against a real (if throwaway) k3d cluster.
#
# --- Why two local git servers, not one -----------------------------------
#
# Two independent repos need to be reachable from BOTH this host (running
# `pulumi up`/`hermes profile install`) AND from *inside* k3d pods (a
# `file://` URL only resolves on the host — see repo-root README's
# "Why git-before-cluster" and this task's report for the full reasoning):
#
#   1. The GitOps repo (gitopsRepoUrl) — gitops-emitter PUSHES to it (stage
#      2, host-side) and Argo CD READS it in-cluster. Needs read+write.
#      Served via `git daemon --enable=receive-pack` (git:// protocol) —
#      dumb HTTP cannot support `git push` at all (no smart-HTTP backend
#      behind a plain static file server), so this repo can't use the same
#      transport as repo 2 below.
#
#   2. The persona/chart source repo (hermesGitopsRepoUrl AND, doubling as
#      the same URL, the `hermes profile install <source>` argument that
#      becomes `spec.source` in profile.yaml) — a bare mirror of THIS repo.
#      Read-only from both sides, but MUST be http(s)/git@/ssh:// (or a bare
#      "host.tld/path" string) — harness/hermes/charts/hermes-profile/templates/_helpers.tpl's
#      `hermes.gitCloneURL` helper explicitly `fail`s on a `git://` URL (only
#      http/https/git@/ssh:// or bare-host-looking strings are accepted) and
#      the pod's own bootstrap-distribution initContainer (configmap-boot.yaml)
#      does a REAL `git clone $HERMES_DIST_SOURCE` at every boot using
#      whatever string `spec.source` holds — so this one is served dumb-HTTP
#      (`python3 -m http.server`, `git update-server-info` regenerated after
#      every commit) instead.
#
# Both are addressed via the k3d cluster's own docker bridge network's
# gateway IP (`docker network inspect k3d-<cluster> ... .Gateway`) — this IP
# is reachable both from the host (it's a real interface on the host, docker
# always attaches the bridge gateway there) and from every container
# plugged into that bridge network (k3d nodes and everything running on
# them), so ONE url string works unmodified on both sides of the boundary —
# confirmed live (see this task's report) rather than assumed; the more
# commonly-documented `host.k3d.internal` DNS name is NOT usable here since
# it's injected only into the cluster's own CoreDNS/node /etc/hosts, not
# resolvable from the host's own resolver.
#
# --- Usage -------------------------------------------------------------
#   infra/scripts/smoke-local.sh
# Env overrides: HERMES_FORK_PATH (default: ../hermes-agent-gitops
#   next to this checkout).
# Requires: pulumi, uv, git, python3, docker, kubectl (dev-cluster.sh
#   self-installs k3d/kubectl to ~/.local/bin if missing).
#
# Prints "OK"/"PASS"/"FAIL" lines throughout; non-zero exit on any failure.
# Trap-based cleanup runs on ANY exit (success, failure, or interrupt):
# port-forward, git daemon, http server, the pulumi stack (destroyed and
# removed), the k3d cluster (deleted), and every tmpdir this run created.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOOTSTRAP_DIR="$REPO_ROOT/infra"
HERMES_FORK_PATH="${HERMES_FORK_PATH:-$REPO_ROOT/../hermes-agent-gitops}"

# shellcheck source=lib/smoke-helpers.sh
source "$REPO_ROOT/infra/scripts/lib/smoke-helpers.sh"

CLUSTER_NAME="hermes-gitops-dev"          # matches infra/scripts/dev-cluster.sh
K3D_NETWORK="k3d-${CLUSTER_NAME}"
STACK_NAME="smoke-local"
PERSONA_NAME="hermes-gitops-test"          # matches distribution.yaml's `name:`
APP_NAME="hermes-${PERSONA_NAME}"        # ApplicationSet naming convention
NAMESPACE="hermes-${PERSONA_NAME}"       # ApplicationSet destination namespace
LOCAL_IMAGE_REPO="hermes-agent"
LOCAL_IMAGE_TAG="hermes-gitops-dev"

SMOKE_LOG_PREFIX="smoke-local"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
preflight_checks

# ---------------------------------------------------------------------------
# Isolation + trap-based cleanup (every step below is disposable; nothing
# under $HOME or this checkout is touched or left behind on exit).
# ---------------------------------------------------------------------------
WORKDIR="$(mktemp -d -t hermes-gitops-smoke-XXXXXX)"
GIT_DAEMON_PID=""
HTTP_SERVER_PID=""
WEBHOOK_SINK_PID=""
PORT_FORWARD_PID=""
CLUSTER_UP=0

# Monitoring/alerting knobs (see bootstrap_stage12 in lib/smoke-helpers.sh):
# the author default threshold in the persona's hermes-gitops.yaml is 100
# visits/5m; the per-instance Pulumi override drops it to this value so a
# handful of curls trips the SiteVisitsHigh alert — proving the operator
# override channel AND the alert loop in one step.
VISITS_THRESHOLD=3
# The demo secret value the agentSecrets -> Secret -> envFrom chain must
# deliver into the running agent pod, byte-for-byte (asserted in step 10b).
SMOKE_DEMO_SECRET_VALUE="smoke-demo-$$-$(date +%s)"

cleanup() {
  local rc=$?
  log "cleaning up (exit code $rc)..."

  common_cleanup

  if [[ "$rc" == "0" ]]; then
    echo
    echo "=========================================================="
    echo "PASS: Hermes GitOps full loop verified end-to-end on this machine"
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
# Step 1 — throwaway k3d cluster
# ---------------------------------------------------------------------------
log "== step 1: dev k3d cluster =="
bash "$REPO_ROOT/infra/scripts/dev-cluster.sh" up
CLUSTER_UP=1
pass "k3d cluster '${CLUSTER_NAME}' up"

# ---------------------------------------------------------------------------
# Step 2 — local git servers: the writable GitOps repo (git://, receive-pack
# enabled) and the read-only persona/chart source mirror (dumb http://) —
# see this script's header comment for why these need two different
# transports. (infra/scripts/lib/smoke-helpers.sh::start_git_servers)
# ---------------------------------------------------------------------------
log "== step 2: local git servers (GitOps repo + persona-source mirror) =="
start_git_servers

# The local webhook sink stands in for the operator's real alert receiver
# (a GitHub dispatch endpoint, Discord, ...) so step 12m can ASSERT
# delivery. Export DISCORD_WEBHOOK_URL to additionally prove alerts
# against a real Discord channel (see bootstrap_stage12).
log "== step 2b: local webhook sink (Grafana alert receiver) =="
start_webhook_sink

# ---------------------------------------------------------------------------
# Step 3 — pulumi up, stages 1-2 (real fork Hermes + gitops-emitter plugin,
# real `hermes profile install` of THIS repo's own .hermes-dist payload).
# (infra/scripts/lib/smoke-helpers.sh::bootstrap_stage12 — see its inline comment
# for why agents[0].ref is required, not optional, here.)
# ---------------------------------------------------------------------------
log "== step 3: pulumi up (stages 1-2) =="
bootstrap_stage12
pass "pulumi up (stage 1: Hermes+plugin install; stage 2: hermes profile install $PERSONA_NAME)"

# ---------------------------------------------------------------------------
# Step 4 — verify the GitOps repo actually received the scaffold + profile
# ---------------------------------------------------------------------------
log "== step 4: verifying the pushed GitOps repo =="
GITOPS_CHECK="$WORKDIR/gitops-check"
git clone --quiet "$GITOPS_URL" "$GITOPS_CHECK"

for f in bootstrap/applicationset.yaml bootstrap/project.yaml bootstrap/values/cluster-values.yaml \
  "profiles/${PERSONA_NAME}/profile.yaml"; do
  [[ -f "$GITOPS_CHECK/$f" ]] || fail "$f missing from the pushed GitOps repo"
  ok "$f present in pushed GitOps repo"
done

log "-- profiles/${PERSONA_NAME}/profile.yaml --"
cat "$GITOPS_CHECK/profiles/${PERSONA_NAME}/profile.yaml"

SCHEMA="$REPO_ROOT/agent-bundle-contracts/hermesprofile/v1alpha3/profile.schema.json"
uv run --with pyyaml --with jsonschema "$REPO_ROOT/infra/scripts/validate_with_jsonschema.py" \
  "$SCHEMA" "$GITOPS_CHECK/profiles/${PERSONA_NAME}/profile.yaml"
pass "profile.yaml valid against schemas/hermesprofile/v1alpha3 (spec.apps intent from hermes-gitops.yaml)"

# The record must show the OVERRIDE CHAIN did its job: the monitoring
# app's author threshold (100, hermes-gitops.yaml) deep-merged under the
# per-instance Pulumi override ($VISITS_THRESHOLD), the webhook receiver
# satisfied valuesRequired, and the declared demo secret survived into
# spec.envRequires.
uv run --with pyyaml python3 - "$GITOPS_CHECK/profiles/${PERSONA_NAME}/profile.yaml" \
  "$VISITS_THRESHOLD" "$WEBHOOK_SINK_URL" <<'PYEOF'
import sys, yaml
path, threshold, sink_url = sys.argv[1], sys.argv[2], sys.argv[3]
spec = yaml.safe_load(open(path))["spec"]
apps = {a["name"]: a for a in spec.get("apps", [])}
assert "monitoring" in apps, f"monitoring app missing from spec.apps: {sorted(apps)}"
alert = apps["monitoring"]["values"]["alert"]
got = str(alert["siteVisits5m"]["threshold"])
assert got == threshold, f"threshold override lost: expected {threshold}, record has {got}"
assert alert["webhookUrl"] == sink_url, f"webhookUrl override lost: {alert.get('webhookUrl')!r}"
assert "SMOKE_DEMO_SECRET" in (spec.get("envRequires") or []), \
    f"SMOKE_DEMO_SECRET missing from spec.envRequires: {spec.get('envRequires')}"
print("  monitoring app: threshold override + webhookUrl + envRequires all present")
PYEOF
pass "record proves the Pulumi override channel (threshold=${VISITS_THRESHOLD}, webhookUrl=sink) + spec.envRequires"

# ---------------------------------------------------------------------------
# Step 5 — point the scaffolded cluster-values.yaml at the LOCAL
# hermes-agent:hermes-gitops-dev image build. This is exactly the documented,
# sanctioned post-scaffold operator workflow (infra/gitops-template/README.md:
# "bootstrap/values/cluster-values.yaml (operator-owned cluster config) is
# meant to be edited after scaffolding") — not a bootstrap/emitter/chart
# change. A real fleet operator would point this at their own pushed image
# instead; this script points it at the image already built and verified
# live in Task 8, per this task's brief.
# ---------------------------------------------------------------------------
log "== step 5: pinning cluster-values.yaml's image to the local build =="
pin_cluster_values_image "$GITOPS_CHECK" "$LOCAL_IMAGE_REPO" "$LOCAL_IMAGE_TAG"
pass "cluster-values.yaml image pinned to local ${LOCAL_IMAGE_REPO}:${LOCAL_IMAGE_TAG} build"

# ---------------------------------------------------------------------------
# Step 6 — import the local image into k3d
# ---------------------------------------------------------------------------
log "== step 6: importing ${LOCAL_IMAGE_REPO}:${LOCAL_IMAGE_TAG} into k3d =="
import_local_image "$LOCAL_IMAGE_REPO" "$LOCAL_IMAGE_TAG" "$CLUSTER_NAME"
pass "${LOCAL_IMAGE_REPO}:${LOCAL_IMAGE_TAG} imported into k3d cluster ${CLUSTER_NAME}"

# ---------------------------------------------------------------------------
# Step 7 — pulumi up, stage 3 (Argo CD + ESO +
# ClusterSecretStore + the hermes-gitops-root Application) against the k3d
# kubeconfig
# ---------------------------------------------------------------------------
log "== step 7: pulumi up (stage 3: cluster control plane) =="
bootstrap_stage3
pass "pulumi up (stage 3: Argo CD + ESO + hermes-gitops-root Application)"

log "== step 7b: idempotency — a second stage-3 pulumi up must be a no-op =="
pulumi up --yes --expect-no-changes
pass "second stage-3 pulumi up was a no-op (idempotent)"

KCTL=(kubectl --context "k3d-${CLUSTER_NAME}")

# ---------------------------------------------------------------------------
# Step 8 — wait for the ApplicationSet-generated Application to exist, then
# Sync+Healthy. (infra/scripts/lib/smoke-helpers.sh::wait_for / app_status /
# wait_app_synced_healthy)
# ---------------------------------------------------------------------------
log "== step 8: waiting for Argo CD Application '${APP_NAME}' to exist =="
wait_for "Application ${APP_NAME} to exist" 300 \
  "${KCTL[@]}" get application "$APP_NAME" -n argocd || \
  fail "Application ${APP_NAME} never appeared in argocd namespace within 300s"
pass "Argo CD Application ${APP_NAME} exists"

log "== step 9: waiting for Application ${APP_NAME} to reach Synced+Healthy =="
wait_app_synced_healthy "$APP_NAME" 900

# ---------------------------------------------------------------------------
# Step 9b — the platform monitoring stack (bootstrap/monitoring-stack.yaml
# in the scaffolded GitOps repo: one pinned kube-prometheus-stack release,
# ADR-45, synced by the same hermes-gitops-root Application as everything
# else in bootstrap/). A remote chart, so first sync pulls from the public
# helm repo — allow a generous window.
# ---------------------------------------------------------------------------
log "== step 9b: waiting for the platform monitoring stack =="
for mon_app in monitoring-stack; do
  wait_for "Application ${mon_app} to exist" 300 \
    "${KCTL[@]}" get application "$mon_app" -n argocd || \
    fail "Application ${mon_app} never appeared in argocd namespace within 300s"
  wait_app_synced_healthy "$mon_app" 900
done

# ---------------------------------------------------------------------------
# Step 10 — pod Ready
# ---------------------------------------------------------------------------
log "== step 10: waiting for pod hermes-${PERSONA_NAME}-0 to be Ready =="
wait_pod_ready "$NAMESPACE" "hermes-${PERSONA_NAME}-0" 300s
pass "pod hermes-${PERSONA_NAME}-0 is Ready"

# ---------------------------------------------------------------------------
# Step 10b — the demo secret arrived: `pulumi config set --secret --path
# 'agentSecrets.<name>.SMOKE_DEMO_SECRET'` -> agent-secrets component ->
# Secret hermes-<name>-env -> chart envFrom -> the RUNNING container's
# environment, byte-for-byte.
# ---------------------------------------------------------------------------
log "== step 10b: demo secret present in the agent pod's environment =="
POD_SECRET="$("${KCTL[@]}" -n "$NAMESPACE" exec "hermes-${PERSONA_NAME}-0" -c hermes-agent -- printenv SMOKE_DEMO_SECRET 2>/dev/null || true)"
[[ "$POD_SECRET" == "$SMOKE_DEMO_SECRET_VALUE" ]] || \
  fail "SMOKE_DEMO_SECRET in the pod env is ${POD_SECRET:-<empty>}, expected ${SMOKE_DEMO_SECRET_VALUE} (agentSecrets -> Secret -> envFrom chain broken)"
pass "agentSecrets -> Secret hermes-${PERSONA_NAME}-env -> pod env chain delivered SMOKE_DEMO_SECRET"

# ---------------------------------------------------------------------------
# Step 11 — the labeled Application inventories the instance (there is no
#           HermesProfile CRD — issue #50 [G9]; the persona label on the
#           Argo CD Application is the cluster-side inventory now)
# ---------------------------------------------------------------------------
log "== step 11: labeled Application inventory =="
"${KCTL[@]}" -n argocd get application "$APP_NAME" \
  -o jsonpath='{.metadata.labels.hermes-gitops\.factorylevel\.dev/persona}' | grep -qx "$PERSONA_NAME" || \
  fail "Application ${APP_NAME} missing persona label ${PERSONA_NAME}"
pass "Application ${APP_NAME} carries persona label ${PERSONA_NAME}"

# ---------------------------------------------------------------------------
# Step 12 — curl the test page through the real Ingress/Traefik path
# ---------------------------------------------------------------------------
log "== step 12: curling the Hermes GitOps docs site through Ingress =="
LOCAL_PORT="$(find_free_port)"
nohup "${KCTL[@]}" -n kube-system port-forward svc/traefik "${LOCAL_PORT}:80" \
  >"$WORKDIR/port-forward.log" 2>&1 <"/dev/null" &
PORT_FORWARD_PID=$!
disown
sleep 3
kill -0 "$PORT_FORWARD_PID" 2>/dev/null || fail "kubectl port-forward svc/traefik failed to start (see $WORKDIR/port-forward.log)"

# The exposed service is the "site" app (a local platform chart serving
# the project's own MkDocs site, built in-container from the distribution
# source at the pinned sha - see .hermes-dist/distribution-agent/hermes-gitops.yaml).
# First boot clones + builds before serving, so allow a longer settle window
# than the old static test page needed.
BODY=""
for attempt in $(seq 1 24); do
  BODY="$(curl -s -H "Host: ${PERSONA_NAME}.hermes.local" "http://127.0.0.1:${LOCAL_PORT}/" || true)"
  # grep -q <<<herestring, NOT `echo | grep -q`: with pipefail, grep
  # exiting at the match SIGPIPEs the echo (exit 141) once the body
  # outgrows the pipe buffer, and the pipeline "fails" despite the
  # match - bit us live when the wiki grew past 64KB.
  if grep -q "<title>Hermes GitOps</title>" <<<"$BODY"; then
    break
  fi
  sleep 5
done
grep -q "<title>Hermes GitOps</title>" <<<"$BODY" || {
  log "-- response body --"
  echo "$BODY"
  fail "docs site did not contain the expected '<title>Hermes GitOps</title>' marker"
}
pass "curled the Hermes GitOps docs site through the real Ingress/Traefik path"

# ---------------------------------------------------------------------------
# Step 12s — the secret SHA tester: a SEPARATE page (same hostname,
# /secret-tester path) whose verify endpoint proves — with two payloads —
# that the secret the operator set in Pulumi reached the agent-app, by
# comparing sha256 digests server-side. The secret value itself never
# appears in the repo, the record, or this check's traffic.
# ---------------------------------------------------------------------------
log "== step 12s: secret SHA tester page (two-payload verify) =="
TESTER_PAGE=""
for attempt in $(seq 1 24); do
  TESTER_PAGE="$(curl -s -H "Host: ${PERSONA_NAME}.hermes.local" "http://127.0.0.1:${LOCAL_PORT}/secret-tester" || true)"
  if grep -q "Secret SHA tester" <<<"$TESTER_PAGE"; then
    break
  fi
  sleep 5
done
grep -q "Secret SHA tester" <<<"$TESTER_PAGE" || {
  echo "$TESTER_PAGE"
  fail "secret-tester page did not serve through Ingress at /secret-tester"
}
ok "secret-tester page serves at /secret-tester (separate from the wiki site at /)"

TESTER_VERIFY="$(curl -s -H "Host: ${PERSONA_NAME}.hermes.local" "http://127.0.0.1:${LOCAL_PORT}/secret-tester/verify" || true)"
python3 - "$TESTER_VERIFY" <<'PYEOF' || fail "secret-tester verify endpoint failed: $TESTER_VERIFY"
import json, sys
v = json.loads(sys.argv[1])
assert v["secretAvailable"] is True, v
payloads = {p["name"]: p["match"] for p in v["payloads"]}
assert payloads == {"expected": True, "control": False}, \
    f"two-payload semantics broken: {payloads}"
assert v["pass"] is True, v
print(f"  expected payload MATCH + control payload MISMATCH -> PASS (sha256 {v['actualSha256'][:12]}...)")
PYEOF
pass "secret-tester verified the live secret against the in-repo checksum (both payloads behaved)"

# ---------------------------------------------------------------------------
# Step 12m — monitoring end to end: the persona SHIPPED a dashboard and
# alerts (monitoring-chart ConfigMaps, picked up by the platform
# Grafana's sidecars), the visits threshold came from the per-instance
# Pulumi override, and every alert lands at the webhook sink (plus
# Discord, when DISCORD_WEBHOOK_URL was exported).
# ---------------------------------------------------------------------------
log "== step 12m: monitoring — dashboard ConfigMaps + Grafana alert loop =="

for cm in "hermes-${PERSONA_NAME}-monitoring-dashboard" "hermes-${PERSONA_NAME}-monitoring-alerts"; do
  "${KCTL[@]}" -n "$NAMESPACE" get configmap "$cm" >/dev/null || \
    fail "monitoring ConfigMap $cm not found (the monitoring chart did not render?)"
  ok "monitoring ConfigMap $cm exists"
done

# Gate BEFORE generating traffic: the alert rules must be live in Grafana
# (the sidecar imports them minutes after the ConfigMap lands) and
# Prometheus must already be scraping Traefik — otherwise the visits fall
# out of the 5m increase() window before the rule first evaluates
# (exactly how run 4 of this script failed).
log "-- 12m.0: waiting for Grafana rule import + Prometheus traefik scrape --"
wait_for "Grafana to import the profile's 3 alert rules" 600 grafana_rules_imported 3 || \
  fail "Grafana never imported the profile's alert rules (sidecar/provisioning broken?)"
ok "Grafana has the profile's alert rules"
wait_for "Prometheus to scrape traefik" 300 prometheus_scraping_traefik || \
  fail "Prometheus has no up traefik target (extraScrapeConfigs broken?)"
ok "Prometheus is scraping traefik"

log "-- 12m.1: sustained visits over threshold must fire SiteVisitsHigh --"
SINK_BASELINE="$(webhook_log_lines)"
# Prime the per-service counter FIRST: Traefik creates it lazily at the
# first request, and a burst that lands entirely inside one scrape
# interval on a brand-new series leaves Prometheus a flat series whose
# first sample already holds every visit - increase() = 0, forever
# (root-caused live; see prometheus_has_visit_series). One request + a
# confirmed scrape establishes the series...
curl -s -o /dev/null -H "Host: ${PERSONA_NAME}.hermes.local" "http://127.0.0.1:${LOCAL_PORT}/" || true
wait_for "the per-service traefik counter series to exist in Prometheus" 120 prometheus_has_visit_series || \
  fail "traefik's per-service counter never reached Prometheus (scrape config broken?)"
ok "per-service counter series established in Prometheus"
# ...and sustained traffic (1 visit / 2s - far over threshold
# ${VISITS_THRESHOLD}/5m) keeps the counter climbing across many scrapes,
# so EVERY alert evaluation window sees the traffic regardless of
# scrape/eval phase. Repro measured fire-to-sink at ~20s under this shape.
(
  while true; do
    curl -s -o /dev/null -H "Host: ${PERSONA_NAME}.hermes.local" "http://127.0.0.1:${LOCAL_PORT}/" || true
    sleep 2
  done
) &
TRAFFIC_PID=$!
ok "sustained visit traffic running (pid ${TRAFFIC_PID})"
wait_webhook_alert "SiteVisitsHigh (${PERSONA_NAME})" "$SINK_BASELINE" 420 || {
  kill "$TRAFFIC_PID" 2>/dev/null || true
  dump_monitoring_diagnostics
  tail -5 "$WEBHOOK_LOG" 2>/dev/null || true
  fail "SiteVisitsHigh did not reach the webhook sink within 420s of sustained over-threshold traffic"
}
kill "$TRAFFIC_PID" 2>/dev/null || true
wait "$TRAFFIC_PID" 2>/dev/null || true
pass "SiteVisitsHigh fired at the sink (threshold ${VISITS_THRESHOLD}/5m came from the Pulumi override)"

log "-- 12m.2: killing the agent pod must fire HermesAgentDown --"
# Settle first: on a cold cluster the KSM series lags and HermesAgentDown
# false-fires at rule-import time. If it is STILL firing when we take the
# baseline, the kill produces no new firing transition and the causal
# assertion below can never pass (run 8). Wait for the series, then for
# the false positive to clear (needs the 2m lookback to drain).
wait_for "the agent StatefulSet's KSM series in Prometheus" 300 prometheus_has_agent_series || \
  fail "kube-state-metrics never exposed the agent StatefulSet series"
wait_for "HermesAgentDown to settle to inactive" 600 grafana_rule_inactive "HermesAgentDown (${PERSONA_NAME})" || {
  dump_monitoring_diagnostics
  fail "HermesAgentDown never settled to inactive before the kill test"
}
ok "HermesAgentDown settled (install-time false positive cleared)"
SINK_BASELINE="$(webhook_log_lines)"
# THREE deletes 25s apart, not one: a single fast restart can slip
# between kube-state-metrics scrapes entirely (no 0 sample -> no alert —
# observed live). Holding readyReplicas at 0 for ~75s guarantees several
# scrapes see the outage regardless of restart speed.
for kill_round in 1 2 3; do
  "${KCTL[@]}" -n "$NAMESPACE" delete pod "hermes-${PERSONA_NAME}-0" --wait=false >/dev/null 2>&1 || true
  sleep 25
done
wait_webhook_alert "HermesAgentDown (${PERSONA_NAME})" "$SINK_BASELINE" 420 || {
  dump_monitoring_diagnostics
  tail -5 "$WEBHOOK_LOG" 2>/dev/null || true
  fail "HermesAgentDown did not reach the webhook sink within 420s of deleting the agent pod"
}
pass "HermesAgentDown fired at the sink after the agent pod was deleted"
wait_pod_ready "$NAMESPACE" "hermes-${PERSONA_NAME}-0" 300s
ok "agent pod recovered (StatefulSet controller restarted it)"

log "-- 12m.3: killing the site pod must fire AgentAppUnhealthy --"
# Same settle logic as 12m.2: a still-firing install-time state would
# swallow the new transition.
wait_for "AgentAppUnhealthy to settle to inactive" 600 grafana_rule_inactive "AgentAppUnhealthy (${PERSONA_NAME})" || {
  dump_monitoring_diagnostics
  fail "AgentAppUnhealthy never settled to inactive before the kill test"
}
ok "AgentAppUnhealthy settled"
SINK_BASELINE="$(webhook_log_lines)"
# Same sustained-outage treatment as the agent kill in 12m.2: the site
# pod rebuilds in seconds (local clone + sub-second mkdocs build), so a
# single delete's unavailability window can fit entirely between two 15s
# kube-state-metrics scrapes and no sample ever records it. Three
# deletes 25s apart hold unavailableReplicas > 0 across several scrapes.
for kill_round in 1 2 3; do
  "${KCTL[@]}" -n "$NAMESPACE" delete pod \
    -l "app.kubernetes.io/name=site,app.kubernetes.io/instance=hermes-${PERSONA_NAME}-site" \
    --wait=false >/dev/null 2>&1 || true
  sleep 25
done
wait_webhook_alert "AgentAppUnhealthy (${PERSONA_NAME})" "$SINK_BASELINE" 420 || {
  dump_monitoring_diagnostics
  tail -5 "$WEBHOOK_LOG" 2>/dev/null || true
  fail "AgentAppUnhealthy did not reach the webhook sink within 420s of deleting the site pod"
}
pass "AgentAppUnhealthy fired at the sink after the site pod was deleted"
wait_for "site deployment available again" 600 \
  "${KCTL[@]}" -n "$NAMESPACE" wait --for=condition=Available "deployment/hermes-${PERSONA_NAME}-site-site" --timeout=5s || \
  fail "site deployment did not recover after the pod kill"
ok "site deployment recovered"
pass "monitoring loop verified: dashboard shipped, visits/agent/app alerts all delivered"

kill "$PORT_FORWARD_PID" 2>/dev/null || true
wait "$PORT_FORWARD_PID" 2>/dev/null || true
PORT_FORWARD_PID=""

# ---------------------------------------------------------------------------
# Step 12b — backups: the persona declares spec.backup (schedule+retention)
# and cluster-values sets providers.backup=pvc, so the chart must have
# rendered the per-instance backups PVC + archive CronJob. Trigger the
# CronJob NOW (rather than waiting for its schedule) and assert a real
# archive landed.
# ---------------------------------------------------------------------------
log "== step 12b: verifying the backup path (PVC + CronJob) =="
"${KCTL[@]}" -n "$NAMESPACE" get pvc "hermes-${PERSONA_NAME}-backups" >/dev/null || \
  fail "backups PVC hermes-${PERSONA_NAME}-backups not found"
ok "backups PVC hermes-${PERSONA_NAME}-backups exists"
"${KCTL[@]}" -n "$NAMESPACE" get cronjob "hermes-${PERSONA_NAME}-backup" >/dev/null || \
  fail "backup CronJob hermes-${PERSONA_NAME}-backup not found"
ok "backup CronJob hermes-${PERSONA_NAME}-backup exists"

"${KCTL[@]}" -n "$NAMESPACE" create job --from="cronjob/hermes-${PERSONA_NAME}-backup" smoke-backup-now >/dev/null
"${KCTL[@]}" -n "$NAMESPACE" wait --for=condition=complete "job/smoke-backup-now" --timeout=180s >/dev/null || {
  "${KCTL[@]}" -n "$NAMESPACE" logs "job/smoke-backup-now" --tail=50 || true
  fail "backup job smoke-backup-now did not complete within 180s"
}
BACKUP_LOG="$("${KCTL[@]}" -n "$NAMESPACE" logs "job/smoke-backup-now" 2>/dev/null)"
grep -q "archive(s) retained" <<<"$BACKUP_LOG" || {
  echo "$BACKUP_LOG"
  fail "backup job log did not report a retained archive"
}
pass "backup CronJob produced a real archive on the backups PVC ($(echo "$BACKUP_LOG" | grep -o '[0-9]* archive(s) retained'))"
"${KCTL[@]}" -n "$NAMESPACE" delete job smoke-backup-now --wait=false >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Step 13 — update path: bump the persona-source repo (new commit/sha),
# re-install, assert the pod rolls to the new sha with its PVC preserved
# ---------------------------------------------------------------------------
log "== step 13: update path — bumping the persona distribution =="

OLD_POD_UID="$("${KCTL[@]}" -n "$NAMESPACE" get pod "hermes-${PERSONA_NAME}-0" -o jsonpath='{.metadata.uid}')"
OLD_PVC_NAME="data-hermes-${PERSONA_NAME}-0"
"${KCTL[@]}" -n "$NAMESPACE" get pvc "$OLD_PVC_NAME" >/dev/null 2>&1 || \
  fail "expected PVC $OLD_PVC_NAME not found before the bump"

# "PVC still exists" alone doesn't prove the *data on it* survived the roll
# (a fresh PVC of the same name would also pass that check). Write a
# nonce-bearing marker file onto the actual mounted volume
# (/opt/data — harness/hermes/charts/hermes-profile/templates/pod/statefulset.yaml's
# `data` volumeMount, both initContainer and main container) now, and read
# it back after the roll below — this proves the SAME underlying volume
# (not just a same-named PVC object) is still mounted post-roll.
MARKER_DIR="/opt/data/.hermes-gitops"
MARKER_FILE="${MARKER_DIR}/smoke-marker"
MARKER_NONCE="smoke-$(date -u +%s)-${RANDOM}-$$"
"${KCTL[@]}" -n "$NAMESPACE" exec "hermes-${PERSONA_NAME}-0" -c hermes-agent -- \
  sh -c "mkdir -p '$MARKER_DIR' && printf '%s' '$MARKER_NONCE' > '$MARKER_FILE'" || \
  fail "failed to write PVC data marker $MARKER_FILE before the bump"
WRITTEN_BACK="$("${KCTL[@]}" -n "$NAMESPACE" exec "hermes-${PERSONA_NAME}-0" -c hermes-agent -- cat "$MARKER_FILE" 2>/dev/null || true)"
[[ "$WRITTEN_BACK" == "$MARKER_NONCE" ]] || \
  fail "PVC data marker $MARKER_FILE did not read back correctly right after writing it (got: ${WRITTEN_BACK:-<empty>})"
ok "wrote PVC data marker $MARKER_FILE (nonce ${MARKER_NONCE})"

BUMP_DIR="$WORKDIR/persona-bump"
# Operate on the bare mirror directly via its filesystem path (not over
# http://) — dumb HTTP is read-only, so this is the only way to add a
# commit to the SAME repo the pod fetches over http:// (see header comment).
git clone --quiet "$WORKDIR/serve/persona-source.git" "$BUMP_DIR"
{
  echo ""
  echo "<!-- smoke-local bump marker: $(date -u +%FT%TZ) -->"
} >>"$BUMP_DIR/.hermes-dist/distribution-agent/SOUL.md"
git -C "$BUMP_DIR" -c user.email=smoke@hermes-gitops.local -c user.name=smoke-local \
  commit --quiet -am "smoke-local: bump marker for update-path verification"
git -C "$BUMP_DIR" push --quiet origin "HEAD:refs/heads/${SOURCE_BRANCH}"
git -C "$WORKDIR/serve/persona-source.git" update-server-info
NEW_SHA="$(git -C "$WORKDIR/serve/persona-source.git" rev-parse HEAD)"
[[ "$NEW_SHA" != "$PERSONA_SHA" ]] || fail "bump did not produce a new commit sha"
ok "persona-source mirror bumped: ${PERSONA_SHA:0:12} -> ${NEW_SHA:0:12}"

# Re-run the exact install agents.py's stage 2 Command would run (same env,
# same shape) directly — the brief permits either pulumi or a direct call;
# doing it directly sidesteps agents.py's own trigger-gated caching (its
# Pulumi Command only re-runs when agent.source/ref/name/workloads/overrides
# themselves change, none of which change here — only the content the
# UNCHANGED source URL now resolves to).
(
  export PATH="${UV_TOOL_BIN_DIR}:$PATH"
  export HERMES_HOME="$WORKDIR/hermes-home"
  export HERMES_GITOPS_REQUIRE_EMITTER=1
  export GITOPS_GIT_TOKEN="smoke-local-dummy-token"
  # #$SOURCE_BRANCH pin: see the same-shaped comment on agents[0].ref above
  # (stage 2) — required so the fork's clone falls back to a full (not
  # shallow) clone over dumb http instead of hard-failing.
  # --subdir mirrors bootstrap_stage12's agents[0].subdir (the payload lives
  # under .hermes-dist/distribution-agent/, NOT the repo root — omitting it
  # fails with "No distribution.yaml at the root").
  hermes profile install "$PERSONA_URL#$SOURCE_BRANCH" --name "$PERSONA_NAME" \
    --subdir ".hermes-dist/distribution-agent" --force -y
)
pass "hermes profile install re-run against the bumped source (sha ${NEW_SHA:0:12})"

GITOPS_CHECK2="$WORKDIR/gitops-check2"
git clone --quiet "$GITOPS_URL" "$GITOPS_CHECK2"
grep -q "sha: $NEW_SHA" "$GITOPS_CHECK2/profiles/${PERSONA_NAME}/profile.yaml" || \
  fail "pushed profile.yaml does not contain the bumped sha $NEW_SHA"
pass "pushed profile.yaml reflects the bumped sha"

"${KCTL[@]}" -n argocd annotate application "$APP_NAME" argocd.argoproj.io/refresh=hard --overwrite >/dev/null

log "== waiting for the running StatefulSet to pick up the new sha (profile checksum annotation) =="
waited=0
timeout=300
CURRENT_SHA=""
while (( waited < timeout )); do
  CURRENT_SHA="$("${KCTL[@]}" -n "$NAMESPACE" get statefulset "hermes-${PERSONA_NAME}" -o jsonpath='{.spec.template.spec.initContainers[0].env[?(@.name=="HERMES_DIST_SHA")].value}' 2>/dev/null || true)"
  if [[ "$CURRENT_SHA" == "$NEW_SHA" ]]; then
    break
  fi
  sleep 5
  waited=$((waited + 5))
  if (( waited % 30 == 0 )); then
    log "   ...statefulset HERMES_DIST_SHA=${CURRENT_SHA:-<none>} (${waited}s/${timeout}s)"
  fi
done
[[ "$CURRENT_SHA" == "$NEW_SHA" ]] || fail "HermesProfile ${PERSONA_NAME}'s spec.sha never reached $NEW_SHA (last: ${CURRENT_SHA:-<none>})"
pass "HermesProfile CR spec.sha rolled to the bumped sha"

log "== waiting for the pod to roll (new UID) and become Ready again =="
waited=0
NEW_POD_UID=""
while (( waited < timeout )); do
  NEW_POD_UID="$("${KCTL[@]}" -n "$NAMESPACE" get pod "hermes-${PERSONA_NAME}-0" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
  if [[ -n "$NEW_POD_UID" && "$NEW_POD_UID" != "$OLD_POD_UID" ]]; then
    break
  fi
  sleep 5
  waited=$((waited + 5))
done
[[ -n "$NEW_POD_UID" && "$NEW_POD_UID" != "$OLD_POD_UID" ]] || \
  fail "pod hermes-${PERSONA_NAME}-0 never rolled to a new UID after the bump (still ${OLD_POD_UID})"
"${KCTL[@]}" -n "$NAMESPACE" wait --for=condition=Ready "pod/hermes-${PERSONA_NAME}-0" --timeout=300s || \
  fail "rolled pod hermes-${PERSONA_NAME}-0 did not become Ready within 300s"
pass "pod rolled (uid ${OLD_POD_UID:0:8} -> ${NEW_POD_UID:0:8}) and is Ready again"

"${KCTL[@]}" -n "$NAMESPACE" get pvc "$OLD_PVC_NAME" >/dev/null 2>&1 || \
  fail "PVC $OLD_PVC_NAME no longer exists after the roll — state was NOT preserved"

# Real data test, not just a name check: read the marker written onto
# /opt/data before the bump back from the ROLLED pod and assert the nonce
# still matches — proves the same underlying volume (not merely a
# same-named PVC object) survived the roll.
ROLLED_MARKER="$("${KCTL[@]}" -n "$NAMESPACE" exec "hermes-${PERSONA_NAME}-0" -c hermes-agent -- cat "$MARKER_FILE" 2>/dev/null || true)"
if [[ -z "$ROLLED_MARKER" ]]; then
  fail "PVC $OLD_PVC_NAME data marker $MARKER_FILE missing after the roll — state was NOT preserved"
elif [[ "$ROLLED_MARKER" != "$MARKER_NONCE" ]]; then
  fail "PVC $OLD_PVC_NAME data marker $MARKER_FILE mismatch after the roll (expected ${MARKER_NONCE}, got ${ROLLED_MARKER}) — state was NOT preserved"
fi
pass "PVC $OLD_PVC_NAME preserved across the roll (data marker nonce ${MARKER_NONCE} verified intact)"

# ---------------------------------------------------------------------------
# SMOKE_KEEP=1 — stop BEFORE the decommission test and leave everything
# running (cluster, git servers, stack, the deployed app), so an operator
# can actually visit the site the loop just deployed. The cleanup trap
# honors the same flag.
# ---------------------------------------------------------------------------
if [[ "${SMOKE_KEEP:-0}" == "1" ]]; then
  echo
  echo "=========================================================="
  echo "PASS: Hermes GitOps loop verified; SMOKE_KEEP=1 - leaving it running"
  echo "  cluster:   k3d '${CLUSTER_NAME}' (delete: infra/scripts/dev-cluster.sh down)"
  echo "  namespace: ${NAMESPACE}"
  echo "  visit:     kubectl -n kube-system port-forward svc/traefik <port>:80"
  echo "             then browse http://127.0.0.1:<port>/ with Host: ${PERSONA_NAME}.hermes.local"
  echo "  workdir:   ${WORKDIR} (git servers keep running from here)"
  echo "=========================================================="
  trap - EXIT
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 14 — teardown path: remove profiles/<name> from the GitOps repo
# directly (simulating decommission), assert the Application is pruned
# ---------------------------------------------------------------------------
log "== step 14: decommissioning ${PERSONA_NAME} (direct git rm) =="
GITOPS_CHECK3="$WORKDIR/gitops-check3"
git clone --quiet "$GITOPS_URL" "$GITOPS_CHECK3"
git -C "$GITOPS_CHECK3" rm -rq "profiles/${PERSONA_NAME}"
git -C "$GITOPS_CHECK3" -c user.email=smoke@hermes-gitops.local -c user.name=smoke-local \
  commit --quiet -m "smoke-local: decommission ${PERSONA_NAME}"
git -C "$GITOPS_CHECK3" push --quiet origin HEAD:refs/heads/main
pass "profiles/${PERSONA_NAME}/ removed from the GitOps repo"

# Nudge the ApplicationSet's git generator to notice the removed file
# immediately rather than waiting out its normal requeue interval.
"${KCTL[@]}" -n argocd annotate applicationset hermes-gitops-profiles \
  argocd.argoproj.io/application-set-refresh=true --overwrite >/dev/null 2>&1 || true

log "== waiting for Application ${APP_NAME} to be pruned =="
waited=0
timeout=300
while (( waited < timeout )); do
  if ! "${KCTL[@]}" -n argocd get application "$APP_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 5
  waited=$((waited + 5))
  if (( waited % 30 == 0 )); then
    log "   ...Application ${APP_NAME} still present (${waited}s/${timeout}s)"
  fi
done
if "${KCTL[@]}" -n argocd get application "$APP_NAME" >/dev/null 2>&1; then
  fail "Application ${APP_NAME} was not pruned within ${timeout}s of removing profiles/${PERSONA_NAME}/"
fi
pass "Application ${APP_NAME} pruned"

# NOTE: Argo CD's `CreateNamespace=true` sync option is a first-sync
# convenience — it does NOT mark the namespace as an Application-managed
# resource, so pruning the Application does not delete the namespace it
# created (confirmed live: the namespace stays plain `Active`, never even
# enters `Terminating`, after the Application above is pruned). This is
# documented Argo CD behavior, not a bug, so this is a best-effort
# informational check only — a persisting namespace here is expected, not
# a failure signal; cluster teardown (this script's trap) reclaims it
# either way.
log "== checking namespace ${NAMESPACE} (informational only — see note above) =="
if "${KCTL[@]}" get namespace "$NAMESPACE" >/dev/null 2>&1; then
  log "note: namespace ${NAMESPACE} still exists (expected — Argo CD's CreateNamespace=true does not prune it); cluster teardown reclaims it regardless"
else
  pass "namespace ${NAMESPACE} pruned"
fi

echo
echo "All steps passed. Tearing down (trap) ..."
