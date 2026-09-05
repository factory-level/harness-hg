#!/usr/bin/env bash
# Cut the public snapshot: this repository (the private ops fork) minus the
# operator overlay, as ONE orphan commit in a fresh clone, gated before it
# is pushed anywhere.
#
#   infra/scripts/public-snapshot.sh <out-dir> [<commit-subject>]
#
# What it does:
#   1. `git archive HEAD` into <out-dir>, then delete the overlay list.
#   2. Run the public-clean gate with NO exclusions and the full `make test`
#      inside the export, so the snapshot is proven on its own.
#   3. `git init` + one commit. Push it yourself: the script never touches a
#      remote.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:?usage: public-snapshot.sh <out-dir> [<subject>]}"
SUBJECT="${2:-chore: initial public release}"

# The operator overlay. Everything else in the tree is public by the
# public-clean gate's definition.
OVERLAY=(
  factory-system-reference.md
  infra/environments/factory.yaml
  infra/Pulumi.factory.yaml
  state/Pulumi.factory.yaml
  _old-docs
  _docs/adr/CHANGES.md
  DOCS_REFACTOR.md
  avatars
)

[ -e "$OUT" ] && { echo "public-snapshot: $OUT exists - refusing to overwrite"; exit 1; }
mkdir -p "$OUT"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$OUT"
for p in "${OVERLAY[@]}"; do rm -rf "$OUT/$p"; done

# The frozen legacy ledger leaves with the overlay: the ADR files that cite
# it by anchor are internal, but a dangling link would fail doc-links.
# Keep a one-line stub so those links resolve to an honest note.
mkdir -p "$OUT/_docs/adr"
cat > "$OUT/_docs/adr/CHANGES.md" <<'EOF'
# Legacy decision ledger

The pre-2026-08-25 ledger (154 records addressed by `#adr-N` anchors) stayed in the
private ops fork. Decisions since then are the numbered `NNNN-<name>.md` files beside
this file.
EOF

(cd "$OUT" && git init -q && git add -A && git -c user.name=harness-hg -c user.email=hg-bot@users.noreply.github.com commit -q -m "$SUBJECT")
echo "== gates inside the export"
# After the commit: the gate is a git grep, and an uninitialised tree greps nothing.
(cd "$OUT" && bash infra/scripts/check-public-clean.sh --strict)
(cd "$OUT" && make test >"$OUT/.snapshot-make-test.log" 2>&1) \
  || { echo "public-snapshot: make test FAILED in the export - see $OUT/.snapshot-make-test.log"; exit 1; }
rm -f "$OUT/.snapshot-make-test.log"
# make test writes build output (site/, _docs/site/); the commit predates it
# and .gitignore covers it, so the tree is still one clean commit.
(cd "$OUT" && git status --short | head -5)
echo "== snapshot ready at $OUT ($(cd "$OUT" && git rev-parse --short HEAD)); push it with:"
echo "   git -C $OUT remote add origin git@github.com:factory-level/harness-hg.git && git -C $OUT push -u origin HEAD:main"
# A force-pushed orphan commit has no base to diff, so the wiki workflow's
# path filter never matches and no run starts: dispatch it by hand.
echo "   then: gh workflow run wiki -R factory-level/harness-hg --ref main   (the push trigger's path filter cannot see an orphan commit)"
