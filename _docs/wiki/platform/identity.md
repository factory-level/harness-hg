# IAM

**What this page tells you:** who you sign in as, which services trust that sign-in, and the
one thing single sign-on here does not do.

The platform ships its own OIDC issuer, built on Dex, in-cluster, declared in
`bootstrap/identity.yaml`. Nexus UI, Argo CD and Grafana trust it, so one identity reaches
all three.

## Sign-in shares identity, never authorization

Signing in says who you are. It does not say what you may do. Each service maps the same
claims onto its own roles and keeps its own session. A denial is enforced by the service
asked, not by whatever let the request in.

Cloudflare Access at the edge is admission, not authorization. Getting through the edge is
not being authorized.

## Why Dex

It works the same offline and live: static passwords for the local loop, a Google or GitHub
connector for real people, one config shape either way. That is what makes the whole role
matrix provable in `make test`.

## The clients

| Client | What it is |
|---|---|
| `nexus` | Nexus UI |
| `argocd` | Argo CD |
| `grafana` | Grafana |
| `hg-proof` | `hg auth prove`, which drives the matrix without a browser |

## The local-loop identities

| Identity | Proves |
|---|---|
| `owner` | the full-access role resolves |
| `operator` | the middle role resolves, and is not the owner's |
| `viewer` | read-only resolves |
| `unbound` | authentication succeeds and authorization still denies |

!!! warning "The static passwords are the local loop's"
    Real people sign in through a connector that needs an OAuth client this repository
    cannot make. See [Google sign-in at the edge](../runbooks/google-sso.md).

## Prove it

```bash
hg auth prove [--control-plane <url>]
```

AUTH001..009: Nexus UI takes roles from verified claims, a forged header names nobody, all
four identities authenticate, a wrong password mints nothing, Argo CD resolves each role and
defaults to deny with local admin off, Grafana has no fallback role, and no secret is
readable from any surface a browser reaches.

## Where to go next

- [Nexus UI](nexus.md), the surface most of this protects
- [Google sign-in at the edge](../runbooks/google-sso.md), edge admission
