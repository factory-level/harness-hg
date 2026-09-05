"""Unit tests for gitops_emitter/config_cli.py — the supported
plugin-config write surface (issue #10 [E1])."""

from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from gitops_emitter.config_cli import (  # noqa: E402
    ConfigCliError,
    _effective_paths,
    apply_config_yaml,
    assert_applied,
    desired_entry_from_env,
    read_back_entry,
    seed_fleet_defaults,
    upsert_env_token,
)

DESIRED = {
    "repo_url": "https://github.com/org/gitops.git",
    "branch": "main",
    "hermes_gitops_repo_url": "https://github.com/factory-level/harness-hg.git",
    "chart_revision": "main",
    "scaffold": True,
}

FULL_ENV = {
    "HERMES_GITOPS_GITOPS_REPO_URL": DESIRED["repo_url"],
    "HERMES_GITOPS_GITOPS_BRANCH": DESIRED["branch"],
    "HERMES_GITOPS_HERMES_GITOPS_REPO_URL": DESIRED["hermes_gitops_repo_url"],
    "HERMES_GITOPS_CHART_REVISION": DESIRED["chart_revision"],
    "HERMES_GITOPS_GITOPS_SCAFFOLD": "true",
}


class TestDesiredEntryFromEnv:
    def test_full_env_builds_the_block(self):
        assert desired_entry_from_env(dict(FULL_ENV)) == DESIRED

    def test_scaffold_false(self):
        env = dict(FULL_ENV, HERMES_GITOPS_GITOPS_SCAFFOLD="false")
        assert desired_entry_from_env(env)["scaffold"] is False

    def test_missing_required_var_names_it(self):
        env = dict(FULL_ENV)
        del env["HERMES_GITOPS_GITOPS_REPO_URL"]
        with pytest.raises(ConfigCliError, match="HERMES_GITOPS_GITOPS_REPO_URL"):
            desired_entry_from_env(env)


class TestApplyConfigYaml:
    def test_fresh_file_gets_the_block(self, tmp_path):
        config = tmp_path / "config.yaml"
        apply_config_yaml(config, DESIRED)
        entry = read_back_entry(config)
        assert entry == DESIRED

    def test_comments_and_unrelated_keys_survive(self, tmp_path):
        config = tmp_path / "config.yaml"
        config.write_text(
            "# Operator's hand-written header comment\n"
            "model: claude-fable-5  # inline comment on the model\n"
            "plugins:\n"
            "  # plugins section comment\n"
            "  enabled:\n"
            "    - some-other-plugin\n"
            "  entries:\n"
            "    some-other-plugin:\n"
            "      key: value  # keep me\n",
            encoding="utf-8",
        )
        apply_config_yaml(config, DESIRED)
        text = config.read_text(encoding="utf-8")
        assert "# Operator's hand-written header comment" in text
        assert "# inline comment on the model" in text
        assert "# plugins section comment" in text
        assert "# keep me" in text
        assert "some-other-plugin" in text
        entry = read_back_entry(config)
        assert entry == DESIRED

    def test_idempotent_reapply(self, tmp_path):
        config = tmp_path / "config.yaml"
        apply_config_yaml(config, DESIRED)
        first = config.read_text(encoding="utf-8")
        apply_config_yaml(config, DESIRED)
        assert config.read_text(encoding="utf-8") == first

    def test_enabled_not_duplicated(self, tmp_path):
        config = tmp_path / "config.yaml"
        apply_config_yaml(config, DESIRED)
        apply_config_yaml(config, DESIRED)
        text = config.read_text(encoding="utf-8")
        assert text.count("gitops-emitter") >= 2  # enabled entry + entries key
        # exactly one enabled-list occurrence
        assert text.count("- gitops-emitter") == 1

    def test_non_mapping_file_fails_loudly(self, tmp_path):
        config = tmp_path / "config.yaml"
        config.write_text("- just\n- a\n- list\n", encoding="utf-8")
        with pytest.raises(ConfigCliError, match="YAML mapping"):
            apply_config_yaml(config, DESIRED)


class TestAssertApplied:
    def test_passes_after_apply(self, tmp_path):
        config = tmp_path / "config.yaml"
        apply_config_yaml(config, DESIRED)
        assert_applied(config, DESIRED)  # no raise

    def test_fails_naming_the_key_on_mismatch(self, tmp_path):
        config = tmp_path / "config.yaml"
        apply_config_yaml(config, dict(DESIRED, branch="other"))
        with pytest.raises(ConfigCliError, match="branch"):
            assert_applied(config, DESIRED)


class TestUpsertEnvToken:
    def test_fresh_file(self, tmp_path):
        env = tmp_path / ".env"
        upsert_env_token(env, "tok-1")
        assert env.read_text(encoding="utf-8") == "GITOPS_GIT_TOKEN=tok-1\n"

    def test_other_lines_preserved_and_token_replaced(self, tmp_path):
        env = tmp_path / ".env"
        env.write_text(
            "# my env file\nOTHER=keep\nGITOPS_GIT_TOKEN=old\nTRAILING=x\n",
            encoding="utf-8",
        )
        upsert_env_token(env, "tok-2")
        assert env.read_text(encoding="utf-8") == (
            "# my env file\nOTHER=keep\nGITOPS_GIT_TOKEN=tok-2\nTRAILING=x\n"
        )

    def test_rerun_never_duplicates_the_line(self, tmp_path):
        """Issue #16 [I2]: exactly ONE GITOPS_GIT_TOKEN line survives any
        number of re-applies (the stage-1 re-run case)."""
        env = tmp_path / ".env"
        for _ in range(3):
            upsert_env_token(env, "tok-same")
        content = env.read_text(encoding="utf-8")
        assert content.count("GITOPS_GIT_TOKEN=") == 1
        assert "GITOPS_GIT_TOKEN=tok-same\n" in content

    def test_no_token_branch_leaves_env_untouched(self, tmp_path, monkeypatch):
        """Issue #16 [I2]: with no GITOPS_GIT_TOKEN in the apply
        environment, cmd apply never creates or touches .env."""
        import gitops_emitter.config_cli as config_cli

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        for var, value in FULL_ENV.items():
            monkeypatch.setenv(var, value)
        monkeypatch.delenv("GITOPS_GIT_TOKEN", raising=False)
        monkeypatch.delenv("HERMES_GITOPS_FLEET_DEFAULTS_JSON", raising=False)
        config_cli.main(["apply"])
        assert (tmp_path / "config.yaml").is_file()
        assert not (tmp_path / ".env").exists()


class TestOptionalFields:
    """Issue #13 [E3]: unwritten plugin-config fields become writable."""

    def test_unset_optional_fields_are_absent(self):
        entry = desired_entry_from_env(dict(FULL_ENV))
        for key in (
            "profiles_path",
            "defaults_file",
            "overrides_dir",
            "git_author_name",
            "git_author_email",
            "image_repository",
            "image_tag",
        ):
            assert key not in entry

    def test_set_optional_fields_are_written(self, tmp_path):
        env = dict(
            FULL_ENV,
            HERMES_GITOPS_PROFILES_PATH="fleet-profiles",
            HERMES_GITOPS_GIT_AUTHOR_NAME="fleet-bot",
            HERMES_GITOPS_IMAGE_TAG="v1.2.3",
        )
        entry = desired_entry_from_env(env)
        assert entry["profiles_path"] == "fleet-profiles"
        assert entry["git_author_name"] == "fleet-bot"
        assert entry["image_tag"] == "v1.2.3"
        config = tmp_path / "config.yaml"
        apply_config_yaml(config, entry)
        assert read_back_entry(config)["image_tag"] == "v1.2.3"


class TestFleetDefaults:
    def test_seed_writes_generated_header_and_content(self, tmp_path):
        f = tmp_path / "gitops-emitter" / "defaults.yaml"
        seed_fleet_defaults(f, {"deployment": {"diskSizeGb": 100}})
        text = f.read_text(encoding="utf-8")
        assert "GENERATED" in text
        assert "diskSizeGb: 100" in text

    def test_seed_is_wholesale(self, tmp_path):
        f = tmp_path / "defaults.yaml"
        seed_fleet_defaults(f, {"a": 1})
        seed_fleet_defaults(f, {"b": 2})
        text = f.read_text(encoding="utf-8")
        assert "b: 2" in text and "a: 1" not in text

    def test_effective_paths_single_sourced_from_emitter(self, monkeypatch, tmp_path):
        from gitops_emitter.harness.hermes import default_defaults_file, default_overrides_dir

        # HERMES_HOME-aware (the isolation contract the bootstrap honors)
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        defaults_file, overrides_dir = _effective_paths({})
        assert defaults_file == tmp_path / "gitops-emitter" / "defaults.yaml"
        assert overrides_dir == tmp_path / "gitops-emitter" / "overrides"
        assert defaults_file == pathlib.Path(default_defaults_file()).expanduser()
        assert overrides_dir == pathlib.Path(default_overrides_dir()).expanduser()
        d2, o2 = _effective_paths(
            {"defaults_file": "/x/d.yaml", "overrides_dir": "/x/ov"}
        )
        assert d2 == pathlib.Path("/x/d.yaml")
        assert o2 == pathlib.Path("/x/ov")
