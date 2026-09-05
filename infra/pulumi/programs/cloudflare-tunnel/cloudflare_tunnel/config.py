"""Typed configuration for the cloudflare-tunnel Pulumi program.

Reads the flat ``cloudflare:*`` / ``hermes:*`` stack-config keys
written by
``harness/hermes/charts/hermes-profile/templates/tunnel/stack-cloudflare.yaml``'s rendered
Stack CR ``spec.config`` block - every key name here MUST byte-match that
template's ``config:`` map (see that file's header comment for the other
half of this contract).

``load()`` itself is a thin wrapper around ``pulumi.Config`` reads feeding
``_parse()`` - deliberately split out so every validation rule below
(access-policy enum, idp-id-required-for-idp/mixed, secret-provider enum)
is unit-testable directly against a plain
dict, with NO ``pulumi.runtime.set_mocks``/live Pulumi context required
(see ``tests/test_config.py``). This program's config-loading has enough
independent branches (four validated fields, two of them cross-field) that
direct, offline unit coverage is worth the extra indirection.
"""

from __future__ import annotations

import dataclasses
import json

import pulumi

ACCESS_POLICIES = ("service-token", "idp", "mixed")
# k8s is the ONLY secret provider - external backends (gsm/vault/sops)
# were removed outright (issue #30 [H1]).
SECRET_PROVIDERS = ("k8s",)


class ConfigError(Exception):
    """Raised for Stack config that fails validation before any Cloudflare/
    Kubernetes resource is registered."""


@dataclasses.dataclass(frozen=True)
class TunnelConfig:
    account_id: str
    zone_id: str
    zone_name: str
    idp_id: str
    name: str
    expose_services: list[dict]
    access_policy: str
    secret_provider: str
    secret_namespace: str


def _require_nonempty(raw: dict, key: str) -> str:
    value = raw.get(key)
    if not value:
        raise ConfigError(
            f"{key!r} is required and must be non-empty (see the Stack CR's "
            f"spec.config / templates/tunnel/stack-cloudflare.yaml for where "
            f"it's rendered)."
        )
    return value


def _parse(raw: dict) -> TunnelConfig:
    """Pure validation/shaping over a plain dict of already-string-typed
    config values (the shape ``load()`` below hands it, mirroring exactly
    what ``pulumi.Config.require()``/``get()`` return). Raises
    ``ConfigError`` with an actionable message for every invalid shape;
    never silently defaults a required field.
    """
    account_id = _require_nonempty(raw, "accountId")
    zone_id = _require_nonempty(raw, "zoneId")
    zone_name = _require_nonempty(raw, "zoneName")
    idp_id = raw.get("idpId") or ""

    name = _require_nonempty(raw, "name")

    expose_services = raw.get("expose") or []
    if not expose_services:
        raise ConfigError(
            "hermes:expose is empty - a cloudflare-tunnel Stack requires at "
            "least one exposed service (hermes.cloudflareConfigGuard in "
            "_helpers.tpl should have caught this at helm-template time; "
            "seeing this error means the Stack CR's config was hand-edited "
            "or built by something other than "
            "templates/tunnel/stack-cloudflare.yaml)."
        )
    for i, svc in enumerate(expose_services):
        if not isinstance(svc, dict) or "name" not in svc or "port" not in svc:
            raise ConfigError(
                f"hermes:expose[{i}] must be an object with at least "
                f"'name' and 'port' keys (schemas/hermesprofile/v1alpha2's "
                f"expose.services[] shape); got: {svc!r}"
            )

    access_policy = raw.get("accessPolicy") or "service-token"
    if access_policy not in ACCESS_POLICIES:
        raise ConfigError(
            f"hermes:accessPolicy={access_policy!r} is not valid; expected "
            f"one of: {', '.join(ACCESS_POLICIES)}"
        )
    if access_policy in ("idp", "mixed") and not idp_id:
        raise ConfigError(
            f"hermes:accessPolicy={access_policy!r} requires cloudflare:idpId "
            f"to be set (an existing Cloudflare Access Identity Provider "
            f"integration id) - hermes.cloudflareConfigGuard in _helpers.tpl "
            f"should have caught this at helm-template time."
        )

    secret_provider = _require_nonempty(raw, "secretProvider")
    if secret_provider not in SECRET_PROVIDERS:
        raise ConfigError(
            f"hermes:secretProvider={secret_provider!r} is not a recognized "
            f"providers.secret value; expected one of: "
            f"{', '.join(SECRET_PROVIDERS)} (external secret backends were "
            f"removed - issue #30 [H1])"
        )

    secret_namespace = raw.get("secretNamespace") or "hermes-secrets"

    return TunnelConfig(
        account_id=account_id,
        zone_id=zone_id,
        zone_name=zone_name,
        idp_id=idp_id,
        name=name,
        expose_services=expose_services,
        access_policy=access_policy,
        secret_provider=secret_provider,
        secret_namespace=secret_namespace,
    )


def load() -> TunnelConfig:
    cf_cfg = pulumi.Config("cloudflare")
    hermes_cfg = pulumi.Config("hermes")

    # hermes:expose is a JSON-encoded STRING config value (see
    # stack-cloudflare.yaml's header comment on why) - get_object()
    # json.loads()'s the raw string for us.
    raw = {
        "accountId": cf_cfg.get("accountId"),
        "zoneId": cf_cfg.get("zoneId"),
        "zoneName": cf_cfg.get("zoneName"),
        "idpId": cf_cfg.get("idpId"),
        "name": hermes_cfg.get("name"),
        "expose": hermes_cfg.get_object("expose"),
        "accessPolicy": hermes_cfg.get("accessPolicy"),
        "secretProvider": hermes_cfg.get("secretProvider"),
        "secretNamespace": hermes_cfg.get("secretNamespace"),
    }
    return _parse(raw)


def expose_services_from_json(raw_json: str) -> list[dict]:
    """Convenience for tests/tooling that only have the raw JSON string
    stack-cloudflare.yaml renders (``hermes:expose``), not a live
    ``pulumi.Config`` context."""
    return json.loads(raw_json)
