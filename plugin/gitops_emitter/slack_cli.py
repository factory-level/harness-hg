"""Slack-provisioning CLI: ``python -m gitops_emitter.slack_cli <subcommand>``.

Invoked by the bootstrap's ``SlackWorkspace`` component from ``local.Command``
resources (the ``scaffold_cli`` idiom): config from the environment, never
argv; stdout is machine JSON only; prose and errors go to stderr.

``provision-app`` is the stateful path (ADR 0175): its stdout carries the
app's signing secret and bot token EXACTLY ONCE per run, captured by a
Command whose stdout is secret-marked — encrypted Pulumi state is the
durable home of both. Everything else keeps stdout secret-free.

Environment (per subcommand):

- ``SLACK_CLI_BIN``       — the Slack CLI binary (default ``slack``);
  ``bot-identity`` / ``delete-app`` only
- ``SLACK_TEAM_ID``       (required) — the workspace, e.g. ``T0123456789``
- ``SLACK_PROJECT_DIR``   (required) — the app's project directory (the
  CLI-compatible record ``provision-app`` maintains for ``slack api`` calls)
- ``SLACK_MANIFEST_JSON`` — ``provision-app`` / ``apply-manifest``: the full
  app manifest, built by the component (the same JSON is the Command's
  ``triggers`` entry). ``sync-bot-token`` reads it for scopes, falling back
  to ``SLACK_PROJECT_DIR/manifest.json``.
- ``SLACK_APP_ID``        — ``apply-manifest`` (required); ``bot-identity`` /
  ``delete-app`` / ``sync-bot-token`` (optional, defaults to the project
  record; ``delete-app`` also accepts the previous provision stdout)
- ``SLACK_CREDENTIALS_FILE`` — default ``~/.slack/credentials.json`` (the
  ``slack login`` pair; raw-API subcommands ride its user token)
- ``PULUMI_COMMAND_STDOUT`` — injected by @pulumi/command: ``provision-app``
  branches create-vs-update on it and carries the signing secret forward
- ``SLACK_EVENTS_PROBE_TIMEOUT`` — ``apply-manifest`` only (default 180):
  seconds to wait for the events endpoint to answer 401-unsigned before
  applying (a fresh deployment's pod starts asynchronously via Argo CD)
- ``sync-bot-token`` additionally reads ``AGENT_NAME``, ``PULUMI_DIR``,
  ``PULUMI_STACK``. It is the ADOPTED-app escape hatch (config-pinned
  appId), operator-run: sync → ``hg env apply`` → ``pulumi up``.

Subcommands: ``provision-app`` | ``apply-manifest`` | ``bot-identity`` |
``delete-app`` | ``sync-bot-token``.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .errors import GitopsEmitterError
from .slack import (
    apply_manifest,
    bot_identity,
    delete_app,
    manifest_bot_scopes,
    project_app_id,
    provision_app,
    sync_bot_token,
)


def _require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"gitops-emitter slack: {name} is required", file=sys.stderr)
        raise SystemExit(2)
    return value


def _credentials_file() -> Path:
    return Path(
        os.environ.get("SLACK_CREDENTIALS_FILE") or Path.home() / ".slack" / "credentials.json"
    )


def _manifest_json(project_dir: Path) -> str:
    """The manifest from the env, else the project record ``provision-app``
    (or a prior run) wrote — the single source for bot scopes."""
    manifest_json = os.environ.get("SLACK_MANIFEST_JSON", "")
    if manifest_json:
        return manifest_json
    manifest_file = project_dir / "manifest.json"
    try:
        return manifest_file.read_text()
    except OSError:
        print(
            "gitops-emitter slack: SLACK_MANIFEST_JSON is unset and "
            f"{manifest_file} does not exist - run provision-app (pulumi up) "
            "first or set SLACK_MANIFEST_JSON",
            file=sys.stderr,
        )
        raise SystemExit(2) from None


def _stdout_app_id() -> str:
    """The app id from a previous provision run's stdout, if any."""
    try:
        parsed = json.loads((os.environ.get("PULUMI_COMMAND_STDOUT") or "").strip() or "{}")
    except ValueError:
        return ""
    return str(parsed.get("app_id", "")) if isinstance(parsed, dict) else ""


def main() -> None:
    subs = {"provision-app", "apply-manifest", "bot-identity", "delete-app", "sync-bot-token"}
    if len(sys.argv) != 2 or sys.argv[1] not in subs:
        print(
            "usage: python -m gitops_emitter.slack_cli " + "|".join(sorted(subs)),
            file=sys.stderr,
        )
        raise SystemExit(2)
    sub = sys.argv[1]

    cli_bin = os.environ.get("SLACK_CLI_BIN") or "slack"
    team_id = _require("SLACK_TEAM_ID")
    project_dir = Path(_require("SLACK_PROJECT_DIR"))

    try:
        if sub == "provision-app":
            out = provision_app(
                _credentials_file(),
                team_id,
                _require("SLACK_MANIFEST_JSON"),
                project_dir,
                previous_stdout=os.environ.get("PULUMI_COMMAND_STDOUT", ""),
            )
        elif sub == "apply-manifest":
            out = apply_manifest(
                _credentials_file(),
                team_id,
                _require("SLACK_APP_ID"),
                _require("SLACK_MANIFEST_JSON"),
                probe_timeout_s=int(os.environ.get("SLACK_EVENTS_PROBE_TIMEOUT") or "180"),
            )
        elif sub == "bot-identity":
            app_id = os.environ.get("SLACK_APP_ID") or project_app_id(project_dir, team_id) or ""
            if not app_id:
                print(
                    "gitops-emitter slack: SLACK_APP_ID is unset and the project "
                    "records no installed app - run provision-app first",
                    file=sys.stderr,
                )
                raise SystemExit(2)
            out = bot_identity(cli_bin, project_dir, team_id, app_id)
        elif sub == "sync-bot-token":
            app_id = os.environ.get("SLACK_APP_ID") or project_app_id(project_dir, team_id) or ""
            if not app_id:
                print(
                    "gitops-emitter slack: SLACK_APP_ID is unset and the project "
                    "records no installed app - set the adopted app's id",
                    file=sys.stderr,
                )
                raise SystemExit(2)
            scopes = manifest_bot_scopes(json.loads(_manifest_json(project_dir)))
            out = sync_bot_token(
                _credentials_file(),
                team_id,
                app_id,
                _require("AGENT_NAME"),
                Path(_require("PULUMI_DIR")),
                _require("PULUMI_STACK"),
                scopes,
            )
        else:
            app_id = (
                os.environ.get("SLACK_APP_ID")
                or _stdout_app_id()
                or project_app_id(project_dir, team_id)
                or ""
            )
            if not app_id:
                print(
                    "gitops-emitter slack: SLACK_APP_ID is unset and the project "
                    "records no installed app - nothing to delete",
                    file=sys.stderr,
                )
                raise SystemExit(2)
            out = delete_app(cli_bin, project_dir, team_id, app_id)
    except GitopsEmitterError as exc:
        print(f"gitops-emitter slack: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    except ValueError as exc:
        print(f"gitops-emitter slack: invalid manifest JSON: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    print(json.dumps(out))


if __name__ == "__main__":
    main()
