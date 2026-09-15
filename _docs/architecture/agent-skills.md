# Approved agent skills

The independent `agent-skills/v1alpha1` family supplies per-agent manifests and locks, plus
bootstrap-owned approval records. The CLI resolves exact tags or commits into staged packages,
records a SHA-256 over package paths and bytes, and installs only a matching approved review.
Packages include shared references and licensing files; runtime downloads are unnecessary.

`cli/src/skills` owns prepare, approve, install and offline check. A transaction journal blocks
validation after an interrupted install. Repeating installation with the same approved review
restores the previous packages before retrying. Symlinks and escaping paths are rejected.

`hg validate` and the Python emitter reject stale manifests and modified locked packages.
Team planning derives external requirements from source, checks actual registered capabilities
and requires acceptance scenarios. A source's optional `skillPolicy.approvals` binds deployment
to the reviewed content and capabilities. Existing sources without this policy retain their
current approval behavior. Local requirements remain in the bootstrap plan.

Approval is an operator assertion, not authentication of a person. The CLI does not establish
that the named approver actually consented; operators must protect the bootstrap approval file.
Coding-assistant skill installation remains a separate workflow and approval decision.

Tests cover real local Git fetching, moved tags, independent agent versions, tampering,
capability drift, shared references, install recovery and source approval checks. They do not
establish Kubernetes skill discovery or live provider behavior.
