"""Scaffold-only CLI: ``python -m gitops_emitter.scaffold_cli``.

The bootstrap program's explicit scaffold step (issue #12 [B1] — target
control flow step 1) invokes this to create/scaffold the GitOps repo as
its own Pulumi resource, BEFORE Argo CD's root Application and independent
of any agent install. A separate module (not ``scaffold`` itself) so
``python -m`` doesn't re-execute a module the package already imported.

Config comes from the environment (mirroring the plugin-config fields
``emitter.load_config`` reads from config.yaml, and keeping the token out
of any command line):

- ``GITOPS_REPO_URL``      (required) — the GitOps repo to create/scaffold
- ``GITOPS_BRANCH``        (default ``main``)
- ``HERMES_GITOPS_REPO_URL`` / ``CHART_REVISION`` — chart source tokens
- ``IMAGE_REPOSITORY`` / ``IMAGE_TAG`` — optional image tokens
- ``GIT_AUTHOR_NAME`` / ``GIT_AUTHOR_EMAIL`` — optional commit identity
  (defaults to the emitter's bot identity)
- ``GITOPS_GIT_TOKEN``     — push/create credential (optional for
  token-less remotes, e.g. ``file://`` in local verification)
- ``GITOPS_BRANCH_PROTECTION`` — ``"true"`` requires a pull request on the
  default branch, applied AFTER the seeding push (ADR-95, #179). **Off
  unless the string is exactly** ``"true"``. Deliberately readable only
  here: the emitter's runtime path has no equivalent, so the runtime
  identity has no way to protect — or unprotect — the branch it pushes to.
- ``GITOPS_REQUIRED_REVIEWERS`` — approving reviews the protection
  demands (default ``0``, the solo-operator posture: a pull request is
  still required, and one person can satisfy it)
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any, Dict

from .gitrepo import _scrub
from .scaffold import ensure_repo_and_scaffold


def main() -> None:
    repo_url = os.environ.get("GITOPS_REPO_URL", "")
    if not repo_url:
        print("gitops-emitter scaffold: GITOPS_REPO_URL is required", file=sys.stderr)
        raise SystemExit(2)

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    cfg: Dict[str, Any] = {
        "repo_url": repo_url,
        "branch": os.environ.get("GITOPS_BRANCH") or "main",
        "hermes_gitops_repo_url": os.environ.get("HERMES_GITOPS_REPO_URL") or "",
        "chart_revision": os.environ.get("CHART_REVISION") or "",
        "image_repository": os.environ.get("IMAGE_REPOSITORY") or "",
        "image_tag": os.environ.get("IMAGE_TAG") or "",
        "git_author_name": os.environ.get("GIT_AUTHOR_NAME") or "hermes-gitops-bot",
        "git_author_email": os.environ.get("GIT_AUTHOR_EMAIL") or "hg-bot@users.noreply.github.com",
        # Explicit string comparison, never truthiness: the string "false"
        # is truthy, and a security control that turns itself ON when set
        # to "false" would be worse than one that is simply absent.
        "branch_protection": os.environ.get("GITOPS_BRANCH_PROTECTION") == "true",
        "required_reviewers": os.environ.get("GITOPS_REQUIRED_REVIEWERS") or "0",
    }
    token = os.environ.get("GITOPS_GIT_TOKEN") or None
    ensure_repo_and_scaffold(cfg, token)
    print(f"gitops-emitter scaffold: OK ({_scrub(repo_url, token)})")


if __name__ == "__main__":
    main()
