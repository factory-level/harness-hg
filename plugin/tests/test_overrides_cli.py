"""Unit tests for gitops_emitter/overrides_cli.py (issue #11 [E2])."""

from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from gitops_emitter import overrides_cli  # noqa: E402


@pytest.fixture()
def overrides_dir(tmp_path, monkeypatch):
    d = tmp_path / "overrides"
    monkeypatch.setenv("HERMES_GITOPS_OVERRIDES_DIR", str(d))
    return d


def test_set_get_list_unset_roundtrip(overrides_dir, tmp_path, capsys):
    source = tmp_path / "src.yaml"
    source.write_text("deployment:\n  diskSizeGb: 42\n", encoding="utf-8")

    assert overrides_cli.main(["set", "support-agent", str(source)]) == 0
    written = (overrides_dir / "support-agent.yaml").read_text(encoding="utf-8")
    # Content byte-identical, plus a provenance stamp naming THIS verb as
    # the writer (ADR-4, #180). `set` is the explicit local path; the
    # stamp is what lets a later read tell it from a hand-authored file,
    # which is not an authoring path at all.
    assert written.endswith("deployment:\n  diskSizeGb: 42\n")
    assert "# gitops-emitter:written-by overrides_cli" in written

    assert overrides_cli.main(["list"]) == 0
    assert overrides_cli.main(["get", "support-agent"]) == 0
    out = capsys.readouterr().out
    assert "support-agent" in out and "diskSizeGb: 42" in out

    assert overrides_cli.main(["unset", "support-agent"]) == 0
    assert not (overrides_dir / "support-agent.yaml").exists()
    # unset again: explicit no-op, still success
    assert overrides_cli.main(["unset", "support-agent"]) == 0


def test_get_missing_exits_1(overrides_dir, capsys):
    assert overrides_cli.main(["get", "support-agent"]) == 1
    assert "no persisted override" in capsys.readouterr().err


def test_set_rejects_non_mapping(overrides_dir, tmp_path, capsys):
    source = tmp_path / "src.yaml"
    source.write_text("- a\n- list\n", encoding="utf-8")
    assert overrides_cli.main(["set", "support-agent", str(source)]) == 1
    assert "YAML mapping" in capsys.readouterr().err


def test_invalid_name_rejected(overrides_dir, capsys):
    assert overrides_cli.main(["get", "Bad-Name"]) == 1


def test_usage_on_bad_args(overrides_dir, capsys):
    assert overrides_cli.main(["frobnicate"]) == 2
    assert "usage:" in capsys.readouterr().err
