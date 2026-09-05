"""Create-if-missing GitOps repo + app-of-apps bootstrap scaffold.

Two callers:

1. The bootstrap program's explicit scaffold step (issue #12 [B1] — target
   control flow step 1, sequenced BEFORE Argo CD's root Application):
   ``python -m gitops_emitter.scaffold_cli``, config from environment — see
   that module. This is the step that GUARANTEES the repo's
   ``bootstrap/`` app-of-apps tree exists before anything references it.
2. ``emitter.emit()`` (when the plugin config's ``scaffold: true``, the
   default) *before* ``gitrepo.publish()`` pushes the profile record — a
   defensive fallback: with the explicit step in place this path finds
   ``bootstrap/`` already present and no-ops (the early return in
   ``_scaffold_repo``).

The app-of-apps template itself is the canonical ``infra/gitops-template/``,
packaged into the wheel at build time (issue #28 [L1] — see
pyproject.toml's force-include).
"""

from __future__ import annotations

import json
import logging
import re
import tempfile

import yaml
import urllib.error
import urllib.request
from urllib.parse import quote
from importlib import resources
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .errors import GitopsEmitterError
from .gitrepo import (
    _clone_or_init,
    _identity_env,
    _push_with_retry,
    _run_git,
    _scrub,
    _token_url,
)

logger = logging.getLogger(__name__)

__all__ = ["ensure_repo_and_scaffold"]

_SCAFFOLD_COMMIT_MESSAGE = "gitops-emitter: scaffold app-of-apps bootstrap"

_GITHUB_API_BASE = "https://api.github.com"

# Matches https://github.com/<owner>/<repo>[.git], bare github.com/<owner>/<repo>,
# and git@github.com:<owner>/<repo>[.git] — the URL forms operators plausibly
# hand-write into plugins.entries.gitops-emitter.repo_url.
_GITHUB_URL_RE = re.compile(
    r"^(?:https?://|git@)?(?:www\.)?github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$"
)

_DEFAULT_IMAGE_REPOSITORY = "ghcr.io/factory-level/hermes-agent"
_DEFAULT_IMAGE_TAG = "latest"


def _parse_github_owner_repo(repo_url: str) -> Optional[Tuple[str, str]]:
    """Return ``(owner, repo)`` if *repo_url* is a github.com URL, else ``None``."""
    match = _GITHUB_URL_RE.match(repo_url.strip())
    if not match:
        return None
    return match.group("owner"), match.group("repo")


def _http_post(url: str, headers: Dict[str, str], payload: bytes) -> Tuple[Optional[int], str]:
    """POST *payload* to *url*. Returns ``(status_code, body)``; status is
    ``None`` on a connection-level failure (DNS, refused, timeout, ...)."""
    return _http_request(url, headers, payload, "POST")


def _http_request(
    url: str, headers: Dict[str, str], payload: Optional[bytes], method: str
) -> Tuple[Optional[int], str]:
    """Any verb. ``_http_post`` is this with ``method="POST"``, kept as its
    own name because every existing caller and test refers to it."""
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https API host
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        return exc.code, body
    except urllib.error.URLError as exc:
        return None, str(exc.reason)


# --- Server-side pull-request enforcement (ADR-95, #179) -----------------
#
# ADR-2 says every change goes through a pull request; ADR-12 says an SRE
# agent's strongest action is opening one. Both are enforced entirely
# CLIENT-side - by the emitter choosing to open a PR - and the runtime
# identity can push straight to the default branch whenever it likes. So
# the boundary the whole safety model rests on is a convention.
#
# This closes it, and SHIPS DISABLED. See ADR-95 for why: turning it on
# changes how an existing environment's reconcile loop behaves, and that
# is an operator's decision about their own live system, not a default a
# platform release should make for them.


def _github_protect_branch(
    api_base: str,
    owner: str,
    repo: str,
    branch: str,
    token: str,
    required_reviewers: int,
) -> None:
    """Require a pull request on *branch*.

    Configured by the BOOTSTRAP identity (the operator's `pulumi up`),
    never by the runtime: an agent that can lift its own limit does not
    have one. Nothing in the emitter's runtime path calls this.

    `required_approving_review_count: 0` is the solo-operator default and
    is deliberate - it still forces every change onto a pull request,
    which is the property ADR-2 and ADR-12 actually need, while remaining
    satisfiable by the one person who is both author and reviewer.
    GitHub cannot express "a PR is required but you may approve your own",
    so one is the smallest number that would block a solo operator
    entirely.
    """
    # Percent-encoded as PATH SEGMENTS, branch especially: a perfectly
    # ordinary name like `release/production` would otherwise add path
    # segments and address a different endpoint entirely, which GitHub
    # answers with a 404 - reported here as "the branch does not exist
    # yet", sending the operator to look at seeding instead of at the
    # name they configured. `safe=""` because a slash inside one segment
    # is exactly what must not survive.
    url = (
        f"{api_base}/repos/{quote(owner, safe='')}/{quote(repo, safe='')}"
        f"/branches/{quote(branch, safe='')}/protection"
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "hermes-gitops-emitter",
    }
    payload = json.dumps(
        {
            # No status checks: CI is not a precondition this platform can
            # assume exists. The PR itself is the gate.
            "required_status_checks": None,
            # False: the bootstrap identity is usually an admin, and an
            # admin locked out of their own GitOps repository during a
            # recovery is a worse failure than an admin who can bypass.
            # ADR-95 records this as the deliberate hole it is.
            "enforce_admins": False,
            "required_pull_request_reviews": {
                "required_approving_review_count": required_reviewers,
                "dismiss_stale_reviews": False,
                "require_code_owner_reviews": False,
            },
            "restrictions": None,
            # The emitter force-pushes its per-persona head branch by
            # design (one commit of delta per PR). Protection applies to
            # the DEFAULT branch only, so this does not affect that - but
            # allowing it here would defeat the point on the branch that
            # matters.
            "allow_force_pushes": False,
            "allow_deletions": False,
        }
    ).encode("utf-8")

    status, body = _http_request(url, headers, payload, "PUT")
    if status == 200:
        logger.info(
            "gitops-emitter: branch protection applied to %s/%s@%s "
            "(pull request required, %d approving review(s))",
            owner,
            repo,
            branch,
            required_reviewers,
        )
        return
    if status == 403:
        raise GitopsEmitterError(
            f"gitops-emitter: cannot protect {owner}/{repo}@{branch} - the token "
            "lacks admin rights on the repository (branch protection needs "
            "`administration: write`, which a contents-only token does not have). "
            "Use the BOOTSTRAP identity's token, or unset "
            "gitopsBranchProtection to leave the branch unprotected."
        )
    if status == 404:
        raise GitopsEmitterError(
            f"gitops-emitter: cannot protect {owner}/{repo}@{branch} - GitHub "
            "returned 404. Either the branch does not exist yet (protection is "
            "applied AFTER the seeding push, so this means seeding did not "
            "happen) or the token cannot see the repository."
        )
    raise GitopsEmitterError(
        f"gitops-emitter: failed to protect {owner}/{repo}@{branch} "
        f"(HTTP {status if status is not None else 'connection failed'}): "
        f"{_scrub(body, token)[:400]}"
    )


def _verify_repo_creation(
    response_body: str, expected_full_name: str, owner: str, repo: str, token: str
) -> None:
    """Verify that the GitHub API response created the intended repo.

    Parses the response JSON to extract the created repo's full_name and
    compares it (case-insensitively) against the intended owner/repo. Raises
    GitopsEmitterError if they don't match, indicating a token mismatch or
    misconfiguration.
    """
    try:
        response = json.loads(response_body)
        actual_full_name = response.get("full_name", "").lower()
    except (json.JSONDecodeError, ValueError):
        actual_full_name = ""

    if actual_full_name != expected_full_name:
        raise GitopsEmitterError(
            f"gitops-emitter: GitHub created {actual_full_name or '<unknown>'} "
            f"but the configured repo_url expects {owner}/{repo} — the token does "
            f"not belong to {owner}; fix repo_url or use a token for that account"
        )


def _github_create_repo(api_base: str, owner: str, repo: str, token: str) -> None:
    """Create ``owner/repo`` on GitHub via the REST API (private by default).

    A seam: tests monkeypatch this function directly to assert it was
    called with the right (api_base, owner, repo, token) rather than
    exercising real HTTP. Everything else in this module is tested against
    real local bare git repos.

    GitHub has no single "create a repo under this owner" endpoint — org
    repos go through ``POST /orgs/{org}/repos``, personal repos through
    ``POST /user/repos`` (which always creates under the *authenticated*
    user, ignoring any owner in the URL). Since we can't cheaply tell
    "org" from "personal account" from the URL alone, try the org endpoint
    first (the common case for a fleet's shared GitOps repo) and fall back
    to ``/user/repos`` on a 404 (owner is not an org).
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gitops-emitter",
        "Content-Type": "application/json",
    }
    payload = json.dumps({"name": repo, "private": True}).encode("utf-8")

    expected_full_name = f"{owner}/{repo}".lower()

    org_url = f"{api_base}/orgs/{owner}/repos"
    org_status, org_body = _http_post(org_url, headers, payload)
    if org_status is not None and 200 <= org_status < 300:
        _verify_repo_creation(org_body, expected_full_name, owner, repo, token)
        return

    if org_status == 404:
        user_url = f"{api_base}/user/repos"
        user_status, user_body = _http_post(user_url, headers, payload)
        if user_status is not None and 200 <= user_status < 300:
            _verify_repo_creation(user_body, expected_full_name, owner, repo, token)
            return
        raise GitopsEmitterError(
            f"gitops-emitter: failed to create GitHub repo {owner}/{repo} "
            f"(tried org and user endpoints; last attempt HTTP "
            f"{user_status}): {_scrub(user_body, token)}"
        )

    raise GitopsEmitterError(
        f"gitops-emitter: failed to create GitHub repo {owner}/{repo} via "
        f"{org_url} (HTTP {org_status}): {_scrub(org_body, token)}"
    )


def _repo_exists(repo_url: str, token: Optional[str]) -> bool:
    result = _run_git(["ls-remote", _token_url(repo_url, token)], token=token, check=False)
    return result.returncode == 0


def _copy_verbatim(src, dst: Path) -> None:
    """Recursively copy *src* to *dst* with no token substitution."""
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        for entry in src.iterdir():
            _copy_verbatim(entry, dst / entry.name)
    else:
        dst.write_bytes(src.read_bytes())


def _copy_substituting(src, dst: Path, tokens: Dict[str, str]) -> None:
    """Recursively copy *src* to *dst*, substituting every
    ``__DOUBLE_UNDERSCORE__`` token verbatim (plain string replace — see
    ``infra/gitops-template/README.md``'s "Placeholder tokens" section for why
    this alphabet was chosen). Binary files (none exist in the template
    today, but future-proof) are copied byte-for-byte, untouched.
    """
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        for entry in src.iterdir():
            _copy_substituting(entry, dst / entry.name, tokens)
        return
    data = src.read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        dst.write_bytes(data)
        return
    for token_name, value in tokens.items():
        text = text.replace(token_name, value)
    dst.write_text(text, encoding="utf-8")


def _copy_template_tree(template_root, workdir: Path, tokens: Dict[str, str]) -> None:
    """Copy the packaged template tree into *workdir*.

    Only files under ``bootstrap/`` receive token substitution — that is
    the plugin-managed, Argo CD-synced portion of the scaffold that
    actually consumes the tokens (``infra/gitops-template/README.md``'s
    "Placeholder tokens" section scopes this explicitly to "Files under
    ``bootstrap/``"). The top-level ``README.md`` (which becomes the
    repo's own README once scaffolded, and documents the token syntax by
    naming the literal token strings in a table) and ``profiles/.gitkeep``
    are copied verbatim, so the README's own documentation of the tokens
    is not corrupted by the very substitution it describes.
    """
    for entry in template_root.iterdir():
        target = workdir / entry.name
        if entry.is_dir() and entry.name == "bootstrap":
            _copy_substituting(entry, target, tokens)
        else:
            _copy_verbatim(entry, target)


# The environment's half of the AppProject allowlist (#133's split): the
# operator declares remote helm repos ONCE, in cluster-values'
# appProject.sourceRepos, and the scaffold renders them into the managed
# bootstrap/project.yaml. Before this token the managed file had no slot
# for them, so every hash-gated reconcile deleted the operator's hand-added
# entries and Argo CD refused to sync the persona's OCI charts (factory,
# 2026-08-27 and 2026-08-29). The token swallows its own line: an empty
# list renders nothing.
_OPERATOR_SOURCE_REPOS_TOKEN = "__OPERATOR_SOURCE_REPOS__\n"
_CLUSTER_VALUES_RELPATH = "bootstrap/values/cluster-values.yaml"
# The rendered items are plain YAML scalars: only URL-shaped strings are
# accepted (no whitespace, quotes or '#'), so an entry can never change the
# node it lands in. Mirrored by cli/src/gitops/index.ts operatorSourceRepos.
_REPO_URL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~:/@%+-]*$")


def operator_source_repos(workdir: Optional[Path]) -> List[str]:
    """cluster-values' ``appProject.sourceRepos`` with every ``oci://`` entry
    doubled by its scheme-less twin (the hermes-profile chart renders
    helm-OCI child Applications scheme-less, #187). Sorted, deduplicated;
    empty when the file or the list is absent. Pure."""
    if workdir is None:
        return []
    path = workdir / _CLUSTER_VALUES_RELPATH
    if not path.is_file():
        return []
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise GitopsEmitterError(
            f"gitops-emitter: {_CLUSTER_VALUES_RELPATH} is not valid YAML ({exc})"
        ) from exc
    project = doc.get("appProject") if isinstance(doc, dict) else None
    repos = (project or {}).get("sourceRepos") if isinstance(project, dict) else None
    if repos is None:
        return []
    if not isinstance(repos, list) or not all(
        isinstance(r, str) and _REPO_URL_RE.match(r) for r in repos
    ):
        raise GitopsEmitterError(
            f"gitops-emitter: {_CLUSTER_VALUES_RELPATH} appProject.sourceRepos must be a list "
            "of repository URLs (no whitespace, quotes or '#')"
        )
    out = set()
    for repo in repos:
        out.add(repo)
        if repo.startswith("oci://"):
            out.add(repo[len("oci://"):])
    return sorted(out)


def _scaffold_tokens(cfg: Dict[str, Any], workdir: Optional[Path] = None) -> Dict[str, str]:
    return {
        "__GITOPS_REPO_URL__": cfg["repo_url"],
        "__GITOPS_BRANCH__": cfg["branch"],
        "__HERMES_GITOPS_REPO_URL__": cfg.get("hermes_gitops_repo_url") or "",
        "__CHART_REVISION__": cfg.get("chart_revision") or "",
        "__IMAGE_REPOSITORY__": cfg.get("image_repository") or _DEFAULT_IMAGE_REPOSITORY,
        "__IMAGE_TAG__": cfg.get("image_tag") or _DEFAULT_IMAGE_TAG,
        _OPERATOR_SOURCE_REPOS_TOKEN: "".join(
            f"    - {repo}\n" for repo in operator_source_repos(workdir)
        ),
    }



# ---------------------------------------------------------------------------
# Scaffold lifecycle (ADR-37): the write-once era ends here. A scaffolded
# repo carries bootstrap/scaffold.yaml - the ownership manifest ADR-19
# asked for - recording which files the PLUGIN manages and the sha256 each
# had when the plugin last wrote it. Reconciliation is hash-gated: a
# managed file whose on-disk hash matches its record is the plugin's to
# update; one that differs was edited by an operator and is REFUSED
# (warned, never overwritten). Everything else the template seeds
# (values/, monitoring, fleet-dashboard, README, profiles/) is
# seeded-then-operator-owned and never touched again.

_SCAFFOLD_RECORD_PATH = "bootstrap/scaffold.yaml"
_SCAFFOLD_VERSION = 2
_MANAGED_FILES = (
    "bootstrap/project.yaml",
    "bootstrap/applicationset.yaml",
    "bootstrap/applicationsets/agents.yaml",
    "bootstrap/applicationsets/apps.yaml",
    "bootstrap/applicationsets/endpoints.yaml",
    # ADR-19's operator tree (#173). MANAGED rather than seeded-once,
    # because the Application that syncs `platform/` is platform
    # machinery - an environment that never updated it would silently
    # stop getting the tree's project, prune and exclusion rules. The
    # tree's CONTENTS are the operator's; this file is how they reach the
    # cluster, and it is the reconciler's.
    #
    # This is also the entry that proves the reconcile path works for a
    # file NEW in a release: an already-scaffolded repository gains it on
    # the next emit, warns if the operator has edited it, and never
    # recreates it if they deleted it deliberately.
    "bootstrap/platform-extras.yaml",
)


def _sha256_text(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _substitute_text(path, tokens: Dict[str, str]) -> str:
    text = path.read_bytes().decode("utf-8")
    for token_name, value in tokens.items():
        text = text.replace(token_name, value)
    return text


def _render_managed(template_root, tokens: Dict[str, str]) -> Dict[str, str]:
    """The managed set as the CURRENT template + tokens render it. A file
    absent from the template (an older plugin) is simply absent."""
    out: Dict[str, str] = {}
    for rel in _MANAGED_FILES:
        parts = rel.split("/")
        node = template_root
        for part in parts:
            node = node / part
        if node.is_file():
            out[rel] = _substitute_text(node, tokens)
    return out


def _scaffold_record_text(cfg: Dict[str, Any], hashes: Dict[str, str]) -> str:
    doc = {
        "version": _SCAFFOLD_VERSION,
        "templateRevision": cfg.get("chart_revision") or "",
        "substitutions": {
            "gitopsRepoUrl": cfg["repo_url"],
            "gitopsBranch": cfg["branch"],
            "hermesGitopsRepoUrl": cfg.get("hermes_gitops_repo_url") or "",
            "chartRevision": cfg.get("chart_revision") or "",
        },
        "managedFiles": [
            {"path": rel, "sha256": hashes[rel]} for rel in sorted(hashes)
        ],
    }
    return yaml.safe_dump(doc, sort_keys=True, default_flow_style=False)


def _reconcile_scaffold(workdir: Path, template_root, tokens: Dict[str, str], cfg: Dict[str, Any]) -> bool:
    """Hash-gated reconcile of the managed files. Returns True when
    anything changed on disk. Operator-edited managed files are warned
    about and preserved - refusal is per file, never an abort."""
    record_file = workdir / _SCAFFOLD_RECORD_PATH
    recorded: Dict[str, str] = {}
    try:
        doc = yaml.safe_load(record_file.read_text(encoding="utf-8")) or {}
        for entry in doc.get("managedFiles") or []:
            recorded[entry["path"]] = entry["sha256"]
    except Exception:  # noqa: BLE001 - a broken record means nothing is provably ours
        logger.warning(
            "gitops-emitter: %s is unreadable - refusing to reconcile any managed file",
            _SCAFFOLD_RECORD_PATH,
        )
        return False

    desired = _render_managed(template_root, tokens)
    changed = False
    final_hashes: Dict[str, str] = {}

    for rel, new_text in desired.items():
        target = workdir / rel
        if not target.is_file():
            if rel in recorded:
                # Recorded but missing = an OPERATOR deleted it - a
                # modification like any other, refused, never recreated.
                logger.warning(
                    "gitops-emitter: managed file %s was deleted since the plugin wrote it - "
                    "REFUSING to recreate it (restore it to resume management)",
                    rel,
                )
                final_hashes[rel] = recorded[rel]
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(new_text, encoding="utf-8")
            logger.info("gitops-emitter: scaffold added %s (new in this platform release)", rel)
            changed = True
            final_hashes[rel] = _sha256_text(new_text)
            continue
        on_disk = target.read_bytes().decode("utf-8")
        if rel not in recorded:
            # Present but never recorded (e.g. hand-added): not provably ours.
            logger.warning(
                "gitops-emitter: %s exists but is not in scaffold.yaml - leaving it untouched", rel
            )
            continue
        if _sha256_text(on_disk) != recorded[rel]:
            logger.warning(
                "gitops-emitter: %s was edited since the plugin wrote it - REFUSING to update it "
                "(restore it or remove the edit, then re-run)",
                rel,
            )
            final_hashes[rel] = recorded[rel]
            continue
        if on_disk != new_text:
            target.write_text(new_text, encoding="utf-8")
            logger.info("gitops-emitter: scaffold updated %s", rel)
            changed = True
        final_hashes[rel] = _sha256_text(new_text)

    # Recorded files the template no longer ships: delete only if clean.
    for rel, sha in recorded.items():
        if rel in desired:
            continue
        target = workdir / rel
        if not target.is_file():
            continue
        if _sha256_text(target.read_bytes().decode("utf-8")) == sha:
            target.unlink()
            logger.info("gitops-emitter: scaffold removed %s (retired by this platform release)", rel)
            changed = True
        else:
            logger.warning(
                "gitops-emitter: retired managed file %s was edited - REFUSING to remove it", rel
            )
            final_hashes[rel] = sha

    new_record = _scaffold_record_text(cfg, final_hashes)
    if not record_file.is_file() or record_file.read_bytes().decode("utf-8") != new_record:
        record_file.write_text(new_record, encoding="utf-8")
        changed = True
    return changed


def _scaffold_repo(cfg: Dict[str, Any], token: Optional[str]) -> None:
    """Clone (or init) the GitOps repo and bring its scaffold up to date.

    Three cases, and the difference between the last two is what an
    earlier version of this docstring got wrong:

    * **no ``bootstrap/``** — seed the whole app-of-apps template, write
      the ownership record, push.
    * **``bootstrap/`` but no ``bootstrap/scaffold.yaml``** — a repository
      scaffolded before ADR-37. Nothing records what the plugin owns, so
      nothing is provably safe to touch: left untouched, with a log line
      pointing at ``hg gitops upgrade``.
    * **``bootstrap/`` and a record** — hash-gated reconcile of the
      managed files (``_reconcile_scaffold``): add what is new in this
      release, update what the plugin wrote and nobody has edited, remove
      what this release retired if it is clean, and REFUSE anything an
      operator changed. Commits and pushes only if something changed.

    Idempotent in every case: a re-run with nothing to do produces no
    commit and no push.
    """
    repo_url = cfg["repo_url"]
    branch = cfg["branch"]
    author = {"name": cfg.get("git_author_name", ""), "email": cfg.get("git_author_email", "")}
    git_env = _identity_env(author)
    clone_url = _token_url(repo_url, token)

    with tempfile.TemporaryDirectory(prefix="gitops_emitter_scaffold_") as tmp:
        workdir = Path(tmp) / "repo"
        _clone_or_init(clone_url, branch, workdir, token, git_env)

        template_root_probe = resources.files("gitops_emitter") / "gitops_template"
        if not template_root_probe.is_dir():
            template_root_probe = Path(__file__).resolve().parents[2] / "infra" / "gitops-template"

        if (workdir / "bootstrap").is_dir():
            if not (workdir / _SCAFFOLD_RECORD_PATH).is_file():
                # Pre-lifecycle repo: nothing records what the plugin owns,
                # so nothing is provably safe to touch. `hg gitops upgrade`
                # is the migration that writes the record.
                logger.info(
                    "gitops-emitter: GitOps repo scaffolded before the managed-file record "
                    "existed - leaving it untouched (run `hg gitops upgrade` to adopt it)"
                )
                return
            if _reconcile_scaffold(workdir, template_root_probe, _scaffold_tokens(cfg, workdir), cfg):
                _run_git(["add", "-A"], cwd=workdir, token=token, env=git_env)
                status = _run_git(["status", "--porcelain"], cwd=workdir, token=token, env=git_env, check=False)
                if status.stdout.strip():
                    _run_git(["commit", "-m", "gitops-emitter: reconcile plugin-managed scaffold files"], cwd=workdir, token=token, env=git_env)
                    _push_with_retry(workdir, branch, token, git_env)
                    logger.info("gitops-emitter: reconciled plugin-managed scaffold files")
            return

        # Installed wheel: the app-of-apps template is packaged into the
        # wheel at build time from the canonical infra/gitops-template/ (see
        # pyproject.toml's force-include, issue #28 [L1]). Source checkout /
        # editable install: fall back to the canonical directory at the
        # repo root (two levels above plugin/gitops_emitter/ since issue
        # #35 [L4]) — the single source of truth the build step packages
        # from.
        template_root = resources.files("gitops_emitter") / "gitops_template"
        if not template_root.is_dir():
            template_root = Path(__file__).resolve().parents[2] / "infra" / "gitops-template"
        _copy_template_tree(template_root, workdir, _scaffold_tokens(cfg))

        # The ownership manifest (ADR-37): every plugin-managed file's
        # as-written hash, so later releases can reconcile hash-gated.
        managed = _render_managed(template_root, _scaffold_tokens(cfg))
        (workdir / _SCAFFOLD_RECORD_PATH).write_text(
            _scaffold_record_text(cfg, {rel: _sha256_text(text) for rel, text in managed.items()}),
            encoding="utf-8",
        )

        _run_git(["add", "-A"], cwd=workdir, token=token, env=git_env)
        status = _run_git(["status", "--porcelain"], cwd=workdir, token=token, env=git_env, check=False)
        if not status.stdout.strip():
            return  # defensive: template copy produced no changes

        _run_git(["commit", "-m", _SCAFFOLD_COMMIT_MESSAGE], cwd=workdir, token=token, env=git_env)
        _push_with_retry(workdir, branch, token, git_env)
        logger.info("gitops-emitter: scaffolded app-of-apps bootstrap in GitOps repo")


def ensure_repo_and_scaffold(cfg: Dict[str, Any], token: Optional[str]) -> None:
    """Create the configured GitOps repo if missing, then scaffold it.

    Step 1 — existence: ``git ls-remote`` against ``cfg["repo_url"]``. If
    that fails and the URL is a github.com repo, create it via the GitHub
    REST API (private by default) using *token*. A non-github URL that
    doesn't exist raises ``GitopsEmitterError`` telling the operator to
    create it themselves — this module has no way to create a repo on an
    arbitrary git host.

    Step 2 — scaffold: see ``_scaffold_repo``.
    """
    repo_url = cfg["repo_url"]

    if not _repo_exists(repo_url, token):
        owner_repo = _parse_github_owner_repo(repo_url)
        if owner_repo is None:
            raise GitopsEmitterError(
                f"gitops-emitter: GitOps repo {repo_url!r} does not exist (or is "
                "unreachable) and is not a github.com URL, so gitops-emitter "
                "cannot create it automatically. Create the (empty) repository "
                "yourself and re-run the install, or fix repo_url / your git "
                "token's access."
            )
        if not token:
            raise GitopsEmitterError(
                f"gitops-emitter: GitOps repo {repo_url!r} does not exist and no "
                "git token is available to create it via the GitHub API."
            )
        owner, repo = owner_repo
        _github_create_repo(_GITHUB_API_BASE, owner, repo, token)

    _scaffold_repo(cfg, token)

    # Protection LAST, and only when the caller asked (ADR-95, #179).
    #
    # After the seeding push, deliberately: the branch has to exist before
    # it can be protected, and protecting it first would block the very
    # push that creates it.
    #
    # `branch_protection` is absent from the runtime config entirely -
    # `emitter.load_plugin_config` does not read it, so the emitter's own
    # `ensure_repo_and_scaffold` call can never reach this. Only
    # `scaffold_cli`, run by the operator's `pulumi up` with the BOOTSTRAP
    # identity, sets it. That is the point of #179: an agent that can lift
    # its own limit does not have one.
    if cfg.get("branch_protection"):
        owner_repo = _parse_github_owner_repo(cfg["repo_url"])
        if owner_repo is None:
            raise GitopsEmitterError(
                f"gitops-emitter: branch protection was requested but {cfg['repo_url']!r} "
                "is not a github.com URL - protection is a GitHub API feature and this "
                "module has no equivalent for other hosts. Unset it, or move the "
                "repository to GitHub."
            )
        if not token:
            raise GitopsEmitterError(
                "gitops-emitter: branch protection was requested but no git token is "
                "available to call the GitHub API with."
            )
        owner, repo = owner_repo
        _github_protect_branch(
            _GITHUB_API_BASE,
            owner,
            repo,
            cfg["branch"],
            token,
            int(cfg.get("required_reviewers") or 0),
        )

