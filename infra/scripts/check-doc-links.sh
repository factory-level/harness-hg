#!/usr/bin/env bash
# Every repo-local documentation reference resolves (#137).
#
# Two classes, both of which had rotted after the restructure moved
# schemas/ -> agent-bundle-contracts/, gitops_emitter/ -> plugin/gitops_emitter/
# and the wiki -> _docs/{design,architecture,adr,runbooks}:
#
#   1. Markdown links to repo-local paths, resolved relative to their file.
#   2. In-CODE references to doc paths - comments in charts, values files,
#      Pulumi programs, shell scripts and TypeScript. `mkdocs --strict`
#      never saw these, because they are not markdown links and not in the
#      built site, so ~85 of them pointed at files that had not existed
#      for months.
#
# Deliberately NOT checked: _old-docs/ (archived, unbuilt, known-stale by
# design) and _docs/site/ (build output). A link INTO _old-docs is legal - it is
# where superseded material actually lives - but it is not checked for
# accuracy, only existence.
set -uo pipefail

cd "$(dirname "$0")/../.."

fail=0
note() { echo "BROKEN  $1"; fail=1; }

# Paths git tracks, minus the archives and build output.
mapfile -t FILES < <(git ls-files | grep -vE '^(_old-docs|_docs/site)/')

# --- 1. markdown links -----------------------------------------------------
for f in "${FILES[@]}"; do
  case "$f" in *.md) ;; *) continue;; esac
  d=$(dirname "$f")
  while IFS= read -r link; do
    case "$link" in http*|"#"*|mailto:*|"") continue;; esac
    p="${link%%#*}"
    [ -z "$p" ] && continue
    # Regexes and glob patterns inside prose look like links to a naive
    # matcher ("[-a-z0-9]*[a-z0-9]"). A real path has no bracket or brace.
    case "$p" in *"["*|*"{"*|*"|"*|*"<"*) continue;; esac
    if [ "${p#/}" != "$p" ]; then t=".$p"; else t="$d/$p"; fi
    [ -e "$t" ] || note "$f -> $link"
  done < <(grep -oE '\]\(([^)]+)\)' "$f" 2>/dev/null | sed 's/^](//; s/)$//')
done

# --- 2. in-code doc references --------------------------------------------
for f in "${FILES[@]}"; do
  case "$f" in *.md) continue;; esac
  while IFS= read -r p; do
    [ -e "$p" ] || note "$f -> $p"
  done < <(grep -oE '(_docs|_old-docs)/[A-Za-z0-9_/.-]+\.md' "$f" 2>/dev/null | sort -u)
done

if [ "$fail" -eq 0 ]; then
  echo "OK   every repo-local documentation reference resolves"
else
  echo
  echo "A reference points at a file that does not exist. Either the target"
  echo "moved (repoint it) or it was never written (say so, or drop the link)."
fi
exit "$fail"
