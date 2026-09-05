"""Publish content to a GitOps repo via the system ``git`` binary.

Deliberately shells out to ``git`` (subprocess) rather than a Python git
library: it is the one implementation every operator's environment already
has correctly configured (SSH keys, credential helpers for non-token
remotes, etc.) and it makes token handling easy to reason about — the
token lives only in an in-memory URL string for the lifetime of one
temporary clone, never in a file that outlives the process.

Every error raised from this module has already been scrubbed of the git
token (see ``_scrub``) and of this module's own ephemeral tempdir paths
(see ``_scrub_tempdir``) — callers (``emitter.py``, ``scaffold.py``, and
ultimately ``gitops_emitter/__init__.py``'s fatal-dict contract) can surface
``GitopsEmitterError`` messages to the operator verbatim.
"""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union
from urllib.parse import urlsplit, urlunsplit

from .errors import GitopsEmitterError

logger = logging.getLogger(__name__)

__all__ = ["publish", "publish_to_head", "remove_path"]

# Per-invocation timeout for every single git subprocess call (clone, fetch,
# push, ...). Generous enough for a slow remote, short enough that a hung
# git process (e.g. an interactive credential prompt despite
# GIT_TERMINAL_PROMPT=0) doesn't hang `hermes profile install` indefinitely.
_GIT_TIMEOUT_SECONDS = 60


def _scrub(text: str, token: Optional[str]) -> str:
    """Remove every occurrence of *token* from *text*.

    Applied to every piece of subprocess output (stdout, stderr, the
    command line itself) before it can reach a raised exception, a log
    line, or the CLI-surfaced fatal-dict ``error`` field. The token must
    NEVER appear verbatim outside of the in-memory clone URL used for the
    single git invocation that needs it.
    """
    if not token or not text:
        return text
    return text.replace(token, "***")


def _scrub_tempdir(text: str, cwd: Optional[Path]) -> str:
    """Replace this module's own ephemeral working-directory path with a
    stable placeholder, so operator-facing errors stay readable (a raw
    ``/tmp/gitops_emitter_publish_xk3jd8/repo`` path is noise, not signal)
    without hiding anything the operator actually needs to act on.
    """
    if not cwd or not text:
        return text
    return text.replace(str(cwd), "<gitops-emitter-workdir>")


def _token_url(repo_url: str, token: Optional[str]) -> str:
    """Embed *token* into an ``https://`` URL as an in-memory credential.

    ``https://x-access-token:{token}@host/path`` is the GitHub-recommended
    form for token auth (also accepted by GitLab/Gitea/etc. as basic-auth
    with an arbitrary username). Non-``https`` URLs (``file://``, ``git@``,
    ``ssh://``) are returned unchanged — token auth only applies to https
    remotes; git's own SSH/file mechanisms handle the rest, and embedding a
    token in those URL forms would be either meaningless or actively wrong.
    The returned URL exists only in memory / as a git remote URL inside a
    tempdir repo that is deleted at the end of the calling function — it is
    never written to a durable config file.
    """
    if not token:
        return repo_url
    parts = urlsplit(repo_url)
    if parts.scheme != "https":
        return repo_url
    netloc = f"x-access-token:{token}@{parts.netloc}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def _run_git(
    args: List[str],
    cwd: Optional[Path] = None,
    token: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run ``git <args>`` as a subprocess.

    Never touches global git config (identity comes from ``env``'s
    ``GIT_AUTHOR_*``/``GIT_COMMITTER_*``, set by callers), never allows an
    interactive credential prompt (``GIT_TERMINAL_PROMPT=0``), and raises
    ``GitopsEmitterError`` (token- and tempdir-scrubbed) on a non-zero exit
    when ``check`` is True. Pass ``check=False`` when the caller wants to
    branch on ``returncode`` itself (e.g. "does this remote branch exist").
    """
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    full_env.setdefault("GIT_TERMINAL_PROMPT", "0")
    # Never let a locally-configured credential helper or stored credential
    # leak in — the token in the URL (or the remote's own SSH/file access)
    # is the only credential this module ever uses.
    full_env.setdefault("GIT_ASKPASS", "true")

    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd) if cwd else None,
            env=full_env,
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = _scrub_tempdir(_scrub(str(exc.stdout or ""), token), cwd)
        stderr = _scrub_tempdir(_scrub(str(exc.stderr or ""), token), cwd)
        args_str = _scrub_tempdir(_scrub(" ".join(args), token), cwd)
        raise GitopsEmitterError(
            f"gitops-emitter: git {args_str} timed out after "
            f"{_GIT_TIMEOUT_SECONDS}s: {(stdout + ' ' + stderr).strip()}"
        ) from None
    except OSError as exc:
        detail = _scrub_tempdir(_scrub(str(exc), token), cwd)
        raise GitopsEmitterError(f"gitops-emitter: failed to run git: {detail}") from None

    if check and result.returncode != 0:
        args_str = _scrub_tempdir(_scrub(" ".join(args), token), cwd)
        stdout = _scrub_tempdir(_scrub(result.stdout, token), cwd)
        stderr = _scrub_tempdir(_scrub(result.stderr, token), cwd)
        detail = (stderr or stdout).strip()
        raise GitopsEmitterError(
            f"gitops-emitter: git {args_str} failed (exit {result.returncode})"
            + (f": {detail}" if detail else "")
        )
    return result


def _identity_env(author: Dict[str, str]) -> Dict[str, str]:
    name = author.get("name", "")
    email = author.get("email", "")
    return {
        "GIT_AUTHOR_NAME": name,
        "GIT_AUTHOR_EMAIL": email,
        "GIT_COMMITTER_NAME": name,
        "GIT_COMMITTER_EMAIL": email,
    }


def _clone_or_init(
    clone_url: str, branch: str, workdir: Path, token: Optional[str], git_env: Dict[str, str]
) -> None:
    """Populate *workdir* with a working tree checked out to *branch*.

    Tries a shallow, single-branch clone first (the common case: the repo
    and branch already exist). Falls back to ``git init`` + ``remote add``
    + ``fetch`` when the clone fails — which covers both a genuinely empty
    repo (fetch finds no refs at all) and a repo that exists but doesn't
    have *branch* yet (fetch succeeds, the branch checkout does not). In
    either fallback case we end up on a fresh orphan *branch*, ready for
    the first commit. A remote that is truly unreachable (bad URL, no
    access, deleted repo) is not distinguished here — it fails loud instead
    at the push step, which is where this module's actual authority over
    the remote is exercised.
    """
    cloned = _run_git(
        ["clone", "--depth", "1", "--branch", branch, clone_url, str(workdir)],
        token=token,
        env=git_env,
        check=False,
    )
    if cloned.returncode == 0:
        return

    workdir.mkdir(parents=True, exist_ok=True)
    _run_git(["init"], cwd=workdir, token=token, env=git_env)
    _run_git(["remote", "add", "origin", clone_url], cwd=workdir, token=token, env=git_env)

    fetched = _run_git(["fetch", "origin"], cwd=workdir, token=token, env=git_env, check=False)
    if fetched.returncode == 0:
        checked_out = _run_git(
            ["checkout", "-B", branch, f"origin/{branch}"],
            cwd=workdir,
            token=token,
            env=git_env,
            check=False,
        )
        if checked_out.returncode == 0:
            return

    _run_git(["checkout", "--orphan", branch], cwd=workdir, token=token, env=git_env)
    _run_git(["rm", "-rf", "--cached", "."], cwd=workdir, token=token, env=git_env, check=False)


def _push(workdir: Path, branch: str, token: Optional[str], git_env: Dict[str, str]) -> subprocess.CompletedProcess:
    return _run_git(
        ["push", "origin", f"HEAD:refs/heads/{branch}"],
        cwd=workdir,
        token=token,
        env=git_env,
        check=False,
    )


# GitHub's rejection codes for a protected branch. GH006 is the general
# "protected branch update failed"; the prose variants cover hosts that do
# not emit a code (and GitHub's own wording for the review requirement).
_PROTECTED_MARKERS = (
    "GH006",
    "protected branch",
    "Protected branch update failed",
    "required status check",
    "at least 1 approving review",
    "Changes must be made through a pull request",
)


def _raise_if_branch_protected(
    result: subprocess.CompletedProcess, branch: str, token: Optional[str], workdir: Path
) -> None:
    """Turn a protected-branch rejection into a message about the RULE.

    #140 replaced the install carve-out with `allow_direct_commit`, and
    #179 makes a direct push actually impossible. Those two have to meet
    somewhere: with protection on and the flag set, the flag must fail
    LOUDLY rather than appear to work. Both issues say so, because a
    silent no-op would be worse than the carve-out #140 removed.

    Without this, the failure arrives as "push was rejected
    (non-fast-forward) and the automatic rebase failed" - which is wrong,
    unhelpful, and sends the operator looking for a concurrent writer that
    does not exist. The rebase would even SUCCEED here, since nothing is
    actually out of date, and the second push would fail the same way.
    """
    blob = f"{result.stdout}\n{result.stderr}"
    if not any(marker.lower() in blob.lower() for marker in _PROTECTED_MARKERS):
        return
    detail = _scrub_tempdir(_scrub(blob, token), workdir).strip()
    raise GitopsEmitterError(
        f"gitops-emitter: the remote REFUSED a direct push to {branch!r} - it is a "
        "protected branch requiring a pull request (ADR-2, #179).\n\n"
        "This is the gate working, not a transient error. Either:\n"
        "  * use `mode: pr` and leave `allow_direct_commit` unset, so changes "
        "arrive as pull requests (this is the intended posture); or\n"
        "  * remove the branch protection deliberately, if this environment has "
        "decided not to run the gate.\n\n"
        "Setting `allow_direct_commit` cannot get past this and is not meant to - "
        "the flag skips the emitter's own PR machinery, not the server's rule.\n\n"
        f"git said: {detail}"
    )


def _push_with_retry(workdir: Path, branch: str, token: Optional[str], git_env: Dict[str, str]) -> None:
    """Push, and on a non-fast-forward rejection, rebase onto the remote tip
    and retry exactly once.

    Safe because every commit this module makes is either a single profile
    record write (publish path) or a multi-file scaffold tree commit
    (initial scaffold path) — a rebase conflict here means a genuine
    concurrent write to the same file(s), not routine drift, so we abort and
    fail loud rather than attempt any conflict resolution.
    """
    result = _push(workdir, branch, token, git_env)
    if result.returncode == 0:
        return

    _raise_if_branch_protected(result, branch, token, workdir)

    _run_git(["fetch", "origin", branch], cwd=workdir, token=token, env=git_env)
    rebased = _run_git(["rebase", "FETCH_HEAD"], cwd=workdir, token=token, env=git_env, check=False)
    if rebased.returncode != 0:
        _run_git(["rebase", "--abort"], cwd=workdir, token=token, env=git_env, check=False)
        raise GitopsEmitterError(
            f"gitops-emitter: push to branch {branch!r} was rejected (non-fast-forward) "
            "and the automatic rebase onto the remote tip failed — this means a "
            "concurrent write conflicted with ours on the same file; resolve "
            "manually (inspect the GitOps repo's history) and retry the install."
        )

    retried = _push(workdir, branch, token, git_env)
    if retried.returncode != 0:
        _raise_if_branch_protected(retried, branch, token, workdir)
        stderr = _scrub_tempdir(_scrub(retried.stdout + retried.stderr, token), workdir)
        raise GitopsEmitterError(
            f"gitops-emitter: push to branch {branch!r} failed even after rebasing "
            f"onto the remote tip: {stderr.strip()}"
        )


def _blob_sha(data: bytes) -> str:
    """The sha1 git assigns a blob of *data* - lets a head-parity check
    compare bytes against a remote file without round-tripping binary
    content through a text-mode subprocess."""
    return hashlib.sha1(b"blob %d\x00" % len(data) + data).hexdigest()


def _reconcile_replace_trees(
    workdir: Path,
    replace_trees: Optional[List[str]],
    all_files: List[Tuple[str, bytes]],
) -> List[str]:
    """Delete files under each *replace_trees* directory that the new
    publish set no longer carries (ADR-42: the dashboard catalogue is a
    reconciled tree, not append-only - a contribution an author removed
    must leave Git). Returns the deleted repo-relative paths; empty
    directories are swept."""
    deleted: List[str] = []
    keep = {rel for rel, _ in all_files}
    for tree in replace_trees or []:
        base = workdir / tree
        if not base.is_dir() or base.is_symlink():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() or p.is_symlink():
                rel = p.relative_to(workdir).as_posix()
                if rel not in keep:
                    p.unlink()
                    deleted.append(rel)
        for p in sorted(base.rglob("*"), key=lambda x: len(str(x)), reverse=True):
            if p.is_dir() and not any(p.iterdir()):
                p.rmdir()
        if base.is_dir() and not any(base.iterdir()):
            base.rmdir()
    return deleted


# --- The generated-tree allowlist (ADR-19, #173) -------------------------
#
# ADR-19 splits the GitOps repository into trees with owners: the emitter's,
# the operator's after a one-time seed, and the operator's exclusively.
# Until now that split was a *convention* on this side - nothing
# structurally stopped a write to any path in the repository, so a bug in
# path construction could put generated content into an operator's tree and
# the operator would find out by having it overwritten.
#
# Every write path here is now checked against an explicit allowlist that
# the CALLER passes. Required, never defaulted: a default permissive value
# is how a new call site silently escapes the boundary the parameter exists
# to create.


class PathNotAllowed(RuntimeError):
    """A write was attempted outside the emitter's own trees."""


def _assert_within(allowed_prefixes: Sequence[str], paths: Sequence[str]) -> None:
    """Every path must sit under one allowed prefix.

    Refuses absolute paths and any `..` segment as well as the obvious
    out-of-tree case: `profiles/../bootstrap/x` normalises out of the
    allowed tree, and a check that only compared string prefixes would
    pass it.
    """
    allowed = [p.strip("/") for p in allowed_prefixes if p and p.strip("/")]
    if not allowed:
        raise PathNotAllowed(
            "gitops-emitter: refusing to write with an empty path allowlist - "
            "the caller must name the trees it owns (ADR-19)"
        )
    for raw in paths:
        rel = str(raw)
        if rel.startswith("/") or rel.startswith("\\"):
            raise PathNotAllowed(f"gitops-emitter: refusing to write absolute path {rel!r}")
        parts = [seg for seg in PurePosixPath(rel).parts if seg not in (".",)]
        if ".." in parts:
            raise PathNotAllowed(
                f"gitops-emitter: refusing to write {rel!r} - a '..' segment can escape the "
                f"generated trees ({', '.join(allowed)})"
            )
        norm = "/".join(parts)
        if not any(norm == pre or norm.startswith(pre + "/") for pre in allowed):
            raise PathNotAllowed(
                f"gitops-emitter: refusing to write {rel!r} - the emitter writes only under "
                f"{', '.join(f'{p}/' for p in allowed)} (ADR-19). Everything else in the GitOps "
                f"repository belongs to the operator."
            )


def publish_to_head(
    repo_url: str,
    base_branch: str,
    head_branch: str,
    rel_path: str,
    content: str,
    message: str,
    token: Optional[str],
    author: Dict[str, str],
    extra_files: Optional[List[Tuple[str, Union[str, bytes]]]] = None,
    replace_trees: Optional[List[str]] = None,
    *,
    allowed_prefixes: Sequence[str],
) -> Tuple[Optional[str], bool]:
    """PR-mode publish with full idempotency (issue #19 [F2]).

    Returns ``(sha, pushed)``:

    * ``(None, False)`` — the BASE branch already carries byte-identical
      content (e.g. an earlier PR merged); nothing to change, no PR
      needed.
    * ``(head_sha, False)`` — the remote HEAD branch already carries
      byte-identical content: the open PR (if any) already reflects the
      desired state, so nothing is pushed — a re-run is a true no-op
      (no force-push churn, no PR-updated noise).
    * ``(new_sha, True)`` — content changed: the head branch is reset
      from base, the change committed, and force-pushed (the existing
      open PR, if any, now reflects it; otherwise the caller opens one).
    """
    _assert_within(
        allowed_prefixes,
        [rel_path, *[rel for rel, _ in extra_files or []], *(replace_trees or [])],
    )
    git_env = _identity_env(author)
    clone_url = _token_url(repo_url, token)

    with tempfile.TemporaryDirectory(prefix="gitops_emitter_publish_") as tmp:
        workdir = Path(tmp) / "repo"
        _clone_or_init(clone_url, base_branch, workdir, token, git_env)

        all_files: List[Tuple[str, bytes]] = [(rel_path, content.encode("utf-8"))]
        for extra_rel, extra_content in extra_files or []:
            all_files.append(
                (
                    extra_rel,
                    extra_content.encode("utf-8")
                    if isinstance(extra_content, str)
                    else extra_content,
                )
            )
        target_path = workdir / rel_path
        new_bytes = content.encode("utf-8")
        stale = _reconcile_replace_trees(workdir, replace_trees, all_files)
        if not stale and all(
            (workdir / rel).is_file() and (workdir / rel).read_bytes() == data
            for rel, data in all_files
        ):
            return None, False

        # Does the remote head branch already carry the desired bytes?
        fetched = _run_git(
            ["fetch", "--depth", "1", "origin", f"{head_branch}:refs/remotes/origin/{head_branch}"],
            cwd=workdir,
            token=token,
            env=git_env,
            check=False,
        )
        if fetched.returncode == 0:
            shown = _run_git(
                ["show", f"origin/{head_branch}:{rel_path}"],
                cwd=workdir,
                token=token,
                env=git_env,
                check=False,
            )
            # Extras compare by blob sha, not `git show` text: catalogue
            # extras may be binary (icon assets), and _run_git's text mode
            # would choke decoding them. Byte-exact, CRLF included.
            extras_on_head = all(
                (lambda r: r.returncode == 0 and r.stdout.strip() == _blob_sha(data))(
                    _run_git(
                        ["rev-parse", f"origin/{head_branch}:{rel}"],
                        cwd=workdir, token=token, env=git_env, check=False,
                    )
                )
                for rel, data in all_files[1:]
            )
            # Presence is not enough: a reconciled tree (ADR-42) must also
            # carry NOTHING extra on the head - a removed catalogue file
            # lingering there would survive the "already identical" skip.
            trees_reconciled = True
            for tree in replace_trees or []:
                listed = _run_git(
                    ["ls-tree", "-r", "--name-only", f"origin/{head_branch}", "--", tree],
                    cwd=workdir, token=token, env=git_env, check=False,
                )
                if listed.returncode != 0:
                    trees_reconciled = False
                    break
                have = {line for line in listed.stdout.splitlines() if line}
                prefix = tree.rstrip("/") + "/"
                want = {rel for rel, _ in all_files if rel.startswith(prefix)}
                if have != want:
                    trees_reconciled = False
                    break
            if (
                shown.returncode == 0
                and shown.stdout.encode("utf-8") == new_bytes
                and extras_on_head
                and trees_reconciled
            ):
                head_sha = _run_git(
                    ["rev-parse", f"origin/{head_branch}"],
                    cwd=workdir,
                    token=token,
                    env=git_env,
                )
                return head_sha.stdout.strip(), False

        _run_git(["checkout", "-B", head_branch], cwd=workdir, token=token, env=git_env)
        for rel, data in all_files:
            target = workdir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        _run_git(
            ["add", "-A", "--", *[rel for rel, _ in all_files], *stale],
            cwd=workdir,
            token=token,
            env=git_env,
        )
        _run_git(["commit", "-m", message], cwd=workdir, token=token, env=git_env)
        # Force: the head branch is reset-from-base by design (one commit
        # of delta per PR); review history lives in the PR conversation.
        _run_git(
            ["push", "--force", "origin", f"HEAD:refs/heads/{head_branch}"],
            cwd=workdir,
            token=token,
            env=git_env,
        )
        sha = _run_git(["rev-parse", "HEAD"], cwd=workdir, token=token, env=git_env)
        return sha.stdout.strip(), True


def remove_path(
    repo_url: str,
    branch: str,
    rel_path: str,
    message: str,
    token: Optional[str],
    author: Dict[str, str],
    head_branch: Optional[str] = None,
    extra_paths: Optional[List[str]] = None,
    *,
    allowed_prefixes: Sequence[str],
) -> Optional[str]:
    """Remove *rel_path* (a file or directory) from *repo_url* (issue #24
    [F6] — decommission). Direct mode commits the removal straight to
    *branch*; PR mode (``head_branch`` set) commits it on the head branch
    reset from base and force-pushes (the caller opens/merges the PR, same
    as publishing). Returns the commit sha, or ``None`` when the path is
    already absent from the base branch (idempotent no-op — a re-run of a
    completed decommission changes nothing).
    """
    _assert_within(allowed_prefixes, [rel_path, *(extra_paths or [])])
    git_env = _identity_env(author)
    clone_url = _token_url(repo_url, token)

    with tempfile.TemporaryDirectory(prefix="gitops_emitter_remove_") as tmp:
        workdir = Path(tmp) / "repo"
        _clone_or_init(clone_url, branch, workdir, token, git_env)

        # One commit removes the record AND its companions (the catalogue
        # entry, ADR-34); no-op only when EVERY path is already absent.
        all_paths = [rel_path, *(extra_paths or [])]
        present = [rel for rel in all_paths if (workdir / rel).exists()]
        if not present:
            return None

        if head_branch is not None:
            _run_git(["checkout", "-B", head_branch], cwd=workdir, token=token, env=git_env)

        _run_git(["rm", "-r", "-q", "--", *present], cwd=workdir, token=token, env=git_env)
        _run_git(["commit", "-m", message], cwd=workdir, token=token, env=git_env)
        if head_branch is not None:
            _run_git(
                ["push", "--force", "origin", f"HEAD:refs/heads/{head_branch}"],
                cwd=workdir,
                token=token,
                env=git_env,
            )
        else:
            _push_with_retry(workdir, branch, token, git_env)
        sha = _run_git(["rev-parse", "HEAD"], cwd=workdir, token=token, env=git_env)
        return sha.stdout.strip()


def publish(
    repo_url: str,
    branch: str,
    rel_path: str,
    content: str,
    message: str,
    token: Optional[str],
    author: Dict[str, str],
    head_branch: Optional[str] = None,
    extra_files: Optional[List[Tuple[str, Union[str, bytes]]]] = None,
    replace_trees: Optional[List[str]] = None,
    *,
    allowed_prefixes: Sequence[str],
) -> Optional[str]:
    """Write *content* to *rel_path* of *repo_url* and push it.

    Direct mode (``head_branch=None``): commit lands straight on *branch*
    — today's behavior, byte-for-byte.

    PR mode (issue #17 [F1], ``head_branch`` set): the commit is created
    on ``head_branch``, freshly branched from *branch* (the base), and
    force-pushed there — the stable per-persona head branch is RESET from
    base on every change, so it always carries exactly one commit of
    delta for review. Opening the PR itself is the forge client's job
    (``forge.open_pull_request``), not this module's.

    Returns the new commit's full SHA, or ``None`` if *content* was
    already byte-identical to what's on the BASE branch (a deliberate
    no-op — no empty commit, and in PR mode no empty PR, is ever
    created).

    *token* is embedded (in-memory only) into the clone URL for ``https``
    remotes; ``file://`` and SSH remotes are used as given (see
    ``_token_url``). *author* is ``{"name": ..., "email": ...}`` and is
    applied purely through ``GIT_AUTHOR_*``/``GIT_COMMITTER_*`` env vars —
    this module never reads or writes the operator's global git config.
    """
    _assert_within(
        allowed_prefixes,
        [rel_path, *[rel for rel, _ in extra_files or []], *(replace_trees or [])],
    )
    git_env = _identity_env(author)
    clone_url = _token_url(repo_url, token)

    with tempfile.TemporaryDirectory(prefix="gitops_emitter_publish_") as tmp:
        workdir = Path(tmp) / "repo"
        _clone_or_init(clone_url, branch, workdir, token, git_env)

        # One commit for the record AND its companion files (the catalogue,
        # ADR-34): the no-op check requires EVERY file byte-identical.
        all_files: List[Tuple[str, bytes]] = [(rel_path, content.encode("utf-8"))]
        for extra_rel, extra_content in extra_files or []:
            all_files.append(
                (
                    extra_rel,
                    extra_content.encode("utf-8")
                    if isinstance(extra_content, str)
                    else extra_content,
                )
            )
        deleted = _reconcile_replace_trees(workdir, replace_trees, all_files)
        if not deleted and all(
            (workdir / rel).is_file() and (workdir / rel).read_bytes() == data
            for rel, data in all_files
        ):
            return None

        if head_branch is not None:
            _run_git(["checkout", "-B", head_branch], cwd=workdir, token=token, env=git_env)

        for rel, data in all_files:
            target = workdir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

        _run_git(
            ["add", "-A", "--", *[rel for rel, _ in all_files], *deleted],
            cwd=workdir,
            token=token,
            env=git_env,
        )
        status = _run_git(["status", "--porcelain"], cwd=workdir, token=token, env=git_env, check=False)
        if not status.stdout.strip():
            return None  # nothing staged (defensive: byte-identical check above should catch this first)

        _run_git(["commit", "-m", message], cwd=workdir, token=token, env=git_env)
        if head_branch is not None:
            # Force: the stable head branch is reset-from-base by design
            # (see docstring); a plain push would reject after any prior
            # PR cycle.
            _run_git(
                ["push", "--force", "origin", f"HEAD:refs/heads/{head_branch}"],
                cwd=workdir,
                token=token,
                env=git_env,
            )
        else:
            _push_with_retry(workdir, branch, token, git_env)

        sha = _run_git(["rev-parse", "HEAD"], cwd=workdir, token=token, env=git_env)
        return sha.stdout.strip()
