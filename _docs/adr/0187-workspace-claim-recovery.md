# 0187 — Bounded first-workspace claim migration

## Decision

The team installation recovery gate can orphan and recreate an existing agent StatefulSet
when the only immutable change is adding its first workspaces claim. It compares Argo-rendered
desired state with the live controller, verifies the exact source and runtime image, preserves
the existing bound data claim and pod, and records a UID-preconditioned recovery receipt.
The owning design is the team installation section of design/cli.md.

## Reason

Complete source-workspace projection can expose a previously unmounted declared workspace.
Kubernetes rejects adding volumeClaimTemplates to a live StatefulSet. A manual delete or
GitOps edit would turn an onboarding defect into an operator-only migration procedure.

## Cost

Recovery requires the existing Argo controller's manifest-read API and Kubernetes permission
to orphan the exact controller. Only the single-replica data-to-data-plus-workspaces case is
supported. Existing claim changes, unhealthy pods, preexisting workspace claims and changed
application sources fail closed. An uncertain request permits at most three attempts after
fresh identity and non-deletion checks; an accepted request is never repeated. Argo owns recreation and the
subsequent pod rollout; recovery is incomplete until normal readiness and acceptance pass.
