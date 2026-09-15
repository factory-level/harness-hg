#!/usr/bin/env bash
# The eve-agent chart's operator-overlay build path (ADR 0194), proven without
# Docker or a cluster. Builds a throwaway source repository and overlay
# repository, computes the real content and tree hashes with
# files/overlay-apply.mjs, renders the REAL chart with that record, and runs the
# RENDERED boot.sh with EVE_BOOT_STOP_AFTER=overlays against local git (the
# record's https URL is mapped onto the local repository by url.insteadOf):
#   1. the rendered EVE_OVERLAY_DIGEST and pod annotation equal the digest
#      overlay-apply.mjs computes from the rendered lines;
#   2. boot.sh fetches every overlay at its commit and merges exactly the tree
#      the shared implementation produces, and writes no stamp;
#   3. the rebuild key is sha256(spec.sha, digest), and a record without
#      overlays keeps spec.sha as its key (existing agents do not rebuild);
#   4. content the record does not pin stops the build and clears a stale stamp;
#   5. an unfetchable commit stops the build;
#   6. a repository that is an option or carries a credential is refused
#      before git runs, and is never echoed.
# Needs helm, git, node and python3 with PyYAML. Invoked by
# infra/scripts/render-test.sh; standalone-runnable too.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART="$REPO_ROOT/harness/eve/charts/eve-agent"
export MJS="$CHART/files/overlay-apply.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAIL=0
ok()  { echo "[overlay-boot-test] OK   $*" >&2; }
bad() { echo "[overlay-boot-test] FAIL $*" >&2; FAIL=$((FAIL+1)); }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

# --- an Eve project at agents/echo in its source repository ------------------
SRC="$WORK/source"
mkdir -p "$SRC/agents/echo/agent/tools" "$SRC/agents/echo/agent/connections"
printf '{"name":"echo"}\n' > "$SRC/agents/echo/package.json"
printf '{}\n' > "$SRC/agents/echo/package-lock.json"
printf 'You are echo.\n' > "$SRC/agents/echo/agent/instructions.md"
printf 'export default 1;\n' > "$SRC/agents/echo/agent/connections/crm.ts"
printf 'export default {};\n' > "$SRC/agents/echo/agent/tools/lookup.ts"
git -C "$SRC" init -q -b main && git -C "$SRC" add -A && git -C "$SRC" commit -q -m source
SRC_SHA="$(git -C "$SRC" rev-parse HEAD)"

# --- the overlay repository, reachable at the record's https URL --------------
OVR="$WORK/overlays"
OVR_URL="https://example.invalid/overlays.git"
mkdir -p "$OVR/skills/brand-voice" "$OVR/echo"
printf -- '---\ndescription: brand voice\n---\n# Voice\n' > "$OVR/skills/brand-voice/SKILL.md"
printf 'export default 2;\n' > "$OVR/echo/crm.ts"
printf 'Always cite sources.\n' > "$OVR/echo/rules.md"
git -C "$OVR" init -q -b main
git -C "$OVR" config uploadpack.allowAnySHA1InWant true
git -C "$OVR" add -A && git -C "$OVR" commit -q -m overlays
OVR_SHA="$(git -C "$OVR" rev-parse HEAD)"
git config --file "$WORK/gitconfig" "url.$OVR.insteadOf" "$OVR_URL"
export GIT_CONFIG_GLOBAL="$WORK/gitconfig"

# --- a record values file per case, hashed by the shared implementation -------
cat > "$WORK/prepare.mjs" <<'NODE'
import fs from "node:fs";
import path from "node:path";
const { applyOverlays, contentHash } = await import(process.env.MJS);
const [overlayRepo, overlayUrl, overlayCommit, sourceProject, sourceSha, expected, out, tamper] = process.argv.slice(2);
const entry = (id, kind, mode, target, sourcePath) => mode === "remove" ? { id, kind, mode, target }
  : { id, kind, mode, target, source: { repository: overlayUrl, commit: overlayCommit, path: sourcePath }, contentHash: contentHash(path.join(overlayRepo, sourcePath)) };
const overlays = [
  entry("brand-voice", "skill", "append", "agent/skills/brand-voice", "skills/brand-voice"),
  entry("disable-bash", "tool", "remove", "agent/tools/bash.ts"),
  entry("retire-lookup", "file", "remove", "agent/tools/lookup.ts"),
  entry("crm", "connection", "override", "agent/connections/crm.ts", "echo/crm.ts"),
  entry("rules", "instructions", "append", "agent/instructions.md", "echo/rules.md"),
];
fs.cpSync(sourceProject, expected, { recursive: true });
const { treeHash } = applyOverlays({ project: expected, overlays, contentFor: o => path.join(overlayRepo, o.source.path) });
if (tamper === "content") overlays[3].contentHash = "a".repeat(64);
if (tamper === "commit") for (const o of overlays) if (o.source) o.source.commit = "b".repeat(40);
const spec = { persona: "echo", runtime: "eve", source: "https://github.com/example/echo.git", sha: sourceSha, sourceSubdir: "agents/echo" };
fs.writeFileSync(out, JSON.stringify({ spec: tamper === "none" ? spec : { ...spec, overlays, overlayTreeHash: treeHash } }));
NODE

render() { # <values> <case-dir>: render the chart, extract the boot files and the build env
  mkdir -p "$2/scripts"
  helm template ag-eve-echo "$CHART" --namespace ag-eve-echo -f "$1" > "$2/render.yaml"
  python3 - "$2" <<'PY'
import json, sys, yaml
out = sys.argv[1]
env = {}
for doc in yaml.safe_load_all(open(f"{out}/render.yaml")):
    if not doc:
        continue
    if doc["kind"] == "ConfigMap" and doc["metadata"]["name"].endswith("-boot"):
        for name, text in doc["data"].items():
            open(f"{out}/scripts/{name}", "w").write(text)
    if doc["kind"] == "StatefulSet":
        init = doc["spec"]["template"]["spec"]["initContainers"][0]
        env = {e["name"]: e["value"] for e in init["env"] if "value" in e}
        env["_annotation"] = (doc["spec"]["template"]["metadata"].get("annotations") or {}).get("harness-hg.factorylevel.dev/overlay-digest", "")
json.dump(env, open(f"{out}/env.json", "w"))
PY
}

env_value() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2"; }

boot() { # <case-dir>: run the rendered boot.sh the way the build container does, stopping after overlays
  local dir="$1"
  mkdir -p "$dir/app"
  set +e
  (
    eval "$(python3 -c '
import json, shlex, sys
env = json.load(open(sys.argv[1]))
for key in ("EVE_DIST_SHA", "EVE_DIST_SUBDIR", "EVE_OVERLAYS", "EVE_OVERLAY_TREE_HASH", "EVE_OVERLAY_DIGEST"):
    if key in env:
        print(f"export {key}={shlex.quote(env[key])}")
' "$dir/env.json")"
    export EVE_DIST_SOURCE="$SRC" EVE_DATA_ROOT="$dir/app" EVE_SCRIPTS_DIR="$dir/scripts" EVE_BOOT_STOP_AFTER=overlays
    sh "$dir/scripts/boot.sh"
  ) > "$dir/boot.log" 2>&1
  local status=$?
  set -e
  return $status
}

run_case() { # <name> <tamper>
  local dir="$WORK/$1"
  mkdir -p "$dir"
  node "$WORK/prepare.mjs" "$OVR" "$OVR_URL" "$OVR_SHA" "$SRC/agents/echo" "$SRC_SHA" "$dir/expected" "$dir/values.json" "$2"
  render "$dir/values.json" "$dir"
}

# 1-3: the approved overlays --------------------------------------------------
run_case good ok
GOOD="$WORK/good"
if node --input-type=module -e '
const { overlayDigest, parseOverlayLines } = await import(process.env.MJS);
const env = JSON.parse((await import("node:fs")).readFileSync(process.argv[1], "utf8"));
const digest = overlayDigest(parseOverlayLines(env.EVE_OVERLAYS), env.EVE_OVERLAY_TREE_HASH);
process.exit(digest === env.EVE_OVERLAY_DIGEST && digest === env._annotation ? 0 : 1);' "$GOOD/env.json"; then
  ok "rendered digest and pod annotation equal overlay-apply.mjs's digest"
else
  bad "rendered EVE_OVERLAY_DIGEST or annotation differs from overlay-apply.mjs's digest"
fi
if boot "$GOOD"; then
  if diff -r "$GOOD/expected/agent" "$GOOD/app/src/agents/echo/agent" >/dev/null; then
    ok "boot.sh fetched every overlay at its commit and merged the expected tree"
  else
    bad "boot.sh merged a different tree:"; diff -r "$GOOD/expected/agent" "$GOOD/app/src/agents/echo/agent" | sed 's/^/       /' >&2
  fi
  [[ ! -f "$GOOD/app/.hermes-gitops/installed_sha" ]] && ok "no stamp before the build" || bad "a stamp was written before the build"
  key="$(printf '%s\n%s' "$SRC_SHA" "$(env_value "$GOOD/env.json" EVE_OVERLAY_DIGEST)" | sha256sum | cut -d' ' -f1)"
  grep -q "build key ('$key')" "$GOOD/boot.log" && ok "the rebuild key is sha256(spec.sha, overlay digest)" || bad "rebuild key is not sha256(spec.sha, overlay digest)"
else
  bad "boot.sh refused approved overlays:"; tail -20 "$GOOD/boot.log" | sed 's/^/       /' >&2
fi

run_case plain none
if boot "$WORK/plain" && grep -q "build key ('$SRC_SHA')" "$WORK/plain/boot.log" && ! grep -q "\[build-agent\] overlay " "$WORK/plain/boot.log"; then
  ok "a record without overlays keeps spec.sha as its rebuild key"
else
  bad "a record without overlays changed its rebuild key or ran the overlay path:"; tail -10 "$WORK/plain/boot.log" | sed 's/^/       /' >&2
fi

# 4: content the record does not pin, over a stale stamp at the same key -------
run_case tampered content
TAMPERED="$WORK/tampered"
mkdir -p "$TAMPERED/app/.hermes-gitops"
printf '%s\n%s' "$SRC_SHA" "$(env_value "$TAMPERED/env.json" EVE_OVERLAY_DIGEST)" | sha256sum | cut -d' ' -f1 > "$TAMPERED/app/.hermes-gitops/installed_sha"
if boot "$TAMPERED"; then
  bad "boot.sh built with content the record does not pin"
else
  grep -q "the record pins" "$TAMPERED/boot.log" && ok "unpinned content stops the build" || { bad "unpinned content failed for another reason:"; tail -10 "$TAMPERED/boot.log" | sed 's/^/       /' >&2; }
  [[ ! -f "$TAMPERED/app/.hermes-gitops/installed_sha" ]] && ok "a failed rebuild leaves no stamp to skip on" || bad "a failed rebuild left its stamp in place"
fi

# 5: an unfetchable commit ----------------------------------------------------
run_case unfetchable commit
if boot "$WORK/unfetchable"; then
  bad "boot.sh built without fetching its overlays"
else
  grep -q "could not be fetched" "$WORK/unfetchable/boot.log" && ok "an unfetchable commit stops the build" || { bad "unfetchable commit failed for another reason:"; tail -10 "$WORK/unfetchable/boot.log" | sed 's/^/       /' >&2; }
fi

# 6: repositories that are options or carry credentials -----------------------
for name in injected credential; do
  dir="$WORK/$name"
  mkdir -p "$dir"
  cp -r "$GOOD/scripts" "$dir/scripts"
  case "$name" in
    injected) replacement="--upload-pack=touch${WORK}/pwned"; reason="is not an https:// or git@ URL" ;;
    credential) replacement="https://user:private-token-fixture@example.invalid/overlays.git"; reason="carries user info" ;;
  esac
  python3 - "$GOOD/env.json" "$dir/env.json" "$OVR_URL" "$replacement" <<'PY'
import json, sys
env = json.load(open(sys.argv[1]))
env["EVE_OVERLAYS"] = env["EVE_OVERLAYS"].replace(sys.argv[3], sys.argv[4])
json.dump(env, open(sys.argv[2], "w"))
PY
  if boot "$dir"; then
    bad "boot.sh accepted a $name repository"
  elif grep -q "$reason" "$dir/boot.log" && [[ ! -e "$WORK/pwned" ]] && ! grep -q "private-token-fixture\|upload-pack" "$dir/boot.log"; then
    ok "a $name repository is refused before git runs and is not echoed"
  else
    bad "a $name repository was not refused cleanly:"; tail -10 "$dir/boot.log" | sed 's/^/       /' >&2
  fi
done

if [[ $FAIL -eq 0 ]]; then echo "[overlay-boot-test] PASS" >&2; else echo "[overlay-boot-test] $FAIL FAILURE(S)" >&2; exit 1; fi
