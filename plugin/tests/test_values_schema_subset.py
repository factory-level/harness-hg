"""Real drift check between harness/hermes/charts/hermes-profile/values.schema.json and
schemas/cluster-values/v1alpha1/cluster-values.schema.json (the canonical,
frozen contract) - what values.schema.json's own description used to
claim ("Kept in sync by hand - see tests/chart/ for drift-catching golden
renders...") was misleading: the golden renders in tests/chart/ only prove
`helm template` SUCCEEDS against a handful of fixed example fixtures -
they say nothing about whether the chart's own values.schema.json still
accepts everything the CANONICAL schema allows. If the canonical schema's
`providers.*` enums or `platformRepo`/`appProject` shapes ever gain a new
allowed value/field that the hand-maintained chart schema doesn't mirror,
every golden fixture already committed would keep passing (none of them
exercise the new value) while a real cluster-values.yaml using it would
be silently rejected by `helm template` - drift a byte-diff golden render
can't catch by construction. This test catches exactly that: it asserts
the canonical schema's allowed `providers.compute`/`secret`/`ingress`
values and `platformRepo`/`appProject` shapes (property names) are
all still accepted by the chart's own values.schema.json, i.e. the chart
schema is a genuine (not just claimed) superset for these fields. Not
exhaustive (deliberately narrow, per this test's own scope) - see
values.schema.json's description for what's still "kept in sync by hand".
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent
CANONICAL_SCHEMA = json.loads(
    (REPO_ROOT / "agent-bundle-contracts/cluster-values/v1alpha1/cluster-values.schema.json").read_text()
)
CHART_SCHEMA = json.loads(
    (REPO_ROOT / "harness/hermes/charts/hermes-profile/values.schema.json").read_text()
)


# Values the canonical schema still ACCEPTS but the chart deliberately no
# longer implements. The superset rule holds in one direction only for
# these: `cluster-values/v1alpha1` is frozen and immutable, so a retired
# provider cannot be removed from it without a version bump - but leaving
# the chart able to render it would defeat the retirement.
#
# The resulting failure is loud and actionable rather than silent: helm
# refuses with "providers.ingress must be one of the following", which is
# exactly what ADR-9 wants a half-implemented provider to do.
RETIRED = {
    # ADR-9 / #131: three contradictory in-tree descriptions of its status
    # and no test. Templates, guards and sidecar removed.
    "ingress": {"tailscale"},
}


def test_providers_enums_are_a_superset_of_canonical():
    canonical_providers = CANONICAL_SCHEMA["properties"]["providers"]["properties"]
    chart_providers = CHART_SCHEMA["properties"]["providers"]["properties"]
    for key in ("compute", "secret", "ingress", "backup"):
        canonical_enum = set(canonical_providers[key]["enum"]) - RETIRED.get(key, set())
        chart_enum = set(chart_providers[key]["enum"])
        missing = canonical_enum - chart_enum
        assert not missing, (
            f"providers.{key}: canonical cluster-values schema allows "
            f"{sorted(canonical_enum)}, but harness/hermes/charts/hermes-profile/"
            f"values.schema.json is missing {sorted(missing)} - a valid "
            f"canonical cluster-values.yaml using one of those values "
            f"would be rejected by `helm template`."
        )


def test_platform_repo_and_app_project_shapes_are_a_superset_of_canonical():
    """The helm-apps contract's cluster-values additions (platformRepo,
    appProject - replacing the removed workloadCatalog) must be accepted
    by the chart's own values.schema.json: every canonical property name
    must exist in the chart schema with the same type."""
    for block in ("platformRepo", "appProject"):
        canonical = CANONICAL_SCHEMA["properties"][block]["properties"]
        chart = CHART_SCHEMA["properties"][block]["properties"]
        missing = set(canonical) - set(chart)
        assert not missing, (
            f"{block}: canonical schema allows fields {missing} that "
            f"harness/hermes/charts/hermes-profile/values.schema.json doesn't define - "
            f"a valid canonical cluster-values.yaml using one of those "
            f"fields would be rejected by `helm template`."
        )
        for field, canonical_spec in canonical.items():
            assert chart[field].get("type") == canonical_spec.get("type"), (
                f"{block}.{field}: canonical type {canonical_spec.get('type')!r} "
                f"!= chart schema type {chart[field].get('type')!r}"
            )


def test_workload_catalog_stays_removed():
    """The workloadCatalog indirection was removed by the helm-apps
    contract - neither schema may quietly grow it back."""
    assert "workloadCatalog" not in CANONICAL_SCHEMA["properties"]
    assert "workloadCatalog" not in CHART_SCHEMA["properties"]


def test_cloudflare_block_consistent_between_canonical_and_chart():
    """Issue #20 [G2]: the cloudflare block now has a canonical home; the
    chart's block must accept everything the canonical shape allows
    (property names compared recursively - the chart is a superset, not a
    divergent copy)."""
    canonical_cf = CANONICAL_SCHEMA["properties"]["cloudflare"]
    chart_cf = CHART_SCHEMA["properties"]["cloudflare"]

    def assert_superset(canonical: dict, chart: dict, path: str) -> None:
        for prop, canonical_sub in (canonical.get("properties") or {}).items():
            assert prop in (chart.get("properties") or {}), (
                f"chart values.schema.json is missing canonical cloudflare "
                f"property {path}.{prop}"
            )
            assert_superset(canonical_sub, chart["properties"][prop], f"{path}.{prop}")

    assert_superset(canonical_cf, chart_cf, "cloudflare")


def test_retired_providers_are_gone_from_the_chart():
    """The inverse of the superset rule: a retired value must NOT be
    accepted by the chart. Without this, deleting a provider's templates
    while leaving its enum entry in place would render an ingress that
    does nothing - which is worse than the contradictory half-state the
    retirement was meant to end."""
    chart_providers = CHART_SCHEMA["properties"]["providers"]["properties"]
    for key, retired in RETIRED.items():
        still_there = retired & set(chart_providers[key]["enum"])
        assert not still_there, (
            f"providers.{key}: {sorted(still_there)} is retired but the chart "
            f"schema still accepts it - `helm template` would render a "
            f"provider with no implementation behind it."
        )
