#!/usr/bin/env bash
# The eve-agent chart's process-start contract, proven in Docker without a
# cluster (ADR-149). Needs Docker and network (npm registry); runs nowhere
# in `make test` - like `make e2e`, it is its own target, `make eve-boot-test`.
#
# What it proves, in order:
#   1. the eve-runtime image builds from versions.json's pin;
#   2. the chart's boot.sh (rendered, not a copy) converges the example Eve
#      project from a git source at one sha: clone, npm ci, the platform
#      pin check, eve build, stamp;
#   3. a second boot at the same sha does no work;
#   4. `eve start` on the built output answers GET /eve/v1/health 200,
#      refuses an anonymous and a wrongly-authenticated POST /eve/v1/session
#      with 401 + a Basic challenge, and accepts the minted credential.
# A real model turn is NOT part of this script (no credential here) - that
# is `hg test` / `hg agent prove` on the local loop.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${EVE_RUNTIME_IMAGE:-eve-runtime:hermes-gitops-dev}"
PORT="${EVE_BOOT_TEST_PORT:-3017}"
WORK="$(mktemp -d)"
CONTAINER="eve-boot-test-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
FAIL=0
ok()   { echo "OK   $*"; }
fail() { echo "FAIL $*"; FAIL=$((FAIL+1)); }

echo "== 1. image =="
bash "$REPO_ROOT/harness/eve/image/build.sh" "$IMAGE" >/dev/null
EVE_PIN="$(python3 -c "import json;print(json.load(open('$REPO_ROOT/versions.json'))['runtimes']['eve']['version'])")"
IMAGE_EVE="$(docker run --rm "$IMAGE" eve --version)"
[[ "$IMAGE_EVE" == "$EVE_PIN" ]] && ok "image ships eve@$IMAGE_EVE" || fail "image ships eve@$IMAGE_EVE, versions.json pins $EVE_PIN"

echo "== 2. boot.sh converges the example project =="
mkdir -p "$WORK/repo" "$WORK/app"
cp -r "$REPO_ROOT/examples/eve-agent/agents" "$WORK/repo/"
git -C "$WORK/repo" init -q -b main
git -C "$WORK/repo" -c user.email=t@t -c user.name=t add -A
git -C "$WORK/repo" -c user.email=t@t -c user.name=t commit -q -m init
SHA="$(git -C "$WORK/repo" rev-parse HEAD)"
mkdir -p "$WORK/scripts"
helm template ag-eve-echo "$REPO_ROOT/harness/eve/charts/eve-agent" --namespace ag-eve-echo \
  -f "$REPO_ROOT/plugin/tests/chart/fixtures/eve-record-minimal.yaml" \
  | python3 -c "
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if d and d['kind'] == 'ConfigMap':
        for k, v in d['data'].items():
            open('$WORK/scripts/' + k, 'w').write(v)"
# The example authors its own channel; delete it from the throwaway repo so
# the boot script's default-channel branch is the one exercised here.
git -C "$WORK/repo" rm -q agents/echo/agent/channels/eve.ts
git -C "$WORK/repo" -c user.email=t@t -c user.name=t commit -q -m "no authored channel"
SHA="$(git -C "$WORK/repo" rev-parse HEAD)"
chmod -R a+rwX "$WORK/app"
boot() {
  docker run --rm --user 1000:1000 \
    -v "$WORK/repo:/src-repo:ro" -v "$WORK/app:/app" -v "$WORK/scripts:/scripts:ro" \
    -e EVE_DIST_SOURCE=/src-repo -e EVE_DIST_SHA="$SHA" -e EVE_DIST_SUBDIR=agents/echo \
    "$IMAGE" sh /scripts/boot.sh
}
if boot > "$WORK/boot1.log" 2>&1; then
  grep -q "built $SHA with eve@$EVE_PIN" "$WORK/boot1.log" && ok "first boot built $SHA" || fail "first boot did not report the build"
  [[ -f "$WORK/app/.hermes-gitops/installed_sha" && "$(cat "$WORK/app/.hermes-gitops/installed_sha")" == "$SHA" ]] \
    && ok "stamp records the sha" || fail "stamp missing or wrong"
  [[ -d "$WORK/app/src/agents/echo/.output" ]] && ok ".output/ exists" || fail "no .output/"
  cmp -s "$WORK/app/src/agents/echo/agent/channels/eve.ts" "$REPO_ROOT/harness/eve/charts/eve-agent/files/channel-eve.ts" \
    && ok "default channel installed byte-for-byte" || fail "default channel missing or differs"
else
  fail "first boot exited non-zero:"; tail -30 "$WORK/boot1.log" | sed 's/^/       /'
fi
echo "== 3. a second boot at the same sha skips =="
if boot > "$WORK/boot2.log" 2>&1 && grep -q "skipping rebuild" "$WORK/boot2.log"; then
  ok "second boot skipped"
else
  fail "second boot did not skip:"; tail -5 "$WORK/boot2.log" | sed 's/^/       /'
fi

echo "== 3a. the build receipt describes what was built (ADR 0195) =="
RECEIPT="$WORK/app/.hermes-gitops/build-receipt.json"
if [[ -f "$RECEIPT" ]] && python3 -c "
import json, sys
r = json.load(open('$RECEIPT'))
assert r['sourceSha'] == '$SHA', r
assert r['buildKey'] == '$SHA', r
assert r['eveVersion'] == '$EVE_PIN', r
assert r['imageEveVersion'] == '$EVE_PIN', r
assert r['builtAt'].endswith('Z'), r
"; then
  ok "receipt records the source sha, build key and eve release"
else
  fail "receipt missing or wrong:"; cat "$RECEIPT" 2>/dev/null | sed 's/^/       /'
fi
# A volume built before receipts existed keeps its stamp: the skip path fills one in
# rather than forcing a rebuild for a file the startup gate needs.
rm -f "$RECEIPT"
if boot > "$WORK/boot-receipt.log" 2>&1 && grep -q "skipping rebuild" "$WORK/boot-receipt.log" && [[ -f "$RECEIPT" ]]; then
  ok "a build with no receipt gains one without rebuilding"
else
  fail "skip path did not write a receipt:"; tail -5 "$WORK/boot-receipt.log" | sed 's/^/       /'
fi
# A CONFIGURATION change moves the runtime-manifest digest without changing the build
# key. The receipt has to follow it, or the startup gate would refuse this pod forever.
if docker run --rm --user 1000:1000 \
    -v "$WORK/repo:/src-repo:ro" -v "$WORK/app:/app" -v "$WORK/scripts:/scripts:ro" \
    -e EVE_DIST_SOURCE=/src-repo -e EVE_DIST_SHA="$SHA" -e EVE_DIST_SUBDIR=agents/echo \
    -e HG_RUNTIME_DIGEST=config-changed-digest \
    "$IMAGE" sh /scripts/boot.sh > "$WORK/boot-config.log" 2>&1 \
    && grep -q "skipping rebuild" "$WORK/boot-config.log" \
    && [[ "$(python3 -c "import json;print(json.load(open('$RECEIPT'))['runtimeDigest'])")" == "config-changed-digest" ]]; then
  ok "a config-only change updates the receipt without rebuilding"
else
  fail "receipt did not follow the runtime digest:"; tail -5 "$WORK/boot-config.log" | sed 's/^/       /'
fi

echo "== 3b. a runtime pin refuses an image shipping another eve (ADR 0192) =="
# EXPECTED_EVE_VERSION is what the record was rendered for; this image ships
# $EVE_PIN. The mismatch must stop the build BEFORE any clone or npm install.
MISMATCH_LOG="$WORK/boot-mismatch.log"
if docker run --rm --user 1000:1000 \
    -v "$WORK/repo:/src-repo:ro" -v "$WORK/app:/app" -v "$WORK/scripts:/scripts:ro" \
    -e EVE_DIST_SOURCE=/src-repo -e EVE_DIST_SHA="$SHA" -e EVE_DIST_SUBDIR=agents/echo \
    -e EXPECTED_EVE_VERSION=0.0.0-not-shipped \
    "$IMAGE" sh /scripts/boot.sh > "$MISMATCH_LOG" 2>&1; then
  fail "a pinned record on the wrong image booted anyway"
elif grep -q "pins eve@0.0.0-not-shipped but the image ships eve@$EVE_PIN" "$MISMATCH_LOG"; then
  ok "pinned record refuses an image shipping another eve"
else
  fail "pin mismatch did not report the disagreement:"; tail -5 "$MISMATCH_LOG" | sed 's/^/       /'
fi
# The pin that MATCHES the image is a no-op: the same skip path as before.
if docker run --rm --user 1000:1000 \
    -v "$WORK/repo:/src-repo:ro" -v "$WORK/app:/app" -v "$WORK/scripts:/scripts:ro" \
    -e EVE_DIST_SOURCE=/src-repo -e EVE_DIST_SHA="$SHA" -e EVE_DIST_SUBDIR=agents/echo \
    -e EXPECTED_EVE_VERSION="$EVE_PIN" \
    "$IMAGE" sh /scripts/boot.sh > "$WORK/boot-match.log" 2>&1 && grep -q "skipping rebuild" "$WORK/boot-match.log"; then
  ok "a matching pin changes nothing"
else
  fail "a matching pin did not boot like an unpinned record:"; tail -8 "$WORK/boot-match.log" | sed 's/^/       /'
fi

echo "== 4. eve start serves the route contract =="
# The credential arrives the way the chart delivers it: a mounted file,
# read per request by the default channel.
mkdir -p "$WORK/route-auth" && printf 'boot-test-secret' > "$WORK/route-auth/password" && chmod -R a+rX "$WORK/route-auth"
docker run -d --name "$CONTAINER" --user 1000:1000 -p "127.0.0.1:$PORT:3000" \
  -v "$WORK/app:/app" -v "$WORK/route-auth:/run/secrets/route-auth:ro" -w /app/src/agents/echo \
  -e HOME=/app/home -e PORT=3000 -e NODE_ENV=production \
  -e ROUTE_AUTH_BASIC_USERNAME=agent -e ROUTE_AUTH_BASIC_PASSWORD_FILE=/run/secrets/route-auth/password \
  "$IMAGE" ./node_modules/.bin/eve start --host 0.0.0.0 >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/eve/v1/health" >/dev/null 2>&1 && break; sleep 1
done
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
BODY='{"message":"ping"}'
H=(-H 'content-type: application/json')
[[ "$(code "http://127.0.0.1:$PORT/eve/v1/health")" == "200" ]] && ok "health 200" || fail "health not 200"
[[ "$(code -X POST "${H[@]}" -d "$BODY" "http://127.0.0.1:$PORT/eve/v1/session")" == "401" ]] \
  && ok "anonymous session 401" || fail "anonymous session not 401"
curl -sS -D - -o /dev/null -X POST "${H[@]}" -d "$BODY" "http://127.0.0.1:$PORT/eve/v1/session" \
  | grep -qi '^www-authenticate: Basic' && ok "401 carries a Basic challenge" || fail "no Basic challenge"
[[ "$(code -u agent:wrong -X POST "${H[@]}" -d "$BODY" "http://127.0.0.1:$PORT/eve/v1/session")" == "401" ]] \
  && ok "wrong credential 401" || fail "wrong credential not 401"
# The documented create-session contract (docs/channels/eve.mdx):
# {"ok":true,"sessionId":"...","status":"accepted"}. No model key is set,
# so the TURN will fail later on its stream - but acceptance of the request
# under the minted credential is what this proves.
GOOD="$(curl -sS -u agent:boot-test-secret -X POST "${H[@]}" -d "$BODY" "http://127.0.0.1:$PORT/eve/v1/session")"
if python3 -c "import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get('ok') is True and d.get('status')=='accepted' and d.get('sessionId') else 1)" "$GOOD"; then
  ok "minted credential accepted: $GOOD"
else
  fail "minted credential not accepted: $GOOD"
fi
# The same secret as a bearer (what `eve eval --url` sends via EVE_EVAL_AUTH_TOKEN).
BEAR="$(code -H 'authorization: Bearer boot-test-secret' -X POST "${H[@]}" -d "$BODY" "http://127.0.0.1:$PORT/eve/v1/session")"
[[ "$BEAR" != "401" && "$BEAR" != "403" ]] && ok "minted credential accepted as a bearer too ($BEAR)" || fail "bearer form rejected ($BEAR)"
[[ "$(code -H 'authorization: Bearer wrong' -X POST "${H[@]}" -d "$BODY" "http://127.0.0.1:$PORT/eve/v1/session")" == "401" ]] \
  && ok "wrong bearer 401" || fail "wrong bearer not 401"
# Rotation without restart: the default channel reads the mounted file per
# request, so a re-minted Secret must take effect on the running process.
printf 'rotated-secret' > "$WORK/route-auth/password"
[[ "$(code -u agent:boot-test-secret -X POST "${H[@]}" -d "$BODY" "http://127.0.0.1:$PORT/eve/v1/session")" == "401" ]] \
  && ok "old credential refused after rotation" || fail "old credential still accepted after rotation"
ROT="$(code -u agent:rotated-secret -X POST "${H[@]}" -d "$BODY" "http://127.0.0.1:$PORT/eve/v1/session")"
[[ "$ROT" != "401" && "$ROT" != "403" ]] && ok "rotated credential accepted without a restart ($ROT)" || fail "rotated credential rejected ($ROT)"

echo "== 5. the startup gate admits the intended build and refuses any other (ADR 0195) =="
# The real path: the receipt this build wrote, on the volume, plus the health
# endpoint the running agent serves. verify-build.mjs is the startup probe.
gate() {
  docker run --rm --network host -v "$WORK/app:/app" -v "$WORK/scripts:/scripts:ro" \
    -e HG_BUILD_RECEIPT=/app/.hermes-gitops/build-receipt.json -e PORT="$PORT" "$@" \
    "$IMAGE" node /scripts/verify-build.mjs
}
if gate -e HG_EXPECTED_SOURCE_SHA="$SHA" -e HG_EXPECTED_BUILD_KEY="$SHA" -e HG_EXPECTED_EVE_VERSION="$EVE_PIN" >"$WORK/gate-ok.log" 2>&1; then
  ok "the intended build passes the startup gate"
else
  fail "the intended build failed its own gate:"; cat "$WORK/gate-ok.log" | sed 's/^/       /'
fi
if ! gate -e HG_EXPECTED_SOURCE_SHA="0000000000000000000000000000000000000000" >"$WORK/gate-sha.log" 2>&1 \
    && grep -q "source commit" "$WORK/gate-sha.log"; then
  ok "a pod rendered for another commit is refused, and says which"
else
  fail "wrong source sha was not refused:"; cat "$WORK/gate-sha.log" | sed 's/^/       /'
fi
if ! gate -e HG_EXPECTED_EVE_VERSION="0.0.0-not-shipped" >"$WORK/gate-eve.log" 2>&1 \
    && grep -q "Eve release" "$WORK/gate-eve.log"; then
  ok "a pod rendered for another Eve release is refused"
else
  fail "wrong eve version was not refused:"; cat "$WORK/gate-eve.log" | sed 's/^/       /'
fi
# An unset expectation is a field this deployment does not pin: skipped, not failed.
if gate >"$WORK/gate-none.log" 2>&1; then
  ok "an unpinned deployment gates on health alone"
else
  fail "no expectations should still pass:"; cat "$WORK/gate-none.log" | sed 's/^/       /'
fi
# No receipt at all is a build that never completed: the agent must not go ready.
mv "$WORK/app/.hermes-gitops/build-receipt.json" "$WORK/app/.hermes-gitops/receipt.bak"
if ! gate -e HG_EXPECTED_SOURCE_SHA="$SHA" >"$WORK/gate-missing.log" 2>&1 && grep -q "no readable build receipt" "$WORK/gate-missing.log"; then
  ok "a volume with no receipt never becomes ready"
else
  fail "missing receipt was not refused:"; cat "$WORK/gate-missing.log" | sed 's/^/       /'
fi
mv "$WORK/app/.hermes-gitops/receipt.bak" "$WORK/app/.hermes-gitops/build-receipt.json"

echo
if [[ $FAIL -eq 0 ]]; then echo "eve-boot-test: PASS"; else echo "eve-boot-test: $FAIL FAILURE(S)"; exit 1; fi
