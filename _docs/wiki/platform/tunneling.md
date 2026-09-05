# Tunnels

**What this page tells you:** how something inside the environment becomes reachable from
outside, who owns which half, and what the one supported implementation builds.

A **tunnel** is an outbound connection from the cluster to an edge provider, which accepts
inbound requests on your behalf. No inbound port is opened on the server. A destination can
sit behind NAT or a firewall you do not control and still serve an authenticated endpoint.

## Not on by default

`providers.ingress` defaults to `ingress`: ordinary Kubernetes ingress, no tunnel. Choose
`cloudflare` in `cluster-values.yaml` to turn one on.

## Who owns what

| The platform owns | Your repo owns |
|---|---|
| Which implementation runs | Asking for an endpoint |
| The connector and its lifecycle | The port and protocol behind it |
| The edge resources: DNS, access policy | Nothing at the edge |
| The credential | Nothing; it never sees it |

## Trust boundary

The tunnel terminates at the edge. The provider can see the traffic. Authentication is a
separate layer: the access policy in front of the hostname. **A tunnelled endpoint with no
access policy is public.** See [Google sign-in at the edge](../runbooks/google-sso.md).

## The implementation: Cloudflare Tunnel

The only supported one. Tailscale was implemented and removed; the frozen schema still
accepts the word and the chart refuses it.

One Cloudflare API token builds the whole edge: a tunnel, DNS records, a Zero Trust Access
application per hostname, its policies, and the identity provider binding. It can create and
destroy public routes into your environment. Think before issuing it.

The control-plane edge, built by the Pulumi bootstrap, publishes Nexus UI, Grafana and one
hostname per agent. Every agent is reached over that one shared tunnel with the host header
rewritten to its own Ingress. An agent has no tunnel of its own.

Some hostnames are deliberately Access-free, because a machine cannot sign in. See
[Webhooks](webhooks.md).

## Proof

```bash
hg edge prove --stack <pulumi stack>
```

It checks the real account: token permissions, stack outputs, DNS, a real HTTP answer,
denial for anonymous and bogus-token requests, no undeclared hostname published, no public
Service bypassing the tunnel, and `pulumi preview --expect-no-changes`.

## Temporary test URLs

```bash
hg edge publish --app <match> --email you@example.com
hg edge list
hg edge unpublish --hostname <label>
```

Plain `kubectl`, no Argo CD, nothing reconciles it. A debugging aid, not a foundation.

## Where to go next

- [Cloudflare Tunnel setup](../runbooks/cloudflare-tunnel.md), the procedure
- [Networking](topology.md), where the tunnel sits
