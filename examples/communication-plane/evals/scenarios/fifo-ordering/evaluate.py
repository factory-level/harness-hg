#!/usr/bin/env python3
"""Same-key deliveries complete in emission order, on the durable
transport."""
import json
import os
import sys

receipts = json.load(open(os.environ["HG_EVAL_RECEIPTS"]))
emitted = os.environ["HG_EVAL_EVENT_IDS"].split(",")
agent = [r for r in receipts if r.get("kind") == "agent" and r.get("status") == "accepted"]
if len(agent) != 3:
    print(f"expected 3 accepted agent deliveries, got {len(agent)}", file=sys.stderr)
    sys.exit(1)
if any(r.get("transport") != "queued" for r in agent):
    print("a delivery bypassed the durable transport", file=sys.stderr)
    sys.exit(1)
order = [r["eventId"] for r in agent]
if order != emitted:
    print(f"order violated: emitted {emitted}, delivered {order}", file=sys.stderr)
    sys.exit(1)
if any(r.get("orderingKey") != "incident/eval-fifo" for r in agent):
    print("a delivery lost its ordering key", file=sys.stderr)
    sys.exit(1)
print("same-key FIFO held across 3 events")
