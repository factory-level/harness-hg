#!/usr/bin/env bash
# The eve-agent chart's tracked-workspace refresh (ADR 0197), proven without
# Docker or a cluster. Renders the REAL chart with a tracked binding, maps its
# https URL onto a local repository (url.insteadOf), extracts the RENDERED
# boot.sh, workspace-sync.sh and workspace-metrics.mjs and the rendered binding
# lines, and runs them against throwaway workspaces roots:
#   1. boot clones the branch tip: the workspace is a symlink into
#      .revs/<name>/<sha> inside the root (a realpath containment check
#      passes), read-only, beside an untouched pinned checkout, and the stamp
#      records branch, sha, success and no failure;
#   2. a new commit is switched in by `once`; the previous revision stays
#      readable until pruning, which keeps two;
#   3. rewritten history is a failure: the live tree stays, the stamp counts
#      and names the failure, no unavailable marker - and a fast-forward
#      afterwards recovers;
#   4. a modified live checkout is a failure;
#   5. an unreachable source on a fresh root leaves the unavailable marker;
#   6. the metrics endpoint reports freshness and flags a stale workspace;
#   7. the loop refreshes on its interval and exits on TERM;
#   8. unbinding removes the symlink and its revisions; pinning it again
#      leaves a real checkout, and tracking it again replaces that.
# Needs helm, git, node and python3 with PyYAML. Invoked by
# infra/scripts/render-test.sh; standalone-runnable too.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART="$REPO_ROOT/harness/eve/charts/eve-agent"
FIXTURE="$REPO_ROOT/plugin/tests/chart/fixtures/eve-record-workspace-tracked.yaml"
WORK="$(mktemp -d)"
LOOP_PID=""
METRICS_PID=""
cleanup() {
  [ -n "$LOOP_PID" ] && kill "$LOOP_PID" 2>/dev/null || true
  [ -n "$METRICS_PID" ] && kill "$METRICS_PID" 2>/dev/null || true
  chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
FAIL=0
ok()  { echo "[workspace-sync-test] OK   $*" >&2; }
bad() { echo "[workspace-sync-test] FAIL $*" >&2; FAIL=$((FAIL+1)); }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null

# --- the tracked repository and the pinned one, at the record's URLs -----------
UP="$WORK/vision"
URL="https://github.com/factory-level/vision-manager.git"
PLAT="$WORK/platform"
commit() { printf '%s\n' "$2" > "$1/BRAND.md"; git -C "$1" add -A; git -C "$1" commit -q -m "$2"; git -C "$1" rev-parse HEAD; }
git init -q -b main "$UP"
SHA1="$(commit "$UP" v1)"
git init -q -b main "$PLAT"
PLAT_SHA="$(commit "$PLAT" platform)"
git config --file "$WORK/gitconfig" "url.$UP.insteadOf" "$URL"
git config --file "$WORK/gitconfig" "url.$PLAT.insteadOf" "https://github.com/factory-level/harness-hg"
# The unreachable source is a local path that does not exist - no DNS lookup.
git config --file "$WORK/gitconfig" "url.$WORK/nowhere.git.insteadOf" "https://example.invalid/nowhere.git"
export GIT_CONFIG_GLOBAL="$WORK/gitconfig"

# --- the rendered scripts and binding lines -------------------------------------
mkdir -p "$WORK/scripts"
helm template ag-eve-echo "$CHART" --namespace ag-eve-echo -f "$FIXTURE" > "$WORK/render.yaml"
python3 - "$WORK/render.yaml" "$WORK" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
out = sys.argv[2]
for d in docs:
    if d["kind"] == "ConfigMap" and d["metadata"]["name"].endswith("-boot"):
        for key, value in d["data"].items():
            open(f"{out}/scripts/{key}", "w").write(value)
    if d["kind"] == "StatefulSet":
        spec = d["spec"]["template"]["spec"]
        env = lambda c: {e["name"]: e.get("value") for e in c.get("env", [])}
        build = next(c for c in spec["initContainers"] if c["name"] == "build-agent")
        sync = next(c for c in spec["containers"] if c["name"] == "workspace-sync")
        open(f"{out}/boot-bindings", "w").write(env(build)["EVE_WORKSPACE_BINDINGS"])
        open(f"{out}/sync-bindings", "w").write(env(sync)["EVE_WORKSPACE_BINDINGS"])
PY
# The fixture's pinned sha is a placeholder; point it at the local commit.
sed -i "s/b5113eb5c0ffee00000000000000000000000000/$PLAT_SHA/" "$WORK/boot-bindings"
TRACKED_LINE="$(cat "$WORK/sync-bindings")"
PINNED_LINE="$(grep '^platform ' "$WORK/boot-bindings")"
check "the rendered sync line is the tracked binding only" \
  test "$TRACKED_LINE" = "vision $URL main read-only tracked 1800"

run_boot() { # root bindings
  env -i PATH="$PATH" GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 \
    EVE_BOOT_MODE=workspaces EVE_DATA_ROOT="$WORK/data" EVE_WORKSPACES_DIR="$1" \
    EVE_SCRIPTS_DIR="$WORK/scripts" EVE_WORKSPACE_BINDINGS="$2" \
    sh "$WORK/scripts/boot.sh" >> "$WORK/boot.log" 2>&1
}
run_once() { # root [bindings]
  env -i PATH="$PATH" GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 \
    EVE_WORKSPACES_DIR="$1" EVE_SCRIPTS_DIR="$WORK/scripts" EVE_WORKSPACE_BINDINGS="${2:-$TRACKED_LINE}" \
    sh "$WORK/scripts/workspace-sync.sh" once >> "$WORK/sync.log" 2>&1
}
stamp() { node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = s[process.argv[2]]; console.log(v === null ? "null" : String(v))' "$1" "$2"; }
live_rev() { readlink "$1/vision" 2>/dev/null || true; }
sha_dirs() { ls -1 "$1/.revs/vision" | grep -Ec '^[0-9a-f]{40}$' || true; }
WS="$WORK/ws"

# --- 1. boot clones the branch tip -----------------------------------------------
check "boot exits 0 with a tracked and a pinned binding" run_boot "$WS" "$(cat "$WORK/boot-bindings")"
check "the workspace is a symlink into .revs/vision/<tip>" test "$(live_rev "$WS")" = ".revs/vision/$SHA1"
check "the live tree is the branch tip" test "$(git -C "$WS/vision" rev-parse HEAD)" = "$SHA1"
check "persona-style realpath containment passes through the symlink" node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1], wsRoot = fs.realpathSync(process.argv[2]);
  const resolvedRoot = fs.realpathSync(root);
  const target = fs.realpathSync(path.resolve(root, "BRAND.md"));
  if (!target.startsWith(resolvedRoot + "/") || !resolvedRoot.startsWith(wsRoot + "/")) process.exit(1);' "$WS/vision" "$WS"
if [ "$(id -u)" != 0 ]; then
  check "a read-only tracked checkout refuses a write" sh -c "! touch '$WS/vision/stray' 2>/dev/null"
fi
check "the stamp records branch, sha and a clean success" sh -c "
  [ \"\$(node -e 'const s=require(process.argv[1]); console.log([s.branch, s.sha, s.consecutiveFailures, String(s.error), s.refreshIntervalSeconds, s.lastSuccessAt ? 1 : 0].join(\" \"))' '$WS/.stamps/vision.json')\" = 'main $SHA1 0 null 1800 1' ]"
check "the plain stamp holds the live sha and no unavailable marker exists" \
  sh -c "[ \"\$(cat '$WS/.stamps/vision')\" = '$SHA1' ] && [ ! -e '$WS/.stamps/vision.unavailable' ]"
check "the pinned binding beside it is a real checkout at its sha" \
  sh -c "[ -d '$WS/platform' ] && [ ! -L '$WS/platform' ] && [ \"\$(git -C '$WS/platform' rev-parse HEAD)\" = '$PLAT_SHA' ]"

# --- 2. a new commit is switched in; two revisions are kept ----------------------
OLD_REAL="$(cd "$WS/vision" && pwd -P)"
SHA2="$(commit "$UP" v2)"
run_once "$WS"
check "a new commit is switched in" sh -c "[ '$(live_rev "$WS")' != '' ] && [ \"\$(readlink '$WS/vision')\" = '.revs/vision/$SHA2' ] && grep -qx v2 '$WS/vision/BRAND.md'"
check "a reader holding the previous revision still reads it" grep -qx v1 "$OLD_REAL/BRAND.md"
SHA3="$(commit "$UP" v3)"; run_once "$WS"
SHA4="$(commit "$UP" v4)"; run_once "$WS"
check "pruning keeps the newest two revisions" \
  sh -c "[ '$(sha_dirs "$WS")' = 2 ] && [ -d '$WS/.revs/vision/$SHA4' ] && [ -d '$WS/.revs/vision/$SHA3' ] && [ ! -e '$WS/.revs/vision/$SHA1' ]"
run_once "$WS"
check "an unchanged tip keeps the live revision and stays clean" \
  sh -c "[ \"\$(readlink '$WS/vision')\" = '.revs/vision/$SHA4' ] && [ '$(stamp "$WS/.stamps/vision.json" consecutiveFailures)' = 0 ]"

# --- 3. rewritten history fails, loudly, and a fast-forward recovers -------------
git -C "$UP" reset -q --hard "$SHA3"
commit "$UP" v4-rewritten > /dev/null
run_once "$WS"
check "rewritten history keeps the live tree" test "$(live_rev "$WS")" = ".revs/vision/$SHA4"
check "rewritten history is a counted, named failure without the unavailable marker" \
  sh -c "[ '$(stamp "$WS/.stamps/vision.json" consecutiveFailures)' = 1 ] && [ ! -e '$WS/.stamps/vision.unavailable' ]"
check "the failure names the rewrite" sh -c "stamp_err=\$(node -e 'console.log(require(process.argv[1]).error)' '$WS/.stamps/vision.json'); case \"\$stamp_err\" in *rewritten*) exit 0;; *) exit 1;; esac"
check "the failure is logged to stderr" grep -q "ERROR workspace vision (branch main): branch main was rewritten" "$WORK/sync.log"
git -C "$UP" reset -q --hard "$SHA4"
SHA5="$(commit "$UP" v5)"
run_once "$WS"
check "a fast-forward after the rewrite recovers" \
  sh -c "[ \"\$(readlink '$WS/vision')\" = '.revs/vision/$SHA5' ] && [ '$(stamp "$WS/.stamps/vision.json" consecutiveFailures)' = 0 ]"

# --- 4. a modified live checkout fails ------------------------------------------
chmod -R u+w "$WS/.revs/vision/$SHA5"
printf 'local edit\n' > "$WS/vision/stray.txt"
SHA6="$(commit "$UP" v6)"
run_once "$WS"
check "a modified live checkout is refused and kept" \
  sh -c "[ \"\$(readlink '$WS/vision')\" = '.revs/vision/$SHA5' ] && [ '$(stamp "$WS/.stamps/vision.json" consecutiveFailures)' = 1 ]"
check "the refusal names the modification" grep -q "has local modifications" "$WORK/sync.log"
rm -f "$WS/vision/stray.txt"
run_once "$WS"
check "a clean checkout converges again" test "$(live_rev "$WS")" = ".revs/vision/$SHA6"

# --- 4a. a retained modified revision is never served again ----------------------
chmod -R u+w "$WS/.revs/vision/$SHA6"
printf 'local edit\n' > "$WS/vision/stray2.txt"
rm "$WS/vision"   # the runbook's recovery: discard the workspace link
run_once "$WS"
check "a retained revision that was modified is materialized again, not re-served" \
  sh -c "[ \"\$(readlink '$WS/vision')\" = '.revs/vision/$SHA6' ] && [ ! -e '$WS/vision/stray2.txt' ] && [ '$(stamp "$WS/.stamps/vision.json" consecutiveFailures)' = 0 ]"

# --- 4b. access follows the binding at an unchanged tip ---------------------------
if [ "$(id -u)" != 0 ]; then
  run_once "$WS" "vision $URL main read-write tracked 1800"
  check "a binding moved to read-write makes the served checkout writable" \
    sh -c "touch '$WS/vision/probe' && rm -f '$WS/vision/probe'"
  run_once "$WS"
  check "a binding moved back to read-only makes it read-only again" sh -c "! touch '$WS/vision/probe' 2>/dev/null"
fi

# --- 4c. a failed switch to another branch does not forfeit the switch -----------
run_once "$WS" "vision $URL release read-only tracked 1800"
check "a failed attempt on a new branch keeps the served branch in the stamp" \
  sh -c "[ '$(stamp "$WS/.stamps/vision.json" branch)' = main ] && [ '$(stamp "$WS/.stamps/vision.json" consecutiveFailures)' = 1 ] && [ \"\$(readlink '$WS/vision')\" = '.revs/vision/$SHA6' ]"
git -C "$UP" checkout -q -b release "$SHA1"
REL="$(commit "$UP" release-1)"
git -C "$UP" checkout -q main
run_once "$WS" "vision $URL release read-only tracked 1800"
check "the diverged branch is switched in once it exists, not refused as a rewrite" \
  sh -c "[ \"\$(readlink '$WS/vision')\" = '.revs/vision/$REL' ] && [ '$(stamp "$WS/.stamps/vision.json" branch)' = release ] && [ '$(stamp "$WS/.stamps/vision.json" consecutiveFailures)' = 0 ]"
run_once "$WS"
check "switching back to main is a declared change too" test "$(live_rev "$WS")" = ".revs/vision/$SHA6"

# --- 5. an unreachable source on a fresh root is unavailable ---------------------
WS2="$WORK/ws-unreachable"
check "boot exits 0 when the tracked clone cannot happen" \
  run_boot "$WS2" "vision https://example.invalid/nowhere.git main read-only tracked 1800"
check "an unreachable tracked source leaves the unavailable marker and no workspace" \
  sh -c "[ -e '$WS2/.stamps/vision.unavailable' ] && [ ! -e '$WS2/vision' ] && [ '$(stamp "$WS2/.stamps/vision.json" sha 2>/dev/null)' = null ] && [ '$(stamp "$WS2/.stamps/vision.json" consecutiveFailures 2>/dev/null)' = 1 ]"

# --- 6. the metrics endpoint ---------------------------------------------------
scrape() { # root port -> metrics text
  node -e 'fetch(`http://127.0.0.1:${process.argv[1]}/metrics`).then(r => r.text()).then(t => process.stdout.write(t)).catch(() => process.exit(1))' "$2"
}
serve_metrics() { # root port
  env -i PATH="$PATH" EVE_WORKSPACES_DIR="$1" HG_WORKSPACE_METRICS_PORT="$2" EVE_WORKSPACE_BINDINGS="$TRACKED_LINE" \
    node "$WORK/scripts/workspace-metrics.mjs" >> "$WORK/metrics.log" 2>&1 &
  METRICS_PID=$!
  for _ in $(seq 1 50); do scrape "$1" "$2" > /dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
PORT=$((20000 + RANDOM % 20000))
check "the metrics endpoint starts" serve_metrics "$WS" "$PORT"
scrape "$WS" "$PORT" > "$WORK/m-fresh.txt" || true
check "metrics report a fresh workspace" grep -qx 'hg_workspace_stale{workspace="vision"} 0' "$WORK/m-fresh.txt"
check "metrics report the declared interval" grep -qx 'hg_workspace_refresh_interval_seconds{workspace="vision"} 1800' "$WORK/m-fresh.txt"
check "metrics report the branch and the served commit" grep -qx "hg_workspace_info{workspace=\"vision\",branch=\"main\",sha=\"$SHA6\"} 1" "$WORK/m-fresh.txt"
check "metrics report the last success time" grep -q '^hg_workspace_last_success_timestamp_seconds{workspace="vision"} [1-9]' "$WORK/m-fresh.txt"
node -e 'const fs = require("fs"); const f = process.argv[1]; const s = JSON.parse(fs.readFileSync(f, "utf8")); s.lastSuccessAt = "2020-01-01T00:00:00Z"; fs.writeFileSync(f, JSON.stringify(s) + "\n")' "$WS/.stamps/vision.json"
scrape "$WS" "$PORT" > "$WORK/m-stale.txt" || true
check "metrics flag a workspace whose last success is older than twice the interval" \
  grep -qx 'hg_workspace_stale{workspace="vision"} 1' "$WORK/m-stale.txt"
kill "$METRICS_PID" 2>/dev/null || true; wait "$METRICS_PID" 2>/dev/null || true; METRICS_PID=""
PORT2=$((PORT + 1))
check "the metrics endpoint starts on a root that never synced" serve_metrics "$WS2" "$PORT2"
scrape "$WS2" "$PORT2" > "$WORK/m-never.txt" || true
check "a workspace that never refreshed reports a last success of 0" \
  grep -qx 'hg_workspace_last_success_timestamp_seconds{workspace="vision"} 0' "$WORK/m-never.txt"
check "a workspace that never refreshed is stale" grep -qx 'hg_workspace_stale{workspace="vision"} 1' "$WORK/m-never.txt"
kill "$METRICS_PID" 2>/dev/null || true; wait "$METRICS_PID" 2>/dev/null || true; METRICS_PID=""

# --- 7. the loop refreshes on its interval and exits on TERM ---------------------
SHA7="$(commit "$UP" v7)"
env -i PATH="$PATH" GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 \
  EVE_WORKSPACES_DIR="$WS" EVE_SCRIPTS_DIR="$WORK/scripts" HG_WORKSPACE_SYNC_TICK=1 \
  HG_WORKSPACE_METRICS_PORT="$((PORT + 2))" EVE_WORKSPACE_BINDINGS="vision $URL main read-only tracked 2" \
  sh "$WORK/scripts/workspace-sync.sh" loop >> "$WORK/loop.log" 2>&1 &
LOOP_PID=$!
switched=0
for _ in $(seq 1 60); do
  if [ "$(live_rev "$WS")" = ".revs/vision/$SHA7" ]; then switched=1; break; fi
  sleep 0.25
done
check "the loop switches in a new commit within its interval" test "$switched" = 1
kill -TERM "$LOOP_PID" 2>/dev/null || true
exited=0
for _ in $(seq 1 40); do
  if ! kill -0 "$LOOP_PID" 2>/dev/null; then exited=1; break; fi
  sleep 0.25
done
check "the loop exits promptly on TERM" test "$exited" = 1
wait "$LOOP_PID" 2>/dev/null || true
LOOP_PID=""

# --- 8. unbind, pin and track again ---------------------------------------------
run_boot "$WS" "$PINNED_LINE"
check "unbinding removes the symlink, its revisions and its stamps" \
  sh -c "[ ! -e '$WS/vision' ] && [ ! -L '$WS/vision' ] && [ ! -e '$WS/.revs/vision' ] && [ ! -e '$WS/.stamps/vision.json' ] && [ -d '$WS/platform' ]"
run_boot "$WS" "$TRACKED_LINE"
check "tracking again clones the tip" test "$(live_rev "$WS")" = ".revs/vision/$SHA7"
run_boot "$WS" "vision $URL $SHA6 read-only"
check "pinning a tracked workspace leaves a real checkout at the pin and no revisions" \
  sh -c "[ -d '$WS/vision' ] && [ ! -L '$WS/vision' ] && [ \"\$(git -C '$WS/vision' rev-parse HEAD)\" = '$SHA6' ] && [ ! -e '$WS/.revs/vision' ] && [ ! -e '$WS/.stamps/vision.json' ]"
run_boot "$WS" "$TRACKED_LINE"
check "tracking a pinned workspace replaces its checkout with the symlink" test "$(live_rev "$WS")" = ".revs/vision/$SHA7"

if [ "$FAIL" -gt 0 ]; then
  echo "[workspace-sync-test] $FAIL failure(s); logs:" >&2
  for f in boot.log sync.log loop.log metrics.log; do
    [ -f "$WORK/$f" ] && { echo "--- $f" >&2; tail -20 "$WORK/$f" >&2; }
  done
  exit 1
fi
echo "[workspace-sync-test] all checks passed" >&2
