"""Offline unit tests for ``cloudflare_tunnel/secrets.py`` - uses
``pulumi.runtime.set_mocks(...)`` (Pulumi's own offline testing mechanism) so
``k8s.core.v1.Secret`` never leaves this process - no Kubernetes
credentials, no network access, no live API call of any kind.
``set_mocks`` MUST run before any resource is constructed, hence the
module-level call below, before ``cloudflare_tunnel`` is imported.

The resource TYPE TOKEN below (``kubernetes:core/v1:Secret``) was read
directly out of the installed SDK's ``register_resource(...)`` call
(``pulumi_kubernetes==4.33.0``), not guessed.
"""

from __future__ import annotations

import pathlib
import sys
from typing import Any

import pulumi

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))


class _RecordingMocks(pulumi.runtime.Mocks):
    """Records every resource registered, keyed by pulumi type token, so
    a test can assert exactly which resources (and how many) a call under
    test created - not just that construction didn't raise."""

    def __init__(self):
        super().__init__()
        self.created: list[tuple[str, dict[str, Any]]] = []

    def new_resource(
        self, args: pulumi.runtime.MockResourceArgs
    ) -> tuple[str, dict[str, Any]]:
        outputs = dict(args.inputs)
        self.created.append((args.typ, outputs))
        return f"{args.name}_id", outputs

    def call(
        self, args: pulumi.runtime.MockCallArgs
    ) -> tuple[dict[str, Any], list[tuple[str, str]] | None]:
        raise AssertionError(f"unexpected mocked invoke: {args.token}")  # pragma: no cover


_mocks = _RecordingMocks()
pulumi.runtime.set_mocks(_mocks, preview=False)

from cloudflare_tunnel import secrets  # noqa: E402


def test_secret_name_matches_naming_contract():
    assert secrets.secret_name("support-agent", "CF_TUNNEL_TOKEN") == (
        "hermes-support-agent-cf-tunnel-token"
    )
    assert secrets.secret_name("support-agent", "ACCESS_TOKEN") == (
        "hermes-support-agent-access-token"
    )


@pulumi.runtime.test
def test_write_k8s_secret_shape():
    res = secrets.write_k8s_secret(
        "hermes-secrets", "hermes-support-agent-cf-tunnel-token", {"value": "tok-123"}
    )

    def check(args):
        name, namespace, string_data = args
        assert name == "hermes-support-agent-cf-tunnel-token"
        assert namespace == "hermes-secrets"
        assert string_data == {"value": "tok-123"}
        return True

    return pulumi.Output.all(res.metadata.name, res.metadata.namespace, res.string_data).apply(
        check
    )


@pulumi.runtime.test
def test_deliver_k8s_writes_both_secrets_with_expected_names_and_namespace():
    _mocks.created.clear()
    created = secrets.deliver(
        "k8s",
        instance_name="support-agent",
        secret_namespace="hermes-secrets",
        tunnel_token="tok-123",
        client_id="client-abc",
        client_secret="secret-xyz",
    )

    tunnel_res, access_res = created

    def check(args):
        (
            tunnel_name,
            tunnel_ns,
            tunnel_data,
            access_name,
            access_ns,
            access_data,
        ) = args
        assert tunnel_name == "hermes-support-agent-cf-tunnel-token"
        assert access_name == "hermes-support-agent-access-token"
        assert tunnel_ns == "hermes-secrets"
        assert access_ns == "hermes-secrets"
        assert tunnel_data == {"value": "tok-123"}
        assert access_data == {"clientId": "client-abc", "clientSecret": "secret-xyz"}
        return True

    # Read each Secret's own TYPED Output properties (not the raw
    # `_mocks.created` inputs) - pulumi_kubernetes marks `Secret.
    # string_data`'s VALUES as pulumi secrets automatically (observed
    # directly against the installed SDK: the raw mock-recorded input for
    # `stringData` comes back wrapped in Pulumi's secret-value sentinel
    # shape, not a plain dict), and only the proper Output resolution
    # path (`.string_data.apply(...)`, same as test_write_k8s_secret_shape
    # above) unwraps that transparently.
    return pulumi.Output.all(
        tunnel_res.metadata.name,
        tunnel_res.metadata.namespace,
        tunnel_res.string_data,
        access_res.metadata.name,
        access_res.metadata.namespace,
        access_res.string_data,
    ).apply(check)


def test_deliver_rejects_unsupported_backend_before_any_resource():
    # config.py already rejects vault/sops before load() returns a
    # TunnelConfig - this proves secrets.deliver() ALSO refuses to
    # silently no-op if it's ever reached with an unsupported value
    # anyway (defense in depth).
    _mocks.created.clear()
    try:
        secrets.deliver(
            "vault",
            instance_name="support-agent",
            secret_namespace="hermes-secrets",
                tunnel_token="tok-123",
            client_id="client-abc",
            client_secret="secret-xyz",
        )
        raise AssertionError("expected an exception for an unsupported secret backend")
    except Exception as exc:  # noqa: BLE001 - intentionally broad, see assertion below
        assert "not implemented" in str(exc)
    assert _mocks.created == []
