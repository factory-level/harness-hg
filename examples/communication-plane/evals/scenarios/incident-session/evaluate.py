#!/usr/bin/env python3
"""Both events of one incident share one session; distinct incidents never
share identity. Exit 0 pass, 1 fail (the eval protocol)."""
import json
import os
import sys

receipts = json.load(open(os.environ["HG_EVAL_RECEIPTS"]))
agent = [r for r in receipts if r.get("kind") == "agent" and r.get("status") == "accepted"]
if len(agent) != 2:
    print(f"expected 2 accepted agent deliveries, got {len(agent)}", file=sys.stderr)
    sys.exit(1)
keys = {r["sessionKey"] for r in agent}
if len(keys) != 1:
    print(f"firing and resolved landed in DIFFERENT sessions: {sorted(keys)}", file=sys.stderr)
    sys.exit(1)
key = keys.pop()
# The key namespace: <environment>/<profile>/<route>/<subject>
if not key.startswith("local/platform-sre/operational-alerts/"):
    print(f"session key lacks the environment/profile/route namespace: {key}", file=sys.stderr)
    sys.exit(1)
events = {r["eventId"] for r in agent}
if len(events) != 2:
    print("the two notifications shared an event id - identities must be distinct", file=sys.stderr)
    sys.exit(1)
print(f"one incident, one session: {key}")
