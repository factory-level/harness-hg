"""The DNS CNAME publishing the tunnel's public hostname.

``cloudflare.Record`` (verified present under this exact top-level name in
the installed ``pulumi_cloudflare==6.18.0`` SDK, alongside a newer
``DnsRecord`` variant not used here - ``Record`` is what the provider's own
current examples use for a plain CNAME) - ``content`` is the tunnel's
``<tunnel_id>.cfargotunnel.com`` alias, the documented way to point a DNS
record at a Cloudflare Tunnel without a fixed IP. ``proxied=True`` (orange-
clouded) is required for a tunnel CNAME - Cloudflare only accepts
``cfargotunnel.com`` targets through its own proxy, never as a
DNS-only/grey-clouded record. ``ttl=1`` means "automatic", the value
Cloudflare's API expects/normalizes to whenever ``proxied`` is true (a
concrete TTL is meaningless once Cloudflare is proxying the record).
"""

from __future__ import annotations

import pulumi
import pulumi_cloudflare as cloudflare


def cname_record(
    zone_id: str, host: str, tunnel_id: pulumi.Input[str]
) -> cloudflare.Record:
    return cloudflare.Record(
        "hermes-tunnel-dns",
        zone_id=zone_id,
        name=host,
        type="CNAME",
        content=pulumi.Output.from_input(tunnel_id).apply(
            lambda tid: f"{tid}.cfargotunnel.com"
        ),
        proxied=True,
        ttl=1,
    )
