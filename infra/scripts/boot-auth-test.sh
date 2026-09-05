#!/usr/bin/env bash
# Sandboxed test of the boot script's private-source auth behavior
# (issue #18 [G1]): renders the REAL configmap-boot.yaml boot.sh out of
# the chart, then runs it with stubbed `git`/`hermes` binaries and a fake
# /git-auth mount, asserting:
#   1. https source + username/password -> ~/.netrc written for the host,
#      used for the clone, and REMOVED afterwards (no credential outlives
#      the clone);
#   2. ssh source + ssh-privatekey -> GIT_SSH_COMMAND identity set for the
#      clone and the key removed afterwards;
#   3. public source with no /git-auth -> no auth material ever created
#      (backward compatible).
# Invoked by infra/scripts/render-test.sh; standalone-runnable too.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="$REPO_ROOT/harness/hermes/charts/hermes-profile"
export PATH="${HOME}/.local/bin:$PATH"

FAIL=0
log() { echo "[boot-auth-test] $*" >&2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- extract the real boot.sh from the rendered chart -----------------
helm template hermes-support-agent "$CHART_DIR" --namespace hermes-support-agent \
  --set spec.gitAuthSecretRef=git-auth -s templates/pod/configmap-boot.yaml \
  | python3 -c '
import sys, yaml
doc = yaml.safe_load(sys.stdin)
sys.stdout.write(doc["data"]["boot.sh"])
' > "$WORK/boot.sh"

# --- stub toolchain ---------------------------------------------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/git" <<'STUB'
#!/bin/sh
# Records every invocation + the auth state visible AT CLONE TIME.
echo "git $*" >> "$STUB_LOG"
if [ "$1" = "clone" ]; then
  if [ -f "$HOME/.netrc" ]; then cp "$HOME/.netrc" "$STUB_DIR/netrc-at-clone"; fi
  if [ -n "${GIT_SSH_COMMAND:-}" ]; then printf '%s' "$GIT_SSH_COMMAND" > "$STUB_DIR/ssh-cmd-at-clone"; fi
  mkdir -p "$3/.git"
fi
exit 0
STUB
cat > "$WORK/bin/hermes" <<'STUB'
#!/bin/sh
echo "hermes $*" >> "$STUB_LOG"
exit 0
STUB
chmod +x "$WORK/bin/git" "$WORK/bin/hermes"

run_boot() {
  local case_name="$1" source_url="$2" auth_dir="$3"
  local home="$WORK/home-$case_name"
  mkdir -p "$home"
  STUB_LOG="$WORK/log-$case_name" STUB_DIR="$WORK/stub-$case_name" \
    HOME="$home" HERMES_HOME="$home/.hermes" \
    HERMES_PROFILE_NAME=support-agent \
    HERMES_DIST_SOURCE="$source_url" \
    HERMES_DIST_SHA=0000000000000000000000000000000000000000 \
    PATH="$WORK/bin:$PATH" \
    sh -c "mkdir -p \"$WORK/stub-$case_name\"; ${auth_dir:+ln -sfn $auth_dir /git-auth 2>/dev/null || sudo -n ln -sfn $auth_dir /git-auth 2>/dev/null || true;} sh $WORK/boot.sh" \
    >/dev/null 2>&1 || true
}

# /git-auth is an absolute path we can't create without root; run the boot
# script inside a mount-namespace-free sandbox by REWRITING /git-auth to a
# writable path in the extracted script copy per case.
make_case_script() {
  local auth_path="$1" out="$2"
  # Rewrite the fixed /git-auth mount path to the case's sandbox dir, and
  # truncate everything after the install section (profile activation /
  # .env materialization need the full pod filesystem; every assertion
  # this test makes happens before that point).
  # Only the MOUNT PATH occurrences ("-d /git-auth" and "/git-auth/<key>")
  # are rewritten - "$HOME/.ssh/git-auth-key" also contains the substring
  # and must stay untouched.
  sed -e "s#-d /git-auth #-d ${auth_path} #g" -e "s#/git-auth/#${auth_path}/#g" "$WORK/boot.sh" \
    | sed '/^hermes profile use /,$d' > "$out"
}

# --- case 1: https + PAT ---------------------------------------------
AUTH1="$WORK/auth-https"; mkdir -p "$AUTH1"
printf 'x-access-token' > "$AUTH1/username"
printf 'sekret-pat' > "$AUTH1/password"
make_case_script "$AUTH1" "$WORK/boot-https.sh"
HOME1="$WORK/home-https"; mkdir -p "$HOME1"
STUB_LOG="$WORK/log-https" STUB_DIR="$WORK/stub-https" HOME="$HOME1" \
  HERMES_HOME="$HOME1/.hermes" HERMES_PROFILE_NAME=support-agent \
  HERMES_DIST_SOURCE="https://github.example/org/private.git" \
  HERMES_DIST_SHA=0000000000000000000000000000000000000000 \
  PATH="$WORK/bin:$PATH" sh -c "mkdir -p '$WORK/stub-https'; sh '$WORK/boot-https.sh'" >/dev/null

if grep -q 'machine github.example' "$WORK/stub-https/netrc-at-clone" 2>/dev/null \
    && grep -q 'password sekret-pat' "$WORK/stub-https/netrc-at-clone"; then
  log "OK   https: .netrc present at clone time with host + PAT"
else
  log "FAIL https: .netrc missing/wrong at clone time"; FAIL=1
fi
if [ ! -f "$HOME1/.netrc" ]; then
  log "OK   https: .netrc removed after the clone"
else
  log "FAIL https: .netrc survived the boot"; FAIL=1
fi

# --- case 2: ssh + deploy key ----------------------------------------
AUTH2="$WORK/auth-ssh"; mkdir -p "$AUTH2"
printf -- '-----BEGIN FAKE KEY-----\n' > "$AUTH2/ssh-privatekey"
make_case_script "$AUTH2" "$WORK/boot-ssh.sh"
HOME2="$WORK/home-ssh"; mkdir -p "$HOME2"
STUB_LOG="$WORK/log-ssh" STUB_DIR="$WORK/stub-ssh" HOME="$HOME2" \
  HERMES_HOME="$HOME2/.hermes" HERMES_PROFILE_NAME=support-agent \
  HERMES_DIST_SOURCE="git@github.example:org/private.git" \
  HERMES_DIST_SHA=0000000000000000000000000000000000000000 \
  PATH="$WORK/bin:$PATH" sh -c "mkdir -p '$WORK/stub-ssh'; sh '$WORK/boot-ssh.sh'" >/dev/null

if grep -q 'git-auth-key' "$WORK/stub-ssh/ssh-cmd-at-clone" 2>/dev/null; then
  log "OK   ssh: GIT_SSH_COMMAND identity present at clone time"
else
  log "FAIL ssh: GIT_SSH_COMMAND not set at clone time"; FAIL=1
fi
if [ ! -f "$HOME2/.ssh/git-auth-key" ]; then
  log "OK   ssh: deploy key removed after the clone"
else
  log "FAIL ssh: deploy key survived the boot"; FAIL=1
fi

# --- case 3: public source, no auth dir ------------------------------
make_case_script "$WORK/nonexistent-auth" "$WORK/boot-public.sh"
HOME3="$WORK/home-public"; mkdir -p "$HOME3"
STUB_LOG="$WORK/log-public" STUB_DIR="$WORK/stub-public" HOME="$HOME3" \
  HERMES_HOME="$HOME3/.hermes" HERMES_PROFILE_NAME=support-agent \
  HERMES_DIST_SOURCE="https://github.example/org/public.git" \
  HERMES_DIST_SHA=0000000000000000000000000000000000000000 \
  PATH="$WORK/bin:$PATH" sh -c "mkdir -p '$WORK/stub-public'; sh '$WORK/boot-public.sh'" >/dev/null

if [ ! -f "$WORK/stub-public/netrc-at-clone" ] && [ ! -f "$HOME3/.netrc" ] \
    && grep -q "git clone https://github.example/org/public.git" "$WORK/log-public"; then
  log "OK   public: clone ran with no auth material (backward compatible)"
else
  log "FAIL public: unexpected auth material or missing clone"; FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  log "FAILURES present"
  exit 1
fi
log "PASS"
