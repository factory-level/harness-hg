# 0199 — Public release housekeeping

## Decision

The landing page leads with the Nexus UI demo, followed by the local agent-team quickstart.
Keep the existing visual identity and page URLs. Use the vocabulary register for current
product copy; legacy runtime identifiers and historical records keep their names.

Current feature claims describe implemented behavior. Illustrative scenes use shipping CLI
syntax and carry an explicit illustration label. Every landing page supplies canonical and
social metadata with a shared, locally rendered PNG.

The public snapshot tool gains `--verify-only`: export committed HEAD, remove the operator
overlay and gate the exported tree without fetching the public Git remote, writing release notes or creating tags. Release
publication remains a separate operation.

## Reason

A new reader should be able to inspect the product before installing its toolchain. Stale
product names, automatic-PR claims and ambiguous backup promises undermine that first read.
The public tree must also be verifiable independently of private operator documents and
without consuming a release version for a housekeeping PR.

## Cost

The landing metadata and command checks become part of CI. The social PNG needs local Chrome
to regenerate and a visual review when its source changes. Command grammar checks do not
prove deployment outcomes: claims still need an implementation review. Export verification
runs the full gate again in a fresh tree, adding time and dependency downloads to PR review.
