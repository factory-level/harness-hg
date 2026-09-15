# 0188 — Stop stale workspace sync before migration

## Decision

Extend the bounded workspace migration in ADR 0187 with a preceding stale-sync termination.
After all desired-manifest, healthy-pod and unchanged-data checks pass, Hg can change only
the exact old Argo operation from Running to Terminating. JSON Patch tests require the
Application UID, resourceVersion, operation start time and Running phase to remain unchanged.
The owning design is design/cli.md.

## Reason

An old Argo sync can continue waiting on resources after the Application's declared chart
source changes. Its desired operation can neither apply the new chart nor add the workspace
claim. Waiting for retries alone does not guarantee progress.

## Cost

This uses Argo's OperationState termination transition through its Kubernetes API. Recovery
requires Application patch permission and a private receipt; accepted requests never repeat,
and uncertain requests have three attempts. The controller is not orphaned until a later pass
verifies a sync using the current sources. Other stuck operations remain outside this recovery.
