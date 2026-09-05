#!/usr/bin/env bash
# End-to-end acceptance check for bootstrap stages 1-2 (see repo-root
# README.md's "three-stage bootstrap sequence"): a real fork hermes CLI, a
# real gitops-emitter plugin install, and a real (local, no GitHub) git
# push - all driven entirely through `pulumi up`. This is the session's
# headline acceptance check.
#
# What this proves, in order:
#   1. `uv tool install --editable <fork> --with <this repo>` yields a
#      `hermes` binary with gitops-emitter registered on the
#      hermes_agent.plugins entry-point group (bootstrap stage 1).
#   2. `hermes profile install <local test distribution>` succeeds under
#      HERMES_GITOPS_REQUIRE_EMITTER=1 (i.e. the plugin really is
#      subscribed, not silently missing), and the plugin scaffolds +
#      pushes to a local bare repo (bootstrap stage 2).
#   3. The pushed bootstrap/ scaffold and profiles/<agent>/profile.yaml
#      are exactly what stage 3's root_app.py / the ApplicationSet expect,
#      and profile.yaml validates against the canonical HermesProfile
#      schema - including the `deployment`/`apps` blocks carried by the
#      distribution's hermes-gitops.yaml (the ONE extension carrier,
#      sitting beside its distribution.yaml; the fork's payload copy must
#      preserve it byte-for-byte through a REAL `hermes profile install` -
#      this assertion is what would catch a regression there).
#   4. A second `pulumi up` is a no-op (`--expect-no-changes`).
#
# No GitHub involved anywhere: the GitOps repo is a local bare repo
# (a `file://` URL - gitops_emitter/gitrepo.py supports that natively),
# and the "distribution" installed in step 2 is a throwaway local git repo
# this script creates under a tmpdir, not a checked-in fixture. It's named
# `agent-distribution.git` (not just a plain directory) deliberately: the
# fork's own `_looks_like_git_url` (hermes_cli/profile_distribution.py)
# matches on a literal `.git` suffix regardless of local-vs-remote, so
# naming it this way makes the fork `git clone` it and resolve a REAL
# commit SHA - a plain local-directory source instead hits the fork's
# no-clone dev-install path, which leaves `sha` empty, and an empty `sha`
# fails the HermesProfile schema's 40-hex-char pattern. This is not
# incidental: it's the shape infra/scripts/dev-cluster.sh-style local
# verification needs to exercise the REAL git-clone code path, not a
# dev-only shortcut around it.
#
# Isolation: a throwaway tmpdir holds the Pulumi local file backend, the
# stack config, HERMES_HOME, and UV_TOOL_DIR/UV_TOOL_BIN_DIR - nothing
# under $HOME or this checkout is touched or left behind. The Pulumi
# backend is selected purely via the PULUMI_BACKEND_URL env var (never
# `pulumi login`), so this script never mutates the operator's actual
# current-backend selection in ~/.pulumi/credentials.json. Everything is
# torn down on exit (trap, including on failure): the stack is destroyed
# and removed, then the tmpdir is deleted - taking the throwaway
# uv-tool-installed `hermes`/`hermes-agent`/`hermes-acp` with it, since
# they live under UV_TOOL_DIR/UV_TOOL_BIN_DIR inside the tmpdir rather
# than the real ~/.local/share/uv/tools - so no `uv tool uninstall` step
# is needed.
#
# Usage: infra/scripts/verify-bootstrap-git-side.sh
# Env overrides: HERMES_FORK_PATH (default: ../hermes-agent-gitops
#   next to this checkout)
# Requires: pulumi, uv, git, python3, bun. Does NOT require docker/k3d - no
# cluster is involved (stages.cluster is left false throughout).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOOTSTRAP_DIR="$REPO_ROOT/infra"
HERMES_FORK_PATH="${HERMES_FORK_PATH:-$REPO_ROOT/../hermes-agent-gitops}"

log() { echo "[verify-bootstrap-git-side] $*" >&2; }

if [[ ! -f "$HERMES_FORK_PATH/pyproject.toml" ]]; then
  echo "FAIL: no pyproject.toml at HERMES_FORK_PATH=$HERMES_FORK_PATH" >&2
  echo "      Set HERMES_FORK_PATH to a checkout of hermes-agent-gitops." >&2
  exit 1
fi
HERMES_FORK_PATH="$(cd "$HERMES_FORK_PATH" && pwd)"

for bin in pulumi uv git python3 bun; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL: $bin not found on PATH" >&2; exit 1; }
done

WORKDIR="$(mktemp -d -t hermes-gitops-verify-XXXXXX)"
STACK_NAME="verify-git-side"

cleanup() {
  local rc=$?
  log "cleaning up (exit code $rc)..."
  (
    cd "$BOOTSTRAP_DIR" 2>/dev/null || exit 0
    export PULUMI_CONFIG_PASSPHRASE=""
    export PULUMI_BACKEND_URL="file://$WORKDIR/pulumi-backend"
    if pulumi stack select "$STACK_NAME" >/dev/null 2>&1; then
      pulumi destroy --yes --skip-preview >/dev/null 2>&1 || true
      pulumi stack rm "$STACK_NAME" --force --yes >/dev/null 2>&1 || true
    fi
  )
  rm -rf "$WORKDIR"
  log "removed $WORKDIR"
  exit "$rc"
}
trap cleanup EXIT

log "workdir: $WORKDIR"
log "fork:    $HERMES_FORK_PATH"

mkdir -p "$WORKDIR/hermes-home" "$WORKDIR/uv-tools" "$WORKDIR/uv-bin" "$WORKDIR/pulumi-backend"

# --- 1. GitOps target: a genuinely empty local bare repo (repo_url) -------
git init --quiet --bare "$WORKDIR/gitops.git"

# --- 2. Test distribution: a local git-shaped repo (see header comment on
#        why it must be git-shaped, not a plain directory) -----------------
DIST_DIR="$WORKDIR/agent-distribution.git"
mkdir -p "$DIST_DIR"
git -C "$DIST_DIR" init --quiet
# Subdir layout (the fork's --subdir install form, mirroring this repo's
# own .hermes-dist/distribution-agent/ convention): the distribution
# payload lives in a subdirectory, with the K7 hermes-gitops.yaml extension
# BESIDE distribution.yaml at that payload root.
mkdir -p "$DIST_DIR/.hermes-dist/agent"
# distribution.yaml stays PURE Hermes (no embedded extension blocks - the
# plugin no longer reads them at all).
cat > "$DIST_DIR/.hermes-dist/agent/distribution.yaml" <<'EOF'
name: e2e-agent
version: 0.1.0
description: "hermes-gitops-bootstrap E2E verification agent"
env_requires:
  - name: OPENAI_API_KEY
    description: "OpenAI API key"
    required: true
EOF
# The dedicated hermes-gitops.yaml BESIDE distribution.yaml is the ONE
# carrier of infra intent: helm apps (one remote with a pinned version,
# one local platform chart) plus pod knobs. diskSizeGb 42 is the marker
# asserted after the push - it proves the extension file survived the
# fork's payload copy into the installed profile and drove the record.
cat > "$DIST_DIR/.hermes-dist/agent/hermes-gitops.yaml" <<'EOF'
apps:
  - name: vector-db
    chart: qdrant
    repo: https://qdrant.github.io/qdrant-helm
    version: 1.9.1
    values:
      replicas: 1
  - name: docs-site
    chart: cli/test-env/charts/test-page
    repo: local
deployment:
  diskSizeGb: 42
EOF
git -C "$DIST_DIR" add -A
git -C "$DIST_DIR" -c user.email=verify@hermes-gitops.local -c user.name=verify-bootstrap \
  commit --quiet -m "e2e-agent distribution"

# --- 3. Pulumi stack, fully isolated -----------------------------------
export PULUMI_CONFIG_PASSPHRASE=""
export PULUMI_BACKEND_URL="file://$WORKDIR/pulumi-backend"
export HERMES_HOME="$WORKDIR/hermes-home"
export UV_TOOL_DIR="$WORKDIR/uv-tools"
export UV_TOOL_BIN_DIR="$WORKDIR/uv-bin"

cd "$BOOTSTRAP_DIR"
# infra/ is a bun/TypeScript Pulumi program - make sure node_modules exists
# before the first pulumi invocation (pulumi does not auto-install deps).
bun install --frozen-lockfile >/dev/null
pulumi stack init "$STACK_NAME"
pulumi stack select "$STACK_NAME"

pulumi config set --path hermes-gitops-bootstrap:providers.compute pod
pulumi config set --path hermes-gitops-bootstrap:providers.secret k8s
pulumi config set --path hermes-gitops-bootstrap:providers.ingress none
pulumi config set --path hermes-gitops-bootstrap:stages.cluster false
pulumi config set --path hermes-gitops-bootstrap:hermes.source "$HERMES_FORK_PATH"

# --- 3a. D1 capability check (issue #2): a wrong-but-plausible
#         hermes.source (a Hermes build WITHOUT the profile-lifecycle
#         hooks) must fail stage 1 loudly, not silently no-op stage 2.
#         Build a minimal fake "hermes" package (console script, no
#         hermes_cli.plugins) and point stage 1 at it. ---
FAKE_FORK="$WORKDIR/fake-hermes"
mkdir -p "$FAKE_FORK/hermes_fake"
cat > "$FAKE_FORK/pyproject.toml" <<'EOF_FAKE'
[project]
name = "hermes-agent-fake"
version = "0.0.1"
description = "Deliberately hook-less Hermes stand-in for the D1 negative check"

[project.scripts]
hermes = "hermes_fake:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
EOF_FAKE
cat > "$FAKE_FORK/hermes_fake/__init__.py" <<'EOF_FAKE'
def main() -> None:
    print("fake hermes - no profile hooks")
EOF_FAKE

log "== D1 negative: pulumi up with a hook-less hermes.source must fail stage 1 =="
pulumi config set --path hermes-gitops-bootstrap:hermes.source "$FAKE_FORK"
set +e
D1_OUT="$(pulumi up --yes --skip-preview 2>&1)"
D1_RC=$?
set -e
if [[ $D1_RC -eq 0 ]]; then
  echo "FAIL: stage 1 passed against a Hermes build without profile hooks" >&2
  exit 1
fi
if ! grep -q "cannot fire profile hooks" <<<"$D1_OUT"; then
  echo "FAIL: wrong-source failure did not name the missing hook capability; output was:" >&2
  echo "$D1_OUT" | tail -20 >&2
  exit 1
fi
log "OK: hook-less hermes.source failed stage 1 naming the missing capability"
pulumi config set --path hermes-gitops-bootstrap:hermes.source "$HERMES_FORK_PATH"
pulumi config set --path hermes-gitops-bootstrap:gitopsRepoUrl "file://$WORKDIR/gitops.git"
pulumi config set --secret --path hermes-gitops-bootstrap:gitopsGitToken "verify-local-dummy-token"
pulumi config set --path hermes-gitops-bootstrap:agents[0].source "$DIST_DIR"
# Subdir-layout fixture: the payload lives under .hermes-dist/agent (the
# fork's --subdir install form).
pulumi config set --path hermes-gitops-bootstrap:agents[0].subdir ".hermes-dist/agent"

# --- 3b. K5 fail-loud check (issue #37): the test distribution declares
#         env_requires: [OPENAI_API_KEY]; with no matching agentSecrets
#         entry the agent install MUST fail `pulumi up` naming the key. ---
log "== K5 negative: pulumi up without agentSecrets.e2e-agent.OPENAI_API_KEY must fail =="
set +e
K5_OUT="$(pulumi up --yes --skip-preview 2>&1)"
K5_RC=$?
set -e
if [[ $K5_RC -eq 0 ]]; then
  echo "FAIL: pulumi up succeeded despite a declared required secret missing from the stack" >&2
  exit 1
fi
if ! grep -q "OPENAI_API_KEY" <<<"$K5_OUT" || ! grep -q "agentSecrets.e2e-agent.OPENAI_API_KEY" <<<"$K5_OUT"; then
  echo "FAIL: missing-secret failure did not name the key / the fix command; output was:" >&2
  echo "$K5_OUT" | tail -20 >&2
  exit 1
fi
log "OK: missing required secret failed the up, naming OPENAI_API_KEY and the fix command"

pulumi config set --secret --path 'hermes-gitops-bootstrap:agentSecrets.e2e-agent.OPENAI_API_KEY' "verify-dummy-openai-key"

# --- 4. `pulumi preview` with stages.cluster=false: stage 1-2 resources
#        only (no k8s provider needed at all) - see this task's brief. ---
log "== pulumi preview (stages.cluster=false) =="
pulumi preview

# --- 5. `pulumi up`: stage 1 (hermes + plugin install) then stage 2
#        (hermes profile install e2e-agent) --------------------------------
log "== pulumi up (stage 1 + stage 2) =="
pulumi up --yes

# --- 5b. I2: assert stage 1 wrote the plugin config + token DIRECTLY -----
#         (issue #16 [I2]) - not just inferred from the downstream install
#         succeeding: open the isolated HERMES_HOME's config.yaml/.env and
#         compare against the exact stack config that drove this run. ---
log "== I2: asserting stage-1 plugin config in HERMES_HOME directly =="
I2_EXPECT_REPO_URL="file://$WORKDIR/gitops.git" \
uv run --with pyyaml python3 - "$HERMES_HOME/config.yaml" <<'EOF_I2'
import os, sys, yaml

cfg = yaml.safe_load(open(sys.argv[1], encoding="utf-8")) or {}
plugins = cfg.get("plugins") or {}
assert "gitops-emitter" in (plugins.get("enabled") or []), (
    f"plugins.enabled is missing gitops-emitter: {plugins.get('enabled')!r}"
)
entry = (plugins.get("entries") or {}).get("gitops-emitter") or {}
expected = {
    "repo_url": os.environ["I2_EXPECT_REPO_URL"],
    "branch": "main",              # DEFAULT_GITOPS_BRANCH (unset in this stack)
    "scaffold": True,              # hermesInstall.scaffold default
    "hermes_gitops_repo_url": "https://github.com/factory-level/harness-hg.git",
    "chart_revision": "main",      # DEFAULT_CHART_REVISION (unset in this stack)
}
mismatched = {
    key: (want, entry.get(key))
    for key, want in expected.items()
    if entry.get(key) != want
}
assert not mismatched, f"plugins.entries.gitops-emitter mismatches: {mismatched}"
print("OK   config.yaml: plugins.enabled + all five entries.gitops-emitter keys match stack config")
EOF_I2

I2_ENV_FILE="$HERMES_HOME/.env"
[[ -f "$I2_ENV_FILE" ]] || { echo "FAIL: $I2_ENV_FILE missing after stage 1" >&2; exit 1; }
I2_TOKEN_COUNT="$(grep -c '^GITOPS_GIT_TOKEN=' "$I2_ENV_FILE")"
if [[ "$I2_TOKEN_COUNT" != 1 ]] || ! grep -q '^GITOPS_GIT_TOKEN=verify-local-dummy-token$' "$I2_ENV_FILE"; then
  echo "FAIL: expected exactly one GITOPS_GIT_TOKEN=verify-local-dummy-token line in $I2_ENV_FILE (found $I2_TOKEN_COUNT token line(s))" >&2
  exit 1
fi
echo "OK   .env: exactly one GITOPS_GIT_TOKEN line with the configured secret"

# --- 6. Assert the bare repo actually received bootstrap/ + the profile ---
log "== verifying the bare GitOps repo's contents =="
CHECK_CLONE="$WORKDIR/check-clone"
git clone --quiet --branch main "$WORKDIR/gitops.git" "$CHECK_CLONE"

for f in bootstrap/applicationset.yaml bootstrap/project.yaml profiles/e2e-agent/profile.yaml; do
  if [[ ! -f "$CHECK_CLONE/$f" ]]; then
    echo "FAIL: $f missing from the pushed GitOps repo" >&2
    exit 1
  fi
  echo "OK   $f present in pushed GitOps repo"
done

log "-- profiles/e2e-agent/profile.yaml --"
cat "$CHECK_CLONE/profiles/e2e-agent/profile.yaml"

# The hermes-gitops.yaml intent (deployment/apps) must have survived the
# real `hermes profile install` round-trip (the fork's payload copy
# preserves the file byte-for-byte; only distribution.yaml gets rewritten)
# - assert on more than just file presence.
if ! grep -q "^  deployment:" "$CHECK_CLONE/profiles/e2e-agent/profile.yaml"; then
  echo "FAIL: profile.yaml has no spec.deployment - the hermes-gitops.yaml intent was dropped" >&2
  exit 1
fi
if ! grep -q "^  apps:" "$CHECK_CLONE/profiles/e2e-agent/profile.yaml"; then
  echo "FAIL: profile.yaml has no spec.apps - the hermes-gitops.yaml intent was dropped" >&2
  exit 1
fi
echo "OK   profile.yaml carries its deployment/apps blocks"
# The record must carry hermes-gitops.yaml's diskSizeGb marker (42) - the
# dedicated file is the ONLY extension carrier.
if ! grep -q "diskSizeGb: 42" "$CHECK_CLONE/profiles/e2e-agent/profile.yaml"; then
  echo "FAIL: profile.yaml diskSizeGb is not 42 - hermes-gitops.yaml (beside the manifest) did not drive the record" >&2
  exit 1
fi
echo "OK   beside-manifest hermes-gitops.yaml drove the rendered record"
# The resolved apps must keep the local/remote split: remote app pins its
# version, local app has none.
if ! grep -q "version: 1.9.1" "$CHECK_CLONE/profiles/e2e-agent/profile.yaml"; then
  echo "FAIL: profile.yaml's remote app lost its pinned chart version" >&2
  exit 1
fi
if ! grep -q "repo: local" "$CHECK_CLONE/profiles/e2e-agent/profile.yaml"; then
  echo "FAIL: profile.yaml's local app lost its repo: local marker" >&2
  exit 1
fi
echo "OK   resolved apps keep the remote-version / local split"

# --- 7. Schema-validate the pushed profile against the canonical contract -
log "== validating profile.yaml against the canonical HermesProfile schema =="
SCHEMA="$REPO_ROOT/agent-bundle-contracts/hermesprofile/v1alpha3/profile.schema.json"
uv run --with pyyaml --with jsonschema "$REPO_ROOT/infra/scripts/validate_with_jsonschema.py" \
  "$SCHEMA" "$CHECK_CLONE/profiles/e2e-agent/profile.yaml"

# --- 8. Idempotency: a second `pulumi up` must be a no-op -----------------
log "== pulumi up (again): must be a no-op =="
pulumi up --yes --expect-no-changes

# I2: the re-run must not have duplicated the .env token line (upsert, not
# append).
if [[ "$(grep -c '^GITOPS_GIT_TOKEN=' "$HERMES_HOME/.env")" != 1 ]]; then
  echo "FAIL: re-run duplicated the GITOPS_GIT_TOKEN line in $HERMES_HOME/.env" >&2
  exit 1
fi
echo "OK   .env still has exactly one GITOPS_GIT_TOKEN line after the re-run (I2)"

# --- 8b. D2 self-heal (issue #3): delete the tool venv out-of-band and
#         re-run with UNCHANGED config - the health probe must force the
#         install to rerun and restore a working hermes; a further up is
#         a no-op again. ---
log "== D2 self-heal: deleting the hermes tool venv, then pulumi up with unchanged config =="
rm -rf "$UV_TOOL_DIR/hermes-agent"
if "$UV_TOOL_BIN_DIR/hermes" --help >/dev/null 2>&1; then
  echo "FAIL: hermes still works after deleting its tool venv - the self-heal case isn't testing anything" >&2
  exit 1
fi
D2_OUT="$(pulumi up --yes --skip-preview 2>&1)"
if ! grep -q "needs (re)install" <<<"$D2_OUT"; then
  echo "FAIL: health probe did not flag the deleted venv; output was:" >&2
  echo "$D2_OUT" | tail -20 >&2
  exit 1
fi
if ! grep -q "entry point resolved OK" <<<"$D2_OUT"; then
  echo "FAIL: self-heal up did not re-run the install+verify; output was:" >&2
  echo "$D2_OUT" | tail -20 >&2
  exit 1
fi
"$UV_TOOL_BIN_DIR/hermes" --help >/dev/null 2>&1 || { echo "FAIL: hermes still broken after self-heal up" >&2; exit 1; }
log "OK: deleted venv was detected, reinstalled, and hermes works again"
# The first up after a successful heal normalizes the health trigger back
# to "healthy" (one more idempotent install+verify run - see the
# component's convergence comment); everything after that is a no-op.
log "== pulumi up (trigger normalization after self-heal) =="
pulumi up --yes --skip-preview >/dev/null
log "== pulumi up (after normalization): must be a no-op again =="
pulumi up --yes --expect-no-changes

# --- 8c. K1 diff-tracking (issue #32): changing a declared override must
#         show a legible per-key desired-state diff at `pulumi preview`
#         (the HERMES_GITOPS_DESIRED_OVERRIDES_DOC environment input), not
#         an opaque "will run a command". ---
log "== K1: pulumi preview --diff after an overrides change must show the desired-state key =="
pulumi config set --path 'hermes-gitops-bootstrap:agents[0].overrides.deployment.diskSizeGb' 123
K1_OUT="$(pulumi preview --diff 2>&1)"
if ! grep -q "HERMES_GITOPS_DESIRED_OVERRIDES_DOC" <<<"$K1_OUT" || ! grep -q "123" <<<"$K1_OUT"; then
  echo "FAIL: preview --diff did not show the overrides desired-state change; output was:" >&2
  echo "$K1_OUT" | tail -30 >&2
  exit 1
fi
log "OK: preview shows the per-key desired-state diff for the overrides change"
pulumi config rm --path 'hermes-gitops-bootstrap:agents[0].overrides' >/dev/null
pulumi up --yes --expect-no-changes >/dev/null

# --- 8d. F5 update semantics + mutable-ref drift (issue #23): commit an
#         upstream change to the (mutable-ref) distribution repo; the
#         plan-time sha resolution must re-trigger the Command, the run
#         must dispatch to `hermes profile update` (commit message says
#         "update"), and the pushed record must carry the new sha. A
#         further up with no upstream movement is a no-op again. ---
log "== F5: committing an upstream distribution change (mutable ref) =="
sed -i 's/^version: 0\.1\.0$/version: 0.2.0/' "$DIST_DIR/.hermes-dist/agent/distribution.yaml"
git -C "$DIST_DIR" add -A
git -C "$DIST_DIR" -c user.email=verify@hermes-gitops.local -c user.name=verify-bootstrap \
  commit --quiet -m "bump to 0.2.0"
NEW_DIST_SHA="$(git -C "$DIST_DIR" rev-parse HEAD)"

F5_PREVIEW="$(pulumi preview --diff 2>&1)"
if ! grep -q "HERMES_GITOPS_DESIRED_SOURCE_SHA" <<<"$F5_PREVIEW" || ! grep -q "$NEW_DIST_SHA" <<<"$F5_PREVIEW"; then
  echo "FAIL: preview did not show the resolved-sha drift for the upstream commit; output was:" >&2
  echo "$F5_PREVIEW" | tail -30 >&2
  exit 1
fi
log "OK: plan-time sha resolution surfaced the upstream commit at preview"

pulumi up --yes --skip-preview >/dev/null

GITOPS_HEAD_MSG="$(git --git-dir "$WORKDIR/gitops.git" log -1 --format=%s main)"
if ! grep -q "gitops-emitter: update e2e-agent 0.2.0" <<<"$GITOPS_HEAD_MSG"; then
  echo "FAIL: expected an 'update' commit for 0.2.0, got: $GITOPS_HEAD_MSG" >&2
  exit 1
fi
PUSHED_SHA="$(git --git-dir "$WORKDIR/gitops.git" show "main:profiles/e2e-agent/profile.yaml" | sed -n 's/^  sha: //p')"
if [[ "$PUSHED_SHA" != "$NEW_DIST_SHA" ]]; then
  echo "FAIL: pushed record sha $PUSHED_SHA != new distribution sha $NEW_DIST_SHA" >&2
  exit 1
fi
log "OK: update path re-pushed the new sha with an 'update' commit message"

log "== pulumi up (no upstream movement): must be a no-op =="
pulumi up --yes --expect-no-changes >/dev/null

# --- 8e. F6 decommission (issue #24): removing the agent from stack
#         config must prune profiles/<name>/ from the GitOps repo on the
#         next `pulumi up`, with a decommission commit. ---
log "== F6: removing the agent from stack config, pulumi up must prune the record =="
pulumi config rm --path 'hermes-gitops-bootstrap:agents' >/dev/null
pulumi up --yes --skip-preview >/dev/null
if git --git-dir "$WORKDIR/gitops.git" cat-file -e "main:profiles/e2e-agent/profile.yaml" 2>/dev/null; then
  echo "FAIL: profiles/e2e-agent/ still present after removing the agent from stack config" >&2
  exit 1
fi
DECOM_MSG="$(git --git-dir "$WORKDIR/gitops.git" log -1 --format=%s main)"
if ! grep -q "gitops-emitter: decommission e2e-agent" <<<"$DECOM_MSG"; then
  echo "FAIL: expected a decommission commit, got: $DECOM_MSG" >&2
  exit 1
fi
log "OK: agent removal pruned profiles/e2e-agent/ with a decommission commit"

echo
echo "=========================================================="
echo "PASS: bootstrap stages 1-2 verified end-to-end"
echo "  - real fork hermes CLI installed + verified via uv tool install"
echo "  - real gitops-emitter plugin discovered on the hermes_agent.plugins"
echo "    entry point"
echo "  - real 'hermes profile install' pushed bootstrap/ + profile.yaml to"
echo "    a local bare git repo"
echo "  - profile.yaml valid against schemas/hermesprofile/v1alpha3"
echo "  - second 'pulumi up' was a no-op"
echo "  - deleted tool venv self-healed on the next 'pulumi up' (D2)"
echo "  - upstream mutable-ref commit re-triggered a real 'hermes profile"
echo "    update' push with the new sha (F5)"
echo "  - removing the agent from stack config pruned its record on the"
echo "    next 'pulumi up' (F6)"
echo "=========================================================="
