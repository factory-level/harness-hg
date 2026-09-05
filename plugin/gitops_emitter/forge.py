"""GitHub pulls client for PR-mode publishing (issue #17 [F1]).

GitHub-only by decision:
this mirrors ``scaffold.py``'s existing GitHub-only repo-creation client —
same stdlib-``urllib`` transport (no new runtime dependency), same header
set, same token-scrubbing posture (every error string passes through
``_scrub`` before it can reach an operator). A future forge abstraction
would grow around this module's function signatures, not inside them.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

from .errors import GitopsEmitterError
from .gitrepo import _scrub
from .scaffold import _GITHUB_API_BASE, _parse_github_owner_repo

logger = logging.getLogger(__name__)

__all__ = [
    "find_open_pull_request",
    "open_pull_request",
    "merge_pull_request",
    "require_github_repo",
]


def require_github_repo(repo_url: str, context: str) -> Tuple[str, str]:
    """Return ``(owner, repo)`` or raise a clear error — PR mode only works
    against github.com remotes (a ``file://``/GitLab/self-hosted remote has
    no pulls API here)."""
    parsed = _parse_github_owner_repo(repo_url)
    if parsed is None:
        raise GitopsEmitterError(
            f"gitops-emitter: {context} requires a github.com repo_url "
            f"(got a non-GitHub remote) - use mode: direct for non-GitHub remotes"
        )
    return parsed


def _headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gitops-emitter",
        "Content-Type": "application/json",
    }


def _http_request(
    method: str, url: str, headers: Dict[str, str], payload: Optional[bytes]
) -> Tuple[Optional[int], str]:
    """Issue *method* against *url*. Returns ``(status, body)``; status is
    ``None`` on a connection-level failure. A seam tests monkeypatch."""
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https API host
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        return exc.code, body
    except urllib.error.URLError as exc:
        return None, str(exc.reason)


def _pulls_error_message(
    action: str,
    owner: str,
    repo: str,
    status: Optional[int],
    body: str,
    token: Optional[str],
) -> str:
    """Map the pulls API's common failure codes to distinct, actionable
    messages (issue #22 [F4]); everything is token-scrubbed."""
    detail = _scrub(body[:300], token)
    if status == 403:
        return (
            f"gitops-emitter: failed to {action} on {owner}/{repo} (HTTP 403 "
            f"forbidden): the token lacks pull-request access - a fine-grained "
            f"PAT needs 'Pull requests: write' (a classic PAT needs 'repo'); "
            f"see gitops_emitter/README.md's token-scope table. {detail}"
        )
    if status == 404:
        return (
            f"gitops-emitter: failed to {action} on {owner}/{repo} (HTTP 404): "
            f"the token cannot see this repository - wrong owner/repo in "
            f"repo_url, or the token isn't granted access to it. {detail}"
        )
    if status == 422:
        return (
            f"gitops-emitter: failed to {action} on {owner}/{repo} (HTTP 422 "
            f"unprocessable): usually 'no commits between head and base' - "
            f"the base branch already carries the change (a benign race with "
            f"an out-of-band merge; re-running is safe and will no-op) - or "
            f"an invalid branch name. {detail}"
        )
    return (
        f"gitops-emitter: failed to {action} on {owner}/{repo} "
        f"(HTTP {status}): {detail}"
    )


def _parse_pr(body: str) -> Dict[str, Any]:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        data = {}
    return data if isinstance(data, dict) else {}


def find_open_pull_request(
    repo_url: str,
    token: Optional[str],
    *,
    head: str,
    base: str,
) -> Optional[Dict[str, Any]]:
    """Return the open PR for ``head`` -> ``base`` (matched by head branch
    name + open state — the ``hermes-gitops/`` branch namespace is
    plugin-owned, so no extra marker is needed), or ``None``. Issue #19
    [F2]'s lookup half."""
    owner, repo = require_github_repo(repo_url, "PR mode")
    if not token:
        raise GitopsEmitterError(
            "gitops-emitter: PR mode requires GITOPS_GIT_TOKEN (the pulls "
            "API is authenticated; there is no anonymous fallback)"
        )
    url = (
        f"{_GITHUB_API_BASE}/repos/{owner}/{repo}/pulls"
        f"?state=open&base={base}&head={owner}:{head}"
    )
    status, body = _http_request("GET", url, _headers(token), None)
    if status is None or not (200 <= status < 300):
        raise GitopsEmitterError(
            f"gitops-emitter: failed to list open PRs for {head} on "
            f"{owner}/{repo} (HTTP {status}): {_scrub(body[:300], token)}"
        )
    try:
        items = json.loads(body)
    except json.JSONDecodeError:
        items = []
    if isinstance(items, list) and items and isinstance(items[0], dict):
        first = items[0]
        return {
            "number": first.get("number"),
            "html_url": first.get("html_url", ""),
            "existing": True,
        }
    return None


def open_pull_request(
    repo_url: str,
    token: Optional[str],
    *,
    head: str,
    base: str,
    title: str,
    body: str,
) -> Dict[str, Any]:
    """Open a PR ``head`` -> ``base`` on the GitHub repo behind *repo_url*.

    Returns ``{"number": int, "html_url": str, "existing": bool}``. A 422
    "already exists" resolves to the existing open PR for the same head
    (the stable per-persona head branch makes this the common
    update-in-place case — full update-or-noop semantics are F2's scope;
    here it just never errors on, or duplicates, an already-open PR).
    """
    owner, repo = require_github_repo(repo_url, "PR mode")
    if not token:
        raise GitopsEmitterError(
            "gitops-emitter: PR mode requires GITOPS_GIT_TOKEN (the pulls "
            "API is authenticated; there is no anonymous fallback)"
        )

    url = f"{_GITHUB_API_BASE}/repos/{owner}/{repo}/pulls"
    payload = json.dumps(
        {"title": title, "body": body, "head": head, "base": base}
    ).encode("utf-8")
    status, resp_body = _http_request("POST", url, _headers(token), payload)

    if status is not None and 200 <= status < 300:
        data = _parse_pr(resp_body)
        number = data.get("number")
        if not isinstance(number, int):
            raise GitopsEmitterError(
                "gitops-emitter: GitHub pull-request response had no PR number "
                f"- {_scrub(resp_body[:300], token)}"
            )
        return {"number": number, "html_url": data.get("html_url", ""), "existing": False}

    if status == 422 and "already exist" in resp_body:
        existing = find_open_pull_request(repo_url, token, head=head, base=base)
        if existing is not None:
            return existing
        raise GitopsEmitterError(
            f"gitops-emitter: GitHub reported a PR for {head} already exists "
            f"but none is open - {_scrub(resp_body[:300], token)}"
        )

    raise GitopsEmitterError(
        _pulls_error_message(
            f"open pull request {head} -> {base}", owner, repo, status, resp_body, token
        )
    )


def merge_pull_request(
    repo_url: str,
    token: Optional[str],
    number: int,
    *,
    merge_method: str = "squash",
) -> str:
    """Merge PR *number* (the ``pr_auto_merge`` posture — the review gate
    an operator gets by turning auto-merge off). Returns the merge SHA."""
    owner, repo = require_github_repo(repo_url, "PR auto-merge")
    if not token:
        raise GitopsEmitterError(
            "gitops-emitter: PR auto-merge requires GITOPS_GIT_TOKEN"
        )

    url = f"{_GITHUB_API_BASE}/repos/{owner}/{repo}/pulls/{number}/merge"
    payload = json.dumps({"merge_method": merge_method}).encode("utf-8")
    status, resp_body = _http_request("PUT", url, _headers(token), payload)

    if status is not None and 200 <= status < 300:
        data = _parse_pr(resp_body)
        sha = data.get("sha")
        if isinstance(sha, str) and sha:
            return sha
        raise GitopsEmitterError(
            "gitops-emitter: GitHub merge response had no sha - "
            f"{_scrub(resp_body[:300], token)}"
        )

    raise GitopsEmitterError(
        _pulls_error_message(
            f"auto-merge PR #{number}", owner, repo, status, resp_body, token
        )
        + " - the PR remains open for manual review/merge"
    )
