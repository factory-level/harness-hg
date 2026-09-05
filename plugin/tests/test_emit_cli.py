"""The push-driven emit (gitops_emitter/emit_cli.py, ADR-149) against a
local bare GitOps repository: render-only, publish, idempotent re-run,
the env-based config source, the secret check, and decommission of the
published record through the unchanged decommission CLI."""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import pytest
import yaml

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from gitops_emitter import decommission_cli, emit_cli  # noqa: E402
from gitops_emitter.harness import hermes as emitter_mod  # noqa: E402
from gitops_emitter.harness.hermes import GitopsEmitterError, load_plugin_config  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
EXAMPLE = REPO_ROOT / "examples" / "eve-agent" / "agents" / "echo"
SHA = "3f06a1b2c3d4e5f60718293a4b5c6d7e8f901234"
SHA2 = "4a17b2c3d4e5f60718293a4b5c6d7e8f901234ab"
SRC = "https://github.com/factorylevel/eve-agents.git"
ARGS = ["--runtime", "eve", "--agent-dir", str(EXAMPLE), "--source", SRC, "--subdir", "agents/echo"]


@pytest.fixture()
def bare_repo(tmp_path):
    repo = tmp_path / "gitops.git"
    subprocess.run(["git", "init", "--bare", "-q", str(repo)], check=True)
    return repo


@pytest.fixture()
def env_config(bare_repo, tmp_path, monkeypatch):
    """The Eve-only host shape: no $HERMES_HOME/config.yaml, config from the
    HERMES_GITOPS_* environment contract."""
    monkeypatch.setenv("HERMES_GITOPS_CONFIG_SOURCE", "env")
    monkeypatch.setenv("HERMES_GITOPS_GITOPS_REPO_URL", f"file://{bare_repo}")
    monkeypatch.setenv("HERMES_GITOPS_GITOPS_BRANCH", "main")
    monkeypatch.setenv("HERMES_GITOPS_HERMES_GITOPS_REPO_URL", "https://example.invalid/plugin.git")
    monkeypatch.setenv("HERMES_GITOPS_CHART_REVISION", "main")
    monkeypatch.setenv("HERMES_GITOPS_GITOPS_SCAFFOLD", "false")
    monkeypatch.setenv("HERMES_GITOPS_OVERRIDES_DIR", str(tmp_path / "overrides"))
    monkeypatch.setenv("GITOPS_GIT_TOKEN", "not-needed-for-file-urls")
    monkeypatch.delenv("HERMES_GITOPS_AVAILABLE_SECRETS_JSON", raising=False)
    # Belt and braces: the Hermes config seam must never be consulted.
    monkeypatch.setattr(
        emitter_mod, "_load_hermes_config", lambda: pytest.fail("hermes_cli consulted")
    )
    return bare_repo


def _ls(bare_repo):
    out = subprocess.run(
        ["git", "--git-dir", str(bare_repo), "ls-tree", "-r", "--name-only", "main"],
        capture_output=True, text=True,
    )
    return out.stdout.split() if out.returncode == 0 else []  # no main yet = empty


def _show(bare_repo, path):
    return subprocess.run(
        ["git", "--git-dir", str(bare_repo), "show", f"main:{path}"],
        capture_output=True, text=True, check=True,
    ).stdout


def _log_count(bare_repo):
    out = subprocess.run(
        ["git", "--git-dir", str(bare_repo), "rev-list", "--count", "main"],
        capture_output=True, text=True, check=True,
    ).stdout
    return int(out.strip())


class TestConfigSources:
    def test_env_source_builds_the_same_shape_as_config_yaml(self, env_config):
        cfg = load_plugin_config()
        assert cfg["repo_url"].startswith("file://")
        assert cfg["mode"] == "direct"
        assert cfg["scaffold"] is False
        assert cfg["profiles_path"] == "profiles"

    def test_json_source(self, tmp_path, monkeypatch):
        p = tmp_path / "cfg.json"
        p.write_text(json.dumps({"repo_url": "https://example.invalid/g.git", "mode": "pr"}))
        monkeypatch.setenv("HERMES_GITOPS_CONFIG_JSON", str(p))
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: pytest.fail("hermes_cli consulted")
        )
        cfg = load_plugin_config()
        assert cfg["mode"] == "pr" and cfg["pr_auto_merge"] is True

    def test_env_source_missing_required_fails_loudly(self, monkeypatch):
        monkeypatch.setenv("HERMES_GITOPS_CONFIG_SOURCE", "env")
        monkeypatch.delenv("HERMES_GITOPS_GITOPS_REPO_URL", raising=False)
        with pytest.raises(GitopsEmitterError, match="HERMES_GITOPS_GITOPS_REPO_URL"):
            load_plugin_config()

    def test_unrecognized_source_never_falls_through_to_hermes(self, monkeypatch):
        monkeypatch.setenv("HERMES_GITOPS_CONFIG_SOURCE", "ENV")
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: pytest.fail("hermes_cli consulted")
        )
        with pytest.raises(GitopsEmitterError, match="not a recognized config source"):
            load_plugin_config()

    def test_no_hermes_installed_is_a_named_error(self, monkeypatch):
        monkeypatch.delenv("HERMES_GITOPS_CONFIG_SOURCE", raising=False)
        monkeypatch.delenv("HERMES_GITOPS_CONFIG_JSON", raising=False)

        def _no_hermes():
            raise ImportError("No module named 'hermes_cli'")

        monkeypatch.setattr(emitter_mod, "_load_hermes_config", _no_hermes)
        with pytest.raises(GitopsEmitterError, match="HERMES_GITOPS_CONFIG_SOURCE=env"):
            load_plugin_config()


class TestRenderOnly:
    def test_prints_the_record_and_touches_nothing(self, capsys, env_config):
        rc = emit_cli.main(ARGS + ["--sha", SHA, "--ref", "main", "--render-only"])
        assert rc == 0
        doc = yaml.safe_load(capsys.readouterr().out)
        assert doc["spec"]["persona"] == "echo"
        assert doc["spec"]["runtime"] == "eve"
        assert doc["spec"]["sha"] == SHA
        assert doc["spec"]["sourceSubdir"] == "agents/echo"
        assert _ls(env_config) == []

    def test_short_sha_is_refused_without_echoing_it(self, capsys, env_config):
        rc = emit_cli.main(ARGS + ["--sha", "ghp_notasha", "--render-only"])
        assert rc == 1
        err = capsys.readouterr().err
        assert "40-character" in err and "ghp_notasha" not in err

    def test_platform_pin_mismatch_fails_at_emit_time(self, capsys, env_config):
        rc = emit_cli.main(ARGS + ["--sha", SHA, "--expect-eve-version", "9.9.9", "--render-only"])
        assert rc == 1
        assert "eve@9.9.9" in capsys.readouterr().err

    def test_platform_pin_match_passes(self, capsys, env_config):
        lock = json.loads((EXAMPLE / "package-lock.json").read_text())
        pin = lock["packages"]["node_modules/eve"]["version"]
        assert emit_cli.main(ARGS + ["--sha", SHA, "--expect-eve-version", pin, "--render-only"]) == 0

    def test_unexpected_exceptions_are_withheld(self, capsys, env_config, monkeypatch):
        def _boom(*_a, **_k):
            raise RuntimeError("token=ghp_secret /tmp/xyz")

        monkeypatch.setattr(emit_cli, "read_eve_manifest", _boom)
        rc = emit_cli.main(ARGS + ["--sha", SHA, "--render-only"])
        assert rc == 1
        err = capsys.readouterr().err
        assert "RuntimeError" in err and "ghp_secret" not in err

    def test_name_mismatch_is_refused(self, capsys, env_config):
        rc = emit_cli.main(ARGS + ["--sha", SHA, "--name", "support", "--render-only"])
        assert rc == 1
        assert "package.json name" in capsys.readouterr().err

    def test_render_only_needs_no_config_at_all(self, capsys, monkeypatch):
        # hg validate runs this on a developer machine with no GitOps
        # configuration: nothing may be consulted but the project.
        for var in list(emitter_mod.os.environ):
            if var.startswith("HERMES_GITOPS_") or var == "GITOPS_GIT_TOKEN":
                monkeypatch.delenv(var, raising=False)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: pytest.fail("config consulted")
        )
        assert emit_cli.main(ARGS + ["--sha", SHA, "--render-only"]) == 0
        assert yaml.safe_load(capsys.readouterr().out)["spec"]["persona"] == "echo"

    def test_app_values_must_be_a_json_object(self, capsys, env_config):
        rc = emit_cli.main(ARGS + ["--sha", SHA, "--app-values", "[1]", "--render-only"])
        assert rc == 1
        assert "JSON object" in capsys.readouterr().err
        rc = emit_cli.main(ARGS + ["--sha", SHA, "--app-values", "{nope", "--render-only"])
        assert rc == 1
        assert "not valid JSON" in capsys.readouterr().err

    def test_app_values_for_undeclared_apps_are_ignored(self, capsys, env_config):
        # Fleet-default appValues are one file shared across personas: a
        # fragment for an app this project does not declare changes nothing.
        assert emit_cli.main(ARGS + ["--sha", SHA, "--render-only"]) == 0
        plain = capsys.readouterr().out
        rc = emit_cli.main(
            ARGS + ["--sha", SHA, "--app-values", '{"other": {"x": 1}}', "--render-only"]
        )
        assert rc == 0
        assert capsys.readouterr().out == plain


class TestPublish:
    def test_publish_then_rerun_is_a_no_op_then_update(self, capsys, env_config):
        assert emit_cli.main(ARGS + ["--sha", SHA, "--ref", "main"]) == 0
        files = _ls(env_config)
        assert "profiles/echo/profile.yaml" in files
        assert "catalog/profiles/echo/contract.yaml" in files
        assert "catalog/profiles/echo/provenance.yaml" in files
        assert _show(env_config, "catalog/profiles/echo/contract.yaml") == (
            EXAMPLE / "hermes-gitops.yaml"
        ).read_text()
        assert _show(env_config, "catalog/profiles/echo/provenance.yaml") == (
            f'profile: echo\nsourceSha: "{SHA}"\nruntime: eve\n'
        )
        record = yaml.safe_load(_show(env_config, "profiles/echo/profile.yaml"))
        assert record["spec"]["runtime"] == "eve"
        assert record["spec"]["sha"] == SHA
        n = _log_count(env_config)

        # same inputs -> byte-identical -> no commit
        assert emit_cli.main(ARGS + ["--sha", SHA, "--ref", "main", "--event", "update"]) == 0
        assert "already up to date" in capsys.readouterr().out
        assert _log_count(env_config) == n

        # a new sha -> one more commit, record updated
        assert emit_cli.main(ARGS + ["--sha", SHA2, "--ref", "main", "--event", "update"]) == 0
        assert _log_count(env_config) == n + 1
        assert yaml.safe_load(_show(env_config, "profiles/echo/profile.yaml"))["spec"]["sha"] == SHA2

    def test_required_secret_check_applies(self, capsys, env_config, monkeypatch):
        monkeypatch.setenv("HERMES_GITOPS_AVAILABLE_SECRETS_JSON", json.dumps({"echo": []}))
        rc = emit_cli.main(ARGS + ["--sha", SHA])
        assert rc == 1
        err = capsys.readouterr().err
        assert "ANTHROPIC_API_KEY" in err and "pulumi config set" in err
        assert _ls(env_config) == []

    def test_required_secret_present_publishes(self, env_config, monkeypatch):
        monkeypatch.setenv(
            "HERMES_GITOPS_AVAILABLE_SECRETS_JSON", json.dumps({"echo": ["ANTHROPIC_API_KEY"]})
        )
        assert emit_cli.main(ARGS + ["--sha", SHA]) == 0
        assert "profiles/echo/profile.yaml" in _ls(env_config)

    def test_decommission_removes_an_eve_record(self, env_config):
        assert emit_cli.main(ARGS + ["--sha", SHA]) == 0
        assert decommission_cli.main(["echo"]) == 0
        assert "profiles/echo/profile.yaml" not in _ls(env_config)

    def test_decommission_by_source_and_subdir_disambiguates_a_monorepo(self, env_config, tmp_path):
        # Two agents from ONE source repo, told apart by subdir - the shape
        # the EveAgents component decommissions by when no name is declared.
        import shutil

        sibling = tmp_path / "agents" / "ping"
        shutil.copytree(EXAMPLE, sibling)
        pkg = json.loads((sibling / "package.json").read_text())
        pkg["name"] = "ping"
        (sibling / "package.json").write_text(json.dumps(pkg))
        assert emit_cli.main(ARGS + ["--sha", SHA]) == 0
        assert emit_cli.main(
            ["--runtime", "eve", "--agent-dir", str(sibling), "--source", SRC,
             "--subdir", "agents/ping", "--sha", SHA]
        ) == 0
        assert {"profiles/echo/profile.yaml", "profiles/ping/profile.yaml"} <= set(_ls(env_config))
        # source alone is ambiguous and says so
        assert decommission_cli.main(["--source", SRC]) == 1
        # source + subdir is exact
        assert decommission_cli.main(["--source", SRC, "--subdir", "agents/ping"]) == 0
        files = _ls(env_config)
        assert "profiles/ping/profile.yaml" not in files
        assert "profiles/echo/profile.yaml" in files
