"""Tests for gitops_emitter.gitrepo — publish() against real local bare-repo
fixtures (git init --bare), exercised entirely through the system git
binary, no mocking of git itself.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from gitops_emitter.harness.hermes import GitopsEmitterError
from gitops_emitter.gitrepo import (
    _clone_or_init,
    _identity_env,
    _push_with_retry,
    _scrub,
    _scrub_tempdir,
    _token_url,
    PathNotAllowed,
    publish as _publish,
    publish_to_head as _publish_to_head,
    remove_path as _remove_path,
)

AUTHOR = {"name": "hermes-gitops-bot", "email": "hg-bot@users.noreply.github.com"}

# The trees the emitter owns (ADR-19, #173). Every write path in gitrepo
# now takes this allowlist as a REQUIRED keyword - there is deliberately no
# permissive default, because a default is how a new call site escapes the
# boundary the parameter exists to create. These wrappers supply the real
# emitter's value so the tests below exercise git mechanics; the allowlist
# itself has its own class at the bottom of this file.
GENERATED_TREES = ["profiles", "catalog"]


def publish(*args, **kw):
    kw.setdefault("allowed_prefixes", GENERATED_TREES)
    return _publish(*args, **kw)


def publish_to_head(*args, **kw):
    kw.setdefault("allowed_prefixes", GENERATED_TREES)
    return _publish_to_head(*args, **kw)


def remove_path(*args, **kw):
    kw.setdefault("allowed_prefixes", GENERATED_TREES)
    return _remove_path(*args, **kw)


# ---------------------------------------------------------------------------
# fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def bare_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "gitops.git"
    subprocess.run(["git", "init", "--bare", "-q", str(repo)], check=True)
    return repo


def _file_url(path: Path) -> str:
    return f"file://{path}"


def _seed_bare_repo(bare_repo: Path, branch: str = "main", filename: str = "SEED.md") -> None:
    """Push one commit to *branch* so the repo is non-empty."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        seed = Path(tmp) / "seed"
        subprocess.run(["git", "init", "-q", "-b", branch, str(seed)], check=True)
        (seed / filename).write_text("seed\n", encoding="utf-8")
        env = _identity_env(AUTHOR)
        subprocess.run(["git", "add", "-A"], cwd=seed, check=True, env=_full_env(env))
        subprocess.run(
            ["git", "commit", "-q", "-m", "seed"], cwd=seed, check=True, env=_full_env(env)
        )
        subprocess.run(
            ["git", "push", "-q", _file_url(bare_repo), f"HEAD:refs/heads/{branch}"],
            cwd=seed,
            check=True,
            env=_full_env(env),
        )


def _full_env(extra: dict) -> dict:
    import os

    env = dict(os.environ)
    env.update(extra)
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _bare_log(bare_repo: Path, branch: str = "main") -> str:
    result = subprocess.run(
        ["git", "log", branch, "--format=%H %an|%ae %s"],
        cwd=bare_repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _bare_file_content(bare_repo: Path, rel_path: str, branch: str = "main") -> bytes:
    result = subprocess.run(
        ["git", "show", f"{branch}:{rel_path}"],
        cwd=bare_repo,
        capture_output=True,
        check=True,
    )
    return result.stdout


# ---------------------------------------------------------------------------
# _scrub / _scrub_tempdir / _token_url — pure helpers
# ---------------------------------------------------------------------------


class TestScrubHelpers:
    def test_scrub_removes_token(self):
        assert _scrub("push failed: bad creds SECRET123", "SECRET123") == "push failed: bad creds ***"

    def test_scrub_removes_all_occurrences(self):
        assert _scrub("SECRET SECRET SECRET", "SECRET") == "*** *** ***"

    def test_scrub_none_token_is_noop(self):
        assert _scrub("text with SECRET", None) == "text with SECRET"

    def test_scrub_empty_text(self):
        assert _scrub("", "SECRET") == ""

    def test_scrub_tempdir_replaces_cwd_path(self, tmp_path):
        workdir = tmp_path / "repo"
        text = f"fatal: could not open '{workdir}/foo'"
        assert str(workdir) not in _scrub_tempdir(text, workdir)

    def test_scrub_tempdir_none_cwd_is_noop(self):
        assert _scrub_tempdir("some text", None) == "some text"

    def test_token_url_embeds_token_for_https(self):
        url = _token_url("https://github.com/org/repo.git", "TOK123")
        assert url == "https://x-access-token:TOK123@github.com/org/repo.git"

    def test_token_url_leaves_file_url_unchanged(self, tmp_path):
        raw = _file_url(tmp_path)
        assert _token_url(raw, "TOK123") == raw

    def test_token_url_leaves_ssh_unchanged(self):
        raw = "git@github.com:org/repo.git"
        assert _token_url(raw, "TOK123") == raw

    def test_token_url_no_token_returns_original(self):
        raw = "https://github.com/org/repo.git"
        assert _token_url(raw, None) == raw


# ---------------------------------------------------------------------------
# publish() — happy paths
# ---------------------------------------------------------------------------


class TestPublishSuccess:
    def test_first_push_to_empty_repo_creates_commit(self, bare_repo):
        sha = publish(
            _file_url(bare_repo),
            "main",
            "profiles/support-agent/profile.yaml",
            "spec: {}\n",
            "gitops-emitter: install support-agent",
            None,
            AUTHOR,
        )
        assert sha
        assert len(sha) == 40
        assert _bare_file_content(bare_repo, "profiles/support-agent/profile.yaml") == b"spec: {}\n"

    def test_push_to_existing_non_empty_branch(self, bare_repo):
        _seed_bare_repo(bare_repo)
        sha = publish(
            _file_url(bare_repo),
            "main",
            "profiles/support-agent/profile.yaml",
            "spec: {}\n",
            "gitops-emitter: install support-agent",
            None,
            AUTHOR,
        )
        assert sha
        # Both the seed file and our new file must be present.
        assert _bare_file_content(bare_repo, "SEED.md") == b"seed\n"
        assert _bare_file_content(bare_repo, "profiles/support-agent/profile.yaml") == b"spec: {}\n"

    def test_byte_identical_republish_is_noop(self, bare_repo):
        content = "spec: {}\n"
        first_sha = publish(
            _file_url(bare_repo),
            "main",
            "profiles/support-agent/profile.yaml",
            content,
            "gitops-emitter: install support-agent",
            None,
            AUTHOR,
        )
        assert first_sha is not None

        log_before = _bare_log(bare_repo)
        second_sha = publish(
            _file_url(bare_repo),
            "main",
            "profiles/support-agent/profile.yaml",
            content,
            "gitops-emitter: install support-agent (again)",
            None,
            AUTHOR,
        )
        assert second_sha is None
        assert _bare_log(bare_repo) == log_before  # no new commit was created

    def test_changed_content_creates_new_commit(self, bare_repo):
        publish(
            _file_url(bare_repo),
            "main",
            "profiles/support-agent/profile.yaml",
            "spec: {a: 1}\n",
            "gitops-emitter: install support-agent",
            None,
            AUTHOR,
        )
        log_before = _bare_log(bare_repo)
        second_sha = publish(
            _file_url(bare_repo),
            "main",
            "profiles/support-agent/profile.yaml",
            "spec: {a: 2}\n",
            "gitops-emitter: update support-agent",
            None,
            AUTHOR,
        )
        assert second_sha is not None
        assert _bare_log(bare_repo) != log_before
        assert _bare_file_content(bare_repo, "profiles/support-agent/profile.yaml") == b"spec: {a: 2}\n"

    def test_author_identity_from_config_not_global_gitconfig(self, bare_repo):
        publish(
            _file_url(bare_repo),
            "main",
            "profiles/support-agent/profile.yaml",
            "spec: {}\n",
            "gitops-emitter: install support-agent",
            None,
            AUTHOR,
        )
        log = _bare_log(bare_repo)
        assert "hermes-gitops-bot|hg-bot@users.noreply.github.com" in log
        # Must NOT pick up this test environment's global git identity.
        global_email = subprocess.run(
            ["git", "config", "--global", "user.email"], capture_output=True, text=True
        ).stdout.strip()
        if global_email:
            assert global_email not in log


# ---------------------------------------------------------------------------
# publish() — non-fast-forward rebase + retry
# ---------------------------------------------------------------------------


class TestNonFastForwardRetry:
    def test_rebase_retry_succeeds_on_disjoint_racing_commit(self, bare_repo, tmp_path):
        _seed_bare_repo(bare_repo)
        git_env = _identity_env(AUTHOR)
        url = _file_url(bare_repo)

        workdir_ours = tmp_path / "ours"
        _clone_or_init(url, "main", workdir_ours, None, git_env)
        (workdir_ours / "profiles").mkdir()
        (workdir_ours / "profiles" / "support-agent.yaml").write_text("spec: {}\n")
        subprocess.run(["git", "add", "-A"], cwd=workdir_ours, check=True, env=_full_env(git_env))
        subprocess.run(
            ["git", "commit", "-q", "-m", "ours"],
            cwd=workdir_ours,
            check=True,
            env=_full_env(git_env),
        )

        # A second, independent clone races ahead and pushes first, touching
        # a completely different file.
        workdir_racer = tmp_path / "racer"
        _clone_or_init(url, "main", workdir_racer, None, git_env)
        (workdir_racer / "other-agent.yaml").write_text("spec: racer\n")
        subprocess.run(["git", "add", "-A"], cwd=workdir_racer, check=True, env=_full_env(git_env))
        subprocess.run(
            ["git", "commit", "-q", "-m", "racer"],
            cwd=workdir_racer,
            check=True,
            env=_full_env(git_env),
        )
        subprocess.run(
            ["git", "push", "-q", "origin", "HEAD:refs/heads/main"],
            cwd=workdir_racer,
            check=True,
            env=_full_env(git_env),
        )

        # Our push should now be rejected, rebase, and retry successfully.
        _push_with_retry(workdir_ours, "main", None, git_env)

        assert _bare_file_content(bare_repo, "other-agent.yaml") == b"spec: racer\n"
        assert (
            _bare_file_content(bare_repo, "profiles/support-agent.yaml") == b"spec: {}\n"
        )

    def test_rebase_conflict_on_same_file_raises_and_aborts(self, bare_repo, tmp_path):
        _seed_bare_repo(bare_repo)
        git_env = _identity_env(AUTHOR)
        url = _file_url(bare_repo)

        workdir_ours = tmp_path / "ours"
        _clone_or_init(url, "main", workdir_ours, None, git_env)
        (workdir_ours / "SEED.md").write_text("ours\n")
        subprocess.run(["git", "add", "-A"], cwd=workdir_ours, check=True, env=_full_env(git_env))
        subprocess.run(
            ["git", "commit", "-q", "-m", "ours"],
            cwd=workdir_ours,
            check=True,
            env=_full_env(git_env),
        )

        workdir_racer = tmp_path / "racer"
        _clone_or_init(url, "main", workdir_racer, None, git_env)
        (workdir_racer / "SEED.md").write_text("racer\n")
        subprocess.run(["git", "add", "-A"], cwd=workdir_racer, check=True, env=_full_env(git_env))
        subprocess.run(
            ["git", "commit", "-q", "-m", "racer"],
            cwd=workdir_racer,
            check=True,
            env=_full_env(git_env),
        )
        subprocess.run(
            ["git", "push", "-q", "origin", "HEAD:refs/heads/main"],
            cwd=workdir_racer,
            check=True,
            env=_full_env(git_env),
        )

        with pytest.raises(GitopsEmitterError):
            _push_with_retry(workdir_ours, "main", None, git_env)

        # Rebase must have been aborted, not left half-applied.
        status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--branch"],
            cwd=workdir_ours,
            capture_output=True,
            text=True,
            check=True,
        )
        assert "rebasing" not in status.stdout.lower()


# ---------------------------------------------------------------------------
# publish() — hard failures + token scrubbing
# ---------------------------------------------------------------------------


class TestHardFailuresAndScrubbing:
    def test_missing_repo_raises(self, tmp_path):
        gone = tmp_path / "does-not-exist.git"
        with pytest.raises(GitopsEmitterError):
            publish(
                _file_url(gone),
                "main",
                "profiles/x/profile.yaml",
                "spec: {}\n",
                "gitops-emitter: install x",
                None,
                AUTHOR,
            )

    def test_missing_repo_error_has_no_tempdir_path(self, tmp_path):
        gone = tmp_path / "does-not-exist.git"
        with pytest.raises(GitopsEmitterError) as excinfo:
            publish(
                _file_url(gone),
                "main",
                "profiles/x/profile.yaml",
                "spec: {}\n",
                "gitops-emitter: install x",
                None,
                AUTHOR,
            )
        assert "gitops_emitter_publish_" not in str(excinfo.value)

    @pytest.mark.parametrize(
        "rel_path",
        ["profiles/x/profile.yaml", "profiles/y/profile.yaml"],
    )
    def test_token_never_appears_in_exception_message(self, rel_path):
        token = "gh_super_secret_token_ABC123XYZ"
        # 127.0.0.1 with a port nobody listens on -> instant connection
        # refused, no real network dependency, no DNS lookup delay.
        unreachable_https = "https://127.0.0.1:1/org/repo.git"
        with pytest.raises(GitopsEmitterError) as excinfo:
            publish(
                unreachable_https,
                "main",
                rel_path,
                "spec: {}\n",
                "gitops-emitter: install x",
                token,
                AUTHOR,
            )
        message = str(excinfo.value)
        assert token not in message

    def test_bad_host_error_is_operator_readable(self):
        token = "gh_super_secret_token_ABC123XYZ"
        unreachable_https = "https://127.0.0.1:1/org/repo.git"
        with pytest.raises(GitopsEmitterError) as excinfo:
            publish(
                unreachable_https,
                "main",
                "profiles/x/profile.yaml",
                "spec: {}\n",
                "gitops-emitter: install x",
                token,
                AUTHOR,
            )
        message = str(excinfo.value)
        assert message  # non-empty, not just an opaque exit code
        assert "gitops-emitter" in message


class TestPublishHeadBranch:
    """Issue #17 [F1]: PR-mode publishing pushes to a per-persona head
    branch freshly reset from base, leaving the base branch untouched."""

    def test_head_branch_created_base_untouched(self, bare_repo):
        url = f"file://{bare_repo}"
        base_sha = publish(url, "main", "profiles/a/profile.yaml", "spec: {}\n", "seed", None, AUTHOR)
        assert base_sha is not None

        head_sha = publish(
            url, "main", "profiles/a/profile.yaml", "spec: {x: 1}\n", "change", None, AUTHOR,
            head_branch="hermes-gitops/a",
        )
        assert head_sha is not None
        # base still at the seed commit; head has the change
        assert _bare_file_content(bare_repo, "profiles/a/profile.yaml", "main") == b"spec: {}\n"
        assert (
            _bare_file_content(bare_repo, "profiles/a/profile.yaml", "hermes-gitops/a")
            == b"spec: {x: 1}\n"
        )

    def test_head_branch_reset_from_base_on_each_change(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/a.yaml", "one\n", "seed", None, AUTHOR)
        publish(url, "main", "profiles/a.yaml", "two\n", "change-one", None, AUTHOR, head_branch="hv/a")
        publish(url, "main", "profiles/a.yaml", "three\n", "change-two", None, AUTHOR, head_branch="hv/a")
        # the stable head branch carries exactly one commit of delta
        # (message tokens are non-hex so a random commit sha can't
        # spuriously contain them)
        log = _bare_log(bare_repo, "hv/a")
        assert "change-two" in log and "change-one" not in log
        assert _bare_file_content(bare_repo, "profiles/a.yaml", "hv/a") == b"three\n"

    def test_byte_identical_vs_base_is_noop_no_head_push(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/a.yaml", "same\n", "seed", None, AUTHOR)
        result = publish(
            url, "main", "profiles/a.yaml", "same\n", "again", None, AUTHOR, head_branch="hv/a"
        )
        assert result is None
        # head branch never created
        refs = subprocess.run(
            ["git", "--git-dir", str(bare_repo), "branch", "--list", "hv/a"],
            capture_output=True, text=True, check=True,
        ).stdout
        assert refs.strip() == ""


class TestPublishToHead:
    """Issue #19 [F2]: the idempotency decision table's git half."""

    def test_base_identical_is_full_noop(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/a.yaml", "same\n", "seed", None, AUTHOR)
        assert publish_to_head(url, "main", "hv/a", "profiles/a.yaml", "same\n", "m", None, AUTHOR) == (None, False)

    def test_changed_pushes_head(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/a.yaml", "one\n", "seed", None, AUTHOR)
        sha, pushed = publish_to_head(url, "main", "hv/a", "profiles/a.yaml", "two\n", "m", None, AUTHOR)
        assert pushed is True and sha
        assert _bare_file_content(bare_repo, "profiles/a.yaml", "hv/a") == b"two\n"
        assert _bare_file_content(bare_repo, "profiles/a.yaml", "main") == b"one\n"

    def test_head_identical_rerun_is_noop_same_sha(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/a.yaml", "one\n", "seed", None, AUTHOR)
        sha1, pushed1 = publish_to_head(url, "main", "hv/a", "profiles/a.yaml", "two\n", "m1", None, AUTHOR)
        sha2, pushed2 = publish_to_head(url, "main", "hv/a", "profiles/a.yaml", "two\n", "m2", None, AUTHOR)
        assert pushed1 is True
        assert pushed2 is False
        assert sha2 == sha1  # existing head commit reused - no force-push churn
        log = _bare_log(bare_repo, "hv/a")
        assert "m1" in log and "m2" not in log

    def test_head_identical_rerun_with_binary_extra_is_noop(self, bare_repo):
        # Icon assets ride extra_files as bytes; the head-parity check must
        # neither crash on binary (text-mode `git show`) nor miss the match
        # (a wrong _blob_sha would force-push churn on every re-run).
        url = f"file://{bare_repo}"
        png = b"\x89PNG\r\n\x1a\n" + bytes(range(256))
        extras = [("catalog/icons/logo.png", png)]
        publish(url, "main", "profiles/a.yaml", "one\n", "seed", None, AUTHOR)
        sha1, pushed1 = publish_to_head(
            url, "main", "hv/a", "profiles/a.yaml", "two\n", "m1", None, AUTHOR, extra_files=extras
        )
        sha2, pushed2 = publish_to_head(
            url, "main", "hv/a", "profiles/a.yaml", "two\n", "m2", None, AUTHOR, extra_files=extras
        )
        assert pushed1 is True
        assert (sha2, pushed2) == (sha1, False)
        assert _bare_file_content(bare_repo, "catalog/icons/logo.png", "hv/a") == png

    def test_removed_extra_in_replace_tree_resets_a_stale_head(self, bare_repo):
        # The head-parity skip must not survive a REMOVAL: a head branch
        # still carrying an icon the new publish set dropped is not
        # "already identical" - the reconciled tree (ADR-42) says so.
        url = f"file://{bare_repo}"
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
        publish(url, "main", "profiles/a.yaml", "one\n", "seed", None, AUTHOR)
        publish_to_head(
            url, "main", "hv/a", "profiles/a.yaml", "two\n", "m1", None, AUTHOR,
            extra_files=[("catalog/x/logo.png", png)], replace_trees=["catalog/x"],
        )
        sha2, pushed2 = publish_to_head(
            url, "main", "hv/a", "profiles/a.yaml", "two\n", "m2", None, AUTHOR,
            extra_files=[], replace_trees=["catalog/x"],
        )
        assert pushed2 is True and sha2
        ls = subprocess.run(
            ["git", "--git-dir", str(bare_repo), "ls-tree", "-r", "--name-only", "hv/a"],
            capture_output=True, text=True, check=True,
        ).stdout
        assert "catalog/x/logo.png" not in ls

    def test_further_change_force_updates_head(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/a.yaml", "one\n", "seed", None, AUTHOR)
        sha1, _ = publish_to_head(url, "main", "hv/a", "profiles/a.yaml", "two\n", "m1", None, AUTHOR)
        sha2, pushed2 = publish_to_head(url, "main", "hv/a", "profiles/a.yaml", "three\n", "m2", None, AUTHOR)
        assert pushed2 is True and sha2 != sha1
        assert _bare_file_content(bare_repo, "profiles/a.yaml", "hv/a") == b"three\n"
        log = _bare_log(bare_repo, "hv/a")
        assert "m2" in log and "m1" not in log


class TestRemovePath:
    """Issue #24 [F6]: decommission's git half."""

    def test_removes_directory_direct(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/a/profile.yaml", "spec: {}\n", "seed", None, AUTHOR)
        sha = remove_path(url, "main", "profiles/a", "decommission a", None, AUTHOR)
        assert sha
        log = _bare_log(bare_repo, "main")
        assert "decommission a" in log
        ls = subprocess.run(
            ["git", "--git-dir", str(bare_repo), "ls-tree", "-r", "--name-only", "main"],
            capture_output=True, text=True, check=True,
        ).stdout
        assert "profiles/a/profile.yaml" not in ls

    def test_absent_path_is_noop(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/keep.yaml", "x\n", "seed", None, AUTHOR)
        assert remove_path(url, "main", "profiles/gone", "m", None, AUTHOR) is None

    def test_head_branch_removal_leaves_base_untouched(self, bare_repo):
        url = f"file://{bare_repo}"
        publish(url, "main", "profiles/a/profile.yaml", "spec: {}\n", "seed", None, AUTHOR)
        sha = remove_path(
            url, "main", "profiles/a", "decommission a", None, AUTHOR, head_branch="hv/a"
        )
        assert sha
        assert _bare_file_content(bare_repo, "profiles/a/profile.yaml", "main") == b"spec: {}\n"
        ls = subprocess.run(
            ["git", "--git-dir", str(bare_repo), "ls-tree", "-r", "--name-only", "hv/a"],
            capture_output=True, text=True, check=True,
        ).stdout
        assert "profiles/a/profile.yaml" not in ls


# ---------------------------------------------------------------------------
# The generated-tree allowlist (ADR-19, #173)
# ---------------------------------------------------------------------------


class TestGeneratedTreeAllowlist:
    """The emitter writes only its own trees, structurally.

    ADR-19 sanctions the GitOps repository as a bounded authoring surface:
    `profiles/` and `catalog/` are the emitter's, `bootstrap/` is the
    operator's after a one-time seed, `platform/` is the operator's
    exclusively. Until now that split was a CONVENTION on this side -
    nothing stopped a write to any path, so a bug in path construction
    could put generated content into an operator's tree and the operator
    would find out by having it overwritten on the next emit.
    """

    def test_a_write_outside_the_generated_trees_is_refused(self, bare_repo):
        with pytest.raises(PathNotAllowed) as exc:
            _publish(
                _file_url(bare_repo), "main",
                "bootstrap/monitoring-grafana.yaml", "spec: {}\n", "nope", None, AUTHOR,
                allowed_prefixes=GENERATED_TREES,
            )
        # The message names the trees, so an operator reading a failed
        # install knows which side of the boundary the bug is on.
        assert "profiles/" in str(exc.value)
        assert "belongs to the operator" in str(exc.value)

    def test_the_operator_tree_is_refused_by_name(self, bare_repo):
        for operator_path in ("platform/my-app.yaml", "bootstrap/project.yaml", "README.md"):
            with pytest.raises(PathNotAllowed):
                _publish(
                    _file_url(bare_repo), "main", operator_path, "x\n", "nope", None, AUTHOR,
                    allowed_prefixes=GENERATED_TREES,
                )

    def test_a_companion_file_outside_the_trees_is_refused(self, bare_repo):
        # The record path being legal is not enough: `extra_files` is how
        # the catalogue rides along, and it is a second path source.
        with pytest.raises(PathNotAllowed):
            _publish(
                _file_url(bare_repo), "main",
                "profiles/a/profile.yaml", "spec: {}\n", "nope", None, AUTHOR,
                extra_files=[("platform/sneaky.yaml", "x\n")],
                allowed_prefixes=GENERATED_TREES,
            )

    def test_a_replace_tree_outside_the_trees_is_refused(self, bare_repo):
        # `replace_trees` DELETES whatever it does not re-list, so an
        # unchecked value here is the most destructive of the three.
        with pytest.raises(PathNotAllowed):
            _publish(
                _file_url(bare_repo), "main",
                "profiles/a/profile.yaml", "spec: {}\n", "nope", None, AUTHOR,
                replace_trees=["bootstrap"],
                allowed_prefixes=GENERATED_TREES,
            )

    def test_a_traversal_that_normalises_out_is_refused(self, bare_repo):
        # A prefix comparison alone would pass this: the string starts
        # with "profiles/", and it resolves to bootstrap/.
        with pytest.raises(PathNotAllowed) as exc:
            _publish(
                _file_url(bare_repo), "main",
                "profiles/../bootstrap/project.yaml", "x\n", "nope", None, AUTHOR,
                allowed_prefixes=GENERATED_TREES,
            )
        assert ".." in str(exc.value)

    def test_an_absolute_path_is_refused(self, bare_repo):
        with pytest.raises(PathNotAllowed):
            _publish(
                _file_url(bare_repo), "main", "/etc/passwd", "x\n", "nope", None, AUTHOR,
                allowed_prefixes=GENERATED_TREES,
            )

    def test_a_sibling_of_an_allowed_prefix_is_not_allowed(self, bare_repo):
        # "profiles-backup/" must not pass a check that compares raw string
        # prefixes - the boundary is a path segment, not a substring.
        with pytest.raises(PathNotAllowed):
            _publish(
                _file_url(bare_repo), "main", "profiles-backup/a.yaml", "x\n", "nope", None, AUTHOR,
                allowed_prefixes=GENERATED_TREES,
            )

    def test_an_empty_allowlist_refuses_everything(self, bare_repo):
        # Fail closed. A caller that forgot to name its trees must not get
        # unrestricted write access as the degenerate case.
        with pytest.raises(PathNotAllowed) as exc:
            _publish(
                _file_url(bare_repo), "main", "profiles/a/profile.yaml", "x\n", "nope", None, AUTHOR,
                allowed_prefixes=[],
            )
        assert "empty path allowlist" in str(exc.value)

    def test_a_removal_outside_the_trees_is_refused(self, bare_repo):
        # Decommission removes paths; the same boundary applies, and here
        # the failure mode is deleting an operator's file.
        with pytest.raises(PathNotAllowed):
            _remove_path(
                _file_url(bare_repo), "main", "bootstrap", "nope", None, AUTHOR,
                allowed_prefixes=GENERATED_TREES,
            )

    def test_the_allowlist_follows_a_configured_profiles_path(self, bare_repo):
        # `profiles_path` is configurable, so the allowlist is passed by
        # the caller rather than hardcoded here - an environment that
        # renames the tree must not lose the boundary.
        sha = _publish(
            _file_url(bare_repo), "main", "records/a/profile.yaml", "spec: {}\n", "seed", None, AUTHOR,
            allowed_prefixes=["records", "catalog"],
        )
        assert sha
        with pytest.raises(PathNotAllowed):
            _publish(
                _file_url(bare_repo), "main", "profiles/a/profile.yaml", "x\n", "nope", None, AUTHOR,
                allowed_prefixes=["records", "catalog"],
            )


class TestProtectedBranchRejection:
    """#140 and #179 have to meet somewhere.

    #140 replaced the install carve-out with `allow_direct_commit`; #179
    makes a direct push actually impossible. With protection on and the
    flag set, the flag must fail LOUDLY rather than appear to work - both
    issues say so, because a silent no-op would be worse than the carve-out
    #140 removed.

    Without this, the failure arrives as "push was rejected
    (non-fast-forward) and the automatic rebase failed", which is wrong and
    sends the operator looking for a concurrent writer that does not exist.
    """

    def _rejection(self, stderr: str):
        return subprocess.CompletedProcess(args=["git", "push"], returncode=1, stdout="", stderr=stderr)

    def test_a_protected_branch_rejection_names_the_rule(self, tmp_path):
        from gitops_emitter.gitrepo import _raise_if_branch_protected

        # GitHub's actual wording.
        stderr = (
            "remote: error: GH006: Protected branch update failed for refs/heads/main.\n"
            "remote: error: Changes must be made through a pull request.\n"
            "! [remote rejected] main -> main (protected branch hook declined)\n"
        )
        with pytest.raises(GitopsEmitterError) as exc:
            _raise_if_branch_protected(self._rejection(stderr), "main", None, tmp_path)
        msg = str(exc.value)
        assert "protected branch requiring a pull request" in msg
        # It says this is the gate WORKING, so the operator does not go
        # hunting for a transient fault.
        assert "not a transient error" in msg
        # And it says the escape hatch cannot help, which is the exact
        # thing someone who set it will assume.
        assert "allow_direct_commit" in msg

    def test_the_review_requirement_wording_is_recognised_too(self, tmp_path):
        from gitops_emitter.gitrepo import _raise_if_branch_protected

        stderr = "remote: error: At least 1 approving review is required by reviewers with write access.\n"
        with pytest.raises(GitopsEmitterError):
            _raise_if_branch_protected(self._rejection(stderr), "main", None, tmp_path)

    def test_an_ordinary_rejection_is_left_alone(self, tmp_path):
        """A non-fast-forward must still take the rebase-and-retry path -
        misclassifying it would turn routine concurrency into a hard
        failure."""
        from gitops_emitter.gitrepo import _raise_if_branch_protected

        stderr = (
            "! [rejected] main -> main (fetch first)\n"
            "error: failed to push some refs\n"
            "hint: Updates were rejected because the remote contains work that you do not have\n"
        )
        _raise_if_branch_protected(self._rejection(stderr), "main", None, tmp_path)

    def test_the_token_never_appears_in_the_message(self, tmp_path):
        from gitops_emitter.gitrepo import _raise_if_branch_protected

        stderr = "remote: error: GH006: Protected branch update failed for https://x-access-token:s3cr3t@github.com/o/r\n"
        with pytest.raises(GitopsEmitterError) as exc:
            _raise_if_branch_protected(self._rejection(stderr), "main", "s3cr3t", tmp_path)
        assert "s3cr3t" not in str(exc.value)
