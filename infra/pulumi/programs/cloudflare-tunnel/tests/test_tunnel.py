"""Offline unit tests for ``cloudflare_tunnel/tunnel.py``'s pure helpers
(``hostname``, ``ingress_rules``) - these build plain
``pulumi.input_type``-decorated Args objects, which (confirmed by directly
exercising this in a throwaway scratch project against the installed
``pulumi_cloudflare`` SDK before writing this test) construct fine with NO
active Pulumi runtime/``set_mocks`` context, unlike an actual
``pulumi.CustomResource`` - see ``test_secrets.py`` for the
``set_mocks``-based tests covering the resource-construction half of this
program.
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from cloudflare_tunnel.tunnel import hostname, ingress_rules  # noqa: E402


def test_hostname_pattern():
    assert hostname("support-agent", "example.com") == "support-agent.agents.example.com"


def test_ingress_rules_one_per_service_plus_catch_all():
    services = [
        {"name": "tools", "port": 8080, "path": "/tools"},
        {"name": "metrics", "port": 9090},
    ]
    rules = ingress_rules(services, "support-agent.agents.example.com")

    assert len(rules) == 3  # 2 services + 1 catch-all

    assert rules[0].hostname == "support-agent.agents.example.com"
    assert rules[0].service == "http://localhost:8080"
    assert rules[0].path == "/tools"

    assert rules[1].hostname == "support-agent.agents.example.com"
    assert rules[1].service == "http://localhost:9090"
    assert rules[1].path is None

    # The catch-all MUST be last and MUST have no hostname (Cloudflare
    # evaluates ingress rules in order, first match wins; an unmatched
    # request needs an explicit terminal rule).
    assert rules[-1].hostname is None
    assert rules[-1].service == "http_status:404"


def test_ingress_rules_catch_all_present_even_with_no_services():
    rules = ingress_rules([], "support-agent.agents.example.com")
    assert len(rules) == 1
    assert rules[0].service == "http_status:404"
    assert rules[0].hostname is None
