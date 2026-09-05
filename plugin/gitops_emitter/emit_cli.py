"""``python -m gitops_emitter.emit_cli`` - the push-driven emit (ADR-149).

The Hermes pipeline emits a record as a SIDE EFFECT of ``hermes profile
install`` (the fork fires ``profile_install``/``profile_update`` and this
package's hook renders and publishes). Eve has no such lifecycle hook -
its ``defineHook`` observes runtime stream events after the fact - so for
an Eve agent the CALLER emits: the Pulumi ``EveAgents`` component runs this
CLI as its per-agent command, and ``hg`` runs it with ``--render-only``
for validation and the local loop. The record it publishes goes through
``emitter.publish_record``, the exact publisher the Hermes hook uses
(direct-vs-PR, the three-state idempotency table, branch protection,
auto-merge), so the GitOps repository cannot tell the two runtimes apart.

    python -m gitops_emitter.emit_cli --runtime eve \\
        --agent-dir <checkout>/agents/echo --name echo \\
        --source https://github.com/org/agents.git --ref main --sha <40hex> \\
        [--subdir agents/echo] [--event install|update] [--render-only]

Configuration comes from ``emitter.load_plugin_config`` - on an Eve-only
host that means ``HERMES_GITOPS_CONFIG_SOURCE=env`` plus the
``HERMES_GITOPS_*`` variables, or ``HERMES_GITOPS_CONFIG_JSON``. The token
is ``GITOPS_GIT_TOKEN`` (``emitter.read_git_token``). The fail-loud secret
check (``HERMES_GITOPS_AVAILABLE_SECRETS_JSON``) applies exactly as it does
to a Hermes install. Exit 1 with a scrubbed message on any
``GitopsEmitterError``; the caller's exit code is the contract.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import List, Optional

from .harness.hermes import (
    EXTENSION_FILE_RELPATH,
    GitopsEmitterError,
    _check_required_secrets,
    load_plugin_config,
    publish_record,
    read_git_token,
    required_secret_names,
)
from .harness.eve import (
    build_eve_record,
    check_eve_version,
    eve_env_requires,
    load_eve_extension,
    read_eve_manifest,
    validate_eve_record,
)
from . import layout
from .render import render_yaml
from .scaffold import ensure_repo_and_scaffold

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def render_eve_record(
    *,
    agent_dir: Path,
    name: Optional[str],
    source: str,
    sha: str,
    ref: Optional[str],
    subdir: Optional[str],
    expect_eve_version: Optional[str] = None,
    app_values: Optional[dict] = None,
    contract_dir: Optional[str] = None,
) -> tuple[str, str, dict]:
    """The pure half: (name, yaml_text, record). Shared by ``--render-only``
    and the publish path so the two can never diverge."""
    if not _SHA_RE.match(sha):
        # The value is deliberately not echoed: an orchestration slip could
        # put something other than a sha in this argument.
        raise GitopsEmitterError(
            "gitops-emitter: --sha must be a full 40-character lowercase commit sha"
        )
    manifest = read_eve_manifest(agent_dir)
    if name and name != manifest["name"]:
        raise GitopsEmitterError(
            f"gitops-emitter: --name {name!r} does not match the project's package.json name "
            f"{manifest['name']!r}; the package name IS the agent identity (omit --name, or "
            "rename the package)"
        )
    name = manifest["name"]
    extension = load_eve_extension(agent_dir, contract_dir, subdir)
    check_eve_version(manifest, expected=expect_eve_version, extension=extension)
    record = build_eve_record(
        name,
        source=source,
        sha=sha,
        ref=ref,
        subdir=subdir,
        extension=extension,
        app_values=app_values,
    )
    validate_eve_record(record)
    return name, render_yaml(record), record


def parse_app_values(raw: Optional[str]) -> Optional[dict]:
    """``--app-values`` is a JSON object ``{<appName>: {<values fragment>}}``
    - the per-instance override instruction the Hermes path takes from the
    overrides document. Anything but an object is refused before the
    record is built; the value is not echoed (it may carry a credential
    that an app's ``valuesRequired`` demands)."""
    if raw is None or not raw.strip():
        return None
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GitopsEmitterError(
            f"gitops-emitter: --app-values is not valid JSON ({exc.msg} at column {exc.colno})"
        ) from exc
    if not isinstance(doc, dict):
        raise GitopsEmitterError(
            "gitops-emitter: --app-values must be a JSON object {<appName>: {<values>}}"
        )
    return doc


def emit_eve(args: argparse.Namespace) -> Optional[str]:
    agent_dir = Path(args.agent_dir)
    name, yaml_text, record = render_eve_record(
        agent_dir=agent_dir,
        name=args.name,
        source=args.source,
        sha=args.sha,
        ref=args.ref,
        subdir=args.subdir,
        expect_eve_version=args.expect_eve_version,
        app_values=parse_app_values(args.app_values),
        contract_dir=args.contract_dir,
    )
    if args.render_only:
        sys.stdout.write(yaml_text)
        return None

    cfg = load_plugin_config()
    env_requires = eve_env_requires(load_eve_extension(agent_dir, args.contract_dir, args.subdir))
    _check_required_secrets(name, required_secret_names(env_requires))
    token = read_git_token(str(agent_dir))
    if cfg["scaffold"]:
        ensure_repo_and_scaffold(cfg, token)

    rel_path = f"{cfg['profiles_path']}/{name}/profile.yaml"
    generated_trees = [cfg["profiles_path"], "catalog"]
    # The catalogue copies the authored contract byte-for-byte: the legacy
    # file, or the agent-team agent.yaml (ADR 0178's stated cost: the split
    # siblings ride the inputs hash, not the catalogue).
    try:
        _folded, agent_file = layout.load_agent_declaration(agent_dir, args.contract_dir, args.subdir)
    except layout.LayoutError as exc:
        raise GitopsEmitterError(str(exc)) from exc
    ext_path = agent_file if agent_file is not None else agent_dir / EXTENSION_FILE_RELPATH
    catalogue_files = [
        (
            f"catalog/profiles/{name}/contract.yaml",
            ext_path.read_bytes().decode("utf-8"),
        ),
        (
            f"catalog/profiles/{name}/provenance.yaml",
            f'profile: {name}\nsourceSha: "{args.sha}"\nruntime: eve\n',
        ),
    ]
    sha12 = args.sha[:12]
    message = f"gitops-emitter: {args.event} {name} eve @ {sha12}"
    commit = publish_record(
        cfg,
        name=name,
        rel_path=rel_path,
        yaml_text=yaml_text,
        catalogue_files=catalogue_files,
        generated_trees=generated_trees,
        message=message,
        token=token,
        event=args.event,
        pr_body=(
            f"Rendered EveAgent record for `{name}` ({args.event}, eve @ `{sha12}`).\n\n"
            f"Opened by gitops-emitter; the head branch is reset from "
            f"`{cfg['branch']}` on every change."
        ),
    )
    if commit is None:
        print(f"gitops-emitter: {rel_path} already up to date @ {sha12} - nothing to publish")
    else:
        print(f"gitops-emitter: published {rel_path} @ {sha12} ({commit[:12]})")
    return commit


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m gitops_emitter.emit_cli",
        description="Render (and publish) an agent record from its source checkout.",
    )
    p.add_argument("--runtime", required=True, choices=["eve"], help="the agent runtime")
    p.add_argument("--agent-dir", required=True, help="the Eve project directory (package.json + agent/)")
    p.add_argument("--name", help="expected agent name; must equal package.json name when given")
    p.add_argument("--source", required=True, help="git URL the pod will clone")
    p.add_argument("--sha", required=True, help="full 40-hex commit the pod will build")
    p.add_argument("--ref", help="the ref --sha was resolved from (provenance only)")
    p.add_argument("--subdir", help="subdirectory of --source holding the project, e.g. agents/echo")
    p.add_argument(
        "--contract-dir",
        help="agent-team layout (ADR 0178): the agent's harness-hg/ directory when it is not "
        "../harness-hg beside a src/ payload (e.g. a separate clone); HERMES_GITOPS_CONTRACT_DIR is "
        "the same knob as an environment variable",
    )
    p.add_argument("--event", default="install", choices=["install", "update"])
    p.add_argument(
        "--app-values",
        help="JSON object {<appName>: {<values fragment>}} deep-merged onto each declared "
        "app's author values (the per-instance override; every valuesRequired path must "
        "resolve after the merge)",
    )
    p.add_argument(
        "--expect-eve-version",
        help="the platform's pinned eve release (versions.json runtimes.eve.version); the "
        "project's locked eve must equal it, or deployment.runtimeImageTag when set",
    )
    p.add_argument(
        "--render-only",
        action="store_true",
        help="print the record to stdout and touch nothing (hg validate / hg up)",
    )
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        emit_eve(args)
        return 0
    except GitopsEmitterError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - the fail-loud boundary
        # Same posture as the Hermes hook's _sanitize_generic_exception: an
        # exception this package did not raise has not had its message
        # scrubbed of tokens or tempdir paths, so only its type is shown.
        print(
            f"gitops-emitter: emit failed with an unexpected {type(exc).__name__} "
            "(details withheld - they were not scrubbed; rerun with the same inputs under "
            "a debugger, or check the publish path's logs)",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
