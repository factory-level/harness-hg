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
  infra/environments/factory-proactive-secrets.py
  infra/environments/factory-inferops-prepare.py
  infra/environments/tests/test_factory_inferops_prepare.py
  infra/environments/factory-proactive-volumes.py
  infra/environments/factory-proactive-topology.ts
  infra/environments/factory-communication
  infra/Pulumi.factory.yaml
  state/Pulumi.factory.yaml
  _old-docs
  _docs/adr/CHANGES.md
  DOCS_REFACTOR.md
  avatars
  PRODUCT.md
  .github/workflows/DISABLED.md
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
# Chain the snapshot onto the public repo's main so history is kept: a PR
# merged there between cuts stays an ancestor (its content is carried by
# the ops fork, where every public PR is ported before the next cut), and
# the push is a fast-forward, never a force. The first cut has no parent.
PUBLIC_REMOTE="${PUBLIC_REMOTE:-https://github.com/factory-level/harness-hg.git}"
if git -C "$OUT" fetch -q "$PUBLIC_REMOTE" main 2>/dev/null; then
  parent="$(git -C "$OUT" rev-parse FETCH_HEAD)"
  chained="$(cd "$OUT" && git -c user.name=harness-hg -c user.email=hg-bot@users.noreply.github.com commit-tree "HEAD^{tree}" -p "$parent" -m "$SUBJECT")"
  git -C "$OUT" update-ref refs/heads/main "$chained" && git -C "$OUT" reset -q --hard main
  echo "== chained onto public main ${parent:0:8}"
else
  echo "== public main not reachable - orphan commit (first cut, or offline)"
fi
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
echo "   git -C $OUT push $PUBLIC_REMOTE HEAD:main && git -C $OUT tag -a vX.Y.Z -m ... && git -C $OUT push $PUBLIC_REMOTE vX.Y.Z"
# A force-pushed orphan commit has no base to diff, so the wiki workflow's
# path filter never matches and no run starts: dispatch it by hand.
echo "   then: gh workflow run wiki -R factory-level/harness-hg --ref main   (the push trigger's path filter cannot see an orphan commit)"
