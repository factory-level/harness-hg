"""Tests for gitops_emitter.harness.hermes — config loading, override chain, and
the full install/update pipeline (config -> manifest -> merge -> render ->
scaffold -> publish), against real local bare-repo fixtures with every
``hermes_cli`` touchpoint monkeypatched (that package isn't importable in
this repo's test env — see gitops_emitter/README.md).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import jsonschema
import pytest
import yaml

import gitops_emitter
import gitops_emitter.harness.hermes as emitter_mod
from gitops_emitter.harness.hermes import (
    GitopsEmitterError,
    _extract_env_requires,
    required_secret_names,
    emit,
    load_defaults,
    load_instance_overrides,
    load_plugin_config,
    read_git_token,
    read_target_manifest,
)

def _schema() -> dict:
    """The schema the EMITTER validates against, not a copy of it.

    This used to hardcode a version directory and had been left on
    `v1alpha1` through the v1alpha2 bump - so these tests were checking
    published records against a contract two versions out of date, and
    would have kept passing while production rejected the same record.
    Borrowing `render`'s own loader makes that impossible.
    """
    from gitops_emitter.render import _load_schema

    return _load_schema()


# ---------------------------------------------------------------------------
# load_plugin_config
# ---------------------------------------------------------------------------


class TestLoadPluginConfig:
    def _hermes_cfg(self, entry: dict) -> dict:
        return {"plugins": {"enabled": ["gitops-emitter"], "entries": {"gitops-emitter": entry}}}

    def test_missing_repo_url_raises(self, monkeypatch):
        monkeypatch.setattr(emitter_mod, "_load_hermes_config", lambda: self._hermes_cfg({}))
        with pytest.raises(GitopsEmitterError, match="repo_url"):
            load_plugin_config()

    def test_missing_plugins_block_entirely_raises(self, monkeypatch):
        monkeypatch.setattr(emitter_mod, "_load_hermes_config", lambda: {})
        with pytest.raises(GitopsEmitterError, match="repo_url"):
            load_plugin_config()

    def test_entry_not_a_mapping_raises(self, monkeypatch):
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: {"plugins": {"entries": {"gitops-emitter": "not-a-dict"}}},
        )
        with pytest.raises(GitopsEmitterError, match="mapping"):
            load_plugin_config()

    def test_full_config_round_trips(self, monkeypatch):
        entry = {
            "repo_url": "https://github.com/factory-level/gitops-fleet",
            "branch": "release",
            "profiles_path": "/agents/",
            "defaults_file": "/tmp/defaults.yaml",
            "overrides_dir": "/tmp/overrides",
            "git_author_name": "custom-bot",
            "git_author_email": "custom@example.dev",
            "scaffold": False,
            "hermes_gitops_repo_url": "https://github.com/factory-level/harness-hg",
            "chart_revision": "v1.0.0",
            "image_repository": "ghcr.io/example/agent",
            "image_tag": "v9",
        }
        monkeypatch.setattr(emitter_mod, "_load_hermes_config", lambda: self._hermes_cfg(entry))
        cfg = load_plugin_config()
        assert cfg["repo_url"] == entry["repo_url"]
        assert cfg["branch"] == "release"
        assert cfg["profiles_path"] == "agents"  # leading/trailing slashes stripped
        assert cfg["scaffold"] is False
        assert cfg["chart_revision"] == "v1.0.0"
        assert cfg["image_repository"] == "ghcr.io/example/agent"

    def test_defaults_applied_for_omitted_fields(self, monkeypatch):
        entry = {"repo_url": "https://github.com/factory-level/gitops-fleet"}
        monkeypatch.setattr(emitter_mod, "_load_hermes_config", lambda: self._hermes_cfg(entry))
        cfg = load_plugin_config()
        assert cfg["branch"] == "main"
        assert cfg["profiles_path"] == "profiles"
        assert cfg["scaffold"] is True
        assert cfg["git_author_name"] == "hermes-gitops-bot"
        assert cfg["git_author_email"] == "hg-bot@users.noreply.github.com"
        assert cfg["chart_revision"] == "main"


# ---------------------------------------------------------------------------
# load_defaults
# ---------------------------------------------------------------------------


class TestLoadDefaults:
    def test_missing_file_returns_empty_dict(self, tmp_path):
        cfg = {"defaults_file": str(tmp_path / "does-not-exist.yaml")}
        assert load_defaults(cfg) == {}

    def test_valid_yaml_loaded(self, tmp_path):
        path = tmp_path / "defaults.yaml"
        path.write_text("deployment:\n  region: us-west1\n", encoding="utf-8")
        cfg = {"defaults_file": str(path)}
        assert load_defaults(cfg) == {"deployment": {"region": "us-west1"}}

    def test_empty_file_returns_empty_dict(self, tmp_path):
        path = tmp_path / "defaults.yaml"
        path.write_text("", encoding="utf-8")
        cfg = {"defaults_file": str(path)}
        assert load_defaults(cfg) == {}

    def test_malformed_yaml_raises(self, tmp_path):
        path = tmp_path / "defaults.yaml"
        path.write_text("deployment: [unterminated\n", encoding="utf-8")
        cfg = {"defaults_file": str(path)}
        with pytest.raises(GitopsEmitterError):
            load_defaults(cfg)

    def test_non_mapping_yaml_raises(self, tmp_path):
        path = tmp_path / "defaults.yaml"
        path.write_text("- a\n- b\n", encoding="utf-8")
        cfg = {"defaults_file": str(path)}
        with pytest.raises(GitopsEmitterError, match="mapping"):
            load_defaults(cfg)

    def test_expanduser_applied(self, monkeypatch, tmp_path):
        monkeypatch.setenv("HOME", str(tmp_path))
        (tmp_path / ".hermes-defaults.yaml").write_text("deployment: {}\n", encoding="utf-8")
        cfg = {"defaults_file": "~/.hermes-defaults.yaml"}
        assert load_defaults(cfg) == {"deployment": {}}


# ---------------------------------------------------------------------------
# load_instance_overrides
# ---------------------------------------------------------------------------


class TestLoadInstanceOverrides:
    def test_no_env_no_persisted_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        cfg = {"overrides_dir": str(tmp_path / "overrides")}
        assert load_instance_overrides("support-agent", cfg) == {}

    def test_env_var_loads_and_persists_copy(self, tmp_path, monkeypatch):
        overrides_src = tmp_path / "instance-overrides.yaml"
        overrides_src.write_text("deployment:\n  diskSizeGb: 200\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(overrides_src))

        overrides_dir = tmp_path / "overrides"
        cfg = {"overrides_dir": str(overrides_dir)}

        result = load_instance_overrides("support-agent", cfg)
        assert result == {"deployment": {"diskSizeGb": 200}}

        persisted = overrides_dir / "support-agent.yaml"
        assert persisted.is_file()
        text = persisted.read_text(encoding="utf-8")
        # The CONTENT round-trips byte-identically; the copy additionally
        # carries a provenance stamp (ADR-4, #180) so a later read can
        # tell a cache the tooling wrote from a hand-authored second
        # authority. The stamp is a comment, so the parsed data is
        # unchanged.
        assert text.endswith(overrides_src.read_text(encoding="utf-8"))
        assert "# gitops-emitter:written-by pulumi" in text
        import yaml as _yaml

        assert _yaml.safe_load(text) == {"deployment": {"diskSizeGb": 200}}

    def test_persisted_copy_reused_when_env_unset(self, tmp_path, monkeypatch):
        from gitops_emitter.harness.hermes import _provenance_header

        overrides_dir = tmp_path / "overrides"
        overrides_dir.mkdir()
        (overrides_dir / "support-agent.yaml").write_text(
            _provenance_header("pulumi") + "deployment:\n  diskSizeGb: 300\n",
            encoding="utf-8",
        )
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)

        cfg = {"overrides_dir": str(overrides_dir)}
        result = load_instance_overrides("support-agent", cfg)
        assert result == {"deployment": {"diskSizeGb": 300}}

    def test_env_set_then_unset_round_trip(self, tmp_path, monkeypatch):
        overrides_src = tmp_path / "instance-overrides.yaml"
        overrides_src.write_text("reach:\n  regions: [us-west]\n", encoding="utf-8")
        overrides_dir = tmp_path / "overrides"
        cfg = {"overrides_dir": str(overrides_dir)}

        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(overrides_src))
        first = load_instance_overrides("support-agent", cfg)

        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES")
        second = load_instance_overrides("support-agent", cfg)

        assert first == second == {"reach": {"regions": ["us-west"]}}

    def test_different_instances_get_separate_persisted_files(self, tmp_path, monkeypatch):
        overrides_dir = tmp_path / "overrides"
        src_a = tmp_path / "a.yaml"
        src_a.write_text("deployment:\n  region: us-west1\n", encoding="utf-8")
        cfg = {"overrides_dir": str(overrides_dir)}

        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(src_a))
        load_instance_overrides("agent-a", cfg)

        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES")
        assert load_instance_overrides("agent-b", cfg) == {}
        assert load_instance_overrides("agent-a", cfg) == {"deployment": {"region": "us-west1"}}

    def test_malformed_env_overrides_file_raises(self, tmp_path, monkeypatch):
        overrides_src = tmp_path / "bad.yaml"
        overrides_src.write_text("deployment: [unterminated\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(overrides_src))
        cfg = {"overrides_dir": str(tmp_path / "overrides")}
        with pytest.raises(GitopsEmitterError):
            load_instance_overrides("support-agent", cfg)

    def test_missing_env_overrides_file_raises(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(tmp_path / "does-not-exist.yaml"))
        cfg = {"overrides_dir": str(tmp_path / "overrides")}
        with pytest.raises(GitopsEmitterError):
            load_instance_overrides("support-agent", cfg)


# ---------------------------------------------------------------------------
# read_target_manifest / _extract_env_requires
# ---------------------------------------------------------------------------


class TestReadTargetManifest:
    def test_reads_valid_manifest(self, tmp_path):
        (tmp_path / "distribution.yaml").write_text(
            "name: support-agent\nversion: 1.3.0\n", encoding="utf-8"
        )
        manifest = read_target_manifest(str(tmp_path))
        assert manifest["name"] == "support-agent"

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(GitopsEmitterError):
            read_target_manifest(str(tmp_path))

    def test_malformed_yaml_raises(self, tmp_path):
        (tmp_path / "distribution.yaml").write_text("name: [unterminated\n", encoding="utf-8")
        with pytest.raises(GitopsEmitterError):
            read_target_manifest(str(tmp_path))

    def test_non_mapping_raises(self, tmp_path):
        (tmp_path / "distribution.yaml").write_text("- a\n- b\n", encoding="utf-8")
        with pytest.raises(GitopsEmitterError, match="mapping"):
            read_target_manifest(str(tmp_path))


class TestExtractEnvRequires:
    """#141: a declaration carries its metadata.

    `distribution.yaml` declares each variable with a description and a
    `required` flag; the record used to store a flat array of names, so
    optionality, purpose and the secret-versus-config distinction were all
    discarded at the one point they could have been written down.
    """

    def _names(self, manifest):
        return [e["name"] for e in _extract_env_requires(manifest)]

    def test_a_bare_name_resolves_to_required_and_secret(self):
        # The conservative default in both directions: an entry that says
        # nothing is mandatory, and an unclassified value is a credential.
        assert _extract_env_requires({"env_requires": ["OPENAI_API_KEY"]}) == [
            {"name": "OPENAI_API_KEY", "required": True, "secret": True}
        ]

    def test_metadata_survives(self):
        manifest = {
            "env_requires": [
                {
                    "name": "GRAPHITI_MCP_URL",
                    "description": "Memory service base URL",
                    "required": False,
                    "secret": False,
                }
            ]
        }
        assert _extract_env_requires(manifest) == [
            {
                "name": "GRAPHITI_MCP_URL",
                "required": False,
                "secret": False,
                "description": "Memory service base URL",
            }
        ]

    def test_an_absent_description_is_omitted_rather_than_invented(self):
        entry = _extract_env_requires({"env_requires": [{"name": "X_KEY"}]})[0]
        assert "description" not in entry

    def test_a_blank_description_counts_as_absent(self):
        entry = _extract_env_requires({"env_requires": [{"name": "X_KEY", "description": "   "}]})[0]
        assert "description" not in entry

    def test_required_absent_means_required(self):
        # Matches the fork's own EnvRequirement default. Flipping this
        # would turn every existing declaration optional at once.
        assert _extract_env_requires({"env_requires": [{"name": "X_KEY"}]})[0]["required"] is True

    def test_secret_absent_means_secret(self):
        # distribution.yaml has no `secret` field today, so EVERY existing
        # declaration resolves this way. The direction matters: treating a
        # setting as a secret costs an ExternalSecret; treating a secret as
        # config puts its value in a rendered manifest.
        assert _extract_env_requires({"env_requires": [{"name": "X_KEY"}]})[0]["secret"] is True

    def test_mixed_list_shape(self):
        assert self._names(
            {"env_requires": ["OPENAI_API_KEY", {"name": "DISCORD_BOT_TOKEN"}]}
        ) == ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"]

    def test_missing_key_returns_empty(self):
        assert _extract_env_requires({}) == []

    def test_object_entry_missing_name_raises(self):
        with pytest.raises(GitopsEmitterError):
            _extract_env_requires({"env_requires": [{"required": True}]})

    def test_non_list_raises(self):
        with pytest.raises(GitopsEmitterError):
            _extract_env_requires({"env_requires": "OPENAI_API_KEY"})

    def test_invalid_entry_type_raises(self):
        with pytest.raises(GitopsEmitterError):
            _extract_env_requires({"env_requires": [123]})


class TestRequiredSecretNames:
    """Which declarations can fail an install for being unset."""

    def test_only_required_AND_secret(self):
        entries = _extract_env_requires(
            {
                "env_requires": [
                    {"name": "MUST_HAVE"},
                    {"name": "OPTIONAL_KEY", "required": False},
                    # New with #141: a required piece of CONFIGURATION is
                    # not a secret, and has no business in the fail-loud
                    # secret check. Before the flag existed this variable
                    # would have blocked an install for not being in the
                    # stack's secret map.
                    {"name": "PUBLIC_URL", "required": True, "secret": False},
                ]
            }
        )
        assert required_secret_names(entries) == ["MUST_HAVE"]

    def test_an_optional_secret_never_blocks_an_install(self):
        entries = _extract_env_requires({"env_requires": [{"name": "NICE_TO_HAVE", "required": False}]})
        assert required_secret_names(entries) == []


# ---------------------------------------------------------------------------
# read_git_token
# ---------------------------------------------------------------------------


class TestReadGitToken:
    def test_token_from_dotenv_file(self, tmp_path):
        (tmp_path / ".env").write_text("GITOPS_GIT_TOKEN=abc123\n", encoding="utf-8")
        assert read_git_token(str(tmp_path)) == "abc123"

    def test_token_from_process_env_when_no_dotenv(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GITOPS_GIT_TOKEN", "envtoken456")
        assert read_git_token(str(tmp_path)) == "envtoken456"

    def test_dotenv_takes_precedence_over_process_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GITOPS_GIT_TOKEN", "envtoken456")
        (tmp_path / ".env").write_text("GITOPS_GIT_TOKEN=dotenvtoken\n", encoding="utf-8")
        assert read_git_token(str(tmp_path)) == "dotenvtoken"

    def test_missing_everywhere_raises(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GITOPS_GIT_TOKEN", raising=False)
        with pytest.raises(GitopsEmitterError, match="GITOPS_GIT_TOKEN"):
            read_git_token(str(tmp_path))

    def test_empty_value_in_dotenv_falls_back_or_raises(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GITOPS_GIT_TOKEN", raising=False)
        (tmp_path / ".env").write_text("GITOPS_GIT_TOKEN=\n", encoding="utf-8")
        with pytest.raises(GitopsEmitterError):
            read_git_token(str(tmp_path))

    def test_error_message_never_contains_a_real_token_value(self, tmp_path, monkeypatch):
        # Missing-token error can't leak a token it never had — this just
        # locks in that the message text doesn't echo back GITOPS_GIT_TOKEN
        # in a way that could be confused with a value.
        monkeypatch.delenv("GITOPS_GIT_TOKEN", raising=False)
        with pytest.raises(GitopsEmitterError) as excinfo:
            read_git_token(str(tmp_path))
        assert "=" not in str(excinfo.value)


# ---------------------------------------------------------------------------
# emit() — full pipeline against real bare-repo fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def bare_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "gitops.git"
    subprocess.run(["git", "init", "--bare", "-q", str(repo)], check=True)
    return repo


def _file_url(path: Path) -> str:
    return f"file://{path}"


def _show(bare_repo: Path, rel_path: str, branch: str = "main") -> str:
    result = subprocess.run(
        ["git", "show", f"{branch}:{rel_path}"],
        cwd=bare_repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _show_bytes(bare_repo: Path, rel_path: str, branch: str = "main") -> bytes:
    # text=True would mangle (or crash on) binary blobs like icon assets.
    result = subprocess.run(
        ["git", "show", f"{branch}:{rel_path}"],
        cwd=bare_repo,
        capture_output=True,
        check=True,
    )
    return result.stdout


def _log(bare_repo: Path, branch: str = "main") -> str:
    result = subprocess.run(
        ["git", "log", branch, "--format=%H"],
        cwd=bare_repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


# distribution.yaml stays PURE Hermes — no extension blocks; the plugin
# only reads env_requires from it.
DISTRIBUTION_YAML = """\
name: support-agent
version: 1.3.0
env_requires:
  - name: DISCORD_BOT_TOKEN
    description: "Discord bot token"
    required: true
"""

# hermes-gitops.yaml, BESIDE distribution.yaml — the ONE carrier of the
# profile's infra intent (apps/deployment/expose/backup/gitAuthSecretRef).
HERMES_GITOPS_YAML = """\
apps:
  - name: vector-db
    chart: qdrant
    repo: https://qdrant.github.io/qdrant-helm
    version: 1.9.1
    values:
      replicas: 1
  - name: docs-site
    chart: charts/test-page
    repo: local
deployment:
  baseImageTag: hermes-base-2026-07
  diskSizeGb: 100
expose:
  services:
    - name: tools
      port: 8080
      path: /
  access:
    policy: service-token
"""


def _target_dir(
    tmp_path: Path,
    token: str = "gh_fake_token_value",
    extension: str | None = HERMES_GITOPS_YAML,
) -> Path:
    target = tmp_path / "profile"
    target.mkdir(parents=True)
    (target / "distribution.yaml").write_text(DISTRIBUTION_YAML, encoding="utf-8")
    if extension is not None:
        (target / "hermes-gitops.yaml").write_text(extension, encoding="utf-8")
    (target / ".env").write_text(f"GITOPS_GIT_TOKEN={token}\n", encoding="utf-8")
    return target


def _hook_kwargs(target_dir: Path, event: str = "install", **overrides) -> dict:
    payload = {
        "name": "support-agent",
        "source_url": "github.com/factorylevel/support-agent",
        "ref": "v1.3.0",
        "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        "distribution_version": "1.3.0",
        "target_dir": str(target_dir),
        "event": event,
    }
    payload.update(overrides)
    return payload


def _fake_hermes_config(repo_url: str, **entry_overrides) -> dict:
    entry = {
        "repo_url": repo_url,
        "branch": "main",
        "git_author_name": "hermes-gitops-bot",
        "git_author_email": "hg-bot@users.noreply.github.com",
        "scaffold": False,
    }
    entry.update(entry_overrides)
    return {"plugins": {"enabled": ["gitops-emitter"], "entries": {"gitops-emitter": entry}}}


class TestExtensionFile:
    """hermes-gitops.yaml BESIDE distribution.yaml — the ONLY carrier of a
    profile's infra intent. Missing file => None (no infra intent, NOT an
    error); unknown keys fail loudly; distribution.yaml's embedded blocks
    are never read (the old fallback chain is gone)."""

    def _write_extension(self, root, content):
        root.mkdir(parents=True, exist_ok=True)
        (root / "hermes-gitops.yaml").write_text(content, encoding="utf-8")

    def test_reads_the_file_beside_the_manifest(self, tmp_path):
        target = tmp_path / "profile"
        target.mkdir()
        (target / "distribution.yaml").write_text(
            "name: x\nversion: 0.1.0\n", encoding="utf-8"
        )
        self._write_extension(target, "deployment:\n  diskSizeGb: 20\n")
        assert emitter_mod.load_extension_file(target) == {
            "deployment": {"diskSizeGb": 20}
        }

    def test_missing_file_returns_none(self, tmp_path):
        target = tmp_path / "profile"
        target.mkdir()
        assert emitter_mod.load_extension_file(target) is None

    def test_embedded_distribution_blocks_are_ignored(self, tmp_path):
        # A distribution.yaml still carrying legacy embedded extension
        # blocks contributes NOTHING — hermes-gitops.yaml is the only
        # carrier, and here there is no such file.
        target = tmp_path / "profile"
        target.mkdir()
        (target / "distribution.yaml").write_text(
            "name: x\nversion: 0.1.0\ndeployment:\n  diskSizeGb: 99\n",
            encoding="utf-8",
        )
        assert emitter_mod.load_extension_file(target) is None

    def test_unknown_key_fails_naming_it(self, tmp_path):
        src = tmp_path / "repo"
        src.mkdir()
        self._write_extension(src, "deplyoment:\n  diskSizeGb: 20\n")
        with pytest.raises(GitopsEmitterError, match=r"deplyoment.*allowed:"):
            emitter_mod.load_extension_file(src)

    def test_legacy_keys_fail_loudly(self, tmp_path):
        # The removed keys (workloads/reach/targetCluster) are unknown now.
        src = tmp_path / "repo"
        src.mkdir()
        self._write_extension(
            src, "workloads:\n  - name: test-page\n    default: true\n"
        )
        with pytest.raises(GitopsEmitterError, match=r"workloads.*allowed:"):
            emitter_mod.load_extension_file(src)

    def test_apps_block_is_allowed(self, tmp_path):
        src = tmp_path / "repo"
        src.mkdir()
        self._write_extension(src, HERMES_GITOPS_YAML)
        extension = emitter_mod.load_extension_file(src)
        assert [a["name"] for a in extension["apps"]] == ["vector-db", "docs-site"]


class TestEmitFullPipeline:
    def test_install_pushes_valid_record_to_bare_repo(self, tmp_path, bare_repo, monkeypatch):
        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )

        sha = emit(_hook_kwargs(target_dir))
        assert sha and len(sha) == 40

        text = _show(bare_repo, "profiles/support-agent/profile.yaml")
        record = yaml.safe_load(text)
        jsonschema.validate(instance=record, schema=_schema())
        assert list(record.keys()) == ["spec"]
        # spec.apps carries the resolved apps, in author order.
        assert [a["name"] for a in record["spec"]["apps"]] == ["vector-db", "docs-site"]
        assert record["spec"]["apps"][0]["version"] == "1.9.1"
        assert "version" not in record["spec"]["apps"][1]  # local app
        assert "workloads" not in record["spec"]

    def test_defaults_and_overrides_are_merged_and_applied(self, tmp_path, bare_repo, monkeypatch):
        # A deliberately sparse hermes-gitops.yaml (only `baseImageTag` in
        # its deployment block) so each of the three merge layers
        # contributes a distinct, individually-checkable field: defaults
        # sets diskSizeGb (50), the extension sets baseImageTag, and the
        # instance override wins on diskSizeGb (250).
        target_dir = tmp_path / "profile"
        target_dir.mkdir()
        (target_dir / "distribution.yaml").write_text(
            "name: support-agent\nversion: 1.3.0\n", encoding="utf-8"
        )
        (target_dir / "hermes-gitops.yaml").write_text(
            "deployment:\n  baseImageTag: hermes-base-2026-07\n", encoding="utf-8"
        )
        (target_dir / ".env").write_text("GITOPS_GIT_TOKEN=gh_fake_token_value\n", encoding="utf-8")

        defaults_file = tmp_path / "defaults.yaml"
        defaults_file.write_text(
            "deployment:\n  diskSizeGb: 50\n", encoding="utf-8"
        )

        overrides_src = tmp_path / "instance-overrides.yaml"
        overrides_src.write_text("deployment:\n  diskSizeGb: 250\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(overrides_src))

        overrides_dir = tmp_path / "overrides"
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(
                _file_url(bare_repo),
                defaults_file=str(defaults_file),
                overrides_dir=str(overrides_dir),
            ),
        )

        emit(_hook_kwargs(target_dir))

        record = yaml.safe_load(_show(bare_repo, "profiles/support-agent/profile.yaml"))
        # baseImageTag: only hermes-gitops.yaml sets it.
        assert record["spec"]["deployment"]["baseImageTag"] == "hermes-base-2026-07"
        # diskSizeGb: both defaults (50) and the instance override (250)
        # set it — the override, applied last, must win.
        assert record["spec"]["deployment"]["diskSizeGb"] == 250

        # And it must have been persisted for reuse when the env var is unset.
        assert (overrides_dir / "support-agent.yaml").is_file()

    def test_persisted_overrides_reused_on_second_install_without_env(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = _target_dir(tmp_path)
        overrides_src = tmp_path / "instance-overrides.yaml"
        overrides_src.write_text("deployment:\n  diskSizeGb: 250\n", encoding="utf-8")
        overrides_dir = tmp_path / "overrides"

        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(_file_url(bare_repo), overrides_dir=str(overrides_dir)),
        )

        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(overrides_src))
        emit(_hook_kwargs(target_dir))

        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES")
        # A second, distinct target_dir (fresh re-install elsewhere) with no
        # env var set must still pick up the persisted override.
        target_dir_2 = _target_dir(tmp_path / "second")
        emit(_hook_kwargs(target_dir_2))

        record = yaml.safe_load(_show(bare_repo, "profiles/support-agent/profile.yaml"))
        assert record["spec"]["deployment"]["diskSizeGb"] == 250

    def test_app_values_override_merges_into_app_values(self, tmp_path, bare_repo, monkeypatch):
        # Per-instance overrides carry `appValues: {<appName>: fragment}`;
        # the fragment deep-merges into that app's values in the record.
        target_dir = _target_dir(tmp_path)
        overrides_src = tmp_path / "instance-overrides.yaml"
        overrides_src.write_text(
            "appValues:\n  vector-db:\n    auth:\n      apiKeySecretRef: my-secret\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(overrides_src))

        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(_file_url(bare_repo), overrides_dir=str(tmp_path / "overrides")),
        )

        emit(_hook_kwargs(target_dir))
        record = yaml.safe_load(_show(bare_repo, "profiles/support-agent/profile.yaml"))
        vector_db = record["spec"]["apps"][0]
        assert vector_db["name"] == "vector-db"
        # Author value preserved, override fragment merged in.
        assert vector_db["values"]["replicas"] == 1
        assert vector_db["values"]["auth"]["apiKeySecretRef"] == "my-secret"

    def test_fleet_default_app_values_apply_and_instance_wins(self, tmp_path, bare_repo, monkeypatch):
        target_dir = _target_dir(tmp_path)
        defaults_file = tmp_path / "defaults.yaml"
        defaults_file.write_text(
            "appValues:\n  vector-db:\n    replicas: 5\n    auth:\n      mode: token\n",
            encoding="utf-8",
        )
        overrides_src = tmp_path / "instance-overrides.yaml"
        overrides_src.write_text(
            "appValues:\n  vector-db:\n    replicas: 9\n", encoding="utf-8"
        )
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(overrides_src))
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(
                _file_url(bare_repo),
                defaults_file=str(defaults_file),
                overrides_dir=str(tmp_path / "overrides"),
            ),
        )

        emit(_hook_kwargs(target_dir))
        record = yaml.safe_load(_show(bare_repo, "profiles/support-agent/profile.yaml"))
        vector_db = record["spec"]["apps"][0]
        # instance override (9) beats fleet default (5) beats author (1).
        assert vector_db["values"]["replicas"] == 9
        # fleet-default fragment key survives the chain.
        assert vector_db["values"]["auth"]["mode"] == "token"

    def test_unsatisfied_values_required_fails_before_any_push(self, tmp_path, bare_repo, monkeypatch):
        extension = """\
apps:
  - name: vector-db
    chart: qdrant
    repo: https://qdrant.github.io/qdrant-helm
    version: 1.9.1
    valuesRequired:
      - auth.apiKeySecretRef
"""
        target_dir = _target_dir(tmp_path, extension=extension)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )

        with pytest.raises(GitopsEmitterError) as exc:
            emit(_hook_kwargs(target_dir))
        message = str(exc.value)
        assert "auth.apiKeySecretRef" in message
        assert "overrides_cli set support-agent" in message
        # Fail-fast: nothing was pushed at all (the bare repo has no refs).
        refs = subprocess.run(
            ["git", "show-ref"], cwd=bare_repo, capture_output=True, text=True
        )
        assert refs.stdout.strip() == ""

    def test_values_required_satisfied_by_override_publishes(self, tmp_path, bare_repo, monkeypatch):
        extension = """\
apps:
  - name: vector-db
    chart: qdrant
    repo: https://qdrant.github.io/qdrant-helm
    version: 1.9.1
    valuesRequired:
      - auth.apiKeySecretRef
"""
        target_dir = _target_dir(tmp_path, extension=extension)
        overrides_src = tmp_path / "instance-overrides.yaml"
        overrides_src.write_text(
            "appValues:\n  vector-db:\n    auth:\n      apiKeySecretRef: my-secret\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(overrides_src))
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(_file_url(bare_repo), overrides_dir=str(tmp_path / "overrides")),
        )

        emit(_hook_kwargs(target_dir))
        record = yaml.safe_load(_show(bare_repo, "profiles/support-agent/profile.yaml"))
        app = record["spec"]["apps"][0]
        assert app["values"]["auth"]["apiKeySecretRef"] == "my-secret"
        assert "valuesRequired" not in app  # satisfied and dropped
        jsonschema.validate(instance=record, schema=_schema())

    def test_local_app_with_version_fails_pre_render(self, tmp_path, bare_repo, monkeypatch):
        extension = """\
apps:
  - name: docs-site
    chart: charts/test-page
    repo: local
    version: 1.0.0
"""
        target_dir = _target_dir(tmp_path, extension=extension)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="version is not allowed with repo: local"):
            emit(_hook_kwargs(target_dir))

    def test_remote_app_without_version_fails_pre_render(self, tmp_path, bare_repo, monkeypatch):
        extension = """\
apps:
  - name: vector-db
    chart: qdrant
    repo: https://qdrant.github.io/qdrant-helm
"""
        target_dir = _target_dir(tmp_path, extension=extension)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="version is required for remote repo"):
            emit(_hook_kwargs(target_dir))

    def test_duplicate_app_names_fail_pre_render(self, tmp_path, bare_repo, monkeypatch):
        extension = """\
apps:
  - name: vector-db
    chart: qdrant
    repo: https://qdrant.github.io/qdrant-helm
    version: 1.9.1
  - name: vector-db
    chart: other
    repo: https://example.com/charts
    version: 2.0.0
"""
        target_dir = _target_dir(tmp_path, extension=extension)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="duplicate app name"):
            emit(_hook_kwargs(target_dir))

    def test_missing_repo_url_raises(self, tmp_path, monkeypatch):
        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: {"plugins": {"entries": {"gitops-emitter": {}}}},
        )
        with pytest.raises(GitopsEmitterError, match="repo_url"):
            emit(_hook_kwargs(target_dir))

    def test_missing_token_raises(self, tmp_path, bare_repo, monkeypatch):
        target_dir = tmp_path / "profile"
        target_dir.mkdir()
        (target_dir / "distribution.yaml").write_text(DISTRIBUTION_YAML, encoding="utf-8")
        # deliberately no .env file
        monkeypatch.delenv("GITOPS_GIT_TOKEN", raising=False)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="GITOPS_GIT_TOKEN"):
            emit(_hook_kwargs(target_dir))

    def test_update_with_same_sha_as_previous_is_a_cheap_noop_second_publish(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )

        first_sha = emit(_hook_kwargs(target_dir, event="install"))
        assert first_sha is not None
        log_before = _log(bare_repo)

        second_sha = emit(
            _hook_kwargs(
                target_dir,
                event="update",
                previous_version="1.3.0",
                previous_sha="9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            )
        )
        assert second_sha is None
        assert _log(bare_repo) == log_before

    def test_scaffold_true_creates_bootstrap_and_publishes_profile(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(_file_url(bare_repo), scaffold=True),
        )

        emit(_hook_kwargs(target_dir))

        result = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", "main"],
            cwd=bare_repo,
            capture_output=True,
            text=True,
            check=True,
        )
        files = result.stdout.splitlines()
        assert "bootstrap/applicationset.yaml" in files
        assert "profiles/support-agent/profile.yaml" in files

    def test_scaffold_false_skips_bootstrap_but_still_publishes(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(_file_url(bare_repo), scaffold=False),
        )

        emit(_hook_kwargs(target_dir))

        result = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", "main"],
            cwd=bare_repo,
            capture_output=True,
            text=True,
            check=True,
        )
        files = result.stdout.splitlines()
        assert "bootstrap/applicationset.yaml" not in files
        assert "profiles/support-agent/profile.yaml" in files

    def test_commit_message_format(self, tmp_path, bare_repo, monkeypatch):
        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        emit(_hook_kwargs(target_dir, event="install"))
        result = subprocess.run(
            ["git", "log", "main", "-1", "--format=%s"],
            cwd=bare_repo,
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.stdout.strip() == (
            "gitops-emitter: install support-agent 1.3.0 @ 9f2c1ab3d4e5"
        )

    def test_no_extension_file_publishes_zero_apps_record(
        self, tmp_path, bare_repo, monkeypatch
    ):
        # No hermes-gitops.yaml at all => the profile declares no infra
        # intent. That is NOT an error and there is NO fallback to
        # distribution.yaml blocks or to a source re-fetch: the record
        # still publishes (agent pod renders) with zero apps.
        target_dir = _target_dir(tmp_path, extension=None)

        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )

        sha = emit(_hook_kwargs(target_dir))
        assert sha is not None
        record = yaml.safe_load(_show(bare_repo, "profiles/support-agent/profile.yaml"))
        for key in ("apps", "deployment", "expose", "workloads"):
            assert key not in record["spec"]
        # env_requires still flows from the (pure) distribution.yaml.
        # v1alpha3 (#141): the declaration keeps its metadata, and the
        # description the distribution.yaml carried survives into the
        # record instead of being discarded at the boundary.
        assert record["spec"]["envRequires"] == [
            {
                "name": "DISCORD_BOT_TOKEN",
                "required": True,
                "secret": True,
                "description": "Discord bot token",
            }
        ]
        jsonschema.validate(instance=record, schema=_schema())

    def test_embedded_distribution_blocks_are_never_read(
        self, tmp_path, bare_repo, monkeypatch
    ):
        # A distribution.yaml still carrying legacy embedded extension
        # blocks (old-style repo): those blocks contribute NOTHING to the
        # record — hermes-gitops.yaml is the only carrier, and none exists
        # here. No source re-fetch happens either (source_url points at a
        # nonexistent path, which the removed fallback would have choked
        # on).
        target_dir = tmp_path / "profile"
        target_dir.mkdir()
        (target_dir / "distribution.yaml").write_text(
            "name: support-agent\nversion: 1.3.0\n"
            "deployment:\n  diskSizeGb: 99\n"
            "workloads:\n  - name: test-page\n    default: true\n",
            encoding="utf-8",
        )
        (target_dir / ".env").write_text("GITOPS_GIT_TOKEN=gh_fake_token_value\n", encoding="utf-8")
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )

        sha = emit(
            _hook_kwargs(target_dir, source_url=str(tmp_path / "does-not-exist-source.git"))
        )
        assert sha is not None
        record = yaml.safe_load(_show(bare_repo, "profiles/support-agent/profile.yaml"))
        assert "deployment" not in record["spec"]
        assert "apps" not in record["spec"]
        assert "workloads" not in record["spec"]


# ---------------------------------------------------------------------------
# Handler-level: gitops_emitter/__init__.py against the real emit() pipeline
# ---------------------------------------------------------------------------


class TestHandlerLevelFullPipeline:
    def test_fatal_dict_on_unreachable_repo(self, tmp_path, monkeypatch):
        target_dir = _target_dir(tmp_path)
        unreachable = tmp_path / "does-not-exist.git"
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(unreachable))
        )

        result = gitops_emitter._on_profile_install(**_hook_kwargs(target_dir))

        assert result["fatal"] is True
        assert result["plugin"] == "gitops-emitter"
        assert result["error"]  # readable, non-empty
        assert "gh_fake_token_value" not in result["error"]

    def test_success_returns_none_and_logs_commit_sha(self, tmp_path, bare_repo, monkeypatch, caplog):
        import logging

        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )

        with caplog.at_level(logging.INFO, logger="gitops_emitter"):
            result = gitops_emitter._on_profile_install(**_hook_kwargs(target_dir))

        assert result is None
        assert any(
            "pushed HermesProfile/support-agent" in record.message for record in caplog.records
        )


class TestCheckRequiredSecrets:
    """Issue #37 [K5]: fail-loud secret-presence check, opt-in via
    HERMES_GITOPS_AVAILABLE_SECRETS_JSON (names only, set by the infra
    program's per-agent install Commands)."""

    def test_skipped_when_env_var_unset(self, monkeypatch):
        monkeypatch.delenv("HERMES_GITOPS_AVAILABLE_SECRETS_JSON", raising=False)
        emitter_mod._check_required_secrets("support-agent", ["OPENAI_API_KEY"])  # no raise

    def test_skipped_when_no_env_requires(self, monkeypatch):
        monkeypatch.setenv("HERMES_GITOPS_AVAILABLE_SECRETS_JSON", "{}")
        emitter_mod._check_required_secrets("support-agent", [])  # no raise

    def test_all_present_passes(self, monkeypatch):
        monkeypatch.setenv(
            "HERMES_GITOPS_AVAILABLE_SECRETS_JSON",
            '{"support-agent": ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"]}',
        )
        emitter_mod._check_required_secrets("support-agent", ["OPENAI_API_KEY"])  # no raise

    def test_missing_secret_fails_naming_key_and_fix(self, monkeypatch):
        monkeypatch.setenv("HERMES_GITOPS_AVAILABLE_SECRETS_JSON", '{"support-agent": []}')
        with pytest.raises(GitopsEmitterError) as exc:
            emitter_mod._check_required_secrets("support-agent", ["OPENAI_API_KEY"])
        message = str(exc.value)
        assert "OPENAI_API_KEY" in message
        assert "agentSecrets.support-agent.OPENAI_API_KEY" in message

    def test_unknown_instance_fails_listing_all(self, monkeypatch):
        monkeypatch.setenv("HERMES_GITOPS_AVAILABLE_SECRETS_JSON", '{"other": ["A"]}')
        with pytest.raises(GitopsEmitterError, match="OPENAI_API_KEY, DISCORD_BOT_TOKEN"):
            emitter_mod._check_required_secrets(
                "support-agent", ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"]
            )

    def test_invalid_json_fails_loudly(self, monkeypatch):
        monkeypatch.setenv("HERMES_GITOPS_AVAILABLE_SECRETS_JSON", "not-json")
        with pytest.raises(GitopsEmitterError, match="not valid JSON"):
            emitter_mod._check_required_secrets("support-agent", ["OPENAI_API_KEY"])

    def test_optional_vars_are_not_demanded(self):
        """required: false entries must never fail an install for being
        unset - only the required subset feeds the check (found live: the
        marketing-manager profile's optional HERMES_DASHBOARD*/ELEVENLABS
        vars failed the whole fleet install)."""
        manifest = {
            "env_requires": [
                {"name": "ANTHROPIC_API_KEY", "required": True},
                {"name": "HERMES_DASHBOARD", "required": False},
                {"name": "IMPLICITLY_REQUIRED"},
                "BARE_NAME",
            ]
        }
        extracted = emitter_mod._extract_env_requires(manifest)
        assert [e["name"] for e in extracted] == [
            "ANTHROPIC_API_KEY",
            "HERMES_DASHBOARD",
            "IMPLICITLY_REQUIRED",
            "BARE_NAME",
        ]
        assert emitter_mod.required_secret_names(extracted) == [
            "ANTHROPIC_API_KEY",
            "IMPLICITLY_REQUIRED",
            "BARE_NAME",
        ]


import pathlib  # noqa: E402


class TestOverridesClearContract:
    """Issue #11 [E2]: HERMES_GITOPS_OVERRIDES_CLEAR deletes the persisted
    per-instance override (declared-absent), while plain runs keep the
    backward-compatible reuse behavior."""

    def _cfg(self, tmp_path):
        return {"overrides_dir": str(tmp_path / "overrides")}

    def test_clear_removes_persisted_and_returns_empty(self, tmp_path, monkeypatch):
        cfg = self._cfg(tmp_path)
        overrides_dir = pathlib.Path(cfg["overrides_dir"])
        overrides_dir.mkdir(parents=True)
        (overrides_dir / "support-agent.yaml").write_text(
            "deployment:\n  diskSizeGb: 99\n", encoding="utf-8"
        )
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES_CLEAR", "1")
        assert emitter_mod.load_instance_overrides("support-agent", cfg) == {}
        assert not (overrides_dir / "support-agent.yaml").exists()

    def test_clear_with_nothing_persisted_is_a_noop(self, tmp_path, monkeypatch):
        cfg = self._cfg(tmp_path)
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES_CLEAR", "1")
        assert emitter_mod.load_instance_overrides("support-agent", cfg) == {}

    def test_overrides_env_wins_over_clear(self, tmp_path, monkeypatch):
        cfg = self._cfg(tmp_path)
        source = tmp_path / "src.yaml"
        source.write_text("deployment:\n  diskSizeGb: 42\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(source))
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES_CLEAR", "1")
        result = emitter_mod.load_instance_overrides("support-agent", cfg)
        assert result == {"deployment": {"diskSizeGb": 42}}

    def test_no_env_vars_keeps_persisted_reuse(self, tmp_path, monkeypatch):
        cfg = self._cfg(tmp_path)
        overrides_dir = pathlib.Path(cfg["overrides_dir"])
        overrides_dir.mkdir(parents=True)
        (overrides_dir / "support-agent.yaml").write_text(
            emitter_mod._provenance_header("pulumi") + "deployment:\n  diskSizeGb: 99\n",
            encoding="utf-8",
        )
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES_CLEAR", raising=False)
        assert emitter_mod.load_instance_overrides("support-agent", cfg) == {
            "deployment": {"diskSizeGb": 99}
        }


class TestPrModeConfig:
    """Issue #17 [F1]: mode/pr_auto_merge config fields."""

    def _hermes_cfg(self, entry):
        return {"plugins": {"entries": {"gitops-emitter": entry}}}

    def test_mode_defaults_to_direct(self, monkeypatch):
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: self._hermes_cfg({"repo_url": "https://github.com/o/g.git"}),
        )
        cfg = emitter_mod.load_plugin_config()
        assert cfg["mode"] == "direct"
        assert cfg["pr_auto_merge"] is True

    def test_mode_pr_accepted(self, monkeypatch):
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: self._hermes_cfg(
                {"repo_url": "https://github.com/o/g.git", "mode": "pr", "pr_auto_merge": False}
            ),
        )
        cfg = emitter_mod.load_plugin_config()
        assert cfg["mode"] == "pr"
        assert cfg["pr_auto_merge"] is False

    def test_invalid_mode_rejected(self, monkeypatch):
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: self._hermes_cfg(
                {"repo_url": "https://github.com/o/g.git", "mode": "yolo"}
            ),
        )
        with pytest.raises(GitopsEmitterError, match="'direct' or 'pr'"):
            emitter_mod.load_plugin_config()


class TestEmitPrModeIdempotency:
    """Issue #19 [F2]: the emit-level decision table against a real local
    bare repo, with the forge HTTP surface mocked."""

    def _setup(self, tmp_path, bare_repo, monkeypatch, auto_merge=False):
        from gitops_emitter import forge

        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(
                _file_url(bare_repo), mode="pr", pr_auto_merge=auto_merge
            ),
        )
        # file:// stands in for GitHub on the git side; bypass the
        # GitHub-URL requirement and record forge calls.
        calls = {"opened": 0, "found": 0, "merged": 0, "open_prs": []}
        monkeypatch.setattr(forge, "require_github_repo", lambda url, ctx: ("org", "gitops"))

        def fake_find(url, token, *, head, base):
            calls["found"] += 1
            return {"number": 7, "html_url": "u", "existing": True} if calls["open_prs"] else None

        def fake_open(url, token, *, head, base, title, body):
            calls["opened"] += 1
            calls["open_prs"].append(head)
            return {"number": 7, "html_url": "u", "existing": False}

        def fake_merge(url, token, number, **kw):
            calls["merged"] += 1
            calls["open_prs"].clear()
            return "f" * 40

        monkeypatch.setattr(forge, "find_open_pull_request", fake_find)
        monkeypatch.setattr(forge, "open_pull_request", fake_open)
        monkeypatch.setattr(forge, "merge_pull_request", fake_merge)
        return target_dir, calls

    def test_rerun_with_identical_content_opens_exactly_one_pr(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir, calls = self._setup(tmp_path, bare_repo, monkeypatch)
        sha1 = emit(_hook_kwargs(target_dir, event="update"))
        assert sha1 and calls["opened"] == 1

        sha2 = emit(_hook_kwargs(target_dir, event="update"))
        assert calls["opened"] == 1  # no duplicate PR
        assert sha2 == sha1  # existing head commit reported, nothing pushed
        log = subprocess.run(
            ["git", "--git-dir", str(bare_repo), "log", "--oneline", "hermes-gitops/support-agent"],
            capture_output=True, text=True, check=True,
        ).stdout
        assert len(log.strip().splitlines()) >= 1

    def test_changed_content_updates_existing_pr_not_a_second_one(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir, calls = self._setup(tmp_path, bare_repo, monkeypatch)
        emit(_hook_kwargs(target_dir, event="update"))
        assert calls["opened"] == 1

        kwargs = _hook_kwargs(target_dir, event="update")
        kwargs["sha"] = "b" * 40  # content change
        emit(kwargs)
        assert calls["opened"] == 1  # updated, not duplicated
        text = _show(bare_repo, "profiles/support-agent/profile.yaml", branch="hermes-gitops/support-agent")
        assert ("b" * 40) in text

    def test_auto_merge_returns_merge_sha(self, tmp_path, bare_repo, monkeypatch):
        target_dir, calls = self._setup(tmp_path, bare_repo, monkeypatch, auto_merge=True)
        sha = emit(_hook_kwargs(target_dir, event="update"))
        assert calls["merged"] == 1
        assert sha == "f" * 40


class TestEmitEventModeDispatch:
    """ADR-2 (#140): the PR gate applies to EVERY change, including the
    first install, and the only way past it is an explicit flag.

    What this replaced: `pr` mode silently became `direct` when
    `event == "install"`. The rule "every change goes through a pull
    request" was therefore false in exactly the situation nobody would
    think to check, and the exception appeared in no config an operator
    could read.
    """

    def _setup(self, tmp_path, bare_repo, monkeypatch, auto_merge=True, **entry):
        from gitops_emitter import forge

        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(
                _file_url(bare_repo), mode="pr", pr_auto_merge=auto_merge, **entry
            ),
        )
        calls = {"opened": 0, "merged": 0}
        monkeypatch.setattr(forge, "require_github_repo", lambda url, ctx: ("org", "gitops"))
        monkeypatch.setattr(
            forge, "find_open_pull_request", lambda *a, **k: None
        )

        def fake_open(url, token, *, head, base, title, body):
            calls["opened"] += 1
            return {"number": 9, "html_url": "u", "existing": False}

        def fake_merge(url, token, number, **kw):
            calls["merged"] += 1
            return "e" * 40

        monkeypatch.setattr(forge, "open_pull_request", fake_open)
        monkeypatch.setattr(forge, "merge_pull_request", fake_merge)
        return target_dir, calls

    def test_install_takes_the_pr_gate_like_everything_else(self, tmp_path, bare_repo, monkeypatch):
        """The carve-out is gone. A first install opens a PR."""
        target_dir, calls = self._setup(tmp_path, bare_repo, monkeypatch, auto_merge=False)
        sha = emit(_hook_kwargs(target_dir, event="install"))
        assert sha and calls["opened"] == 1
        # The base branch does NOT carry the record - a human (or
        # auto-merge) has to merge it, exactly as for an update.
        with pytest.raises(subprocess.CalledProcessError):
            _show(bare_repo, "profiles/support-agent/profile.yaml")

    def test_install_with_auto_merge_still_converges(self, tmp_path, bare_repo, monkeypatch):
        """The reason the carve-out existed - a fresh fleet's
        non-interactive `pulumi up` has to converge - is served by
        `pr_auto_merge`, which is already on by default. Removing the
        carve-out costs that case nothing."""
        target_dir, calls = self._setup(tmp_path, bare_repo, monkeypatch, auto_merge=True)
        sha = emit(_hook_kwargs(target_dir, event="install"))
        assert sha and calls["opened"] == 1 and calls["merged"] == 1

    def test_the_flag_commits_direct_for_any_event(self, tmp_path, bare_repo, monkeypatch):
        """The explicit escape hatch, and it is not keyed on event type -
        that was the defect."""
        for event, sha_in in (("install", "a" * 40), ("update", "b" * 40)):
            target_dir, calls = self._setup(
                tmp_path / event, bare_repo, monkeypatch, allow_direct_commit=True
            )
            kwargs = _hook_kwargs(target_dir, event=event)
            # Distinct content per event: an identical re-emit is a
            # deliberate no-op (None), which would hide the thing under
            # test.
            kwargs["sha"] = sha_in
            sha = emit(kwargs)
            assert sha, event
            assert calls["opened"] == 0 and calls["merged"] == 0, event
        assert "spec:" in _show(bare_repo, "profiles/support-agent/profile.yaml")

    def test_the_flag_is_off_unless_set(self, tmp_path, bare_repo, monkeypatch):
        # Fail closed: the bypass must never be the default posture.
        from gitops_emitter.harness.hermes import load_plugin_config

        monkeypatch.setattr(
            emitter_mod,
            "_load_hermes_config",
            lambda: _fake_hermes_config(_file_url(bare_repo), mode="pr"),
        )
        assert load_plugin_config()["allow_direct_commit"] is False

    def test_using_the_flag_is_logged_loudly(self, tmp_path, bare_repo, monkeypatch, caplog):
        """#140: the flag must be visible when used. A silent bypass is
        the carve-out again, wearing a config key."""
        import logging

        target_dir, _ = self._setup(
            tmp_path, bare_repo, monkeypatch, allow_direct_commit=True
        )
        with caplog.at_level(logging.WARNING, logger="gitops_emitter.harness.hermes"):
            emit(_hook_kwargs(target_dir, event="install"))
        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert warnings, "using the escape hatch produced no warning"
        msg = " ".join(r.getMessage() for r in warnings)
        assert "allow_direct_commit" in msg
        # It names what is being bypassed, not just that a flag is set.
        assert "pull-request" in msg

    def test_update_event_takes_the_pr_gate(self, tmp_path, bare_repo, monkeypatch):
        # Seed the base branch with the escape hatch - the bootstrap case
        # the flag exists for - then measure what an UPDATE does.
        seed_dir, _ = self._setup(
            tmp_path / "seed", bare_repo, monkeypatch, allow_direct_commit=True
        )
        emit(_hook_kwargs(seed_dir, event="install"))
        target_dir, calls = self._setup(tmp_path, bare_repo, monkeypatch, auto_merge=False)
        kwargs = _hook_kwargs(target_dir, event="update")
        kwargs["sha"] = "b" * 40
        sha = emit(kwargs)
        assert sha and calls["opened"] == 1 and calls["merged"] == 0
        # base unchanged until a human merges
        assert ("b" * 40) not in _show(bare_repo, "profiles/support-agent/profile.yaml")

    def test_update_event_with_auto_merge_merges(self, tmp_path, bare_repo, monkeypatch):
        seed_dir, _ = self._setup(
            tmp_path / "seed", bare_repo, monkeypatch, allow_direct_commit=True
        )
        emit(_hook_kwargs(seed_dir, event="install"))
        target_dir, calls = self._setup(tmp_path, bare_repo, monkeypatch, auto_merge=True)
        kwargs = _hook_kwargs(target_dir, event="update")
        kwargs["sha"] = "b" * 40
        sha = emit(kwargs)
        assert calls["opened"] == 1 and calls["merged"] == 1
        assert sha == "e" * 40


class TestCatalogueCoPublish:
    """ADR-34: every record publish carries the logical catalogue in the
    SAME commit - the authored contract byte-for-byte plus hand-formatted
    provenance (byte-matching the CLI emitter's output)."""

    def test_install_writes_catalogue_beside_the_record(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = _target_dir(tmp_path)
        authored = (target_dir / "hermes-gitops.yaml").read_text(encoding="utf-8")
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )

        sha = emit(_hook_kwargs(target_dir))
        assert sha

        assert _show(bare_repo, "catalog/profiles/support-agent/contract.yaml") == authored
        prov = _show(bare_repo, "catalog/profiles/support-agent/provenance.yaml")
        hook_sha = _hook_kwargs(target_dir)["sha"]
        assert prov == f'profile: support-agent\nsourceSha: "{hook_sha}"\n'

    def test_reemit_is_a_single_no_op_across_all_files(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        assert emit(_hook_kwargs(target_dir))
        # identical inputs: record AND catalogue unchanged -> no commit
        assert emit(_hook_kwargs(target_dir)) is None

    def test_profile_without_extension_gets_the_placeholder(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = tmp_path / "bare-profile"
        target_dir.mkdir()
        (target_dir / "distribution.yaml").write_text(
            "name: support-agent\nversion: 1.0.0\n", encoding="utf-8"
        )
        (target_dir / ".env").write_text("GITOPS_GIT_TOKEN=t\n", encoding="utf-8")
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        assert emit(_hook_kwargs(target_dir))
        assert (
            _show(bare_repo, "catalog/profiles/support-agent/contract.yaml")
            == "# no hermes-gitops.yaml - the profile declares no infra intent\n"
        )


class TestDashboardCataloguePublish:
    """ADR-42: a profile payload carrying dashboard/ files gets them
    validated and co-published byte-for-byte into the dashboard catalogue,
    with hand-formatted provenance, in the SAME commit as the record."""

    COMPONENTS_YAML = (
        "apiVersion: dashboard.hermes-gitops/v1alpha1\n"
        "kind: NexusContribution\n"
        "metadata:\n"
        "  id: support-agent\n"
        "  title: Support Agent\n"
        "spec:\n"
        "  components:\n"
        "    - id: support-agent\n"
        "      kind: agent\n"
        "      title: Support Agent\n"
        "      bind:\n"
        "        profile: support-agent\n"
    )

    def _with_dashboard(self, tmp_path, content=None):
        target_dir = _target_dir(tmp_path)
        dash = target_dir / "dashboard"
        dash.mkdir()
        (dash / "components.yaml").write_text(
            content if content is not None else self.COMPONENTS_YAML, encoding="utf-8"
        )
        return target_dir

    def test_dashboard_files_copied_verbatim_with_provenance(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = self._with_dashboard(tmp_path)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        assert emit(_hook_kwargs(target_dir))
        assert (
            _show(bare_repo, "catalog/dashboard/sources/support-agent/components.yaml")
            == self.COMPONENTS_YAML
        )
        hook_sha = _hook_kwargs(target_dir)["sha"]
        prov = _show(bare_repo, "catalog/dashboard/sources/support-agent/provenance.yaml")
        assert prov == (
            f'sourceSha: "{hook_sha}"\nsourcePaths:\n  - dashboard/components.yaml\n'
        )
        # identical inputs -> one no-op across record + both catalogues
        assert emit(_hook_kwargs(target_dir)) is None

    def test_invalid_dashboard_file_refuses_before_any_write(
        self, tmp_path, bare_repo, monkeypatch
    ):
        bad = self.COMPONENTS_YAML.replace("kind: agent", "kind: spaceship")
        target_dir = self._with_dashboard(tmp_path, content=bad)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="schema validation failed"):
            emit(_hook_kwargs(target_dir))
        # nothing reached the repo - not even the profile record
        with pytest.raises(Exception):
            _show(bare_repo, "profiles/support-agent/profile.yaml")

    def test_unknown_kind_refuses(self, tmp_path, bare_repo, monkeypatch):
        target_dir = self._with_dashboard(tmp_path, content="kind: Deployment\n")
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="kind must be"):
            emit(_hook_kwargs(target_dir))

    def test_v1alpha2_links_validate_and_publish_verbatim(
        self, tmp_path, bare_repo, monkeypatch
    ):
        # ADR-43: the emitter dispatches on apiVersion - a v1alpha2 file
        # with clean https links passes and is catalogued byte-for-byte.
        v2 = self.COMPONENTS_YAML.replace("v1alpha1", "v1alpha2") + (
            "      links:\n"
            "        repository: https://github.com/acme/support\n"
        )
        target_dir = self._with_dashboard(tmp_path, content=v2)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        assert emit(_hook_kwargs(target_dir))
        assert (
            _show(bare_repo, "catalog/dashboard/sources/support-agent/components.yaml") == v2
        )

    def test_v1alpha2_http_link_refuses(self, tmp_path, bare_repo, monkeypatch):
        bad = self.COMPONENTS_YAML.replace("v1alpha1", "v1alpha2") + (
            "      links:\n"
            "        repository: http://github.com/acme/support\n"
        )
        target_dir = self._with_dashboard(tmp_path, content=bad)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="schema validation failed"):
            emit(_hook_kwargs(target_dir))

    def test_unknown_api_version_refuses(self, tmp_path, bare_repo, monkeypatch):
        v9 = self.COMPONENTS_YAML.replace("v1alpha1", "v9")
        target_dir = self._with_dashboard(tmp_path, content=v9)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="apiVersion must be"):
            emit(_hook_kwargs(target_dir))

    def test_api_version_allowlist_is_the_full_string_even_without_jsonschema(
        self, monkeypatch
    ):
        # A suffix match would let other.vendor/v1alpha2 (or a bare
        # v1alpha2) publish unvalidated when jsonschema is absent.
        from gitops_emitter import render

        monkeypatch.setattr(render, "jsonschema", None)
        for bad in ("other.vendor/v1alpha2", "v1alpha2", "dashboard.hermes-gitops/v9", None):
            with pytest.raises(GitopsEmitterError, match="apiVersion must be"):
                render.validate_dashboard_file(
                    "x.yaml", {"kind": "NexusContribution", "apiVersion": bad}
                )
        # The real versions still pass the (schema-less) gate.
        for good in ("dashboard.hermes-gitops/v1alpha1", "dashboard.hermes-gitops/v1alpha2"):
            render.validate_dashboard_file(
                "x.yaml", {"kind": "NexusContribution", "apiVersion": good}
            )

    def test_symlink_in_dashboard_refuses(self, tmp_path, bare_repo, monkeypatch):
        target_dir = self._with_dashboard(tmp_path)
        secret = tmp_path / "secret.yaml"
        secret.write_text("kind: NexusView\n", encoding="utf-8")
        (target_dir / "dashboard" / "stolen.yaml").symlink_to(secret)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="symlink"):
            emit(_hook_kwargs(target_dir))

    PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    WEBP_BYTES = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 24

    def test_icon_assets_catalogued_with_provenance(
        self, tmp_path, bare_repo, monkeypatch
    ):
        target_dir = self._with_dashboard(tmp_path)
        icons = target_dir / "dashboard" / "icons"
        icons.mkdir()
        (icons / "postiz.png").write_bytes(self.PNG_BYTES)
        (icons / "kanban.webp").write_bytes(self.WEBP_BYTES)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        assert emit(_hook_kwargs(target_dir))
        assert (
            _show_bytes(bare_repo, "catalog/dashboard/sources/support-agent/icons/postiz.png")
            == self.PNG_BYTES
        )
        assert (
            _show_bytes(bare_repo, "catalog/dashboard/sources/support-agent/icons/kanban.webp")
            == self.WEBP_BYTES
        )
        prov = _show(bare_repo, "catalog/dashboard/sources/support-agent/provenance.yaml")
        assert "  - dashboard/icons/postiz.png\n" in prov
        assert "  - dashboard/icons/kanban.webp\n" in prov
        # identical inputs -> one no-op across record + catalogue, icons included
        assert emit(_hook_kwargs(target_dir)) is None

    def test_icon_wrong_extension_refuses(self, tmp_path, bare_repo, monkeypatch):
        target_dir = self._with_dashboard(tmp_path)
        icons = target_dir / "dashboard" / "icons"
        icons.mkdir()
        (icons / "logo.svg").write_bytes(b"<svg/>")
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match=r"must be \.png or \.webp"):
            emit(_hook_kwargs(target_dir))

    def test_icon_magic_byte_mismatch_refuses(self, tmp_path, bare_repo, monkeypatch):
        target_dir = self._with_dashboard(tmp_path)
        icons = target_dir / "dashboard" / "icons"
        icons.mkdir()
        (icons / "logo.png").write_bytes(b"not a png at all")
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="does not match its .png extension"):
            emit(_hook_kwargs(target_dir))

    def test_icon_oversize_refuses(self, tmp_path, bare_repo, monkeypatch):
        target_dir = self._with_dashboard(tmp_path)
        icons = target_dir / "dashboard" / "icons"
        icons.mkdir()
        (icons / "huge.png").write_bytes(
            b"\x89PNG\r\n\x1a\n" + b"\x00" * (256 * 1024)
        )
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="limit is"):
            emit(_hook_kwargs(target_dir))

    def test_icon_symlink_refuses(self, tmp_path, bare_repo, monkeypatch):
        target_dir = self._with_dashboard(tmp_path)
        icons = target_dir / "dashboard" / "icons"
        icons.mkdir()
        real = tmp_path / "outside.png"
        real.write_bytes(self.PNG_BYTES)
        (icons / "stolen.png").symlink_to(real)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        with pytest.raises(GitopsEmitterError, match="symlink"):
            emit(_hook_kwargs(target_dir))

    def test_no_dashboard_dir_changes_nothing(self, tmp_path, bare_repo, monkeypatch):
        target_dir = _target_dir(tmp_path)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        assert emit(_hook_kwargs(target_dir))
        with pytest.raises(Exception):
            _show(bare_repo, "catalog/dashboard/sources/support-agent/provenance.yaml")

    def test_removed_dashboard_files_leave_the_catalogue(
        self, tmp_path, bare_repo, monkeypatch
    ):
        """An update whose payload no longer carries dashboard/ must
        delete the stale catalogue tree - the catalogue is reconciled,
        never append-only."""
        target_dir = self._with_dashboard(tmp_path)
        monkeypatch.setattr(
            emitter_mod, "_load_hermes_config", lambda: _fake_hermes_config(_file_url(bare_repo))
        )
        assert emit(_hook_kwargs(target_dir))
        assert "components" in _show(
            bare_repo, "catalog/dashboard/sources/support-agent/components.yaml"
        )

        (target_dir / "dashboard" / "components.yaml").unlink()
        (target_dir / "dashboard").rmdir()
        kwargs = _hook_kwargs(target_dir, event="update")
        kwargs["sha"] = "b" * 40
        assert emit(kwargs)
        with pytest.raises(Exception):
            _show(bare_repo, "catalog/dashboard/sources/support-agent/components.yaml")
        with pytest.raises(Exception):
            _show(bare_repo, "catalog/dashboard/sources/support-agent/provenance.yaml")
        # the record itself survives
        assert "spec:" in _show(bare_repo, "profiles/support-agent/profile.yaml")


class TestOverridesAreACacheNotAnAuthority:
    """ADR-4 (#180): Pulumi stack configuration is the ONLY environment
    authority, and the files under HERMES_HOME are a regenerable cache
    of it.

    The code used to let those files be hand-authored and reused, which
    quietly created a second authority for the same decisions - an
    operator edits one, it shapes every later record, and the stack
    config that is supposed to be authoritative says something else. The
    two never disagree loudly; they just disagree.
    """

    def _cfg(self, tmp_path):
        return {"overrides_dir": str(tmp_path / "overrides")}

    def _write(self, tmp_path, text):
        d = pathlib.Path(self._cfg(tmp_path)["overrides_dir"])
        d.mkdir(parents=True, exist_ok=True)
        (d / "support-agent.yaml").write_text(text, encoding="utf-8")
        return d / "support-agent.yaml"

    def test_a_hand_authored_file_fails_loudly(self, tmp_path, monkeypatch):
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES_CLEAR", raising=False)
        self._write(tmp_path, "deployment:\n  diskSizeGb: 500\n")

        with pytest.raises(GitopsEmitterError) as exc:
            emitter_mod.load_instance_overrides("support-agent", self._cfg(tmp_path))
        msg = str(exc.value)
        # #180: "either ignored or a LOUD FAILURE - with a message naming
        # the stack key to set instead".
        assert "not written by this tooling" in msg
        assert "agents[]" in msg and "overrides" in msg
        # And the named local path, for the case that is legitimately
        # outside Pulumi.
        assert "overrides_cli set" in msg
        # And how to get unstuck without guessing.
        assert "rm " in msg

    def test_a_stamped_file_is_honoured(self, tmp_path, monkeypatch):
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES_CLEAR", raising=False)
        self._write(
            tmp_path,
            emitter_mod._provenance_header("pulumi") + "deployment:\n  diskSizeGb: 7\n",
        )
        assert emitter_mod.load_instance_overrides("support-agent", self._cfg(tmp_path)) == {
            "deployment": {"diskSizeGb": 7}
        }

    def test_the_cli_written_file_is_honoured_too(self, tmp_path, monkeypatch):
        """`overrides_cli set` is the explicit, named local path #180 asks
        for - a deliberate command, not the ambient "a file happens to be
        here" capability this replaces."""
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES_CLEAR", raising=False)
        self._write(
            tmp_path,
            emitter_mod._provenance_header("overrides_cli") + "deployment:\n  diskSizeGb: 8\n",
        )
        assert emitter_mod.load_instance_overrides("support-agent", self._cfg(tmp_path)) == {
            "deployment": {"diskSizeGb": 8}
        }

    def test_a_stamp_below_content_does_not_count(self, tmp_path, monkeypatch):
        """Otherwise the check is defeated by pasting the header at the
        bottom of a hand-authored file, which is exactly what someone
        who read the error message and wanted it to go away would do."""
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES_CLEAR", raising=False)
        self._write(
            tmp_path,
            "deployment:\n  diskSizeGb: 9\n" + emitter_mod._provenance_header("pulumi"),
        )
        with pytest.raises(GitopsEmitterError):
            emitter_mod.load_instance_overrides("support-agent", self._cfg(tmp_path))

    def test_no_file_at_all_is_not_an_error(self, tmp_path, monkeypatch):
        # Absent overrides are the common case, not a misconfiguration.
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES", raising=False)
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES_CLEAR", raising=False)
        assert emitter_mod.load_instance_overrides("support-agent", self._cfg(tmp_path)) == {}

    def test_the_files_are_provably_regenerable(self, tmp_path, monkeypatch):
        """#180: "deleting them and re-running produces identical records".

        This is the property that makes them a cache rather than state.
        """
        src = tmp_path / "src.yaml"
        src.write_text("deployment:\n  diskSizeGb: 123\n", encoding="utf-8")
        cfg = self._cfg(tmp_path)
        monkeypatch.setenv("HERMES_GITOPS_OVERRIDES", str(src))
        monkeypatch.delenv("HERMES_GITOPS_OVERRIDES_CLEAR", raising=False)

        first = emitter_mod.load_instance_overrides("support-agent", cfg)
        persisted = pathlib.Path(cfg["overrides_dir"]) / "support-agent.yaml"
        before = persisted.read_bytes()

        persisted.unlink()
        second = emitter_mod.load_instance_overrides("support-agent", cfg)

        assert first == second
        # Byte-identical, not merely equivalent: a regenerated cache that
        # differs on disk would make "did anything change?" unanswerable.
        assert persisted.read_bytes() == before
