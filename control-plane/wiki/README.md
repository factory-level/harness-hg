# control-plane/wiki/

**Purpose.** The product manual, served in-cluster — NOT BUILT YET.

**Chart / machinery.** `chart/` (nginx) + `image/` (builds from the repo root; `/version` self-reports the baked platform revision) — ADR 0167.

**Signals.** URL scheme is the mkdocs tree; edge/SSO exposure + the Nexus deep-link ride #703. Coverage is inventoried per component in #662.
