#!/usr/bin/env bash
# The published wiki never cites an ADR (#825). ADRs are the internal
# decision ledger; a reader of the manual gets the claim, not the history.
# Generated reference pages inherit their text from schema descriptions and
# cli/src/commands.ts, so a hit there means the SOURCE carries the citation.
set -uo pipefail
cd "$(dirname "$0")/../.."
hits=$(grep -rnE 'ADR[- ]?[0-9]|_docs/adr/|#adr-|CHANGES\.md' _docs/wiki --include=*.md || true)
if [ -n "$hits" ]; then
  echo "$hits"
  echo
  echo "wiki: ADR citations above - keep the claim, drop the citation."
  exit 1
fi
echo "OK   the wiki cites no ADR"
