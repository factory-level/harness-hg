# GitOps

**What this page tells you:** how a declaration in Git becomes a running workload, and what
keeps it that way.

## Few controllers

There is no controller of ours in the cluster and no custom resource. A record is plain Helm
values: one `spec:` block in a file whose directory name is its identity. Argo CD turns each
directory into an Application and a chart renders it. Argo CD, Helm and the External Secrets
Operator do their ordinary jobs, so `kubectl` and `argocd` tell you the truth.

## From a declaration to a pod

```text
your Agent Team Repo    harness-hg/ (the team's, and each agent's)
      ↓                 hg up, or the environment's emitter
destination repo        profiles/<name>/profile.yaml, deployments/, catalog/   (generated)
      ↓                 Argo CD pulls
cluster                 one Application per agent → chart → StatefulSet
```

Nothing pushes to the cluster. Argo CD pulls, and so does the host reconciler.

## Two loops, not one

- **Argo CD** runs inside the cluster. It reconciles the repository into Kubernetes objects.
- **The reconcile timer** runs on the destination host as a systemd user unit. It pulls the
  repository to the host and runs the platform-level apply Argo CD cannot do on itself.

```bash
hg reconcile install --repo <url> [--branch main] [--interval 60]
hg reconcile status
hg reconcile sync      # force a cycle
hg reconcile prove
```

`sync` is skipped, not queued, while the timer holds its lock. Retry.

## The generators

Each ApplicationSet under `bootstrap/applicationsets/` turns a directory of records into
Applications. Being in the directory is not the same as being deployed: the root Application
recurses `bootstrap/` with an explicit exclude list.

| Generator | One Application per | State |
|---|---|---|
| `agents.yaml` | agent | live |
| `communication.yaml` | the event router | live |
| `apps.yaml` | supporting application | staged, excluded |
| `endpoints.yaml` | declared endpoint | staged, excluded |
| `bundles.yaml` | bundle | live once the team's `harness-hg/bundles.yaml` exists |

## Staleness

`deployments/plan.yaml` carries an `inputsHash` over every input that produced the tree. If
it does not match the current inputs, the tree is older than the declarations behind it.
Argo CD reconciles a stale tree happily. Only the hash tells you.

```bash
hg topology doctor
hg gitops doctor <destination-clone>
```

## What may reach the cluster

The Argo CD project carries a `sourceRepos` allowlist. A chart from a repository not on it is
refused. The list is enforced in two places and `make source-repos` proves they agree.

## Where to go next

- [Networking](topology.md), where each loop runs
- [Repository scaffolds](../reference/repo-scaffolds.md), what is generated and what is yours
- [Install a destination server](../runbooks/install.md), standing this up
