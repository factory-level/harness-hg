"""Zero Trust Access application + policy gating the tunnel hostname, and a
per-instance Access service token.

Resource shapes verified by installed-SDK introspection
(``pulumi_cloudflare==6.18.0`` - see ``tunnel.py``'s module docstring for
the same methodology applied there):

  - ``cloudflare.ZeroTrustAccessPolicy(account_id, name, decision, includes)``
    is a STANDALONE, reusable resource - it is NOT nested under (or
    scoped to) any one application by construction. It's attached to an
    application via ``ZeroTrustAccessApplicationPolicyArgs(id=policy.id,
    precedence=1)`` in the application's own ``policies`` list (see
    ``access_application`` below) - the provider's documented "reusable
    policy" attachment shape, chosen over inlining the same ``includes``
    directly on the application so the policy is independently
    inspectable/importable (and, if a future revision wants it, shareable
    across more than one application).
  - ``ZeroTrustAccessPolicyIncludeArgs`` is a discriminated union of ~20
    optional fields (one per Access rule type) - this program only ever
    sets ``any_valid_service_token`` (an empty marker object matching ANY
    valid service token issued under this account) and/or
    ``login_method(id=idp_id)`` (restricts to one specific, pre-existing
    Identity Provider integration - this program never creates an IdP
    integration itself, see ``_docs/wiki/platform/tunneling.md``). ``spec.expose.access.
    policy`` (schemas/hermesprofile/v1alpha2's enum) maps to ``includes``
    as:
      - "service-token" -> [any_valid_service_token]
      - "idp"           -> [login_method(idp_id)]
      - "mixed"         -> [any_valid_service_token, login_method(idp_id)]
    (``includes`` entries are OR'd - Access grants if ANY one is
    satisfied, so "mixed" genuinely means "a valid service token OR a
    successful idp login", not "both required" - matching the plain
    English reading of the policy name.)
  - ``cloudflare.ZeroTrustAccessApplication(account_id, name, type,
    domain, destinations, session_duration, policies)`` -
    ``type="self_hosted"`` (a plain HTTP(S) application, matching what a
    tunnel-fronted Hermes agent actually is - not ssh/vnc/rdp/saas/etc.);
    ``destinations`` (the current, non-deprecated field -
    ``self_hosted_domains`` is documented as deprecated in favor of it)
    carries ``type="public"``, ``uri=<hostname>`` so Access secures
    exactly the tunnel's own public hostname.
  - ``cloudflare.ZeroTrustAccessServiceToken(account_id, name, duration)``
    - minted UNCONDITIONALLY (regardless of ``access_policy`` - even an
    "idp"-only instance gets one), per the brief: a machine credential
    other Hermes instances/callers can use is useful independent of
    whether HUMAN access to this instance also requires an idp login.
    ``client_id``/``client_secret`` are both resource OUTPUTS (server-
    generated, not settable inputs) - written to the configured secret
    backend by ``secrets.py``, never logged/exported in plaintext by this
    program.
"""

from __future__ import annotations

import pulumi
import pulumi_cloudflare as cloudflare

DEFAULT_SESSION_DURATION = "24h"
DEFAULT_SERVICE_TOKEN_DURATION = "8760h"  # 1 year - matches the provider's own default.


def includes_for_policy(
    policy: str, idp_id: str
) -> list[cloudflare.ZeroTrustAccessPolicyIncludeArgs]:
    includes: list[cloudflare.ZeroTrustAccessPolicyIncludeArgs] = []
    if policy in ("service-token", "mixed"):
        includes.append(
            cloudflare.ZeroTrustAccessPolicyIncludeArgs(
                any_valid_service_token=cloudflare.ZeroTrustAccessPolicyIncludeAnyValidServiceTokenArgs(),
            )
        )
    if policy in ("idp", "mixed"):
        includes.append(
            cloudflare.ZeroTrustAccessPolicyIncludeArgs(
                login_method=cloudflare.ZeroTrustAccessPolicyIncludeLoginMethodArgs(
                    id=idp_id
                ),
            )
        )
    return includes


def access_policy(
    name: str, account_id: str, policy: str, idp_id: str
) -> cloudflare.ZeroTrustAccessPolicy:
    return cloudflare.ZeroTrustAccessPolicy(
        "hermes-tunnel-access-policy",
        account_id=account_id,
        name=f"hermes-{name}-access",
        decision="allow",
        includes=includes_for_policy(policy, idp_id),
    )


def access_application(
    name: str,
    account_id: str,
    host: str,
    policy: cloudflare.ZeroTrustAccessPolicy,
) -> cloudflare.ZeroTrustAccessApplication:
    return cloudflare.ZeroTrustAccessApplication(
        "hermes-tunnel-access-app",
        account_id=account_id,
        name=f"hermes-{name}",
        type="self_hosted",
        domain=host,
        destinations=[
            cloudflare.ZeroTrustAccessApplicationDestinationArgs(
                type="public", uri=host
            ),
        ],
        session_duration=DEFAULT_SESSION_DURATION,
        policies=[
            cloudflare.ZeroTrustAccessApplicationPolicyArgs(
                id=policy.id, precedence=1
            ),
        ],
        opts=pulumi.ResourceOptions(depends_on=[policy]),
    )


def access_service_token(
    name: str, account_id: str
) -> cloudflare.ZeroTrustAccessServiceToken:
    return cloudflare.ZeroTrustAccessServiceToken(
        "hermes-tunnel-service-token",
        account_id=account_id,
        name=f"hermes-{name}-agent",
        duration=DEFAULT_SERVICE_TOKEN_DURATION,
    )
