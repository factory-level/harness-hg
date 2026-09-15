#!/usr/bin/env bash
# End-to-end test of the local developer loop against a real EVE agent - the
# greeter example (examples/eve-agent/agents/greeter), a standalone root Eve
# project. Proves the whole loop on one machine, on a throwaway k3d cluster:
#
#   onboard (a working COPY of the example, so this script never mutates the
#   repo tree)
#     -> up (k3d + Argo CD + the eve-runtime image built and imported; the
#        agent builds, writes its build receipt, and passes its startup gate)
#     -> test (register + the Eve smoke tier)
#     -> dev (the REAL watch loop, backgrounded: an edit reaches the cluster as
#        a new source commit, and the rebuilt agent's receipt names it)
#     -> reset (scoped: prune + re-sync; a hermes.dev/preserve=true Secret
#        survives)
#     -> agent show (the deployed manifest names the synced commit)
#     -> status
#     -> reconcile (a command watcher: detect, apply, block, retry)
#     -> team watcher (credential gate, locked platform revision, published status)
#     -> team status on the running agent: proven (exit 0), drifted from its lock
#        (exit 1), re-locked, rolled back (exit 0)
#
# Isolated: HERMES_GITOPS_HOME points at a temp dir, the cluster is the CLI's
# own (HG_CLUSTER_NAME, default hg-e2e), and the trap tears it down.
# Requires: bun, k3d, kubectl, helm, git, docker, uv, python3 and network for
# the agent's `npm ci`. No model credential: the agent boots, proves its build
# and answers health and info without one. Run it from the main checkout or a
# clone - never a git worktree, whose .git file the wiki image cannot build from.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=("bun" "$REPO_ROOT/cli/src/main.ts")
export HERMES_GITOPS_HOME="$(mktemp -d -t hg-e2e-home-XXXXXX)"
# Its own cluster too: the trap's `reset --nuclear` deletes CLUSTER_NAME, and
# on a developer machine the default one is a live loop.
export HG_CLUSTER_NAME="${HG_CLUSTER_NAME:-hg-e2e}"
PROFILE_COPY="$(mktemp -d -t hg-e2e-profile-XXXXXX)"
KCTL=(kubectl --context "k3d-$HG_CLUSTER_NAME")
DEV_PID=""
AGENT=greeter
AGENT_NS="ag-eve-$AGENT"
EVE_PIN="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/versions.json'))['runtimes']['eve']['version'])")"

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
    echo "PASS: hermes-gitops CLI verified end-to-end (Eve agent)"
    echo "=========================================================="
  fi
  exit "$rc"
}
trap cleanup EXIT

# The commit the local loop last published for the agent's source: the tip of
# the synthetic profile-source repository `hg up` / `hg dev` push to.
source_head() {
  local bare
  bare="$(find "$HERMES_GITOPS_HOME" -type d -name profile-source.git -print -quit)"
  [[ -n "$bare" ]] || fail "no profile-source.git under $HERMES_GITOPS_HOME"
  git --git-dir "$bare" rev-parse main
}
# The build receipt the agent's build container published (ADR 0195), as JSON.
receipt() {
  "${KCTL[@]}" -n "$AGENT_NS" get pod "$AGENT_NS-0" \
    -o jsonpath='{.status.initContainerStatuses[?(@.name=="build-agent")].state.terminated.message}' 2>/dev/null || true
}
# Wait until the running, Ready agent's receipt names commit $1 and the pinned Eve.
wait_for_build() {
  local want="$1" deadline=$((SECONDS + 1200)) got=""
  while (( SECONDS < deadline )); do
    got="$(receipt)"
    if python3 - "$got" "$want" "$EVE_PIN" <<'PYRECEIPT' 2>/dev/null; then
import json, sys
r = json.loads(sys.argv[1])
assert r["sourceSha"] == sys.argv[2] and r["eveVersion"] == sys.argv[3], r
PYRECEIPT
      if [[ "$("${KCTL[@]}" -n "$AGENT_NS" get pod "$AGENT_NS-0" \
            -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" == "True" ]]; then
        return 0
      fi
    fi
    sleep 10
  done
  echo "--- last receipt: ${got:-none}" >&2
  "${KCTL[@]}" -n "$AGENT_NS" describe pod "$AGENT_NS-0" 2>/dev/null | tail -25 >&2 || true
  return 1
}

# --- step 1: onboard a working copy of the Eve example --------------------
log "== step 1: onboard (local path) =="
cp -r "$REPO_ROOT/examples/eve-agent/agents/$AGENT/." "$PROFILE_COPY/"
"${CLI[@]}" onboard "$PROFILE_COPY"
pass "onboarded the $AGENT Eve agent (working copy at $PROFILE_COPY)"

# --- step 2: up, and the agent proves its own build ------------------------
log "== step 2: up (cluster + argocd + eve-runtime image + application) =="
"${CLI[@]}" up
wait_for_build "$(source_head)" || fail "the agent never proved a build of the published commit with eve $EVE_PIN"
pass "platform up; the agent built the published commit, wrote its receipt and passed its startup gate"

# --- step 3: test (register + the Eve smoke tier) -------------------------
log "== step 3: test (register + Eve smoke) =="
"${CLI[@]}" test
pass "register + Eve smoke tiers green"

# --- step 4: the dev hot-reload loop --------------------------------------
# An edit to the agent's own files must reach the cluster as a new source
# commit, and the rebuilt agent's receipt must name exactly that commit.
log "== step 4: dev loop - an edit must be rebuilt at its new commit =="
BEFORE="$(source_head)"
nohup "${CLI[@]}" dev >"$HERMES_GITOPS_HOME/dev.log" 2>&1 &
DEV_PID=$!
sleep 3
kill -0 "$DEV_PID" || fail "hg dev did not start (see $HERMES_GITOPS_HOME/dev.log)"
MARKER="hg-dev-loop-$(date +%s)"
printf '\n<!-- %s -->\n' "$MARKER" >> "$PROFILE_COPY/agent/instructions.md"
AFTER=""
for _ in $(seq 1 60); do
  AFTER="$(source_head)"
  [[ "$AFTER" != "$BEFORE" ]] && break
  sleep 2
done
[[ "$AFTER" != "$BEFORE" ]] || { tail -20 "$HERMES_GITOPS_HOME/dev.log" >&2 || true; fail "the edit never became a new source commit"; }
wait_for_build "$AFTER" || { tail -20 "$HERMES_GITOPS_HOME/dev.log" >&2 || true; fail "the edited agent was never rebuilt at $AFTER"; }
kill "$DEV_PID" 2>/dev/null || true
DEV_PID=""
pass "dev loop delivered the edit: new commit -> Argo CD -> rebuilt agent whose receipt names it"

# --- step 5: scoped reset honors the preserve contract -------------------
log "== step 5: scoped reset (+ hermes.dev/preserve=true survival) =="
"${KCTL[@]}" -n "$AGENT_NS" create secret generic e2e-oauth-token \
  --from-literal=token=precious >/dev/null
"${KCTL[@]}" -n "$AGENT_NS" label secret e2e-oauth-token hermes.dev/preserve=true >/dev/null
"${CLI[@]}" reset
"${KCTL[@]}" -n "$AGENT_NS" get secret e2e-oauth-token >/dev/null || \
  fail "preserved secret did not survive the scoped reset"
wait_for_build "$(source_head)" || fail "the agent did not rebuild and prove itself after the reset"
pass "scoped reset re-synced clean, rebuilt the agent and preserved the labeled secret"

# --- step 6: what the deployment actually got ------------------------------
log "== step 6: agent show =="
SNAPSHOT="$("${CLI[@]}" agent show --profile "$AGENT" --json)"
python3 - "$SNAPSHOT" "$AGENT_NS" "$(source_head)" <<'PYSHOW' || fail "agent show did not describe the deployed Eve agent"
import json, sys
snap = json.loads(sys.argv[1])["profiles"][0]
assert snap["engine"] == "eve", snap["engine"]
assert snap["instance"] == sys.argv[2], snap["instance"]
# The runtime manifest the chart mounted names the commit the loop published.
assert snap.get("runtimeRevision") == sys.argv[3], (snap.get("runtimeRevision"), sys.argv[3])
PYSHOW
pass "agent show names the Eve instance and the exact commit it was deployed from"

# --- step 7: eval ----------------------------------------------------------
# Deliberately not run here: the only Eve eval scenario the examples ship
# (examples/eve-agent/evals, echoes-verbatim) targets the echo agent and needs a
# real model turn, which this credential-free chain cannot make.
log "== step 7: eval (skipped: the Eve example suite needs a real model credential) =="

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
  --kube-context "k3d-$HG_CLUSTER_NAME" --status-namespace hermes-nexus
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

# --- step 13: the team watcher, the locked platform revision, and live status --
# Everything steps 9-12 proved for a COMMAND watcher, now for a `kind: team`
# one (ADR 0191/0193/0195) against this real cluster: the credential gate, the
# platform worktree materialized from a real bare clone, a failure that is
# blocked and auditable rather than looping, the v1alpha2 status document
# published into the live cluster, and `hg team status` reading that cluster.
#
# This step's plan names an agent that is not deployed, so status honestly reports
# its agent fields unknown - which is itself asserted below. Step 14 proves a
# status PASS against the Eve agent this chain actually runs.
log "== step 13: a team-kind watcher, its platform revision, and live status =="
TEAM_BARE="$HERMES_GITOPS_HOME/team-bootstrap.git"
TEAM_WORK="$HERMES_GITOPS_HOME/team-work"
PLATFORM_SRC="$HERMES_GITOPS_HOME/platform-src"
PLATFORM_BARE="$HERMES_GITOPS_HOME/platform.git"
git init --quiet --bare "$TEAM_BARE"
git init --quiet "$TEAM_WORK"
git -C "$TEAM_WORK" config user.email e2e@test && git -C "$TEAM_WORK" config user.name e2e
git -C "$TEAM_WORK" remote add origin "$TEAM_BARE"

# A platform repository with two revisions: the watcher must run the one the
# lock names, and a rollback must return to the other.
mkdir -p "$PLATFORM_SRC/cli/src" "$PLATFORM_SRC/infra"
git init --quiet "$PLATFORM_SRC"
git -C "$PLATFORM_SRC" config user.email e2e@test && git -C "$PLATFORM_SRC" config user.name e2e
for ws in cli infra; do
  printf '{"name":"%s","private":true}' "$ws" > "$PLATFORM_SRC/$ws/package.json"
  ( cd "$PLATFORM_SRC/$ws" && bun install >/dev/null 2>&1 )
done
mkdir -p "$PLATFORM_SRC/cli/src"
# Each revision names itself, echoes the credential it was handed and exits 9: the tick
# must record exactly that exit and that name, and scrub the value from all it writes.
printf 'console.error("platform revision one, token", process.env.E2E_AGENT_TOKEN);process.exit(9);\n' > "$PLATFORM_SRC/cli/src/main.ts"
git -C "$PLATFORM_SRC" add -A && git -C "$PLATFORM_SRC" commit -qm "platform one"
PLATFORM_REV1="$(git -C "$PLATFORM_SRC" rev-parse HEAD)"
printf 'console.error("platform revision two, token", process.env.E2E_AGENT_TOKEN);process.exit(9);\n' > "$PLATFORM_SRC/cli/src/main.ts"
git -C "$PLATFORM_SRC" add -A && git -C "$PLATFORM_SRC" commit -qm "platform two"
PLATFORM_REV2="$(git -C "$PLATFORM_SRC" rev-parse HEAD)"
git clone --quiet --bare "$PLATFORM_SRC" "$PLATFORM_BARE"

# A plan may not name a local path as its platform repository - it must be a
# credential-free URL. Git's own rewrite resolves the declared URL to the bare
# copy here, which is exactly how an operator points at a mirror.
PLATFORM_URL="https://github.com/example/e2e-platform"
export GIT_CONFIG_GLOBAL="$HERMES_GITOPS_HOME/gitconfig"
{ echo "[user]"; echo "  name = e2e"; echo "  email = e2e@test"
  echo "[url \"$PLATFORM_BARE\"]"; echo "  insteadOf = $PLATFORM_URL"; } > "$GIT_CONFIG_GLOBAL"

write_team_plan() {  # $1 = platform revision to lock, $2 = the revision it replaced (optional)
  mkdir -p "$TEAM_WORK/teams" "$TEAM_WORK/infra"
  printf '{"name":"bootstrap","private":true}' > "$TEAM_WORK/infra/package.json"
  : > "$TEAM_WORK/infra/Pulumi.e2e.yaml"
  # The tick runs `bun install --frozen-lockfile` here before anything else, so this
  # needs a REAL lockfile - an empty placeholder is not one.
  ( cd "$TEAM_WORK/infra" && bun install >/dev/null 2>&1 )
  python3 - "$TEAM_WORK" "$PLATFORM_URL" "$1" "k3d-$HG_CLUSTER_NAME" "${2:-}" <<'PYPLAN'
import json, sys
work, platform, revision, context, previous = sys.argv[1:6]
plan = {
  "version": 2, "id": "e2e-teams", "lock": "teams/installation.lock.yaml",
  "sources": [{"id": "demo", "repository": "https://github.com/example/demo", "ref": "a" * 40, "private": False,
    "agents": [{"name": "echo", "subdir": "agents/eve/echo/src", "environment": ["E2E_AGENT_TOKEN"],
                "tools": [], "writablePaths": [], "skills": []}]}],
  "destination": {"repository": "https://github.com/example/generated", "branch": "main",
                  "credentialEnv": "E2E_GITOPS_TOKEN", "autoMerge": True},
  "environment": "environment.yaml", "argoDestinations": ["in-cluster"],
  "platform": {"repository": platform, "ref": revision},
  "runtime": {"image": "example/eve@sha256:" + "a" * 64, "platform": "linux/amd64"},
  "bootstrap": {"directory": "infra", "stack": "e2e"}, "kubeContext": context, "authorizations": ["publish"],
  "credentials": {"configFile": "infra/Pulumi.e2e.yaml", "bindings": {},
                  "inputs": {"E2E_GITOPS_TOKEN": "e2e:git.token"}},
  "acceptance": [{"id": "verify", "source": "demo", "agent": "echo", "argv": ["node", "verify.mjs"], "effect": "read"}],
}
lock = {"version": 2, "installation": "e2e-teams", "planDigest": "0" * 64,
        "sources": {"demo": {"ref": "a" * 40, "commit": "a" * 40}},
        "agents": {"echo": {"image": "example/eve@sha256:" + "a" * 64, "eveVersion": "0.0.0"}},
        "platform": {"ref": revision, "revision": revision, **({"previousRevision": previous} if previous else {})}}
open(f"{work}/teams/installation.yaml", "w").write(json.dumps(plan, indent=2))
open(f"{work}/teams/installation.lock.yaml", "w").write(json.dumps(lock, indent=2))
PYPLAN
  git -C "$TEAM_WORK" add -A
  git -C "$TEAM_WORK" commit -qm "team plan at platform ${1:0:8}"
  git -C "$TEAM_WORK" push -q origin HEAD:main --force
}
write_team_plan "$PLATFORM_REV1"

"${CLI[@]}" reconcile install --repo "$TEAM_BARE" --branch main --interval 60 \
  --kind team --team-plan teams/installation.yaml \
  --version "e2e-team-$(git -C "$REPO_ROOT" rev-parse --short HEAD)" \
  --kube-context "k3d-$HG_CLUSTER_NAME" --status-namespace hermes-nexus --instance team
pass "team-kind watcher installed against a bare bootstrap repository"

# 13a. The credential gate: names only, never values, and nothing runs.
HG_RECONCILE_INSTANCE=team "${CLI[@]}" reconcile run --instance team --json \
  > "$HERMES_GITOPS_HOME/team-tick1.json" 2>/dev/null && fail "a tick ran without the plan's credentials" || true
python3 - "$HERMES_GITOPS_HOME/team-tick1.json" <<'PY2' || fail "the credential gate did not hold"
import json, sys
ledger = json.load(open(sys.argv[1]))
assert ledger["state"] == "failed", ledger["state"]
summary = ledger["blocked"]["summary"]
assert "E2E_AGENT_TOKEN" in summary, summary
# The name that the bootstrap config resolves is NOT demanded of the environment.
assert "E2E_GITOPS_TOKEN" not in summary, summary
# Refused before anything runs, but never anonymously.
assert ledger.get("installation") == "e2e-teams", ledger.get("installation")
PY2
pass "the watcher refuses a plan whose credential NAMES are absent, naming only the names and its installation"

# 13b. With the names present, the tick materializes the LOCKED platform
# revision from a real bare clone and runs that checkout's hg - which here
# exits 9, so the run fails, is blocked, and does not loop.
TEAM_ENV="$HERMES_GITOPS_HOME/team.env"
printf 'E2E_AGENT_TOKEN=e2e-fixture-token\n' > "$TEAM_ENV"
chmod 600 "$TEAM_ENV"
"${CLI[@]}" reconcile install --repo "$TEAM_BARE" --branch main --interval 60 \
  --kind team --team-plan teams/installation.yaml --environment-file "$TEAM_ENV" \
  --version "e2e-team-$(git -C "$REPO_ROOT" rev-parse --short HEAD)" \
  --kube-context "k3d-$HG_CLUSTER_NAME" --status-namespace hermes-nexus --instance team
"${CLI[@]}" reconcile retry --instance team --json > "$HERMES_GITOPS_HOME/team-tick2.json" 2>/dev/null || true
PLATFORM_WT="$HERMES_GITOPS_HOME/../.hermes-gitops/reconcile/instances/team/platform"
WT_ROOT="$(python3 -c "
import json,os,sys
home = os.environ['HERMES_GITOPS_HOME']
print(os.path.join(home, 'reconcile', 'instances', 'team', 'platform'))")"
if [[ -d "$WT_ROOT/$PLATFORM_REV1" && -f "$WT_ROOT/$PLATFORM_REV1/cli/src/main.ts" ]]; then
  grep -q "platform revision one" "$WT_ROOT/$PLATFORM_REV1/cli/src/main.ts" \
    && pass "the locked platform revision is a real worktree, and IS the hg the tick ran" \
    || fail "the platform worktree holds the wrong revision"
else
  echo "--- the tick's ledger ---" >&2; cat "$HERMES_GITOPS_HOME/team-tick2.json" >&2 || true
  echo "--- the tick's log ---" >&2
  tail -40 "$HERMES_GITOPS_HOME/reconcile/instances/team/logs/"*.log 2>/dev/null >&2 || true
  fail "the locked platform revision was never materialized at $WT_ROOT/$PLATFORM_REV1"
fi
python3 - "$HERMES_GITOPS_HOME/team-tick2.json" <<'PY2' || fail "the failed team tick was not blocked cleanly"
import json, sys
ledger = json.load(open(sys.argv[1]))
assert ledger["state"] == "failed", ledger["state"]
assert ledger["blocked"]["summary"], "a failure must carry a sanitized summary"
failure = ledger["history"][-1]["failure"]
# The locked revision's own hg ran: ITS exit code and ITS name, not a lock or install refusal.
assert failure["step"] == "hg team resume --unattended", failure
assert failure["exitCode"] == 9, failure
assert "platform revision one" in failure["summary"], failure["summary"]
# That revision echoed the credential it was handed; what reached the ledger is the redaction.
assert "«redacted»" in failure["summary"], failure["summary"]
assert "e2e-fixture-token" not in json.dumps(ledger), "the environment file's VALUE leaked into the ledger"
PY2
TEAM_LOGS="$HERMES_GITOPS_HOME/reconcile/instances/team/logs"
grep -rq "platform revision one, token «redacted»" "$TEAM_LOGS" \
  || fail "the host log does not show the locked revision's scrubbed output"
! grep -rq "e2e-fixture-token" "$TEAM_LOGS" || fail "the environment file's VALUE leaked into the host log"
pass "a failing team resume blocks on the locked revision's own exit, scrubbing the credential it echoed from ledger and host log"

# 13c. The watcher published its status into the LIVE cluster, as v1alpha2.
"${KCTL[@]}" -n hermes-nexus get configmap hermes-reconciliation-status-team -o json \
  > "$HERMES_GITOPS_HOME/team-status-cm.json" 2>/dev/null || fail "the team watcher published no status ConfigMap"
python3 - "$HERMES_GITOPS_HOME/team-status-cm.json" "$REPO_ROOT" <<'PY2' || fail "the published status is not a valid v1alpha2 document"
import json, sys
cm = json.load(open(sys.argv[1]))
doc = json.loads(cm["data"]["status.json"])
assert doc["apiVersion"] == "nexus.hermes.ai/v1alpha2", doc["apiVersion"]
assert doc["kind"] == "ReconciliationStatus", doc["kind"]
assert doc["installation"] == "e2e-teams", doc
assert doc["phase"] in ("failed", "degraded", "pending"), doc["phase"]
assert "e2e-fixture-token" not in json.dumps(doc), "a credential value reached the cluster"
labels = cm["metadata"].get("labels", {})
assert labels.get("harness-hg.factorylevel.dev/phase") == doc["phase"], labels
PY2
pass "the team watcher published a v1alpha2 status into the cluster, labelled and scrubbed"

# 13d. Moving the lock forward runs the new revision and keeps the old one for
# a rollback; `hg reconcile status` shows the new commit.
write_team_plan "$PLATFORM_REV2" "$PLATFORM_REV1"
"${CLI[@]}" reconcile retry --instance team --json > "$HERMES_GITOPS_HOME/team-tick3.json" 2>/dev/null || true
[[ -f "$WT_ROOT/$PLATFORM_REV2/cli/src/main.ts" ]] \
  && grep -q "platform revision two" "$WT_ROOT/$PLATFORM_REV2/cli/src/main.ts" \
  || fail "moving the lock did not materialize the new platform revision"
python3 - "$HERMES_GITOPS_HOME/team-tick3.json" <<'PY2' || fail "the moved lock did not run the new revision's hg"
import json, sys
failure = json.load(open(sys.argv[1]))["history"][-1]["failure"]
assert failure["exitCode"] == 9 and "platform revision two" in failure["summary"], failure
PY2
# The lock records the revision it replaced, so the watcher keeps that checkout for a rollback.
[[ -f "$WT_ROOT/$PLATFORM_REV1/cli/src/main.ts" ]] \
  || fail "moving the lock pruned the previous revision's checkout, which the lock still names"
pass "moving the locked platform revision runs the new one and keeps the previous checkout for a rollback"

# 13e. `hg team status` reads the LIVE cluster and is honest about what it
# cannot prove. This plan's agent is not deployed, so every agent-evidence field
# is unknown WITH its reason; the watcher this installation runs really is
# failed, so the command exits 1 - and never 0.
git clone --quiet --branch main "$TEAM_BARE" "$HERMES_GITOPS_HOME/team-status-clone"
set +e
"${CLI[@]}" team status --plan teams/installation.yaml --dir "$HERMES_GITOPS_HOME/team-status-clone" --json \
  > "$HERMES_GITOPS_HOME/team-status.json" 2>"$HERMES_GITOPS_HOME/team-status.err"
TEAM_STATUS_RC=$?
set -e
[[ "$TEAM_STATUS_RC" == "1" ]] || {
  echo "--- status stdout ---" >&2; cat "$HERMES_GITOPS_HOME/team-status.json" >&2 || true
  echo "--- status stderr ---" >&2; cat "$HERMES_GITOPS_HOME/team-status.err" >&2 || true
  fail "team status exited $TEAM_STATUS_RC; expected 1 (the watcher it observes is failed)"
}
python3 - "$HERMES_GITOPS_HOME/team-status.json" <<'PY2' || fail "team status did not report honestly"
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["apiVersion"] == "team-status.hermes-gitops.factorylevel.dev/v1alpha1", doc["apiVersion"]
assert doc["verdict"] == "fail", doc["verdict"]
agent = doc["agents"][0]
fields = agent["fields"]
# The live watcher is what fails - and status found the document it published.
assert fields["watcher"]["verdict"] == "fail", fields["watcher"]
# Nothing about the agent itself is claimed, because nothing about it was seen.
for name in ("argo", "ready", "source", "overlay", "eve", "image", "smoke"):
    assert fields[name]["verdict"] == "unknown", (name, fields[name])
# Every field that is not a pass says WHY - an unactionable "?" is the failure
# mode ADR 0195 exists to prevent.
for name, field in fields.items():
    if field["verdict"] != "pass":
        assert field.get("reason"), (name, field)
PY2
pass "team status read the live cluster, claimed nothing it could not see, and failed on the watcher it could"

# --- step 14: hg team status proves the running agent, and its drift ------
# The team commands' own lock and status code, against the Eve agent this chain
# deployed: a plan naming its source commit and running image, a lock written by
# compileLock/renderLock, and `hg team status` reading the live cluster. The
# lock's source commit is set directly rather than fetched: what is under test
# is whether status can prove what runs, not how a resolver reaches a mirror.
log "== step 14: team status proves the running Eve agent, catches drift, and follows a rollback =="
TEAM14="$HERMES_GITOPS_HOME/team14"
mkdir -p "$TEAM14/teams"
IMAGE_ID="$("${KCTL[@]}" -n "$AGENT_NS" get pod "$AGENT_NS-0" \
  -o jsonpath='{.status.containerStatuses[?(@.name=="eve-agent")].imageID}')"
IMAGE_DIGEST="$(grep -oE 'sha256:[a-f0-9]{64}' <<<"$IMAGE_ID" | tail -1)"
[[ -n "$IMAGE_DIGEST" ]] || fail "the running agent reports no image digest (imageID: ${IMAGE_ID:-none})"
cat > "$TEAM14/lock.ts" <<TSEOF
import fs from "node:fs";
import { loadPlan } from "$REPO_ROOT/cli/src/team/plan.ts";
import { compileLock, renderLock } from "$REPO_ROOT/cli/src/team/lock.ts";
const [planFile, lockFile, sha] = process.argv.slice(2) as [string, string, string];
const plan = loadPlan(planFile);
fs.writeFileSync(lockFile, renderLock(await compileLock(plan, async () => sha)));
TSEOF
lock_at() {  # $1 = the source commit the installation intends
  python3 - "$TEAM14/teams/installation.yaml" "$1" "$IMAGE_DIGEST" "k3d-$HG_CLUSTER_NAME" "$AGENT" <<'PYPLAN'
import json, sys
path, sha, digest, context, agent = sys.argv[1:6]
plan = {
  "version": 2, "id": "e2e-greeter", "lock": "teams/installation.lock.yaml",
  "sources": [{"id": agent, "repository": f"https://github.com/example/e2e-{agent}", "ref": sha, "private": False,
    "agents": [{"name": agent, "subdir": "agent", "environment": [], "tools": [], "writablePaths": [], "skills": []}]}],
  "destination": {"repository": "https://github.com/example/e2e-generated", "branch": "main",
                  "credentialEnv": "E2E_GITOPS_TOKEN", "autoMerge": True},
  "environment": "environment.yaml", "argoDestinations": ["in-cluster"],
  "runtime": {"image": f"eve-runtime@{digest}", "platform": "linux/amd64"},
  "bootstrap": {"directory": "infra", "stack": "e2e"}, "kubeContext": context, "authorizations": [],
  "acceptance": [{"id": "verify", "source": agent, "agent": agent, "argv": ["node", "verify.mjs"], "effect": "read"}],
}
open(path, "w").write(json.dumps(plan, indent=2))
PYPLAN
  bun "$TEAM14/lock.ts" "$TEAM14/teams/installation.yaml" "$TEAM14/teams/installation.lock.yaml" "$1" \
    || fail "the lock for $1 could not be compiled"
}
team_status() {  # prints the exit code; the JSON lands in $TEAM14/status.json
  set +e
  "${CLI[@]}" team status --plan teams/installation.yaml --dir "$TEAM14" --json \
    > "$TEAM14/status.json" 2> "$TEAM14/status.err"
  local rc=$?
  set -e
  echo "$rc"
}
show_status() { cat "$TEAM14/status.json" >&2 || true; cat "$TEAM14/status.err" >&2 || true; }
# A Ready pod with the right receipt can still be ahead of its PostSync smoke hook: until the hook
# finishes, status honestly exits 2. Wait (bounded) ONLY while smoke is unknown for that transient
# reason - any other verdict, or a smoke result that stays unknown, is asserted as it stands.
team_status_settled() {
  local rc deadline=$((SECONDS + 300))
  while :; do
    rc="$(team_status)"
    [[ "$rc" == "2" && $SECONDS -lt $deadline ]] || break
    python3 - "$TEAM14/status.json" <<'PYSETTLE' || break
import json, sys
smoke = json.load(open(sys.argv[1]))["agents"][0]["fields"]["smoke"]
transient = ("the smoke check has not finished", "is from an earlier sync")
sys.exit(0 if smoke["verdict"] == "unknown" and any(t in smoke.get("reason", "") for t in transient) else 1)
PYSETTLE
    sleep 5
  done
  echo "$rc"
}

# 14a. Everything the agent runs is what the lock intends: exit 0.
PROVEN="$(source_head)"
lock_at "$PROVEN"
RC="$(team_status_settled)"
[[ "$RC" == "0" ]] || { show_status; fail "team status exited $RC for an agent running exactly what its lock records; expected 0"; }
python3 - "$TEAM14/status.json" <<'PYPROVEN' || { show_status; fail "team status exited 0 without proving every field"; }
import json, sys
fields = json.load(open(sys.argv[1]))["agents"][0]["fields"]
for name in ("argo", "ready", "source", "overlay", "eve", "image", "smoke"):
    assert fields[name]["verdict"] == "pass", (name, fields[name])
# Nobody runs a team watcher for this installation, so the verdict does not wait for one.
assert fields["watcher"]["verdict"] == "not-applicable", fields["watcher"]
PYPROVEN
pass "team status proved the running Eve agent field by field - receipt, image digest, smoke hook - and exited 0"

# 14b. The agent moves to a commit the lock does not record: exit 1, on source.
ORIGINAL_INSTRUCTIONS="$HERMES_GITOPS_HOME/instructions.before-drift.md"
cp "$PROFILE_COPY/agent/instructions.md" "$ORIGINAL_INSTRUCTIONS"
printf '\n<!-- hg-e2e-drift-%s -->\n' "$(date +%s)" >> "$PROFILE_COPY/agent/instructions.md"
"${CLI[@]}" up
DRIFTED="$(source_head)"
[[ "$DRIFTED" != "$PROVEN" ]] || fail "the drift edit did not produce a new source commit"
wait_for_build "$DRIFTED" || fail "the agent was never rebuilt at the drifted commit $DRIFTED"
RC="$(team_status_settled)"
[[ "$RC" == "1" ]] || { show_status; fail "team status exited $RC for an agent running a commit its lock does not record; expected 1"; }
python3 - "$TEAM14/status.json" "$PROVEN" "$DRIFTED" <<'PYDRIFT' || { show_status; fail "team status did not name the drifted source"; }
import json, sys
source = json.load(open(sys.argv[1]))["agents"][0]["fields"]["source"]
assert source["verdict"] == "fail", source
assert source["desired"] == sys.argv[2] and source["running"] == sys.argv[3], source
PYDRIFT
pass "the agent drifted from its lock: team status failed on source, naming both commits"

# 14c. Re-lock at what runs: proven again.
lock_at "$DRIFTED"
RC="$(team_status_settled)"
[[ "$RC" == "0" ]] || { show_status; fail "team status exited $RC after re-locking at the running commit; expected 0"; }
pass "re-locked at the running commit: team status exited 0"

# 14d. Roll the content back. The loop publishes a NEW commit whose content is the
# pre-drift content; the agent rebuilds it, and the lock follows it back.
cp "$ORIGINAL_INSTRUCTIONS" "$PROFILE_COPY/agent/instructions.md"
"${CLI[@]}" up
ROLLED_BACK="$(source_head)"
[[ "$ROLLED_BACK" != "$DRIFTED" ]] || fail "the rollback did not produce a new source commit"
SOURCE_BARE="$(find "$HERMES_GITOPS_HOME" -type d -name profile-source.git -print -quit)"
[[ "$(git --git-dir "$SOURCE_BARE" rev-parse "$ROLLED_BACK^{tree}")" == "$(git --git-dir "$SOURCE_BARE" rev-parse "$PROVEN^{tree}")" ]] \
  || fail "the rolled-back commit's content is not the content that was proven before the drift"
wait_for_build "$ROLLED_BACK" || fail "the agent was never rebuilt at the rollback commit $ROLLED_BACK"
lock_at "$ROLLED_BACK"
RC="$(team_status_settled)"
[[ "$RC" == "0" ]] || { show_status; fail "team status exited $RC after the rollback; expected 0"; }
pass "rolled back: the pre-drift content was rebuilt, re-locked and proven again (exit 0)"

log "all steps passed"
