#!/usr/bin/env bash
# check-quickstart-drift.sh — #675's docs-vs-runs gate. Each loop
# quickstart in the wiki must contain, in order, every `hg` invocation
# its executable loop run asserts (ADR 0170: the scripts are the
# acceptance surface; the prose defers to them). Extra prose-only
# commands are welcome; a step the script proves but the page omits is
# a failure. Coverage is a SUBSEQUENCE check on the command words
# (verb + subject), not exact argv - flags and paths vary by reader.
#
#   make quickstart-drift   (part of `make test`; cluster-free, fast)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

FAIL=0

# The hg command sequence a loop SCRIPT asserts: `check "hg ..." ...`
# labels (agent-bundle/ops) or `"${CLI[@]}" <verb>` lines (e2e-local).
script_commands() { # <script> -> "hg <words>" lines
  case "$1" in
    *e2e-local.sh)
      grep -oE '"\$\{CLI\[@\]\}" [a-z-]+( [a-z-]+)?' "$1" \
        | sed 's/"\${CLI\[@\]}" /hg /' ;;
    *)
      grep -oE 'check "hg [^"]*"' "$1" | sed 's/^check "//; s/"$//' ;;
  esac
}

# First two words after `hg` (subject [verb]) - the coverage key.
key() { awk '{ if (NF >= 3) print $1, $2, $3; else print }'; }

# `hg ...` lines inside the page's ```-fences.
page_commands() { # <page>
  awk '/^```/{f=!f; next} f && /^ *hg /' "$1" | sed 's/^ *//'
}

check_pair() { # <loop-name> <script> <page> [exempt-keys...]
  local loop="$1" script="$2" page="$3"; shift 3
  local exempt=("$@")
  if [ ! -f "$page" ]; then
    echo "FAIL [$loop] quickstart page $page does not exist"; FAIL=1; return
  fi
  local wanted have
  wanted="$(script_commands "$script" | key)"
  have="$(page_commands "$page" | key)"
  local pos=0
  while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    local skip=""
    for e in "${exempt[@]:-}"; do [ "$cmd" = "$e" ] && skip=1; done
    [ -n "$skip" ] && continue
    # subsequence: find cmd in `have` at or after pos
    local found
    found="$(printf '%s\n' "$have" | tail -n +$((pos + 1)) | grep -nxF "$cmd" | head -1 | cut -d: -f1 || true)"
    if [ -z "$found" ]; then
      echo "FAIL [$loop] the run asserts \`$cmd\` but $page's fences do not carry it (in order)"
      FAIL=1
    else
      pos=$((pos + found))
    fi
  done <<<"$wanted"
  echo "OK   [$loop] every asserted command appears, in order, in $(basename "$page")"
}

# Exemptions, each with its reason:
#   - the dev loop's e2e harness asserts hg reset/agent/eval/reconcile
#     legs that are ACCEPTANCE machinery, not the quickstart's
#     make-a-change story; the quickstart ends at the converge proof.
check_pair dev cli/e2e-local.sh _docs/wiki/get-started/dev-quickstart.md \
  "hg reset" "hg reset --nuclear" "hg agent apply" "hg agent show" "hg eval --dir" \
  "hg reconcile install" "hg reconcile prove" "hg reconcile run" "hg reconcile status"

check_pair agent-bundle cli/loops/agent-bundle-loop.sh _docs/wiki/get-started/agent-team-repo.md

#   - the ops loop's day-0 head (env new) IS in the page; the prove
#     segment's per-subject verbs ride `hg launch prove` in prose - the
#     page must still carry reconcile status + backup verify + launch
#     prove (the operator's dailies), so only edge prove (stack-bound
#     flags) is exempt.
check_pair ops cli/loops/ops-loop.sh _docs/wiki/get-started/host-an-environment.md \
  "hg edge prove" "hg connection prove" "hg observability prove" \
  "hg auth prove" "hg grafana prove"

# The REVERSE check, over the whole wiki. The subsequence check above
# deliberately welcomes extra prose commands, so a page can invoke a verb
# that does not exist and still pass - which is how the wiki printed
# `hg platform backup install-timer` while the parser rejected it, and how
# the runbooks (gated by nothing above) drifted for months. A command whose
# sub list contains "" takes positionals rather than a subcommand, so only
# subcommand-requiring commands are checked.
python3 infra/scripts/check-wiki-commands.py || FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "quickstart-drift: the pages lag the code - update the docs, not the scripts" >&2
  exit 1
fi
echo "quickstart-drift: every quickstart carries its loop's asserted sequence"
