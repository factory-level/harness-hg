"""Unit tests for gitops_emitter/decommission_cli.py (issue #24 [F6])."""

from __future__ import annotations

import pathlib
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from gitops_emitter import decommission_cli  # noqa: E402
from gitops_emitter.harness import hermes as emitter_mod  # noqa: E402
from gitops_emitter.harness.hermes import GitopsEmitterError  # noqa: E402
from gitops_emitter.gitrepo import publish as _publish  # noqa: E402


def publish(*args, **kw):
    """Seed helper. gitrepo's write paths take the ADR-19 allowlist as a
    required keyword (#173); these fixtures write the emitter's own trees."""
    kw.setdefault("allowed_prefixes", ["profiles", "catalog"])
    return _publish(*args, **kw)

AUTHOR = {"name": "hermes-gitops-bot", "email": "hg-bot@users.noreply.github.com"}


@pytest.fixture()
def bare_repo(tmp_path):
    repo = tmp_path / "gitops.git"
    subprocess.run(["git", "init", "--bare", "-q", str(repo)], check=True)
    return repo


def _cfg(bare_repo, tmp_path, **overrides):
    entry = {
        "repo_url": f"file://{bare_repo}",
        "branch": "main",
        "git_author_name": AUTHOR["name"],
        "git_author_email": AUTHOR["email"],
        "scaffold": False,
        "overrides_dir": str(tmp_path / "overrides"),
    }
    entry.update(overrides)
    return {"plugins": {"enabled": ["gitops-emitter"], "entries": {"gitops-emitter": entry}}}


def _ls(bare_repo):
    return subprocess.run(
        ["git", "--git-dir", str(bare_repo), "ls-tree", "-r", "--name-only", "main"],
        capture_output=True, text=True, check=True,
    ).stdout


def test_decommission_by_name_removes_record_and_override(
    bare_repo, tmp_path, monkeypatch
):
    url = f"file://{bare_repo}"
    publish(url, "main", "profiles/support-agent/profile.yaml", "spec: {}\n", "seed", None, AUTHOR)
    overrides_dir = tmp_path / "overrides"
    overrides_dir.mkdir()
    (overrides_dir / "support-agent.yaml").write_text("deployment: {}\n", encoding="utf-8")
    monkeypatch.setattr(
        emitter_mod, "_load_hermes_config", lambda: _cfg(bare_repo, tmp_path)
    )

    sha = decommission_cli.decommission("support-agent", None)
    assert sha
    assert "profiles/support-agent/profile.yaml" not in _ls(bare_repo)
    assert not (overrides_dir / "support-agent.yaml").exists()


def test_decommission_by_source_matches_unique_record(bare_repo, tmp_path, monkeypatch):
    url = f"file://{bare_repo}"
    publish(
        url, "main", "profiles/agent-a/profile.yaml",
        "spec:\n  source: github.com/org/agent-a\n", "seed-a", None, AUTHOR,
    )
    publish(
        url, "main", "profiles/agent-b/profile.yaml",
        "spec:\n  source: github.com/org/agent-b\n", "seed-b", None, AUTHOR,
    )
    monkeypatch.setattr(
        emitter_mod, "_load_hermes_config", lambda: _cfg(bare_repo, tmp_path)
    )

    sha = decommission_cli.decommission(None, "github.com/org/agent-a")
    assert sha
    listing = _ls(bare_repo)
    assert "profiles/agent-a/profile.yaml" not in listing
    assert "profiles/agent-b/profile.yaml" in listing


def test_decommission_absent_record_is_noop(bare_repo, tmp_path, monkeypatch):
    url = f"file://{bare_repo}"
    publish(url, "main", "profiles/keep.yaml", "x\n", "seed", None, AUTHOR)
    monkeypatch.setattr(
        emitter_mod, "_load_hermes_config", lambda: _cfg(bare_repo, tmp_path)
    )
    assert decommission_cli.decommission("gone-agent", None) is None
    assert decommission_cli.decommission(None, "github.com/org/none") is None


def test_pr_mode_routes_through_forge(bare_repo, tmp_path, monkeypatch):
    from gitops_emitter import forge

    url = f"file://{bare_repo}"
    publish(url, "main", "profiles/support-agent/profile.yaml", "spec: {}\n", "seed", None, AUTHOR)
    monkeypatch.setattr(
        emitter_mod,
        "_load_hermes_config",
        lambda: _cfg(bare_repo, tmp_path, mode="pr", pr_auto_merge=True),
    )
    calls = {"opened": 0, "merged": 0}
    monkeypatch.setattr(forge, "require_github_repo", lambda u, c: ("org", "gitops"))
    monkeypatch.setattr(forge, "find_open_pull_request", lambda *a, **k: None)
    monkeypatch.setattr(
        forge,
        "open_pull_request",
        lambda *a, **k: calls.__setitem__("opened", calls["opened"] + 1)
        or {"number": 5, "html_url": "u", "existing": False},
    )
    monkeypatch.setattr(
        forge,
        "merge_pull_request",
        lambda *a, **k: calls.__setitem__("merged", calls["merged"] + 1) or "d" * 40,
    )

    sha = decommission_cli.decommission("support-agent", None)
    assert calls == {"opened": 1, "merged": 1}
    assert sha == "d" * 40
    # base untouched until (mocked) merge; the removal rode the head branch
    assert "profiles/support-agent/profile.yaml" in _ls(bare_repo)


def test_decommission_removes_the_catalogue_entry_too(bare_repo, tmp_path, monkeypatch):
    """ADR-34: the logical catalogue entry leaves with the record, in the
    same commit."""
    url = f"file://{bare_repo}"
    publish(
        url, "main", "profiles/support-agent/profile.yaml", "spec: {}\n", "seed", None, AUTHOR,
        extra_files=[
            ("catalog/profiles/support-agent/contract.yaml", "apps: []\n"),
            ("catalog/profiles/support-agent/provenance.yaml", 'profile: support-agent\nsourceSha: "' + "0" * 40 + '"\n'),
        ],
    )
    monkeypatch.setattr(emitter_mod, "_load_hermes_config", lambda: _cfg(bare_repo, tmp_path))

    sha = decommission_cli.decommission("support-agent", None)
    assert sha
    listing = _ls(bare_repo)
    assert not any(p.startswith("profiles/support-agent/") for p in listing)
    assert not any(p.startswith("catalog/profiles/support-agent/") for p in listing)
