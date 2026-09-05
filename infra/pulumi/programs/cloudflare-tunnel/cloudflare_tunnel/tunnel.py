"""The tunnel connector, its ingress config, and the connector token.

Resource/data-source names below were verified by INSTALLED-SDK
introspection (``pulumi_cloudflare==6.18.0`` at the time this was written -
``uv add pulumi-cloudflare`` into a throwaway scratch project and reading
the generated source directly), not recalled from memory - the
``pulumi_cloudflare`` provider went through a real rename in its history
(the legacy ``cloudflare.Tunnel``/``cloudflare.TunnelConfig`` resources are
still present in 6.x for backwards compatibility, but the brief's guidance
and the provider's own current documentation point at the
``ZeroTrustTunnelCloudflared*`` names used here instead):

  - ``cloudflare.ZeroTrustTunnelCloudflared(account_id, name, config_src,
    tunnel_secret=None)`` - the tunnel object itself. ``config_src="cloudflare"``
    means the tunnel's ingress config is managed remotely (via
    ``ZeroTrustTunnelCloudflaredConfig`` below), not a local YAML file on
    the connector host - the only shape that makes sense for a
    connector-token-authenticated ``cloudflared tunnel run`` (no config
    file ships with the cloudflared sidecar/VM at all - see
    ``harness/hermes/charts/hermes-profile/templates/pod/statefulset.yaml``'s cloudflared
    container).
  - ``cloudflare.ZeroTrustTunnelCloudflaredConfig(account_id, tunnel_id,
    config=ZeroTrustTunnelCloudflaredConfigConfigArgs(ingresses=[...]))`` -
    the remote ingress-rule set. Cloudflare evaluates ``ingresses`` in
    order, first match wins - the mandatory catch-all (a rule with no
    ``hostname``, ``service="http_status:404"``) MUST be last, matching
    every Cloudflare Tunnel deployment's documented requirement that
    unmatched requests get an explicit terminal rule rather than falling
    through to nothing.
  - ``cloudflare.get_zero_trust_tunnel_cloudflared_token_output(account_id,
    tunnel_id)`` - the data source `cloudflared tunnel run --token`
    actually needs (NOT a property on the ``ZeroTrustTunnelCloudflared``
    resource itself - it has no ``token`` output; the token is a separate,
    derived credential fetched via this invoke). The ``_output`` variant
    (not the plain function) is used because ``tunnel_id`` here is a
    ``pulumi.Output`` (the newly-created tunnel's id), not a plain string
    known ahead of resource creation.

Hostname pattern: ONE hostname per instance (``<name>.agents.<zone>``),
with every ``spec.expose.services[]`` entry routed by PATH under that same
hostname (``ingress_rules`` below) - see
``harness/hermes/charts/hermes-profile/templates/tunnel/stack-cloudflare.yaml``'s header
comment for the full reasoning (this repo's original planning spec,
referenced in this task's brief as "spec section 6.2", was not present in
this checkout to consult directly; this is a reasoned, documented pick
consistent with ``templates/pod/ingress.yaml``'s existing one-host/
per-service-path precedent for the plain-Ingress provider).
"""

from __future__ import annotations

import pulumi
import pulumi_cloudflare as cloudflare


def hostname(name: str, zone_name: str) -> str:
    return f"{name}.agents.{zone_name}"


def create_tunnel(name: str, account_id: str) -> cloudflare.ZeroTrustTunnelCloudflared:
    return cloudflare.ZeroTrustTunnelCloudflared(
        "hermes-tunnel",
        account_id=account_id,
        name=f"hermes-{name}",
        config_src="cloudflare",
    )


def ingress_rules(
    services: list[dict], host: str
) -> list[cloudflare.ZeroTrustTunnelCloudflaredConfigConfigIngressArgs]:
    """One rule per ``spec.expose.services[]`` entry (``service:`` points
    at the exposed port on ``localhost`` - the cloudflared connector
    always runs colocated with the workload it fronts, as a pod sidecar -
    see ``harness/hermes/charts/hermes-profile/templates/pod/statefulset.yaml``), plus a
    mandatory trailing catch-all.
    A service with no ``path`` gets Cloudflare's own default (unset
    ``path`` matches everything under the hostname) - the SAME "two
    path-less services collide" caveat
    ``harness/hermes/charts/hermes-profile/templates/pod/ingress.yaml`` already has for
    the plain-Ingress provider, not a new footgun introduced here.
    """
    rules = [
        cloudflare.ZeroTrustTunnelCloudflaredConfigConfigIngressArgs(
            hostname=host,
            service=f"http://localhost:{svc['port']}",
            path=svc.get("path"),
        )
        for svc in services
    ]
    rules.append(
        cloudflare.ZeroTrustTunnelCloudflaredConfigConfigIngressArgs(
            service="http_status:404",
        )
    )
    return rules


def configure_tunnel(
    account_id: str,
    tunnel_id: pulumi.Input[str],
    services: list[dict],
    host: str,
) -> cloudflare.ZeroTrustTunnelCloudflaredConfig:
    return cloudflare.ZeroTrustTunnelCloudflaredConfig(
        "hermes-tunnel-config",
        account_id=account_id,
        tunnel_id=tunnel_id,
        config=cloudflare.ZeroTrustTunnelCloudflaredConfigConfigArgs(
            ingresses=ingress_rules(services, host),
        ),
    )


def tunnel_token(account_id: str, tunnel_id: pulumi.Input[str]) -> pulumi.Output[str]:
    return cloudflare.get_zero_trust_tunnel_cloudflared_token_output(
        account_id=account_id, tunnel_id=tunnel_id
    ).token
