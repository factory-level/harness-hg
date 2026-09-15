#!/bin/sh
# harness/eve/charts/eve-agent/files/workspace-sync.sh - the tracked-workspace
# refresh (ADR 0197). Shipped in the boot ConfigMap and run two ways:
#   sh workspace-sync.sh once   boot.sh, in the build container: the first
#                               clone of every tracked binding at its tip
#   sh workspace-sync.sh loop   the workspace-sync container: each binding
#                               again whenever its interval elapses, plus
#                               files/workspace-metrics.mjs on the metrics port
#
# It reads the tracked lines of EVE_WORKSPACE_BINDINGS ("name source branch
# access tracked intervalSeconds") and, for each workspace under
# EVE_WORKSPACES_DIR (default /app/workspaces):
#   1. fetches the branch into a full-history mirror, .revs/<name>/.mirror.git;
#   2. refuses, as a FAILURE, a live checkout that is not at its recorded
#      commit or has local modifications, and a new tip the live commit is not
#      an ancestor of (rewritten history) - ADR-76's refuse-unsafe-convergence;
#   3. materializes a new tip as its own checkout, .revs/<name>/<sha>, and
#      switches the <name> symlink to it with ONE rename(2): a reader sees the
#      old tree or the new one, never a mixture. The link target stays under
#      the workspaces root, so a realpath-inside-root check keeps passing. A
#      retained revision is served again only if it is still exactly its
#      commit, unmodified;
#   4. reconciles the checkout's permissions with the binding's access, keeps
#      the newest two revisions and prunes the rest;
#   5. writes .stamps/<name> (the live sha) and .stamps/<name>.json:
#      {name, mode, branch, sha, refreshIntervalSeconds, fetchedAt,
#       lastSuccessAt, lastAttemptAt, consecutiveFailures, error}.
#      branch and sha describe the tree SERVED; fetchedAt is when that commit
#      was materialized; lastSuccessAt is the last refresh that confirmed it is
#      still the tip of the declared branch.
#
# A failure never removes a live tree - the last good revision keeps being
# served - and it is never quiet: the stamp records it, the log line goes to
# stderr, the metrics count it, WorkspaceStale fires at twice the interval and
# `hg workspace verify` fails. Only a workspace with no tree at all gets the
# .stamps/<name>.unavailable marker boot.sh uses for a failed clone.
#
# Credentials (/run/secrets/repositories/<name>/git) are copied into a
# throwaway HOME under /tmp for each fetch and removed after it, as boot.sh
# does - never onto the claim. `once` always exits 0: a workspace degrades, it
# never stops the agent from starting.
set -u

WORKSPACES_DIR="${EVE_WORKSPACES_DIR:-/app/workspaces}"
STAMPS="$WORKSPACES_DIR/.stamps"
REVS="$WORKSPACES_DIR/.revs"
SCRIPTS_DIR="${EVE_SCRIPTS_DIR:-/scripts}"
CRED_ROOT="${HG_WORKSPACE_CREDENTIALS_DIR:-/run/secrets/repositories}"
KEEP_REVISIONS="${HG_WORKSPACE_KEEP_REVISIONS:-2}"
TICK="${HG_WORKSPACE_SYNC_TICK:-15}"
FETCH_TIMEOUT="${HG_WORKSPACE_FETCH_TIMEOUT:-300}"
MODE="${1:-loop}"
WS_HOME=""
METRICS_PID=""

log()  { echo "[workspace-sync] $*"; }
loud() { echo "[workspace-sync] $*" >&2; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
is_sha() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }

# ---- the stamp --------------------------------------------------------------
json_or_null() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }
# Error text comes from git: one line, no quotes or backslashes, printable, bounded.
sanitize() { printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '"\\' | tr -cd '[:print:]' | cut -c1-300; }
# Read back a string field this script wrote. Only characters a timestamp, a
# sha or a branch can hold are accepted: the claim is shared with the agent.
stamp_field() {
  [ -f "$1" ] || return 0
  sed -n "s|.*\"$2\":\"\([0-9A-Za-z:._/-]*\)\".*|\1|p" "$1" | head -n 1
}
stamp_failures() {
  sf_value=""
  if [ -f "$1" ]; then
    sf_value="$(sed -n 's/.*"consecutiveFailures":\([0-9][0-9]*\).*/\1/p' "$1" | head -n 1)"
  fi
  echo "${sf_value:-0}"
}
write_stamp() { # name branch sha interval fetchedAt lastSuccessAt lastAttemptAt failures error
  w_tmp="$STAMPS/.$1.json.$$"
  if printf '{"name":"%s","mode":"tracked","branch":"%s","sha":%s,"refreshIntervalSeconds":%s,"fetchedAt":%s,"lastSuccessAt":%s,"lastAttemptAt":%s,"consecutiveFailures":%s,"error":%s}\n' \
      "$1" "$2" "$(json_or_null "$3")" "$4" "$(json_or_null "$5")" "$(json_or_null "$6")" \
      "$(json_or_null "$7")" "$8" "$(json_or_null "$9")" > "$w_tmp"; then
    mv -f "$w_tmp" "$STAMPS/$1.json"
  else
    rm -f "$w_tmp"
    loud "ERROR workspace $1: the freshness stamp could not be written"
  fi
}

# ---- credentials and files -----------------------------------------------------
cred_home() { # name source
  WS_HOME="$(mktemp -d /tmp/ws-sync.XXXXXX)"
  c_dir="$CRED_ROOT/$1/git"
  [ -d "$c_dir" ] || return 0
  case "$2" in
    https://*)
      if [ -f "$c_dir/username" ] && [ -f "$c_dir/password" ]; then
        c_host="$(printf '%s' "$2" | sed -E 's#^https://([^/]+)/.*#\1#')"
        printf 'machine %s\nlogin %s\npassword %s\n' "$c_host" "$(cat "$c_dir/username")" "$(cat "$c_dir/password")" > "$WS_HOME/.netrc"
        chmod 600 "$WS_HOME/.netrc"
      fi
      ;;
    git@*|ssh://*)
      if [ -f "$c_dir/ssh-privatekey" ]; then
        mkdir -p "$WS_HOME/.ssh"
        cp "$c_dir/ssh-privatekey" "$WS_HOME/.ssh/key"
        chmod 600 "$WS_HOME/.ssh/key"
        GIT_SSH_COMMAND="ssh -i $WS_HOME/.ssh/key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$WS_HOME/.ssh/known_hosts"
        export GIT_SSH_COMMAND
      fi
      ;;
  esac
}
cred_done() {
  unset GIT_SSH_COMMAND 2>/dev/null || true
  if [ -n "$WS_HOME" ]; then rm -rf "$WS_HOME"; fi
  WS_HOME=""
}
fetch_git() {
  if command -v timeout >/dev/null 2>&1; then
    HOME="$WS_HOME" timeout "$FETCH_TIMEOUT" git "$@"
  else
    HOME="$WS_HOME" git "$@"
  fi
}
# A read-only checkout (chmod -R a-w) cannot be removed until its directories
# are writable again; a symlink is removed as a link, never followed.
remove_tree() {
  if [ -L "$1" ]; then rm -f "$1"; return 0; fi
  [ -e "$1" ] || return 0
  chmod -R u+w "$1" 2>/dev/null || true
  rm -rf "$1"
}
# Non-empty when a checkout is not exactly the commit it claims, unmodified.
checkout_problem() { # dir sha
  cp_head="$(git -C "$1/" rev-parse HEAD 2>/dev/null)"
  if [ "$cp_head" != "$2" ]; then
    echo "is at ${cp_head:-no commit}, not its recorded $2"
    return 0
  fi
  cp_dirty="$(GIT_OPTIONAL_LOCKS=0 git -C "$1/" status --porcelain --untracked-files=normal 2>/dev/null)" \
    || cp_dirty="git status failed"
  if [ -n "$cp_dirty" ]; then echo "has local modifications"; fi
}

# ---- one workspace ----------------------------------------------------------
# sync_one sets these for sync_fail: S_NAME S_BRANCH S_SERVED_BRANCH S_INTERVAL
# S_LIVE_SHA S_FETCHED S_SUCCESS S_ATTEMPT S_FAILURES.
sync_fail() {
  f_count=$((S_FAILURES + 1))
  f_msg="$(sanitize "$1")"
  write_stamp "$S_NAME" "$S_SERVED_BRANCH" "$S_LIVE_SHA" "$S_INTERVAL" "$S_FETCHED" "$S_SUCCESS" "$S_ATTEMPT" "$f_count" "$f_msg"
  if [ -z "$S_LIVE_SHA" ]; then
    : > "$STAMPS/$S_NAME.unavailable"
    loud "ERROR workspace $S_NAME (branch $S_BRANCH): $f_msg - there is no checkout to serve, the workspace is UNAVAILABLE ($f_count consecutive failure(s))"
  else
    loud "ERROR workspace $S_NAME (branch $S_BRANCH): $f_msg - still serving $S_LIVE_SHA from branch $S_SERVED_BRANCH, last refreshed ${S_SUCCESS:-never} ($f_count consecutive failure(s))"
  fi
}

prune_revisions() { # name liveSha
  p_dir="$REVS/$1"
  p_hist="$p_dir/.history"
  if [ "$(tail -n 1 "$p_hist" 2>/dev/null)" != "$2" ]; then printf '%s\n' "$2" >> "$p_hist"; fi
  # The newest KEEP_REVISIONS distinct revisions, newest first.
  p_keep="$(awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) if (!seen[line[i]]++) print line[i] }' "$p_hist" | head -n "$KEEP_REVISIONS")"
  printf '%s\n' "$p_keep" | awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }' > "$p_hist.tmp" \
    && mv -f "$p_hist.tmp" "$p_hist"
  for p_rev in "$p_dir"/*; do
    [ -d "$p_rev" ] || continue
    p_base="${p_rev##*/}"
    case "$p_base" in
      *.tmp) remove_tree "$p_rev"; continue ;;
    esac
    is_sha "$p_base" || continue
    if [ "$p_base" = "$2" ]; then continue; fi
    if printf '%s\n' "$p_keep" | grep -qx "$p_base"; then continue; fi
    remove_tree "$p_rev"
    log "workspace $1: pruned revision $p_base"
  done
}

sync_one() { # name source branch access intervalSeconds
  S_NAME="$1"; s_source="$2"; S_BRANCH="$3"; s_access="$4"; S_INTERVAL="$5"
  s_live="$WORKSPACES_DIR/$S_NAME"
  s_revs="$REVS/$S_NAME"
  s_mirror="$s_revs/.mirror.git"
  s_stamp="$STAMPS/$S_NAME.json"
  S_ATTEMPT="$(now_iso)"
  S_SUCCESS="$(stamp_field "$s_stamp" lastSuccessAt)"
  S_FETCHED="$(stamp_field "$s_stamp" fetchedAt)"
  S_FAILURES="$(stamp_failures "$s_stamp")"
  s_prev_branch="$(stamp_field "$s_stamp" branch)"
  S_LIVE_SHA=""
  if [ -L "$s_live" ]; then
    s_target="$(readlink "$s_live")"
    case "$s_target" in
      ".revs/$S_NAME/"*) S_LIVE_SHA="${s_target##*/}" ;;
    esac
    is_sha "$S_LIVE_SHA" || S_LIVE_SHA=""
  fi
  # The stamp's branch is the branch of the commit being SERVED. A failed
  # attempt on a newly declared branch must not claim it, or that branch's
  # first success would be judged as a rewrite of the old one.
  S_SERVED_BRANCH="$S_BRANCH"
  if [ -n "$S_LIVE_SHA" ] && [ -n "$s_prev_branch" ]; then S_SERVED_BRANCH="$s_prev_branch"; fi
  mkdir -p "$s_revs" "$STAMPS"

  # 1. fetch the branch
  if [ ! -d "$s_mirror" ] && ! git init --quiet --bare "$s_mirror" >/dev/null 2>&1; then
    sync_fail "cannot create the mirror under $s_revs"
    return 0
  fi
  cred_home "$S_NAME" "$s_source"
  if ! s_err="$(fetch_git --git-dir="$s_mirror" fetch --quiet --no-tags --force -- "$s_source" "+refs/heads/$S_BRANCH:refs/hg/tip" 2>&1)"; then
    cred_done
    sync_fail "fetching branch $S_BRANCH from $s_source failed: $s_err"
    return 0
  fi
  cred_done
  s_tip="$(git --git-dir="$s_mirror" rev-parse --verify --quiet 'refs/hg/tip^{commit}' 2>/dev/null)"
  if ! is_sha "$s_tip"; then
    sync_fail "branch $S_BRANCH resolved to no commit"
    return 0
  fi

  # 2. refuse unsafe convergence (ADR-76)
  if [ -n "$S_LIVE_SHA" ]; then
    s_problem="$(checkout_problem "$s_live" "$S_LIVE_SHA")"
    if [ -n "$s_problem" ]; then
      sync_fail "the live checkout $s_problem - refusing to converge over it (remove $s_live to re-clone)"
      return 0
    fi
    # Fast-forward only - unless the binding itself moved to another branch,
    # which is a declared change, not a rewrite.
    if [ "$s_tip" != "$S_LIVE_SHA" ] && [ "$S_SERVED_BRANCH" = "$S_BRANCH" ]; then
      if ! git --git-dir="$s_mirror" merge-base --is-ancestor "$S_LIVE_SHA" "$s_tip" >/dev/null 2>&1; then
        sync_fail "branch $S_BRANCH was rewritten: the live commit $S_LIVE_SHA is not an ancestor of the new tip $s_tip - refresh is fast-forward only"
        return 0
      fi
    fi
  fi

  # 3. materialize the tip and switch to it atomically
  s_changed=0
  s_rev="$s_revs/$s_tip"
  if [ "$s_tip" != "$S_LIVE_SHA" ]; then
    # A retained revision is served again only if it is still exactly its
    # commit, unmodified - never a checkout an earlier refresh refused.
    if [ -d "$s_rev/.git" ] && [ -n "$(checkout_problem "$s_rev" "$s_tip")" ]; then
      log "workspace $S_NAME: retained revision $s_tip no longer matches its commit - materializing it again"
      remove_tree "$s_rev"
    fi
    if [ ! -d "$s_rev/.git" ]; then
      remove_tree "$s_rev.tmp"
      remove_tree "$s_rev"
      if ! s_err="$(git clone --quiet --no-checkout "$s_mirror" "$s_rev.tmp" 2>&1 \
          && git -C "$s_rev.tmp" -c advice.detachedHead=false checkout --quiet --detach "$s_tip" 2>&1)"; then
        remove_tree "$s_rev.tmp"
        sync_fail "could not check out $s_tip: $s_err"
        return 0
      fi
      git -C "$s_rev.tmp" remote remove origin >/dev/null 2>&1 || true
      if [ "$(git -C "$s_rev.tmp" rev-parse HEAD 2>/dev/null)" != "$s_tip" ] || ! mv "$s_rev.tmp" "$s_rev"; then
        remove_tree "$s_rev.tmp"
        sync_fail "the checkout of $s_tip did not land where it should"
        return 0
      fi
    fi
    s_next="$WORKSPACES_DIR/.$S_NAME.next"
    rm -f "$s_next"
    # A pinned checkout this binding used to be is replaced here - by the
    # build container's `once`, before the agent starts.
    if [ -e "$s_live" ] && [ ! -L "$s_live" ]; then remove_tree "$s_live"; fi
    if ! ln -s ".revs/$S_NAME/$s_tip" "$s_next" || ! mv -T "$s_next" "$s_live"; then
      rm -f "$s_next"
      sync_fail "could not switch $S_NAME to $s_tip"
      return 0
    fi
    s_changed=1
    log "workspace $S_NAME: $s_source $S_BRANCH @ $s_tip ($s_access)${S_LIVE_SHA:+, was $S_LIVE_SHA}"
  fi

  # 4. reconcile access, record the success and prune. Access is applied on
  # every success, not only when a revision is created: a binding whose access
  # changed at an unchanged tip still gets it.
  if [ "$s_access" = "read-only" ]; then
    chmod -R a-w "$s_rev" 2>/dev/null || loud "ERROR workspace $S_NAME: could not make $s_tip read-only"
  else
    chmod -R u+w "$s_rev" 2>/dev/null || loud "ERROR workspace $S_NAME: could not make $s_tip writable"
  fi
  printf '%s\n' "$s_tip" > "$STAMPS/.$S_NAME.sha.$$" && mv -f "$STAMPS/.$S_NAME.sha.$$" "$STAMPS/$S_NAME"
  rm -f "$STAMPS/$S_NAME.unavailable"
  if [ "$s_changed" = 1 ] || [ -z "$S_FETCHED" ]; then S_FETCHED="$S_ATTEMPT"; fi
  write_stamp "$S_NAME" "$S_BRANCH" "$s_tip" "$S_INTERVAL" "$S_FETCHED" "$S_ATTEMPT" "$S_ATTEMPT" 0 ""
  if [ "$S_FAILURES" -gt 0 ]; then log "workspace $S_NAME recovered after $S_FAILURES failed refresh(es)"; fi
  prune_revisions "$S_NAME" "$s_tip"
  return 0
}

# ---- the bindings -----------------------------------------------------------
tracked_bindings() { # -> "name source branch access interval" per tracked line
  printf '%s\n' "${EVE_WORKSPACE_BINDINGS:-}" | while read -r t_name t_source t_branch t_access t_mode t_interval; do
    if [ "$t_mode" != "tracked" ]; then continue; fi
    if ! printf '%s' "$t_name" | grep -Eq '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' \
        || ! printf '%s' "$t_branch" | grep -Eq '^[A-Za-z0-9._/-]+$' \
        || ! printf '%s' "$t_interval" | grep -Eq '^[1-9][0-9]*$'; then
      loud "ERROR ignoring a malformed tracked binding line for '${t_name:-?}' - the chart renders these lines, so the record and the chart disagree"
      continue
    fi
    printf '%s %s %s %s %s\n' "$t_name" "$t_source" "$t_branch" "${t_access:-read-write}" "$t_interval"
  done
}

LINES="$(mktemp /tmp/ws-lines.XXXXXX)"
DUE="$(mktemp -d /tmp/ws-due.XXXXXX)"
cleanup() {
  if [ -n "$METRICS_PID" ]; then kill "$METRICS_PID" 2>/dev/null || true; fi
  cred_done
  rm -rf "$LINES" "$DUE"
}
mkdir -p "$STAMPS" "$REVS"
tracked_bindings > "$LINES"

case "$MODE" in
  once)
    while read -r o_name o_source o_branch o_access o_interval; do
      sync_one "$o_name" "$o_source" "$o_branch" "$o_access" "$o_interval" < /dev/null
    done < "$LINES"
    cleanup
    exit 0
    ;;
  loop) ;;
  *)
    loud "usage: workspace-sync.sh once|loop"
    cleanup
    exit 2
    ;;
esac

start_metrics() {
  if [ ! -f "$SCRIPTS_DIR/workspace-metrics.mjs" ]; then
    loud "ERROR no $SCRIPTS_DIR/workspace-metrics.mjs - workspace freshness is NOT exported, so WorkspaceStale sees no data"
    return 0
  fi
  node "$SCRIPTS_DIR/workspace-metrics.mjs" &
  METRICS_PID=$!
}
trap 'cleanup; exit 0' TERM INT
start_metrics
log "tracking $(wc -l < "$LINES" | tr -d ' ') workspace(s), checked every ${TICK}s"
# The build container refreshed every workspace moments ago: each first
# attempt waits one interval from the stamp's lastAttemptAt.
while read -r d_name d_source d_branch d_access d_interval; do
  d_last="$(stamp_field "$STAMPS/$d_name.json" lastAttemptAt)"
  d_epoch=0
  if [ -n "$d_last" ]; then d_epoch="$(date -u -d "$d_last" +%s 2>/dev/null || echo 0)"; fi
  echo $((d_epoch + d_interval)) > "$DUE/$d_name"
done < "$LINES"
while :; do
  l_now="$(date +%s)"
  while read -r l_name l_source l_branch l_access l_interval; do
    l_due="$(cat "$DUE/$l_name" 2>/dev/null)"
    if [ "$l_now" -ge "${l_due:-0}" ]; then
      sync_one "$l_name" "$l_source" "$l_branch" "$l_access" "$l_interval" < /dev/null
      echo $(( $(date +%s) + l_interval )) > "$DUE/$l_name"
    fi
  done < "$LINES"
  if [ -n "$METRICS_PID" ] && ! kill -0 "$METRICS_PID" 2>/dev/null; then
    loud "ERROR the metrics endpoint exited - restarting it"
    start_metrics
  fi
  sleep "$TICK" &
  wait $! 2>/dev/null || true
done
