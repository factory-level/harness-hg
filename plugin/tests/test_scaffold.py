"""Tests for gitops_emitter.scaffold — create-if-missing GitOps repo +
app-of-apps bootstrap, against real local bare-repo fixtures plus a mocked
GitHub REST seam.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from gitops_emitter.harness.hermes import GitopsEmitterError
from gitops_emitter.scaffold import (
    _parse_github_owner_repo,
    ensure_repo_and_scaffold,
)

REPO_ROOT = Path(__file__).resolve().parent.parent

# The KNOWN live scaffold tokens (see infra/gitops-template/README.md). Narrower
# than a generic `__[A-Z_]+__` grep on purpose: the template's own header
# comments use that shape to talk *about* the token syntax (e.g.
# "`__DOUBLE_UNDERSCORE__` tokens are..."), which is documentation, not a
# live placeholder, and must not trip this check — mirrors
# infra/scripts/validate-gitops-template.sh's own known_tokens allowlist.
_KNOWN_TOKENS = (
    "__GITOPS_REPO_URL__",
    "__GITOPS_BRANCH__",
    "__HERMES_GITOPS_REPO_URL__",
    "__CHART_REVISION__",
    "__IMAGE_REPOSITORY__",
    "__IMAGE_TAG__",
    "__OPERATOR_SOURCE_REPOS__",
)


def _cfg(repo_url: str, branch: str = "main", **overrides) -> dict:
    cfg = {
        "repo_url": repo_url,
        "branch": branch,
        "git_author_name": "hermes-gitops-bot",
        "git_author_email": "hg-bot@users.noreply.github.com",
        "hermes_gitops_repo_url": "https://github.com/factory-level/harness-hg",
        "chart_revision": "feat/v1",
        "image_repository": "ghcr.io/factory-level/hermes-agent",
        "image_tag": "2026-07-16",
    }
    cfg.update(overrides)
    return cfg


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


def _log(bare_repo: Path, branch: str = "main") -> str:
    result = subprocess.run(
        ["git", "log", branch, "--format=%H %s"],
        cwd=bare_repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _ls(bare_repo: Path, branch: str = "main") -> list:
    result = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", branch],
        cwd=bare_repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.splitlines()


# ---------------------------------------------------------------------------
# scaffold against an empty repo
# ---------------------------------------------------------------------------


class TestScaffoldEmptyRepo:
    def test_pushes_bootstrap_and_profiles_gitkeep(self, bare_repo):
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)

        files = _ls(bare_repo)
        assert "bootstrap/applicationset.yaml" in files
        assert "bootstrap/project.yaml" in files
        assert "bootstrap/values/cluster-values.yaml" in files
        assert "profiles/.gitkeep" in files
        assert "README.md" in files

    def test_commit_message(self, bare_repo):
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)
        assert "gitops-emitter: scaffold app-of-apps bootstrap" in _log(bare_repo)

    def test_tokens_substituted_no_remnants_under_bootstrap(self, bare_repo):
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)

        for rel in (
            "bootstrap/applicationset.yaml",
            "bootstrap/project.yaml",
            "bootstrap/values/cluster-values.yaml",
        ):
            text = _show(bare_repo, rel)
            for token in _KNOWN_TOKENS:
                assert token not in text, f"{rel} still has unsubstituted token {token}"

    def test_applicationset_repo_url_matches_config(self, bare_repo):
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)
        text = _show(bare_repo, "bootstrap/applicationset.yaml")
        assert cfg["repo_url"] in text

    def test_project_yaml_sourcerepos_match_config(self, bare_repo):
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)
        text = _show(bare_repo, "bootstrap/project.yaml")
        assert cfg["repo_url"] in text
        assert cfg["hermes_gitops_repo_url"] in text

    def test_cluster_values_image_substituted(self, bare_repo):
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)
        text = _show(bare_repo, "bootstrap/values/cluster-values.yaml")
        assert cfg["image_repository"] in text
        assert cfg["image_tag"] in text

    def test_readme_not_corrupted_still_documents_tokens(self, bare_repo):
        # README.md is copied verbatim (it becomes the repo's own README and
        # documents the token syntax by naming the literal tokens) — the
        # scaffold step must NOT substitute inside it.
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)
        text = _show(bare_repo, "README.md")
        assert "__GITOPS_REPO_URL__" in text

    def test_scaffolded_tree_is_valid_yaml(self, bare_repo):
        import yaml

        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)
        for rel in (
            "bootstrap/applicationset.yaml",
            "bootstrap/project.yaml",
            "bootstrap/values/cluster-values.yaml",
        ):
            docs = list(yaml.safe_load_all(_show(bare_repo, rel)))
            assert docs and all(isinstance(d, dict) for d in docs)


# ---------------------------------------------------------------------------
# idempotency
# ---------------------------------------------------------------------------


class TestScaffoldIdempotent:
    def test_already_scaffolded_repo_gets_no_new_commit(self, bare_repo):
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)
        log_before = _log(bare_repo)

        ensure_repo_and_scaffold(cfg, None)
        assert _log(bare_repo) == log_before

    def test_second_call_does_not_raise(self, bare_repo):
        cfg = _cfg(_file_url(bare_repo))
        ensure_repo_and_scaffold(cfg, None)
        ensure_repo_and_scaffold(cfg, None)  # must not raise


# ---------------------------------------------------------------------------
# repo-creation path (github.com) — mocked HTTP seam
# ---------------------------------------------------------------------------


class TestRepoCreationGithub:
    def test_missing_github_repo_triggers_create_then_scaffolds(self, tmp_path, monkeypatch):
        # Simulate "repo doesn't exist yet" by pointing repo_url at a
        # github.com URL, but redirecting the actual git operations at a
        # local bare repo that starts out NOT existing, then gets created
        # by our mocked _github_create_repo the moment it's called.
        target_bare = tmp_path / "created.git"
        calls = []

        def fake_create(api_base, owner, repo, token):
            calls.append((api_base, owner, repo, token))
            subprocess.run(["git", "init", "--bare", "-q", str(target_bare)], check=True)

        import gitops_emitter.scaffold as scaffold_mod

        monkeypatch.setattr(scaffold_mod, "_parse_github_owner_repo", lambda url: ("factory-level", "gitops-fleet"))
        monkeypatch.setattr(scaffold_mod, "_github_create_repo", fake_create)
        # repo_url points straight at the local bare-repo path via file://
        # so _repo_exists / the clone step exercise real git, while only
        # the "create" leg is mocked (the seam this module explicitly
        # documents for testing).
        monkeypatch.setattr(scaffold_mod, "_repo_exists", lambda repo_url, token: target_bare.is_dir())

        cfg = _cfg(_file_url(target_bare))
        ensure_repo_and_scaffold(cfg, "fake-token-value")

        assert calls == [("https://api.github.com", "factory-level", "gitops-fleet", "fake-token-value")]
        assert "bootstrap/applicationset.yaml" in _ls(target_bare)

    def test_create_repo_called_with_correct_payload_shape(self, monkeypatch):
        import json
        import urllib.request

        import gitops_emitter.scaffold as scaffold_mod

        captured = {}

        class _FakeResponse:
            status = 201

            def read(self):
                return b'{"full_name": "factory-level/gitops-fleet"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["headers"] = {k.lower(): v for k, v in req.headers.items()}
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _FakeResponse()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

        scaffold_mod._github_create_repo(
            "https://api.github.com", "factory-level", "gitops-fleet", "fake-token"
        )

        assert captured["url"] == "https://api.github.com/orgs/factory-level/repos"
        assert captured["method"] == "POST"
        assert captured["body"] == {"name": "gitops-fleet", "private": True}
        assert captured["headers"]["authorization"] == "Bearer fake-token"

    def test_create_repo_falls_back_to_user_endpoint_on_404(self, monkeypatch):
        import urllib.request
        import urllib.error

        import gitops_emitter.scaffold as scaffold_mod

        calls = []

        class _FakeResponse:
            status = 201

            def read(self):
                return b'{"full_name": "someuser/gitops-fleet"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            calls.append(req.full_url)
            if "/orgs/" in req.full_url:
                raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)
            return _FakeResponse()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

        scaffold_mod._github_create_repo(
            "https://api.github.com", "someuser", "gitops-fleet", "fake-token"
        )

        assert calls == [
            "https://api.github.com/orgs/someuser/repos",
            "https://api.github.com/user/repos",
        ]

    def test_create_repo_raises_scrubbed_error_on_hard_failure(self, monkeypatch):
        import urllib.request
        import urllib.error

        import gitops_emitter.scaffold as scaffold_mod

        def fake_urlopen(req, timeout=None):
            raise urllib.error.HTTPError(
                req.full_url, 403, "Forbidden: token gh_SECRET_TOKEN lacks scope", {}, None
            )

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

        with pytest.raises(GitopsEmitterError) as excinfo:
            scaffold_mod._github_create_repo(
                "https://api.github.com", "someorg", "gitops-fleet", "gh_SECRET_TOKEN"
            )
        assert "gh_SECRET_TOKEN" not in str(excinfo.value)

    def test_create_repo_verifies_full_name_mismatch_org_endpoint(self, monkeypatch):
        import urllib.request

        import gitops_emitter.scaffold as scaffold_mod

        class _FakeResponse:
            status = 201

            def read(self):
                # Token's account is wrong-owner, but configured repo_url expects factory-level
                return b'{"full_name": "wrong-owner/gitops-fleet"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            return _FakeResponse()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

        with pytest.raises(GitopsEmitterError) as excinfo:
            scaffold_mod._github_create_repo(
                "https://api.github.com", "factory-level", "gitops-fleet", "fake-token"
            )
        error_msg = str(excinfo.value)
        assert "wrong-owner/gitops-fleet" in error_msg
        assert "factory-level/gitops-fleet" in error_msg
        assert "token does not belong to factory-level" in error_msg
        assert "fake-token" not in error_msg  # token should not appear in error

    def test_create_repo_verifies_full_name_mismatch_user_endpoint(self, monkeypatch):
        import urllib.request
        import urllib.error

        import gitops_emitter.scaffold as scaffold_mod

        calls = []

        class _FakeResponse:
            status = 201

            def read(self):
                # Token's personal account created the repo under wrong-owner
                return b'{"full_name": "wrong-owner/gitops-fleet"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            calls.append(req.full_url)
            if "/orgs/" in req.full_url:
                raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)
            return _FakeResponse()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

        with pytest.raises(GitopsEmitterError) as excinfo:
            scaffold_mod._github_create_repo(
                "https://api.github.com", "factory-level", "gitops-fleet", "fake-token"
            )
        error_msg = str(excinfo.value)
        assert "wrong-owner/gitops-fleet" in error_msg
        assert "factory-level/gitops-fleet" in error_msg
        assert "token does not belong to factory-level" in error_msg

    def test_create_repo_succeeds_on_full_name_match(self, monkeypatch):
        import urllib.request

        import gitops_emitter.scaffold as scaffold_mod

        class _FakeResponse:
            status = 201

            def read(self):
                return b'{"full_name": "factory-level/gitops-fleet"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            return _FakeResponse()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

        # Should not raise
        scaffold_mod._github_create_repo(
            "https://api.github.com", "factory-level", "gitops-fleet", "fake-token"
        )

    def test_create_repo_succeeds_on_full_name_match_case_insensitive(self, monkeypatch):
        import urllib.request

        import gitops_emitter.scaffold as scaffold_mod

        class _FakeResponse:
            status = 201

            def read(self):
                # Response has mixed case, but should still match when lowercased
                return b'{"full_name": "Factory-Level/GitOps-Fleet"}'

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            return _FakeResponse()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

        # Should not raise despite case mismatch
        scaffold_mod._github_create_repo(
            "https://api.github.com", "factory-level", "gitops-fleet", "fake-token"
        )


# ---------------------------------------------------------------------------
# non-github missing repo
# ---------------------------------------------------------------------------


class TestNonGithubMissingRepo:
    def test_raises_readable_error(self, tmp_path):
        missing = tmp_path / "does-not-exist.git"
        cfg = _cfg(_file_url(missing))
        with pytest.raises(GitopsEmitterError) as excinfo:
            ensure_repo_and_scaffold(cfg, "some-token")
        message = str(excinfo.value)
        assert "does not exist" in message or "cannot create" in message.lower()
        assert "github" in message.lower()


class TestMissingGithubRepoWithoutToken:
    def test_raises_readable_error_instead_of_calling_github(self, monkeypatch):
        import gitops_emitter.scaffold as scaffold_mod

        called = []
        monkeypatch.setattr(scaffold_mod, "_repo_exists", lambda repo_url, token: False)
        monkeypatch.setattr(
            scaffold_mod, "_github_create_repo", lambda *a, **kw: called.append((a, kw))
        )

        cfg = _cfg("https://github.com/factory-level/gitops-fleet")
        with pytest.raises(GitopsEmitterError, match="token"):
            ensure_repo_and_scaffold(cfg, None)
        assert called == []


# ---------------------------------------------------------------------------
# _parse_github_owner_repo
# ---------------------------------------------------------------------------


class TestParseGithubOwnerRepo:
    @pytest.mark.parametrize(
        "url,expected",
        [
            ("https://github.com/factory-level/gitops-fleet", ("factory-level", "gitops-fleet")),
            ("https://github.com/factory-level/gitops-fleet.git", ("factory-level", "gitops-fleet")),
            ("github.com/factory-level/gitops-fleet", ("factory-level", "gitops-fleet")),
            ("git@github.com:factory-level/gitops-fleet.git", ("factory-level", "gitops-fleet")),
        ],
    )
    def test_parses_known_forms(self, url, expected):
        assert _parse_github_owner_repo(url) == expected

    @pytest.mark.parametrize(
        "url",
        [
            "https://gitlab.com/factory-level/gitops-fleet.git",
            "https://git.example.com/org/repo.git",
            "/local/path/to/repo.git",
        ],
    )
    def test_non_github_returns_none(self, url):
        assert _parse_github_owner_repo(url) is None




class TestScaffoldLifecycle:
    """ADR-37: fresh scaffolds carry bootstrap/scaffold.yaml (the ownership
    manifest); re-runs reconcile hash-gated - plugin-clean files update,
    operator-edited files are refused, pre-record repos stay untouched."""

    def _seed(self, bare_repo, **cfg_overrides):
        import yaml as _yaml

        cfg = _cfg(_file_url(bare_repo), **cfg_overrides)
        ensure_repo_and_scaffold(cfg, None)
        record = _yaml.safe_load(_show(bare_repo, "bootstrap/scaffold.yaml"))
        return cfg, record

    def test_fresh_scaffold_writes_the_record_with_true_hashes(self, bare_repo):
        import hashlib

        _cfg_, record = self._seed(bare_repo)
        assert record["version"] == 2
        paths = {e["path"] for e in record["managedFiles"]}
        assert "bootstrap/applicationsets/agents.yaml" in paths
        assert "bootstrap/applicationset.yaml" in paths
        for entry in record["managedFiles"]:
            on_disk = _show(bare_repo, entry["path"])
            assert hashlib.sha256(on_disk.encode()).hexdigest() == entry["sha256"], entry["path"]

    def test_rerun_is_a_no_op(self, bare_repo):
        cfg, _record = self._seed(bare_repo)
        before = _log(bare_repo)
        ensure_repo_and_scaffold(cfg, None)
        assert _log(bare_repo) == before  # no reconcile commit

    def test_token_change_updates_clean_managed_files(self, bare_repo):
        self._seed(bare_repo, chart_revision="v1.0.0")
        cfg2 = _cfg(_file_url(bare_repo), chart_revision="v2.0.0")
        ensure_repo_and_scaffold(cfg2, None)
        assert "targetRevision: v2.0.0" in _show(bare_repo, "bootstrap/applicationset.yaml")
        assert "targetRevision: v2.0.0" in _show(bare_repo, "bootstrap/applicationsets/agents.yaml")
        # the record follows the rewrite
        import yaml as _yaml
        record = _yaml.safe_load(_show(bare_repo, "bootstrap/scaffold.yaml"))
        assert record["substitutions"]["chartRevision"] == "v2.0.0"

    def _operator_commit(self, bare_repo, tmp_path, rel, text):
        work = tmp_path / "operator"
        subprocess.run(["git", "clone", "-q", "-b", "main", _file_url(bare_repo), str(work)], check=True)
        (work / rel).write_text(text, encoding="utf-8")
        env = {"GIT_AUTHOR_NAME": "op", "GIT_AUTHOR_EMAIL": "op@x", "GIT_COMMITTER_NAME": "op", "GIT_COMMITTER_EMAIL": "op@x"}
        subprocess.run(["git", "add", "-A"], cwd=work, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "operator: " + rel], cwd=work, check=True, env={**__import__("os").environ, **env})
        subprocess.run(["git", "push", "-q", "origin", "main"], cwd=work, check=True)

    def test_fresh_scaffold_renders_only_the_platform_repos(self, bare_repo):
        cfg, _record = self._seed(bare_repo)
        text = _show(bare_repo, "bootstrap/project.yaml")
        assert "__OPERATOR_SOURCE_REPOS__" not in text
        import yaml as _yaml
        doc = _yaml.safe_load(text)
        assert doc["spec"]["sourceRepos"] == [cfg["repo_url"], cfg["hermes_gitops_repo_url"]]

    def test_cluster_values_source_repos_render_into_project_yaml(self, bare_repo, tmp_path):
        """The environment's half of the allowlist is declared once, in
        cluster-values; the scaffold renders it into the managed
        project.yaml (oci:// twinned scheme-less, #187) instead of
        clobbering operator entries on every reconcile."""
        import yaml as _yaml

        cfg, _record = self._seed(bare_repo)
        values = _yaml.safe_load(_show(bare_repo, "bootstrap/values/cluster-values.yaml"))
        values["appProject"]["sourceRepos"] = [
            "oci://registry.example.dev/hermes/charts",
            "https://qdrant.github.io/qdrant-helm",
        ]
        self._operator_commit(
            bare_repo, tmp_path, "bootstrap/values/cluster-values.yaml", _yaml.safe_dump(values, sort_keys=False)
        )
        ensure_repo_and_scaffold(cfg, None)
        doc = _yaml.safe_load(_show(bare_repo, "bootstrap/project.yaml"))
        assert doc["spec"]["sourceRepos"] == [
            cfg["repo_url"],
            cfg["hermes_gitops_repo_url"],
            "https://qdrant.github.io/qdrant-helm",
            "oci://registry.example.dev/hermes/charts",
            "registry.example.dev/hermes/charts",
        ]
        # the record follows the rewrite, and a re-run is a no-op
        import hashlib
        record = _yaml.safe_load(_show(bare_repo, "bootstrap/scaffold.yaml"))
        sha = {e["path"]: e["sha256"] for e in record["managedFiles"]}["bootstrap/project.yaml"]
        assert hashlib.sha256(_show(bare_repo, "bootstrap/project.yaml").encode()).hexdigest() == sha
        before = _log(bare_repo)
        ensure_repo_and_scaffold(cfg, None)
        assert _log(bare_repo) == before

    @pytest.mark.parametrize(
        "text",
        [
            "appProject:\n  sourceRepos: not-a-list\n",
            # a valid YAML string that would change the rendered node
            'appProject:\n  sourceRepos: ["https://repo.example/charts # mirror"]\n',
            'appProject:\n  sourceRepos: ["oci://x/y\\n    - https://injected"]\n',
        ],
    )
    def test_malformed_cluster_values_source_repos_refuse(self, bare_repo, tmp_path, text):
        cfg, _record = self._seed(bare_repo)
        self._operator_commit(bare_repo, tmp_path, "bootstrap/values/cluster-values.yaml", text)
        with pytest.raises(GitopsEmitterError, match="sourceRepos must be a list"):
            ensure_repo_and_scaffold(cfg, None)

    def test_operator_edited_file_is_refused(self, bare_repo, tmp_path):
        cfg, _record = self._seed(bare_repo, chart_revision="v1.0.0")
        # operator edits a managed file directly
        work = tmp_path / "operator"
        subprocess.run(["git", "clone", "-q", "-b", "main", _file_url(bare_repo), str(work)], check=True)
        f = work / "bootstrap" / "applicationset.yaml"
        f.write_text(f.read_text() + "# operator note\n")
        subprocess.run(["git", "-C", str(work), "commit", "-aqm", "operator edit"], check=True,
                       env={**__import__("os").environ, "GIT_AUTHOR_NAME": "op", "GIT_AUTHOR_EMAIL": "op@x",
                            "GIT_COMMITTER_NAME": "op", "GIT_COMMITTER_EMAIL": "op@x"})
        subprocess.run(["git", "-C", str(work), "push", "-q", "origin", "main"], check=True)

        cfg2 = _cfg(_file_url(bare_repo), chart_revision="v2.0.0")
        ensure_repo_and_scaffold(cfg2, None)
        # the edited file kept the operator's content AND the old revision
        text = _show(bare_repo, "bootstrap/applicationset.yaml")
        assert "# operator note" in text
        assert "targetRevision: v1.0.0" in text
        # a clean sibling still updated
        assert "targetRevision: v2.0.0" in _show(bare_repo, "bootstrap/applicationsets/agents.yaml")

    def test_pre_lifecycle_repo_is_left_untouched(self, bare_repo, tmp_path):
        cfg, _record = self._seed(bare_repo)
        # simulate a pre-record repo: remove scaffold.yaml
        work = tmp_path / "strip"
        subprocess.run(["git", "clone", "-q", "-b", "main", _file_url(bare_repo), str(work)], check=True)
        subprocess.run(["git", "-C", str(work), "rm", "-q", "bootstrap/scaffold.yaml"], check=True)
        subprocess.run(["git", "-C", str(work), "commit", "-qm", "strip record"], check=True,
                       env={**__import__("os").environ, "GIT_AUTHOR_NAME": "op", "GIT_AUTHOR_EMAIL": "op@x",
                            "GIT_COMMITTER_NAME": "op", "GIT_COMMITTER_EMAIL": "op@x"})
        subprocess.run(["git", "-C", str(work), "push", "-q", "origin", "main"], check=True)
        before = _log(bare_repo)
        ensure_repo_and_scaffold(_cfg(_file_url(bare_repo), chart_revision="v9.9.9"), None)
        assert _log(bare_repo) == before  # nothing committed

    def test_operator_deleted_file_is_not_recreated(self, bare_repo, tmp_path):
        cfg, _record = self._seed(bare_repo)
        work = tmp_path / "delete"
        subprocess.run(["git", "clone", "-q", "-b", "main", _file_url(bare_repo), str(work)], check=True)
        subprocess.run(["git", "-C", str(work), "rm", "-q", "bootstrap/applicationsets/endpoints.yaml"], check=True)
        subprocess.run(["git", "-C", str(work), "commit", "-qm", "operator removes endpoints generator"], check=True,
                       env={**__import__("os").environ, "GIT_AUTHOR_NAME": "op", "GIT_AUTHOR_EMAIL": "op@x",
                            "GIT_COMMITTER_NAME": "op", "GIT_COMMITTER_EMAIL": "op@x"})
        subprocess.run(["git", "-C", str(work), "push", "-q", "origin", "main"], check=True)

        ensure_repo_and_scaffold(_cfg(_file_url(bare_repo), chart_revision="v3.0.0"), None)
        listing = subprocess.run(
            ["git", "--git-dir", str(bare_repo), "ls-tree", "-r", "--name-only", "main"],
            check=True, capture_output=True, text=True,
        ).stdout
        assert "bootstrap/applicationsets/endpoints.yaml" not in listing  # deletion respected


class TestBranchProtection:
    """Server-side pull-request enforcement (ADR-95, #179).

    ADR-2 says every change goes through a pull request; ADR-12 says an
    SRE agent's strongest action is opening one. Both were enforced
    entirely client-side, so the boundary the whole safety model rests on
    was a convention. These tests cover the mechanism AND the two
    properties that make it safe to have: it ships disabled, and the
    runtime identity cannot reach it.
    """

    def _capture_urlopen(self, monkeypatch, status=200, body=b"{}"):
        import urllib.request

        captured: dict = {}

        class _FakeResponse:
            def __init__(self):
                self.status = status

            def read(self):
                return body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["headers"] = {k.lower(): v for k, v in req.headers.items()}
            captured["body"] = json.loads(req.data.decode("utf-8")) if req.data else None
            return _FakeResponse()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        return captured

    def test_requires_a_pull_request_and_forbids_force_push(self, monkeypatch):
        import gitops_emitter.scaffold as scaffold_mod

        captured = self._capture_urlopen(monkeypatch)
        scaffold_mod._github_protect_branch(
            "https://api.github.com", "factory-level", "gitops-fleet", "main", "tok", 0
        )

        assert captured["url"] == (
            "https://api.github.com/repos/factory-level/gitops-fleet/branches/main/protection"
        )
        assert captured["method"] == "PUT"
        body = captured["body"]
        # The PR requirement itself - the property ADR-2 and ADR-12 need.
        assert body["required_pull_request_reviews"]["required_approving_review_count"] == 0
        # A force push would let the runtime rewrite the branch and bypass
        # the gate entirely, which is the same hole with extra steps.
        assert body["allow_force_pushes"] is False
        assert body["allow_deletions"] is False
        # CI is not a precondition this platform can assume exists.
        assert body["required_status_checks"] is None

    def test_a_branch_name_with_a_slash_addresses_the_right_endpoint(self, monkeypatch):
        """`release/production` is an ordinary branch name.

        Interpolated raw it adds path segments, so GitHub addresses
        something else entirely and answers 404 - which this module
        reports as "the branch does not exist yet (seeding did not
        happen)", sending the operator to look at seeding instead of at
        the name they configured. Found by Codex reviewing wave 2.
        """
        import gitops_emitter.scaffold as scaffold_mod

        captured = self._capture_urlopen(monkeypatch)
        scaffold_mod._github_protect_branch(
            "https://api.github.com", "factory-level", "gitops-fleet", "release/production", "tok", 0
        )
        assert captured["url"] == (
            "https://api.github.com/repos/factory-level/gitops-fleet"
            "/branches/release%2Fproduction/protection"
        )
        # The slash must not survive as a separator - that is the whole
        # bug, and a `safe="/"` encode would silently reintroduce it.
        assert "/branches/release/production/" not in captured["url"]

    def test_owner_and_repo_are_encoded_too(self, monkeypatch):
        # Less likely to matter than the branch, but the same class of
        # mistake, and free to close while we are here.
        import gitops_emitter.scaffold as scaffold_mod

        captured = self._capture_urlopen(monkeypatch)
        scaffold_mod._github_protect_branch(
            "https://api.github.com", "own er", "re po", "main", "tok", 0
        )
        assert "/repos/own%20er/re%20po/" in captured["url"]

    def test_zero_reviewers_is_the_solo_operator_default(self, monkeypatch):
        """A pull request is still REQUIRED; one person can satisfy it.

        GitHub cannot express "a PR is required but you may approve your
        own", so 1 is the smallest count that would lock out a solo
        operator entirely - which would make the gate unusable for the
        deployment shape this platform actually has.
        """
        import gitops_emitter.scaffold as scaffold_mod

        captured = self._capture_urlopen(monkeypatch)
        scaffold_mod._github_protect_branch(
            "https://api.github.com", "o", "r", "main", "tok", 0
        )
        assert captured["body"]["required_pull_request_reviews"] is not None

    def test_a_contents_only_token_fails_with_the_reason(self, monkeypatch):
        import gitops_emitter.scaffold as scaffold_mod

        monkeypatch.setattr(
            scaffold_mod, "_http_request", lambda *a, **k: (403, '{"message":"Resource not accessible"}')
        )
        with pytest.raises(GitopsEmitterError) as exc:
            scaffold_mod._github_protect_branch(
                "https://api.github.com", "o", "r", "main", "tok", 0
            )
        # Names the missing permission AND the way out, because the most
        # likely cause is the runtime token being used for a bootstrap job.
        assert "administration: write" in str(exc.value)
        assert "gitopsBranchProtection" in str(exc.value)

    def test_a_404_says_the_branch_may_not_exist_yet(self, monkeypatch):
        import gitops_emitter.scaffold as scaffold_mod

        monkeypatch.setattr(scaffold_mod, "_http_request", lambda *a, **k: (404, "{}"))
        with pytest.raises(GitopsEmitterError) as exc:
            scaffold_mod._github_protect_branch(
                "https://api.github.com", "o", "r", "main", "tok", 0
            )
        assert "seeding did not" in str(exc.value)

    def test_it_ships_disabled(self, tmp_path, monkeypatch):
        """The whole feature is off unless an operator asks (ADR-95).

        Turning it on changes how an existing environment's reconcile loop
        behaves. That is the operator's decision about their own live
        system, not a default a platform release makes for them.
        """
        import gitops_emitter.scaffold as scaffold_mod

        called: list = []
        monkeypatch.setattr(scaffold_mod, "_repo_exists", lambda *a, **k: True)
        monkeypatch.setattr(scaffold_mod, "_scaffold_repo", lambda *a, **k: None)
        monkeypatch.setattr(
            scaffold_mod, "_github_protect_branch", lambda *a, **k: called.append(a)
        )

        scaffold_mod.ensure_repo_and_scaffold(
            {"repo_url": "https://github.com/o/r", "branch": "main"}, "tok"
        )
        assert called == []

    def test_the_runtime_config_has_no_way_to_ask_for_it(self):
        """#179: the BOOTSTRAP identity configures protection; the RUNTIME
        identity cannot change it - otherwise the agent can remove its own
        limit.

        This is structural rather than a permission check:
        `load_plugin_config` never produces the key, so the emitter's own
        `ensure_repo_and_scaffold` call cannot reach the protection code
        no matter what is in config.yaml.
        """
        import gitops_emitter.harness.hermes as emitter_mod

        entry = {"repo_url": "https://github.com/o/r", "branch_protection": True}
        cfg = {"plugins": {"entries": {"gitops-emitter": entry}}}
        loaded = emitter_mod.load_plugin_config.__wrapped__ if hasattr(
            emitter_mod.load_plugin_config, "__wrapped__"
        ) else emitter_mod.load_plugin_config
        import unittest.mock as mock

        with mock.patch.object(emitter_mod, "_load_hermes_config", lambda: cfg):
            resolved = loaded()
        assert "branch_protection" not in resolved
        assert "required_reviewers" not in resolved

    def test_protection_is_applied_after_seeding(self, monkeypatch):
        """Order matters: the branch has to exist before it can be
        protected, and protecting first would block the push that creates
        it."""
        import gitops_emitter.scaffold as scaffold_mod

        order: list = []
        monkeypatch.setattr(scaffold_mod, "_repo_exists", lambda *a, **k: True)
        monkeypatch.setattr(
            scaffold_mod, "_scaffold_repo", lambda *a, **k: order.append("seed")
        )
        monkeypatch.setattr(
            scaffold_mod, "_github_protect_branch", lambda *a, **k: order.append("protect")
        )

        scaffold_mod.ensure_repo_and_scaffold(
            {
                "repo_url": "https://github.com/o/r",
                "branch": "main",
                "branch_protection": True,
            },
            "tok",
        )
        assert order == ["seed", "protect"]

    def test_a_non_github_remote_refuses_rather_than_pretending(self, monkeypatch):
        import gitops_emitter.scaffold as scaffold_mod

        monkeypatch.setattr(scaffold_mod, "_repo_exists", lambda *a, **k: True)
        monkeypatch.setattr(scaffold_mod, "_scaffold_repo", lambda *a, **k: None)
        with pytest.raises(GitopsEmitterError) as exc:
            scaffold_mod.ensure_repo_and_scaffold(
                {
                    "repo_url": "https://gitlab.example/o/r.git",
                    "branch": "main",
                    "branch_protection": True,
                },
                "tok",
            )
        # Silently skipping would leave an operator believing the gate is
        # on when it is not - the exact failure #179 exists to prevent.
        assert "not a github.com URL" in str(exc.value)
