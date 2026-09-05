# `platform/` — yours, exclusively

**No tool reads or writes this directory.** Not the emitter, not the scaffold
reconciler, not `hg`. Put Kubernetes manifests here that the platform does not
model and nothing else will manage for you.

Everything in this tree is synced by `bootstrap/platform-extras.yaml`
(`directory.recurse: true`, `README.md` excluded), under the `hermes-gitops`
AppProject — so its `sourceRepos` allowlist and destination rules apply here
exactly as they do to a profile's applications.

## What belongs here

Things a cluster needs that no profile declares:

- a `NetworkPolicy`, `PriorityClass`, `ResourceQuota` or `LimitRange`
- a `ConfigMap` some workload expects to exist
- a CRD the fleet uses but no installed chart ships
- a one-off `Secret` **reference** — an `ExternalSecret`, never a value

## What does not

| Tree | Owner | Why not here |
|---|---|---|
| `profiles/` | the emitter | Generated on every `hermes profile install`. A hand-edit there does not survive. |
| `catalog/` | the emitter | Generated: the contract, provenance and dashboard catalogue. |
| `bootstrap/` | you, after a one-time seed | Platform-managed files live here too, and a later release reconciles them (`bootstrap/scaffold.yaml` records which). |

The emitter **cannot** write here — `plugin/gitops_emitter/gitrepo.py` refuses
any path outside its own trees, so this is a structural boundary rather than a
convention.

## Two things to know

**It is not namespaced for you.** The Application's `destination.namespace` is
`default` and `CreateNamespace=false`, so every manifest carries its own
`metadata.namespace`, and a namespace it needs must already exist. This is
deliberate: a tree that silently created namespaces would be a way to stand up
infrastructure nothing else knows about.

**It self-heals and prunes.** Like every other Application here,
`automated {prune: true, selfHeal: true}` is on. A resource you delete from
this tree is deleted from the cluster; a resource you patch by hand in the
cluster is reverted. Git is the source of truth for this tree the same way it
is for the rest.

## An empty tree is normal

A freshly scaffolded repository has this README and nothing else. The
Application syncs, produces no resources, and reports Synced.
