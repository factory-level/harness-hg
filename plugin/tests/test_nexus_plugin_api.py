"""The Nexus plugin backend (control-plane/nexus/plugin_api.py, ADR-42 M3):
the Argo severity mapping, the rollup ladder, the overlay join, and the
degrade-to-unknown paths. The module is loaded from its plugin location -
it is not part of the gitops_emitter package."""

import importlib.util
import json
import os
import re
import time
from pathlib import Path

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parents[2] / "control-plane" / "nexus" / "plugin_api.py"
)


@pytest.fixture()
def api(monkeypatch):
    spec = importlib.util.spec_from_file_location("nexus_plugin_api", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _plan(**overrides):
    doc = {
        "version": 1,
        "components": [
            {
                "id": "manager",
                "kind": "agent",
                "resolved": True,
                "instances": [
                    {"id": "manager@ca-west", "application": "hermes-manager-ca-west"},
                    {"id": "manager@eu-west", "application": "hermes-manager-eu-west"},
                ],
            },
            {
                "id": "ghost",
                "kind": "application",
                "resolved": False,
                "unresolvedReason": "bind names app 'ghost' which no profile declares",
                "instances": [],
            },
            {"id": "calvin", "kind": "human", "resolved": True, "instances": []},
            {"id": "marketing", "kind": "group", "resolved": True, "instances": []},
        ],
    }
    doc.update(overrides)
    return doc


def _argo_item(name, health, sync):
    return {"metadata": {"name": name}, "status": {"health": {"status": health}, "sync": {"status": sync}}}


def _dest_item(object_ns, dest_ns, name, health, sync):
    """A realistically shaped Application: the object lives in `object_ns`
    (normally `argocd`) and DEPLOYS into `dest_ns` (the workload namespace,
    which is the one the plan carries)."""
    return {
        "metadata": {"name": name, "namespace": object_ns},
        "spec": {"destination": {"namespace": dest_ns}},
        "status": {"health": {"status": health}, "sync": {"status": sync}},
    }


class TestArgoLevel:
    def test_the_severity_table(self, api):
        assert api._argo_level("Healthy", "Synced") == "healthy"
        assert api._argo_level("Healthy", "OutOfSync") == "degraded"
        assert api._argo_level("Progressing", "Synced") == "degraded"
        assert api._argo_level("Suspended", "Synced") == "degraded"
        assert api._argo_level("Degraded", "Synced") == "unhealthy"
        assert api._argo_level("Missing", "OutOfSync") == "unhealthy"
        assert api._argo_level("Unknown", "Synced") == "unknown"
        assert api._argo_level("", "") == "unknown"

    def test_rollup_ladder(self, api):
        assert api._rollup([]) == "unknown"
        assert api._rollup(["healthy", "healthy"]) == "healthy"
        assert api._rollup(["healthy", "unknown"]) == "unknown"
        assert api._rollup(["unknown", "degraded"]) == "degraded"
        assert api._rollup(["degraded", "unhealthy"]) == "unhealthy"


class TestBuildOverlay:
    def test_regional_degradation_rolls_up_with_named_reason(self, api):
        items = [
            _argo_item("hermes-manager-ca-west", "Healthy", "Synced"),
            _argo_item("hermes-manager-eu-west", "Healthy", "OutOfSync"),
        ]
        overlay = api.build_overlay(_plan(), items, "2026-07-29T00:00:00Z")
        manager = overlay["components"]["manager"]
        assert manager["level"] == "degraded"
        assert manager["summary"] == "1 of 2 instances requires attention"
        eu = overlay["instances"]["manager@eu-west"]
        assert eu["level"] == "degraded"
        assert eu["reasons"] == [{"source": "argocd", "message": "OutOfSync / Healthy"}]
        assert eu["observedAt"] == "2026-07-29T00:00:00Z"

    def test_missing_application_is_unknown_never_green(self, api):
        overlay = api.build_overlay(_plan(), [], "t")
        assert overlay["components"]["manager"]["level"] == "unknown"
        assert "no Argo Application" in overlay["instances"]["manager@ca-west"]["reasons"][0]["message"]

    def test_unresolved_component_carries_its_reason(self, api):
        overlay = api.build_overlay(_plan(), [], "t")
        assert overlay["components"]["ghost"]["level"] == "unknown"
        assert "ghost" in overlay["components"]["ghost"]["summary"]

    def test_humans_and_groups_have_no_health(self, api):
        overlay = api.build_overlay(_plan(), [], "t")
        assert "calvin" not in overlay["components"]
        assert "marketing" not in overlay["components"]

    def test_same_named_applications_across_namespaces_are_ambiguous(self, api):
        items = [
            {"metadata": {"name": "hermes-manager-ca-west", "namespace": "argocd"},
             "status": {"health": {"status": "Healthy"}, "sync": {"status": "Synced"}}},
            {"metadata": {"name": "hermes-manager-ca-west", "namespace": "argocd-two"},
             "status": {"health": {"status": "Degraded"}, "sync": {"status": "Synced"}}},
        ]
        overlay = api.build_overlay(_plan(), items, "t")
        inst = overlay["instances"]["manager@ca-west"]
        assert inst["level"] == "unknown"
        assert "ambiguous" in inst["reasons"][0]["message"]

    def test_adapter_unavailable_degrades_to_unknown_with_reason(self, api):
        overlay = api.build_overlay(_plan(), None, "t", unavailable_reason="argo query failed")
        assert overlay["components"]["manager"]["level"] == "unknown"
        assert overlay["instances"]["manager@ca-west"]["reasons"] == [
            {"source": "argocd", "message": "argo query failed"}
        ]


class TestNormalizedOverlay:
    """The runtime-overlay/v1alpha1 contract: every source reports its own
    adapter status, an unconfigured or failed source can never read green,
    rollups are precomputed here so no consumer recomputes them, and links
    are built from exact identity."""

    _LINKS = {"argocdBaseUrl": "https://argocd.example.internal", "grafanaBaseUrl": None}

    def test_every_source_kind_is_present_even_with_no_adapter(self, api):
        overlay = api.build_overlay(_plan(), [], "t")
        assert set(overlay["sources"]) == set(api.SOURCE_KINDS)
        # An omitted row is indistinguishable from a healthy one - which is
        # the exact lie this document exists to prevent.
        for kind in api.SOURCE_KINDS:
            if kind == "argocd":
                continue
            src = overlay["sources"][kind]
            assert src["status"] == "not configured"
            assert src["level"] == "unknown"
            assert src["summary"], f"{kind} must say WHY it is unconfigured"

    def test_unconfigured_or_failed_can_never_be_handed_a_green_level(self, api):
        # The adapter asks for healthy; _source overrides it. This is the
        # invariant that makes "one dead adapter cannot turn the system
        # green" a property of the code, not a rule adapters must follow.
        for status in ("not configured", "failed"):
            assert api._source("backup", status, "healthy", "all good")["level"] == "unknown"
        # A stale source keeps its last-good level - that is the point of it.
        assert api._source("backup", "stale", "healthy", "last seen 09:02")["level"] == "healthy"

    def test_components_carry_every_source_so_the_browser_never_fabricates(self, api):
        overlay = api.build_overlay(_plan(), [], "t")
        kinds = [s["kind"] for s in overlay["components"]["manager"]["sources"]]
        assert kinds == list(api.SOURCE_KINDS)

    def test_rollups_are_precomputed_and_name_the_affected(self, api):
        items = [
            _argo_item("hermes-manager-ca-west", "Healthy", "Synced"),
            _argo_item("hermes-manager-eu-west", "Degraded", "Synced"),
        ]
        overlay = api.build_overlay(_plan(), items, "t")
        agents = overlay["rollups"]["kind:agent"]
        assert agents["level"] == "unhealthy"
        assert agents["members"] == ["manager"]
        # `ghost` is an unresolved application: unknown, and NOT affected -
        # "not observed" is not the same problem as "broken".
        apps = overlay["rollups"]["kind:application"]
        assert apps["level"] == "unknown"
        assert apps["members"] == []

    def test_group_rollup_counts_members_a_collapsed_group_would_hide(self, api):
        plan = _plan()
        plan["view"] = {
            "id": "default",
            "nodes": [
                {"ref": "manager", "position": {"x": 0, "y": 0}, "parent": "marketing"},
                {"ref": "ghost", "position": {"x": 1, "y": 1}, "parent": "marketing"},
            ],
        }
        items = [
            _argo_item("hermes-manager-ca-west", "Degraded", "Synced"),
            _argo_item("hermes-manager-eu-west", "Healthy", "Synced"),
        ]
        overlay = api.build_overlay(plan, items, "t")
        # Membership is declared, not rendered: whether the canvas is
        # currently hiding these cards cannot change the answer.
        assert overlay["rollups"]["group:marketing"]["level"] == "unhealthy"
        assert overlay["rollups"]["group:marketing"]["members"] == ["manager"]

    def test_ungrouped_bucket_has_its_own_scope(self, api):
        # A repository is free to declare a Group whose id is "ungrouped";
        # the bucket must not be able to collide with it.
        overlay = api.build_overlay(_plan(), [], "t")
        assert "bucket:ungrouped" in overlay["rollups"]
        assert set(overlay["rollups"]["bucket:ungrouped"]["members"]) == set()

    def test_argo_link_uses_the_application_object_namespace(self, api):
        # Two different namespaces are in play. The plan carries the
        # DESTINATION namespace (where the workload runs); an Argo URL
        # wants the namespace the Application OBJECT lives in. Building the
        # link from the plan's value would produce a URL to nothing.
        plan = _plan()
        plan["components"][0]["instances"][0]["namespace"] = "hermes-manager"
        items = [_dest_item("argocd", "hermes-manager", "hermes-manager-ca-west", "Healthy", "Synced")]
        overlay = api.build_overlay(plan, items, "t", links=self._LINKS)
        link = overlay["instances"]["manager@ca-west"]["links"][0]
        assert link["url"] == (
            "https://argocd.example.internal/applications/argocd/hermes-manager-ca-west"
        )
        assert link["kind"] == "external"

    def test_no_link_is_guessed_when_no_application_matched(self, api):
        overlay = api.build_overlay(_plan(), [], "t", links=self._LINKS)
        assert "links" not in overlay["instances"]["manager@ca-west"]

    def test_destination_namespace_disambiguates_a_same_named_application(self, api):
        # Name-only matching called this ambiguous and gave up. The two
        # Applications deploy to different workload namespaces, which is
        # exactly the fact the plan carries - so there is nothing ambiguous
        # about it once we key on the destination.
        plan = _plan()
        plan["components"][0]["instances"][0]["namespace"] = "hermes-manager"
        items = [
            _dest_item("argocd", "hermes-manager", "hermes-manager-ca-west", "Healthy", "Synced"),
            _dest_item("argocd-two", "other-tenant", "hermes-manager-ca-west", "Degraded", "Synced"),
        ]
        overlay = api.build_overlay(plan, items, "t")
        assert overlay["instances"]["manager@ca-west"]["level"] == "healthy"

    def test_name_only_fallback_still_refuses_to_guess(self, api):
        # No namespace on the instance (a plan compiled before the field was
        # populated) and two candidates: unknown, never a coin flip.
        items = [
            _dest_item("argocd", "a", "hermes-manager-ca-west", "Healthy", "Synced"),
            _dest_item("argocd-two", "b", "hermes-manager-ca-west", "Degraded", "Synced"),
        ]
        overlay = api.build_overlay(_plan(), items, "t")
        inst = overlay["instances"]["manager@ca-west"]
        assert inst["level"] == "unknown"
        assert "ambiguous" in inst["reasons"][0]["message"]

    def test_hostile_identity_cannot_escape_the_link_path(self, api):
        plan = _plan()
        plan["components"][0]["instances"][0]["namespace"] = "hermes-manager"
        plan["components"][0]["instances"][0]["application"] = "a b/../c#f"
        items = [_dest_item("../../evil?x=1", "hermes-manager", "a b/../c#f", "Healthy", "Synced")]
        overlay = api.build_overlay(plan, items, "t", links=self._LINKS)
        url = overlay["instances"]["manager@ca-west"]["links"][0]["url"]
        assert url.startswith("https://argocd.example.internal/applications/")
        tail = url.split("/applications/", 1)[1]
        # Exactly two segments, and nothing structural survived inside
        # either: no slash to traverse with, no `?` to start a query, no
        # `#` to start a fragment, no raw space.
        assert len(tail.split("/")) == 2
        for bad in ("?", "#", " "):
            assert bad not in tail

    def test_a_dot_segment_refuses_to_build_a_link_at_all(self, api):
        # `.` and `..` are unreserved, so percent-encoding does not touch
        # them - and a lone `..` is the one segment a browser normalises
        # away, walking the URL out of /applications/.
        assert api._join("https://argo.test", "applications", "..", "app") is None
        assert api._join("https://argo.test", "applications", ".", "app") is None
        assert api._join("https://argo.test", "applications", "ns", "app") == (
            "https://argo.test/applications/ns/app"
        )

    def test_no_link_when_no_base_is_configured(self, api):
        items = [_dest_item("argocd", "hermes-manager", "hermes-manager-ca-west", "Healthy", "Synced")]
        overlay = api.build_overlay(_plan(), items, "t")
        assert "links" not in overlay["instances"]["manager@ca-west"]

    def test_component_links_point_at_what_is_broken(self, api):
        plan = _plan()
        for inst in plan["components"][0]["instances"]:
            inst["namespace"] = "hermes-manager"
        items = [
            _dest_item("argocd", "hermes-manager", "hermes-manager-ca-west", "Healthy", "Synced"),
            _dest_item("argocd", "hermes-manager", "hermes-manager-eu-west", "Degraded", "Synced"),
        ]
        overlay = api.build_overlay(plan, items, "t", links=self._LINKS)
        links = overlay["components"]["manager"]["sources"][0]["links"]
        assert [ln["instanceId"] for ln in links] == ["manager@eu-west"]

    def test_reasons_are_bounded_and_say_how_many_were_dropped(self, api):
        trimmed = api._truncate_reasons([{"message": f"m{i}"} for i in range(9)])
        assert len(trimmed) == 5
        assert trimmed[-1]["message"] == "+5 more"

    def test_summaries_and_reasons_are_clipped(self, api):
        assert len(api._clip("x" * 500, 120)) == 120
        long = api._truncate_reasons([{"message": "y" * 500}])[0]["message"]
        assert len(long) == 200

    def test_a_failed_adapter_is_distinguishable_from_a_disabled_one(self, api):
        failed = api.build_overlay(_plan(), None, "t", unavailable_reason="argo query failed")
        assert failed["sources"]["argocd"]["status"] == "failed"
        assert failed["sources"]["argocd"]["level"] == "unknown"
        off = api.build_overlay(_plan(), None, "t", unavailable_reason="argo adapter disabled")
        assert off["sources"]["argocd"]["status"] == "not configured"

    def test_stale_is_a_document_level_fact(self, api):
        assert api.build_overlay(_plan(), [], "t")["stale"] is False
        stale = api.build_overlay(
            _plan(),
            [],
            "t",
            sources={"backup": api._source("backup", "stale", "healthy", "last seen 09:02", "t0")},
        )
        assert stale["stale"] is True

    def test_sheet_and_nav_rollups_come_from_the_workspace(self, api, tmp_path, monkeypatch):
        # The M05 hierarchy: sheet + top-nav aggregates over DECLARED
        # membership, computed by the same ladder as everything else.
        monkeypatch.setattr(api, "WORKSPACE_PATH", tmp_path / "workspace.json")
        ws = {
            "apiVersion": "nexus.hermes.ai/v1alpha1",
            "kind": "NexusWorkspace",
            "environment": "local",
            "revision": 3,
            "featureFlags": {},
            "sheets": [
                {"id": "fleet", "name": "Fleet Canvas", "mode": "operational",
                 "cards": [{"ref": "manager", "position": {"x": 0, "y": 0}}],
                 "shapes": [], "texts": [], "notes": [], "connections": []},
                # A concept sheet holding the OTHER workload - its problem
                # must still reach nav:fleet.
                {"id": "ideas", "name": "Ideas", "mode": "concept",
                 "cards": [{"ref": "ghost", "position": {"x": 0, "y": 0}}],
                 "shapes": [], "texts": [], "notes": [], "connections": []},
            ],
        }
        (tmp_path / "workspace.json").write_text(json.dumps(ws))
        items = [
            _argo_item("hermes-manager-ca-west", "Degraded", "Synced"),
            _argo_item("hermes-manager-eu-west", "Healthy", "Synced"),
        ]
        overlay = api.build_overlay(_plan(), items, "t")
        # Sheet rollups: only the components ON the sheet contribute.
        assert overlay["rollups"]["sheet:fleet"]["level"] == "unhealthy"
        assert overlay["rollups"]["sheet:fleet"]["members"] == ["manager"]
        assert overlay["rollups"]["sheet:ideas"]["level"] == "unknown"  # ghost is unresolved
        assert overlay["rollups"]["sheet:ideas"]["members"] == []
        # nav:fleet spans BOTH sheets, concept included.
        assert overlay["rollups"]["nav:fleet"]["level"] == "unhealthy"
        assert overlay["rollups"]["nav:fleet"]["members"] == ["manager"]
        assert overlay["rollups"]["nav:agents"]["members"] == ["manager"]

    def test_nav_system_rolls_up_platform_sources_with_inventory_members(self, api):
        # #276: the System tab's aggregate comes from the platform SOURCE
        # levels, and its members are inventory workload ids - so the
        # popover names the machinery, not fleet components.
        overlay = api.build_overlay(
            _plan(),
            [_argo_item("hermes-manager-ca-west", "Healthy", "Synced")],
            "t",
            sources={
                "communication": api._source(
                    "communication", "configured", "unhealthy", "3 dead-lettered events waiting", "t"
                ),
                "backup": api._source("backup", "configured", "healthy", "all current", "t"),
                "reconciliation": api._source(
                    "reconciliation", "configured", "healthy", "synced", "t"
                ),
            },
        )
        roll = overlay["rollups"]["nav:system"]
        assert roll["level"] == "unhealthy"
        # Every inventory workload mapped to the failing source is named.
        assert "communication-router" in roll["members"]
        assert "communication-queue" in roll["members"]
        assert "webhook-gateway" in roll["members"]
        assert "chatops" in roll["members"]
        # Healthy/unmapped workloads are not.
        assert "argocd" not in roll["members"]
        assert "nexus" not in roll["members"]

    def test_nav_system_never_reads_green_while_a_source_is_unobserved(self, api):
        # grafana/uptime/etc. default to not configured => unknown, and
        # unknown propagates - the System dot cannot be quietly green on a
        # half-wired platform.
        overlay = api.build_overlay(
            _plan(), [_argo_item("hermes-manager-ca-west", "Healthy", "Synced")], "t"
        )
        assert overlay["rollups"]["nav:system"]["level"] == "unknown"
        assert "not yet observed" in overlay["rollups"]["nav:system"]["summary"]

    def test_without_a_workspace_nav_fleet_covers_everything(self, api, tmp_path, monkeypatch):
        monkeypatch.setattr(api, "WORKSPACE_PATH", tmp_path / "none.json")
        items = [_argo_item("hermes-manager-ca-west", "Degraded", "Synced")]
        overlay = api.build_overlay(_plan(), items, "t")
        assert overlay["rollups"]["nav:fleet"]["level"] == "unhealthy"
        assert "sheet:fleet" not in overlay["rollups"]

    def test_the_envelope_is_versioned(self, api):
        overlay = api.build_overlay(_plan(), [], "t")
        assert overlay["apiVersion"] == "nexus.hermes.ai/v1alpha2"
        assert overlay["kind"] == "RuntimeOverlay"


def _alert(name, severity, namespace, state="firing"):
    return {
        "state": state,
        "labels": {"alertname": name, "severity": severity, "namespace": namespace},
        "annotations": {"summary": f"{name} is unhappy"},
    }


def _cronjob(name, namespace, *, suspend=False, last_success=None):
    doc = {
        "metadata": {"name": name, "namespace": namespace},
        "spec": {"suspend": suspend},
        "status": {},
    }
    if last_success:
        doc["status"]["lastSuccessfulTime"] = last_success
    return doc


def _ns_plan():
    """The plan with workload namespaces populated - the join key every
    namespace-scoped adapter uses."""
    plan = _plan()
    for inst in plan["components"][0]["instances"]:
        inst["namespace"] = "hermes-manager"
    return plan


class TestAdapters:
    NOW = "2026-07-31T12:00:00Z"

    def test_grafana_narrows_alerts_by_namespace(self, api):
        alerts = [
            _alert("AgentDown", "critical", "hermes-manager"),
            _alert("DiskWarn", "warning", "hermes-other"),
            _alert("Resolved", "critical", "hermes-manager", state="resolved"),
        ]
        src, per = api.grafana_source(_ns_plan(), alerts, self.NOW)
        # Fleet-wide: two firing (the resolved one does not count), worst
        # is critical.
        assert src["level"] == "unhealthy"
        assert src["summary"] == "2 firing alerts"
        # This component only owns the one in its namespace.
        assert per["manager"]["level"] == "unhealthy"
        assert per["manager"]["summary"] == "1 firing alert"
        assert "AgentDown" in per["manager"]["reasons"][0]["message"]

    def test_no_firing_alert_is_healthy_not_unknown(self, api):
        # Absence IS the signal for alerting - that is what an alert means.
        # This is the one adapter where "no data" is good news.
        src, per = api.grafana_source(_ns_plan(), [], self.NOW)
        assert src["level"] == "healthy"
        assert per["manager"]["level"] == "healthy"
        assert per["manager"]["summary"] == "no firing alerts"

    def test_alert_severity_maps_to_the_ladder(self, api):
        for severity, expected in (
            ("critical", "unhealthy"),
            ("error", "unhealthy"),
            ("warning", "degraded"),
            ("chatty", "degraded"),
        ):
            src, _ = api.grafana_source(_ns_plan(), [_alert("X", severity, "hermes-manager")], self.NOW)
            assert src["level"] == expected, severity

    def test_backup_reports_suspended_and_stale_routines(self, api):
        cronjobs = [
            _cronjob("nexus-state", "hermes-manager", last_success="2026-07-31T09:00:00Z"),
            _cronjob("agent-state", "hermes-manager", suspend=True),
            _cronjob("old-state", "hermes-manager", last_success="2026-07-01T09:00:00Z"),
        ]
        src, per = api.backup_source(_ns_plan(), cronjobs, self.NOW)
        assert src["status"] == "configured"
        assert src["level"] == "degraded"
        messages = " ".join(r["message"] for r in per["manager"]["reasons"])
        assert "agent-state: suspended" in messages
        assert "old-state: last success" in messages
        # The current one is not named as a problem.
        assert "nexus-state" not in messages

    def test_a_routine_that_never_ran_is_not_healthy(self, api):
        src, _ = api.backup_source(_ns_plan(), [_cronjob("new", "hermes-manager")], self.NOW)
        assert src["level"] == "degraded"
        assert "never completed" in src["reasons"][0]["message"]

    def test_no_routine_in_a_namespace_is_not_configured(self, api):
        src, per = api.backup_source(_ns_plan(), [], self.NOW)
        assert src["status"] == "not configured"
        assert src["level"] == "unknown"
        assert per["manager"]["status"] == "not configured"

    def test_backup_in_another_namespace_does_not_count(self, api):
        cronjobs = [_cronjob("elsewhere", "hermes-other", suspend=True)]
        _, per = api.backup_source(_ns_plan(), cronjobs, self.NOW)
        assert per["manager"]["status"] == "not configured"

    def test_uptime_without_series_is_not_configured(self, api):
        src, _ = api.uptime_source(_ns_plan(), [], self.NOW)
        assert src["status"] == "not configured"
        assert src["level"] == "unknown"

    def test_uptime_with_series_is_configured_but_never_green(self, api):
        series = [{"metric": {"key": "agents_manager"}}, {"metric": {"key": "agents_research"}}]
        src, _ = api.uptime_source(_ns_plan(), series, self.NOW)
        assert src["status"] == "configured"
        # A cumulative counter cannot say "passing now"; claiming healthy
        # from one would be the exact failure this document prevents.
        assert src["level"] == "unknown"
        assert "2 probes reporting" in src["summary"]

    def test_communication_without_a_router_series_is_not_configured(self, api):
        src, per = api.communication_source(_ns_plan(), [], [], self.NOW)
        assert src["status"] == "not configured"
        assert src["level"] == "unknown"
        assert per == {}

    def test_communication_with_empty_dlqs_is_healthy(self, api):
        up = [{"metric": {"__name__": "hermes_router_up"}, "value": [0, "1"]}]
        dlq = [{"metric": {"edge": "a->0:agent:b"}, "value": [0, "0"]}]
        src, _ = api.communication_source(_ns_plan(), up, dlq, self.NOW)
        assert src["status"] == "configured"
        assert src["level"] == "healthy"
        assert "queues empty" in src["summary"]

    def test_a_router_that_cannot_reach_its_queue_is_unhealthy(self, api):
        # The failure this series exists for: the router used to 503 its
        # whole /metrics when redis was unreachable, which took
        # hermes_router_up with it and made this adapter say "not
        # configured" - the dashboard going quiet exactly when the durable
        # transport died. Now it is a loud, specific unhealthy.
        up = [{"metric": {}, "value": [0, "1"]}]
        redis_down = [{"metric": {}, "value": [0, "0"]}]
        src, _ = api.communication_source(_ns_plan(), up, [], self.NOW, redis_down)
        assert src["status"] == "configured"
        assert src["level"] == "unhealthy"
        assert "cannot reach the durable queue" in src["summary"]
        assert "stalled" in src["reasons"][0]["message"]

    def test_pending_deliveries_are_a_lag_signal_not_a_failure(self, api):
        # Events in flight are normal; they are degraded (worth seeing),
        # never unhealthy (worth paging).
        up = [{"metric": {}, "value": [0, "1"]}]
        pending = [{"metric": {"edge": "mgr/alerts@global->0:agent:sre"}, "value": [0, "4"]}]
        src, _ = api.communication_source(_ns_plan(), up, [], self.NOW, [], pending)
        assert src["level"] == "degraded"
        assert src["summary"] == "4 events awaiting delivery"
        assert "awaiting delivery on" in src["reasons"][0]["message"]

    def test_dead_letters_outrank_pending(self, api):
        up = [{"metric": {}, "value": [0, "1"]}]
        dlq = [{"metric": {"edge": "e1"}, "value": [0, "2"]}]
        pending = [{"metric": {"edge": "e2"}, "value": [0, "5"]}]
        src, _ = api.communication_source(_ns_plan(), up, dlq, self.NOW, [], pending)
        assert src["level"] == "unhealthy"
        assert "dead-lettered" in src["summary"]

    def test_dead_lettered_events_are_unhealthy_and_name_the_edge(self, api):
        # A nonzero DLQ depth means deliveries exhausted their retries and
        # a human owes the queue a decision - not a "degraded, maybe fine".
        up = [{"metric": {}, "value": [0, "1"]}]
        dlq = [
            {"metric": {"edge": "mgr/kanban-alerts@global->0:agent:sre"}, "value": [0, "3"]},
            {"metric": {"edge": "quiet-edge"}, "value": [0, "0"]},
        ]
        src, _ = api.communication_source(_ns_plan(), up, dlq, self.NOW)
        assert src["level"] == "unhealthy"
        assert src["summary"] == "3 dead-lettered events waiting"
        assert "kanban-alerts" in src["reasons"][0]["message"]
        assert len(src["reasons"]) == 1  # the empty queue is not a reason

    def _recon(self, api, doc, at="2026-07-31T12:00:00Z", stale=1800.0):
        src, per = api.reconciliation_source(doc, at, stale)
        assert per == {}  # installation-scoped, never narrowed
        return src

    def test_reconciliation_absent_is_not_configured(self, api):
        src = self._recon(api, None)
        assert src["status"] == "not configured"
        assert src["level"] == "unknown"

    def test_reconciliation_phases_map_to_the_ladder(self, api):
        for phase, expected in (
            ("synced", "healthy"),
            ("applying", "healthy"),  # a reconciler mid-work is the system functioning
            ("waiting-for-argocd", "degraded"),
            ("degraded", "degraded"),
            ("failed", "unhealthy"),
            ("authentication-required", "unhealthy"),
        ):
            src = self._recon(api, {"phase": phase, "observedAt": "2026-07-31T11:59:00Z"})
            assert src["level"] == expected, phase
            assert src["status"] == "configured"

    def test_a_dead_timer_reads_unknown_not_its_last_success(self, api):
        # The reconciler last reported synced two hours ago and has been
        # silent since. Serving that as healthy is exactly the false green
        # M01 exists to prevent.
        src = self._recon(api, {"phase": "synced", "observedAt": "2026-07-31T10:00:00Z"})
        assert src["status"] == "stale"
        assert src["level"] == "unknown"
        assert "is the timer running" in src["summary"]
        # The original observation time survives - its distance from the
        # document's observedAt IS the staleness.
        assert src["observedAt"] == "2026-07-31T10:00:00Z"

    def test_a_failed_commit_names_both_shas(self, api):
        src = self._recon(
            api,
            {
                "phase": "failed",
                "observedAt": "2026-07-31T11:59:30Z",
                "desiredSha": "9a3d0e2f1b8c7d6e5a4b3c2d1e0f9a8b7c6d5e4f",
                "appliedSha": "4f2c1ab9d7e3c5b1a0f8e6d4c2b0a9f8e7d6c5b4",
                "summary": "validation failed: hg topology doctor exited 1",
                "retryable": True,
            },
        )
        assert src["level"] == "unhealthy"
        # Running vs refused, both visible: the bad commit is NOT live.
        assert src["summary"] == "commit 9a3d0e2f1b8c rejected; running 4f2c1ab9d7e3"
        messages = " ".join(r["message"] for r in src["reasons"])
        assert "topology doctor" in messages
        assert "hg reconcile retry" in messages

    def test_hand_edited_record_is_re_scrubbed(self, api):
        base = {"phase": "synced", "observedAt": "2026-07-31T11:59:30Z"}
        # An unknown phase is malformed, not defaulted.
        assert self._recon(api, {**base, "phase": "rolling-back"})["status"] == "failed"
        # A malformed SHA never renders.
        src = self._recon(api, {**base, "appliedSha": "https://evil.test/x"})
        assert "evil" not in json.dumps(src)
        # A URL-shaped summary survived the writer's scrub only by hand
        # edit; it is dropped, not clipped.
        src = self._recon(api, {**base, "summary": "see https://evil.test/paste?token=abc"})
        assert "evil" not in json.dumps(src)

    def test_eval_is_wired_in_and_says_it_has_nothing(self, api):
        src, per = api.eval_source(_ns_plan())
        assert src["status"] == "not configured"
        assert src["level"] == "unknown"
        assert per["manager"]["status"] == "not configured"


class TestCollection:
    NOW = "2026-07-31T12:00:00Z"
    LATER = "2026-07-31T12:00:15Z"

    def _cfg(self, **over):
        cfg = {"integrations": {"prometheus": {"baseUrl": "http://prom.test:9090"}}}
        cfg.update(over)
        return cfg

    def test_a_failed_adapter_serves_last_good_marked_stale(self, api, monkeypatch):
        api._last_good.clear()
        monkeypatch.setattr(api, "_prom_alerts", lambda _b: [_alert("X", "warning", "hermes-manager")])
        monkeypatch.setattr(api, "_k8s_get", lambda *a, **k: {"items": []})
        first, _, _ = api.collect_sources(_ns_plan(), self._cfg(), self.NOW)
        assert first["grafana"]["status"] == "configured"
        assert first["grafana"]["level"] == "degraded"

        def boom(_b):
            raise RuntimeError("prom down at http://prom.test:9090/api/v1/alerts")

        monkeypatch.setattr(api, "_prom_alerts", boom)
        second, _, _ = api.collect_sources(_ns_plan(), self._cfg(), self.LATER)
        assert second["grafana"]["status"] == "stale"
        # The last-good LEVEL survives, and so does its original
        # observation time - the gap between that and the document's IS
        # the staleness the UI renders.
        assert second["grafana"]["level"] == "degraded"
        assert second["grafana"]["observedAt"] == self.NOW

    def test_a_failure_with_no_last_good_is_failed_not_green(self, api, monkeypatch):
        api._last_good.clear()

        def boom(*_a, **_k):
            raise RuntimeError("nope")

        monkeypatch.setattr(api, "_prom_alerts", boom)
        monkeypatch.setattr(api, "_k8s_get", boom)
        sources, _, _ = api.collect_sources(_ns_plan(), self._cfg(), self.NOW)
        for kind in ("grafana", "backup"):
            assert sources[kind]["status"] == "failed"
            assert sources[kind]["level"] == "unknown"

    def test_adapter_failure_detail_never_reaches_the_browser(self, api, monkeypatch):
        api._last_good.clear()

        def boom(*_a, **_k):
            raise RuntimeError("dial tcp 10.0.0.5:9090: connection refused; token=/var/run/secrets/x")

        monkeypatch.setattr(api, "_prom_alerts", boom)
        monkeypatch.setattr(api, "_k8s_get", boom)
        sources, _, _ = api.collect_sources(_ns_plan(), self._cfg(), self.NOW)
        blob = json.dumps(sources)
        assert "10.0.0.5" not in blob
        assert "/var/run/secrets" not in blob

    def test_no_prometheus_configured_is_not_configured_not_failed(self, api, monkeypatch):
        api._last_good.clear()
        monkeypatch.setattr(api, "_k8s_get", lambda *a, **k: {"items": []})
        sources, _, _ = api.collect_sources(_ns_plan(), {"integrations": {}}, self.NOW)
        # "never switched on" and "broken" are different operator problems.
        assert sources["grafana"]["status"] == "not configured"
        assert sources["uptime"]["status"] == "not configured"

    def test_one_dead_adapter_leaves_the_others_intact(self, api, monkeypatch):
        api._last_good.clear()

        def boom(_b):
            raise RuntimeError("prom down")

        monkeypatch.setattr(api, "_prom_alerts", boom)
        monkeypatch.setattr(
            api,
            "_k8s_get",
            lambda *a, **k: {"items": [_cronjob("n", "hermes-manager", last_success=self.NOW)]},
        )
        sources, _, _ = api.collect_sources(_ns_plan(), self._cfg(), self.NOW)
        assert sources["grafana"]["status"] == "failed"
        assert sources["backup"]["status"] == "configured"
        assert sources["backup"]["level"] == "healthy"

    def test_component_rows_prefer_the_narrowed_answer(self, api):
        overlay = api.build_overlay(
            _ns_plan(),
            [],
            self.NOW,
            sources={"backup": api._source("backup", "configured", "healthy", "fleet-wide")},
            component_sources={
                "backup": {"manager": api._source("backup", "configured", "degraded", "mine")}
            },
        )
        rows = {s["kind"]: s for s in overlay["components"]["manager"]["sources"]}
        assert rows["backup"]["summary"] == "mine"
        # A component the adapter said nothing about falls back to the
        # fleet-wide entry rather than to a fabricated row.
        rows_ghost = {s["kind"]: s for s in overlay["components"]["ghost"]["sources"]}
        assert rows_ghost["backup"]["summary"] == "fleet-wide"


class TestHealthEndpoint:
    def _setup(self, api, tmp_path, monkeypatch, *, argo=None, fail=False, enabled=True):
        plan_file = tmp_path / "deployments" / "dashboard" / "nexus-plan.json"
        plan_file.parent.mkdir(parents=True)
        plan_file.write_text(json.dumps(_plan()), encoding="utf-8")
        monkeypatch.setattr(
            api, "_load_config", lambda: {"repoPath": str(tmp_path), "adapters": {"argo": {"enabled": enabled}}}
        )
        if fail:
            def boom(_ctx):
                raise RuntimeError("kubectl exploded: /home/operator/.kube/config server=10.0.0.5")
            monkeypatch.setattr(api, "_run_kubectl", boom)
        else:
            monkeypatch.setattr(api, "_run_kubectl", lambda _ctx: argo or [])

    def test_live_overlay(self, api, tmp_path, monkeypatch):
        self._setup(api, tmp_path, monkeypatch, argo=[_argo_item("hermes-manager-ca-west", "Healthy", "Synced")])
        overlay = api.get_nexus_health()
        assert overlay["instances"]["manager@ca-west"]["level"] == "healthy"
        assert overlay["integrations"]["argocd"] is True

    def test_kubectl_failure_is_sanitized_and_never_500s(self, api, tmp_path, monkeypatch):
        self._setup(api, tmp_path, monkeypatch, fail=True)
        overlay = api.get_nexus_health()
        assert overlay["components"]["manager"]["level"] == "unknown"
        # stderr detail (paths, server addresses) must never reach the browser
        assert "10.0.0.5" not in json.dumps(overlay)
        assert ".kube" not in json.dumps(overlay)

    def test_disabled_adapter_reports_unknown_never_healthy(self, api, tmp_path, monkeypatch):
        self._setup(api, tmp_path, monkeypatch, enabled=False)
        overlay = api.get_nexus_health()
        assert overlay["components"]["manager"]["level"] == "unknown"
        assert overlay["integrations"]["argocd"] is False


class TestSafeLinks:
    def test_base_url_allowlist(self, api):
        assert api._safe_base_url("https://argocd.example.dev/") == "https://argocd.example.dev"
        assert api._safe_base_url("http://grafana.internal") == "http://grafana.internal"
        assert api._safe_base_url("javascript:alert(1)") is None
        assert api._safe_base_url("https://user:pass@argocd.example.dev") is None
        assert api._safe_base_url("ftp://argocd.example.dev") is None
        assert api._safe_base_url("https://grafana.example/?orgId=1") is None
        assert api._safe_base_url("https://grafana.example/#frag") is None
        assert api._safe_base_url("not a url") is None
        assert api._safe_base_url(None) is None


class TestToolUrls:
    """External tool URLs (#469, spec §23): operator config served through
    the existing `_links(cfg)` envelope block, NOT inventory.json (that's
    imported by system.tsx at build time - an operator edit there would
    split-brain the served copy against the built view)."""

    def test_absent_key_means_absent_block(self, api):
        assert "toolUrls" not in api._links({})
        assert "toolUrls" not in api._links({"integrations": {}})

    def test_https_urls_pass_through_keyed_by_inventory_id(self, api):
        cfg = {"toolUrls": {"grafana": "https://grafana.example.dev", "argocd": "https://argocd.example.dev"}}
        assert api._links(cfg)["toolUrls"] == {
            "grafana": "https://grafana.example.dev",
            "argocd": "https://argocd.example.dev",
        }

    def test_http_and_credentialed_urls_are_dropped_not_the_whole_block(self, api):
        # Same gate as every other authored link (_safe_https_url) - one
        # bad entry does not take the rest of the map down with it.
        cfg = {
            "toolUrls": {
                "good": "https://tool.example.dev",
                "http": "http://tool.example.dev",
                "creds": "https://user:pass@tool.example.dev",
                "query": "https://tool.example.dev/?x=1",
                "not-a-url": "not a url",
            }
        }
        assert api._links(cfg)["toolUrls"] == {"good": "https://tool.example.dev"}

    def test_all_entries_invalid_means_absent_block_not_an_empty_one(self, api):
        cfg = {"toolUrls": {"bad": "http://tool.example.dev"}}
        assert "toolUrls" not in api._links(cfg)

    def test_non_mapping_toolurls_is_ignored(self, api):
        assert "toolUrls" not in api._links({"toolUrls": "not a mapping"})
        assert "toolUrls" not in api._links({"toolUrls": ["not", "a", "mapping"]})


class TestLayoutOverlay:
    """The legacy layout VALIDATOR survives as the projection input for
    default_workspace (the /nexus/views routes are gone - the workspace
    document is the only write path, ADR-56)."""

    def test_validator_accepts_and_rejects(self, api):
        from fastapi import HTTPException

        doc = {"version": 1, "positions": {"manager": {"x": 10, "y": -20}}, "viewport": {"x": 0, "y": 0, "zoom": 0.8}}
        assert api.validate_layout(doc) == doc
        bad = [
            {"version": 1, "positions": {}, "secrets": {"x": 1}},
            {"version": 2, "positions": {}},
            {"version": 1, "positions": {"a": {"x": 1e9, "y": 0}}},
            {"version": 1, "positions": {"UPPER!": {"x": 1, "y": 2}}},
            # bool is an int subclass and must not pass as a coordinate
            {"version": 1, "positions": {"a": {"x": True, "y": 0}}},
        ]
        for d in bad:
            with pytest.raises(HTTPException):
                api.validate_layout(d)

    def test_read_rejects_view_id_traversal(self, api, tmp_path, monkeypatch):
        from fastapi import HTTPException

        monkeypatch.setattr(api, "STATE_DIR", tmp_path / "layouts")
        with pytest.raises(HTTPException):
            api.read_layout("../escape")

    def test_schema_incompatible_stored_file_is_ignored(self, api, tmp_path, monkeypatch):
        monkeypatch.setattr(api, "STATE_DIR", tmp_path / "layouts")
        (tmp_path / "layouts").mkdir(parents=True)
        (tmp_path / "layouts" / "default.json").write_text('{"version": 99}', encoding="utf-8")
        assert api.read_layout("default") is None


class TestFeatures:
    """The flag registry + operator state (ADR-43): registry defaults,
    lenient read, loud write, atomic bounded storage."""

    _REGISTRY = [
        {"id": "repository-links", "title": "Repository links",
         "description": "", "milestone": "M2", "defaultOff": True},
        {"id": "search", "title": "Search", "description": "",
         "milestone": "M5", "defaultOff": True},
    ]

    class _Req:
        """Features writes require the operator role now. Empty ownerEmails
        is single-operator mode, so a bare request IS the operator - these
        tests are about the payload contract, not the gate (which
        TestDeploymentCapabilities owns)."""

        def __init__(self, headers=None):
            self.headers = headers or {}

    def _use_tmp(self, api, tmp_path, monkeypatch, registry=None):
        monkeypatch.setattr(api, "FEATURES_PATH", tmp_path / "state" / "features.json")
        monkeypatch.setattr(api, "FEATURES", registry if registry is not None else list(self._REGISTRY))

    def test_defaults_off_until_enabled(self, api, tmp_path, monkeypatch):
        self._use_tmp(api, tmp_path, monkeypatch)
        assert api.read_features() == {"repository-links": False, "search": False}
        doc = api.get_features()
        assert doc["features"][0]["milestone"] == "M2"
        assert all(f["enabled"] is False for f in doc["features"])

    def test_put_roundtrip_and_atomicity(self, api, tmp_path, monkeypatch):
        self._use_tmp(api, tmp_path, monkeypatch)
        out = api.put_features(self._Req(), {"version": 1, "enabled": {"repository-links": True}})
        assert out["features"] == {"repository-links": True, "search": False}
        assert api.read_features()["repository-links"] is True
        assert list((tmp_path / "state").glob("*.tmp")) == []

    def test_unknown_id_rejected_on_write(self, api, tmp_path, monkeypatch):
        from fastapi import HTTPException

        self._use_tmp(api, tmp_path, monkeypatch)
        with pytest.raises(HTTPException) as exc:
            api.put_features(self._Req(), {"version": 1, "enabled": {"repositry-links": True}})
        assert exc.value.status_code == 400
        with pytest.raises(HTTPException):
            api.put_features(self._Req(), {"version": 1, "enabled": {"search": "yes"}})
        with pytest.raises(HTTPException):
            api.put_features(self._Req(), {"version": 2, "enabled": {}})
        with pytest.raises(HTTPException):
            api.put_features(self._Req(), {"version": 1, "enabled": {}, "extra": 1})

    def test_unknown_id_ignored_on_read(self, api, tmp_path, monkeypatch):
        # A newer file naming flags this server has never heard of must
        # not break the flags it does know.
        self._use_tmp(api, tmp_path, monkeypatch)
        path = tmp_path / "state" / "features.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps({"version": 1, "enabled": {"search": True, "from-the-future": True}}),
            encoding="utf-8",
        )
        assert api.read_features() == {"repository-links": False, "search": True}

    def test_unreadable_file_means_defaults(self, api, tmp_path, monkeypatch):
        self._use_tmp(api, tmp_path, monkeypatch)
        path = tmp_path / "state" / "features.json"
        path.parent.mkdir(parents=True)
        path.write_text("not json{", encoding="utf-8")
        assert api.read_features() == {"repository-links": False, "search": False}

    def test_size_bound(self, api, tmp_path, monkeypatch):
        from fastapi import HTTPException

        self._use_tmp(api, tmp_path, monkeypatch)
        with pytest.raises(HTTPException) as exc:
            api.put_features(self._Req(), {"version": 1, "enabled": {}, "pad": "x" * 20000})
        assert exc.value.status_code == 413

    def test_delete_resets_to_defaults(self, api, tmp_path, monkeypatch):
        self._use_tmp(api, tmp_path, monkeypatch)
        api.put_features(self._Req(), {"version": 1, "enabled": {"search": True}})
        assert api.read_features()["search"] is True
        assert api.delete_features(self._Req())["reset"] is True
        assert api.read_features() == {"repository-links": False, "search": False}


class TestPlanLinkSanitize:
    """The serve-time layer of the ADR-43 link posture: authored links are
    re-sanitized before the browser sees the plan - https only, no
    userinfo, no query/fragment - and the cached document is never
    mutated."""

    def test_serve_time_link_allowlist(self, api):
        plan = {
            "components": [
                {"id": "a", "links": {
                    "repository": "https://ok.dev/repo",
                    "docs": "http://bad.dev/docs",
                    "runbook": "https://user@bad.dev/runbook",
                }},
                {"id": "b", "links": {"repository": "https://bad.dev/x?q=1"}},
                {"id": "c", "links": {"repository": "https://bad.dev/x#frag"}},
                {"id": "d"},
            ]
        }
        out = api.sanitize_plan_links(plan)
        assert out["components"][0]["links"] == {"repository": "https://ok.dev/repo"}
        assert "links" not in out["components"][1]
        assert "links" not in out["components"][2]
        assert "links" not in out["components"][3]
        # Pure: the input (the cached plan) is untouched.
        assert plan["components"][0]["links"]["docs"] == "http://bad.dev/docs"


class TestCommunicationProjection:
    """The Communication view is an ALLOWLIST PROJECTION (ADR-43): the
    router values carry in-cluster URLs, services, namespaces, ports and
    secret names, and none of it may ever serialize to the browser. This
    test IS the contract."""

    _PLAN_YAML = (
        "chatopsSpaces:\n"
        "  - company_discord#sre-alerts\n"
        "durableProvider: redis-streams\n"
        "edges:\n"
        "  - marketing-manager/kanban-alerts@global->0:agent:marketing-sre\n"
        "externalInputs: []\n"
        "producers:\n"
        "  - marketing-manager/content-kanban#alerts\n"
        "  - marketing-manager/content-kanban#alerts\n"
        "routers:\n"
        "  - router@global\n"
    )

    _VALUES_YAML = """\
spec:
  router:
    id: router@global
    scope: global
    namespace: hermes-system-global
    service: hermes-event-router
  chatopsConnections:
    company_discord:
      provider: recording
  durableProvider:
    plugin: redis-streams
  edges:
    - agent:
        handler: alerts
        instance: marketing-sre@ca-west
        namespace: hermes-marketing-sre-ca-west
        path: /webhooks/alerts
        port: 8644
        profile: marketing-sre
        secretName: hermes-marketing-sre-ca-west-env
        service: hermes-marketing-sre-ca-west
        session:
          key: subject
          mode: keyed
        signature: hmac-sha256
        url: http://hermes-marketing-sre-ca-west.hermes-marketing-sre-ca-west.svc.cluster.local:8644/webhooks/alerts
      delivery:
        deadLetter:
          enabled: true
          retention: 14d
        mode: queued
        ordering:
          key: subject
          mode: fifo
          onFailure: dead-letter-and-continue
        retry:
          backoff: exponential
          maxAttempts: 5
      event: observability.alert/v1
      from:
        producer: marketing-manager/content-kanban@global#alerts
      id: marketing-manager/kanban-alerts@global->0:agent:marketing-sre
      kind: agent
      profile: marketing-manager
      route: kanban-alerts
    - chatops:
        alias: company_discord
        destination: sre-alerts
        provider: recording
        space: company_discord#sre-alerts
      delivery:
        mode: queued
      event: observability.alert/v1
      from:
        producer: marketing-manager/content-kanban@global#alerts
      id: marketing-manager/kanban-alerts@global->1:chatops:company_discord-sre-alerts
      kind: chatops
      profile: marketing-manager
      route: kanban-alerts
"""

    def _repo(self, tmp_path):
        comm = tmp_path / "gitops" / "deployments" / "communication"
        (comm / "router-global").mkdir(parents=True)
        (comm / "plan.yaml").write_text(self._PLAN_YAML, encoding="utf-8")
        (comm / "router-global" / "values.yaml").write_text(self._VALUES_YAML, encoding="utf-8")
        return tmp_path / "gitops"

    def test_a_single_scope_fleet_projects_its_edges(self, api, tmp_path):
        # Found live: a single-scope layout elides the scope from the
        # router id, so the emitter writes `deployments/communication/
        # router/` with no suffix. The projection used to glob `router-*`
        # and slice that prefix off, which meant it silently produced an
        # EMPTY graph for the most common fleet shape. The scope is a
        # field in the record; it was never the directory name.
        comm = tmp_path / "gitops" / "deployments" / "communication"
        (comm / "router").mkdir(parents=True)
        (comm / "plan.yaml").write_text(self._PLAN_YAML, encoding="utf-8")
        (comm / "router" / "values.yaml").write_text(
            self._VALUES_YAML.replace("id: router@global", "id: router").replace(
                "scope: global", "scope: local"
            ),
            encoding="utf-8",
        )
        doc = api.project_communication(str(tmp_path / "gitops"))
        assert doc is not None
        assert doc["routers"] == [{"id": "router", "scope": "local"}]
        assert len(doc["edges"]) == 2
        assert all(e["router"] == "local" for e in doc["edges"])

    def test_projection_carries_logical_facts_only(self, api, tmp_path):
        doc = api.project_communication(str(self._repo(tmp_path)))
        assert doc is not None
        assert doc["routers"] == [{"id": "router@global", "scope": "global"}]
        assert doc["producers"] == ["marketing-manager/content-kanban#alerts"]
        agent_edge = doc["edges"][0]
        assert agent_edge["kind"] == "agent"
        assert agent_edge["target"] == {
            "profile": "marketing-sre",
            "instance": "marketing-sre@ca-west",
            "sessionMode": "keyed",
        }
        assert agent_edge["delivery"] == {
            "mode": "queued",
            "orderingMode": "fifo",
            "retryMaxAttempts": 5,
            "deadLetter": True,
        }
        chatops_edge = doc["edges"][1]
        assert chatops_edge["target"] == {"space": "company_discord#sre-alerts", "provider": "recording"}
        assert chatops_edge["delivery"]["deadLetter"] is False

    def test_an_edge_names_its_external_input_source(self, api, tmp_path):
        # The inbound switchboard joins on this identity (ADR 0180) -
        # matching on event alone can claim another webhook's routes.
        comm = tmp_path / "gitops" / "deployments" / "communication"
        (comm / "router-global").mkdir(parents=True)
        (comm / "plan.yaml").write_text(self._PLAN_YAML, encoding="utf-8")
        values = self._VALUES_YAML.replace(
            "      from:\n        producer: marketing-manager/content-kanban@global#alerts\n"
            "      id: marketing-manager/kanban-alerts@global->0",
            "      from:\n        externalInput: gh-hook\n"
            "      id: marketing-manager/kanban-alerts@global->0",
        )
        (comm / "router-global" / "values.yaml").write_text(values, encoding="utf-8")
        doc = api.project_communication(str(tmp_path / "gitops"))
        assert doc is not None
        assert doc["edges"][0]["externalInput"] == "gh-hook"
        # An edge with a plain producer source carries the key as None,
        # never a fabricated identity.
        assert doc["edges"][1]["externalInput"] is None

    def test_every_edge_names_its_plane_and_router_involvement(self, api, tmp_path):
        # #416: the plane vocabulary, asserted per rendered edge. The
        # fixture's edges carry observability.* events, so both are the
        # ALARM plane - and both rode the router, which the record states
        # rather than implies.
        doc = api.project_communication(str(self._repo(tmp_path)))
        for edge in doc["edges"]:
            assert edge["plane"] == "operational-alert"
            assert edge["eventRouterInvolved"] is True

    def test_a_non_alarm_event_is_the_business_plane(self, api, tmp_path):
        comm = tmp_path / "gitops" / "deployments" / "communication"
        (comm / "router-global").mkdir(parents=True)
        (comm / "plan.yaml").write_text(self._PLAN_YAML, encoding="utf-8")
        (comm / "router-global" / "values.yaml").write_text(
            self._VALUES_YAML.replace("observability.alert/v1", "strategy.brief-updated/v1"),
            encoding="utf-8",
        )
        doc = api.project_communication(str(tmp_path / "gitops"))
        for edge in doc["edges"]:
            assert edge["plane"] == "business-event"
            assert edge["alarmClass"] is False

    def test_business_alerts_are_tellable_from_infrastructure_alerts(self, api, monkeypatch):
        # #407: business-health rules label themselves hermes_signal:
        # business, and the projection passes it through as `signal` so
        # the global surface can distinguish them. An unlabelled alert
        # carries no signal key at all - absence, not empty string.
        monkeypatch.setattr(api, "_prom_base", lambda cfg: "http://prom")
        monkeypatch.setattr(
            api,
            "alerts_observation",
            lambda prom, *_: [
                {"state": "firing", "labels": {"alertname": "BusinessOutputBelowMinimum", "hermes_signal": "business", "severity": "warning"}, "annotations": {}},
                {"state": "firing", "labels": {"alertname": "HermesAgentDown", "severity": "critical"}, "annotations": {}},
            ],
        )
        doc = api._firing_alerts({})
        by_name = {a["name"]: a for a in doc["firing"]}
        assert by_name["BusinessOutputBelowMinimum"]["signal"] == "business"
        assert "signal" not in by_name["HermesAgentDown"]

    def test_a_capped_projection_declares_its_truncation(self, api, monkeypatch):
        # #579: the 100-entry cap must never read as a confident total -
        # past it the doc carries truncated: true (and the flag is absent
        # entirely below the cap, keeping small payloads byte-stable).
        monkeypatch.setattr(api, "_prom_base", lambda cfg: "http://prom")
        make = lambda n: [
            {"state": "firing", "labels": {"alertname": f"A{i}", "severity": "warning"}, "annotations": {}}
            for i in range(n)
        ]
        monkeypatch.setattr(api, "alerts_observation", lambda prom, *_: make(150))
        doc = api._firing_alerts({})
        assert len(doc["firing"]) == 100
        assert doc["truncated"] is True
        monkeypatch.setattr(api, "alerts_observation", lambda prom, *_: make(3))
        assert "truncated" not in api._firing_alerts({})

    def test_a_firing_alert_carries_its_drill_down_evidence(self, api, monkeypatch):
        # #413: the drawer's facts - the rule's own labels/annotations
        # (clipped, bounded), the evaluation value, and an authoritative
        # Grafana URL built ON THE SERVER from the one configured base.
        monkeypatch.setattr(api, "_prom_base", lambda cfg: "http://prom")
        monkeypatch.setattr(api, "grafana_base_url", lambda: "http://grafana.local")
        monkeypatch.setattr(
            api,
            "alerts_observation",
            lambda prom, *_: [
                {
                    "state": "firing",
                    "labels": {"alertname": "HermesAgentDown", "severity": "critical", "pod": "manager-0"},
                    "annotations": {"summary": "agent down", "description": "x" * 1000},
                    "value": "1e+00",
                    "activeAt": "2026-08-13T00:00:00Z",
                },
            ],
        )
        alert = api._firing_alerts({})["firing"][0]
        assert alert["labels"]["pod"] == "manager-0"
        # Clipped, never verbatim-unbounded: a 1000-char annotation is cut.
        assert len(alert["annotations"]["description"]) <= 400
        assert alert["value"] == "1e+00"
        assert alert["grafanaUrl"] == "http://grafana.local/alerting/list?search=HermesAgentDown"
        # #554: no namespace label = cluster-scoped = the control plane's.
        assert alert["ownership"] == "control-plane"

    def test_probe_base_falls_back_to_the_public_base(self, api, monkeypatch):
        # #556: the health probe may use an in-cluster probeBaseUrl when
        # the public base sits behind an edge Access gate; without one it
        # probes the public base exactly as before. Embed URLs never read
        # the probe base - grafana_base_url() stays the browser's one.
        monkeypatch.setattr(
            api,
            "_load_config",
            lambda: {"integrations": {"grafana": {"baseUrl": "https://grafana.example"}}},
        )
        assert api.grafana_probe_base_url() == "https://grafana.example"
        assert api.grafana_base_url() == "https://grafana.example"
        monkeypatch.setattr(
            api,
            "_load_config",
            lambda: {
                "integrations": {
                    "grafana": {
                        "baseUrl": "https://grafana.example",
                        "probeBaseUrl": "http://monitoring-grafana.hermes-monitoring.svc",
                    }
                }
            },
        )
        assert api.grafana_probe_base_url() == "http://monitoring-grafana.hermes-monitoring.svc"
        assert api.grafana_base_url() == "https://grafana.example"

    def test_alert_ownership_is_provenance_by_namespace(self, api):
        # #554: the inventory's own namespaces (and cluster infrastructure)
        # are Hermes'; any other namespace belongs to an installed bundle.
        # Absence of a namespace is a cluster-scoped platform rule.
        # #567 widened the answer to a dict so ownership can NAME the
        # bundle when the membership map is supplied.
        assert api.alert_ownership({}) == {"ownership": "control-plane"}
        assert api.alert_ownership({"namespace": "hermes-monitoring"}) == {"ownership": "control-plane"}
        assert api.alert_ownership({"namespace": "argocd"}) == {"ownership": "control-plane"}
        assert api.alert_ownership({"namespace": "kube-system"}) == {"ownership": "control-plane"}
        # The bootstrap's own Nexus namespace is the control plane's even
        # though the inventory records the local loop's (#567).
        assert api.alert_ownership({"namespace": "hermes-nexus"}) == {"ownership": "control-plane"}
        # Without a membership map the coarse pre-#567 split holds.
        assert api.alert_ownership({"namespace": "marketing-engagement"}) == {"ownership": "bundle"}
        assert api.alert_ownership({"namespace": "anything-else"}) == {"ownership": "bundle"}
        # The inventory's non-namespace strings ("operator host",
        # "per profile") never leak into the control-plane set.
        assert "operator host" not in api.CONTROL_PLANE_NAMESPACES
        assert not any("+" in ns or " " in ns for ns in api.CONTROL_PLANE_NAMESPACES)

    def test_edges_and_external_inputs_carry_their_owner_scope(self, api, tmp_path):
        # #567: every projected route names its installed scope. The
        # fixture's edge targets marketing-sre; declare a bundle holding
        # that profile and the edge resolves to it. Without the bundle it
        # is an unbundled profile's route - and an alarm-class route with
        # no profile endpoint at all is the control plane's own routing.
        repo = self._repo(tmp_path)
        doc = api.project_communication(str(repo))
        edge = doc["edges"][0]
        # No bundles compiled: the route serves an unbundled profile.
        assert edge["ownership"] == "unbundled"
        d = Path(repo) / "deployments" / "bundles" / "ops-core"
        d.mkdir(parents=True)
        (d / "values.yaml").write_text("spec:\n  name: ops-core\n  profiles:\n    - name: marketing-sre\n")
        (d / "deployment.yaml").write_text(
            "spec:\n  id: ops-core\n  namespace: hermes-ops-core\n  displayName: Ops Core\n"
        )
        doc = api.project_communication(str(repo))
        edge = doc["edges"][0]
        assert (edge["ownership"], edge["bundle"], edge["bundleTitle"]) == (
            "bundle", "ops-core", "Ops Core",
        )
        # The helper's own control-plane leg: an alarm-class edge whose
        # endpoints resolve to no profile belongs to the platform.
        assert api.edge_owner({"alarmClass": True, "producer": "alertmanager"}, {}) == {
            "ownership": "control-plane"
        }

    def test_alert_ownership_names_the_bundle_with_a_membership_map(self, api):
        # #567: the three-way contract. A bundle namespace resolves to its
        # id and title; a foreign namespace outside every bundle is
        # explicitly 'unbundled', no longer conflated with 'bundle'.
        bundles = {
            "marketing-core": {
                "namespace": "hermes-marketing-core",
                "profiles": ["manager", "research"],
                "displayName": "Marketing Team",
            }
        }
        assert api.alert_ownership({"namespace": "hermes-marketing-core"}, bundles) == {
            "ownership": "bundle",
            "bundle": "marketing-core",
            "bundleTitle": "Marketing Team",
        }
        assert api.alert_ownership({"namespace": "hermes-solo-agent"}, bundles) == {
            "ownership": "unbundled"
        }
        assert api.alert_ownership({}, bundles) == {"ownership": "control-plane"}
        # No displayName authored: the machine name IS the title.
        untitled = {"core": {"namespace": "hermes-core", "profiles": ["a"]}}
        assert api.alert_ownership({"namespace": "hermes-core"}, untitled)["bundleTitle"] == "core"

    def test_no_grafana_means_no_alert_link_not_a_guessed_one(self, api, monkeypatch):
        monkeypatch.setattr(api, "_prom_base", lambda cfg: "http://prom")
        monkeypatch.setattr(api, "grafana_base_url", lambda: None)
        monkeypatch.setattr(
            api,
            "alerts_observation",
            lambda prom, *_: [{"state": "firing", "labels": {"alertname": "A"}, "annotations": {}}],
        )
        assert "grafanaUrl" not in api._firing_alerts({})["firing"][0]

    def test_the_direct_alert_plane_says_no_router_about_itself(self, api, monkeypatch):
        # #416's checklist line, verbatim: direct alert records indicate
        # eventRouterInvolved: false. The promstack pipeline produces no
        # edges - it IS the FiringAlerts record, in every configured state.
        monkeypatch.setattr(api, "_prom_base", lambda cfg: None)
        doc = api._firing_alerts({})
        assert doc["plane"] == "operational-alert"
        assert doc["eventRouterInvolved"] is False

    def test_fan_out_targets_keep_independent_identity(self, api, tmp_path):
        # One route fanning to two targets is TWO edges with two ids and
        # two statuses, never one aggregate - the fixture's route
        # kanban-alerts fans to an agent and a chatops space.
        doc = api.project_communication(str(self._repo(tmp_path)))
        routes = {e["route"] for e in doc["edges"]}
        assert routes == {"kanban-alerts"}
        assert len(doc["edges"]) == 2
        assert len({e["id"] for e in doc["edges"]}) == 2

    def test_cluster_material_never_serializes(self, api, tmp_path):
        text = json.dumps(api.project_communication(str(self._repo(tmp_path))))
        for needle in (
            "secretName",
            "hermes-marketing-sre-ca-west-env",
            "svc.cluster.local",
            '"url"',
            '"namespace"',
            '"service"',
            '"port"',
            '"path"',
            '"handler"',
            "signature",
            "8644",
        ):
            assert needle not in text, needle

    def test_route_is_flag_gated_and_missing_tree_is_503(self, api, tmp_path, monkeypatch):
        from fastapi import HTTPException

        repo = self._repo(tmp_path)
        monkeypatch.setattr(api, "FEATURES_PATH", tmp_path / "state" / "features.json")
        monkeypatch.setattr(
            api, "FEATURES", [{"id": "communication-view", "title": "c", "defaultOff": True}]
        )
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": str(repo)})
        with pytest.raises(HTTPException) as exc:
            api.get_nexus_communication()
        assert exc.value.status_code == 404
        class _Req:
            headers: dict = {}

        api.put_features(_Req(), {"version": 1, "enabled": {"communication-view": True}})
        assert api.get_nexus_communication()["routers"]
        # An empty clone (no emitted communication tree) is a 503, not a 500.
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": str(tmp_path / "empty")})
        with pytest.raises(HTTPException) as exc:
            api.get_nexus_communication()
        assert exc.value.status_code == 503

    def test_malformed_and_hostile_records_are_excluded_never_500(self, api, tmp_path):
        # A hand-edited repo parks URLs and cluster names in "logical"
        # fields and breaks shapes - everything is dropped or skipped.
        comm = tmp_path / "gitops" / "deployments" / "communication"
        (comm / "router-global").mkdir(parents=True)
        (comm / "plan.yaml").write_text(
            "durableProvider:\n"
            "  url: http://x.svc.cluster.local\n"
            "  secretName: foo\n"
            "chatopsSpaces:\n"
            "  - ok#space\n"
            "  - http://leak.svc.cluster.local\n"
            "  - {nested: dict}\n"
            "producers:\n"
            "  - good/app#alerts\n"
            "  - http://bad.svc.cluster.local:8644/hook\n"
            "  - 7\n",
            encoding="utf-8",
        )
        (comm / "router-global" / "values.yaml").write_text(
            "spec:\n"
            "  edges:\n"
            "    - delivery: leaked-string\n"
            "      kind: agent\n"
            "      agent: also-a-string\n"
            "      event: http://event.svc.cluster.local\n"
            "      id: ok-id\n"
            "      from: {producer: fine/app#alerts}\n"
            "    - not-a-mapping\n"
            "    - kind: mystery\n"
            "      id: dropped-entirely\n",
            encoding="utf-8",
        )
        doc = api.project_communication(str(tmp_path / "gitops"))
        text = json.dumps(doc)
        assert "svc.cluster.local" not in text
        assert "secretName" not in text
        assert doc["durableProvider"] is None
        assert doc["chatopsSpaces"] == ["ok#space"]
        assert doc["producers"] == ["good/app#alerts"]
        # The string-shaped delivery/agent blocks degrade to empty facts,
        # the URL-shaped event is dropped, the unknown kind is excluded.
        assert len(doc["edges"]) == 1
        assert doc["edges"][0]["event"] is None
        assert doc["edges"][0]["producer"] == "fine/app#alerts"


class TestCommunicationHistory:
    """#551: the routed-history endpoint. The spike's sources, pinned:
    receipt rows from the router ring (truthful window: since router
    start), the pulse from Prometheus counter range queries, alert
    firings from the ALERTS series - each degrading to an explicit state,
    everything allowlisted and bounded."""

    class _Req:
        headers: dict = {}

    def _enable(self, api, tmp_path, monkeypatch, cfg=None):
        monkeypatch.setattr(api, "FEATURES_PATH", tmp_path / "state" / "features.json")
        monkeypatch.setattr(
            api, "FEATURES", [{"id": "communication-view", "title": "c", "defaultOff": True}]
        )
        api.put_features(self._Req(), {"version": 1, "enabled": {"communication-view": True}})
        monkeypatch.setattr(api, "_load_config", lambda: cfg or {})

    @staticmethod
    def _fake_status(monkeypatch, doc):
        import urllib.request

        class _Resp:
            def read(self):
                return json.dumps(doc).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        monkeypatch.setattr(urllib.request, "urlopen", lambda url, timeout=None: _Resp())

    _HOSTILE_RECEIPT = {
        "edge": "p/app@global->0:agent:sre",
        "route": "alerts",
        "kind": "agent",
        "status": "delivered",
        "attempt": 1,
        "time": "2026-08-16T10:00:00Z",
        "correlationId": "corr-1",
        # Everything below stays on the router - never in the browser.
        "sessionKey": "SECRET-session-key",
        "providerMessageId": "msg-99887",
        "space": "company#general",
        "httpStatus": 502,
        "destination": "http://agent.svc.cluster.local:8080/hook",
    }

    def test_route_is_flag_gated_like_its_sibling(self, api, tmp_path, monkeypatch):
        from fastapi import HTTPException

        monkeypatch.setattr(api, "FEATURES_PATH", tmp_path / "state" / "features.json")
        monkeypatch.setattr(
            api, "FEATURES", [{"id": "communication-view", "title": "c", "defaultOff": True}]
        )
        monkeypatch.setattr(api, "_load_config", lambda: {})
        with pytest.raises(HTTPException) as exc:
            api.get_nexus_communication_history()
        assert exc.value.status_code == 404

    def test_an_unknown_window_is_a_400_not_a_guess(self, api, tmp_path, monkeypatch):
        from fastapi import HTTPException

        self._enable(api, tmp_path, monkeypatch)
        with pytest.raises(HTTPException) as exc:
            api.get_nexus_communication_history(window="30d")
        assert exc.value.status_code == 400

    def test_receipts_are_allowlisted_no_urls_keys_or_provider_ids(self, api, tmp_path, monkeypatch):
        self._enable(
            api, tmp_path, monkeypatch, {"integrations": {"router": {"baseUrl": "http://router"}}}
        )
        self._fake_status(monkeypatch, {"receipts": [self._HOSTILE_RECEIPT]})
        doc = api.get_nexus_communication_history()
        assert doc["receipts"]["state"] == "ok"
        [entry] = doc["receipts"]["entries"]
        assert entry["correlationId"] == "corr-1"  # the trace identity survives
        text = json.dumps(doc["receipts"])
        for needle in (
            "sessionKey",
            "SECRET-session-key",
            "providerMessageId",
            "msg-99887",
            "svc.cluster.local",
            "httpStatus",
            "http://",
        ):
            assert needle not in text, needle

    def test_receipts_are_capped_and_the_truthful_window_is_stated(self, api, tmp_path, monkeypatch):
        self._enable(
            api, tmp_path, monkeypatch, {"integrations": {"router": {"baseUrl": "http://router"}}}
        )
        many = [dict(self._HOSTILE_RECEIPT, attempt=i) for i in range(600)]
        self._fake_status(monkeypatch, {"receipts": many})
        doc = api.get_nexus_communication_history()
        assert len(doc["receipts"]["entries"]) == 200
        # Never imply the window: the ring is since router start, and the
        # record says so for the UI to label the list with.
        assert doc["receipts"]["truthfulWindow"] == "since router start"

    def test_an_unreachable_router_is_an_explicit_state(self, api, tmp_path, monkeypatch):
        import urllib.request

        self._enable(
            api, tmp_path, monkeypatch, {"integrations": {"router": {"baseUrl": "http://router"}}}
        )

        def refuse(url, timeout=None):
            raise OSError("refused")

        monkeypatch.setattr(urllib.request, "urlopen", refuse)
        doc = api.get_nexus_communication_history()
        assert doc["receipts"] == {
            "state": "unavailable",
            "truthfulWindow": "since router start",
            "entries": [],
        }
        assert doc["provenance"]["sources"]["receipts"]["state"] == "unavailable"

    def test_no_sources_configured_says_so_everywhere(self, api, tmp_path, monkeypatch):
        self._enable(api, tmp_path, monkeypatch)
        doc = api.get_nexus_communication_history()
        assert doc["receipts"]["state"] == "not configured"
        assert doc["pulse"] == {"state": "not configured", "buckets": []}
        assert doc["alertHistory"] == {"state": "not configured", "entries": []}

    def test_a_dead_prometheus_degrades_pulse_and_alert_history(self, api, tmp_path, monkeypatch):
        self._enable(
            api, tmp_path, monkeypatch, {"integrations": {"prometheus": {"baseUrl": "http://prom"}}}
        )

        def boom(base, expr, start, end, step):
            raise OSError("down")

        monkeypatch.setattr(api, "_prom_query_range", boom)
        doc = api.get_nexus_communication_history()
        assert doc["pulse"]["state"] == "unavailable"
        assert doc["alertHistory"]["state"] == "unavailable"

    def test_pulse_buckets_join_delivered_and_failed_per_timestamp(self, api, tmp_path, monkeypatch):
        self._enable(
            api, tmp_path, monkeypatch, {"integrations": {"prometheus": {"baseUrl": "http://prom"}}}
        )

        def fake_range(base, expr, start, end, step):
            t0, t1 = 1_755_300_000, 1_755_303_600
            if "deliveries_total" in expr:
                return [{"metric": {}, "values": [[t0, "3.2"], [t1, "0"]]}]
            if "failures_total" in expr:
                return [{"metric": {}, "values": [[t1, "1"]]}]
            return []  # the ALERTS query

        monkeypatch.setattr(api, "_prom_query_range", fake_range)
        doc = api.get_nexus_communication_history(window="1h")
        assert doc["window"] == "1h"
        assert [(b["delivered"], b["failed"]) for b in doc["pulse"]["buckets"]] == [(3, 0), (0, 1)]
        assert doc["pulse"]["buckets"][0]["at"].endswith("Z")

    def test_alert_history_projects_labels_clipped_and_bounded(self, api, tmp_path, monkeypatch):
        self._enable(
            api, tmp_path, monkeypatch, {"integrations": {"prometheus": {"baseUrl": "http://prom"}}}
        )

        def fake_range(base, expr, start, end, step):
            if expr.startswith("ALERTS"):
                return [
                    {
                        "metric": {
                            "alertname": "A" * 300,
                            "namespace": "ns",
                            "severity": "critical",
                            "pod": "leaks-nothing",
                        },
                        "values": [[1_755_300_000, "1"], [1_755_303_600, "1"]],
                    }
                ] * 80
            return []

        monkeypatch.setattr(api, "_prom_query_range", fake_range)
        doc = api.get_nexus_communication_history()
        entries = doc["alertHistory"]["entries"]
        assert len(entries) == 50  # bounded
        assert len(entries[0]["name"]) == 120  # clipped
        assert entries[0]["severity"] == "critical"
        assert entries[0]["firstActiveAt"] < entries[0]["lastActiveAt"]
        # Only the named labels project - nothing else rides along.
        assert "pod" not in json.dumps(entries)


class TestNotesOverlay:
    """validate_notes survives as the per-item rule set the workspace
    validator reuses; the standalone routes are gone."""

    def test_closed_shape_and_bounds(self, api):
        from fastapi import HTTPException

        good = {"id": "note-1", "x": 1, "y": 2, "text": "hello"}
        assert api.validate_notes({"version": 1, "notes": [good]})["notes"] == [good]
        bad = [
            {"version": 1, "notes": [{**good, "color": "red"}]},
            {"version": 1, "notes": [{**good, "text": "x" * 3000}]},
            {"version": 1, "notes": [{**good, "id": "UPPER!"}]},
            {"version": 1, "notes": [good, good]},
            {"version": 2, "notes": []},
        ]
        for doc in bad:
            with pytest.raises(HTTPException):
                api.validate_notes(doc)

    def test_incompatible_stored_file_reads_empty(self, api, tmp_path, monkeypatch):
        monkeypatch.setattr(api, "NOTES_DIR", tmp_path / "notes")
        (tmp_path / "notes").mkdir(parents=True)
        (tmp_path / "notes" / "default.json").write_text('{"version": 99}', encoding="utf-8")
        assert api.read_notes("default") == {"version": 1, "notes": []}

    def test_note_size_is_optional_bounded_and_round_trips(self, api):
        # #577: w/h persist the sticky's resized footprint; absence keeps
        # the classic 180x110 so pre-size documents round-trip unchanged.
        from fastapi import HTTPException

        base = {"id": "note-1", "x": 1, "y": 2, "text": "hello"}
        sized = {**base, "w": 320, "h": 240}
        assert api.validate_notes({"version": 1, "notes": [sized]})["notes"] == [sized]
        assert api.validate_notes({"version": 1, "notes": [base]})["notes"] == [base]
        for bad in ({**base, "w": 5}, {**base, "h": 100_000}, {**base, "w": True}, {**base, "w": "wide"}):
            with pytest.raises(HTTPException):
                api.validate_notes({"version": 1, "notes": [bad]})


class TestConnectionsOverlay:
    """validate_connections survives as the per-item rule set the
    workspace validator reuses; the standalone routes are gone."""

    def test_closed_shape_and_bounds(self, api):
        from fastapi import HTTPException

        good = {"id": "conn-1", "from": "calvin", "to": "sre", "label": "escalates to"}
        assert api.validate_connections({"version": 1, "connections": [good]})["connections"] == [good]
        bad = [
            {"version": 1, "connections": [{**good, "extra": 1}]},
            {"version": 1, "connections": [{**good, "from": "UPPER!"}]},
            {"version": 1, "connections": [{**good, "label": "x" * 300}]},
            {"version": 1, "connections": [good, good]},
            {"version": 2, "connections": []},
            {"version": 1, "connections": [], "secrets": {}},
        ]
        for doc in bad:
            with pytest.raises(HTTPException):
                api.validate_connections(doc)

    def test_shape_and_text_endpoints_are_valid_prefixed_keys(self, api):
        # #576: shapes and texts speak the same terminal grammar as cards,
        # so an endpoint may be a prefixed shape:/text: member key. Other
        # prefixes (note:, card:) stay refused - cards use bare instance
        # keys, and notes are not connectable.
        from fastapi import HTTPException

        base = {"id": "conn-1", "label": "relates to"}
        good = {**base, "from": "shape:rect-1", "to": "text:text-2"}
        assert api.validate_connections({"version": 1, "connections": [good]})["connections"] == [good]
        for bad_ep in ("note:note-1", "card:calvin", "shape:UPPER!", "shape:", "blob:x"):
            with pytest.raises(HTTPException):
                api.validate_connections({"version": 1, "connections": [{**base, "from": bad_ep, "to": "sre"}]})

    def test_arrows_field_round_trips_and_rejects_junk(self, api):
        # #547: optional arrows in {none, start, end, both}. A legacy
        # record without the field stays valid (the closed-shape test
        # above already proves that); junk values are refused.
        from fastapi import HTTPException

        base = {"id": "conn-1", "from": "calvin", "to": "sre", "label": "escalates to"}
        for arrows in ("none", "start", "end", "both"):
            good = {**base, "arrows": arrows}
            out = api.validate_connections({"version": 1, "connections": [good]})
            assert out["connections"] == [good]  # persisted verbatim
        for junk in ("forward", "", 1, None, ["end"]):
            with pytest.raises(HTTPException):
                api.validate_connections({"version": 1, "connections": [{**base, "arrows": junk}]})

    def test_incompatible_stored_file_reads_empty(self, api, tmp_path, monkeypatch):
        monkeypatch.setattr(api, "CONNECTIONS_DIR", tmp_path / "connections")
        (tmp_path / "connections").mkdir(parents=True)
        (tmp_path / "connections" / "default.json").write_text('{"version": 99}', encoding="utf-8")
        assert api.read_connections("default") == {"version": 1, "connections": []}


class TestWorkspace:
    """The NexusWorkspace document (#274, ADR-56): the closed allowlist,
    the revision CAS, the legacy projection, DELETE-is-reset, export
    byte-equivalence, and the owner gate."""

    def _iso(self, api, tmp_path, monkeypatch, *, config=None, plan=None):
        monkeypatch.setattr(api, "WORKSPACE_PATH", tmp_path / "workspace.json")
        monkeypatch.setattr(api, "STATE_DIR", tmp_path / "layouts")
        monkeypatch.setattr(api, "NOTES_DIR", tmp_path / "notes")
        monkeypatch.setattr(api, "CONNECTIONS_DIR", tmp_path / "connections")
        monkeypatch.setattr(api, "FEATURES_PATH", tmp_path / "features.json")
        monkeypatch.setattr(api, "_load_config", lambda: config or {})
        monkeypatch.setattr(api, "_plan_or_none", lambda: plan)

    def _sheet(self, **over):
        base = {
            "id": "fleet",
            "name": "Fleet Canvas",
            "mode": "operational",
            "cards": [{"ref": "manager", "position": {"x": 10, "y": 20}}],
            "shapes": [],
            "texts": [],
            "notes": [],
            "connections": [],
        }
        base.update(over)
        return base

    def _doc(self, **over):
        base = {
            "apiVersion": "nexus.hermes.ai/v1alpha1",
            "kind": "NexusWorkspace",
            "environment": "local",
            "revision": 0,
            "featureFlags": {},
            "sheets": [self._sheet()],
        }
        base.update(over)
        return base

    class _Req:
        def __init__(self, headers=None):
            self.headers = headers or {}

    # -- relationship adoption (#563) ---------------------------------

    _PLAN = {
        "relationships": [
            {"id": "r1", "from": "manager", "to": "research", "label": "coordinates"},
            {"id": "r2", "from": "manager", "to": "absent", "label": "dangles"},
        ],
        "view": {
            "id": "default",
            "title": "Fleet",
            "nodes": [
                {"ref": "manager", "position": {"x": 0, "y": 0}},
                {"ref": "research", "position": {"x": 100, "y": 0}},
            ],
        },
    }

    def test_default_workspace_materializes_plan_relationships(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        doc = api.default_workspace(self._PLAN)
        conns = doc["sheets"][0]["connections"]
        # Only the pair whose endpoints are cards; the dangling one skips.
        assert [(c["from"], c["to"], c["label"]) for c in conns] == [("manager", "research", "coordinates")]
        assert doc["adoptedRelationships"] is True
        # And the validator round-trips the marker.
        assert api.validate_workspace(doc)["adoptedRelationships"] is True

    def test_persisted_doc_adopts_once_and_deleted_lines_stay_deleted(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        # An old document, written before adoption existed: no marker.
        old = self._doc(sheets=[self._sheet(cards=[
            {"ref": "manager", "position": {"x": 0, "y": 0}},
            {"ref": "research", "position": {"x": 100, "y": 0}},
        ])])
        (tmp_path / "workspace.json").write_text(json.dumps(old))
        doc = api.read_workspace(self._PLAN)
        assert [(c["from"], c["to"]) for c in doc["sheets"][0]["connections"]] == [("manager", "research")]
        assert doc["adoptedRelationships"] is True
        # The operator deletes the adopted line and saves (marker rides
        # the save): a later read must NOT resurrect it.
        saved = dict(doc)
        saved["sheets"] = [dict(doc["sheets"][0], connections=[])]
        (tmp_path / "workspace.json").write_text(json.dumps(api.validate_workspace(saved)))
        again = api.read_workspace(self._PLAN)
        assert again["sheets"][0]["connections"] == []

    def test_adoption_never_duplicates_an_existing_pair(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        old = self._doc(sheets=[self._sheet(
            cards=[
                {"ref": "manager", "position": {"x": 0, "y": 0}},
                {"ref": "research", "position": {"x": 100, "y": 0}},
            ],
            connections=[{"id": "conn-1", "from": "manager", "to": "research", "label": "mine"}],
        )])
        (tmp_path / "workspace.json").write_text(json.dumps(old))
        doc = api.read_workspace(self._PLAN)
        assert [(c["id"], c["label"]) for c in doc["sheets"][0]["connections"]] == [("conn-1", "mine")]

    # -- validation ---------------------------------------------------

    def test_accepts_a_full_document(self, api):
        doc = self._doc(
            sheets=[
                self._sheet(
                    viewport={"x": 0, "y": 0, "zoom": 1},
                    settings={"sourceBadges": ["argocd", "grafana"]},
                    shapes=[{"id": "shape-1", "x": 1, "y": 2, "w": 100, "h": 80, "label": "West"}],
                    texts=[{"id": "text-1", "x": 3, "y": 4, "text": "Q3", "size": "lg"}],
                    notes=[{"id": "note-1", "x": 5, "y": 6, "text": "hello"}],
                    connections=[{"id": "conn-1", "from": "a", "to": "b", "label": "relates to"}],
                ),
                self._sheet(id="delivery", name="Delivery", mode="concept", cards=[]),
            ]
        )
        out = api.validate_workspace(doc)
        assert [s["id"] for s in out["sheets"]] == ["fleet", "delivery"]

    def test_connection_arrows_survive_a_workspace_round_trip(self, api):
        # #547: the arrowhead state persists through the workspace
        # validator (the save path) exactly as written - and a connection
        # endpoint that is a canvas-INSTANCE key (#546's `manager-2`) is
        # a plain DNS label like any other, so re-attachment persists too.
        conns = [
            {"id": "conn-1", "from": "manager", "to": "manager-2", "label": "hands off to", "arrows": "both"},
            {"id": "conn-2", "from": "manager-2", "to": "sre", "label": "relates to"},
        ]
        out = api.validate_workspace(self._doc(sheets=[self._sheet(connections=conns)]))
        assert out["sheets"][0]["connections"] == conns

    def test_authored_objects_accept_and_emit_only_when_present(self, api):
        # ADR-87: the sheet persists what the operator DREW. This is the
        # definition; cards[] still owns the placement, which is why an
        # object carries no x/y of its own.
        drawn = self._sheet(
            objects=[
                {"id": "person-1", "kind": "person", "title": "Calvin"},
                {"id": "external-tool-1", "kind": "external-tool", "title": "Stripe", "subtitle": "Payments API"},
            ]
        )
        out = api.validate_workspace(self._doc(sheets=[drawn]))
        assert [o["id"] for o in out["sheets"][0]["objects"]] == ["person-1", "external-tool-1"]
        assert out["sheets"][0]["objects"][1]["subtitle"] == "Payments API"
        # A document written before ADR-87 round-trips WITHOUT the key.
        plain = api.validate_workspace(self._doc())
        assert "objects" not in plain["sheets"][0]
        # Idempotent: validate(validate(x)) == validate(x).
        assert api.validate_workspace(out) == out

    @pytest.mark.parametrize(
        "obj, why",
        [
            ({"id": "x-1", "kind": "monitor", "title": "Old"}, "retired kind"),
            ({"id": "x-1", "kind": "note", "title": "N"}, "whiteboard primitive is not a domain kind"),
            ({"id": "x-1", "kind": "person"}, "title is required"),
            ({"id": "x-1", "kind": "person", "title": "   "}, "title must not be blank"),
            ({"id": "x-1", "kind": "person", "title": "A", "x": 1}, "objects carry no position"),
            ({"id": "bad id", "kind": "person", "title": "A"}, "id must be a DNS label"),
            ({"id": "x-1", "kind": "person", "title": "A" * 200}, "title is bounded"),
            ({"id": "x-1", "kind": "person", "title": "A", "subtitle": ""}, "a present subtitle must be real"),
        ],
    )
    def test_an_object_that_breaks_the_contract_is_refused(self, api, obj, why):
        # The frozen vocabulary is the gate: a retired kind cannot be
        # NEWLY persisted, which is what stops an orphan on an old sheet
        # from becoming legitimate again by being re-saved.
        with pytest.raises(Exception):
            api.validate_workspace(self._doc(sheets=[self._sheet(objects=[obj])]))

    def test_duplicate_object_ids_are_refused(self, api):
        dupe = self._sheet(
            objects=[
                {"id": "person-1", "kind": "person", "title": "A"},
                {"id": "person-1", "kind": "group", "title": "B"},
            ]
        )
        with pytest.raises(Exception):
            api.validate_workspace(self._doc(sheets=[dupe]))

    def test_object_url_accepts_and_emits_only_when_present(self, api):
        # #469, spec §23: the tool's live external surface. Additive-
        # optional like subtitle - a document written before this field
        # round-trips byte-identically without it.
        drawn = self._sheet(
            objects=[
                {"id": "external-tool-1", "kind": "external-tool", "title": "Stripe", "url": "https://dashboard.stripe.com"},
                {"id": "person-1", "kind": "person", "title": "Calvin"},
            ]
        )
        out = api.validate_workspace(self._doc(sheets=[drawn]))
        assert out["sheets"][0]["objects"][0]["url"] == "https://dashboard.stripe.com"
        assert "url" not in out["sheets"][0]["objects"][1]
        # A url-less document round-trips WITHOUT the key.
        plain = api.validate_workspace(self._doc())
        assert "objects" not in plain["sheets"][0]
        # Idempotent: validate(validate(x)) == validate(x).
        assert api.validate_workspace(out) == out

    @pytest.mark.parametrize(
        "bad_url",
        [
            "http://dashboard.stripe.com",  # http rejected - the same gate as toolUrls
            "https://user:pass@dashboard.stripe.com",  # credentialed rejected
            "https://dashboard.stripe.com/?x=1",  # query rejected
            "javascript:alert(1)",
            "",
        ],
    )
    def test_object_url_is_https_gated(self, api, bad_url):
        obj = {"id": "external-tool-1", "kind": "external-tool", "title": "Stripe", "url": bad_url}
        with pytest.raises(Exception):
            api.validate_workspace(self._doc(sheets=[self._sheet(objects=[obj])]))

    def test_canvas_groups_accept_and_emit_only_when_present(self, api):
        # ADR-72: presentation-only groups over prefixed member keys.
        grouped = self._sheet(
            groups=[{"id": "content", "name": "Content Production", "members": ["card:manager", "shape:shape-1"]}],
            shapes=[{"id": "shape-1", "x": 1, "y": 2, "w": 100, "h": 80, "label": ""}],
        )
        out = api.validate_workspace(self._doc(sheets=[grouped]))
        assert out["sheets"][0]["groups"][0]["members"] == ["card:manager", "shape:shape-1"]
        # A group-less sheet round-trips WITHOUT the key - pre-existing
        # documents stay byte-identical.
        plain = api.validate_workspace(self._doc())
        assert "groups" not in plain["sheets"][0]
        # Idempotent: validate(validate(x)) == validate(x).
        assert api.validate_workspace(out) == out

    def test_canvas_groups_rejection_table(self, api):
        import pytest as _pytest

        g = lambda **over: {**{"id": "g1", "name": "G", "members": ["card:manager"]}, **over}
        bad = [
            (self._doc(sheets=[self._sheet(groups=[g(extra=1)])]), "exactly"),
            (self._doc(sheets=[self._sheet(groups=[g(id="UPPER")])]), "invalid group id"),
            (self._doc(sheets=[self._sheet(groups=[g(name="")])]), "name"),
            (self._doc(sheets=[self._sheet(groups=[g(members=["manager"])])]), "prefixed member key"),
            (self._doc(sheets=[self._sheet(groups=[g(members=["group:other"])])]), "prefixed member key"),
            (self._doc(sheets=[self._sheet(groups=[g(), g(id="g2")])]), "two groups"),
            (self._doc(sheets=[self._sheet(groups=[g(), g()])]), "duplicate group id"),
        ]
        for doc, needle in bad:
            with _pytest.raises(api.HTTPException) as exc:
                api.validate_workspace(doc)
            assert needle.lower() in str(exc.value.detail).lower(), needle

    def test_rejection_table(self, api):
        import pytest as _pytest

        bad = [
            ({**self._doc(), "apiVersion": "v2"}, "apiVersion"),
            ({**self._doc(), "kind": "Workspace"}, "kind"),
            ({**self._doc(), "extra": 1}, "unknown workspace keys"),
            (self._doc(revision=-1), "revision"),
            (self._doc(revision=True), "revision"),
            (self._doc(environment="Not A Label"), "environment"),
            (self._doc(sheets=[]), "non-empty"),
            (self._doc(sheets=[self._sheet(), self._sheet()]), "duplicate sheet id"),
            (self._doc(sheets=[self._sheet(id="UPPER")]), "invalid sheet id"),
            (self._doc(sheets=[self._sheet(name="")]), "name"),
            (self._doc(sheets=[self._sheet(mode="fancy")]), "mode"),
            (self._doc(sheets=[self._sheet(bogus=1)]), "unknown sheet keys"),
            (self._doc(sheets=[self._sheet(settings={"sourceBadges": ["tracing"]})]), "sourceBadges"),
            (self._doc(sheets=[self._sheet(cards=[{"ref": "a", "position": {"x": 1, "y": 2}}, {"ref": "a", "position": {"x": 3, "y": 4}}])]), "duplicate card ref"),
            # #546: instance keys (id-or-ref) must be unique too.
            (self._doc(sheets=[self._sheet(cards=[{"id": "a-2", "ref": "a", "position": {"x": 1, "y": 2}}, {"id": "a-2", "ref": "a", "position": {"x": 3, "y": 4}}])]), "duplicate card ref"),
            (self._doc(sheets=[self._sheet(cards=[{"ref": "a-2", "position": {"x": 1, "y": 2}}, {"id": "a-2", "ref": "a", "position": {"x": 3, "y": 4}}])]), "duplicate card ref"),
            (self._doc(sheets=[self._sheet(cards=[{"id": "Not A Label", "ref": "a", "position": {"x": 1, "y": 2}}])]), "invalid card id"),
            (self._doc(sheets=[self._sheet(cards=[{"ref": "a", "position": {"x": True, "y": 2}}])]), "out of bounds"),
            (self._doc(sheets=[self._sheet(shapes=[{"id": "s", "x": 0, "y": 0, "w": 5, "h": 80, "label": ""}])]), "out of bounds"),
            (self._doc(sheets=[self._sheet(texts=[{"id": "t", "x": 0, "y": 0, "text": "x", "size": "xl"}])]), "size"),
            (self._doc(sheets=[self._sheet(notes=[{"id": "n", "x": 0, "y": 0, "text": "y" * 3000}])]), "text"),
        ]
        for doc, needle in bad:
            with _pytest.raises(api.HTTPException) as exc:
                api.validate_workspace(doc)
            assert needle.lower() in str(exc.value.detail).lower(), needle

    def test_card_instances_share_a_ref_but_never_a_key(self, api):
        # #546: two visual copies of ONE domain object. The second copy
        # carries its own canvas-instance id; save/reload round-trips
        # both instances and their independent geometry.
        cards = [
            {"ref": "manager", "position": {"x": 10, "y": 20}},
            {"id": "manager-2", "ref": "manager", "position": {"x": 400, "y": 20}},
        ]
        out = api.validate_workspace(self._doc(sheets=[self._sheet(cards=cards)]))
        assert out["sheets"][0]["cards"] == cards
        # An id-less document keeps its exact legacy shape - no id is
        # invented on the way through.
        plain = api.validate_workspace(self._doc())
        assert "id" not in plain["sheets"][0]["cards"][0]
        # Idempotent: validate(validate(x)) == validate(x).
        assert api.validate_workspace(out) == out

    def test_brace_shapes_accept_and_emit_only_when_present(self, api):
        # PR A7: `shape` is additive and optional (ADR-72 discipline) - a
        # brace is a WorkspaceShape with one extra field, not a new type.
        braced = self._sheet(
            shapes=[
                {"id": "shape-1", "x": 1, "y": 2, "w": 44, "h": 220, "label": "", "shape": "brace-l"},
                {"id": "shape-2", "x": 10, "y": 20, "w": 44, "h": 220, "label": "Scope", "shape": "brace-r"},
            ]
        )
        out = api.validate_workspace(self._doc(sheets=[braced]))
        assert out["sheets"][0]["shapes"][0]["shape"] == "brace-l"
        assert out["sheets"][0]["shapes"][1]["shape"] == "brace-r"
        # Idempotent: validate(validate(x)) == validate(x).
        assert api.validate_workspace(out) == out

    def test_a_shapeless_document_round_trips_byte_identical(self, api):
        # A document written before PR A7 carries no `shape` key at all -
        # validation must not invent one.
        plain = self._sheet(shapes=[{"id": "s", "x": 0, "y": 0, "w": 100, "h": 80, "label": ""}])
        out = api.validate_workspace(self._doc(sheets=[plain]))
        assert "shape" not in out["sheets"][0]["shapes"][0]
        assert out["sheets"][0]["shapes"] == plain["shapes"]

    def test_a_bogus_shape_variant_is_refused(self, api):
        import pytest as _pytest

        bogus = self._sheet(shapes=[{"id": "s", "x": 0, "y": 0, "w": 100, "h": 80, "label": "", "shape": "star"}])
        with _pytest.raises(api.HTTPException) as exc:
            api.validate_workspace(self._doc(sheets=[bogus]))
        assert "rect|ellipse|diamond|pill|arrow|brace-l|brace-r" in str(exc.value.detail)

    # -- #548: shapes library, container color, rotation, text fonts --

    def test_548_style_fields_survive_a_workspace_round_trip(self, api):
        # The formatted whiteboard: every #548 field persists through the
        # save path exactly as written - variant, color, rotation, font.
        drawn = self._sheet(
            shapes=[
                {"id": "shape-1", "x": 1, "y": 2, "w": 220, "h": 140, "label": "Ops", "shape": "ellipse", "color": "mint", "rotation": 45},
                {"id": "shape-2", "x": 9, "y": 9, "w": 220, "h": 80, "label": "", "shape": "arrow", "rotation": 359},
            ],
            texts=[{"id": "text-1", "x": 3, "y": 4, "text": "Q3", "size": "lg", "font": "mono"}],
        )
        out = api.validate_workspace(self._doc(sheets=[drawn]))
        assert out["sheets"][0]["shapes"] == drawn["shapes"]
        assert out["sheets"][0]["texts"] == drawn["texts"]
        # Idempotent: validate(validate(x)) == validate(x).
        assert api.validate_workspace(out) == out

    def test_548_a_legacy_document_round_trips_byte_identical(self, api):
        # A pre-#548 document carries none of the new keys; validation
        # must not invent any (absent = legacy default, ADR-72).
        plain = self._sheet(
            shapes=[{"id": "s", "x": 0, "y": 0, "w": 100, "h": 80, "label": ""}],
            texts=[{"id": "t", "x": 0, "y": 0, "text": "hi", "size": "md"}],
        )
        out = api.validate_workspace(self._doc(sheets=[plain]))
        assert out["sheets"][0]["shapes"] == plain["shapes"]
        assert out["sheets"][0]["texts"] == plain["texts"]
        for key in ("color", "rotation"):
            assert key not in out["sheets"][0]["shapes"][0]
        assert "font" not in out["sheets"][0]["texts"][0]

    def test_548_junk_style_values_are_refused(self, api):
        import pytest as _pytest

        base = {"id": "s", "x": 0, "y": 0, "w": 100, "h": 80, "label": ""}
        # Color outside the closed token set - including a raw hex value:
        # the record carries tokens, never colors.
        for junk in ("#ff0000", "red", "", 7):
            with _pytest.raises(api.HTTPException):
                api.validate_workspace(self._doc(sheets=[self._sheet(shapes=[{**base, "color": junk}])]))
        # Rotation: whole degrees 1..359 - 0 is spelled as absence, so a
        # written 0 is refused rather than persisting a second spelling
        # of "unrotated"; floats, bools and out-of-range are refused too.
        for junk in (0, 360, -15, 45.5, True, "45"):
            with _pytest.raises(api.HTTPException):
                api.validate_workspace(self._doc(sheets=[self._sheet(shapes=[{**base, "rotation": junk}])]))
        # Font outside the closed set - a webfont cannot enter by name.
        text = {"id": "t", "x": 0, "y": 0, "text": "hi", "size": "md"}
        for junk in ("comic-sans", "", 3, None):
            with _pytest.raises(api.HTTPException):
                api.validate_workspace(self._doc(sheets=[self._sheet(texts=[{**text, "font": junk}])]))

    # -- CAS ----------------------------------------------------------

    def test_cas_accepts_then_rejects_the_stale_tab(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        req = self._Req()
        first = api.put_workspace(req, self._doc(revision=0))
        assert first["revision"] == 1
        assert first["savedBy"] == "operator"
        # The same revision replayed - the stale tab - is a 409 carrying
        # the current document, never a silent overwrite.
        conflict = api.put_workspace(req, self._doc(revision=0))
        assert conflict.status_code == 409
        body = json.loads(conflict.body)
        assert body["error"] == "stale-revision"
        assert body["currentRevision"] == 1
        assert body["workspace"]["revision"] == 1
        # Carrying the fresh revision wins again.
        second = api.put_workspace(req, self._doc(revision=1))
        assert second["revision"] == 2

    def test_a_forged_revision_never_writes(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        out = api.put_workspace(self._Req(), self._doc(revision=9999))
        assert out.status_code == 409
        assert not (tmp_path / "workspace.json").exists()

    def test_server_owns_savedAt_savedBy_and_flags(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        api.put_workspace(
            self._Req(), self._doc(revision=0, savedBy="forged", featureFlags={"made-up": True})
        )
        stored = json.loads((tmp_path / "workspace.json").read_text())
        assert stored["savedBy"] == "operator"
        assert "made-up" not in stored["featureFlags"]

    def test_size_bound(self, api, tmp_path, monkeypatch):
        import pytest as _pytest

        self._iso(api, tmp_path, monkeypatch)
        huge = self._doc()
        huge["sheets"][0]["notes"] = [
            {"id": f"note-{i}", "x": 0, "y": 0, "text": "x" * 2000} for i in range(100)
        ]
        huge["sheets"] = huge["sheets"] * 1
        big = self._doc(sheets=[self._sheet(id=f"s{i}", notes=[{"id": f"n{j}", "x": 0, "y": 0, "text": "x" * 1900} for j in range(50)]) for i in range(7)])
        with _pytest.raises(api.HTTPException) as exc:
            api.put_workspace(self._Req(), big)
        assert exc.value.status_code == 413

    # -- projection / reset / export -----------------------------------

    # --- The launch sheet cap (#405, ADR-93) ------------------------------
    # The cap is a PRODUCT limit, unlike every other bound in this
    # validator, and the server is the enforcement: #405 is explicit that
    # persistence must refuse invalid over-limit state rather than trust
    # the client.

    def test_one_sheet_is_valid(self, api):
        out = api.validate_workspace(self._doc())
        assert len(out["sheets"]) == 1

    def test_exactly_the_cap_is_valid(self, api):
        sheets = [self._sheet(id=f"s{i}", name=f"Sheet {i}") for i in range(api._MAX_SHEETS)]
        out = api.validate_workspace(self._doc(sheets=sheets))
        assert len(out["sheets"]) == api._MAX_SHEETS

    def test_one_over_the_cap_is_refused(self, api):
        sheets = [self._sheet(id=f"s{i}", name=f"Sheet {i}") for i in range(api._MAX_SHEETS + 1)]
        with pytest.raises(Exception) as exc:
            api.validate_workspace(self._doc(sheets=sheets))
        msg = str(exc.value)
        # The refusal has to be actionable: how many are allowed, how many
        # this document has, and what happens to the excess.
        assert str(api._MAX_SHEETS) in msg
        assert str(api._MAX_SHEETS + 1) in msg
        assert "nothing is dropped for you" in msg

    def test_an_over_limit_document_is_never_silently_truncated(self, api):
        """#405: surface an explicit compatibility problem, never drop.

        A workspace written before the cap existed can legitimately hold
        more sheets. Truncating it here would destroy operator work
        without ever mentioning it - and the operator would find out by
        noticing something missing, which is the worst possible channel.
        """
        sheets = [self._sheet(id=f"s{i}", name=f"Sheet {i}") for i in range(20)]
        with pytest.raises(Exception):
            api.validate_workspace(self._doc(sheets=sheets))

    def test_an_empty_sheet_list_is_still_refused(self, api):
        # The floor did not move: a workspace always has at least one.
        with pytest.raises(Exception):
            api.validate_workspace(self._doc(sheets=[]))

    def test_the_default_workspace_fits_under_the_cap(self, api):
        # #405: "reset/default-workspace behavior respects the same
        # constraints" - a default that could not be saved would make
        # reset a trap.
        default = api.default_workspace(None)
        assert 1 <= len(default["sheets"]) <= api._MAX_SHEETS
        assert api.validate_workspace(default)

    def test_legacy_files_project_into_one_sheet(self, api, tmp_path, monkeypatch):
        plan = {"view": {"id": "default", "title": "Fleet", "nodes": [
            {"ref": "manager", "position": {"x": 1, "y": 2}},
            {"ref": "postiz", "position": {"x": 3, "y": 4}},
        ]}}
        self._iso(api, tmp_path, monkeypatch, plan=plan)
        (tmp_path / "layouts").mkdir()
        (tmp_path / "layouts" / "default.json").write_text(json.dumps(
            {"version": 1, "positions": {"manager": {"x": 99, "y": 98}}, "viewport": {"x": 0, "y": 0, "zoom": 2}}
        ))
        ws = api.read_workspace(plan)
        assert ws["revision"] == 0
        sheet = ws["sheets"][0]
        # The stored layout overlay wins over the authored position.
        positions = {c["ref"]: c["position"] for c in sheet["cards"]}
        assert positions["manager"] == {"x": 99, "y": 98}
        assert positions["postiz"] == {"x": 3, "y": 4}
        assert sheet["viewport"]["zoom"] == 2

    def test_after_first_save_the_legacy_files_are_ignored(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        api.put_workspace(self._Req(), self._doc(revision=0))
        (tmp_path / "layouts").mkdir(exist_ok=True)
        (tmp_path / "layouts" / "default.json").write_text(json.dumps(
            {"version": 1, "positions": {"manager": {"x": 1, "y": 1}}}
        ))
        ws = api.read_workspace(None)
        assert ws["revision"] == 1  # the document, not the projection

    def test_delete_is_reset_to_the_repository_default(self, api, tmp_path, monkeypatch):
        plan = {"view": {"id": "default", "nodes": [{"ref": "manager", "position": {"x": 1, "y": 2}}]}}
        # Reset is a deployment capability now (#403) - a config that does
        # not grant it refuses, which the class below covers.
        self._iso(api, tmp_path, monkeypatch, plan=plan,
                  config={"capabilities": {"workspaceReset": True}})
        api.put_workspace(self._Req(), self._doc(revision=0))
        out = api.delete_workspace(self._Req())
        assert out["reset"] is True
        assert out["workspace"]["revision"] == 0
        assert not (tmp_path / "workspace.json").exists()

    def test_export_is_byte_identical_to_the_stored_file(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        api.put_workspace(self._Req(), self._doc(revision=0))
        resp = api.export_workspace()
        assert resp.body == (tmp_path / "workspace.json").read_bytes()
        assert "attachment" in resp.headers["content-disposition"]

    def test_a_hand_mangled_file_reads_as_the_default_never_500(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        (tmp_path / "workspace.json").write_text("{ not json")
        ws = api.read_workspace(None)
        assert ws["revision"] == 0

    # -- owner gate -----------------------------------------------------

    def test_empty_owner_list_is_single_operator_mode(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch, config={"workspace": {"ownerEmails": []}})
        out = api.put_workspace(self._Req(), self._doc(revision=0))
        assert out["savedBy"] == "operator"

    def test_owner_gate_403s_the_wrong_subject_and_admits_the_right_one(self, api, tmp_path, monkeypatch):
        import pytest as _pytest

        cfg = {"workspace": {"ownerEmails": ["calvin@example.test"], "identityHeader": "X-Auth-Email"}}
        self._iso(api, tmp_path, monkeypatch, config=cfg)
        with _pytest.raises(api.HTTPException) as exc:
            api.put_workspace(self._Req({"X-Auth-Email": "intruder@example.test"}), self._doc(revision=0))
        assert exc.value.status_code == 403
        with _pytest.raises(api.HTTPException):
            api.put_workspace(self._Req(), self._doc(revision=0))  # no header at all
        out = api.put_workspace(self._Req({"X-Auth-Email": "calvin@example.test"}), self._doc(revision=0))
        assert out["savedBy"] == "calvin@example.test"
        # Reads stay open to authenticated viewers; only canWrite flips.
        view = api.get_workspace(self._Req({"X-Auth-Email": "viewer@example.test"}))
        assert view["canWrite"] is False
        assert view["ownerEnforced"] is True

    def test_no_tmp_litter_after_a_workspace_write(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        api.put_workspace(self._Req(), self._doc(revision=0))
        assert list(tmp_path.glob("*.tmp")) == []

    # -- the browser wire contract ------------------------------------
    # The rebuilt nexus-ui models cards flat ({ref, x, y}) and wires by
    # selection key; this validator persists {ref, position} and bare
    # card keys. nexus-ui/src/stores/wire.ts is the one boundary, and the
    # two fixtures below are SHARED with nexus-ui/tests/wire.test.ts: the
    # TS side proves fromWire/toWire round-trip the served fixture
    # byte-identically, this side proves the validator accepts both what
    # it serves and what the browser authors. The first live deployment
    # stacked every card at the origin and rejected every save because no
    # test sat on this boundary.

    _FIXTURES = Path(__file__).resolve().parents[2] / "nexus-ui" / "tests" / "fixtures"

    def test_the_served_wire_fixture_validates_idempotently(self, api):
        doc = json.loads((self._FIXTURES / "workspace-wire.json").read_text(encoding="utf-8"))
        # Nothing invented, nothing dropped: the fixture is exactly what a
        # saved workspace.json holds, wider server vocabulary included
        # (brace shapes, rotation, font, objects, groups, settings).
        assert api.validate_workspace(doc) == doc

    def test_a_document_authored_in_the_browser_is_accepted_verbatim(self, api, tmp_path, monkeypatch):
        self._iso(api, tmp_path, monkeypatch)
        doc = json.loads((self._FIXTURES / "workspace-wire.authored.json").read_text(encoding="utf-8"))
        clean = api.validate_workspace(doc)
        for key in ("cards", "shapes", "texts", "notes", "connections"):
            assert clean["sheets"][0][key] == doc["sheets"][0][key], key
        out = api.put_workspace(self._Req(), doc)
        assert out["revision"] == 1
        stored = json.loads((tmp_path / "workspace.json").read_text(encoding="utf-8"))
        # The second copy of a card carries its minted instance id - a
        # DNS label, which is why the browser mints with a hyphen.
        assert stored["sheets"][0]["cards"][1]["id"] == "mkt-manager-2"

    def test_frozen_kinds_and_the_sheet_cap_match_the_browser(self, api):
        # DOMAIN_KIND_IDS's own comment promises this drift test; it had
        # not existed since the old dashboard/ suite retired.
        ui = Path(__file__).resolve().parents[2] / "nexus-ui" / "src"
        kinds_ts = (ui / "app" / "workspace" / "kinds.ts").read_text(encoding="utf-8")
        block = kinds_ts.split("export const DOMAIN_KINDS", 1)[1].split("];", 1)[0]
        assert tuple(re.findall(r'\{ id: "([a-z-]+)"', block)) == api.DOMAIN_KIND_IDS
        document_ts = (ui / "stores" / "document.ts").read_text(encoding="utf-8")
        cap = re.search(r"MAX_SHEETS = (\d+)", document_ts)
        assert cap is not None and int(cap.group(1)) == api._MAX_SHEETS


class TestEdgeLiveStatus:
    """#277: per-edge live delivery status. The ladder must distinguish
    'never observed' from 'observed and fine' - calling an untouched route
    healthy is the same lie the overlay exists to prevent."""

    EDGES = [{"id": "e1"}, {"id": "e2"}]
    UP = [{"metric": {}, "value": [0, "1"]}]

    def test_an_edge_with_no_observations_is_declared_not_healthy(self, api):
        live = api.edge_live_status(self.EDGES, self.UP, {}, {}, {})
        assert live["e1"]["status"] == "declared"
        assert live["e1"]["lastSuccessAt"] is None

    def test_dead_letters_fail_the_edge_and_pending_degrades_it(self, api):
        live = api.edge_live_status(self.EDGES, self.UP, {"e1": 2}, {"e2": 3}, {})
        assert live["e1"]["status"] == "failed"
        assert live["e1"]["dlqDepth"] == 2
        assert live["e2"]["status"] == "degraded"
        assert live["e2"]["pending"] == 3

    def test_a_clean_observed_edge_is_configured(self, api):
        stamps = {"e1": {"success": 1_780_000_000.0}}
        live = api.edge_live_status(self.EDGES, self.UP, {"e1": 0}, {"e1": 0}, stamps)
        assert live["e1"]["status"] == "configured"
        assert live["e1"]["lastSuccessAt"] == "2026-05-28T20:26:40Z"

    def test_a_route_whose_last_act_was_a_failure_is_degraded(self, api):
        # Cumulative counters cannot express "the most recent attempt
        # failed"; the recency stamps can, and that is the difference
        # between a route that recovered and one that is still broken.
        stamps = {"e1": {"success": 100.0, "failure": 200.0}}
        live = api.edge_live_status(self.EDGES, self.UP, {}, {}, stamps)
        assert live["e1"]["status"] == "degraded"
        recovered = api.edge_live_status(
            self.EDGES, self.UP, {}, {}, {"e1": {"success": 200.0, "failure": 100.0}}
        )
        assert recovered["e1"]["status"] == "configured"

    def test_without_a_router_previously_seen_edges_go_stale_not_green(self, api):
        stamps = {"e1": {"success": 1_780_000_000.0}}
        live = api.edge_live_status(self.EDGES, [], {}, {}, stamps)
        assert live["e1"]["status"] == "stale"
        # An edge nothing was ever observed for stays `declared` - there is
        # no last-good to go stale.
        assert live["e2"]["status"] == "declared"

    # -- provenance source states (#414) ---------------------------------

    def test_no_prometheus_is_not_configured_not_an_empty_live_map(self, api, monkeypatch):
        # An empty live map used to be indistinguishable from "Prometheus
        # not configured" - exactly the ambiguity #414 names.
        monkeypatch.setattr(api, "_prom_base", lambda cfg: None)
        live, state = api._communication_live(self.EDGES, {})
        assert live == {}
        assert state == "not configured"

    def test_a_dead_prometheus_is_unavailable_and_edges_go_stale(self, api, monkeypatch):
        monkeypatch.setattr(api, "_prom_base", lambda cfg: "http://prom")

        def boom(base, query):
            raise OSError("down")

        monkeypatch.setattr(api, "_prom_query", boom)
        live, state = api._communication_live(
            [{"id": "e1"}], {}
        )
        assert state == "unavailable"
        # Degrades to stale/declared, never to silence or green.
        assert live["e1"]["status"] == "declared"

    def test_router_execution_distinguishes_its_three_absences(self, api, monkeypatch):
        # No router configured, router down, router up with no receipts -
        # three states one Optional used to flatten.
        assert api._router_execution({}) == (None, "not configured")

        import urllib.request

        def refuse(url, timeout=None):
            raise OSError("refused")

        monkeypatch.setattr(urllib.request, "urlopen", refuse)
        cfg = {"integrations": {"router": {"baseUrl": "http://router"}}}
        assert api._router_execution(cfg) == (None, "unavailable")

    def test_external_inputs_never_carry_a_path_or_a_secret(self, api):
        # The browser learns a binding exists and how it is verified; it
        # must not learn how to call it or what signs it.
        projected = api._project_external_input(
            {
                "id": "manager/brand-brief",
                "profile": "manager",
                "event": "brand.brief-updated/v1",
                "hookPath": "/v1/hooks/manager-brand-brief",
                "accepts": ["push"],
                "verification": {
                    "type": "github-hmac-sha256",
                    "secretRef": {"name": "hermes-event-router-secrets", "key": "brand-brief"},
                },
            }
        )
        assert projected["verification"] == "github-hmac-sha256"
        assert projected["accepts"] == ["push"]
        serialized = json.dumps(projected)
        for forbidden in ("hookPath", "/v1/hooks", "secretRef", "hermes-event-router-secrets"):
            assert forbidden not in serialized


class TestAgentAvailability:
    """#279: per-agent availability from kube-state-metrics. The fleet-wide
    probe half stays presence-only; the per-component half is real."""

    NOW = "2026-07-31T12:00:00Z"

    def _ready(self, ns, ratio, workload=None):
        # WORKLOAD-level, as kube-state-metrics reports it - see
        # _ready_ratios for why pod-level is a trap.
        return {
            "metric": {"namespace": ns, "statefulset": workload or ns},
            "value": [0, str(ratio)],
        }

    def test_readiness_becomes_a_per_component_level(self, api):
        plan = _ns_plan()
        ns = next(iter(next(iter(api._component_namespaces(plan).values()))))
        _, per = api.uptime_source(plan, [], self.NOW, [self._ready(ns, 0.9994)])
        cid = next(iter(api._component_namespaces(plan)))
        assert per[cid]["level"] == "healthy"
        assert "99.9% ready over 30d" in per[cid]["summary"]

    def test_the_thresholds_are_one_ladder(self, api):
        plan = _ns_plan()
        cid = next(iter(api._component_namespaces(plan)))
        ns = next(iter(api._component_namespaces(plan)[cid]))
        for ratio, expected in ((0.99, "healthy"), (0.96, "degraded"), (0.5, "unhealthy")):
            _, per = api.uptime_source(plan, [], self.NOW, [self._ready(ns, ratio)])
            assert per[cid]["level"] == expected, ratio

    def test_the_worst_instance_is_the_honest_answer(self, api):
        # One unready instance IS an availability problem; averaging it
        # away behind a healthy sibling would hide it.
        plan = _ns_plan()
        cid = next(iter(api._component_namespaces(plan)))
        ns = next(iter(api._component_namespaces(plan)[cid]))
        _, per = api.uptime_source(
            plan, [], self.NOW, [self._ready(ns, 0.9999), self._ready(ns, 0.4, "sidecar-app")]
        )
        assert per[cid]["level"] == "unhealthy"

    def test_a_workload_with_no_desired_replicas_makes_no_claim(self, api):
        # 0/0 arrives as NaN from Prometheus. It is not 0% availability -
        # it is no statement at all, and must not drag the level down.
        plan = _ns_plan()
        cid = next(iter(api._component_namespaces(plan)))
        ns = next(iter(api._component_namespaces(plan)[cid]))
        _, per = api.uptime_source(
            plan, [], self.NOW, [self._ready(ns, 0.999), self._ready(ns, float("nan"), "scaled-to-zero")]
        )
        assert per[cid]["level"] == "healthy"

    def test_a_component_with_no_series_is_not_configured_never_healthy(self, api):
        plan = _ns_plan()
        cid = next(iter(api._component_namespaces(plan)))
        _, per = api.uptime_source(plan, [], self.NOW, [self._ready("some-other-ns", 1.0)])
        assert per[cid]["status"] == "not configured"
        assert per[cid]["level"] == "unknown"


class TestProbeResults:
    """#293: real pass/fail from increase(gatus_results_total[w]). A series
    that carries no value (the old instant query, or a flat window) keeps
    the presence-only text - the level is earned by the range query, never
    assumed from presence."""

    NOW = "2026-07-31T12:00:00Z"

    def _probe(self, key, group, name, success, v):
        return {
            "metric": {"key": key, "group": group, "name": name, "success": success},
            "value": [0, str(v)],
        }

    def _pair(self, key, group, name, ok, fails):
        return [
            self._probe(key, group, name, "true", ok),
            self._probe(key, group, name, "false", fails),
        ]

    def test_all_probes_passing_is_healthy(self, api):
        series = self._pair("a_m", "manager", "api", 15, 0) + self._pair("a_r", "research", "chat", 15, 0)
        src, _ = api.uptime_source(_ns_plan(), series, self.NOW)
        assert src["level"] == "healthy"
        assert "2 of 2 probes passing (15m)" in src["summary"]

    def test_a_failing_plain_probe_is_unhealthy(self, api):
        series = self._pair("a_m", "manager", "api", 12, 3) + self._pair("a_r", "research", "chat", 15, 0)
        src, _ = api.uptime_source(_ns_plan(), series, self.NOW)
        assert src["level"] == "unhealthy"
        assert "1 of 2 probes passing (15m)" in src["summary"]
        assert any("api" in r["message"] for r in src.get("reasons", []))

    def test_only_the_degraded_twin_failing_is_degraded(self, api):
        # The generator emits a pair per target: "<name>" (down = red) and
        # "<name> — degraded" (slow = amber). Slowness alone never reads
        # as an outage.
        series = self._pair("a_m", "manager", "api", 15, 0) + self._pair(
            "a_m_d", "manager", "api — degraded", 12, 3
        )
        src, _ = api.uptime_source(_ns_plan(), series, self.NOW)
        assert src["level"] == "degraded"

    def test_valueless_series_keep_the_presence_only_text(self, api):
        series = [{"metric": {"key": "a_m"}}, {"metric": {"key": "a_r"}}]
        src, _ = api.uptime_source(_ns_plan(), series, self.NOW)
        assert src["level"] == "unknown"
        assert "2 probes reporting" in src["summary"]

    def test_a_flat_window_makes_no_claim(self, api):
        # increase() == 0 on both twins means the probe ran zero times in
        # the window - that is silence, not success.
        series = self._pair("a_m", "manager", "api", 0, 0)
        src, _ = api.uptime_source(_ns_plan(), series, self.NOW)
        assert src["level"] == "unknown"
        assert "1 probe reporting" in src["summary"]

    def test_probes_narrow_to_the_component_by_profile_group(self, api):
        plan = _ns_plan()
        plan["components"][0]["bind"] = {"profile": "marketing-manager"}
        series = self._pair("a_m", "marketing-manager", "api", 12, 3)
        _, per = api.uptime_source(plan, series, self.NOW)
        assert per["manager"]["level"] == "unhealthy"
        assert "0/1 probes passing (15m)" in per["manager"]["summary"]

    def test_probe_and_readiness_merge_worst_wins(self, api):
        plan = _ns_plan()
        plan["components"][0]["bind"] = {"profile": "marketing-manager"}
        ready = [{"metric": {"namespace": "hermes-manager", "statefulset": "m"}, "value": [0, "0.9994"]}]
        # readiness healthy + probe failing -> unhealthy, both halves named
        series = self._pair("a_m", "marketing-manager", "api", 12, 3)
        _, per = api.uptime_source(plan, series, self.NOW, ready)
        assert per["manager"]["level"] == "unhealthy"
        assert "99.9% ready over 30d" in per["manager"]["summary"]
        assert "0/1 probes passing" in per["manager"]["summary"]
        # probe passing + readiness degraded -> degraded
        ready[0]["value"] = [0, "0.96"]
        series = self._pair("a_m", "marketing-manager", "api", 15, 0)
        _, per = api.uptime_source(plan, series, self.NOW, ready)
        assert per["manager"]["level"] == "degraded"

    def test_an_unmapped_group_narrows_to_nothing(self, api):
        # control-plane probes are nobody's agent. Before the range query
        # the no-data fallback was the fleet row, which was always
        # unknown; now the fleet row can go red, and inheriting that
        # would paint every agent red for a failing argocd probe.
        plan = _ns_plan()
        plan["components"][0]["bind"] = {"profile": "marketing-manager"}
        series = self._pair("cp_argo", "control-plane", "argocd", 12, 3)
        src, per = api.uptime_source(plan, series, self.NOW)
        assert src["level"] == "unhealthy"
        assert per["manager"]["status"] == "not configured"
        assert per["manager"]["level"] == "unknown"

    def test_a_silent_group_beside_an_active_one_reads_unknown_not_healthy(self, api):
        # Codex review catch: group A active, group B's probes flat (its
        # Gatus stopped probing it). B must NOT vanish into "not
        # configured" while the fleet row carries A's level - and with
        # healthy readiness, B must NOT read healthy: silence is not
        # success.
        plan = _ns_plan()
        plan["components"][0]["bind"] = {"profile": "marketing-manager"}
        series = self._pair("a_r", "research", "chat", 15, 0) + self._pair(
            "a_m", "marketing-manager", "api", 0, 0
        )
        _, per = api.uptime_source(plan, series, self.NOW)
        assert per["manager"]["level"] == "unknown"
        assert "silent" in per["manager"]["summary"]
        ready = [{"metric": {"namespace": "hermes-manager", "statefulset": "m"}, "value": [0, "0.9994"]}]
        _, per = api.uptime_source(plan, series, self.NOW, ready)
        assert per["manager"]["level"] == "unknown"  # unknown outranks healthy
        assert "99.9% ready over 30d" in per["manager"]["summary"]

    def test_valueless_series_with_groups_stay_presence_only_per_component_too(self, api):
        # An instant query of the raw counter carries no measurement at
        # all - "silent" would claim more than we know. Only MEASURED
        # probes (a numeric increase, even 0) reach the group cells.
        plan = _ns_plan()
        plan["components"][0]["bind"] = {"profile": "marketing-manager"}
        series = [{"metric": {"key": "a_m", "group": "marketing-manager", "name": "api"}}]
        src, per = api.uptime_source(plan, series, self.NOW)
        assert "1 probe reporting" in src["summary"]
        assert per["manager"]["summary"] == src["summary"]

    def test_the_fleet_row_counts_silent_probes(self, api):
        series = self._pair("a_r", "research", "chat", 15, 0) + self._pair("a_m", "manager", "api", 0, 0)
        src, _ = api.uptime_source(_ns_plan(), series, self.NOW)
        assert src["level"] == "unknown"  # a silent probe keeps the fleet honest
        assert "1 of 2 probes passing (15m)" in src["summary"]
        assert "1 silent" in src["summary"]

    def test_a_presence_only_fleet_row_still_reaches_the_cells(self, api):
        # The old behavior: no per-component data, fleet row has no real
        # level either - the cell shows the fleet text, unchanged.
        series = [{"metric": {"key": "a_m"}}]
        _, per = api.uptime_source(_ns_plan(), series, self.NOW)
        assert "1 probe reporting" in per["manager"]["summary"]


class TestEvalPublishing:
    """#280 / ADR-58. The security properties here are the point: a
    credential that lets an external harness write into an operator's
    control plane must be mintable only by an owner, shown once, stored
    hashed, scoped, revocable and audited."""

    class _Req:
        def __init__(self, headers=None):
            self.headers = headers or {}

    OWNER = {"Cf-Access-Authenticated-User-Email": "owner@example.com"}

    @pytest.fixture(autouse=True)
    def _isolate(self, api, tmp_path, monkeypatch):
        monkeypatch.setattr(api, "EVAL_RESULTS_DIR", tmp_path / "evals" / "results")
        monkeypatch.setattr(api, "EVAL_TOKENS_PATH", tmp_path / "evals" / "tokens.json")
        monkeypatch.setattr(api, "EVAL_AUDIT_PATH", tmp_path / "evals" / "audit.jsonl")

    def _mint(self, api, scopes=("marketing-manager",), **extra):
        return api.create_eval_token(
            self._Req(self.OWNER), {"name": "demo", "scopes": list(scopes), **extra}
        )

    def _batch(self, component="marketing-manager", run_id="run-1", status="pass"):
        return {
            "apiVersion": api_module_version(),
            "records": [
                {
                    "runId": run_id,
                    "componentId": component,
                    "suite": "behaviour",
                    "scenario": "greets",
                    "status": status,
                    "harness": "hg eval",
                    "ranAt": "2026-08-01T07:00:00Z",
                }
            ],
        }

    def _publish(self, api, raw, batch):
        return api.publish_eval_results(self._Req({"authorization": f"Bearer {raw}"}), batch)

    def test_the_raw_token_is_returned_once_and_only_a_digest_is_stored(self, api):
        minted = self._mint(api)
        raw = minted["token"]
        assert raw.startswith("hgev_")
        # Never in the record, never in the listing, never in the file.
        assert "sha256" not in minted["record"]
        listed = api.list_eval_tokens(self._Req(self.OWNER))["tokens"]
        assert all(raw not in json.dumps(t) for t in listed)
        on_disk = api.EVAL_TOKENS_PATH.read_text(encoding="utf-8")
        assert raw not in on_disk
        assert "sha256" in on_disk
        audit = api.EVAL_AUDIT_PATH.read_text(encoding="utf-8")
        assert "create" in audit and raw not in audit

    def test_only_an_owner_may_mint(self, api, monkeypatch):
        monkeypatch.setattr(
            api, "_load_config", lambda: {"workspace": {"ownerEmails": ["owner@example.com"]}}
        )
        with pytest.raises(Exception) as exc:
            api.create_eval_token(
                self._Req({"Cf-Access-Authenticated-User-Email": "stranger@example.com"}),
                {"name": "x", "scopes": ["marketing-manager"]},
            )
        assert getattr(exc.value, "status_code", None) == 403

    def test_publishing_requires_a_token_and_rejects_a_forged_one(self, api):
        for header in ({}, {"authorization": "Bearer hgev_nope"}):
            with pytest.raises(Exception) as exc:
                api.publish_eval_results(self._Req(header), self._batch())
            assert getattr(exc.value, "status_code", None) == 401

    def test_a_retried_publish_is_a_no_op(self, api):
        raw = self._mint(api)["token"]
        first = self._publish(api, raw, self._batch())
        assert first == {"ok": True, "written": 1, "deduped": 0, "dropped": 0}
        again = self._publish(api, raw, self._batch())
        assert again["written"] == 0 and again["deduped"] == 1
        assert len(api.read_eval_results("marketing-manager")) == 1

    def test_a_token_cannot_publish_outside_its_scope(self, api):
        raw = self._mint(api, scopes=("marketing-manager",))["token"]
        with pytest.raises(Exception) as exc:
            self._publish(api, raw, self._batch(component="marketing-sre"))
        assert getattr(exc.value, "status_code", None) == 403
        assert "marketing-sre" in str(exc.value.detail)
        assert api.read_eval_results("marketing-sre") == []
        assert "out-of-scope" in api.EVAL_AUDIT_PATH.read_text(encoding="utf-8")

    def test_revocation_is_immediate(self, api):
        minted = self._mint(api)
        raw, token_id = minted["token"], minted["record"]["id"]
        assert self._publish(api, raw, self._batch())["ok"] is True
        api.revoke_eval_token(token_id, self._Req(self.OWNER))
        with pytest.raises(Exception) as exc:
            self._publish(api, raw, self._batch(run_id="run-2"))
        assert getattr(exc.value, "status_code", None) == 401
        assert "revoke" in api.EVAL_AUDIT_PATH.read_text(encoding="utf-8")

    def test_an_expired_token_stops_working(self, api):
        raw = self._mint(api, expiresAt="2020-01-01T00:00:00Z")["token"]
        with pytest.raises(Exception) as exc:
            self._publish(api, raw, self._batch())
        assert getattr(exc.value, "status_code", None) == 401

    def test_last_used_is_recorded_without_exposing_the_secret(self, api):
        minted = self._mint(api)
        self._publish(api, minted["token"], self._batch())
        listed = api.list_eval_tokens(self._Req(self.OWNER))["tokens"][0]
        assert listed["lastUsedAt"]
        assert "sha256" not in listed

    def test_an_artifact_path_is_refused(self, api):
        # The most important refusal: a publisher that can name a path can
        # ask the control plane to surface anything on the box.
        raw = self._mint(api)["token"]
        batch = self._batch()
        batch["records"][0]["artifacts"] = [{"label": "t", "url": "/etc/passwd"}]
        with pytest.raises(Exception) as exc:
            self._publish(api, raw, batch)
        assert "https" in str(exc.value.detail)

    def test_credential_shaped_metadata_is_refused(self, api):
        raw = self._mint(api)["token"]
        batch = self._batch()
        batch["records"][0]["metadata"] = {"token": "ghp_" + "a" * 36}
        with pytest.raises(Exception) as exc:
            self._publish(api, raw, batch)
        assert getattr(exc.value, "status_code", None) == 400

    def test_a_component_id_can_never_escape_the_results_directory(self, api):
        raw = self._mint(api, scopes=("*",))["token"]
        with pytest.raises(Exception) as exc:
            self._publish(api, raw, self._batch(component="../../etc/passwd"))
        assert getattr(exc.value, "status_code", None) == 400

    def test_history_is_bounded_and_says_what_it_dropped(self, api, monkeypatch):
        monkeypatch.setattr(api, "_MAX_EVAL_RECORDS", 3)
        raw = self._mint(api)["token"]
        for i in range(4):
            out = self._publish(api, raw, self._batch(run_id=f"run-{i}"))
        assert out["dropped"] == 1
        assert len(api.read_eval_results("marketing-manager")) == 3

    def test_readback_is_filterable_and_bounded(self, api):
        raw = self._mint(api)["token"]
        self._publish(api, raw, self._batch(run_id="a"))
        other = self._batch(run_id="b")
        other["records"][0]["suite"] = "other"
        self._publish(api, raw, other)
        assert api.get_eval_results("marketing-manager")["total"] == 2
        assert api.get_eval_results("marketing-manager", suite="other")["total"] == 1

    def test_the_allowlist_and_the_frozen_schema_cannot_drift(self, api):
        # Two validators, one contract. The CLI checks the schema with ajv
        # and the runtime image checks this allowlist by hand (no
        # jsonschema in the image), so nothing but this test stops them
        # from quietly disagreeing about what is legal.
        schema = json.loads(
            (
                Path(__file__).resolve().parents[2]
                / "agent-bundle-contracts" / "eval-result" / "v1alpha1" / "eval-result.schema.json"
            ).read_text(encoding="utf-8")
        )
        record = schema["$defs"]["record"]
        assert set(record["properties"]) == {
            "runId", "componentId", "instanceId", "suite", "scenario", "status",
            "score", "harness", "ranAt", "durationMs", "commitSha", "metadata", "artifacts",
        }
        assert tuple(record["properties"]["status"]["enum"]) == api._EVAL_STATUSES
        assert schema["properties"]["apiVersion"]["const"] == api.EVAL_API_VERSION
        assert schema["properties"]["records"]["maxItems"] == api._MAX_EVAL_BATCH
        assert record["properties"]["metadata"]["maxProperties"] == 16
        assert record["properties"]["artifacts"]["maxItems"] == 5


class TestEvalOverlay:
    """The five states #280 requires the surface to distinguish, and the
    never-green invariant that has held since M02."""

    NOW = "2026-08-01T12:00:00Z"

    def _rec(self, scenario, status, ran_at="2026-08-01T11:00:00Z", suite="behaviour"):
        return {"suite": suite, "scenario": scenario, "status": status, "ranAt": ran_at}

    def _src(self, api, records):
        plan = _ns_plan()
        cid = next(iter(api._component_namespaces(plan)))
        glob, per = api.eval_source(plan, self.NOW, 168.0, lambda c: records if c == cid else [])
        return glob, per[cid]

    def test_the_flag_gates_the_whole_surface(self, api, monkeypatch):
        # With the flag off the adapter says so rather than reporting
        # results the UI is not showing.
        monkeypatch.setattr(api, "read_features", lambda: {"eval-results": False})
        plan = _ns_plan()
        glob, per = api.eval_source(plan, self.NOW)
        assert glob["status"] == "not configured"
        assert "not enabled" in glob["summary"]

    def test_no_runs_is_not_configured_never_healthy(self, api):
        glob, per = self._src(api, [])
        assert (per["status"], per["level"]) == ("not configured", "unknown")
        assert (glob["status"], glob["level"]) == ("not configured", "unknown")
        assert "no eval runs published" in per["summary"]

    def test_all_passing_is_healthy(self, api):
        _, per = self._src(api, [self._rec("a", "pass"), self._rec("b", "pass")])
        assert (per["status"], per["level"]) == ("configured", "healthy")
        assert per["summary"] == "2 of 2 scenarios passing"

    def test_a_behavioural_failure_is_degraded_and_names_the_scenario(self, api):
        # Degraded, not unhealthy: a failing eval is a quality signal about
        # behaviour, not an outage. Paging on it would train operators to
        # ignore the colour.
        _, per = self._src(api, [self._rec("a", "fail"), self._rec("b", "pass")])
        assert per["level"] == "degraded"
        assert "behaviour/a: fail" in per["reasons"][0]["message"]

    def test_a_harness_error_stays_distinguishable_from_a_failure(self, api):
        # The evaluator breaking is NOT the agent failing its eval, and
        # flattening the two would blame the agent for broken tooling.
        _, per = self._src(api, [self._rec("a", "evaluator-error")])
        assert per["level"] == "degraded"
        assert "evaluator-error" in per["reasons"][0]["message"]

    def test_only_the_newest_run_per_scenario_is_the_verdict(self, api):
        # Records arrive newest-first; an old failure that has since been
        # fixed is history, not a current problem.
        _, per = self._src(
            api,
            [self._rec("a", "pass", "2026-08-01T11:00:00Z"), self._rec("a", "fail", "2026-07-01T11:00:00Z")],
        )
        assert per["level"] == "healthy"
        assert per["summary"] == "1 of 1 scenarios passing"

    def test_an_old_result_goes_stale_rather_than_staying_green(self, api):
        _, per = self._src(api, [self._rec("a", "pass", "2026-01-01T00:00:00Z")])
        assert (per["status"], per["level"]) == ("stale", "unknown")
        assert "older than 168h" in per["summary"]


class TestEvalMetrics:
    """The exposition the monitoring stack scrapes off the nexus pod."""

    def _records(self, component):
        return {
            "marketing-manager": [
                {"suite": "behaviour", "scenario": "greets", "status": "pass", "score": 1,
                 "ranAt": "2026-08-01T11:00:00Z"},
                {"suite": "behaviour", "scenario": "greets", "status": "fail",
                 "ranAt": "2026-07-30T11:00:00Z"},
                {"suite": "behaviour", "scenario": "refuses", "status": "fail",
                 "ranAt": "2026-08-01T10:00:00Z"},
            ]
        }.get(component, [])

    def test_exposition_carries_latest_status_score_and_freshness(self, api):
        text = api.eval_metrics_text(["marketing-manager"], self._records)
        assert 'hermes_eval_last_status{component="marketing-manager",suite="behaviour",scenario="greets",status="pass"} 1' in text
        assert 'hermes_eval_last_score{component="marketing-manager",suite="behaviour",scenario="greets"} 1.0' in text
        # Freshness is the newest run in the suite, as unix seconds.
        assert "hermes_eval_last_run_timestamp_seconds{component=\"marketing-manager\",suite=\"behaviour\"} 1785582000" in text

    def test_retained_history_is_a_gauge_not_a_lying_counter(self, api):
        # The store rotates, so a _total that can go DOWN would be a lie a
        # dashboard believes. `_stored` says exactly what it counts.
        text = api.eval_metrics_text(["marketing-manager"], self._records)
        assert "# TYPE hermes_eval_runs_stored gauge" in text
        assert 'hermes_eval_runs_stored{component="marketing-manager",suite="behaviour",status="fail"} 2' in text
        assert "_total" not in text

    def test_a_component_with_nothing_published_emits_no_series(self, api):
        text = api.eval_metrics_text(["nothing-here"], self._records)
        assert "nothing-here" not in text


class TestLatestExecution:
    """#278: one inbound event, many consumers, per-consumer outcomes."""

    def _r(self, corr, edge, status, at, **extra):
        return {"correlationId": corr, "edge": edge, "status": status, "time": at,
                "route": "brand-brief-fanout", "kind": "agent", "attempt": 1, **extra}

    def test_the_newest_correlation_is_the_execution(self, api):
        out = api.latest_execution([
            self._r("corr_old", "e1", "accepted", "2026-08-01T10:00:00Z"),
            self._r("corr_new", "e1", "accepted", "2026-08-01T11:00:00Z"),
            self._r("corr_new", "e2", "accepted", "2026-08-01T11:00:01Z"),
        ])
        assert out["correlationId"] == "corr_new"
        assert len(out["consumers"]) == 2
        assert out["observedAt"] == "2026-08-01T11:00:01Z"

    def test_a_partial_fan_out_reports_per_consumer_not_a_verdict(self, api):
        # The case the whole surface exists for: one consumer succeeded and
        # one did not. Flattening to a single status would claim success.
        out = api.latest_execution([
            self._r("c", "e-manager", "accepted", "2026-08-01T11:00:00Z"),
            self._r("c", "e-sre", "dead-lettered", "2026-08-01T11:00:05Z",
                    classification="retry-exhausted"),
        ])
        assert (out["delivered"], out["failed"]) == (1, 1)
        statuses = {c["edge"]: c["status"] for c in out["consumers"]}
        assert statuses == {"e-manager": "accepted", "e-sre": "dead-lettered"}
        assert out["consumers"][1]["classification"] == "retry-exhausted"

    def test_receipts_never_carry_internal_addressing(self, api):
        out = api.latest_execution([
            self._r("c", "e1", "accepted", "2026-08-01T11:00:00Z",
                    sessionKey="local/manager/brand-brief/x",
                    providerMessageId="gw_1",
                    url="http://hermes-marketing-core.hermes-marketing-core.svc.cluster.local:8644/webhooks/x")
        ])
        body = json.dumps(out)
        for forbidden in ("svc.cluster.local", "sessionKey", "providerMessageId", "8644"):
            assert forbidden not in body

    def test_no_receipts_is_no_execution(self, api):
        assert api.latest_execution([]) is None
        assert api.latest_execution([{"nonsense": True}]) is None


def api_module_version():
    return "hermes.dev/eval-result/v1alpha1"


# ---------------------------------------------------------------------------
# The Backups product surface (#282, ADR-52). The load-bearing property is
# that schedule health and artifact verification stay SEPARATE: a routine
# on schedule whose artifact nobody has read back must not render as a
# proven restore point, and a platform backup that was never replayed must
# not render as recoverable.


def _routine(name, namespace, **kw):
    """A NORMAL routine: sink volume plus a data PVC, which is the shape
    every hermes-profile routine has. Tests about the restore shape build
    their own CronJobs; these are about the schedule ladder."""
    volumes = kw.pop(
        "volumes",
        [
            {"name": "backups", "persistentVolumeClaim": {"claimName": f"{name}-backups"}},
            {"name": "data", "persistentVolumeClaim": {"claimName": f"data-{name}-0"}},
        ],
    )
    doc = {
        "metadata": {"name": name, "namespace": namespace, "annotations": kw.pop("annotations", {})},
        "spec": {
            "schedule": kw.pop("schedule", "0 3 * * *"),
            "suspend": kw.pop("suspend", False),
            "jobTemplate": {"spec": {"template": {"spec": {"volumes": volumes}}}},
        },
        "status": {},
    }
    for field in ("lastSuccessfulTime", "lastScheduleTime", "active"):
        if field in kw:
            doc["status"][field] = kw.pop(field)
    assert not kw, kw
    return doc


def _platform_record(**overrides):
    doc = {
        "apiVersion": "nexus.hermes.ai/v1alpha1",
        "kind": "PlatformBackupStatus",
        "observedAt": "2026-07-31T11:00:00Z",
        "backupId": "hg-2026-07-31T11-00-00z",
        "createdAt": "2026-07-31T10:58:00Z",
        "environment": "manager",
        "destinationClass": "local-directory",
        "verification": {"state": "available"},
        "components": [
            {
                "name": "volume/manager/agent-state",
                "kind": "volume-archive",
                "profile": "manager",
                "routine": "agent-state",
                "checksum": "9f3a1c7e2b45",
                "sizeKB": 412,
                "consistency": "fresh routine invocation, exported and checksummed",
            },
            {"name": "argocd", "kind": "declarative", "detail": "rebuilt by `hg up`"},
        ],
    }
    doc.update(overrides)
    return doc

def _cron_rows(view):
    """CronJob-routine rows only. #582 adds the platform record's own
    components (host archive, declaratives, ephemeral ledger rows) to
    `routines`; tests about CronJob behaviour filter them out."""
    return [r for r in view["routines"] if not r["id"].startswith(("platform/", "ephemeral/"))]



class TestBackupsView:
    NOW = "2026-07-31T12:00:00Z"

    def test_a_routine_on_schedule_is_still_unmeasured_without_a_platform_backup(self, api):
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
        )
        row = _cron_rows(view)[0]
        # Green schedule...
        assert (row["state"], row["level"]) == ("healthy", "healthy")
        # ...and NOTHING known about what is in the sink. This pair is the
        # whole point of the surface.
        assert row["artifact"] == {"state": "unmeasured"}
        # 2: this routine, plus the never-taken platform archive row.
        assert view["counts"]["unmeasured"] == 2

    def test_the_platform_backup_is_what_makes_an_artifact_available(self, api):
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            _platform_record(),
            self.NOW,
        )
        artifact = _cron_rows(view)[0]["artifact"]
        assert artifact["state"] == "available"
        assert artifact["checksum"] == "9f3a1c7e2b45"
        assert artifact["sizeKB"] == 412

    def test_only_a_verified_restore_makes_an_artifact_restorable(self, api):
        record = _platform_record(
            verification={"state": "restorable", "restoredAt": "2026-07-31T11:30:00Z", "durationSeconds": 219}
        )
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            record,
            self.NOW,
        )
        assert _cron_rows(view)[0]["artifact"]["state"] == "restorable"
        # #582: no platform block - the record's own components ARE rows.
        assert "platform" not in view
        prow = next(r for r in view["routines"] if r["id"] == "platform/argocd")
        assert (prow["state"], prow["level"]) == ("declarative", "healthy")

    def test_an_unrestored_platform_backup_reads_unknown_not_healthy(self, api):
        # #582: unproven-ness is per-artifact now. An exported-but-never-
        # replayed artifact reads `available`, and the rollup keeps the
        # dot off green with the ROW as the named member - `unknown` is
        # the overlay's word for unproven, and it is the honest one here.
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            _platform_record(),
            self.NOW,
        )
        assert _cron_rows(view)[0]["artifact"]["state"] == "available"
        rollup = api._backups_rollup(view)
        assert rollup["level"] == "unknown"
        assert "hermes-manager/agent-state" in rollup["members"]
        assert "never restore-proven" in rollup["summary"]

    def test_no_platform_backup_at_all_is_a_reportable_state(self, api):
        # #582: absence renders as one RED row in the control-plane
        # bucket, never a quiet omission and never a blanket summary.
        view = api.project_backups(_ns_plan(), [], None, self.NOW)
        assert "platform" not in view
        row = view["routines"][0]
        assert row["id"] == "platform/archive"
        assert (row["state"], row["level"]) == ("failed", "unhealthy")
        assert "hg platform backup create" in row["reason"]
        assert row["group"] == "control-plane"

    def test_a_stale_record_cannot_serve_its_last_success(self, api):
        record = _platform_record(
            observedAt="2026-07-01T11:00:00Z",
            verification={"state": "restorable", "restoredAt": "2026-07-01T11:30:00Z"},
        )
        view = api.project_backups(_ns_plan(), [], record, self.NOW)
        prow = next(r for r in view["routines"] if r["id"] == "platform/argocd")
        assert prow["level"] == "unknown"
        assert "is the backup timer running?" in prow["reason"]

    def test_the_schedule_ladder(self, api):
        cases = [
            (_routine("a", "hermes-manager", suspend=True), "disabled", "degraded"),
            (_routine("b", "hermes-manager"), "never", "degraded"),
            (_routine("c", "hermes-manager", lastScheduleTime="2026-07-31T09:00:00Z"), "failed", "unhealthy"),
            (_routine("d", "hermes-manager", lastSuccessfulTime="2026-07-01T09:00:00Z"), "late", "degraded"),
            (_routine("e", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z"), "healthy", "healthy"),
        ]
        for cronjob, state, level in cases:
            row = _cron_rows(api.project_backups(_ns_plan(), [cronjob], None, self.NOW))[0]
            assert (row["state"], row["level"]) == (state, level), cronjob["metadata"]["name"]

    def test_a_run_in_flight_is_not_late(self, api):
        row = api.project_backups(
            _ns_plan(),
            [_routine("a", "hermes-manager", lastSuccessfulTime="2026-07-01T09:00:00Z",
                      active=[{"name": "a-123"}])],
            None,
            self.NOW,
        )
        row = _cron_rows(row)[0]
        # 30 days past the window, but a Job is running right now. Amber
        # for the duration of every backup would train the dot to be noise.
        assert row["state"] == "running"

    def test_schedule_retention_destination_and_protected_paths_are_facts(self, api):
        cronjob = _routine(
            "agent-state",
            "hermes-manager",
            schedule="17 2 * * *",
            lastSuccessfulTime="2026-07-31T09:00:00Z",
            annotations={
                "hermes.dev/backup-protects": "profiles/, memory/",
                "hermes.dev/backup-retention": "14",
                "hermes.dev/backup-destination": "pvc",
            },
        )
        row = _cron_rows(api.project_backups(_ns_plan(), [cronjob], None, self.NOW))[0]
        assert row["schedule"] == "17 2 * * *"
        assert row["retention"] == 14
        assert row["destination"] == "pvc"
        assert row["protects"] == ["profiles/", "memory/"]
        assert row["component"] == "manager"

    def test_a_nonsense_retention_annotation_is_dropped_not_rendered(self, api):
        cronjob = _routine("a", "hermes-manager", annotations={"hermes.dev/backup-retention": "; rm -rf /"})
        row = _cron_rows(api.project_backups(_ns_plan(), [cronjob], None, self.NOW))[0]
        assert "retention" not in row

    def test_a_hand_edited_path_in_the_record_is_dropped_not_rendered(self, api):
        # A ConfigMap is editable by anyone with write on the namespace,
        # and `detail` is the one free-text field that survives into the
        # view. The writer never puts a path there; a value that looks
        # like one is evidence of a hand edit, not something to render.
        record = _platform_record()
        record["components"][1]["detail"] = "/home/operator/.hermes/plugins/hermes-gitops/state"
        view = api.project_backups(_ns_plan(), [], record, self.NOW)
        prow = next(r for r in view["routines"] if r["id"] == "platform/argocd")
        assert "reason" not in prow
        assert "/home/operator" not in json.dumps(view)

    def test_a_hand_edited_url_in_the_record_is_dropped_too(self, api):
        record = _platform_record()
        record["components"][0]["consistency"] = "copied from https://sink.example/backups"
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            record,
            self.NOW,
        )
        assert "consistency" not in _cron_rows(view)[0]["artifact"]
        assert "sink.example" not in json.dumps(view)

    def test_rows_sort_worst_first(self, api):
        view = api.project_backups(
            _ns_plan(),
            [
                _routine("ok", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z"),
                _routine("dead", "hermes-manager", lastScheduleTime="2026-07-31T09:00:00Z"),
                _routine("suspended", "hermes-manager", suspend=True),
            ],
            None,
            self.NOW,
        )
        assert [r["title"] for r in _cron_rows(view)] == ["dead", "suspended", "ok"]


def _job(name, namespace, owner, **kw):
    """A Job as the CronJob controller leaves it: ownerReferences back to
    the routine, pod counters and conditions in status."""
    status = {}
    for field in ("succeeded", "failed", "active", "startTime", "completionTime", "conditions"):
        if field in kw:
            status[field] = kw.pop(field)
    assert not kw, kw
    return {
        "metadata": {
            "name": name,
            "namespace": namespace,
            "ownerReferences": ([{"kind": "CronJob", "name": owner}] if owner else []),
        },
        "status": status,
    }


class TestBackupRuns:
    """The per-run strip (failed / succeeded / active). The join is
    ownerReferences - a Job carries no routine label - so the tests pin
    exactly that: right owner, right namespace, nothing else."""

    NOW = "2026-07-31T12:00:00Z"

    def _view(self, api, jobs, cronjobs=None, plan=None):
        return api.project_backups(
            plan or _ns_plan(),
            cronjobs
            if cronjobs is not None
            else [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
            jobs=jobs,
        )

    def test_runs_join_by_owner_and_namespace_only(self, api):
        jobs = [
            _job("agent-state-1", "hermes-manager", "agent-state",
                 succeeded=1, startTime="2026-07-31T03:00:00Z", completionTime="2026-07-31T03:01:00Z",
                 conditions=[{"type": "Complete", "status": "True"}]),
            _job("agent-state-2", "hermes-manager", "agent-state",
                 failed=1, startTime="2026-07-30T03:00:00Z",
                 conditions=[{"type": "Failed", "status": "True"}]),
            # Same owner NAME in another namespace: a different routine.
            _job("agent-state-x", "hermes-other", "agent-state", succeeded=1),
            # No CronJob owner: a hand-made Job, not a run of anything.
            _job("oneoff", "hermes-manager", None, succeeded=1),
        ]
        row = _cron_rows(self._view(api, jobs))[0]
        # Newest first, states from the Job verdicts.
        assert [(r["name"], r["state"]) for r in row["runs"]] == [
            ("agent-state-1", "succeeded"),
            ("agent-state-2", "failed"),
        ]
        assert row["runs"][0]["completedAt"] == "2026-07-31T03:01:00Z"
        assert row["runCounts"] == {"succeeded": 1, "failed": 1, "active": 0}

    def test_run_totals_land_in_the_counts(self, api):
        jobs = [
            _job("agent-state-1", "hermes-manager", "agent-state", succeeded=1),
            _job("agent-state-2", "hermes-manager", "agent-state", active=1),
        ]
        counts = self._view(api, jobs)["counts"]
        assert (counts["runsSucceeded"], counts["runsFailed"], counts["runsActive"]) == (1, 0, 1)

    def test_a_retried_then_completed_job_is_succeeded_not_failed(self, api):
        # backoffLimit retries leave failed pod counters behind on a Job
        # whose verdict is Complete - the run succeeded.
        jobs = [
            _job("agent-state-1", "hermes-manager", "agent-state",
                 succeeded=1, failed=2, conditions=[{"type": "Complete", "status": "True"}]),
        ]
        row = _cron_rows(self._view(api, jobs))[0]
        assert row["runs"][0]["state"] == "succeeded"
        assert row["runCounts"] == {"succeeded": 1, "failed": 0, "active": 0}

    def test_an_in_flight_job_is_active(self, api):
        jobs = [_job("agent-state-1", "hermes-manager", "agent-state", active=1)]
        assert _cron_rows(self._view(api, jobs))[0]["runs"][0]["state"] == "active"

    def test_no_jobs_is_an_empty_strip_not_a_crash(self, api):
        row = _cron_rows(self._view(api, []))[0]
        assert row["runs"] == []
        assert row["runCounts"] == {"succeeded": 0, "failed": 0, "active": 0}


class TestPlatformComponentRows:
    """#582: the platform record's own components project as explicit
    control-plane rows - the blanket 'Platform backup' block is retired."""

    NOW = "2026-07-31T12:00:00Z"

    def _record(self, **overrides):
        rec = _platform_record(**overrides)
        rec["components"].append({"name": "host/nexus-state", "kind": "host-archive",
                                  "checksum": "4c81de09aa62", "sizeKB": 88})
        rec["components"].append({"name": "argocd-application/manager", "kind": "declarative"})
        return rec

    def test_host_archive_projects_as_a_row_with_its_evidence(self, api):
        view = api.project_backups(_ns_plan(), [], self._record(), self.NOW)
        row = next(r for r in view["routines"] if r["id"] == "platform/host/nexus-state")
        assert row["title"] == "Nexus host state"
        assert (row["state"], row["group"]) == ("archived", "control-plane")
        # Exported but never replayed: unknown level, `available` artifact.
        assert row["level"] == "unknown"
        assert row["artifact"] == {"state": "available", "checksum": "4c81de09aa62", "sizeKB": 88}

    def test_a_verified_restore_turns_the_host_archive_healthy(self, api):
        rec = self._record(verification={"state": "restorable", "restoredAt": "2026-07-31T11:30:00Z"})
        view = api.project_backups(_ns_plan(), [], rec, self.NOW)
        row = next(r for r in view["routines"] if r["id"] == "platform/host/nexus-state")
        assert (row["level"], row["artifact"]["state"]) == ("healthy", "restorable")

    def test_a_record_without_a_host_archive_still_carries_verification(self, api):
        # An older CLI's record has no host-archive component. ADR-52's
        # verification state still needs a row to live on - otherwise an
        # archive nobody ever replayed reads green (caught LIVE on the
        # factory: the verdict said "All 2 backup routines healthy" while
        # nothing had ever been restore-proven).
        view = api.project_backups(_ns_plan(), [], _platform_record(), self.NOW)
        carrier = next(r for r in view["routines"] if r["id"] == "platform/archive")
        assert (carrier["state"], carrier["level"]) == ("archived", "unknown")
        assert carrier["artifact"]["state"] == "available"
        assert "not replayed" in carrier["reason"]
        # With a real host archive, no synthetic carrier appears.
        view2 = api.project_backups(_ns_plan(), [], self._record(), self.NOW)
        assert not any(r["id"] == "platform/archive" for r in view2["routines"])
        # And a verified restore turns the carrier healthy.
        view3 = api.project_backups(
            _ns_plan(), [],
            _platform_record(verification={"state": "restorable", "restoredAt": "2026-07-31T11:30:00Z"}),
            self.NOW,
        )
        carrier3 = next(r for r in view3["routines"] if r["id"] == "platform/archive")
        assert (carrier3["level"], carrier3["artifact"]["state"]) == ("healthy", "restorable")

    def test_per_application_declaratives_do_not_duplicate_profile_rows(self, api):
        view = api.project_backups(_ns_plan(), [], self._record(), self.NOW)
        assert not any("argocd-application" in r["id"] for r in view["routines"])

    def test_the_ephemeral_ledger_projects_with_rationale_and_attribution(self, api):
        membership = {
            "marketing": {
                "namespace": "",
                "namespaces": {"marketing-engagement": "hermes-marketing-engagement"},
                "profiles": ["marketing-engagement"],
                "displayName": "Marketing Team",
            }
        }
        rec = self._record()
        rec["unprotectedByDesign"] = [
            {"claim": "prometheus-db-0", "namespace": "hermes-monitoring",
             "reason": "metric history: continuity is not promised"},
            {"claim": "workspaces-marketing-engagement", "namespace": "hermes-marketing-engagement",
             "reason": "pinned git checkouts, reproduced by cloning"},
        ]
        view = api.project_backups(_ns_plan(), [], rec, self.NOW, membership=membership)
        prom = next(r for r in view["routines"] if r["id"] == "ephemeral/prometheus-db-0")
        # Deliberate, healthy, and the rationale rides along.
        assert (prom["state"], prom["level"], prom["group"]) == ("ephemeral", "healthy", "control-plane")
        assert "continuity" in prom["reason"]
        assert prom["artifact"] == {"state": "ephemeral"}
        # A bundle namespace's ephemeral volume belongs to the BUNDLE.
        ws = next(r for r in view["routines"] if r["id"] == "ephemeral/workspaces-marketing-engagement")
        assert "group" not in ws
        assert (ws["bundle"], ws["bundleTitle"]) == ("marketing", "Marketing Team")

    def test_a_routines_sink_folds_onto_its_own_row(self, api):
        # The ledger names every routine's sink PVC as unprotected-by-design
        # ("archiving the archive is circular"). Listing it as a second row
        # per routine doubled the fleet's count (factory: 12 routines, 33
        # rows); the claim stays named, on the routine that fills it.
        rec = self._record()
        rec["unprotectedByDesign"] = [
            {"claim": "agent-state-backups", "namespace": "hermes-manager",
             "reason": "a backup SINK - archiving the archive is circular"},
            {"claim": "workspaces-manager-0", "namespace": "hermes-manager",
             "reason": "pinned git checkouts, reproduced by cloning"},
            {"claim": "orphan-backups", "namespace": "hermes-manager",
             "reason": "a backup SINK - archiving the archive is circular"},
        ]
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            rec,
            self.NOW,
        )
        ids = [r["id"] for r in view["routines"]]
        assert "ephemeral/agent-state-backups" not in ids
        row = next(r for r in view["routines"] if r["id"] == "hermes-manager/agent-state")
        assert row["sink"] == "agent-state-backups"
        assert "circular" in row["sinkReason"]
        # Not a sink of any routine: still its own honest row.
        assert "ephemeral/workspaces-manager-0" in ids
        # A sink whose routine is gone stays visible - folding hides
        # nothing that has no other home.
        assert "ephemeral/orphan-backups" in ids
        assert view["counts"]["routines"] == len(view["routines"])


class TestBackupsGrouping:
    """Routine rows inherit the component's canvas group; the control
    plane's own routines - which resolve to no component at all - form
    the reserved `control-plane` group."""

    NOW = "2026-07-31T12:00:00Z"

    def _grouped_plan(self):
        plan = _ns_plan()
        plan["view"] = {"nodes": [{"ref": "manager", "parent": "marketing"}]}
        return plan

    def test_a_routine_inherits_its_components_group(self, api):
        view = api.project_backups(
            self._grouped_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
        )
        row = _cron_rows(view)[0]
        assert (row["group"], row["groupTitle"]) == ("marketing", "marketing")

    def test_control_plane_namespaces_form_the_reserved_group(self, api):
        view = api.project_backups(
            self._grouped_plan(),
            [_routine("nexus-state", "hermes-nexus", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
        )
        row = _cron_rows(view)[0]
        assert (row["group"], row["groupTitle"]) == ("control-plane", "Control plane")

    def test_a_componentless_agent_namespace_routine_stays_ungrouped(self, api):
        view = api.project_backups(
            self._grouped_plan(),
            [_routine("stray", "hermes-unknown", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
        )
        assert "group" not in _cron_rows(view)[0]

    def test_a_plan_without_view_nodes_groups_nothing(self, api):
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
        )
        assert "group" not in _cron_rows(view)[0]

    def test_every_control_plane_namespace_forms_the_reserved_group(self, api):
        # #567: the platform bucket uses THE control-plane definition, not
        # a private two-namespace tuple - a monitoring or argocd routine
        # with no owning component is the control plane's, and its absence
        # from the platform group was #566's "missing coverage".
        for ns in ("hermes-monitoring", "argocd", "hermes-gitops", "hermes-system"):
            view = api.project_backups(
                self._grouped_plan(),
                [_routine("r", ns, lastSuccessfulTime="2026-07-31T09:00:00Z")],
                None,
                self.NOW,
            )
            row = _cron_rows(view)[0]
            assert (row["group"], row["groupTitle"]) == ("control-plane", "Control plane"), ns

    def test_an_uncovered_bundle_app_attributes_to_its_bundle(self, api):
        # The bundle is the UNIT of protection (Calvin/ADR-122 amendment):
        # an agent-application with no routine (Postiz) belongs to its
        # distribution's shelf, never a standalone "not covered" section.
        membership = {
            "marketing": {
                "namespace": "",
                "namespaces": {"marketing-engagement": "hermes-marketing-engagement"},
                "profiles": ["marketing-engagement"],
                "displayName": "Marketing Team",
            }
        }
        plan = {
            "components": [
                {"id": "postiz", "kind": "application", "title": "Postiz",
                 "instances": [{"namespace": "hermes-marketing-engagement"}]},
            ],
            "view": {"nodes": []},
        }
        view = api.project_backups(plan, [], None, self.NOW, membership=membership)
        row = view["unprotected"][0]
        assert (row["bundle"], row["bundleTitle"]) == ("marketing", "Marketing Team")
        # Outside every bundle: no invented membership.
        view2 = api.project_backups(plan, [], None, self.NOW)
        assert "bundle" not in view2["unprotected"][0]

    def test_a_shared_namespace_titles_each_routine_by_its_own_component(self, api):
        # An agent and its agent-application share one namespace
        # (engagement + postiz on the factory). The agent's own backup
        # must never be titled by the app; the app's routine - whose
        # name embeds the app id - must claim the app.
        plan = {
            "components": [
                {"id": "marketing-engagement", "kind": "agent", "title": "Marketing Engagement",
                 "instances": [{"namespace": "hermes-marketing-engagement"}]},
                {"id": "postiz", "kind": "application", "title": "Postiz",
                 "instances": [{"namespace": "hermes-marketing-engagement"}]},
            ],
        }
        cronjobs = [
            _cronjob("hermes-marketing-engagement-backup", "hermes-marketing-engagement"),
            _cronjob("hermes-marketing-engagement-postiz-postiz-backup", "hermes-marketing-engagement"),
        ]
        doc = api.project_backups(plan, cronjobs, None, self.NOW)
        by_name = {r["title"]: r for r in doc["routines"]}
        assert by_name["hermes-marketing-engagement-backup"]["component"] == "marketing-engagement"
        assert by_name["hermes-marketing-engagement-postiz-postiz-backup"]["component"] == "postiz"

    def test_a_bundle_namespace_routine_carries_served_bundle_attribution(self, api):
        # #567: the row itself names its Bundle - the browser stops
        # re-deriving membership from the profile->namespace map.
        membership = {
            "marketing-core": {
                "namespace": "hermes-marketing-core",
                "profiles": ["manager", "research"],
                "displayName": "Marketing Team",
            }
        }
        view = api.project_backups(
            self._grouped_plan(),
            [_routine("core-backup", "hermes-marketing-core", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
            bundles={p: b["namespace"] for b in membership.values() for p in b["profiles"]},
            membership=membership,
        )
        row = _cron_rows(view)[0]
        assert (row["bundle"], row["bundleTitle"]) == ("marketing-core", "Marketing Team")
        # A row outside every bundle namespace carries no bundle keys.
        view2 = api.project_backups(
            self._grouped_plan(),
            [_routine("stray", "hermes-unknown", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
            membership=membership,
        )
        assert "bundle" not in _cron_rows(view2)[0]


class TestBackupsRollup:
    NOW = "2026-07-31T12:00:00Z"

    def test_never_restored_keeps_the_nav_dot_off_green(self, api):
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            _platform_record(),
            self.NOW,
        )
        rollup = api._backups_rollup(view)
        # Every routine is current, and the dot is still not green: no
        # restore has ever been proven (ADR-52).
        assert rollup["level"] == "unknown"
        # #582: the member is the ROW whose artifact is unproven, not a
        # synthetic "platform" token.
        assert "hermes-manager/agent-state" in rollup["members"]

    def test_a_verified_restore_and_current_routines_are_green(self, api):
        view = api.project_backups(
            _ns_plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            _platform_record(
                verification={"state": "restorable", "restoredAt": "2026-07-31T11:30:00Z"}
            ),
            self.NOW,
        )
        rollup = api._backups_rollup(view)
        assert rollup["level"] == "healthy"
        assert rollup["members"] == []

    def test_a_failing_routine_outranks_the_unproven_platform_backup(self, api):
        view = api.project_backups(
            _ns_plan(),
            [_routine("dead", "hermes-manager", lastScheduleTime="2026-07-31T09:00:00Z")],
            _platform_record(),
            self.NOW,
        )
        rollup = api._backups_rollup(view)
        assert rollup["level"] == "unhealthy"
        assert "hermes-manager/dead" in rollup["members"]

    def test_nothing_observed_is_unknown_not_empty_and_green(self, api):
        assert api._backups_rollup(None)["level"] == "unknown"

    def test_the_overlay_carries_the_rollup(self, api):
        # No routines, no platform backup ever, and an agent in the plan:
        # `unhealthy` (#582 - the never-taken platform archive is a RED
        # row now, and it outranks the unprotected agent's amber). An
        # empty fleet is not an unobserved one.
        view = api.project_backups(_ns_plan(), [], None, self.NOW)
        overlay = api.build_overlay(_ns_plan(), [], self.NOW, backups=view)
        assert overlay["rollups"]["nav:backups"]["level"] == "unhealthy"
        assert "manager" in overlay["rollups"]["nav:backups"]["members"]
        assert "platform/archive" in overlay["rollups"]["nav:backups"]["members"]

    def test_no_backups_document_at_all_is_still_unknown(self, api):
        overlay = api.build_overlay(_ns_plan(), [], self.NOW, backups=None)
        assert overlay["rollups"]["nav:backups"]["level"] == "unknown"


class TestRestoreShape:
    """A routine producing perfect archives that nothing can put back is
    not a backup. The shape is read from the same CronJob facts the CLI
    reads, and `unsupported` overrides a green schedule outright."""

    NOW = "2026-07-31T12:00:00Z"

    @staticmethod
    def _with_volumes(volumes, annotations=None):
        return {
            "metadata": {"name": "r", "namespace": "hermes-manager", "annotations": annotations or {}},
            "spec": {
                "schedule": "0 3 * * *",
                "jobTemplate": {"spec": {"template": {"spec": {"volumes": volumes}}}},
            },
            "status": {"lastSuccessfulTime": "2026-07-31T09:00:00Z"},
        }

    def test_a_data_pvc_is_the_volume_path(self, api):
        cj = self._with_volumes([
            {"name": "backups", "persistentVolumeClaim": {"claimName": "b"}},
            {"name": "data", "persistentVolumeClaim": {"claimName": "data-0"}},
        ])
        row = _cron_rows(api.project_backups(_ns_plan(), [cj], None, self.NOW))[0]
        assert row["restore"] == "volume"
        assert row["state"] == "healthy"

    def test_a_declared_hook_is_the_app_owned_path(self, api):
        cj = self._with_volumes(
            [{"name": "backups", "persistentVolumeClaim": {"claimName": "b"}}],
            {"hermes.dev/backup-restore-hook": '{"workload":"deployment/db","command":["x"]}'},
        )
        row = _cron_rows(api.project_backups(_ns_plan(), [cj], None, self.NOW))[0]
        assert row["restore"] == "hook"
        assert row["state"] == "healthy"

    def test_no_restore_path_fails_a_routine_that_is_otherwise_green(self, api):
        # Succeeded three hours ago, well inside the window, and still
        # unhealthy - because its artifacts cannot be replayed.
        cj = self._with_volumes([{"name": "backups", "persistentVolumeClaim": {"claimName": "b"}}])
        row = api.project_backups(_ns_plan(), [cj], None, self.NOW)["routines"][0]
        assert row["restore"] == "unsupported"
        assert (row["state"], row["level"]) == ("failed", "unhealthy")
        assert "no restore path" in row["reason"]

    def test_an_unrestorable_routine_reaches_the_nav_dot(self, api):
        cj = self._with_volumes([{"name": "backups", "persistentVolumeClaim": {"claimName": "b"}}])
        view = api.project_backups(_ns_plan(), [cj], None, self.NOW)
        assert api._backups_rollup(view)["level"] == "unhealthy"


class TestBackupsCollectionSafety:
    """An unreadable platform record must never render as `no platform
    backup has been taken`. Absence and unreadability look identical on
    this surface and mean opposite things - take a backup, versus the
    reader is broken - and confusing them is a false negative about
    whether the control plane is protected at all."""

    NOW = "2026-07-31T12:00:00Z"

    def _cfg(self):
        return {"integrations": {}, "backupStaleHours": 48}

    def test_a_403_on_the_record_leaves_no_view_rather_than_an_empty_one(self, api, monkeypatch):
        monkeypatch.setattr(
            api,
            "_k8s_get",
            lambda path, *a, **k: (
                {"items": []}
                if "cronjobs" in path
                else (_ for _ in ()).throw(PermissionError("forbidden"))
            ),
        )
        _, _, backups = api.collect_sources(_ns_plan(), self._cfg(), self.NOW)
        # No view at all - NOT a view claiming nothing has been backed up.
        assert backups is None
        assert api._backups_rollup(backups)["level"] == "unknown"

    def test_both_reads_succeeding_builds_the_view(self, api, monkeypatch):
        monkeypatch.setattr(api, "_k8s_get", lambda path, *a, **k: {"items": []})
        monkeypatch.setattr(api, "_k8s_get_optional", lambda *a, **k: None)
        _, _, backups = api.collect_sources(_ns_plan(), self._cfg(), self.NOW)
        assert backups is not None
        # #582: no platform block - absence renders as the one red row.
        assert backups["routines"][0]["id"] == "platform/archive"


class TestTimestampParsing:
    """Found live: the platform record shipped `toISOString()` output and
    every reader called it unreadable, so a record published seconds ago
    rendered as stale. The producer is fixed; this keeps the READER
    liberal, because the next producer to slip will not announce itself."""

    def test_second_precision_parses(self, api):
        assert api._parse_ts("2026-08-01T22:43:12Z") is not None

    def test_fractional_seconds_parse_too(self, api):
        assert api._parse_ts("2026-08-01T22:43:12.908Z") is not None
        assert api._parse_ts("2026-08-01T22:43:12.908123Z") is not None

    def test_a_fresh_record_with_milliseconds_is_not_stale(self, api):
        record = _platform_record(observedAt="2026-07-31T11:59:00.512Z")
        view = api.project_backups(_ns_plan(), [], record, "2026-07-31T12:00:00Z")
        prow = next(r for r in view["routines"] if r["id"] == "platform/argocd")
        # Fresh record: the declarative claim reads healthy, not stale.
        assert prow["level"] == "healthy"

    def test_genuine_nonsense_still_reads_as_unparseable(self, api):
        assert api._parse_ts("yesterday") is None
        assert api._parse_ts("2026-08-01 22:43:12") is None


class TestUnprotectedComponents:
    """A Backups page built only from discovered routines is a list of
    what IS protected, and reads as complete. Found live: two bundled
    agents had no routine anywhere - the bundle chart ships none - and
    every surface reported the fleet healthy, because a component with no
    routine simply never appeared."""

    NOW = "2026-07-31T12:00:00Z"

    @staticmethod
    def _plan():
        return {
            "components": [
                {"id": "manager", "kind": "agent", "title": "Manager",
                 "instances": [{"namespace": "hermes-manager"}]},
                {"id": "research", "kind": "agent", "title": "Research",
                 "instances": [{"namespace": "hermes-research"}]},
                {"id": "kanban", "kind": "application", "title": "Kanban",
                 "instances": [{"namespace": "hermes-manager"}]},
            ]
        }

    def test_an_agent_with_no_routine_anywhere_is_listed_and_degraded(self, api):
        view = api.project_backups(
            self._plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            None,
            self.NOW,
        )
        ids = {u["id"]: u for u in view["unprotected"]}
        # manager and kanban share a covered namespace; research does not.
        assert set(ids) == {"research"}
        assert ids["research"]["level"] == "degraded"
        assert "no backup routine covers" in ids["research"]["reason"]
        assert view["counts"]["unprotected"] == 1

    def test_an_application_is_listed_but_not_accused(self, api):
        plan = {
            "components": [
                {"id": "kanban", "kind": "application", "title": "Kanban",
                 "instances": [{"namespace": "hermes-kanban"}]},
            ]
        }
        u = api.project_backups(plan, [], None, self.NOW)["unprotected"][0]
        # An application may legitimately hold no state.
        assert u["level"] == "unknown"
        assert u["kind"] == "application"

    def test_an_uncovered_agent_reaches_the_nav_dot(self, api):
        # The load-bearing assertion. Every ROUTINE is healthy; the fleet
        # is not, because an agent has no routine at all.
        view = api.project_backups(
            self._plan(),
            [_routine("agent-state", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z")],
            _platform_record(
                verification={"state": "restorable", "restoredAt": "2026-07-31T11:30:00Z"}
            ),
            self.NOW,
        )
        assert all(r["level"] == "healthy" for r in view["routines"])
        rollup = api._backups_rollup(view)
        assert rollup["level"] == "degraded"
        assert "research" in rollup["members"]

    def test_a_fully_covered_fleet_lists_nothing(self, api):
        view = api.project_backups(
            self._plan(),
            [
                _routine("a", "hermes-manager", lastSuccessfulTime="2026-07-31T09:00:00Z"),
                _routine("b", "hermes-research", lastSuccessfulTime="2026-07-31T09:00:00Z"),
            ],
            None,
            self.NOW,
        )
        assert view["unprotected"] == []


class TestBundleNamespaces:
    """The third place today that addressing a bundled profile by its own
    name resolved to something that does not exist. A bundled agent
    covered by the bundle's routine must not read as unprotected - a
    false alarm on this surface is how an operator learns to ignore it."""

    NOW = "2026-07-31T12:00:00Z"

    @staticmethod
    def _repo(tmp_path, name="marketing-core", profiles=("manager", "research")):
        d = tmp_path / "deployments" / "bundles" / name
        d.mkdir(parents=True)
        (d / "values.yaml").write_text(
            "spec:\n  name: %s\n  profiles:\n%s"
            % (name, "".join(f"    - name: {p}\n      sha: abc\n" for p in profiles))
        )
        return str(tmp_path)

    def test_reads_members_out_of_the_emitted_bundle_values(self, api, tmp_path):
        repo = self._repo(tmp_path)
        assert api.bundle_namespaces(repo) == {
            "manager": "hermes-marketing-core",
            "research": "hermes-marketing-core",
        }

    def test_a_fleet_with_no_bundles_directory_is_empty_not_an_error(self, api, tmp_path):
        assert api.bundle_namespaces(str(tmp_path)) == {}
        assert api.bundle_namespaces(None) == {}

    def test_a_bundled_agent_covered_by_the_bundle_routine_is_not_unprotected(self, api, tmp_path):
        plan = {
            "components": [
                {"id": "manager", "kind": "agent", "title": "Manager",
                 "bind": {"profile": "manager"},
                 "instances": [{"namespace": "hermes-manager"}]},
            ]
        }
        routine = _routine("core-backup", "hermes-marketing-core",
                           lastSuccessfulTime="2026-07-31T09:00:00Z")
        bundles = api.bundle_namespaces(self._repo(tmp_path))
        # Without the placement the plan's declared namespace is all we
        # have, and it looks uncovered.
        assert api.project_backups(plan, [routine], None, self.NOW)["unprotected"] != []
        # With it, the bundle's own routine is found.
        view = api.project_backups(plan, [routine], None, self.NOW, bundles=bundles)
        assert view["unprotected"] == []

    def test_the_bundle_routine_row_carries_a_component(self, api, tmp_path):
        plan = {"components": [
            {"id": "manager", "kind": "agent", "title": "Manager",
             "bind": {"profile": "manager"}, "instances": [{"namespace": "hermes-manager"}]},
        ]}
        routine = _routine("core-backup", "hermes-marketing-core",
                           lastSuccessfulTime="2026-07-31T09:00:00Z")
        view = api.project_backups(
            plan, [routine], None, self.NOW, bundles=api.bundle_namespaces(self._repo(tmp_path))
        )
        # Attributed to a member, not left as a bare namespace.
        assert _cron_rows(view)[0]["component"] == "manager"

    def test_bundle_namespaces_is_unchanged_by_the_bundle_membership_refactor(self, api, tmp_path):
        # Regression guard (PR B1): bundle_namespaces became a projection
        # over bundle_membership. Backups behaviour must not move a byte.
        repo = self._repo(tmp_path)
        assert api.bundle_namespaces(repo) == {
            "manager": "hermes-marketing-core",
            "research": "hermes-marketing-core",
        }
        assert api.bundle_namespaces(None) == {}

    def test_bundle_namespaces_empty_dir_is_unchanged(self, api, tmp_path):
        assert api.bundle_namespaces(str(tmp_path)) == {}


class TestBundleMembership:
    """bundle_membership (PR B1): the serve-time overlay the /nexus
    envelope carries so the frontend can finally answer "is this profile
    bundled" (ADR-28) - today it reaches nothing past bundle_namespaces'
    flattened namespace-only view."""

    @staticmethod
    def _repo(tmp_path, name="marketing-core", profiles=("manager", "research"), dirname=None):
        d = tmp_path / "deployments" / "bundles" / (dirname or name)
        d.mkdir(parents=True)
        (d / "values.yaml").write_text(
            "spec:\n  name: %s\n  profiles:\n%s"
            % (name, "".join(f"    - name: {p}\n      sha: abc\n" for p in profiles))
        )
        return str(tmp_path)

    def test_reads_namespace_and_profiles_per_bundle(self, api, tmp_path):
        repo = self._repo(tmp_path)
        assert api.bundle_membership(repo) == {
            "marketing-core": {
                "namespace": "hermes-marketing-core",
                "profiles": ["manager", "research"],
            }
        }

    def test_name_falls_back_to_the_directory_when_spec_name_is_absent(self, api, tmp_path):
        d = tmp_path / "deployments" / "bundles" / "marketing-core"
        d.mkdir(parents=True)
        (d / "values.yaml").write_text("spec:\n  profiles:\n    - name: manager\n      sha: abc\n")
        out = api.bundle_membership(str(tmp_path))
        assert out == {"marketing-core": {"namespace": "hermes-marketing-core", "profiles": ["manager"]}}

    def test_a_malformed_values_file_is_skipped_not_fatal(self, api, tmp_path):
        good = tmp_path / "deployments" / "bundles" / "marketing-core"
        good.mkdir(parents=True)
        (good / "values.yaml").write_text("spec:\n  name: marketing-core\n  profiles:\n    - name: manager\n      sha: abc\n")
        bad = tmp_path / "deployments" / "bundles" / "broken-bundle"
        bad.mkdir(parents=True)
        (bad / "values.yaml").write_text("spec: [this is not, valid: yaml: -")
        out = api.bundle_membership(str(tmp_path))
        assert set(out) == {"marketing-core"}

    def test_a_syntactically_valid_but_wrongly_shaped_file_is_skipped_not_fatal(self, api, tmp_path):
        # GET /nexus calls this directly and unguarded (unlike the old
        # bundle_namespaces, only ever read behind backup_facts' own
        # try/except) - a file that parses fine as YAML but isn't the
        # expected shape (top-level list, spec not a mapping) must not
        # 500 the whole envelope.
        good = tmp_path / "deployments" / "bundles" / "marketing-core"
        good.mkdir(parents=True)
        (good / "values.yaml").write_text("spec:\n  name: marketing-core\n  profiles:\n    - name: manager\n      sha: abc\n")
        for dirname, text in (
            ("top-level-list", "- just\n- a\n- list\n"),
            ("spec-not-a-map", "spec: not-a-mapping\n"),
            ("profiles-not-a-list", "spec:\n  name: odd\n  profiles: not-a-list\n"),
        ):
            d = tmp_path / "deployments" / "bundles" / dirname
            d.mkdir(parents=True)
            (d / "values.yaml").write_text(text)
        out = api.bundle_membership(str(tmp_path))
        assert set(out) == {"marketing-core", "odd"}
        assert out["odd"]["profiles"] == []

    def test_a_fleet_with_no_bundles_directory_is_empty_not_an_error(self, api, tmp_path):
        assert api.bundle_membership(str(tmp_path)) == {}
        assert api.bundle_membership(None) == {}

    def test_bundles_path_being_a_file_not_a_directory_degrades_not_raises(self, api, tmp_path):
        # Codex review finding: the directory enumeration itself (root.is_dir(),
        # root.glob()) used to sit outside the try - only the per-file parse was
        # guarded. `deployments/bundles` existing as a plain file is the cheapest
        # way to prove the scan-level guard, no exception should ever escape.
        (tmp_path / "deployments").mkdir(parents=True)
        (tmp_path / "deployments" / "bundles").write_text("not a directory")
        assert api.bundle_membership(str(tmp_path)) == {}

    def test_deployment_yaml_facts_win_over_the_namespace_convention(self, api, tmp_path):
        # #567: the compiler's deployment.yaml records the authoritative
        # namespace (honouring placement.namespace), the stable id and the
        # presentation displayName. When readable, those facts replace the
        # `hermes-<name>` guess.
        repo = self._repo(tmp_path)
        d = tmp_path / "deployments" / "bundles" / "marketing-core"
        (d / "deployment.yaml").write_text(
            "spec:\n  id: marketing-core\n  bundle: marketing-core\n"
            "  displayName: Marketing Team\n  namespace: custom-marketing\n"
            "  profiles:\n    - manager\n    - research\n"
        )
        out = api.bundle_membership(repo)
        assert out == {
            "marketing-core": {
                "namespace": "custom-marketing",
                "profiles": ["manager", "research"],
                "id": "marketing-core",
                "displayName": "Marketing Team",
            }
        }
        # And the flattened profile->namespace projection follows it.
        assert api.bundle_namespaces(repo) == {
            "manager": "custom-marketing",
            "research": "custom-marketing",
        }

    def test_distribution_fallback_groups_profiles_by_source_repo(self, api, tmp_path):
        # #567/ADR-119: an environment that retired the runtime bundle
        # (per-profile topology cutover) still resolves ONE canonical
        # installed grouping - the distribution repo on every profile
        # record. Members keep their own namespaces, read from the agent
        # deployment records when present.
        for name in ("marketing-manager", "marketing-sre"):
            d = tmp_path / "profiles" / name
            d.mkdir(parents=True)
            (d / "profile.yaml").write_text(
                "spec:\n  persona: %s\n  source: github.com/example/social-media\n" % name
            )
        dep = tmp_path / "deployments" / "agents" / "marketing-sre"
        dep.mkdir(parents=True)
        (dep / "deployment.yaml").write_text("spec:\n  namespace: custom-sre\n")
        out = api.bundle_membership(str(tmp_path))
        assert out == {
            "social-media": {
                "namespace": "",
                "namespaces": {"marketing-manager": "hermes-marketing-manager", "marketing-sre": "custom-sre"},
                "profiles": ["marketing-manager", "marketing-sre"],
                "id": "social-media",
                "displayName": "Social Media",
            }
        }
        # The flattened projection follows the per-profile namespaces...
        assert api.bundle_namespaces(str(tmp_path)) == {
            "marketing-manager": "hermes-marketing-manager",
            "marketing-sre": "custom-sre",
        }
        # ...and ownership resolves a member namespace to the bundle.
        assert api.alert_ownership({"namespace": "custom-sre"}, out) == {
            "ownership": "bundle",
            "bundle": "social-media",
            "bundleTitle": "Social Media",
        }

    def test_declared_distribution_identity_wins_over_the_repo_stem(self, api, tmp_path):
        # ADR-123: the category comes from the distribution's OWN contract
        # - the `distribution` block the topology compiler stamps onto
        # every agent deployment record - never from the repo name.
        for name in ("marketing-manager", "marketing-sre"):
            d = tmp_path / "profiles" / name
            d.mkdir(parents=True)
            (d / "profile.yaml").write_text(
                "spec:\n  source: github.com/example/social-media\n"
            )
            dep = tmp_path / "deployments" / "agents" / name
            dep.mkdir(parents=True)
            (dep / "deployment.yaml").write_text(
                "spec:\n  namespace: hermes-%s\n  distribution:\n    name: marketing\n    displayName: Marketing Team\n" % name
            )
        out = api.bundle_membership(str(tmp_path))
        assert set(out) == {"marketing"}
        assert out["marketing"]["displayName"] == "Marketing Team"
        assert out["marketing"]["profiles"] == ["marketing-manager", "marketing-sre"]
        assert out["marketing"]["namespaces"]["marketing-sre"] == "hermes-marketing-sre"

    def test_a_compiled_bundle_suppresses_the_distribution_fallback(self, api, tmp_path):
        # The compiled tier is authoritative: when ANY deployments/bundles
        # record exists, source-repo grouping must not double-claim.
        repo = self._repo(tmp_path)
        d = tmp_path / "profiles" / "solo"
        d.mkdir(parents=True)
        (d / "profile.yaml").write_text("spec:\n  source: github.com/x/solo.hermes-gitops\n")
        assert set(api.bundle_membership(repo)) == {"marketing-core"}

    def test_a_malformed_deployment_yaml_degrades_to_the_convention(self, api, tmp_path):
        # Older trees have no deployment.yaml at all; a broken one must
        # degrade the same way - convention namespace, no enrichment keys.
        repo = self._repo(tmp_path)
        d = tmp_path / "deployments" / "bundles" / "marketing-core"
        (d / "deployment.yaml").write_text("spec: [not, a, mapping")
        out = api.bundle_membership(repo)
        assert out == {
            "marketing-core": {
                "namespace": "hermes-marketing-core",
                "profiles": ["manager", "research"],
            }
        }

    def test_an_unreadable_bundles_directory_degrades_to_empty_not_raises(self, api, tmp_path):
        if os.geteuid() == 0:
            pytest.skip("running as root ignores directory permission bits, so chmod 000 can't prove the degrade path")
        good = tmp_path / "deployments" / "bundles" / "marketing-core"
        good.mkdir(parents=True)
        (good / "values.yaml").write_text(
            "spec:\n  name: marketing-core\n  profiles:\n    - name: manager\n      sha: abc\n"
        )
        bundles_dir = tmp_path / "deployments" / "bundles"
        old_mode = bundles_dir.stat().st_mode
        bundles_dir.chmod(0)
        try:
            assert api.bundle_membership(str(tmp_path)) == {}
        finally:
            bundles_dir.chmod(old_mode)


class TestNexusEnvelopeBundles:
    """The /nexus envelope carries bundle membership beside capabilities
    (PR B1) - otherwise ADR-28 bundling reaches nothing the frontend
    consumes and the agent-bundle canvas kind renders an always-empty
    ghost."""

    class _Req:
        def __init__(self, headers=None):
            self.headers = headers or {}

    def _setup(self, api, tmp_path, monkeypatch):
        plan_file = tmp_path / "deployments" / "dashboard" / "nexus-plan.json"
        plan_file.parent.mkdir(parents=True, exist_ok=True)
        plan_file.write_text(json.dumps({"components": [], "relationships": []}), encoding="utf-8")
        (tmp_path / "deployments" / "bundles" / "marketing-core").mkdir(parents=True)
        (tmp_path / "deployments" / "bundles" / "marketing-core" / "values.yaml").write_text(
            "spec:\n  name: marketing-core\n  profiles:\n    - name: manager\n      sha: abc\n"
        )
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": str(tmp_path)})

    def test_the_envelope_carries_bundles_beside_capabilities(self, api, tmp_path, monkeypatch):
        self._setup(api, tmp_path, monkeypatch)
        out = api.get_nexus(self._Req())
        assert out["bundles"] == {
            "marketing-core": {"namespace": "hermes-marketing-core", "profiles": ["manager"]}
        }
        assert "capabilities" in out

    def test_no_bundles_directory_serves_an_empty_overlay_not_an_error(self, api, tmp_path, monkeypatch):
        plan_file = tmp_path / "deployments" / "dashboard" / "nexus-plan.json"
        plan_file.parent.mkdir(parents=True, exist_ok=True)
        plan_file.write_text(json.dumps({"components": [], "relationships": []}), encoding="utf-8")
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": str(tmp_path)})
        assert api.get_nexus(self._Req())["bundles"] == {}

    def test_an_unreadable_bundles_directory_still_serves_200_not_500(self, api, tmp_path, monkeypatch):
        # Codex review finding: bundle_membership must never raise out of
        # GET /nexus, even when `deployments/bundles` itself is transiently
        # unreadable mid-request.
        if os.geteuid() == 0:
            pytest.skip("running as root ignores directory permission bits, so chmod 000 can't prove the degrade path")
        plan_file = tmp_path / "deployments" / "dashboard" / "nexus-plan.json"
        plan_file.parent.mkdir(parents=True, exist_ok=True)
        plan_file.write_text(json.dumps({"components": [], "relationships": []}), encoding="utf-8")
        bundles_dir = tmp_path / "deployments" / "bundles" / "marketing-core"
        bundles_dir.mkdir(parents=True)
        (bundles_dir / "values.yaml").write_text(
            "spec:\n  name: marketing-core\n  profiles:\n    - name: manager\n      sha: abc\n"
        )
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": str(tmp_path)})
        parent = tmp_path / "deployments" / "bundles"
        old_mode = parent.stat().st_mode
        parent.chmod(0)
        try:
            out = api.get_nexus(self._Req())  # must not raise
        finally:
            parent.chmod(old_mode)
        assert out["bundles"] == {}


class TestAuthorization:
    """Two postures, and the difference is the whole point of #284.

    With an issuer configured, a role comes from a VERIFIED session. With
    none, it comes from an edge header trusted because the edge is the
    only ingress. A proof has to be able to tell which is live, and a
    forged header must stop working the moment the issuer exists."""

    class _Req:
        def __init__(self, headers=None, cookies=None):
            self.headers = headers or {}
            self.cookies = cookies or {}

    @pytest.fixture(autouse=True)
    def _isolate(self, api, tmp_path, monkeypatch):
        monkeypatch.setattr(api, "AUTH_DIR", tmp_path / "auth")

    OIDC = {
        "oidc": {
            "issuer": "http://issuer.invalid/dex",
            "clientId": "nexus",
            "roleClaim": "email",
            "roles": {
                "owner": ["owner@hermes.local"],
                "operator": ["operator@hermes.local"],
                "viewer": ["viewer@hermes.local"],
            },
        }
    }

    # -- role mapping -------------------------------------------------

    def test_an_unmapped_identity_is_none_not_viewer(self, api):
        # The load-bearing default. An identity the operator has not
        # placed in a role is DENIED, not quietly given the weakest
        # useful one - "unbound is denied" is unprovable otherwise.
        assert api.role_of_claims({"email": "unbound@hermes.local"}, self.OIDC["oidc"]) == "none"

    def test_each_mapped_identity_gets_its_role(self, api):
        for email, expected in (
            ("owner@hermes.local", "owner"),
            ("operator@hermes.local", "operator"),
            ("viewer@hermes.local", "viewer"),
        ):
            assert api.role_of_claims({"email": email}, self.OIDC["oidc"]) == expected

    def test_a_token_cannot_name_its_own_role(self, api):
        # An authorization bypass wearing an authentication hat: the
        # VALUES come from config, never from the token.
        claims = {"email": "nobody@hermes.local", "role": "owner", "groups": ["owner"]}
        assert api.role_of_claims(claims, self.OIDC["oidc"]) == "none"

    def test_the_highest_matching_role_wins(self, api):
        cfg = {"roleClaim": "groups", "roles": {"viewer": ["all"], "owner": ["admins"]}}
        assert api.role_of_claims({"groups": ["all", "admins"]}, cfg) == "owner"

    def test_a_missing_claim_is_none(self, api):
        assert api.role_of_claims({}, self.OIDC["oidc"]) == "none"

    # -- the posture switch -------------------------------------------

    def test_with_no_issuer_the_edge_header_still_decides(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: {"workspace": {"ownerEmails": ["o@x"]}})
        assert api.oidc_enabled() is False
        assert api.caller_role(self._Req({"Cf-Access-Authenticated-User-Email": "o@x"}))[0] == "owner"

    def test_a_FORGED_header_stops_working_the_moment_an_issuer_exists(self, api, monkeypatch):
        # The single most important assertion in this file. Turning OIDC
        # on must not leave the old trusted-header path as a bypass
        # sitting quietly beside the new one.
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        req = self._Req({"Cf-Access-Authenticated-User-Email": "owner@hermes.local"})
        assert api.caller_role(req) == ("none", "anonymous")
        with pytest.raises(Exception) as exc:
            api.require_role(req, "owner")
        assert getattr(exc.value, "status_code", None) == 403

    def test_whoami_reports_which_posture_is_live(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: {"workspace": {}})
        assert api.nexus_auth_whoami(self._Req())["mode"] == "header"
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        out = api.nexus_auth_whoami(self._Req())
        assert out["mode"] == "oidc"
        assert (out["role"], out["canWrite"]) == ("none", False)

    # -- sessions ------------------------------------------------------

    def test_a_signed_session_round_trips(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        cookie = api._sign({"sub": "owner@hermes.local", "role": "owner", "exp": time.time() + 60})
        req = self._Req(cookies={"hg_nexus_session": cookie})
        assert api.caller_role(req) == ("owner", "owner@hermes.local")
        assert api.require_role(req, "owner") == "owner@hermes.local"

    def test_a_tampered_session_is_no_session(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        cookie = api._sign({"sub": "viewer@hermes.local", "role": "viewer", "exp": time.time() + 60})
        body, sig = cookie.split(".", 1)
        # Re-encode the payload claiming owner, keep the old signature.
        forged = api.base64.urlsafe_b64encode(
            api.json.dumps({"sub": "viewer@hermes.local", "role": "owner", "exp": time.time() + 60}).encode()
        ).decode().rstrip("=")
        assert api.read_session(self._Req(cookies={"hg_nexus_session": f"{forged}.{sig}"})) is None

    def test_an_expired_session_is_no_session(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        cookie = api._sign({"sub": "o", "role": "owner", "exp": time.time() - 1})
        assert api.read_session(self._Req(cookies={"hg_nexus_session": cookie})) is None

    def test_garbage_is_no_session(self, api):
        for raw in ("", "nonsense", "a.b", "...."):
            assert api.read_session(self._Req(cookies={"hg_nexus_session": raw})) is None

    # -- audit ---------------------------------------------------------

    def test_a_denial_is_audited_with_who_and_what(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        with pytest.raises(Exception):
            api.require_role(self._Req(), "owner")
        line = (api.AUTH_DIR / "audit.jsonl").read_text()
        assert '"event": "deny"' in line and '"required": "owner"' in line

    def test_the_audit_never_carries_session_material(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        cookie = api._sign({"sub": "owner@hermes.local", "role": "owner", "exp": time.time() + 60})
        api.auth_audit("login", subject="owner@hermes.local", role="owner")
        body = (api.AUTH_DIR / "audit.jsonl").read_text()
        assert cookie not in body and "hg_nexus_session" not in body

    def test_an_unwritable_audit_never_breaks_a_decision(self, api, monkeypatch):
        # Recording a denial must not be able to turn a clean 403 into a
        # 500 - the decision is the product, the line is bookkeeping.
        monkeypatch.setattr(api, "AUTH_DIR", api.Path("/proc/nonexistent/auth"))
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        with pytest.raises(Exception) as exc:
            api.require_role(self._Req(), "owner")
        assert getattr(exc.value, "status_code", None) == 403


class TestPanelCatalog:
    """The allowlist that replaces the withdrawn embed (ADR-44, #281).

    The failure that motivated all of this was NOT a broken frame. The
    panel rendered perfectly and meant something else - a cost dashboard
    under a tab named Uptime. So the tests that matter here are the ones
    that stop a surface pointing at whatever is nearest."""

    def test_the_shipped_catalog_loads_and_is_closed(self, api):
        panels = api.load_panel_catalog()
        assert len(panels) > 0
        surfaces = {"system", "communication", "backup", "agent", "application", "uptime", "eval"}
        for p in panels:
            assert p["surface"] in surfaces
            assert p["size"] in ("compact", "standard", "wide", "tall")
            assert p.get("range") in (None, "1h", "6h", "24h", "7d", "30d")

    def test_every_catalogued_panel_exists_in_a_provisioned_dashboard(self, api):
        # THE test. Every uid/panelId pair is checked against the actual
        # dashboard JSON the charts ship - one comparison that would have
        # caught the withdrawn embed before any code was written.
        import json as _json
        import re
        from pathlib import Path

        root = Path(api.__file__).resolve().parents[2]
        provisioned: dict = {}
        for chart in ("control-plane/observability/chart", "control-plane/monitoring/chart"):
            for tpl in (root / chart / "templates").glob("configmap-*dashboard*.yaml"):
                text = tpl.read_text()
                uids = re.findall(r'"uid": "(hg-[a-z-]+)"', text)
                ids = {int(i) for i in re.findall(r'"id":\s*(\d+),', text)}
                for uid in uids:
                    provisioned.setdefault(uid, set()).update(ids)
                # Per-agent dashboards template their uid; index them under
                # the token the catalog uses so both halves are covered.
                if not uids:
                    provisioned.setdefault("{instance}", set()).update(ids)

        for p in api.load_panel_catalog():
            available = provisioned.get(p["dashboard"])
            assert available, f"{p['id']}: no provisioned dashboard {p['dashboard']}"
            assert p["panelId"] in available, (
                f"{p['id']} points at panel {p['panelId']} of {p['dashboard']}, "
                f"which does not exist (present: {sorted(available)})"
            )

    def test_no_catalogued_panel_claims_uptime(self, api):
        # Gatus feeds neither Prometheus nor Grafana, so an uptime panel
        # would render an empty chart under a tab promising history -
        # exactly the shape of the mistake this contract replaces. The
        # uptime surface reports `not configured` instead.
        assert [p for p in api.load_panel_catalog() if p["surface"] == "uptime"] == []
        out = api.project_panels("uptime", "https://grafana.example")
        assert out["status"] == "not configured"
        assert "no panel is catalogued" in out["reason"]

    # -- the URL builder ------------------------------------------------

    def test_it_builds_a_single_panel_url(self, api):
        url = api.panel_embed_url("https://g.example", "hg-control-plane-overview", 7, "7d")
        assert url.startswith("https://g.example/d-solo/hg-control-plane-overview?")
        assert "panelId=7" in url and "from=now-7d" in url and "kiosk" in url

    def test_open_in_grafana_is_built_separately(self, api):
        # A failed frame must still leave a working way through. Deriving
        # one from the other would make a single broken string break both.
        assert api.panel_open_url("https://g.example", "uid", 3) == (
            "https://g.example/d/uid?viewPanel=3"
        )

    def test_it_refuses_everything_that_is_not_a_uid(self, api):
        for uid in ("../../evil", "a/b", "..", ""):
            assert api.panel_embed_url("https://g.example", uid, 1, None) is None
            assert api.panel_open_url("https://g.example", uid, 1) is None

    def test_it_refuses_an_unsafe_base(self, api):
        for base in (
            "https://user:pw@g.example",       # userinfo
            "javascript:alert(1)",             # not http(s)
            "https://g.example/?orgId=1",      # a query the path would swallow
            "https://g.example/#x",            # fragment
            "",
        ):
            assert api.panel_embed_url(base, "uid", 1, None) is None

    def test_the_theme_is_a_closed_two_value_set(self, api):
        # #421 (ADR-100 amendment): the browser may name a render theme
        # so an embed matches the shell. Presentation only, and the URL
        # builder is the last line of defense - junk kills the URL.
        for theme in ("light", "dark"):
            url = api.panel_embed_url("https://g.example", "uid", 1, None, None, theme)
            assert f"theme={theme}" in url
        assert "theme" not in api.panel_embed_url("https://g.example", "uid", 1, None)
        for bad in ("solarized", "LIGHT", "dark&admin=1", ""):
            assert api.panel_embed_url("https://g.example", "uid", 1, None, None, bad) is None

    def test_open_in_grafana_carries_no_theme(self, api):
        # The escape hatch opens the NATIVE interface - the user's own
        # Grafana preference applies there, not the shell's.
        url = api.panel_open_url("https://g.example", "uid", 3, {"namespace": "hermes-x"})
        assert "theme" not in url

    def test_a_range_outside_the_allowlist_is_refused(self, api):
        # The range is a URL parameter. Free text here is how `now-5m`
        # becomes `&orgId=1&var-x=` tomorrow.
        for bad in ("now-5m", "7d ", "1h&kiosk", "'; DROP"):
            assert api.panel_embed_url("https://g.example", "uid", 1, bad) is None

    # -- the projection --------------------------------------------------

    def test_no_grafana_configured_is_not_configured_not_empty(self, api):
        out = api.project_panels("system", None)
        assert out["status"] == "not configured"
        assert out["panels"] == []

    def test_a_per_instance_panel_without_a_dashboard_says_so(self, api):
        out = api.project_panels("agent", "https://g.example", instance_uid=None)
        assert out["status"] == "configured"
        for p in out["panels"]:
            assert p["status"] == "not configured"
            assert "no Grafana dashboard" in p["reason"]
            # Never an embedUrl on a panel that cannot resolve.
            assert "embedUrl" not in p

    def test_a_per_instance_panel_uses_the_instance_dashboard(self, api):
        out = api.project_panels("agent", "https://g.example", instance_uid="hermes-sre-dash")
        urls = [p.get("embedUrl", "") for p in out["panels"]]
        assert all("hermes-sre-dash" in u for u in urls)
        assert not any("{instance}" in u for u in urls)

    def test_every_configured_panel_carries_a_fallback_link(self, api):
        out = api.project_panels("system", "https://g.example")
        for p in out["panels"]:
            assert p["status"] == "configured"
            assert p["openUrl"].startswith("https://g.example/d/")

    # -- context-aware variables (ADR-100, #420) -------------------------

    def test_a_context_value_reaches_only_allowlisted_variables(self, api):
        out = api.project_panels("backup", "https://g.example", context={"target": "hermes-marketing-manager"})
        by_id = {p["id"]: p for p in out["panels"]}
        ctx = by_id["backup-history-target"]
        assert ctx["contextual"] is True
        assert "var-namespace=hermes-marketing-manager" in ctx["embedUrl"]
        # The escape hatch carries the SAME context (Codex catch): an
        # Open-in-Grafana that opens the dashboard default would show
        # different data than the frame it claims to expand.
        assert "var-namespace=hermes-marketing-manager" in ctx["openUrl"]
        # Every OTHER panel of the surface is untouched by the context -
        # the allowlist is per entry, not per surface.
        for pid, p in by_id.items():
            if pid != "backup-history-target" and p.get("embedUrl"):
                assert "var-" not in p["embedUrl"]

    def test_no_context_means_no_var_params_and_the_dashboard_default_applies(self, api):
        out = api.project_panels("backup", "https://g.example")
        ctx = next(p for p in out["panels"] if p["id"] == "backup-history-target")
        assert "var-" not in ctx["embedUrl"]
        # Still marked contextual so the browser routes it to the host.
        assert ctx["contextual"] is True

    def test_an_out_of_shape_context_value_kills_the_url_not_the_shape(self, api):
        # The URL builder is the last line of defense and re-checks both
        # halves; a metacharacter value must never survive into a query
        # string half-escaped.
        for bad in ("a&kiosk=", "x y", "'; DROP", "a" * 121, ""):
            assert api.panel_embed_url("https://g.example", "uid", 1, None, {"namespace": bad}) is None
        # An out-of-shape variable NAME is refused the same way.
        assert api.panel_embed_url("https://g.example", "uid", 1, None, {"ns&x": "ok"}) is None

    # -- the embed-health probe (#415) -----------------------------------

    def _probe(self, api, monkeypatch, effect):
        import urllib.request

        api._GRAFANA_HEALTH_CACHE["doc"] = None
        api._GRAFANA_HEALTH_CACHE["at"] = 0.0

        def fake_urlopen(url, timeout=None):
            return effect(url)

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        return api.probe_grafana_health("https://g.example")

    def test_a_denied_health_check_is_state_denied_not_blank(self, api, monkeypatch):
        # 401/403 to an unauthenticated /api/health is the local loop's
        # anonymous-Viewer misconfiguration - the one #415 describes. The
        # browser gets a word for it instead of a grid of blank frames.
        import urllib.error

        def deny(url):
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)

        doc = self._probe(api, monkeypatch, deny)
        assert doc["state"] == "denied"
        assert "403" in doc["detail"]

    def test_an_unreachable_grafana_is_state_unreachable(self, api, monkeypatch):
        def boom(url):
            raise OSError("connection refused")

        doc = self._probe(api, monkeypatch, boom)
        assert doc["state"] == "unreachable"

    def test_a_healthy_grafana_is_reachable_and_cached(self, api, monkeypatch):
        import urllib.request

        calls = []

        class Resp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def count(url, timeout=None):
            calls.append(url)
            return Resp()

        api._GRAFANA_HEALTH_CACHE["doc"] = None
        api._GRAFANA_HEALTH_CACHE["at"] = 0.0
        monkeypatch.setattr(urllib.request, "urlopen", count)
        assert api.probe_grafana_health("https://g.example")["state"] == "reachable"
        assert api.probe_grafana_health("https://g.example")["state"] == "reachable"
        # The second call rode the cache - a panels poll never stacks probes.
        assert len(calls) == 1

    def test_no_base_is_not_configured_without_probing(self, api):
        assert api.probe_grafana_health(None)["state"] == "not configured"

    def test_a_malformed_variables_block_drops_the_whole_entry(self, api, tmp_path, monkeypatch):
        # Fail-closed per entry: a context-aware panel silently degraded
        # to a static one would render the wrong data under the right
        # title - the exact ADR-44 failure.
        import json as _json

        doc = {
            "apiVersion": "nexus.hermes.ai/panel-catalog/v1alpha2",
            "kind": "PanelCatalog",
            "panels": [
                {"id": "good", "surface": "system", "title": "Fine", "dashboard": "d", "panelId": 1, "size": "compact"},
                {"id": "bad-ctx", "surface": "system", "title": "Nope", "dashboard": "d", "panelId": 2, "size": "compact",
                 "variables": {"namespace": "userQuery"}},
                {"id": "bad-name", "surface": "system", "title": "Nope", "dashboard": "d", "panelId": 3, "size": "compact",
                 "variables": {"ns&kiosk": "target"}},
            ],
        }
        f = tmp_path / "panels.json"
        f.write_text(_json.dumps(doc))
        monkeypatch.setattr(api, "PANELS_PATH", f)
        assert [p["id"] for p in api.load_panel_catalog()] == ["good"]


class TestContentSecurityPolicy:
    """The frame boundary (design 14, #281)."""

    def test_it_names_the_grafana_ORIGIN_and_nothing_else(self, api):
        csp = api.content_security_policy("https://grafana.example/sub/path")
        # A path in a CSP source is ignored by browsers, so carrying one
        # would read as tighter than it is.
        assert "frame-src https://grafana.example;" in csp
        assert "sub/path" not in csp

    def test_no_grafana_means_frame_NOTHING(self, api):
        # A page that embeds nothing should not be permitted to embed
        # anything - the default is not "allow and hope".
        assert "frame-src 'none'" in api.content_security_policy(None)
        assert "frame-src 'none'" in api.content_security_policy("javascript:alert(1)")

    def test_there_is_no_wildcard_anywhere(self, api):
        for base in (None, "https://grafana.example"):
            assert "*" not in api.content_security_policy(base)

    def test_nexus_itself_cannot_be_framed(self, api):
        # The half people forget: without this a read-only dashboard is a
        # clickjacking surface for its own write actions.
        assert "frame-ancestors 'self'" in api.content_security_policy("https://g.example")

    def test_no_font_origin_is_ever_named(self, api):
        # #435/ADR-105: the brand faces are served same-origin by the
        # fonts asset route, so default-src 'self' covers them - there is
        # deliberately NO font-src directive and no font CDN anywhere.
        # The deployed page must render offline.
        csp = api.content_security_policy("https://g.example")
        assert "font-src" not in csp
        for directive in csp.split("; "):
            if directive.startswith("style-src"):
                assert "http" not in directive, directive

    def test_the_policy_and_the_panel_builder_read_one_value(self, api, monkeypatch):
        # Two readers of one config key, so a policy can never name an
        # origin the builder would not use.
        monkeypatch.setattr(
            api, "_load_config",
            lambda: {"integrations": {"grafana": {"baseUrl": "https://g.example"}}},
        )
        base = api.grafana_base_url()
        assert base == "https://g.example"
        assert base in api.content_security_policy(base)
        assert api.panel_embed_url(base, "uid", 1, None).startswith(base)


class TestBearerAuth:
    """A machine caller presents the id_token directly rather than
    simulating a browser. Same verification, second transport - not a
    second, weaker door."""

    class _Req:
        def __init__(self, headers=None, cookies=None):
            self.headers = headers or {}
            self.cookies = cookies or {}

    OIDC = {"oidc": {"issuer": "http://i.invalid/dex", "clientId": "nexus",
                     "roleClaim": "email", "roles": {"owner": ["owner@hermes.local"]}}}

    def test_a_verified_bearer_token_carries_its_role(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        monkeypatch.setattr(api, "verify_id_token", lambda t: {"email": "owner@hermes.local"})
        req = self._Req({"authorization": "Bearer real.id.token"})
        assert api.caller_role(req) == ("owner", "owner@hermes.local")

    def test_an_unverifiable_bearer_token_grants_nothing(self, api, monkeypatch):
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)

        def _boom(_t):
            raise api.HTTPException(status_code=401, detail="nope")

        monkeypatch.setattr(api, "verify_id_token", _boom)
        assert api.caller_role(self._Req({"authorization": "Bearer forged"})) == ("none", "anonymous")

    def test_an_eval_publish_token_is_NOT_a_human_role(self, api, monkeypatch):
        # Those are scoped machine credentials for one narrow write.
        # Letting one stand in for a human role would silently widen it.
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        assert api._bearer_id_token(self._Req({"authorization": "Bearer hgev_abc"})) is None
        assert api.caller_role(self._Req({"authorization": "Bearer hgev_abc"})) == ("none", "anonymous")

    def test_a_session_cookie_still_wins(self, api, monkeypatch):
        monkeypatch.setattr(api, "AUTH_DIR", api.Path("/tmp/hg-bearer-test-auth"))
        monkeypatch.setattr(api, "_load_config", lambda: self.OIDC)
        cookie = api._sign({"sub": "owner@hermes.local", "role": "owner", "exp": time.time() + 60})
        req = self._Req({"authorization": "Bearer whatever"}, {"hg_nexus_session": cookie})
        assert api.caller_role(req)[0] == "owner"


class TestIconAssets:
    """Design 12 repository-owned icons: /nexus/assets/icons/<id> serves
    the emitted asset by bare id, re-checking the bytes at serve time."""

    PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
    WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 16

    def _repo(self, tmp_path, files):
        icons = tmp_path / "deployments" / "dashboard" / "assets" / "icons"
        icons.mkdir(parents=True)
        for name, data in files.items():
            (icons / name).write_bytes(data)
        return str(tmp_path)

    def test_png_and_webp_resolve_with_their_media_types(self, api, tmp_path):
        repo = self._repo(tmp_path, {"postiz.png": self.PNG, "kanban.webp": self.WEBP})
        assert api.resolve_icon(repo, "postiz") == (self.PNG, "image/png")
        assert api.resolve_icon(repo, "kanban") == (self.WEBP, "image/webp")

    def test_missing_icon_is_none(self, api, tmp_path):
        repo = self._repo(tmp_path, {})
        assert api.resolve_icon(repo, "ghost") is None

    def test_traversal_shaped_names_are_refused_by_the_id_gate(self, api, tmp_path):
        repo = self._repo(tmp_path, {"postiz.png": self.PNG})
        for name in ("../postiz", "a/../b", ".", "POSTIZ", "a_b", "x" * 64):
            assert api.resolve_icon(repo, name) is None

    def test_fake_bytes_and_oversize_serve_nothing(self, api, tmp_path):
        repo = self._repo(
            tmp_path,
            {
                "fake.png": b"not a png",
                "huge.png": b"\x89PNG\r\n\x1a\n" + b"\x00" * (256 * 1024),
            },
        )
        assert api.resolve_icon(repo, "fake") is None
        assert api.resolve_icon(repo, "huge") is None

    def test_symlinked_icon_is_refused(self, api, tmp_path):
        repo = self._repo(tmp_path, {})
        outside = tmp_path / "outside.png"
        outside.write_bytes(self.PNG)
        (tmp_path / "deployments" / "dashboard" / "assets" / "icons" / "sneaky.png").symlink_to(outside)
        assert api.resolve_icon(repo, "sneaky") is None

    def test_route_404s_clean_and_serves_with_cache_header(self, api, tmp_path, monkeypatch):
        repo = self._repo(tmp_path, {"postiz.png": self.PNG})
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": repo})
        resp = api.get_nexus_icon("postiz")
        assert resp.body == self.PNG
        assert resp.media_type == "image/png"
        assert resp.headers["cache-control"] == "max-age=300"
        with pytest.raises(api.HTTPException) as exc:
            api.get_nexus_icon("ghost")
        assert exc.value.status_code == 404


def _gif(w=128, h=128, sig=b"GIF89a", pad=32, trailer=b"\x3b"):
    return sig + w.to_bytes(2, "little") + h.to_bytes(2, "little") + b"\x00" * pad + trailer


def _vp8x_webp(w=128, h=128, riff_size=None, chunk_size=10):
    payload = b"\x00" * 4 + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little")
    body = b"WEBP" + b"VP8X" + chunk_size.to_bytes(4, "little") + payload
    size = len(body) if riff_size is None else riff_size
    return b"RIFF" + size.to_bytes(4, "little") + body


class TestAvatarAssets:
    """The avatar inventory (#426): platform-curated animated assets,
    selected by id, served through the same bounded posture as icons.
    The list route and the byte route walk the same gate, so the gallery
    can never advertise what the byte route refuses."""

    def _repo(self, tmp_path, files):
        base = tmp_path / "deployments" / "dashboard" / "assets" / "avatars"
        base.mkdir(parents=True)
        for name, data in files.items():
            (base / name).write_bytes(data)
        return str(tmp_path)

    def test_gif_and_vp8x_webp_resolve_with_their_media_types(self, api, tmp_path):
        repo = self._repo(tmp_path, {"bot-nova.gif": _gif(), "bot-vega.webp": _vp8x_webp()})
        assert api.resolve_avatar(repo, "bot-nova") == (_gif(), "image/gif")
        assert api.resolve_avatar(repo, "bot-vega") == (_vp8x_webp(), "image/webp")
        # Both GIF signatures are genuine.
        repo87 = self._repo(tmp_path / "b", {"old.gif": _gif(sig=b"GIF87a")})
        assert api.resolve_avatar(repo87, "old") is not None

    def test_the_refusal_matrix(self, api, tmp_path):
        repo = self._repo(
            tmp_path,
            {
                "fake.gif": b"not a gif" + b"\x00" * 8,
                "png-in-webp.webp": b"RIFF" + b"\x00" * 4 + b"WEBP" + b"VP8 " + b"\x00" * 16,
                "huge.gif": _gif(pad=512 * 1024),
                "wide.gif": _gif(w=256, h=128),
                "big.gif": _gif(w=512, h=512),
                "empty.gif": _gif(w=0, h=0),
                # Codex catch: structure, not just magic. A GIF with no
                # trailer and a WebP whose length fields lie are junk in
                # a costume.
                "headless.gif": _gif(trailer=b"\x00"),
                "lying-riff.webp": _vp8x_webp(riff_size=9999),
                "lying-chunk.webp": _vp8x_webp(chunk_size=99),
            },
        )
        for name in ("fake", "png-in-webp", "huge", "wide", "big", "empty", "headless", "lying-riff", "lying-chunk"):
            assert api.resolve_avatar(repo, name) is None, name
        for name in ("../bot", "a/../b", "BOT", "x" * 64):
            assert api.resolve_avatar(repo, name) is None, name
        assert api.resolve_avatar(repo, "ghost") is None

    def test_symlinked_avatar_is_refused(self, api, tmp_path):
        repo = self._repo(tmp_path, {})
        outside = tmp_path / "outside.gif"
        outside.write_bytes(_gif())
        (tmp_path / "deployments" / "dashboard" / "assets" / "avatars" / "sneaky.gif").symlink_to(outside)
        assert api.resolve_avatar(repo, "sneaky") is None
        assert api.list_avatars(repo) == []

    def test_the_list_is_the_selectable_subset_of_what_the_byte_route_serves(self, api, tmp_path):
        repo = self._repo(
            tmp_path,
            {
                "bot-nova.gif": _gif(),
                # A sibling .webp under the SAME id must not fork the
                # identity: one id, one listing, gif preferred like the
                # byte route (Codex catch).
                "bot-nova.webp": _vp8x_webp(),
                "bot-vega.webp": _vp8x_webp(),
                "broken.gif": b"junk" + b"\x00" * 8,
                "UPPER.gif": _gif(),
                "notes.txt": b"not an image",
                # #426 beta pass: a -still twin is servable (reduced-motion
                # machinery) but must NOT appear in the gallery listing -
                # it is not a second identity an agent can pick.
                "bot-nova-still.gif": _gif(),
            },
        )
        assert api.list_avatars(repo) == [
            {"id": "bot-nova", "ext": "gif"},
            {"id": "bot-vega", "ext": "webp"},
        ]
        assert api.list_avatars(str(tmp_path / "nowhere")) == []
        # Excluded from the list, but still directly fetchable - the
        # reduced-motion request for "bot-nova-still" must not 404.
        assert api.resolve_avatar(repo, "bot-nova-still") == (_gif(), "image/gif")

    def test_routes_serve_list_and_bytes_with_cache_header(self, api, tmp_path, monkeypatch):
        repo = self._repo(tmp_path, {"bot-nova.gif": _gif()})
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": repo})
        listing = api.get_nexus_avatars()
        assert listing == {"version": 1, "avatars": [{"id": "bot-nova", "ext": "gif"}]}
        resp = api.get_nexus_avatar("bot-nova")
        assert resp.media_type == "image/gif"
        assert resp.headers["cache-control"] == "max-age=300"
        with pytest.raises(api.HTTPException) as exc:
            api.get_nexus_avatar("ghost")
        assert exc.value.status_code == 404
        monkeypatch.setattr(api, "_load_config", lambda: {})
        with pytest.raises(api.HTTPException) as exc:
            api.get_nexus_avatars()
        assert exc.value.status_code == 503

    def test_every_committed_inventory_asset_passes_the_serve_gate(self, api):
        # THE commit gate for the curated set: what is in the repo is what
        # production serves, so a bad merge fails here, not on a card.
        inventory = Path(__file__).resolve().parents[2] / "control-plane" / "nexus" / "avatars"
        assets = [p for p in sorted(inventory.iterdir()) if p.suffix in (".gif", ".webp")]
        assert len(assets) >= 8, "the inventory promise is 'lots of avatars'"
        for p in assets:
            assert api._ICON_ID_RE.match(p.stem), p.name
            assert api.avatar_asset_error(p.suffix, p.read_bytes()) is None, p.name

    def test_every_selectable_avatar_has_a_still_twin(self, api):
        # #426 beta pass (Codex catch): AgentAvatar derives "<code>-still"
        # unconditionally for reduced-motion. A selectable id shipped
        # without its twin would 404 there and silently fall back to
        # rings - catch the missing pairing at commit time, not in a
        # reduced-motion session. A symlinked "twin" must not satisfy
        # this either (Codex catch #2 - resolve_avatar refuses symlinks
        # at serve time, so this gate follows the same rule, not raw
        # iterdir()).
        inventory = Path(__file__).resolve().parents[2] / "control-plane" / "nexus" / "avatars"
        real = [p for p in inventory.iterdir() if p.suffix in (".gif", ".webp") and p.is_file() and not p.is_symlink()]
        stems = {p.stem for p in real}
        selectable = {s for s in stems if not s.endswith("-still")}
        assert selectable, "the inventory promise is 'lots of avatars'"
        missing = sorted(s for s in selectable if f"{s}-still" not in stems)
        assert missing == [], f"selectable avatars with no -still twin: {missing}"


class TestTypedConnections:
    """Optional connection.kind (M13): additive under v1alpha1, shared by
    the legacy and sheet validators."""

    def _doc(self, conn):
        return {"version": 1, "connections": [conn]}

    def test_kind_accepted_and_kindless_legacy_round_trips(self, api):
        typed = {"id": "conn-1", "from": "a", "to": "b", "label": "calls", "kind": "calls"}
        out = api.validate_connections(self._doc(typed))
        assert out["connections"][0]["kind"] == "calls"
        legacy = {"id": "conn-1", "from": "a", "to": "b", "label": "relates to"}
        out2 = api.validate_connections(self._doc(legacy))
        assert "kind" not in out2["connections"][0]

    def test_bad_kind_rejected(self, api):
        import pytest as _pytest

        bad = {"id": "conn-1", "from": "a", "to": "b", "label": "x", "kind": "publishes"}
        with _pytest.raises(api.HTTPException) as exc:
            api.validate_connections(self._doc(bad))
        assert "kind" in str(exc.value.detail)


class TestCardDisplayMode:
    """Optional card.displayMode (M13 multiplicity): additive, absent = badge."""

    def _doc(self, card):
        return {
            "apiVersion": "nexus.hermes.ai/v1alpha1",
            "kind": "NexusWorkspace",
            "environment": "local",
            "revision": 0,
            "featureFlags": {},
            "sheets": [{
                "id": "fleet", "name": "Fleet", "mode": "operational",
                "cards": [card], "shapes": [], "texts": [], "notes": [], "connections": [],
            }],
        }

    def test_display_mode_accepted_and_legacy_round_trips(self, api):
        out = api.validate_workspace(self._doc({"ref": "a", "position": {"x": 1, "y": 2}, "displayMode": "stack"}))
        assert out["sheets"][0]["cards"][0]["displayMode"] == "stack"
        plain = api.validate_workspace(self._doc({"ref": "a", "position": {"x": 1, "y": 2}}))
        assert "displayMode" not in plain["sheets"][0]["cards"][0]

    def test_bad_display_mode_rejected(self, api):
        import pytest as _pytest

        with _pytest.raises(api.HTTPException) as exc:
            api.validate_workspace(self._doc({"ref": "a", "position": {"x": 1, "y": 2}, "displayMode": "huge"}))
        assert "displayMode" in str(exc.value.detail)


class TestDeploymentCapabilities:
    """Deployment capabilities (ADR-84, #403/#409).

    The property under test throughout: a capability is decided by
    whoever DEPLOYED Nexus, and nothing reachable from a browser can
    change it. The feature overlay beside it is the opposite - operator
    state, request-time mutable - and conflating the two is what makes a
    destructive action look guarded while it is not.
    """

    class _Req:
        def __init__(self, headers=None):
            self.headers = headers or {}

    def _cfg(self, api, monkeypatch, config):
        monkeypatch.setattr(api, "_load_config", lambda: config)

    # -- resolution ------------------------------------------------------

    def test_absent_capabilities_fail_closed(self, api, monkeypatch):
        for config in ({}, {"capabilities": {}}, {"capabilities": None}, {"capabilities": "yes"}):
            self._cfg(api, monkeypatch, config)
            assert api.capability(api.CAP_WORKSPACE_RESET) is False, config

    def test_a_non_boolean_never_grants(self, api, monkeypatch):
        # A typo must not be able to turn a destructive action on. These
        # are all truthy in Python, which is exactly why the check is
        # isinstance and not `if value`.
        for junk in ("true", "yes", 1, [1], {"enabled": True}):
            self._cfg(api, monkeypatch, {"capabilities": {"workspaceReset": junk}})
            assert api.capability(api.CAP_WORKSPACE_RESET) is False, junk

    def test_an_explicit_true_grants(self, api, monkeypatch):
        self._cfg(api, monkeypatch, {"capabilities": {"workspaceReset": True}})
        assert api.capability(api.CAP_WORKSPACE_RESET) is True

    # -- views fail OPEN, unlike everything else --------------------------

    def test_views_are_available_unless_explicitly_withheld(self, api, monkeypatch):
        for config in ({}, {"capabilities": {}}, {"capabilities": {"views": None}},
                       {"capabilities": {"views": {"system": "false"}}}):
            self._cfg(api, monkeypatch, config)
            assert api.view_enabled("system") is True, config

    def test_an_explicit_false_withholds_a_view(self, api, monkeypatch):
        self._cfg(api, monkeypatch, {"capabilities": {"views": {"system": False}}})
        assert api.view_enabled("system") is False
        assert api.view_enabled("agents") is True

    def test_a_required_view_cannot_be_withheld(self, api, monkeypatch):
        # Only GATEABLE_VIEWS may be withheld; Fleet Canvas is the product.
        self._cfg(api, monkeypatch, {"capabilities": {"views": {"fleet": False}}})
        assert api.view_enabled("fleet") is True
        assert "fleet" not in api.GATEABLE_VIEWS

    # -- enforcement -----------------------------------------------------

    def test_reset_refuses_when_the_capability_is_absent(self, api, tmp_path, monkeypatch):
        import pytest as _pytest

        monkeypatch.setattr(api, "WORKSPACE_PATH", tmp_path / "workspace.json")
        monkeypatch.setattr(api, "_plan_or_none", lambda: None)
        (tmp_path / "workspace.json").write_text("{}")
        self._cfg(api, monkeypatch, {})
        with _pytest.raises(api.HTTPException) as exc:
            api.delete_workspace(self._Req())
        assert exc.value.status_code == 403
        # The message names the key, because editing it is the only
        # useful next step.
        assert "capabilities.workspaceReset" in exc.value.detail
        # And it REFUSED - the file is still there. A gate that 403s after
        # deleting is not a gate.
        assert (tmp_path / "workspace.json").exists()

    def test_a_withheld_view_404s_its_route(self, api, tmp_path, monkeypatch):
        import pytest as _pytest

        monkeypatch.setattr(api, "FEATURES_PATH", tmp_path / "features.json")
        monkeypatch.setattr(api, "read_features", lambda: {"communication-view": True, "backups-view": True})
        self._cfg(api, monkeypatch, {"capabilities": {"views": {"communication": False, "backups": False}}})
        for route in (api.get_nexus_communication, api.get_nexus_backups):
            with _pytest.raises(api.HTTPException) as exc:
                route()
            assert exc.value.status_code == 404
            assert "not available in this deployment" in exc.value.detail

    def test_the_envelope_reports_resolved_verdicts(self, api, monkeypatch):
        self._cfg(api, monkeypatch, {"capabilities": {"workspaceReset": True, "views": {"system": False}}})
        out = api.resolved_capabilities()
        assert out["workspaceReset"] is True
        assert out["views"]["system"] is False
        assert out["views"]["agents"] is True
        # Every gateable view is reported, so the browser never has to
        # guess which omission means what.
        assert set(out["views"]) == set(api.GATEABLE_VIEWS)

    # -- the separation from the operator overlay -------------------------

    def test_no_route_writes_a_capability(self, api):
        # The absence IS the feature. If this ever finds one, the gate has
        # become a preference.
        writers = [
            r for r in api.router.routes
            if "capab" in getattr(r, "path", "").lower()
            and set(getattr(r, "methods", [])) & {"PUT", "POST", "DELETE", "PATCH"}
        ]
        assert writers == []

    def test_features_writes_require_the_operator_role(self, api, tmp_path, monkeypatch):
        import pytest as _pytest

        # Before this, put_features took no Request and checked nothing:
        # anyone who could reach the route could enable every flagged
        # capability in the product.
        monkeypatch.setattr(api, "FEATURES_PATH", tmp_path / "features.json")
        self._cfg(api, monkeypatch, {
            "workspace": {"ownerEmails": ["calvin@example.test"], "identityHeader": "X-Auth-Email"},
        })
        payload = {"version": 1, "enabled": {}}
        for call in (
            lambda req: api.put_features(req, payload),
            lambda req: api.delete_features(req),
        ):
            with _pytest.raises(api.HTTPException) as exc:
                call(self._Req({"X-Auth-Email": "intruder@example.test"}))
            assert exc.value.status_code == 403
        # The owner still gets through.
        assert api.put_features(self._Req({"X-Auth-Email": "calvin@example.test"}), payload)["ok"] is True


class TestOneLadderPerVocabulary:
    """#424: a status ordering is defined once, and the browser's copy of
    it cannot silently drift."""

    def test_the_edge_ladder_is_worst_last_and_complete(self, api):
        assert api.EDGE_STATUS_ORDER == ("declared", "configured", "stale", "degraded", "failed")
        # Every status edge_live_status can emit must be rankable, or a
        # worst-of would silently treat it as the floor.
        assert set(api.EDGE_STATUS_ORDER) == {"declared", "configured", "stale", "degraded", "failed"}

    def test_the_browser_fallback_matches_the_server(self, api):
        # The browser ranks by the order the document SERVES; this
        # fallback only covers a backend older than the field. It still
        # has to agree, or that one case ranks differently from every
        # other - the exact drift the shipped order removes.
        import re
        from pathlib import Path

        src = Path(api.__file__).resolve().parents[2] / "nexus-ui" / "src" / "app" / "communication" / "model.ts"
        text = src.read_text(encoding="utf-8")
        m = re.search(r"const FALLBACK_ORDER: EdgeStatus\[\] = \[([^\]]+)\]", text)
        assert m, "FALLBACK_ORDER not found - did the browser stop ranking?"
        found = tuple(x.strip().strip('"') for x in m.group(1).split(","))
        assert found == api.EDGE_STATUS_ORDER

    def test_the_two_vocabularies_are_not_interchangeable(self, api):
        # Edge delivery states and component health levels are different
        # types on purpose. They share the adjective `degraded` and
        # nothing else: a route can be `declared` (a floor, not a level),
        # and a component can be `healthy` (which no route ever is). The
        # guard is that neither set can quietly become the other.
        edge, level = set(api.EDGE_STATUS_ORDER), set(api._LEVEL_RANK)
        assert edge != level
        assert edge & level == {"degraded"}
        assert {"declared", "configured", "stale"} <= edge
        assert {"healthy", "unhealthy", "unknown"} <= level

    def test_one_alert_observation_feeds_both_readings(self, api, monkeypatch):
        # The strip and the overlay must not be able to describe different
        # firing sets: both go through alerts_observation.
        calls = []
        monkeypatch.setattr(api, "_prom_alerts", lambda b: calls.append(b) or [])
        api.alerts_observation("http://prom.test:9090")
        assert calls == ["http://prom.test:9090"]

    # --- #618: BOTH evaluators are read -------------------------------------
    # Prometheus evaluates the stack defaultRules; Grafana evaluates every rule
    # charts/monitoring provisions - the alerts the platform actually ships.
    # Reading only Prometheus meant the view listed alerts routed to `null` and
    # hid the ones that deliver, then called the result healthy.

    GRAFANA_RULES = {
        "status": "success",
        "data": {
            "groups": [
                {
                    "name": "hermes-marketing-sre-monitoring",
                    "rules": [
                        {
                            "name": "HermesAgentDown (marketing-sre)",
                            "state": "firing",
                            "alerts": [
                                {
                                    # Grafana's own vocabulary, not Prometheus's.
                                    "state": "Alerting",
                                    "activeAt": "2026-08-18T00:00:00Z",
                                    "value": "1",
                                    "labels": {
                                        "alertname": "HermesAgentDown",
                                        "persona": "marketing-sre",
                                        "severity": "critical",
                                        "__grafana_autogenerated__": "true",
                                    },
                                    "annotations": {"summary": "down"},
                                }
                            ],
                        },
                        {
                            "name": "SiteVisitsHigh (marketing-sre)",
                            "state": "inactive",
                            "alerts": [{"state": "Normal", "labels": {}, "annotations": {}}],
                        },
                    ],
                }
            ]
        },
    }

    def _stub_grafana(self, api, monkeypatch, doc):
        import io
        import json as _json
        import urllib.request

        class _Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        monkeypatch.setattr(
            urllib.request, "urlopen", lambda *a, **k: _Resp(_json.dumps(doc).encode())
        )

    def test_grafana_alerting_state_is_translated_to_prometheus_state(self, api, monkeypatch):
        # Grafana says Alerting; every consumer filters on firing. Getting this
        # wrong returns an empty list against a Grafana with rules firing, which
        # is indistinguishable from healthy.
        self._stub_grafana(api, monkeypatch, self.GRAFANA_RULES)
        out = api._grafana_alerts("http://grafana.test")
        assert [a["state"] for a in out] == ["firing"]

    def test_grafana_alerts_carry_a_namespace_derived_from_persona(self, api, monkeypatch):
        # Grafana rules carry `persona` and no `namespace`, and alert_ownership
        # keys on namespace - without the mapping every platform alert would
        # read as control-plane.
        self._stub_grafana(api, monkeypatch, self.GRAFANA_RULES)
        out = api._grafana_alerts("http://grafana.test")
        assert out[0]["labels"]["namespace"] == "hermes-marketing-sre"

    def test_grafana_bookkeeping_labels_do_not_leak(self, api, monkeypatch):
        self._stub_grafana(api, monkeypatch, self.GRAFANA_RULES)
        out = api._grafana_alerts("http://grafana.test")
        assert not [k for k in out[0]["labels"] if k.startswith("__")]

    def test_the_observation_merges_both_engines(self, api, monkeypatch):
        monkeypatch.setattr(api, "_prom_alerts", lambda b: [{"state": "firing", "labels": {"alertname": "Watchdog"}}])
        monkeypatch.setattr(api, "_grafana_alerts", lambda b: [{"state": "firing", "labels": {"alertname": "HermesAgentDown"}}])
        out = api.alerts_observation("http://prom", "http://grafana")
        assert sorted(a["labels"]["alertname"] for a in out) == ["HermesAgentDown", "Watchdog"]

    def test_an_unreachable_grafana_does_not_lose_the_prometheus_alerts(self, api, monkeypatch):
        # Grafana is additive and best-effort: a deployment MAY have anonymous
        # access disabled. Half an answer beats an error - and it can only ever
        # ADD firing alerts, so it can never make the result look healthier.
        def _boom(_b):
            raise RuntimeError("401")

        monkeypatch.setattr(api, "_prom_alerts", lambda b: [{"state": "firing", "labels": {"alertname": "Watchdog"}}])
        monkeypatch.setattr(api, "_grafana_alerts", _boom)
        out = api.alerts_observation("http://prom", "http://grafana")
        assert [a["labels"]["alertname"] for a in out] == ["Watchdog"]

    def test_an_unreadable_grafana_is_marked_not_swallowed(self, api, monkeypatch):
        # The first cut of this swallowed the failure and returned the
        # Prometheus-only list as complete. Empty + unreadable is not healthy.
        def _boom(_b):
            raise RuntimeError("401")

        monkeypatch.setattr(api, "_prom_alerts", lambda b: [])
        monkeypatch.setattr(api, "_grafana_alerts", _boom)
        reading = api.alerts_observation("http://prom", "http://grafana")
        assert list(reading) == []
        assert reading.unreadable == ("grafana",)

    def test_a_complete_reading_marks_nothing_unreadable(self, api, monkeypatch):
        monkeypatch.setattr(api, "_prom_alerts", lambda b: [])
        monkeypatch.setattr(api, "_grafana_alerts", lambda b: [])
        assert api.alerts_observation("http://prom", "http://grafana").unreadable == ()

    def test_a_plain_list_is_still_a_valid_reading(self, api):
        # Consumers use getattr(..., "unreadable", ()), so a stub returning a
        # bare list keeps meaning "complete" rather than crashing.
        assert getattr([], "unreadable", ()) == ()

    def test_the_firing_list_declares_an_unreadable_evaluator(self, api, monkeypatch):
        # An empty list from a PARTIAL read must not be presentable as
        # "nothing is firing" - that is the false all-clear this fixes.
        reading = api.AlertReading([])
        reading.unreadable = ("grafana",)
        monkeypatch.setattr(api, "_prom_base", lambda cfg: "http://prom")
        monkeypatch.setattr(api, "_grafana_alert_base", lambda cfg: "http://grafana")
        monkeypatch.setattr(api, "grafana_base_url", lambda: "http://grafana.local")
        monkeypatch.setattr(api, "alerts_observation", lambda *a, **k: reading)
        doc = api._firing_alerts({})
        assert doc["reachable"] is True
        assert doc["firing"] == []
        assert doc["unreadable"] == ["grafana"]

    def test_the_overlay_refuses_to_read_healthy_from_a_partial_reading(self, api, monkeypatch):
        # grafana_source treats absence of a firing alert as HEALTHY, so a
        # silently-unread evaluator would publish healthy for every component
        # it watches. The adapter must degrade to unknown instead.
        api._last_good.clear()
        reading = api.AlertReading([])
        reading.unreadable = ("grafana",)
        monkeypatch.setattr(api, "alerts_observation", lambda *a, **k: reading)
        monkeypatch.setattr(api, "_k8s_get", lambda *a, **k: {"items": []})
        sources, _, _ = api.collect_sources(
            _ns_plan(),
            {"integrations": {"prometheus": {"baseUrl": "http://prom.test:9090"}}},
            "2026-07-31T12:00:00Z",
        )
        assert sources["grafana"]["level"] != "healthy"

    def test_an_unreachable_prometheus_still_raises(self, api, monkeypatch):
        # Prometheus was always required and stays fatal: the adapter degrades
        # to unknown rather than reporting a partial list as complete.
        def _boom(_b):
            raise RuntimeError("connection refused")

        monkeypatch.setattr(api, "_prom_alerts", _boom)
        with pytest.raises(RuntimeError):
            api.alerts_observation("http://prom", "http://grafana")

    def test_the_alert_observation_is_not_cached(self, api, monkeypatch):
        # A cache here would sit under the overlay's own cache, and the
        # compounded window is time during which a dead Prometheus keeps
        # answering. Missing evidence must read unknown, never healthy.
        seen = []

        def flaky(_b):
            seen.append(1)
            if len(seen) > 1:
                raise RuntimeError("prom down")
            return []

        monkeypatch.setattr(api, "_prom_alerts", flaky)
        assert api.alerts_observation("http://prom.test:9090") == []
        with __import__("pytest").raises(RuntimeError):
            api.alerts_observation("http://prom.test:9090")


class TestPlanShapeGate:
    """#446: a present-but-malformed plan must be a diagnosable 503, never
    a 200 that blanks the canvas in the browser."""

    class _Req:
        def __init__(self, headers=None):
            self.headers = headers or {}

    def _setup(self, api, tmp_path, monkeypatch, text):
        plan_file = tmp_path / "deployments" / "dashboard" / "nexus-plan.json"
        plan_file.parent.mkdir(parents=True, exist_ok=True)
        plan_file.write_text(text, encoding="utf-8")
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": str(tmp_path)})
        return plan_file

    def test_the_pure_gate_names_exactly_what_is_wrong(self, api):
        assert api.plan_shape_error({"components": [], "relationships": []}) is None
        assert "not an object" in api.plan_shape_error(["a", "list"])
        assert "'components' is missing" in api.plan_shape_error({"relationships": []})
        assert "'relationships' is missing" in api.plan_shape_error({"components": []})
        assert "must be a list, got dict" in api.plan_shape_error(
            {"components": [], "relationships": {}}
        )

    def test_a_plan_missing_relationships_503s_naming_the_key_and_file(self, api, tmp_path, monkeypatch):
        # The observed failure: this exact plan used to serve as a 200 and
        # the only evidence was a console TypeError from the edges memo.
        self._setup(api, tmp_path, monkeypatch, json.dumps({"version": 1, "components": []}))
        with pytest.raises(api.HTTPException) as exc:
            api.get_nexus(self._Req())
        assert exc.value.status_code == 503
        assert "'relationships' is missing" in exc.value.detail
        assert "nexus-plan.json" in exc.value.detail

    def test_invalid_json_503s_instead_of_500ing(self, api, tmp_path, monkeypatch):
        self._setup(api, tmp_path, monkeypatch, '{"components": [')
        with pytest.raises(api.HTTPException) as exc:
            api.get_nexus(self._Req())
        assert exc.value.status_code == 503
        assert "not valid JSON" in exc.value.detail
        assert "nexus-plan.json" in exc.value.detail

    def test_neither_detail_reads_as_first_run(self, api, tmp_path, monkeypatch):
        # fetchNexus keys demo mode on "no repoPath configured" and
        # "does not exist - run". A malformed plan matching either would
        # render the demo over a real breakage - the exact bug #424 fixed.
        for text in ('{"components": [', json.dumps({"components": []})):
            self._setup(api, tmp_path, monkeypatch, text)
            with pytest.raises(api.HTTPException) as exc:
                api.get_nexus(self._Req())
            assert "no repoPath configured" not in exc.value.detail
            assert "does not exist - run" not in exc.value.detail


class TestFontAssets:
    """#435/ADR-105: the brand faces ride the gitops repo and are served
    by a validated route - the serve-time half of the mirrored validator
    (the dashboard-side sweep in fonts.test.ts is the commit half)."""

    def _repo(self, tmp_path, name="figtree-latin.woff2", data=b"wOF2" + b"\x00" * 60):
        base = tmp_path / "deployments" / "dashboard" / "assets" / "fonts"
        base.mkdir(parents=True, exist_ok=True)
        (base / name).write_bytes(data)
        return tmp_path

    def test_the_pure_gate(self, api):
        assert api.font_asset_error(b"wOF2" + b"\x00" * 10) is None
        assert "not woff2" in api.font_asset_error(b"wOFF" + b"\x00" * 10)  # woff1 refuses
        assert "not woff2" in api.font_asset_error(b"")
        assert "exceeds" in api.font_asset_error(b"wOF2" + b"\x00" * (256 * 1024))

    def test_resolve_refuses_shapes_the_route_must_never_serve(self, api, tmp_path):
        repo = self._repo(tmp_path)
        assert api.resolve_font(str(repo), "figtree-latin.woff2") is not None
        assert api.resolve_font(str(repo), "figtree-latin.woff") is None  # wrong ext
        assert api.resolve_font(str(repo), "../figtree-latin.woff2") is None  # traversal shape
        assert api.resolve_font(str(repo), "MISSING.woff2") is None  # id regex
        assert api.resolve_font(str(repo), "nope.woff2") is None  # absent
        # A symlink is refused even when its target would pass.
        base = tmp_path / "deployments" / "dashboard" / "assets" / "fonts"
        (base / "alias.woff2").symlink_to(base / "figtree-latin.woff2")
        assert api.resolve_font(str(repo), "alias.woff2") is None
        # Forged extension over junk bytes refuses at the byte gate.
        (base / "junk.woff2").write_bytes(b"GIF89a junk")
        assert api.resolve_font(str(repo), "junk.woff2") is None

    def test_the_route_serves_bytes_with_the_right_type(self, api, tmp_path, monkeypatch):
        repo = self._repo(tmp_path)
        monkeypatch.setattr(api, "_load_config", lambda: {"repoPath": str(repo)})
        resp = api.get_nexus_font("figtree-latin.woff2")
        assert resp.media_type == "font/woff2"
        assert resp.headers["cache-control"] == "max-age=86400"
        with pytest.raises(api.HTTPException) as exc:
            api.get_nexus_font("absent.woff2")
        assert exc.value.status_code == 404

    def test_the_committed_inventory_passes_the_serve_gate(self, api):
        # The sweep: every face the platform ships is servable, and the
        # three the stylesheet names are all present.
        fonts_dir = Path(api.__file__).resolve().parent / "fonts"
        names = sorted(p.name for p in fonts_dir.glob("*.woff2"))
        for name in ("figtree-latin.woff2", "nunito-sans-latin.woff2", "nunito-sans-latin-italic.woff2"):
            assert name in names
        for p in fonts_dir.glob("*.woff2"):
            assert api.font_asset_error(p.read_bytes()) is None, p.name


def test_panels_carry_their_plane(api):
    """#706 / ADR 0166: every served panel names its plane, derived from
    the platform's promised uids - the browser never derives one."""
    project_panels = api.project_panels

    out = project_panels("system", "http://grafana.example")
    assert out["panels"], "the system surface serves panels"
    for p in out["panels"]:
        assert p["plane"] in ("control-plane", "workload"), p

    agent = project_panels("agent", "http://grafana.example", instance_uid="mkt-manager-uid")
    for p in agent["panels"]:
        if p.get("status") == "configured" and "{instance}" not in str(p.get("id", "")):
            assert p["plane"] in ("control-plane", "workload")
    # A per-instance panel is the workload plane by construction.
    none_inst = project_panels("agent", "http://grafana.example", instance_uid=None)
    inst_rows = [p for p in none_inst["panels"] if p.get("status") == "not configured"]
    assert all(p["plane"] == "workload" for p in inst_rows)


class TestPlanPath:
    """The emit writes deployments/control-plane/nexus-plan.json (#732); the
    reader takes that first and falls back to the pre-flip
    deployments/dashboard/ location so an un-re-emitted repo keeps serving."""

    def test_canonical_wins_over_legacy(self, api, tmp_path):
        for rel in ("deployments/control-plane/nexus-plan.json", "deployments/dashboard/nexus-plan.json"):
            f = tmp_path / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("{}", encoding="utf-8")
        assert api._plan_path(str(tmp_path)) == tmp_path / "deployments" / "control-plane" / "nexus-plan.json"

    def test_legacy_location_still_serves(self, api, tmp_path):
        f = tmp_path / "deployments" / "dashboard" / "nexus-plan.json"
        f.parent.mkdir(parents=True)
        f.write_text("{}", encoding="utf-8")
        assert api._plan_path(str(tmp_path)) == f

    def test_absent_names_the_canonical_path(self, api, tmp_path):
        assert api._plan_path(str(tmp_path)) == tmp_path / "deployments" / "control-plane" / "nexus-plan.json"
