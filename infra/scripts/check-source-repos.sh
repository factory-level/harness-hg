#!/usr/bin/env bash
# The Argo CD sourceRepos allowlist cannot silently diverge (#133).
#
# The allowlist is enforced TWICE, by design (design 02, authorities):
#
#   render time   harness/hermes/charts/hermes-profile/templates/_helpers.tpl
#                 `hermes.appsGuard`, reading cluster-values'
#                 appProject.sourceRepos - fails the render, naming the repo
#   server side   the AppProject's own sourceRepos in the GitOps repo's
#                 bootstrap/project.yaml - Argo CD refuses to sync
#
# Two enforcement points is the design and stays. What must not happen is
# the two enforcing DIFFERENT policies, which is a drift hazard in the very
# mechanism that keeps the platform/application boundary honest.
#
# WHAT THIS CHECKS, and why it is a CHECK rather than a generator.
#
# A correction first. An earlier version of this comment said full
# single-sourcing was blocked because bootstrap/ is seeded write-once. That
# was wrong: ADR-37 ended the write-once era, and bootstrap/project.yaml is
# in scaffold.py's _MANAGED_FILES - so the platform CAN and DOES update it,
# hash-gated, refusing only where an operator has edited it.
#
# The real reason the two files stay two files is different, and it is the
# reason they were split in the first place: they hold DIFFERENT SETS.
#
#   the platform's half   the GitOps repo itself and the platform chart
#                         repo. Every environment needs both. This is
#                         platform knowledge, it is templated into
#                         project.yaml, and the reconciler keeps it current.
#
#   the environment's     the remote helm repositories that environment's
#   half                  own apps pull from. Genuinely operator data, and
#                         it lives in cluster-values because that is where
#                         environment intent belongs. Since the
#                         __OPERATOR_SOURCE_REPOS__ token the scaffold
#                         RENDERS that list into project.yaml on every
#                         reconcile (oci:// entries twinned scheme-less,
#                         #187) - the operator still declares it once, in
#                         cluster-values; project.yaml is derived. Before
#                         the token, the managed file had no slot for the
#                         entries and every reconcile deleted them.
#
# Neither set swallows the other: the platform never invents entries for
# repositories it has not heard of, and the environment is never asked to
# restate the two the platform always needs.
#
# So: both halves reach project.yaml from their own source of truth, and
# this script proves the two enforcement points cannot enforce different
# policy about the platform half - plus that the render-time failure names
# BOTH places, because an operator who sees the render-time refusal must
# know the fix is cluster-values, and that project.yaml follows.
set -uo pipefail

cd "$(dirname "$0")/../.."

PROJECT=infra/gitops-template/bootstrap/project.yaml
VALUES=harness/hermes/charts/hermes-profile/values.yaml
HELPERS=harness/hermes/charts/hermes-profile/templates/_helpers.tpl

# Export for an EXTERNAL Argo CD (#177): the required set must be
# machine-readable from outside this chart, because an external instance has
# to have the allowlist REGISTERED into it rather than assuming it exists.
if [ "${1:-}" = "--json" ]; then
  printf '{"required":["__GITOPS_REPO_URL__","__HERMES_GITOPS_REPO_URL__"],"source":"%s"}\n' "$PROJECT"
  exit 0
fi

fail=0
bad() { echo "FAIL $1"; fail=1; }
ok()  { echo "OK   $1"; }

# 1. The scaffolded AppProject must allow both platform repos. Without the
#    GitOps repo itself, nothing syncs at all; without the platform repo,
#    every `repo: local` app chart is refused.
for token in __GITOPS_REPO_URL__ __HERMES_GITOPS_REPO_URL__; do
  if grep -q -- "- $token" "$PROJECT"; then
    ok "$PROJECT allows $token"
  else
    bad "$PROJECT no longer lists $token in sourceRepos - every environment seeded from this template would refuse to sync"
  fi
done

# 2. The chart must ship the allowlist EMPTY. A default entry here would be
#    a third policy, invisible in both the environment's cluster-values and
#    its AppProject.
if grep -qE '^\s+sourceRepos:\s*\[\]\s*$' "$VALUES"; then
  ok "$VALUES ships appProject.sourceRepos empty (environment supplies it)"
else
  bad "$VALUES must default appProject.sourceRepos to [] - a baked-in entry is a policy no environment declared"
fi

# 3. The render-time failure must name BOTH enforcement points. An operator
#    who adds a repo to only one place has a half-working environment, and
#    the error message is the only thing that tells them there are two.
guard=$(sed -n '/hermes.appsGuard/,/^{{- end -}}/p' "$HELPERS")
for needle in "appProject.sourceRepos" "bootstrap/project.yaml"; do
  if grep -qF "$needle" <<<"$guard"; then
    ok "the render-time guard names $needle"
  else
    bad "hermes.appsGuard's failure message no longer names $needle - an operator would fix one enforcement point and not the other"
  fi
done

[ "$fail" -eq 0 ] && echo "OK   the sourceRepos allowlist agrees across both enforcement points"
exit "$fail"
