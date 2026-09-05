#!/usr/bin/env python3
"""No delivery - accepted, failed, or otherwise - ever names
unrelated-sre. The router routes by compiled IaC, not by who could
accept the POST."""
import json
import os
import sys

receipts = json.load(open(os.environ["HG_EVAL_RECEIPTS"]))
leaks = [r for r in receipts if "unrelated-sre" in json.dumps(r)]
if leaks:
    print(f"{len(leaks)} receipt(s) touched unrelated-sre: {leaks[0]}", file=sys.stderr)
    sys.exit(1)
agents = {r["edge"].rsplit(":", 1)[-1] for r in receipts if r.get("kind") == "agent"}
if agents != {"platform-sre"}:
    print(f"agent deliveries reached {sorted(agents)}, expected only platform-sre", file=sys.stderr)
    sys.exit(1)
print("isolation held: platform-sre only")
