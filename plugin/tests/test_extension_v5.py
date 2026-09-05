"""Contract v5 (ADR-149, the agent runtime): dispatch, validation, strip.

v5 adds exactly one key - the top-level ``runtime`` block. For a Hermes
profile the block is absent and the strip is byte-identical to v4. A file
carrying ``runtime.kind: eve`` is an Eve project: it validates here, its
record is built by ``gitops_emitter.harness.eve`` (never by this Hermes pipeline),
and ``load_extension_file`` refuses it loudly so ``hermes profile install``
on an agents/<name>/ directory cannot emit a Hermes record.
"""

from __future__ import annotations

import pathlib

import pytest
import yaml

from gitops_emitter.harness.hermes import GitopsEmitterError, load_extension_file
from gitops_emitter.render import (
    EXTENSION_KEYS_V4,
    EXTENSION_KEYS_V5,
    strip_extension_v4,
    strip_extension_v5,
    validate_extension_v5,
)

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
EXAMPLE = REPO_ROOT / "examples" / "eve-agent" / "agents" / "echo"

V5_HERMES = {
    "contractVersion": 5,
    "requires": [{"capability": "content-board", "inject": {"env": "HERMES_CAP_CONTENT_BOARD_URL"}}],
    "apps": [{"name": "monitoring", "chart": "charts/monitoring", "repo": "local"}],
    "backup": {"schedule": "0 3 * * *", "retention": 14},
}

V5_EVE = {
    "contractVersion": 5,
    "runtime": {
        "kind": "eve",
        "envRequires": ["AI_GATEWAY_API_KEY", {"name": "ECHO_GREETING", "required": False, "secret": False}],
    },
}


class TestValidation:
    def test_hermes_v5_validates(self):
        validate_extension_v5(V5_HERMES)

    def test_eve_v5_validates(self):
        validate_extension_v5(V5_EVE)

    def test_runtime_kind_hermes_is_not_a_spelling(self):
        with pytest.raises(GitopsEmitterError, match="runtime/kind"):
            validate_extension_v5({"contractVersion": 5, "runtime": {"kind": "hermes"}})

    def test_env_names_follow_the_record_rule(self):
        with pytest.raises(GitopsEmitterError, match="envRequires"):
            validate_extension_v5({"contractVersion": 5, "runtime": {"kind": "eve", "envRequires": ["lower"]}})

    def test_marker_four_does_not_validate_as_five(self):
        with pytest.raises(GitopsEmitterError, match="contractVersion"):
            validate_extension_v5({"contractVersion": 4})

    def test_example_eve_agent_validates(self):
        doc = yaml.safe_load((EXAMPLE / "hermes-gitops.yaml").read_text(encoding="utf-8"))
        validate_extension_v5(doc)
        assert doc["runtime"]["kind"] == "eve"
        names = [e if isinstance(e, str) else e["name"] for e in doc["runtime"]["envRequires"]]
        assert "ANTHROPIC_API_KEY" in names


class TestStrip:
    def test_allowlist_is_v4_plus_runtime(self):
        assert set(EXTENSION_KEYS_V5) == set(EXTENSION_KEYS_V4) | {"runtime"}

    def test_hermes_v5_strips_byte_identical_to_v4(self):
        as_v4 = dict(V5_HERMES, contractVersion=4)
        assert strip_extension_v5(V5_HERMES) == strip_extension_v4(as_v4)

    def test_runtime_block_is_stripped(self):
        out = strip_extension_v5(dict(V5_EVE, backup={"schedule": "0 3 * * *"}))
        assert "runtime" not in out
        assert "contractVersion" not in out
        assert out == {"backup": {"schedule": "0 3 * * *"}}


class TestLoadDispatch:
    def test_hermes_v5_file_loads_and_strips(self, tmp_path):
        (tmp_path / "hermes-gitops.yaml").write_text(yaml.safe_dump(V5_HERMES), encoding="utf-8")
        out = load_extension_file(tmp_path)
        assert out == strip_extension_v5(V5_HERMES)

    def test_unknown_key_fails_loudly(self, tmp_path):
        (tmp_path / "hermes-gitops.yaml").write_text(
            yaml.safe_dump(dict(V5_HERMES, expose={"services": []})), encoding="utf-8"
        )
        with pytest.raises(GitopsEmitterError, match="unknown key"):
            load_extension_file(tmp_path)

    def test_eve_project_is_refused_by_the_hermes_pipeline(self):
        # The example is a real Eve project: the Hermes record pipeline must
        # name the right tool instead of rendering a record the Hermes chart
        # would try (and fail) to boot.
        with pytest.raises(GitopsEmitterError, match="emit_cli"):
            load_extension_file(EXAMPLE)
