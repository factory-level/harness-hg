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
SRC_DIR="$DATA_ROOT/src"
PROJECT_DIR="$SRC_DIR${EVE_DIST_SUBDIR:+/$EVE_DIST_SUBDIR}"
STATE_DIR="$DATA_ROOT/state"
WORKSPACES_DIR="${EVE_WORKSPACES_DIR:-$DATA_ROOT/workspaces}"
# EVE_BOOT_MODE: "agent" (default) builds the project and syncs bindings;
# "workspaces" only syncs bindings (the bundle's shared-claim init).
BOOT_MODE="${EVE_BOOT_MODE:-agent}"
export HOME="$DATA_ROOT/home"
export npm_config_cache="$DATA_ROOT/.npm"
mkdir -p "$HOME" "$npm_config_cache"
if [ "$BOOT_MODE" = "agent" ]; then
mkdir -p "$STAMP_DIR" "$STATE_DIR/workflow-data" "$STATE_DIR/sandbox-cache"

CURRENT_SHA=""
if [ -f "$STAMP_FILE" ]; then
  CURRENT_SHA="$(cat "$STAMP_FILE")"
fi

if [ "$CURRENT_SHA" != "$EVE_DIST_SHA" ] || [ ! -d "$PROJECT_DIR/.output" ]; then
  echo "[build-agent] installed_sha ('$CURRENT_SHA') != spec.sha ('$EVE_DIST_SHA') - (re)building the agent"
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
  cd "$PROJECT_DIR"

  # ---- route auth default ---------------------------------------------
  if [ ! -f agent/channels/eve.ts ] && [ ! -f agent/channels/eve.js ] && [ ! -f agent/channels/eve.mjs ]; then
    echo "[build-agent] no agent/channels/eve.ts authored - installing the platform default (Basic auth from the mounted route-auth credential)"
    mkdir -p agent/channels
    cp /scripts/channel-eve.ts agent/channels/eve.ts
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
  echo "$EVE_DIST_SHA" > "$STAMP_FILE"
  echo "[build-agent] built $EVE_DIST_SHA with eve@$EVE_VERSION"
else
  echo "[build-agent] installed_sha matches spec.sha ('$EVE_DIST_SHA') - skipping rebuild"
fi

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
workspace_clone() {
  ws_name="$1"; ws_source="$2"; ws_sha="$3"; ws_access="$4"
  ws_dir="$WORKSPACES_DIR/$ws_name"
  ws_stamp="$WORKSPACES_DIR/.stamps/$ws_name"
  WS_KEEP="$WS_KEEP $ws_name"
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
# EVE_WORKSPACE_BINDINGS: one binding per line, "name source sha access",
# rendered by the chart from spec.workspace.repositories (eve-agent) or
# spec.repositories (eve-bundle). Empty = no bindings.
if [ -n "${EVE_WORKSPACE_BINDINGS:-}" ]; then
  printf '%s\n' "$EVE_WORKSPACE_BINDINGS" | while read -r ws_n ws_s ws_h ws_a; do
    [ -n "$ws_n" ] || continue
    WS_KEEP="$WS_KEEP $ws_n"
    printf '%s\n' "$ws_n" >> "$WORKSPACES_DIR/.stamps/.keep.$$"
    workspace_clone "$ws_n" "$ws_s" "$ws_h" "$ws_a"
  done
fi
# WS_KEEP was set in a subshell (the pipe); re-read it from the keep list.
WS_KEEP=" $(cat "$WORKSPACES_DIR/.stamps/.keep.$$" 2>/dev/null | tr '\n' ' ')"
rm -f "$WORKSPACES_DIR/.stamps/.keep.$$"
# Unbound workspaces are removed: a binding that disappeared from Git
# must not linger as a checkout the agent can still read.
for d in "$WORKSPACES_DIR"/*/; do
  [ -d "$d" ] || continue
  n="$(basename "$d")"
  case " $WS_KEEP " in *" $n "*) ;; *) echo "[build-agent] removing unbound workspace $n"; chmod -R u+w "$d" 2>/dev/null || true; rm -rf "$d" "$WORKSPACES_DIR/.stamps/$n" "$WORKSPACES_DIR/.stamps/$n.unavailable" ;; esac
done
