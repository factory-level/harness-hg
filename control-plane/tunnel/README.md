# control-plane/tunnel/

**Purpose.** The shared control-plane edge (Cloudflare Tunnel + Access).

**Chart / machinery.** managed by `infra/src/components/cloudflare-ingress`; per-agent hostnames ride it (ADR 0156).

**Signals.** `hg edge prove` is its acceptance surface. Coverage is inventoried per component in #662.
