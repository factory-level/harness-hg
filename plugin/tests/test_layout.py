"""The agent-team layout in the emitter (ADR 0178): a split authoring under
agents/<harness>/<name>/{harness-hg,src} renders the SAME record bytes as
the legacy file it was split from - for an Eve agent (the examples/eve-agent
echo project) and for a Hermes profile carrying the v3 expose block - and a
`src/` payload with no contract is a refusal, never a record with zero apps."""

from __future__ import annotations

import os
import pathlib
import shutil
import sys

import pytest
import yaml

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from gitops_emitter import emit_cli, layout  # noqa: E402
from gitops_emitter.harness import hermes  # noqa: E402
from gitops_emitter.harness.hermes import GitopsEmitterError  # noqa: E402
from gitops_emitter.render import build_record, render_yaml, resolve_apps, validate  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
ECHO = REPO_ROOT / "examples" / "eve-agent" / "agents" / "echo"
SHA = "3f06a1b2c3d4e5f60718293a4b5c6d7e8f901234"
SRC = "https://github.com/factorylevel/eve-agents.git"
API = "hermes-gitops.factorylevel.dev/agent-team/v1alpha1"


def _dump(path: pathlib.Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")


def _split_legacy(ext: dict, *, harness: str, name: str, root: pathlib.Path) -> pathlib.Path:
    """Write the agent-team files that fold back to *ext*; return src/."""
    agent_dir = root / "agents" / harness / name
    hg = agent_dir / "harness-hg"
    _dump(root / "harness-hg" / "team.yaml", {"apiVersion": API, "kind": "AgentTeam", "name": "demo", "displayName": "Demo", "harnesses": [harness]})
    agent = {"apiVersion": API, "kind": "Agent", "harness": harness}
    if harness == "eve":
        agent["envRequires"] = ext["runtime"]["envRequires"]
    for k in ("topology", "requires", "deployment", "gitAuthSecretRef"):
        if k in ext:
            agent[k] = ext[k]
    _dump(hg / "agent.yaml", agent)
    if "backup" in ext:
        _dump(hg / "backup.yaml", {"apiVersion": API, "kind": "Backup", **ext["backup"]})
    endpoints = {"apiVersion": API, "kind": "Endpoints"}
    comm = ext.get("communication") or {}
    if "endpoints" in ext:
        endpoints["endpoints"] = ext["endpoints"]
    if "expose" in ext:
        endpoints["expose"] = ext["expose"]
    if comm.get("externalInputs"):
        endpoints["externalInputs"] = comm["externalInputs"]
    inbound = [r for r in comm.get("routes") or [] if "externalInput" in r["from"]]
    if inbound:
        endpoints["routes"] = inbound
    if len(endpoints) > 2:
        _dump(hg / "endpoints.yaml", endpoints)
    apps = []
    for app in ext.get("apps") or []:
        entry = {"name": app["name"], "agent": name, **{k: v for k, v in app.items() if k != "name"}}
        routes = [r for r in comm.get("routes") or [] if r["from"].get("app") == app["name"]]
        if routes:
            entry["routes"] = routes
        apps.append(entry)
    if apps:
        _dump(root / "harness-hg" / "apps.yaml", {"apiVersion": API, "kind": "Apps", "apps": apps})
    return agent_dir / "src"


class TestEveParity:
    def test_split_echo_renders_the_legacy_record_byte_for_byte(self, tmp_path):
        legacy_yaml = emit_cli.render_eve_record(
            agent_dir=ECHO, name=None, source=SRC, sha=SHA, ref="main", subdir="agents/echo",
        )[1]
        ext = yaml.safe_load((ECHO / "hermes-gitops.yaml").read_text())
        src = _split_legacy(ext, harness="eve", name="echo", root=tmp_path)
        shutil.copytree(ECHO, src, ignore=shutil.ignore_patterns("hermes-gitops.yaml", "hermes-gitops.test.yaml"))
        team_yaml = emit_cli.render_eve_record(
            agent_dir=src, name=None, source=SRC, sha=SHA, ref="main", subdir="agents/echo",
        )[1]
        assert team_yaml == legacy_yaml

    def test_explicit_contract_dir_and_env_var_both_find_a_separate_clone(self, tmp_path, monkeypatch):
        ext = yaml.safe_load((ECHO / "hermes-gitops.yaml").read_text())
        src = _split_legacy(ext, harness="eve", name="echo", root=tmp_path / "clone")
        payload = tmp_path / "staged" / "src"
        shutil.copytree(ECHO, payload, ignore=shutil.ignore_patterns("hermes-gitops.yaml", "hermes-gitops.test.yaml"))
        cdir = str(src.parent / "harness-hg")
        raw, agent_file = layout.load_agent_declaration(payload, cdir)
        assert raw["contractVersion"] == 5 and agent_file == pathlib.Path(cdir) / "agent.yaml"
        monkeypatch.setenv(layout.ENV_CONTRACT_DIR, cdir)
        raw2, _ = layout.load_agent_declaration(payload)
        assert raw2 == raw

    def test_a_team_subdir_payload_with_no_contract_is_refused_not_zero_apps(self, tmp_path):
        # The hook path's installed payload is named after the PROFILE, so the
        # signal is the source subdir ending in /src, not the directory name.
        payload = tmp_path / "profiles" / "echo"
        shutil.copytree(ECHO, payload, ignore=shutil.ignore_patterns("hermes-gitops.yaml", "hermes-gitops.test.yaml"))
        with pytest.raises(GitopsEmitterError, match="Refusing to emit a record with no infra intent"):
            emit_cli.render_eve_record(agent_dir=payload, name=None, source=SRC, sha=SHA, ref="main", subdir="agents/eve/echo/src")
        with pytest.raises(GitopsEmitterError, match="Refusing to emit"):
            hermes.load_extension_file(payload, None, "agents/eve/echo/src")

    def test_a_legacy_directory_that_happens_to_be_named_src_stays_legacy(self, tmp_path):
        payload = tmp_path / "src"
        payload.mkdir()
        _dump(payload / "distribution.yaml", DIST)
        assert hermes.load_extension_file(payload) is None  # no infra intent, as before
        assert hermes.load_extension_file(payload, None, "src-of-something") is None

    def test_harness_vs_path_disagreement_is_named(self, tmp_path):
        ext = yaml.safe_load((ECHO / "hermes-gitops.yaml").read_text())
        src = _split_legacy(ext, harness="eve", name="echo", root=tmp_path)
        agent = yaml.safe_load((src.parent / "harness-hg" / "agent.yaml").read_text())
        agent["harness"] = "hermes"
        agent.pop("envRequires")
        _dump(src.parent / "harness-hg" / "agent.yaml", agent)
        with pytest.raises(GitopsEmitterError, match="the path and the declaration must agree"):
            hermes.load_extension_file(src)


LayoutErrorOrEmitter = GitopsEmitterError


HERMES_V3 = {
    "contractVersion": 3,
    "apps": [
        {"name": "test-page", "chart": "cli/test-env/charts/test-page", "repo": "local",
         "topology": {"multiplicity": "per-agent", "dataBoundary": "target"},
         "outputs": [{"name": "alerts", "event": "observability.alert/v1", "subject": "groupKey",
                      "adapter": {"type": "webhook", "inject": {"appValue": {"path": "alert.webhookUrl"}}}}]},
    ],
    "expose": {"services": [{"name": "tools", "port": 8642, "path": "/"}, {"name": "hooks", "port": 8644, "path": "/"}],
               "access": {"policy": "service-token"}},
    "deployment": {"diskSizeGb": 10},
    "backup": {"schedule": "0 3 * * *", "retention": 14},
    "gitAuthSecretRef": "hermes-mgr-git-auth",
    "topology": {"supportedLayouts": ["single", "hub-spoke"], "agent": {"multiplicity": "per-region", "dataBoundary": "region"}},
    "requires": [{"capability": "content-board", "inject": {"env": "HERMES_CAP_CONTENT_BOARD_URL"}}],
    "endpoints": [{"name": "hooks", "path": "/webhooks/brief", "port": 8644, "signature": "hmac-sha256", "type": "webhook"}],
    "communication": {
        "externalInputs": [{"name": "brief", "event": "strategy.brief-updated/v1", "subject": "repository.full_name",
                            "verification": {"type": "github-hmac-sha256", "secretRef": {"name": "router-secrets", "key": "brief"}}}],
        "routes": [
            {"name": "brief-fanout", "from": {"externalInput": "brief"}, "delivery": {"mode": "queued", "guarantee": "at-least-once"},
             "outputs": [{"agent": {"profile": "mgr", "handler": "brief", "session": {"mode": "keyed", "key": "subject"}}}]},
            {"name": "page-alerts", "from": {"app": "test-page", "output": "alerts"}, "delivery": {"mode": "queued", "guarantee": "at-least-once"},
             "outputs": [{"chatops": "company_discord#sre-alerts"}]},
        ],
    },
}
DIST = {"name": "mgr", "version": "1.0.0", "env_requires": [{"name": "ANTHROPIC_API_KEY", "required": True}]}


def _render_hermes(profile_dir: pathlib.Path, contract_dir=None) -> str:
    manifest = hermes.read_target_manifest(str(profile_dir))
    env_requires = hermes._extract_env_requires(manifest)
    ext = hermes.load_extension_file(profile_dir, contract_dir) or {}
    raw_apps = ext.pop("apps", None)
    apps = resolve_apps(raw_apps, {}, persona="mgr")
    if apps:
        ext["apps"] = apps
    record = build_record("mgr", {"name": "mgr", "source_url": SRC, "sha": SHA, "subdir": "x"}, ext, env_requires=env_requires)
    validate(record)
    return render_yaml(record)


class TestHermesParity:
    def test_split_v3_profile_with_expose_renders_the_legacy_record_byte_for_byte(self, tmp_path):
        legacy = tmp_path / "legacy"
        legacy.mkdir()
        _dump(legacy / "distribution.yaml", DIST)
        _dump(legacy / "hermes-gitops.yaml", HERMES_V3)
        legacy_yaml = _render_hermes(legacy)
        assert "expose" in legacy_yaml and "8644" in legacy_yaml  # the Service ports the destination still needs

        src = _split_legacy(HERMES_V3, harness="hermes", name="mgr", root=tmp_path / "team")
        src.mkdir(parents=True)
        _dump(src / "distribution.yaml", DIST)
        raw, agent_file = layout.load_agent_declaration(src)
        assert raw["contractVersion"] == 3  # expose selects the last version that carried it
        assert _render_hermes(src) == legacy_yaml

    def test_expose_on_an_eve_agent_is_refused(self, tmp_path):
        ext = dict(yaml.safe_load((ECHO / "hermes-gitops.yaml").read_text()))
        ext["expose"] = {"services": [{"name": "x", "port": 1}]}
        src = _split_legacy(ext, harness="eve", name="echo", root=tmp_path)
        shutil.copytree(ECHO, src, ignore=shutil.ignore_patterns("hermes-gitops.yaml", "hermes-gitops.test.yaml"))
        with pytest.raises(GitopsEmitterError, match="expose is Hermes-only"):
            hermes.load_extension_file(src)


class TestDashboardCatalogue:
    def test_team_dashboard_and_icons_are_catalogued_from_harness_hg(self, tmp_path):
        ext = yaml.safe_load((ECHO / "hermes-gitops.yaml").read_text())
        src = _split_legacy(ext, harness="eve", name="echo", root=tmp_path)
        hg = src.parent / "harness-hg"
        _dump(hg / "dashboard.yaml", {
            "apiVersion": "dashboard.hermes-gitops/v1alpha2", "kind": "NexusContribution",
            "metadata": {"id": "echo", "title": "Echo"},
            "spec": {"components": [{"id": "echo", "kind": "agent", "title": "Echo", "bind": {"profile": "echo"}}]},
        })
        (hg / "icons").mkdir()
        # a 1x1 PNG: the icon gate checks the magic bytes and a size bound
        (hg / "icons" / "echo.png").write_bytes(
            b"\x89PNG\r\n\x1a\n" + bytes.fromhex(
                "0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0000000020001e221bc330000000049454e44ae426082"
            )
        )
        files = hermes._dashboard_catalogue_files("echo", src, SHA, contract_dir=hg)
        paths = [p for p, _ in files]
        assert paths == [
            "catalog/dashboard/sources/echo/dashboard.yaml",
            "catalog/dashboard/sources/echo/icons/echo.png",
            "catalog/dashboard/sources/echo/provenance.yaml",
        ]
        assert "  - harness-hg/dashboard.yaml\n  - harness-hg/icons/echo.png\n" in files[-1][1]
        # a symlinked contract dir (or anything under it) refuses, as in the legacy tree
        linked_hg = src.parent / "linked-hg"
        linked_hg.symlink_to(hg)
        with pytest.raises(GitopsEmitterError, match="symlink"):
            hermes._dashboard_catalogue_files("echo", src, SHA, contract_dir=linked_hg)
