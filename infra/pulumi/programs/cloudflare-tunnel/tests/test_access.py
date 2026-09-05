"""Offline unit tests for ``cloudflare_tunnel/access.py``'s
``includes_for_policy`` - the pure ``spec.expose.access.policy`` ->
Access-policy-``includes`` mapping (service-token/idp/mixed), independent
of any live Pulumi/Cloudflare resource construction.
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from cloudflare_tunnel.access import includes_for_policy  # noqa: E402


def test_service_token_policy_matches_any_valid_service_token_only():
    includes = includes_for_policy("service-token", idp_id="")
    assert len(includes) == 1
    assert includes[0].any_valid_service_token is not None
    assert includes[0].login_method is None


def test_idp_policy_matches_login_method_only():
    includes = includes_for_policy("idp", idp_id="idp-integration-123")
    assert len(includes) == 1
    assert includes[0].any_valid_service_token is None
    assert includes[0].login_method.id == "idp-integration-123"


def test_mixed_policy_matches_either_service_token_or_login_method():
    includes = includes_for_policy("mixed", idp_id="idp-integration-123")
    assert len(includes) == 2
    assert includes[0].any_valid_service_token is not None
    assert includes[1].login_method.id == "idp-integration-123"
    # Access ORs multiple `includes` entries together - "mixed" therefore
    # means "a valid service token OR a successful idp login", never
    # "both required". This test documents that shape; the OR semantics
    # themselves are Cloudflare's, not asserted mechanically here.
