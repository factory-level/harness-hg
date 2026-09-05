# control-plane/argocd/

**Purpose.** Convergence: the only thing that applies manifests.

**Chart / machinery.** no chart here — installed by the bootstrap Pulumi program (`infra/src`), version pinned in versions.json.

**Signals.** app health is the primary signal; `hg launch prove` reads it. Coverage is inventoried per component in #662.
