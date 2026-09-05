"""Offline unit tests for ``cloudflare_tunnel/config.py``'s ``_parse()`` -
pure dict-in/dataclass-out validation, no ``pulumi.runtime.set_mocks``/live
Pulumi context needed (see that module's docstring for why this program's
config layer is split out for direct testability).
"""

from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from cloudflare_tunnel.config import ConfigError, _parse  # noqa: E402

BASE_RAW = {
    "accountId": "test-account-id",
    "zoneId": "test-zone-id",
    "zoneName": "example.com",
    "idpId": "",
    "name": "support-agent",
    "expose": [{"name": "tools", "port": 8080, "path": "/"}],
    "accessPolicy": "service-token",
    "secretProvider": "k8s",
    "secretNamespace": "hermes-secrets",
    "gcpProject": "",
}


def _raw(**overrides):
    return dict(BASE_RAW, **overrides)


def test_valid_config_parses_cleanly():
    cfg = _parse(_raw())
    assert cfg.account_id == "test-account-id"
    assert cfg.name == "support-agent"
    assert cfg.expose_services == [{"name": "tools", "port": 8080, "path": "/"}]
    assert cfg.access_policy == "service-token"
    assert cfg.secret_provider == "k8s"
    assert cfg.secret_namespace == "hermes-secrets"


@pytest.mark.parametrize("field", ["accountId", "zoneId", "zoneName", "name"])
def test_missing_required_field_raises(field):
    raw = _raw()
    raw[field] = ""
    with pytest.raises(ConfigError, match=field):
        _parse(raw)


def test_empty_expose_raises():
    with pytest.raises(ConfigError, match="hermes:expose is empty"):
        _parse(_raw(expose=[]))


def test_malformed_expose_entry_raises():
    with pytest.raises(ConfigError, match="hermes:expose\\[0\\]"):
        _parse(_raw(expose=[{"name": "tools"}]))  # missing "port"


def test_invalid_access_policy_raises():
    with pytest.raises(ConfigError, match="hermes:accessPolicy"):
        _parse(_raw(accessPolicy="totally-not-a-policy"))


@pytest.mark.parametrize("policy", ["idp", "mixed"])
def test_idp_or_mixed_policy_without_idp_id_raises(policy):
    with pytest.raises(ConfigError, match="cloudflare:idpId"):
        _parse(_raw(accessPolicy=policy, idpId=""))


@pytest.mark.parametrize("policy", ["idp", "mixed"])
def test_idp_or_mixed_policy_with_idp_id_parses(policy):
    cfg = _parse(_raw(accessPolicy=policy, idpId="idp-integration-123"))
    assert cfg.access_policy == policy
    assert cfg.idp_id == "idp-integration-123"


def test_service_token_policy_does_not_require_idp_id():
    cfg = _parse(_raw(accessPolicy="service-token", idpId=""))
    assert cfg.access_policy == "service-token"


@pytest.mark.parametrize("provider", ["gsm", "vault", "sops", "totally-unknown"])
def test_removed_or_unknown_secret_provider_raises(provider):
    # gsm/vault/sops were REMOVED as secret providers (issue #30 [H1]) -
    # they now fail the enum check exactly like an outright typo.
    with pytest.raises(ConfigError, match="not a recognized"):
        _parse(_raw(secretProvider=provider))


def test_secret_namespace_defaults_to_hermes_secrets():
    raw = _raw()
    raw.pop("secretNamespace")
    cfg = _parse(raw)
    assert cfg.secret_namespace == "hermes-secrets"


def test_access_policy_defaults_to_service_token():
    raw = _raw()
    raw.pop("accessPolicy")
    cfg = _parse(raw)
    assert cfg.access_policy == "service-token"
