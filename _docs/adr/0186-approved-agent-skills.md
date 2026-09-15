# ADR 0186 — Per-agent locked skill installation and operator approval

**Status:** Accepted
**Changes:** `_docs/design/platform.md`, `_docs/design/cli.md`

## Decision

Add `agent-skills/v1alpha1` beside existing per-agent declarations. `skills.yaml` owns external
Git package requirements; `skills.lock.yaml` records exact commits, package hashes, and the
manifest fingerprint. Existing schemas remain frozen. Initial support is Eve only. Packages
select one skill entrypoint and explicit supporting resources inside an upstream package root.

`hg skills prepare` stages packages outside agent discovery without executing their code.
An operator records explicit human approval of the review fingerprint. `install` verifies
approval before installing packages into source; `check` verifies installed packages offline.
Only explicit updates resolve existing locks again. Deployment never downloads skills.
Bootstrap owns per-source approval policy and records. Local skills require the same approval
when that policy is enabled. Package requirements never grant tools or writes by themselves.

Team planning derives external requirements from the source and rejects duplicate bootstrap
entries. It checks approval before rendering/publication and fingerprints approval evidence.
Existing inspection hashes and generated GitOps record formats stay compatible: the source
commit pins package content and the installation ledger records capabilities and approvals.

## Reason

An installed directory and handwritten hash cannot reproduce an upstream package or establish
human approval. Portable source requirements and bootstrap-owned authority need distinct homes.
The workshop team is the first consumer, not a customer-specific platform implementation.

## Cost

- The platform maintains a constrained Git resolver and source-install transaction recovery.
- Sources require exact tags or commits; branches, ranges, and runtime downloads are excluded.
- Shared resources must be enumerated; arbitrary upstream installation hooks do not run.
- Approval is a trusted operator action. Bootstrap storage must remain outside agent write access.
- Existing sources are not enrolled in the new approval policy implicitly.
