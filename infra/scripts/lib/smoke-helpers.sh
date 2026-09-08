#!/usr/bin/env bash
# Shared helpers for infra/scripts/smoke-local.sh and
# infra/scripts/test-drift-and-decommission.sh: both scripts stand up the exact
# same disposable environment (k3d cluster, two local git servers, stages
# 1-2-3 of the bootstrap Pulumi program, the "hermes-gitops-test" persona
# from THIS repo's own .hermes-dist/distribution-agent/ payload) before diverging into their own
# assertions (happy-path full loop vs. drift/decommission hardening). This
# file holds the setup/wait/teardown pieces that are byte-identical between
# them so neither script duplicates them - see Task 10's report for why
# this was extracted rather than left inline a second time.
#
# Meant to be `source`d, not executed. The sourcing script owns `set -euo
# pipefail`, its own trap, and the global variables documented on each
# function below (matching smoke-local.sh's original names so callers stay
# close to a plain function-call replacement of what used to be inline).
#
# Every function that can fail calls `fail`, which prints "FAIL: ..." and
# exits the whole script non-zero (matching smoke-local.sh's original
# fail-fast behavior) - callers do not need their own `|| fail ...` wrapper
# around these calls (though a few still add one for a more specific
# message at the call site).

SMOKE_LOG_PREFIX="${SMOKE_LOG_PREFIX:-smoke}"

log() { echo "[${SMOKE_LOG_PREFIX}] $*" >&2; }
ok() { echo "OK   $*"; }
pass() { echo "PASS: $*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# preflight_checks - verifies every required binary is on PATH, docker is
# reachable, and $HERMES_FORK_PATH points at a real checkout. Normalizes
# HERMES_FORK_PATH to an absolute path (same variable, updated in place -
# relies on bash's dynamic scoping for a var the caller already declared,
# same as the pre-extraction inline version did).
# ---------------------------------------------------------------------------
preflight_checks() {
  for bin in pulumi uv git python3 docker kubectl bun; do
    command -v "$bin" >/dev/null 2>&1 || fail "$bin not found on PATH"
  done
  if [[ ! -f "$HERMES_FORK_PATH/pyproject.toml" ]]; then
    fail "no pyproject.toml at HERMES_FORK_PATH=$HERMES_FORK_PATH (set HERMES_FORK_PATH to a checkout of hermes-agent-gitops)"
  fi
  HERMES_FORK_PATH="$(cd "$HERMES_FORK_PATH" && pwd)"
  docker info >/dev/null 2>&1 || fail "docker is not reachable (is the daemon running?)"
}

find_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("0.0.0.0", 0)); print(s.getsockname()[1]); s.close()'
}

# ---------------------------------------------------------------------------
# wait_for <description> <timeout-seconds> <command...> - polls a command
# every 5s until it exits 0 or the timeout elapses. Returns non-zero (does
# NOT call fail itself) so callers can attach their own failure message.
# ---------------------------------------------------------------------------
wait_for() {
  local desc="$1" timeout="$2"
  shift 2
  local waited=0
  while (( waited < timeout )); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
    if (( waited % 30 == 0 )); then
      log "   ...still waiting for: $desc (${waited}s/${timeout}s)"
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# start_git_servers - the two local git servers described in
# smoke-local.sh's header comment (writable git:// GitOps repo, read-only
# dumb-http:// persona/chart source mirror of $REPO_ROOT), reachable from
# both host and k3d pods via the k3d network's docker bridge gateway IP.
#
# Requires (caller-set globals): WORKDIR, REPO_ROOT, K3D_NETWORK
# Sets (globals): GIT_DAEMON_PID, HTTP_SERVER_PID, SOURCE_BRANCH,
#   GATEWAY_IP, GITOPS_URL, PERSONA_URL, PERSONA_SHA
# ---------------------------------------------------------------------------
start_git_servers() {
  git init --quiet --bare -b main "$WORKDIR/serve/gitops.git"

  git clone --quiet --bare "$REPO_ROOT" "$WORKDIR/serve/persona-source.git"
  SOURCE_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  git -C "$WORKDIR/serve/persona-source.git" symbolic-ref HEAD "refs/heads/$SOURCE_BRANCH"
  git -C "$WORKDIR/serve/persona-source.git" update-server-info

  local git_daemon_port http_port
  git_daemon_port="$(find_free_port)"
  http_port="$(find_free_port)"

  nohup git daemon --base-path="$WORKDIR/serve" --export-all --enable=receive-pack \
    --port="$git_daemon_port" --reuseaddr >"$WORKDIR/git-daemon.log" 2>&1 <"/dev/null" &
  GIT_DAEMON_PID=$!
  disown

  nohup python3 -m http.server "$http_port" --bind 0.0.0.0 --directory "$WORKDIR/serve" \
    >"$WORKDIR/http-server.log" 2>&1 <"/dev/null" &
  HTTP_SERVER_PID=$!
  disown

  sleep 1
  kill -0 "$GIT_DAEMON_PID" 2>/dev/null || fail "git daemon failed to start (see $WORKDIR/git-daemon.log)"
  kill -0 "$HTTP_SERVER_PID" 2>/dev/null || fail "http.server failed to start (see $WORKDIR/http-server.log)"

  GATEWAY_IP="$(docker network inspect "$K3D_NETWORK" --format '{{(index .IPAM.Config 0).Gateway}}')"
  [[ -n "$GATEWAY_IP" ]] || fail "could not determine docker network gateway IP for $K3D_NETWORK"
  log "docker bridge gateway IP (reachable from both host and k3d pods): $GATEWAY_IP"

  GITOPS_URL="git://${GATEWAY_IP}:${git_daemon_port}/gitops.git"
  PERSONA_URL="http://${GATEWAY_IP}:${http_port}/persona-source.git"
  PERSONA_SHA="$(git -C "$WORKDIR/serve/persona-source.git" rev-parse HEAD)"

  pass "git daemon (push+pull) serving GitOps repo at $GITOPS_URL"
  pass "dumb-http server (read-only) serving persona-source mirror at $PERSONA_URL @ ${PERSONA_SHA:0:12}"
}

# ---------------------------------------------------------------------------
# start_webhook_sink - the local stand-in for the operator's real alert
# receiver (a GitHub dispatch proxy, Discord, ...): a stdlib-only HTTP
# server (lib/webhook-sink.py) that appends every request it receives to
# $WORKDIR/webhook-hits.jsonl, bound to 0.0.0.0 so the docker bridge
# gateway IP makes it reachable from the in-cluster Grafana. Must run
# AFTER start_git_servers (needs GATEWAY_IP).
#
# Requires (caller-set globals): WORKDIR, REPO_ROOT, GATEWAY_IP
# Sets (globals): WEBHOOK_SINK_PID, WEBHOOK_SINK_URL, WEBHOOK_LOG
# ---------------------------------------------------------------------------
start_webhook_sink() {
  local sink_port
  sink_port="$(find_free_port)"
  WEBHOOK_LOG="$WORKDIR/webhook-hits.jsonl"
  nohup python3 "$REPO_ROOT/infra/scripts/lib/webhook-sink.py" "$sink_port" "$WEBHOOK_LOG" \
    >"$WORKDIR/webhook-sink.log" 2>&1 <"/dev/null" &
  WEBHOOK_SINK_PID=$!
  disown
  sleep 1
  kill -0 "$WEBHOOK_SINK_PID" 2>/dev/null || fail "webhook sink failed to start (see $WORKDIR/webhook-sink.log)"
  WEBHOOK_SINK_URL="http://${GATEWAY_IP}:${sink_port}/github-webhook"
  pass "webhook sink (Grafana alert receiver stand-in) at $WEBHOOK_SINK_URL"
}

# ---------------------------------------------------------------------------
# webhook_log_lines - current number of entries in the sink log (0 if the
# file doesn't exist yet). Used to assert CAUSAL alert delivery: take a
# count before triggering a condition, then require a matching entry
# AFTER that line — install-time firings (e.g. AgentDown while the
# agent boots the very first time) can't satisfy the assertion.
# ---------------------------------------------------------------------------
webhook_log_lines() {
  [[ -f "$WEBHOOK_LOG" ]] && wc -l <"$WEBHOOK_LOG" || echo 0
}

# ---------------------------------------------------------------------------
# wait_webhook_alert <alertname> <since-line> [timeout-seconds, default 420]
# - polls the sink log until an entry AFTER <since-line> carries ANY
# notification (firing OR resolved) for <alertname> (Grafana webhook
# payload shape: {"alerts": [{"status", "labels": {"alertname"}}, ...]}).
#
# ANY status, deliberately: the causal contract comes from the caller's
# baseline (taken after the settle gates prove the rule inactive), so any
# NEW notification for the alertname is caused by the triggered
# condition. Requiring specifically "firing" lost a real, kill-caused
# alert cycle once (run 10): the firing flush was swallowed by an
# alertmanager state-reset race and only the resolved notification
# reached the sink - the alert cycle happened and delivered, which is
# exactly what the e2e asserts.
# Returns non-zero on timeout (callers attach their own fail message).
# ---------------------------------------------------------------------------
wait_webhook_alert() {
  local alertname="$1" since="$2" timeout="${3:-420}"
  local waited=0
  while (( waited < timeout )); do
    if python3 - "$WEBHOOK_LOG" "$alertname" "$since" <<'PYEOF'
import json, sys
path, alertname, since = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    lines = open(path, encoding="utf-8").read().splitlines()
except FileNotFoundError:
    sys.exit(1)
for line in lines[since:]:
    try:
        body = json.loads(line).get("body")
    except json.JSONDecodeError:
        continue
    if not isinstance(body, dict):
        continue
    for alert in body.get("alerts") or []:
        if alert.get("labels", {}).get("alertname") == alertname:
            sys.exit(0)
sys.exit(1)
PYEOF
    then
      return 0
    fi
    sleep 10
    waited=$((waited + 10))
    if (( waited % 60 == 0 )); then
      log "   ...still waiting for a '${alertname}' notification at the webhook sink (${waited}s/${timeout}s)"
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# grafana_rules_imported <count> - true once Grafana's provisioning API
# reports at least <count> alert rules. The alerts sidecar imports the
# profile's ConfigMap on its own cycle, MINUTES after the ConfigMap
# exists (observed live: ~6min on a cold cluster) - callers must gate on
# this before generating the traffic an alert is supposed to catch, or
# the increase() window slides past the visits before the rule ever
# evaluates. Requires: KCTL.
# ---------------------------------------------------------------------------
# The Grafana admin password comes from the monitoring-grafana-admin
# Secret (ADR-45; the committed literal is gone). Lazily read, cached.
GRAFANA_PW=""
grafana_pw() {
  if [[ -z "$GRAFANA_PW" ]]; then
    GRAFANA_PW="$("${KCTL[@]}" -n hermes-monitoring get secret monitoring-grafana-admin \
      -o jsonpath='{.data.admin-password}' 2>/dev/null | base64 -d || true)"
  fi
  [[ -n "$GRAFANA_PW" ]] || fail "monitoring-grafana-admin Secret missing - the bootstrap creates it"
}

grafana_rules_imported() {
  local want="$1" n
  grafana_pw
  n="$("${KCTL[@]}" -n hermes-monitoring exec deploy/monitoring-grafana -c grafana -- \
    sh -c "wget -qO- http://admin:${GRAFANA_PW}@127.0.0.1:3000/api/v1/provisioning/alert-rules" 2>/dev/null \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  [[ "$n" -ge "$want" ]]
}

# ---------------------------------------------------------------------------
# prometheus_scraping_traefik - true once Prometheus reports an up traefik
# target (counter samples exist, so increase() can see new visits).
# Requires: KCTL.
# ---------------------------------------------------------------------------
prometheus_scraping_traefik() {
  "${KCTL[@]}" -n hermes-monitoring exec deploy/monitoring-grafana -c grafana -- \
    wget -qO- 'http://monitoring-prometheus.hermes-monitoring.svc:9090/api/v1/query?query=up{job="traefik"}==1' 2>/dev/null \
    | grep -q '"value"'
}

# ---------------------------------------------------------------------------
# prometheus_has_visit_series - true once Prometheus holds the profile's
# per-service traefik counter series. Traefik creates that counter LAZILY
# at the first request, and a series whose first sample already contains
# all the test's visits is flat forever - increase() = 0, alert never
# fires (root-caused live: run 6 + an isolated repro). Callers prime the
# counter with one request, wait for this, and only then generate the
# traffic the alert must catch. Requires: KCTL, NAMESPACE.
# ---------------------------------------------------------------------------
prometheus_has_visit_series() {
  "${KCTL[@]}" -n hermes-monitoring exec deploy/monitoring-grafana -c grafana -- \
    wget -qO- --post-data "query=traefik_service_requests_total{service=~\"${NAMESPACE}-.*@kubernetes\"}" \
    http://monitoring-prometheus.hermes-monitoring.svc:9090/api/v1/query 2>/dev/null | grep -q '"service"'
}

# ---------------------------------------------------------------------------
# prometheus_has_agent_series - true once Prometheus holds the agent
# StatefulSet's kube-state-metrics ready-replicas series. On a cold
# cluster that series can lag several minutes; until it exists the
# AgentDown rule sees vector(0) and false-fires at import time.
# Requires: KCTL, NAMESPACE.
# ---------------------------------------------------------------------------
prometheus_has_agent_series() {
  "${KCTL[@]}" -n hermes-monitoring exec deploy/monitoring-grafana -c grafana -- \
    wget -qO- --post-data "query=kube_statefulset_status_replicas_ready{namespace=\"${NAMESPACE}\",statefulset=\"${NAMESPACE}\"}" \
    http://monitoring-prometheus.hermes-monitoring.svc:9090/api/v1/query 2>/dev/null | grep -q '"statefulset"'
}

# ---------------------------------------------------------------------------
# grafana_rule_inactive <rule-title> - true when the named rule's current
# state is "inactive". The kill-the-pod steps take a sink baseline and
# then assert a NEW firing after it - if the rule is still firing from
# the install-time false positive (KSM series lag), the kill produces no
# new transition and the causal assertion can never pass (run 8).
# Requires: KCTL.
# ---------------------------------------------------------------------------
grafana_rule_inactive() {
  local title="$1" state
  grafana_pw
  state="$("${KCTL[@]}" -n hermes-monitoring exec deploy/monitoring-grafana -c grafana -- \
    sh -c "wget -qO- 'http://admin:${GRAFANA_PW}@127.0.0.1:3000/api/prometheus/grafana/api/v1/rules'" 2>/dev/null \
    | python3 -c '
import json, sys
title = sys.argv[1]
d = json.load(sys.stdin)
for g in d.get("data", {}).get("groups", []):
    for r in g.get("rules", []):
        if r.get("name") == title:
            print(r.get("state"))
' "$title" 2>/dev/null || true)"
  [[ "$state" == "inactive" ]]
}

# ---------------------------------------------------------------------------
# dump_monitoring_diagnostics - forensic dump for a failed alert wait,
# printed BEFORE cleanup destroys the cluster: every Grafana rule's
# state/health/lastError plus the raw traefik counter series Prometheus
# holds. Best-effort; never fails. Requires: KCTL.
# ---------------------------------------------------------------------------
dump_monitoring_diagnostics() {
  local rules_json
  grafana_pw || true
  log "-- monitoring diagnostics (grafana rule states) --"
  rules_json="$("${KCTL[@]}" -n hermes-monitoring exec deploy/monitoring-grafana -c grafana -- \
    sh -c "wget -qO- 'http://admin:${GRAFANA_PW}@127.0.0.1:3000/api/prometheus/grafana/api/v1/rules'" 2>/dev/null || true)"
  python3 - "$rules_json" <<'PYEOF' || true
import json, sys
try:
    d = json.loads(sys.argv[1])
except (ValueError, IndexError):
    print("  (no rules JSON available)")
    raise SystemExit(0)
for g in d.get("data", {}).get("groups", []):
    for r in g.get("rules", []):
        print("  ", r.get("name"), "| state:", r.get("state"),
              "| health:", r.get("health"),
              "| lastError:", str(r.get("lastError"))[:300])
PYEOF
  log "-- monitoring diagnostics (traefik counter series) --"
  "${KCTL[@]}" -n hermes-monitoring exec deploy/monitoring-grafana -c grafana -- \
    wget -qO- "http://monitoring-prometheus.hermes-monitoring.svc:9090/api/v1/query?query=traefik_service_requests_total" 2>/dev/null \
    | head -c 2000 || true
  echo
  log "-- monitoring diagnostics (grafana alerting log tail) --"
  "${KCTL[@]}" -n hermes-monitoring logs deploy/monitoring-grafana -c grafana --tail 400 2>/dev/null \
    | grep -iE "ngalert|alertmanager|notify" | tail -30 || true
}

# ---------------------------------------------------------------------------
# bootstrap_stage12 - pulumi stack init/select + config + `pulumi up` for
# stages 1-2 (real fork Hermes + gitops-emitter plugin install, real
# `hermes profile install` of the persona named $PERSONA_NAME from
# $PERSONA_URL).
#
# Requires (caller-set globals): BOOTSTRAP_DIR, WORKDIR, STACK_NAME,
#   HERMES_FORK_PATH, GITOPS_URL, PERSONA_URL, PERSONA_SHA, SOURCE_BRANCH,
#   PERSONA_NAME
# Sets (exported env, for reuse by later direct `hermes` CLI calls):
#   PULUMI_CONFIG_PASSPHRASE, PULUMI_BACKEND_URL, HERMES_HOME,
#   UV_TOOL_DIR, UV_TOOL_BIN_DIR
# ---------------------------------------------------------------------------
bootstrap_stage12() {
  export PULUMI_CONFIG_PASSPHRASE=""
  export PULUMI_BACKEND_URL="file://$WORKDIR/pulumi-backend"
  export HERMES_HOME="$WORKDIR/hermes-home"
  export UV_TOOL_DIR="$WORKDIR/uv-tools"
  export UV_TOOL_BIN_DIR="$WORKDIR/uv-bin"

  cd "$BOOTSTRAP_DIR"
  # infra/ is a bun/TypeScript Pulumi program - make sure node_modules
  # exists before the first pulumi invocation.
  bun install --frozen-lockfile >/dev/null
  pulumi stack init "$STACK_NAME"
  pulumi stack select "$STACK_NAME"

  pulumi config set --path hermes-gitops-bootstrap:providers.compute pod
  pulumi config set --path hermes-gitops-bootstrap:providers.secret k8s
  pulumi config set --path hermes-gitops-bootstrap:providers.ingress ingress
  pulumi config set --path hermes-gitops-bootstrap:stages.cluster false
  pulumi config set --path hermes-gitops-bootstrap:hermes.source "$HERMES_FORK_PATH"
  pulumi config set --path hermes-gitops-bootstrap:gitopsRepoUrl "$GITOPS_URL"
  pulumi config set --secret --path hermes-gitops-bootstrap:gitopsGitToken "smoke-local-dummy-token"
  pulumi config set --path hermes-gitops-bootstrap:hermesGitopsRepoUrl "$PERSONA_URL"
  pulumi config set --path hermes-gitops-bootstrap:chartRevision "$PERSONA_SHA"
  pulumi config set --path hermes-gitops-bootstrap:agents[0].source "$PERSONA_URL"
  # ref is NOT optional here despite HEAD being unambiguous without it - see
  # smoke-local.sh's inline comment on this same config key (dumb-http +
  # shallow-clone incompatibility in the fork's `_git_clone`).
  pulumi config set --path hermes-gitops-bootstrap:agents[0].ref "$SOURCE_BRANCH"
  # This repo's own persona payload lives in a subdirectory (the fork's
  # --subdir install form): .hermes-dist/distribution-agent/
  pulumi config set --path hermes-gitops-bootstrap:agents[0].subdir ".hermes-dist/distribution-agent"
  pulumi config set --path hermes-gitops-bootstrap:agents[0].name "$PERSONA_NAME"

  # The persona's distribution.yaml declares env_requires: [SMOKE_DEMO_SECRET]
  # — without this stack config the install fails loudly at stage 2 (the
  # emitter's available-secrets check), and WITH it the agent-secrets
  # component writes Secret hermes-<name>-env that the chart envFrom-injects
  # into the agent pod (asserted live in smoke-local.sh).
  pulumi config set --secret --path "hermes-gitops-bootstrap:agentSecrets.${PERSONA_NAME}.SMOKE_DEMO_SECRET" "$SMOKE_DEMO_SECRET_VALUE"

  # The secret-tester app verifies the DELIVERED secret against a
  # checksum that lives in git — supply the checksum of this run's demo
  # secret (the secret itself only ever exists in agentSecrets above).
  # --plaintext: a long hex digest trips pulumi's looks-like-a-secret
  # heuristic, but a CHECKSUM is exactly the thing that is safe (and
  # meant) to store in the clear.
  pulumi config set --plaintext --path "hermes-gitops-bootstrap:agents[0].overrides.appValues.secret-tester.expectedSha256" \
    "$(printf %s "$SMOKE_DEMO_SECRET_VALUE" | sha256sum | cut -d' ' -f1)"

  # The site app (examples/charts/site) builds the docs site from a clone of the
  # distribution source repo — point it at THIS run's local mirror (the
  # committed default is the public GitHub URL, unreachable/wrong here).
  pulumi config set --path "hermes-gitops-bootstrap:agents[0].overrides.appValues.site.source.repoUrl" "$PERSONA_URL"
  pulumi config set --path "hermes-gitops-bootstrap:agents[0].overrides.appValues.site.source.ref" "$PERSONA_SHA"

  # Per-instance overrides for the persona's `monitoring` app
  # (control-plane/monitoring/chart) — THE operator channel for alert tuning:
  #   - webhookUrl satisfies the app's valuesRequired (alerts need a
  #     receiver; here it's this run's local sink);
  #   - the visits threshold overrides the author default (100) down to
  #     $VISITS_THRESHOLD so a handful of curls can trip it;
  #   - fast health-rule evaluation so the kill-the-pod step proves
  #     AgentDown/AgentAppUnhealthy in seconds, not minutes.
  pulumi config set --path "hermes-gitops-bootstrap:agents[0].overrides.appValues.monitoring.alert.webhookUrl" "$WEBHOOK_SINK_URL"
  pulumi config set --path "hermes-gitops-bootstrap:agents[0].overrides.appValues.monitoring.alert.siteVisits5m.threshold" "$VISITS_THRESHOLD"
  pulumi config set --path "hermes-gitops-bootstrap:agents[0].overrides.appValues.monitoring.alert.evaluationInterval" "30s"
  pulumi config set --path "hermes-gitops-bootstrap:agents[0].overrides.appValues.monitoring.alert.health.pendingFor" "0s"

  pulumi up --yes
}

# ---------------------------------------------------------------------------
# bootstrap_stage3 - flips stages.cluster on and runs `pulumi up` against
# the k3d kubeconfig context. Requires (caller-set globals): CLUSTER_NAME.
# Caller must `cd "$BOOTSTRAP_DIR"` first if not already there
# (bootstrap_stage12 already leaves the shell there).
# ---------------------------------------------------------------------------
bootstrap_stage3() {
  pulumi config set --path hermes-gitops-bootstrap:stages.cluster true
  pulumi config set --path hermes-gitops-bootstrap:kubeconfigContext "k3d-${CLUSTER_NAME}"
  pulumi up --yes
}

# ---------------------------------------------------------------------------
# import_local_image <repo> <tag> <cluster-name> - imports a local docker
# image into the k3d cluster's containerd, failing loudly if the image
# doesn't exist locally yet.
# ---------------------------------------------------------------------------
import_local_image() {
  local repo="$1" tag="$2" cluster="$3"
  docker image inspect "${repo}:${tag}" >/dev/null 2>&1 || \
    fail "${repo}:${tag} not found in the local docker daemon — build it first (see Task 8)"
  k3d image import "${repo}:${tag}" -c "$cluster"
}

# ---------------------------------------------------------------------------
# pin_cluster_values_image <gitops-checkout-dir> <repo> <tag> - edits the
# scaffolded bootstrap/values/cluster-values.yaml in an already-cloned
# GitOps checkout to point image.repository/image.tag at a local build,
# then commits and pushes it to `main`. See smoke-local.sh's inline comment
# (step 5) for why this is the sanctioned post-scaffold operator workflow,
# not a bootstrap/emitter/chart change.
# ---------------------------------------------------------------------------
pin_cluster_values_image() {
  local dir="$1" repo="$2" tag="$3"
  uv run --with pyyaml python3 - "$dir/bootstrap/values/cluster-values.yaml" "$repo" "$tag" <<'PYEOF'
import sys
import yaml

path, repo, tag = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as f:
    data = yaml.safe_load(f)
data.setdefault("image", {})
data["image"]["repository"] = repo
data["image"]["tag"] = tag
with open(path, "w", encoding="utf-8") as f:
    yaml.safe_dump(data, f, sort_keys=False, default_flow_style=False)
PYEOF

  git -C "$dir" -c user.email=smoke@hermes-gitops.local -c user.name=smoke-local \
    add bootstrap/values/cluster-values.yaml
  git -C "$dir" -c user.email=smoke@hermes-gitops.local -c user.name=smoke-local \
    commit --quiet -m "smoke-local: point image at local ${repo}:${tag} build"
  git -C "$dir" push --quiet origin HEAD:refs/heads/main
}

# ---------------------------------------------------------------------------
# app_status <app-name> - echoes "<sync-status> <health-status>" for an
# Argo CD Application in the argocd namespace (empty fields if not found
# yet). Requires (caller-set global): KCTL (array, e.g.
# KCTL=(kubectl --context k3d-hermes-gitops-dev)).
# ---------------------------------------------------------------------------
app_status() {
  local app="$1"
  "${KCTL[@]}" -n argocd get application "$app" \
    -o jsonpath='{.status.sync.status}{" "}{.status.health.status}' 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# wait_app_synced_healthy <app-name> [timeout-seconds, default 900] - polls
# app_status until Synced+Healthy, dumping the Application's full status and
# calling fail() on timeout. Requires: KCTL.
# ---------------------------------------------------------------------------
wait_app_synced_healthy() {
  local app="$1" timeout="${2:-900}"
  local waited=0 sync="" health=""
  while (( waited < timeout )); do
    read -r sync health <<<"$(app_status "$app")"
    if [[ "$sync" == "Synced" && "$health" == "Healthy" ]]; then
      pass "Argo CD Application ${app} is Synced+Healthy"
      return 0
    fi
    sleep 10
    waited=$((waited + 10))
    if (( waited % 30 == 0 )); then
      log "   ...sync=${sync:-<none>} health=${health:-<none>} (${waited}s/${timeout}s)"
    fi
  done
  read -r sync health <<<"$(app_status "$app")"
  log "-- Application status dump --"
  "${KCTL[@]}" -n argocd get application "$app" -o yaml || true
  fail "Application ${app} did not reach Synced+Healthy within ${timeout}s (last: sync=${sync:-<none>} health=${health:-<none>})"
}

# ---------------------------------------------------------------------------
# wait_pod_ready <namespace> <pod-name> [timeout, default 300s] - thin
# wrapper over `kubectl wait --for=condition=Ready`. Requires: KCTL.
# ---------------------------------------------------------------------------
wait_pod_ready() {
  local ns="$1" pod="$2" timeout="${3:-300s}"
  "${KCTL[@]}" -n "$ns" wait --for=condition=Ready "pod/${pod}" --timeout="$timeout" || \
    fail "pod ${pod} did not become Ready within ${timeout} in namespace ${ns}"
}

# ---------------------------------------------------------------------------
# common_cleanup - the shared tail of every trap-based cleanup: kill any
# port-forward, `pulumi destroy`+`stack rm` the stage 1-3 stack (bounded to
# 180s - about to delete the whole k3d cluster regardless, so a graceful
# in-cluster teardown is nice-to-have, not load-bearing), kill the git
# daemon/http server, delete the k3d cluster, remove $WORKDIR. Never raises
# - every step is best-effort so cleanup always runs to completion.
#
# Requires (caller-set globals): BOOTSTRAP_DIR, WORKDIR, STACK_NAME,
#   REPO_ROOT, CLUSTER_UP (0/1), and optionally PORT_FORWARD_PID,
#   GIT_DAEMON_PID, HTTP_SERVER_PID (each only acted on if non-empty).
# ---------------------------------------------------------------------------
common_cleanup() {
  if [[ -n "${PORT_FORWARD_PID:-}" ]]; then
    kill "$PORT_FORWARD_PID" 2>/dev/null || true
    wait "$PORT_FORWARD_PID" 2>/dev/null || true
  fi

  (
    cd "$BOOTSTRAP_DIR" 2>/dev/null || exit 0
    export PULUMI_CONFIG_PASSPHRASE=""
    export PULUMI_BACKEND_URL="file://$WORKDIR/pulumi-backend"
    if pulumi stack select "$STACK_NAME" >/dev/null 2>&1; then
      timeout 180 pulumi destroy --yes --skip-preview >/dev/null 2>&1 || true
      pulumi stack rm "$STACK_NAME" --force --yes >/dev/null 2>&1 || true
    fi
  )

  if [[ -n "${GIT_DAEMON_PID:-}" ]]; then
    kill "$GIT_DAEMON_PID" 2>/dev/null || true
    wait "$GIT_DAEMON_PID" 2>/dev/null || true
  fi
  if [[ -n "${HTTP_SERVER_PID:-}" ]]; then
    kill "$HTTP_SERVER_PID" 2>/dev/null || true
    wait "$HTTP_SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${WEBHOOK_SINK_PID:-}" ]]; then
    kill "$WEBHOOK_SINK_PID" 2>/dev/null || true
    wait "$WEBHOOK_SINK_PID" 2>/dev/null || true
  fi

  if [[ "${CLUSTER_UP:-0}" == "1" ]]; then
    bash "$REPO_ROOT/infra/scripts/dev-cluster.sh" down >/dev/null 2>&1 || true
  fi

  rm -rf "$WORKDIR"
  log "removed $WORKDIR"
}
