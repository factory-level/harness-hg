#!/usr/bin/env bash
# End-to-end test of the hermes-gitops local testing CLI (spec §27)
# against a LOCAL profile - the persona-echo example. Proves the whole
# developer loop on one machine:
#
#   onboard (a working COPY of the example, so this script never mutates
#   the repo tree)
#     -> up (k3d + Argo CD + Grafana/Prometheus + host git remotes +
#        rendered record + Application, Synced+Healthy)
#     -> test (register + smoke tiers green)
#     -> dev (the REAL watch loop, backgrounded: an edit to the profile
#        reaches the served page through git -> Argo CD sync)
#     -> reset (scoped: prune + re-sync; a hermes.dev/preserve=true
#        Secret survives)
#     -> agent apply/show (the declared cron job reaches the running
#        agent, and arrives PAUSED)
#     -> eval (the example's one-scenario suite passes against the
#        deployed agent, no model call)
#     -> status
#
# Isolated: HERMES_GITOPS_HOME points at a temp dir, the cluster is the
# CLI's own (hermes-gitops-cli), and the trap tears everything down.
# Requires: bun, k3d, kubectl, helm, git, docker, uv, python3, and the
# local hermes-agent:hermes-gitops-dev image.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=("bun" "$REPO_ROOT/cli/src/main.ts")
export HERMES_GITOPS_HOME="$(mktemp -d -t hg-e2e-home-XXXXXX)"
PROFILE_COPY="$(mktemp -d -t hg-e2e-profile-XXXXXX)"
KCTL=(kubectl --context k3d-hermes-gitops-cli)
DEV_PID=""

log() { echo "[cli-e2e] $*" >&2; }
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

cleanup() {
  local rc=$?
  log "cleaning up (exit $rc)..."
  [[ -n "$DEV_PID" ]] && { kill "$DEV_PID" 2>/dev/null || true; }
  "${CLI[@]}" reset --nuclear >/dev/null 2>&1 || true
  # The detached host servers (git daemon / http / sink) - pids in state.
  if [[ -f "$HERMES_GITOPS_HOME/state.json" ]]; then
    python3 - "$HERMES_GITOPS_HOME/state.json" <<'PYEOF' || true
import json, os, signal, sys
state = json.load(open(sys.argv[1]))
for pid in (state.get("pids") or {}).values():
    try:
        os.kill(int(pid), signal.SIGTERM)
    except (OSError, TypeError, ValueError):
        pass
PYEOF
  fi
  rm -rf "$HERMES_GITOPS_HOME" "$PROFILE_COPY"
  if [[ "$rc" == "0" ]]; then
    echo "=========================================================="
    echo "PASS: hermes-gitops CLI verified end-to-end (local profile)"
    echo "=========================================================="
  fi
  exit "$rc"
}
trap cleanup EXIT

# --- step 1: onboard a working copy of the local example profile --------
log "== step 1: onboard (local path) =="
cp -r "$REPO_ROOT/examples/distributed-profile/distributions/persona-echo/." "$PROFILE_COPY/"
"${CLI[@]}" onboard "$PROFILE_COPY"
pass "onboarded persona-echo (working copy at $PROFILE_COPY)"

# --- step 2: up ---------------------------------------------------------
log "== step 2: up (cluster + argocd + grafana + remotes + application) =="
"${CLI[@]}" up
pass "platform up, Application Synced+Healthy"

# --- step 3: test (register + smoke) ------------------------------------
log "== step 3: test (register + smoke) =="
"${CLI[@]}" test
pass "register + smoke tiers green"

# --- step 4: the dev hot-reload loop ------------------------------------
log "== step 4: dev loop - an edit must reach the served page =="
MARKER="hg-dev-loop-$(date +%s)"
nohup "${CLI[@]}" dev >"$HERMES_GITOPS_HOME/dev.log" 2>&1 &
DEV_PID=$!
sleep 3
kill -0 "$DEV_PID" || fail "hg dev did not start (see $HERMES_GITOPS_HOME/dev.log)"
# Edit the PROFILE (author-values change to the test page body).
python3 - "$PROFILE_COPY/hermes-gitops.yaml" "$MARKER" <<'PYEOF'
import sys, yaml
path, marker = sys.argv[1], sys.argv[2]
doc = yaml.safe_load(open(path))
for app in doc["apps"]:
    if app["name"] == "test-page":
        app.setdefault("values", {})["page"] = {"body": f"dev loop works: {marker}"}
yaml.safe_dump(doc, open(path, "w"), sort_keys=False)
PYEOF
log "profile edited with marker $MARKER; waiting for it to serve..."
FOUND=""
for attempt in $(seq 1 60); do
  PF_PORT=$((20000 + RANDOM % 20000))
  "${KCTL[@]}" -n hermes-persona-echo port-forward \
    svc/hermes-persona-echo-test-page-test-page "${PF_PORT}:80" >/dev/null 2>&1 &
  PF=$!
  sleep 2
  BODY="$(curl -s --max-time 4 "http://127.0.0.1:${PF_PORT}/" || true)"
  kill "$PF" 2>/dev/null || true
  wait "$PF" 2>/dev/null || true
  if grep -q "$MARKER" <<<"$BODY"; then FOUND=1; break; fi
  sleep 5
done
[[ -n "$FOUND" ]] || {
  tail -20 "$HERMES_GITOPS_HOME/dev.log" || true
  fail "edited marker never reached the served page through the dev loop"
}
kill "$DEV_PID" 2>/dev/null || true
DEV_PID=""
pass "dev loop delivered the edit through git -> Argo CD -> served page"

# --- step 5: scoped reset honors the preserve contract -------------------
log "== step 5: scoped reset (+ hermes.dev/preserve=true survival) =="
"${KCTL[@]}" -n hermes-persona-echo create secret generic e2e-oauth-token \
  --from-literal=token=precious >/dev/null
"${KCTL[@]}" -n hermes-persona-echo label secret e2e-oauth-token hermes.dev/preserve=true >/dev/null
"${CLI[@]}" reset
"${KCTL[@]}" -n hermes-persona-echo get secret e2e-oauth-token >/dev/null || \
  fail "preserved secret did not survive the scoped reset"
pass "scoped reset re-synced clean and preserved the labeled secret"

# --- step 6: agent configuration -----------------------------------------
# Deployment green does not mean configured: the example ships a cron
# declaration, and until `agent apply` runs it it is a file on a PVC that
# nothing schedules. Assert the whole round trip - declared, activated,
# and PAUSED (a redeploy must never start work on its own).
log "== step 6: agent show/apply =="
"${CLI[@]}" agent apply --profile persona-echo
SNAPSHOT="$("${CLI[@]}" agent show --profile persona-echo --json)"
python3 - "$SNAPSHOT" <<'PY' || fail "agent show did not report the declared cron job as activated and paused"
import json, sys
snap = json.loads(sys.argv[1])["profiles"][0]
jobs = {j["name"]: j for j in snap.get("cron") or []}
job = jobs.get("echo-heartbeat")
assert job, f"echo-heartbeat not activated; got {sorted(jobs)}"
assert job["declaredBy"], "activated job is not attributed to its declaration file"
assert not job["enabled"], "a freshly synced job must arrive paused"
assert not snap.get("missingSkills"), f"declared skills missing from the pod: {snap['missingSkills']}"
PY
pass "declared cron reached the agent, paused, and attributed to its file"

# --- step 7: eval (the fourth claim) -------------------------------------
# The example ships a one-scenario eval suite (evaluator-owned invocation,
# no model call). Copied like the profile so the repo tree is never
# mutated; --dir on a local path is operator-typed, i.e. trusted.
log "== step 7: eval =="
EVALS_COPY="$(mktemp -d -t hg-e2e-evals-XXXXXX)"
cp -r "$REPO_ROOT/examples/distributed-profile/evals/." "$EVALS_COPY/"
EVAL_REPORT="$("${CLI[@]}" eval --dir "$EVALS_COPY" --json)"
rm -rf "$EVALS_COPY"
python3 - "$EVAL_REPORT" <<'PY' || fail "hg eval did not pass the example suite"
import json, sys
report = json.loads(sys.argv[1])
assert report["ok"], f"eval failed: {report['failed']}"
assert report["summary"]["total"] == 1, f"expected 1 scenario, got {report['summary']}"
statuses = {s["name"]: s["status"] for s in report["scenarios"]}
assert statuses == {"heartbeat-converged": "pass"}, f"unexpected statuses: {statuses}"
PY
pass "eval suite discovered, validated and passed against the deployed agent"

# --- step 8: status ------------------------------------------------------
log "== step 8: status =="
"${CLI[@]}" status
pass "status reported"

# --- steps 9-12: the #271 acceptance demonstration -----------------------
# A bare deployment repo on this host stands in for the external server's
# remote; `hg reconcile` is configured to apply with a no-op marker (the
# cluster is already converged by `up`, and what these steps prove is the
# RECONCILER's contract: detection without SSH, exact-commit checkout,
# fail-safe blocking, auditable retry). The pulumi default apply is a
# recorded open leg - it needs a real destination VM.
log "== step 9: reconcile install against a bare deployment repo =="
DEPLOY_BARE="$HERMES_GITOPS_HOME/demo-deploy.git"
DEPLOY_WORK="$HERMES_GITOPS_HOME/demo-work"
git init --quiet --bare "$DEPLOY_BARE"
git clone --quiet "$DEPLOY_BARE" "$DEPLOY_WORK" 2>/dev/null || git init --quiet "$DEPLOY_WORK"
( cd "$DEPLOY_WORK"   && git config user.email e2e@test && git config user.name e2e   && git remote get-url origin >/dev/null 2>&1 || git -C "$DEPLOY_WORK" remote add origin "$DEPLOY_BARE" )
( cd "$DEPLOY_WORK" && echo "v1" > desired.txt && git add . && git commit -qm v1 && git push -q origin HEAD:main )
"${CLI[@]}" reconcile install --repo "$DEPLOY_BARE" --branch main --interval 60 \
  --checks 'test -f desired.txt' --apply 'cp desired.txt "$HERMES_GITOPS_HOME/applied.txt"' \
  --version "e2e-$(git -C "$REPO_ROOT" rev-parse --short HEAD)" \
  --kube-context k3d-hermes-gitops-cli --status-namespace hermes-nexus
pass "reconcile installed (units written; timer enablement is host policy)"

log "== step 10: a valid push converges through one tick =="
"${CLI[@]}" reconcile run --json > "$HERMES_GITOPS_HOME/tick1.json"
python3 - "$HERMES_GITOPS_HOME/tick1.json" "$DEPLOY_WORK" <<'PY2' || fail "valid change did not converge"
import json, subprocess, sys
ledger = json.load(open(sys.argv[1]))
head = subprocess.run(["git", "-C", sys.argv[2], "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
assert ledger["state"] in ("synced", "degraded"), ledger["state"]
assert ledger["appliedSha"] == head, (ledger.get("appliedSha"), head)
assert ledger["history"][-1]["trigger"] == "timer", ledger["history"][-1]
PY2
test -f "$HERMES_GITOPS_HOME/applied.txt" || fail "apply did not run"
pass "push -> detect -> exact checkout -> checks -> apply -> ledger (trigger=timer)"

log "== step 11: an invalid push fails safely, is auditable, and never loops =="
( cd "$DEPLOY_WORK" && git rm -q desired.txt && git commit -qm "v2 broken" && git push -q origin HEAD:main )
BAD_SHA="$(git -C "$DEPLOY_WORK" rev-parse HEAD)"
"${CLI[@]}" reconcile run --json > "$HERMES_GITOPS_HOME/tick2.json" 2>/dev/null && fail "broken commit reported success" || true
"${CLI[@]}" reconcile run --json > "$HERMES_GITOPS_HOME/tick3.json" 2>/dev/null || true
python3 - "$HERMES_GITOPS_HOME/tick3.json" "$BAD_SHA" <<'PY2' || fail "the retry gate did not hold"
import json, sys
ledger = json.load(open(sys.argv[1]))
assert ledger["state"] == "failed"
assert ledger["blocked"]["sha"] == sys.argv[2]
# The SECOND tick did not re-attempt: still one recorded attempt.
assert ledger["blocked"]["attempts"] == 1, ledger["blocked"]
# The bad commit is NOT what runs: appliedSha still names the good one.
assert ledger["appliedSha"] != sys.argv[2]
assert ledger["blocked"]["summary"], "failure must carry a sanitized summary"
PY2
"${CLI[@]}" reconcile prove --json > "$HERMES_GITOPS_HOME/prove-failed.json" 2>/dev/null && fail "prove passed against a failed state" || true
python3 - "$HERMES_GITOPS_HOME/prove-failed.json" <<'PY2' || fail "RECON007 did not audit the failure"
import json, sys
report = json.load(open(sys.argv[1]))
byid = {f["id"]: f["status"] for f in report["findings"]}
assert byid["RECON007"] == "pass", byid   # the failure is auditable and gate-backed
assert byid["RECON005"] == "fail", byid   # and the proof says NOT converged - honestly
PY2
pass "broken commit blocked before mutation; gate held on the second tick; audit record complete"

log "== step 12: retry after correction converges and clears the gate =="
( cd "$DEPLOY_WORK" && echo "v3" > desired.txt && git add . && git commit -qm "v3 fixed" && git push -q origin HEAD:main )
"${CLI[@]}" reconcile run --json > "$HERMES_GITOPS_HOME/tick4.json"
python3 - "$HERMES_GITOPS_HOME/tick4.json" "$DEPLOY_WORK" <<'PY2' || fail "the fix did not clear the gate"
import json, subprocess, sys
ledger = json.load(open(sys.argv[1]))
head = subprocess.run(["git", "-C", sys.argv[2], "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
assert ledger["state"] in ("synced", "degraded")
assert ledger["appliedSha"] == head
assert "blocked" not in ledger or ledger["blocked"] is None
PY2
"${CLI[@]}" reconcile status --json | python3 -c "import json,sys; l=json.load(sys.stdin); assert l['state'] in ('synced','degraded')"
pass "pushed fix cleared the block and converged without human intervention"

log "all steps passed"
