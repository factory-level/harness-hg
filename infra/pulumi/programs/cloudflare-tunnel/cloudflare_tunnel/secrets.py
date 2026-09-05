"""Delivers the minted tunnel connector token + Access service-token
credentials into the fleet's configured secret backend - this program
itself WRITES the secret values (rather than asserting pre-existing
secrets exist): nothing else in this fleet could pre-seed a Cloudflare-minted tunnel
token or Access service-token secret/client pair ahead of time - Pulumi
itself is what mints them (``tunnel.py``/``access.py``), so it has to be
the one that writes them out too.

One backend: ``k8s`` — the only secret provider (external backends were
removed, issue #30 [H1]; ``config._parse`` rejects anything else before
this module is ever reached):

  - ``k8s``: a plain ``pulumi_kubernetes.core.v1.Secret`` in the
    ``hermes-secrets`` namespace (the SAME namespace/mechanism the
    ClusterSecretStore "hermes-gitops" k8s provider reads from - see
    ``infra/src/components/secret-store``), named
    ``hermes-<name>-cf-tunnel-token`` / ``hermes-<name>-access-token``
    (naming convention: ``hermes-<name>-<kebab(VAR)>``,
    with ``VAR`` = the literal strings ``CF_TUNNEL_TOKEN`` /
    ``ACCESS_TOKEN`` - not real ``spec.envRequires`` entries, but reusing
    the exact same derivation keeps "what secret backs X" one mental
    model - see ``harness/hermes/charts/hermes-profile/templates/_helpers.tpl``'s
    ``hermes.cfTunnelTokenSecretName`` docstring for the chart-side half
    of this contract). Each Secret's data is written as explicit, separate
    keys (``value`` for the single-value tunnel token; ``clientId``/
    ``clientSecret`` for the two-value access token). Requires the tunnel
    Stack's workspace ServiceAccount to have RBAC to write Secrets into
    ``hermes-secrets`` (a DIFFERENT namespace from its own instance
    namespace) - NOT auto-provisioned by this chart, an operator sets it
    up out of band (see ``_docs/wiki/platform/tunneling.md``'s "Kubernetes RBAC for the
    workspace pod" section).

Every write here would be a genuine, live Kubernetes API call - this
module is therefore the one part of this program that CANNOT be exercised
end-to-end without a live cluster (no live k8s calls were
made in this task - see ``tests/test_secrets.py``, which uses
``pulumi.runtime.set_mocks`` - Pulumi's own offline testing mechanism - to
prove the SHAPE of what would be written without ever leaving the
process).
"""

from __future__ import annotations

import pulumi

TUNNEL_TOKEN_VAR = "CF_TUNNEL_TOKEN"
ACCESS_TOKEN_VAR = "ACCESS_TOKEN"


def _kebab(var: str) -> str:
    return var.lower().replace("_", "-")


def secret_name(instance_name: str, var: str) -> str:
    """``hermes-<name>-<kebab(VAR)>`` - see this module's docstring for
    why this naming convention is reused even though ``var`` is never a
    real ``spec.envRequires`` entry here."""
    return f"hermes-{instance_name}-{_kebab(var)}"


def write_k8s_secret(
    namespace: str, name: str, string_data: dict, depends_on: list | None = None
):
    import pulumi_kubernetes as k8s

    return k8s.core.v1.Secret(
        name,
        metadata=k8s.meta.v1.ObjectMetaArgs(name=name, namespace=namespace),
        string_data=string_data,
        opts=pulumi.ResourceOptions(
            depends_on=depends_on or [], additional_secret_outputs=["stringData"]
        ),
    )


def deliver(
    secret_provider: str,
    *,
    instance_name: str,
    secret_namespace: str,
    tunnel_token: pulumi.Input[str],
    client_id: pulumi.Input[str],
    client_secret: pulumi.Input[str],
    depends_on: list | None = None,
) -> list:
    """Returns every resource this call registered (both the tunnel-token
    and access-token writes) - callers (``__main__.py``, and this
    module's own tests) can chain ``depends_on``/force ordering off the
    returned list rather than off ``deliver()``'s own (nonexistent, since
    Pulumi resource registration is async) return-time completion.
    """
    tunnel_secret_name = secret_name(instance_name, TUNNEL_TOKEN_VAR)
    access_secret_name = secret_name(instance_name, ACCESS_TOKEN_VAR)

    if secret_provider == "k8s":
        tunnel_res = write_k8s_secret(
            secret_namespace,
            tunnel_secret_name,
            {"value": tunnel_token},
            depends_on=depends_on,
        )
        access_res = write_k8s_secret(
            secret_namespace,
            access_secret_name,
            {"clientId": client_id, "clientSecret": client_secret},
            depends_on=depends_on,
        )
        return [tunnel_res, access_res]
    else:  # pragma: no cover - config.py already rejects this before load() returns
        raise Exception(
            f"providers.secret={secret_provider!r} tunnel-token delivery not "
            f"implemented (k8s only - external secret backends were removed, "
            f"issue #30 [H1])"
        )
