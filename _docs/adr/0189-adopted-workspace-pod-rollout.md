# 0189 — Complete the adopted workspace pod rollout

## Decision

Extend ADR 0187's controller migration with graceful replacement of its recorded old pod.
The private accepted migration receipt must match that pod and the retained data claim.
The recreated controller, exact desired manifest, synchronized Application and both PVC
owners are verified before a UID/resourceVersion-preconditioned pod delete. The owning
design is design/cli.md.

## Reason

The StatefulSet controller adopts the preserved pod, then tries to add the new claim volume
to its existing volume list. Kubernetes refuses this immutable pod update before the normal
rolling replacement can proceed. Retaining the pod through controller recreation alone
therefore cannot complete the workspace migration.

## Cost

The recorded old pod is gracefully restarted, creating a brief single-replica interruption.
Its data PVC is retained, and PVCs owned by that pod refuse recovery to avoid garbage collection.
Only an accepted first-workspace migration can authorize this healthy-pod exception; generic
old-pod recovery continues to require a failed obsolete pod. Private receipts bound retries,
and readiness plus live acceptance remain separate gates.
