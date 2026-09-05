# ADR 0156 — Eve agents reach the Cloudflare edge over the shared control-plane tunnel

2026-08-24 · **Accepted — built** (`infra/charts/eve-agent/templates/_helpers.tpl`
`eve.ingressGuard`; `infra/charts/eve-agent/templates/ingress.yaml`;
`infra/scripts/render-test.sh`). Discharges one of
[ADR-149](CHANGES.md#adr-149)'s costs ("no Cloudflare Tunnel realization") in the narrow
sense only — see **Cost**. Authored under the pre-reorg ledger convention; recorded here as
the reserved per-file slot 0156.

## Decision

The eve-agent chart renders its plain Kubernetes Ingress under
`providers.ingress: cloudflare` as well as `ingress`, instead of failing the
render. `cloudflare` does **not** mean a per-agent tunnel for Eve: the agent is
reached over the environment's one shared control-plane tunnel, which
`infra/src/components/cloudflare-ingress/` already publishes as
`<name>.<zoneName>` for **every** `agents[]` entry regardless of runtime,
routed to `services.traefik` with the host header rewritten to
`<name>.<agentHostHeaderDomain>` — exactly the host this chart's Ingress
carries (both default to `hermes.local`). No new Pulumi resource, no new Access
app, no chart-side Cloudflare configuration.

The gate is an equality, not a golden: the cloudflare render must come out
**byte-identical** to the `ingress` render. That is the claim worth pinning —
cloudflare adds nothing per-instance — and it is what will fail first if a
per-agent tunnel is ever built for Eve, which is the right place to reconsider
this decision.

## Reason

`providers.*` lives in the environment-wide `cluster-values.yaml`
layered under every record, so it cannot be set per agent. On any environment
using the Cloudflare edge — factory among them — the refusal therefore blocked
**every** Eve agent from rendering at all, whether or not it wanted to be
published, and the only alternatives were to switch the whole environment to
`ingress` (breaking the live Hermes agents' exposure) or to keep Eve off that
environment entirely. Meanwhile the mechanism that actually gives a Hermes
agent its hostname — `controlPlaneHostnames()` — was already runtime-agnostic
and already routing to whatever in-cluster Ingress claims the rewritten host.
The chart was refusing to render the one object that mechanism needs. The
guard's own refusal message named this escape ("front the cluster Ingress with
the platform tunnel"); this makes it real rather than advisory.

## Cost

- **No per-instance realization.** An Eve agent gets no cloudflared sidecar and
  no tunnel Stack CR, both of which `hermes-profile` renders under the same
  provider value. Tunnel lifecycle is consequently not tied to the instance's
  own Argo CD lifecycle — retiring an Eve agent leaves its hostname to be
  removed through platform stack config, not by the agent's removal alone.
- **No author-declared exposure.** An Eve agent cannot opt out of being
  published, choose its own Access policy, or expose a second service. Those
  become the environment's decisions (`controlPlaneIngress.access.groups`,
  `agentSubdomains`), not the persona's. An Eve record still has no `expose`
  block at all — that predates this decision and is unchanged by it.
- **A silent coupling between two defaults.** The chart's `ingress.baseDomain`
  must equal the environment's `controlPlaneIngress.agentHostHeaderDomain` or
  the tunnel forwards a host no Ingress claims, and the failure is a 404 at the
  edge rather than a refused render. Both default to `hermes.local`, and both
  comments now say so, but nothing enforces it across the two authorities.
- **The Ingress declares no `ingressClass`**, so it depends on the cluster's
  default controller being the one the tunnel targets. True on k3s with Traefik;
  unverified anywhere else.
