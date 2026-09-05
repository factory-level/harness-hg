#!/usr/bin/env bash
# record-cmp.sh — the deployment-neutrality proof, scripted (#669).
#
# Renders every persona profile's record from TWO git refs of this
# platform repo (the persona declarations are held constant at their
# checked-out state) and byte-compares the results. This is the
# CLAUDE.md "render before and after and cmp them" discipline as a
# command instead of a hand procedure: a byte-identical record is the
# only honest form of "this change is deployment-safe"; anything else
# is enumerated per profile with a diff.
#
#   infra/scripts/record-cmp.sh <ref-a> <ref-b> [persona-dir]
#
# The final-pass baseline is 7a3fefbd (the commit before #678, the
# first final-pass merge):
#
#   infra/scripts/record-cmp.sh 7a3fefbd main
#
# Uses git worktrees so neither ref disturbs the working copy; each
# worktree renders through its own uv environment (first run per ref
# resolves it — slow once, cached after).
set -euo pipefail

REF_A="${1:?usage: record-cmp.sh <ref-a> <ref-b> [persona-dir]}"
REF_B="${2:?usage: record-cmp.sh <ref-a> <ref-b> [persona-dir]}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERSONA_DIR="${3:-$ROOT/../my-team}"
[ -d "$PERSONA_DIR/distributions" ] || { echo "no distributions/ under $PERSONA_DIR" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORK/a" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree remove --force "$WORK/b" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

git -C "$ROOT" worktree add -q --detach "$WORK/a" "$REF_A"
git -C "$ROOT" worktree add -q --detach "$WORK/b" "$REF_B"

SHA_ZERO=0000000000000000000000000000000000000000

# A profile whose apps declare valuesRequired secrets (e.g. postiz's
# jwtSecret) cannot render without operator overrides. For NEUTRALITY the
# override VALUES are irrelevant - both refs get the identical dummy - so
# the emitter's own error message is parsed into a dummy appValues map
# and the render retried once. The dummy never leaves the tempdir.
synth_app_values() { # <render-stderr-file> -> JSON on stdout
  python3 - "$1" <<'PY'
import json, re, sys
values = {}
for m in re.finditer(r"app '([^']+)' is missing required value '([^']+)'", open(sys.argv[1]).read()):
    node = values.setdefault(m.group(1), {})
    *parents, leaf = m.group(2).split(".")
    for p in parents:
        node = node.setdefault(p, {})
    node[leaf] = "record-cmp-dummy"
print(json.dumps(values))
PY
}

render() { # <worktree> <profile-dir> <name> <out-file>
  local tree="$1" dist="$2" name="$3" out="$4" errf="$WORK/render.err"
  if (cd "$tree" && uv run --quiet python cli/render_record.py \
      --profile "$dist" --name "$name" --source local-preview --sha "$SHA_ZERO") >"$out" 2>"$errf"; then
    return 0
  fi
  local dummy
  dummy="$(synth_app_values "$errf")"
  if [ "$dummy" = "{}" ]; then cat "$errf" >&2; return 1; fi
  (cd "$tree" && uv run --quiet python cli/render_record.py \
    --profile "$dist" --name "$name" --source local-preview --sha "$SHA_ZERO" \
    --app-values "$dummy") >"$out"
}

echo "record-cmp: $REF_A vs $REF_B"
echo "  persona: $PERSONA_DIR"
DIFFS=0
for dist in "$PERSONA_DIR"/distributions/*/; do
  name="$(grep -m1 '^name:' "$dist/distribution.yaml" | awk '{print $2}')"
  [ -n "$name" ] || { echo "  ?? $dist has no name: in distribution.yaml"; continue; }
  a_out="$WORK/$name.a.yaml"; b_out="$WORK/$name.b.yaml"
  render "$WORK/a" "$dist" "$name" "$a_out"
  render "$WORK/b" "$dist" "$name" "$b_out"
  if cmp -s "$a_out" "$b_out"; then
    echo "  == $name: byte-identical"
  else
    DIFFS=$((DIFFS + 1))
    echo "  != $name: DIFFERS"
    diff -u "$a_out" "$b_out" | sed 's/^/     /' | head -40
  fi
done

echo
if [ "$DIFFS" -gt 0 ]; then
  echo "record-cmp: $DIFFS profile(s) differ - every hunk above must trace to a signed-off rename"
  echo "(maintainers/final-pass/naming-scheme.md) or the change is NOT deployment-neutral."
  exit 1
fi
echo "record-cmp: all profiles byte-identical - deployment-neutral."
