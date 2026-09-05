"""Decommission an agent's GitOps record (issue #24 [F6]).

``python -m gitops_emitter.decommission_cli <name>`` (or
``--source <url>``) removes ``<profiles_path>/<name>/`` from the GitOps
repo, which makes the ApplicationSet's git-files generator drop the
Application and Argo CD prune the workload (``automated.prune: true``).
The infra program's per-agent Command runs this as its ``delete`` action,
so removing an agent from ``agents:`` stack config decommissions it on
the next ``pulumi up``.

Posture: removal honors the same direct-vs-PR publishing mode as
install/update (issues #17/#21 [F1]/[F3]) — ``mode: pr`` opens a
pull request for the removal (auto-merged per ``pr_auto_merge``);
``mode: direct`` pushes it straight. Idempotent: a record already absent
is a clean no-op. Token handling and scrubbing are the same as every
other plugin path (``GITOPS_GIT_TOKEN`` env; every error is scrubbed).

Name resolution: with ``--source``, the record is found by scanning
``<profiles_path>/*/profile.yaml`` for a matching ``spec.source`` —
covering agents that were never explicitly named in stack config (the
distribution named itself at install time). Exactly one match is
required; zero matches is a no-op (already decommissioned), multiple
matches is an error naming them.

The persisted per-instance override (``<overrides_dir>/<name>.yaml``) is
removed too — a decommissioned persona must not leave a sticky override
behind for a future same-named install. Per-agent Secrets/namespaces are
Pulumi resources keyed by ``agentSecrets`` and are removed by deleting
that stack config entry (documented in the example file), not here.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

import yaml

from .harness.hermes import GitopsEmitterError, load_plugin_config
from .gitrepo import _scrub, _token_url, remove_path
from .render import validate_name

logger = logging.getLogger(__name__)


def _list_records_by_source(
    repo_url: str,
    branch: str,
    profiles_path: str,
    source: str,
    token: Optional[str],
    subdir: Optional[str] = None,
) -> List[str]:
    """Names of records under ``profiles_path`` whose ``spec.source``
    equals *source* - and, when *subdir* is given, whose ``spec.sourceSubdir``
    equals it too (a monorepo ships several agents under one source; the
    subdir is what tells them apart). Shallow clone, read-only."""
    clone_url = _token_url(repo_url, token)
    matches: List[str] = []
    with tempfile.TemporaryDirectory(prefix="gitops_emitter_decommission_") as tmp:
        workdir = Path(tmp) / "repo"
        result = subprocess.run(
            ["git", "clone", "--depth", "1", "--branch", branch, clone_url, str(workdir)],
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"},
        )
        if result.returncode != 0:
            raise GitopsEmitterError(
                "gitops-emitter decommission: failed to clone the GitOps repo: "
                + _scrub((result.stderr or result.stdout).strip(), token)
            )
        profiles_dir = workdir / profiles_path
        if not profiles_dir.is_dir():
            return []
        for record in sorted(profiles_dir.glob("*/profile.yaml")):
            try:
                data = yaml.safe_load(record.read_text(encoding="utf-8")) or {}
            except yaml.YAMLError:
                continue
            spec = data.get("spec") or {}
            if (spec.get("source") or "") != source:
                continue
            if subdir is not None and (spec.get("sourceSubdir") or "") != subdir:
                continue
            matches.append(record.parent.name)
    return matches


def decommission(
    name: Optional[str], source: Optional[str], subdir: Optional[str] = None
) -> Optional[str]:
    """Remove the record for *name* (or the unique record matching
    *source*, narrowed by *subdir* when given). Returns the removal commit
    sha, or ``None`` when there was nothing to remove."""
    cfg = load_plugin_config()
    token = os.environ.get("GITOPS_GIT_TOKEN") or None
    author = {"name": cfg["git_author_name"], "email": cfg["git_author_email"]}

    if name is None:
        assert source is not None
        matches = _list_records_by_source(
            cfg["repo_url"], cfg["branch"], cfg["profiles_path"], source, token, subdir
        )
        if not matches:
            print(
                f"gitops-emitter decommission: no record matches source {source!r} "
                "- already decommissioned (no-op)"
            )
            return None
        if len(matches) > 1:
            raise GitopsEmitterError(
                f"gitops-emitter decommission: {len(matches)} records match source "
                f"{source!r} ({', '.join(matches)}) - pass the record name explicitly, "
                "or narrow with --subdir"
            )
        name = matches[0]

    validate_name(name)
    rel_path = f"{cfg['profiles_path']}/{name}"
    message = f"gitops-emitter: decommission {name}"

    head_branch = f"hermes-gitops/{name}" if cfg["mode"] == "pr" else None
    if head_branch is not None:
        from . import forge

        forge.require_github_repo(cfg["repo_url"], "PR-mode decommission")

    sha = remove_path(
        cfg["repo_url"],
        cfg["branch"],
        rel_path,
        message,
        token,
        author,
        head_branch=head_branch,
        extra_paths=[f"catalog/profiles/{name}"],
        # The same generated trees emit writes (ADR-19, #173). A
        # decommission removes only what the emitter created.
        allowed_prefixes=[cfg["profiles_path"], "catalog"],
    )
    if sha is None:
        print(f"gitops-emitter decommission: {rel_path} already absent (no-op)")
    elif head_branch is not None:
        from . import forge

        pr = forge.find_open_pull_request(
            cfg["repo_url"], token, head=head_branch, base=cfg["branch"]
        )
        if pr is None:
            pr = forge.open_pull_request(
                cfg["repo_url"],
                token,
                head=head_branch,
                base=cfg["branch"],
                title=message,
                body=f"Decommission `{name}`: removes `{rel_path}/` so Argo CD prunes the workload.",
            )
        print(f"gitops-emitter decommission: PR #{pr.get('number')} {pr.get('html_url')}")
        if cfg["pr_auto_merge"]:
            merge_sha = forge.merge_pull_request(cfg["repo_url"], token, pr["number"])
            print(f"gitops-emitter decommission: auto-merged @ {merge_sha[:12]}")
            sha = merge_sha
    else:
        print(f"gitops-emitter decommission: removed {rel_path} @ {sha[:12]}")

    # A decommissioned persona must not leave a sticky override behind.
    overrides_file = Path(cfg["overrides_dir"]).expanduser() / f"{name}.yaml"
    if overrides_file.is_file():
        overrides_file.unlink()
        print(f"gitops-emitter decommission: removed persisted override {overrides_file}")
    return sha


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    usage = (
        "usage: python -m gitops_emitter.decommission_cli <name> | --source <url> [--subdir <path>]"
    )
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        if len(args) == 1 and not args[0].startswith("-"):
            decommission(args[0], None)
            return 0
        if len(args) == 2 and args[0] == "--source":
            decommission(None, args[1])
            return 0
        if len(args) == 4 and args[0] == "--source" and args[2] == "--subdir":
            decommission(None, args[1], args[3])
            return 0
    except GitopsEmitterError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(usage, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
