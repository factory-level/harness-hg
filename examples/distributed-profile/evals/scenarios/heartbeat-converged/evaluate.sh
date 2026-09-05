#!/usr/bin/env bash
# Deterministic evaluator: the declared echo-heartbeat cron job is present
# in the agent's job store. Exit protocol: 0 pass, 1 assertion failure,
# anything else evaluator/harness error.
set -u

# Ask the runtime for its own convergence report - machine-readable, never
# scraped narration. A kubectl/exec failure is a HARNESS error (exit 3),
# not an assertion failure.
if ! report=$(kubectl --context "$HG_EVAL_KUBE_CONTEXT" -n "$HG_EVAL_NAMESPACE" \
    exec "$HG_EVAL_POD" -c hermes-agent -- \
    /opt/hermes/bin/hermes -p "$HG_EVAL_PROFILE" cron sync --dry-run --json); then
  echo "could not reach the agent pod or run cron sync" >&2
  exit 3
fi
printf '%s\n' "$report" > "$HG_EVAL_ARTIFACTS/cron-sync-report.json"

python3 - "$HG_EVAL_ARTIFACTS/cron-sync-report.json" <<'PY'
import json, sys

report = json.load(open(sys.argv[1]))
names = [
    entry if isinstance(entry, str) else entry.get("name")
    for key in ("unchanged", "updated", "created")
    for entry in report.get(key, [])
]
if "echo-heartbeat" not in names:
    print(f"echo-heartbeat is not converged; sync report names: {names}")
    sys.exit(1)
print("echo-heartbeat converged in the job store")
PY
