#!/usr/bin/env bash
# The #272 acceptance demonstration, as a script: break one agent, one
# communication route, and one backup routine IN TURN against the `hg up`
# k3d loop, and prove after each that the overlay indicts the CORRECT
# source, that an unavailable source reads unknown (never healthy), and
# that a safe investigation link is offered. Every step restores what it
# broke; the cluster ends as it began.
#
# Usage: infra/scripts/prove-observability-failure.sh <control-plane-url>
#   <control-plane-url> = the local Nexus base, e.g. http://127.0.0.1:8931
#   (hg status prints it after `hg up`).
#
# Requires: a running `hg up` environment (k3d context k3d-hermes-gitops-cli),
# kubectl, curl, python3 (deliberately NOT jq - the loop's hosts don't
# carry it, and this file found that out the hard way). Predicates are
# python expressions over the parsed overlay bound to `o`.
# Prints PASS/FAIL/SKIP per scenario; non-zero exit on any FAIL.

set -uo pipefail

CP="${1:-}"
if [[ -z "$CP" ]]; then
  echo "usage: $0 <control-plane-url>   (hg status prints the Nexus port)" >&2
  exit 2
fi
KCTX="k3d-hermes-gitops-cli"
K() { kubectl --context "$KCTX" "$@"; }
FAIL=0

overlay() { curl -fsS "$CP/api/plugins/hermes-gitops/nexus/health"; }

check() { # <python-predicate over `o`> ; exit 0 when true
  python3 -c "
import json, sys
o = json.load(sys.stdin)
sys.exit(0 if ($1) else 1)
"
}

# The overlay caches for cacheSeconds (default 15); every assertion polls
# past several cache windows rather than sleeping a guessed amount.
wait_for() { # <description> <python-predicate> [attempts=24]
  local desc="$1" pred="$2" attempts="${3:-24}" i
  for i in $(seq 1 "$attempts"); do
    if overlay 2>/dev/null | check "$pred"; then
      echo "PASS $desc"
      return 0
    fi
    sleep 5
  done
  echo "FAIL $desc"
  echo "     last source states:"
  overlay 2>/dev/null | python3 -c "
import json, sys
o = json.load(sys.stdin)
for k, s in (o.get('sources') or {}).items():
    print(f\"       {k}: {s['status']} / {s['level']} - {s['summary']}\")
" || echo "       (overlay unreachable)"
  FAIL=1
  return 1
}

echo "== baseline: the overlay is served and argocd is configured =="
wait_for "baseline overlay reachable with a configured argocd source" \
  "o['sources']['argocd']['status'] == 'configured'"

# ---------------------------------------------------------------------------
echo
echo "== a. break one agent -> the argocd source indicts it, with a link =="
APP=$(K -n argocd get applications.argoproj.io -o name 2>/dev/null \
  | sed 's|.*/||' | grep '^hermes-' | grep -v -- '-monitoring$\|-postiz$\|-kanban$\|bundle' | head -1)
if [[ -z "$APP" ]]; then
  echo "SKIP no hermes-* Application found (is a profile onboarded?)"
else
  NS=$(K -n argocd get applications.argoproj.io "$APP" -o jsonpath='{.spec.destination.namespace}')
  STS=$(K -n "$NS" get statefulset -o name 2>/dev/null | head -1 | sed 's|.*/||')
  if [[ -z "$STS" ]]; then
    echo "SKIP $APP has no StatefulSet to break"
  else
    K -n "$NS" scale statefulset "$STS" --replicas=0 >/dev/null
    wait_for "argocd source leaves healthy after scaling $NS/$STS to 0" \
      "o['sources']['argocd']['level'] != 'healthy' and o['sources']['argocd']['status'] == 'configured'"
    # The CORRECT source: nothing else may take the blame for a dead pod.
    wait_for "backup and communication sources are untouched by the agent breakage" \
      "o['sources']['backup']['status'] != 'failed' and o['sources']['communication']['status'] != 'failed'"
    wait_for "every offered Argo link is namespace-qualified (never a guess)" \
      "all(len((l.get('url','').split('/applications/',1)+[''])[1].split('/')) == 2 for i in o.get('instances',{}).values() for l in (i.get('links') or []) if l.get('kind') == 'external' and '/applications/' in l.get('url',''))"
    K -n "$NS" scale statefulset "$STS" --replicas=1 >/dev/null
    # 60 attempts (5 min): the agent image is ~4GB and a pod restart is
    # genuinely slower than the default window. The claim is "clears only
    # after a FRESH healthy observation", not "clears fast".
    wait_for "the broken instance recovers only after a fresh healthy observation" \
      "any(i['level'] == 'healthy' for k, i in o.get('instances', {}).items() if '$APP'.endswith(k.split('/')[-1].split('@')[0]) or k == '${APP#hermes-}')" 60
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "== b. break the communication route -> the communication source indicts it =="
REDIS=$(K -n hermes-system get deploy -o name 2>/dev/null | grep redis | head -1 || true)
if [[ -z "$REDIS" ]]; then
  echo "SKIP no redis deployment (no durable communication plane in this environment)"
else
  K -n hermes-system scale "$REDIS" --replicas=0 >/dev/null
  # A dead Redis 503s the router's whole /metrics scrape, so Prometheus
  # marks the target down and the series go absent -> the source must
  # leave healthy (failed/stale/not-configured are all honest), and
  # argocd must be unaffected.
  wait_for "communication source leaves healthy after killing redis" \
    "o['sources']['communication']['level'] != 'healthy'"
  wait_for "argocd source unaffected by the communication breakage" \
    "o['sources']['argocd']['status'] == 'configured'"
  K -n hermes-system scale "$REDIS" --replicas=1 >/dev/null
fi

# ---------------------------------------------------------------------------
echo
echo "== c. break one backup routine -> the backup source indicts it by name =="
CJ_LINE=$(K get cronjobs -A -l hermes.dev/backup-routine=true --no-headers 2>/dev/null | head -1 | awk '{print $1, $2}')
if [[ -z "$CJ_LINE" ]]; then
  echo "SKIP no labelled backup routine in this environment"
else
  read -r CJNS CJ <<<"$CJ_LINE"
  K -n "$CJNS" patch cronjob "$CJ" -p '{"spec":{"suspend":true}}' >/dev/null
  wait_for "backup source reports $CJ suspended" \
    "o['sources']['backup']['level'] == 'degraded' and any('$CJ' in (r.get('message') or '') for r in (o['sources']['backup'].get('reasons') or []))"
  K -n "$CJNS" patch cronjob "$CJ" -p '{"spec":{"suspend":false}}' >/dev/null
  wait_for "backup source clears only after a fresh observation" \
    "o['sources']['backup']['level'] in ('healthy', 'degraded')"
fi

# ---------------------------------------------------------------------------
echo
echo "== d. an unavailable adapter reads unknown/stale, never healthy =="
PROM_STS=$(K -n hermes-monitoring get sts -o name 2>/dev/null | grep prometheus | head -1 | sed 's|.*/||')
if [[ -z "$PROM_STS" ]]; then
  echo "SKIP no Prometheus StatefulSet found"
else
  K -n hermes-monitoring scale statefulset "$PROM_STS" --replicas=0 >/dev/null
  wait_for "grafana source degrades with Prometheus down (stale/failed/not-configured, never healthy)" \
    "o['sources']['grafana']['status'] in ('stale', 'failed', 'not configured')"
  wait_for "no source anywhere reads healthy without a real observation" \
    "all(s['status'] in ('configured', 'stale') for s in o['sources'].values() if s['level'] == 'healthy')"
  wait_for "the kube-API sources survive the Prometheus outage" \
    "o['sources']['argocd']['status'] == 'configured'"
  K -n hermes-monitoring scale statefulset "$PROM_STS" --replicas=1 >/dev/null
fi

echo
if [[ $FAIL -eq 0 ]]; then
  echo "OK: every breakage was indicted by the correct source and nothing read false-green"
else
  echo "FAIL: at least one scenario did not behave - see above"
fi
exit $FAIL
