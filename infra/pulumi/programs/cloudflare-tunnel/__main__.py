"""hermes-cloudflare-tunnel - Pulumi entry point.

Orchestration order: config -> tunnel connector -> remote ingress config
(per-service rules + mandatory catch-all) -> connector token -> DNS CNAME
-> Access policy -> Access application (references the policy) -> Access
service token -> credential delivery to the configured secret backend ->
exports. Dependency ordering is enforced via depends_on / argument
threading, not import order.

Invoked by the Pulumi Kubernetes Operator via the Stack CR
``harness/hermes/charts/hermes-profile/templates/tunnel/stack-cloudflare.yaml`` renders -
see that file's header comment and ``cloudflare_tunnel/config.py``'s for
the config-key contract this program depends on.
"""

from __future__ import annotations

import pulumi

from cloudflare_tunnel import access, config, dns, secrets, tunnel


def main() -> None:
    cfg = config.load()

    t = tunnel.create_tunnel(cfg.name, cfg.account_id)
    host = tunnel.hostname(cfg.name, cfg.zone_name)
    tunnel.configure_tunnel(cfg.account_id, t.id, cfg.expose_services, host)
    token = tunnel.tunnel_token(cfg.account_id, t.id)

    dns.cname_record(cfg.zone_id, host, t.id)

    policy = access.access_policy(cfg.name, cfg.account_id, cfg.access_policy, cfg.idp_id)
    access.access_application(cfg.name, cfg.account_id, host, policy)
    svc_token = access.access_service_token(cfg.name, cfg.account_id)

    secrets.deliver(
        cfg.secret_provider,
        instance_name=cfg.name,
        secret_namespace=cfg.secret_namespace,
        tunnel_token=token,
        client_id=svc_token.client_id,
        client_secret=svc_token.client_secret,
        depends_on=[t, svc_token],
    )

    pulumi.export("tunnelId", t.id)
    pulumi.export("hostname", host)
    pulumi.export("accessApplicationName", f"hermes-{cfg.name}")
    pulumi.export("accessServiceTokenName", f"hermes-{cfg.name}-agent")


main()
