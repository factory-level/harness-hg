#!/usr/bin/env bash
# check-retired-paths.sh — the #672 grep-gate: no LIVING reference to a
# tree the final-pass retired may exist, so the old paths cannot creep
# back through copy-paste. `make retired-paths` (part of `make test`).
#
# What counts as retired:
#   plugin/schemas        -> agent-bundle-contracts/   (#651)
#   infra/charts          -> harness/*/charts, control-plane/*/chart (#652/#658)
#   dashboard/src         -> nexus-ui/src              (#668)
#   dashboard/nexus       -> control-plane/nexus       (#668; `deployments/
#                            dashboard/nexus-plan.json` is a DESTINATION-repo
#                            path and stays legal)
#   the ADR 0161 aliases  -> `hg event emit`, `hg chatops inspect`,
#                            `hg platform backup prove-recovery`
#
# What is exempt, and why (each is a tree whose CONTENT is the record of
# the old world, not a living reference):
#   _docs/adr/                     history is written as it happened
#   agent-bundle-contracts/        frozen; descriptions never mutate
#   cli/schemas/                   frozen evals contract, same rule
#   (files marked GENERATED)       generated FROM the frozen schemas — matched
#                                  by CONTENT, not by path: excluding
#                                  `_docs/wiki/reference` wholesale also hid
#                                  `contracts/index.md`, the one hand-written
#                                  page in it, which kept dead `infra/charts/`
#                                  paths for months
#   _docs/wiki/assets/*.svg        generated artifacts
#   _docs/design/nexus-ui/         the extraction record of the old UI
#   nexus-ui/design/impeccable/    same — the archived design record
#   maintainers/final-pass/        the refactor's own disposition ledgers
#   maintainers/landing.md, landing/, _docs/wiki/stylesheets/extra.css,
#   infra/scripts/generate-mark-svg.mjs, nexus-ui/src/primitives/
#                                  provenance comments: they record what a
#                                  value was PORTED FROM, and rewriting
#                                  that would falsify the record
#   plugin/tests/chart/            goldens/fixtures of the frozen test world
#   _docs/architecture/, CLAUDE.md, factory-system-reference.md
#                                  may state that a path WAS deleted
#   this script and its Makefile stanza
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PATTERN='plugin/schemas|infra/charts|dashboard/src|dashboard/nexus([^-]|$)|hg event emit|hg chatops inspect|prove-recovery|quickstart-pulumi|hg eve |--hermes-home'

EXEMPT=(
  ':(exclude)_docs/adr'
  ':(exclude)agent-bundle-contracts'
  ':(exclude)cli/schemas'
  ':(exclude)_docs/wiki/assets'
  ':(exclude)_docs/design/nexus-ui'
  ':(exclude)nexus-ui/design/impeccable'
  ':(exclude)maintainers/final-pass'
  ':(exclude)maintainers/landing.md'
  ':(exclude)landing'
  ':(exclude)_docs/wiki/stylesheets/extra.css'
  ':(exclude)infra/scripts/generate-mark-svg.mjs'
  ':(exclude)nexus-ui/src/primitives'
  ':(exclude)plugin/tests/chart'
  ':(exclude)_docs/architecture'
  ':(exclude)CLAUDE.md'
  ':(exclude)README.md'
  ':(exclude)factory-system-reference.md'
  ':(exclude)infra/scripts/check-retired-paths.sh'
  ':(exclude)cli/tests/commands-grammar.test.ts'
  ':(exclude)Makefile'
)

# Drop hits in generated files: they are rendered from the frozen schemas
# and the CLI manifest, so a retired string in one is a generator bug, caught
# by docs-drift / cli-docs-drift instead.
drop_generated() { while IFS= read -r line; do
  [ -n "$line" ] || continue
  grep -q GENERATED "${line%%:*}" 2>/dev/null || printf '%s\n' "$line"
done; }

HITS="$(git grep -nIE "$PATTERN" -- . "${EXEMPT[@]}" 2>/dev/null | drop_generated || true)"

# The PUBLISHED wiki additionally carries no retired product or repo name.
# Scoped to _docs/wiki because the rest of the tree still has hundreds of
# these to sweep (#649's deferred half) and failing on them helps nobody.
#   - vocabulary.md is the term REGISTER: its "words we avoid" table has to
#     name the retired term to tell you not to use it.
WIKI_PATTERN='Gatus|gatus|claude-plugins|_old-docs|infra/images|hermes-gitops-plugin|social-media\.hermes-gitops|Hermes Mercury'
WIKI_HITS="$(git grep -nIE "$WIKI_PATTERN" -- '_docs/wiki' \
  ':(exclude)_docs/wiki/vocabulary.md' 2>/dev/null | drop_generated || true)"
if [ -n "$WIKI_HITS" ]; then
  echo "retired-paths: the published wiki names a retired tree or product:" >&2
  echo "$WIKI_HITS" >&2
  exit 1
fi

if [ -n "$HITS" ]; then
  echo "retired-paths: living references to retired trees or aliases:" >&2
  echo "$HITS" >&2
  echo >&2
  echo "Fix the reference (see this script's header for each path's successor)." >&2
  echo "A deliberate historical mention belongs in an exempt tree, not here." >&2
  exit 1
fi
echo "retired-paths: clean (no living reference to plugin/schemas, infra/charts, dashboard/*, or dead aliases)"
