#!/bin/sh
# harness/eve/charts/eve-agent/files/boot.sh - the build-agent initContainer's
# script (ADR-149/150). harness/eve/charts/eve-bundle/files/boot.sh is a byte-
# identical copy (render-test cmp-gates it); edit this one and copy.
set -eu

# Roots. The eve-agent chart mounts its data claim at /app; the eve-bundle
# chart shares one claim between members and gives each its own root
# (/app/members/<name>) plus a bundle-wide workspaces claim.
DATA_ROOT="${EVE_DATA_ROOT:-/app}"
STAMP_DIR="$DATA_ROOT/.hermes-gitops"
STAMP_FILE="$STAMP_DIR/installed_sha"
RECEIPT_FILE="$STAMP_DIR/build-receipt.json"
SRC_DIR="$DATA_ROOT/src"
PROJECT_DIR="$SRC_DIR${EVE_DIST_SUBDIR:+/$EVE_DIST_SUBDIR}"
STATE_DIR="$DATA_ROOT/state"
WORKSPACES_DIR="${EVE_WORKSPACES_DIR:-$DATA_ROOT/workspaces}"
# EVE_BOOT_MODE: "agent" (default) builds the project and syncs bindings;
# "workspaces" only syncs bindings (the bundle's shared-claim init).
BOOT_MODE="${EVE_BOOT_MODE:-agent}"
SCRIPTS_DIR="${EVE_SCRIPTS_DIR:-/scripts}"
export HOME="$DATA_ROOT/home"
export npm_config_cache="$DATA_ROOT/.npm"
mkdir -p "$HOME" "$npm_config_cache"

# ---- the runtime this record was rendered for (ADR 0192) -----------------
# A per-agent runtime pin names an image AND the eve release it ships. If the
# image running this script ships a different one, the record and the image
# disagree: fail here, before any clone or install, rather than build against
# the wrong runtime. Unset (no pin) keeps the image's own version.
if [ -n "${EXPECTED_EVE_VERSION:-}" ] && [ "$EXPECTED_EVE_VERSION" != "${EVE_VERSION:-}" ]; then
  echo "[build-agent] this record pins eve@$EXPECTED_EVE_VERSION but the image ships eve@${EVE_VERSION:-unknown} - the pinned image and version in versions.json runtimes.eve.allowed disagree" >&2
  exit 1
fi

# ---- operator overlay fetch (ADR 0194) -----------------------------------
# One overlay's repository at its pinned commit into $OV_ROOT/<id>, with the
# workspace bindings' throwaway-HOME credential handling. Unlike a workspace,
# a failure EXITS: approved overlay content is part of the build, never skipped.
overlay_fetch() {
  ov_id="$1"; ov_repo="$2"; ov_commit="$3"
  ov_dir="$OV_ROOT/$ov_id"
  # The record contract's own rules, re-checked before git sees the values: a
  # credential-free https:// or git@ URL and a full commit. The URL is never
  # echoed when it is refused.
  case "$ov_repo" in
    https://*@*|https://*\?*|https://*\#*) ov_bad="carries user info, a query or a fragment" ;;
    https://*|git@*) ov_bad="" ;;
    *) ov_bad="is not an https:// or git@ URL" ;;
  esac
  if [ -n "$ov_bad" ]; then
    echo "[build-agent] overlay $ov_id: its repository $ov_bad - the build stops" >&2
    exit 1
  fi
  if ! printf '%s' "$ov_commit" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "[build-agent] overlay $ov_id: its commit is not a full 40-hex sha - the build stops" >&2
    exit 1
  fi
  OV_HOME="$(mktemp -d /tmp/ov-auth.XXXXXX)"
  ov_cred="/run/secrets/overlays/$ov_id/git"
  if [ -d "$ov_cred" ]; then
    case "$ov_repo" in
      https://*)
        if [ -f "$ov_cred/username" ] && [ -f "$ov_cred/password" ]; then
          ov_host="$(printf '%s' "$ov_repo" | sed -E 's#^https://([^/]+)/.*#\1#')"
          printf 'machine %s\nlogin %s\npassword %s\n' "$ov_host" "$(cat "$ov_cred/username")" "$(cat "$ov_cred/password")" > "$OV_HOME/.netrc"
          chmod 600 "$OV_HOME/.netrc"
        fi
        ;;
      git@*|ssh://*)
        if [ -f "$ov_cred/ssh-privatekey" ]; then
          mkdir -p "$OV_HOME/.ssh"
          cp "$ov_cred/ssh-privatekey" "$OV_HOME/.ssh/key"
          chmod 600 "$OV_HOME/.ssh/key"
          export GIT_SSH_COMMAND="ssh -i $OV_HOME/.ssh/key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$OV_HOME/.ssh/known_hosts"
        fi
        ;;
    esac
  fi
  mkdir -p "$ov_dir"
  if HOME="$OV_HOME" git -C "$ov_dir" init -q \
    && HOME="$OV_HOME" git -C "$ov_dir" fetch -q --depth=1 -- "$ov_repo" "$ov_commit" \
    && HOME="$OV_HOME" git -C "$ov_dir" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD \
    && [ "$(HOME="$OV_HOME" git -C "$ov_dir" rev-parse HEAD)" = "$ov_commit" ]; then
    rm -rf "$ov_dir/.git"
    unset GIT_SSH_COMMAND || true
    rm -rf "$OV_HOME"
    echo "[build-agent] overlay $ov_id: fetched $ov_repo @ $ov_commit"
  else
    unset GIT_SSH_COMMAND || true
    rm -rf "$OV_HOME"
    echo "[build-agent] overlay $ov_id could not be fetched from $ov_repo @ $ov_commit - the build stops (approved overlay content is never skipped); check the repository, the commit and its credential" >&2
    exit 1
  fi
}


# ---- the build receipt (ADR 0195) ---------------------------------------
# What this volume actually built, beside the stamp that gates rebuilds. The
# startup probe compares it with what the pod was rendered for, and the
# termination message publishes it into pod status - no new permissions.
write_receipt() {
  wr_eve="$1"
  wr_tmp="$STAMP_DIR/.build-receipt.$$"
  printf '{"sourceSha":"%s","overlayDigest":"%s","buildKey":"%s","eveVersion":"%s","imageEveVersion":"%s","runtimeDigest":"%s","builtAt":"%s"}\n' \
    "$EVE_DIST_SHA" "${EVE_OVERLAY_DIGEST:-}" "$BUILD_KEY" "$wr_eve" "${EVE_VERSION:-}" \
    "${HG_RUNTIME_DIGEST:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$wr_tmp"
  mv "$wr_tmp" "$RECEIPT_FILE"
}

if [ "$BOOT_MODE" = "agent" ]; then
mkdir -p "$STAMP_DIR" "$STATE_DIR/workflow-data" "$STATE_DIR/sandbox-cache"

CURRENT_SHA=""
if [ -f "$STAMP_FILE" ]; then
  CURRENT_SHA="$(cat "$STAMP_FILE")"
fi

# The build key is spec.sha, plus the overlay digest when operator overlays
# exist (ADR 0194): an overlay-only change rebuilds, and an agent without
# overlays keeps the stamp it already has.
BUILD_KEY="$EVE_DIST_SHA"
if [ -n "${EVE_OVERLAY_DIGEST:-}" ]; then
  BUILD_KEY="$(printf '%s\n%s' "$EVE_DIST_SHA" "$EVE_OVERLAY_DIGEST" | sha256sum | cut -d' ' -f1)"
fi

if [ "$CURRENT_SHA" != "$BUILD_KEY" ] || [ ! -d "$PROJECT_DIR/.output" ]; then
  echo "[build-agent] installed_sha ('$CURRENT_SHA') != build key ('$BUILD_KEY') - (re)building the agent"
  # The stamp goes first: a rebuild that fails before stamping (overlay
  # verification included) must never be skipped on the next start.
  rm -f "$STAMP_FILE" "$RECEIPT_FILE"
  rm -rf "$SRC_DIR"

  # ---- clone, with private-source auth kept off the data claim --------
  # spec.gitAuthSecretRef is mounted at /git-auth; username+password
  # become a ~/.netrc, ssh-privatekey an identity - both under a
  # throwaway HOME in the container's own /tmp, removed by the trap on
  # ANY exit (a failed clone included).
  GIT_HOME="$(mktemp -d /tmp/git-auth.XXXXXX)"
  trap 'rm -rf "$GIT_HOME"' EXIT
  if [ -d /git-auth ]; then
    case "$EVE_DIST_SOURCE" in
      https://*)
        if [ -f /git-auth/username ] && [ -f /git-auth/password ]; then
          DIST_HOST="$(printf '%s' "$EVE_DIST_SOURCE" | sed -E 's#^https://([^/]+)/.*#\1#')"
          printf 'machine %s\nlogin %s\npassword %s\n' \
            "$DIST_HOST" "$(cat /git-auth/username)" "$(cat /git-auth/password)" > "$GIT_HOME/.netrc"
          chmod 600 "$GIT_HOME/.netrc"
          echo "[build-agent] git auth: using HTTPS credentials from gitAuthSecretRef for $DIST_HOST"
        else
          echo "[build-agent] git auth: /git-auth mounted but username/password keys missing for an https source" >&2
          exit 1
        fi
        ;;
      git@*|ssh://*)
        if [ -f /git-auth/ssh-privatekey ]; then
          mkdir -p "$GIT_HOME/.ssh"
          cp /git-auth/ssh-privatekey "$GIT_HOME/.ssh/git-auth-key"
          chmod 600 "$GIT_HOME/.ssh/git-auth-key"
          export GIT_SSH_COMMAND="ssh -i $GIT_HOME/.ssh/git-auth-key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$GIT_HOME/.ssh/known_hosts"
          echo "[build-agent] git auth: using SSH deploy key from gitAuthSecretRef"
        else
          echo "[build-agent] git auth: /git-auth mounted but ssh-privatekey key missing for an ssh source" >&2
          exit 1
        fi
        ;;
    esac
  fi
  HOME="$GIT_HOME" git clone "$EVE_DIST_SOURCE" "$SRC_DIR"
  HOME="$GIT_HOME" git -C "$SRC_DIR" checkout --detach "$EVE_DIST_SHA"
  unset GIT_SSH_COMMAND || true
  rm -rf "$GIT_HOME"
  trap - EXIT
  rm -rf "$SRC_DIR/.git"

  if [ ! -f "$PROJECT_DIR/package.json" ] || [ ! -d "$PROJECT_DIR/agent" ]; then
    echo "[build-agent] $PROJECT_DIR is not an Eve project (package.json + agent/ required)${EVE_DIST_SUBDIR:+ - check spec.sourceSubdir}" >&2
    exit 1
  fi
  if [ ! -f "$PROJECT_DIR/package-lock.json" ]; then
    echo "[build-agent] $PROJECT_DIR has no package-lock.json - commit one (npm install --package-lock-only) so the build is reproducible from spec.sha" >&2
    exit 1
  fi

  # ---- operator overlays (ADR 0194) -----------------------------------
  # Approved, commit-pinned content merged into agent/ before the build by
  # files/overlay-apply.mjs, which verifies every content hash and the merged
  # tree hash. Any refusal stops here with no stamp, so the next start
  # re-clones and retries.
  if [ -n "${EVE_OVERLAYS:-}" ]; then
    OV_ROOT="$(mktemp -d /tmp/overlays.XXXXXX)"
    trap 'rm -rf "$OV_ROOT"' EXIT
    printf '%s\n' "$EVE_OVERLAYS" > "$OV_ROOT/.lines"
    while read -r ov_id ov_kind ov_mode ov_target ov_repo ov_commit ov_path ov_hash; do
      [ -n "$ov_id" ] || continue
      [ "$ov_mode" = "remove" ] && continue
      overlay_fetch "$ov_id" "$ov_repo" "$ov_commit"
    done < "$OV_ROOT/.lines"
    node "$SCRIPTS_DIR/overlay-apply.mjs" "$PROJECT_DIR" "$OV_ROOT"
    rm -rf "$OV_ROOT"
    trap - EXIT
  fi
  if [ "${EVE_BOOT_STOP_AFTER:-}" = "overlays" ]; then
    echo "[build-agent] EVE_BOOT_STOP_AFTER=overlays - stopping before the build (test hook)"
    exit 0
  fi
  cd "$PROJECT_DIR"

  # ---- route auth default ---------------------------------------------
  if [ ! -f agent/channels/eve.ts ] && [ ! -f agent/channels/eve.js ] && [ ! -f agent/channels/eve.mjs ]; then
    echo "[build-agent] no agent/channels/eve.ts authored - installing the platform default (Basic auth from the mounted route-auth credential)"
    mkdir -p agent/channels
    cp "$SCRIPTS_DIR/channel-eve.ts" agent/channels/eve.ts
  fi

  # ---- dependencies + the platform's runtime pin ----------------------
  npm ci --no-audit --no-fund
  PROJECT_EVE="$(node -p "require('./node_modules/eve/package.json').version" 2>/dev/null || echo missing)"
  if [ "$PROJECT_EVE" != "$EVE_VERSION" ]; then
    echo "[build-agent] the project resolves eve@$PROJECT_EVE but the platform runtime is eve@$EVE_VERSION - pin \"eve\": \"$EVE_VERSION\" in package.json (and refresh package-lock.json), or set spec.deployment.runtimeImageTag to a platform image that ships $PROJECT_EVE" >&2
    exit 1
  fi

  # ---- build ----------------------------------------------------------
  # The project's own eve (== the image's, checked above) compiles the
  # agent and writes the Nitro server under .output/. A failed build
  # leaves no stamp, so the next pod start retries from the clone.
  ./node_modules/.bin/eve build --skip-sandbox-prewarm
  test -d .output || { echo "[build-agent] eve build produced no .output/ directory" >&2; exit 1; }
  echo "$BUILD_KEY" > "$STAMP_FILE"
  echo "[build-agent] built $EVE_DIST_SHA${EVE_OVERLAY_DIGEST:+ with overlays $EVE_OVERLAY_DIGEST} with eve@$EVE_VERSION"
else
  echo "[build-agent] installed_sha matches the build key ('$BUILD_KEY') - skipping rebuild"
  # The build fields still describe this build: a skip only happens when the
  # CURRENT build key already matches the stamp. Read the version actually
  # installed rather than asserting the image's - missing evidence stays missing.
  PROJECT_EVE="$(cd "$PROJECT_DIR" 2>/dev/null && node -p "require('./node_modules/eve/package.json').version" 2>/dev/null || echo "")"
fi
# Written on EVERY boot, not only after a rebuild: the runtime-manifest digest
# follows configuration, which changes without changing the build key, and a
# receipt left describing the previous configuration would wedge the startup
# gate on a config-only change. A volume built before receipts gains one here.
write_receipt "$PROJECT_EVE"
# Pod status carries the receipt even when the container exits successfully.
cat "$RECEIPT_FILE" > /dev/termination-log 2>/dev/null || true

# ---- durable state outside the checkout --------------------------------
# Idempotent: a fresh checkout has no .eve/.workflow-data; an old-layout
# volume (state inside the project, pre-ADR-150) is migrated once.
mkdir -p "$PROJECT_DIR/.eve"
for pair in ".workflow-data:workflow-data" "sandbox-cache:sandbox-cache"; do
  link="$PROJECT_DIR/.eve/${pair%%:*}"
  target="$STATE_DIR/${pair##*:}"
  if [ -d "$link" ] && [ ! -L "$link" ]; then
    echo "[build-agent] migrating $link into $target"
    cp -a "$link/." "$target/" && rm -rf "$link"
  fi
  if [ ! -L "$link" ]; then
    rm -rf "$link"
    ln -s "$target" "$link"
  fi
done

fi # BOOT_MODE=agent

# ---- workspace bindings --------------------------------------------------
mkdir -p "$WORKSPACES_DIR/.stamps"
WS_KEEP=""
# A read-only checkout (chmod -R a-w) cannot be removed until its directories
# are writable again; a tracked workspace's symlink is removed as a link.
ws_remove_tree() {
  if [ -L "$1" ]; then rm -f "$1"; return 0; fi
  [ -e "$1" ] || return 0
  chmod -R u+w "$1" 2>/dev/null || true
  rm -rf "$1"
}
workspace_clone() {
  ws_name="$1"; ws_source="$2"; ws_sha="$3"; ws_access="$4"
  ws_dir="$WORKSPACES_DIR/$ws_name"
  ws_stamp="$WORKSPACES_DIR/.stamps/$ws_name"
  WS_KEEP="$WS_KEEP $ws_name"
  # A binding that tracked a branch until now (ADR 0197) is a symlink into
  # .revs/<name>: pinning it again starts from a real checkout.
  if [ -L "$ws_dir" ]; then
    echo "[build-agent] workspace $ws_name no longer tracks a branch - replacing it with a pinned checkout"
    rm -f "$ws_dir" "$ws_stamp"
  fi
  rm -f "$ws_stamp.json"
  ws_remove_tree "$WORKSPACES_DIR/.revs/$ws_name"
  if [ -f "$ws_stamp" ] && [ "$(cat "$ws_stamp")" = "$ws_sha" ] && [ -d "$ws_dir" ]; then
    echo "[build-agent] workspace $ws_name already at $ws_sha"
    return 0
  fi
  # A read-only checkout (chmod -R a-w) cannot be removed until its
  # directories are writable again - a re-pin of a read-only binding
  # failed every boot before this line (found live).
  [ -d "$ws_dir" ] && chmod -R u+w "$ws_dir" 2>/dev/null || true
  rm -rf "$ws_dir" "$ws_stamp" "$ws_stamp.unavailable"
  WS_HOME="$(mktemp -d /tmp/ws-auth.XXXXXX)"
  ws_cred="/run/secrets/repositories/$ws_name/git"
  if [ -d "$ws_cred" ]; then
    case "$ws_source" in
      https://*)
        if [ -f "$ws_cred/username" ] && [ -f "$ws_cred/password" ]; then
          ws_host="$(printf '%s' "$ws_source" | sed -E 's#^https://([^/]+)/.*#\1#')"
          printf 'machine %s\nlogin %s\npassword %s\n' "$ws_host" "$(cat "$ws_cred/username")" "$(cat "$ws_cred/password")" > "$WS_HOME/.netrc"
          chmod 600 "$WS_HOME/.netrc"
        fi
        ;;
      git@*|ssh://*)
        if [ -f "$ws_cred/ssh-privatekey" ]; then
          mkdir -p "$WS_HOME/.ssh"
          cp "$ws_cred/ssh-privatekey" "$WS_HOME/.ssh/key"
          chmod 600 "$WS_HOME/.ssh/key"
          export GIT_SSH_COMMAND="ssh -i $WS_HOME/.ssh/key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$WS_HOME/.ssh/known_hosts"
        fi
        ;;
    esac
  fi
  if HOME="$WS_HOME" git clone --quiet "$ws_source" "$ws_dir" && HOME="$WS_HOME" git -C "$ws_dir" checkout --quiet --detach "$ws_sha"; then
    [ "$ws_access" = "read-only" ] && chmod -R a-w "$ws_dir" || true
    echo "$ws_sha" > "$ws_stamp"
    echo "[build-agent] workspace $ws_name: $ws_source @ $ws_sha ($ws_access)"
  else
    rm -rf "$ws_dir"
    : > "$ws_stamp.unavailable"
    echo "[build-agent] WARNING workspace $ws_name could not be cloned from $ws_source @ $ws_sha - the agent starts WITHOUT it (degraded); fix the binding or the credential" >&2
  fi
  unset GIT_SSH_COMMAND || true
  rm -rf "$WS_HOME"
}
# EVE_WORKSPACE_BINDINGS: one binding per line, "name source revision access
# [mode interval]", rendered by the chart from spec.workspace.repositories
# (eve-agent) or spec.repositories (eve-bundle). No mode means pinned and the
# revision is the sha; mode "tracked" means the revision is a branch that
# files/workspace-sync.sh refreshes every interval seconds (ADR 0197).
# Empty = no bindings.
if [ -n "${EVE_WORKSPACE_BINDINGS:-}" ]; then
  printf '%s\n' "$EVE_WORKSPACE_BINDINGS" | while read -r ws_n ws_s ws_h ws_a ws_m ws_i; do
    [ -n "$ws_n" ] || continue
    WS_KEEP="$WS_KEEP $ws_n"
    printf '%s\n' "$ws_n" >> "$WORKSPACES_DIR/.stamps/.keep.$$"
    case "${ws_m:-pinned}" in
      pinned) workspace_clone "$ws_n" "$ws_s" "$ws_h" "$ws_a" ;;
      tracked) ;;
      *)
        : > "$WORKSPACES_DIR/.stamps/$ws_n.unavailable"
        echo "[build-agent] WARNING workspace $ws_n has unknown mode '$ws_m' - the agent starts WITHOUT it (degraded)" >&2
        ;;
    esac
  done
fi
# Tracked bindings (ADR 0197) are cloned at their branch tip by the SAME
# script the workspace-sync container runs every interval, so the first clone
# and every refresh share one implementation of fast-forward-only, the atomic
# switch and the freshness stamp. It never fails the boot: a clone that fails
# leaves the .unavailable marker and the agent starts without it, loudly.
if printf '%s\n' "${EVE_WORKSPACE_BINDINGS:-}" | grep -Eq '^[^ ]+ [^ ]+ [^ ]+ [^ ]+ tracked( |$)'; then
  if [ -f "$SCRIPTS_DIR/workspace-sync.sh" ]; then
    EVE_WORKSPACES_DIR="$WORKSPACES_DIR" sh "$SCRIPTS_DIR/workspace-sync.sh" once \
      || echo "[build-agent] WARNING the tracked-workspace sync exited non-zero (degraded) - see its lines above" >&2
  else
    echo "[build-agent] WARNING tracked workspace bindings but no $SCRIPTS_DIR/workspace-sync.sh - they start UNAVAILABLE (degraded)" >&2
    printf '%s\n' "$EVE_WORKSPACE_BINDINGS" | while read -r ws_n ws_s ws_h ws_a ws_m ws_i; do
      if [ "$ws_m" = "tracked" ]; then : > "$WORKSPACES_DIR/.stamps/$ws_n.unavailable"; fi
    done
  fi
fi
# WS_KEEP was set in a subshell (the pipe); re-read it from the keep list.
WS_KEEP=" $(cat "$WORKSPACES_DIR/.stamps/.keep.$$" 2>/dev/null | tr '\n' ' ')"
rm -f "$WORKSPACES_DIR/.stamps/.keep.$$"
# Unbound workspaces are removed: a binding that disappeared from Git
# must not linger as a checkout the agent can still read. A tracked one is a
# symlink plus its revisions under .revs/<name>; both go.
for d in "$WORKSPACES_DIR"/*; do
  [ -d "$d" ] || [ -L "$d" ] || continue
  n="$(basename "$d")"
  case " $WS_KEEP " in *" $n "*) ;; *)
    echo "[build-agent] removing unbound workspace $n"
    ws_remove_tree "$d"
    rm -rf "$WORKSPACES_DIR/.stamps/$n" "$WORKSPACES_DIR/.stamps/$n.unavailable" "$WORKSPACES_DIR/.stamps/$n.json"
    ;; esac
done
for d in "$WORKSPACES_DIR"/.revs/*; do
  [ -d "$d" ] || continue
  n="$(basename "$d")"
  case " $WS_KEEP " in *" $n "*) ;; *) echo "[build-agent] removing the revisions of unbound workspace $n"; ws_remove_tree "$d" ;; esac
done
