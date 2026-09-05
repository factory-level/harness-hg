"""Slack workspace provisioning via the official Slack CLI.

The bootstrap's ``SlackWorkspace`` component (``infra/src/components/
slack-workspace``) shells ``python -m gitops_emitter.slack_cli`` from
``local.Command`` resources — the same idiom as ``scaffold_cli`` — and this
module holds the logic. It wraps the **Slack CLI binary** rather than the
manifest REST API because the CLI's flow is strictly stronger, proven live
on 2026-08-27:

- ``slack install --team <T> --environment deployed --force`` both CREATES
  the app from the project's ``manifest.json`` and INSTALLS it to the
  workspace, non-interactively — there is no browser OAuth step in this
  path, which the raw ``apps.manifest.create`` route cannot avoid.
- ``slack api <method> --app <id>`` executes bot-scoped Web API calls with
  the CLI resolving the bot token internally (``apps.developerInstall``);
  the token never reaches disk, argv, or our stdout.
- The CLI's own credential pair (``~/.slack/credentials.json``, written by
  the one-time ``slack login`` handshake) self-refreshes, replacing the
  app-config-token seed/rotate machinery this module would otherwise need.

Contract with the component:

- A **project directory per app** is the idempotency record: the CLI writes
  ``.slack/apps.json`` (``{"apps": {"<team>": {"app_id": ...}}}``) on first
  install and updates the same app on every later run. The component passes
  the directory in; this module materializes ``manifest.json`` (verbatim
  from ``SLACK_MANIFEST_JSON`` — the TS side builds it, because the same
  JSON is the Command's ``triggers`` entry) and the static hooks file.
- stdout is machine-readable JSON only; every human-facing word goes to
  stderr. **``provision-app`` alone prints secrets on stdout, by design**:
  its Command marks stdout secret (``additionalSecretOutputs``), so the
  encrypted Pulumi state is the durable home of the signing secret and the
  bot token (ADR 0175). stderr stays secret-free everywhere.
- Fail loudly with a named fix: a missing binary, a missing login, and a
  team mismatch each raise :class:`GitopsEmitterError` with the exact
  command that repairs it.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from .errors import GitopsEmitterError

__all__ = [
    "apply_manifest",
    "bot_identity",
    "delete_app",
    "delete_app_api",
    "fetch_bot_token",
    "hooks_file_content",
    "manifest_bot_scopes",
    "project_app_id",
    "provision_app",
    "strip_event_subscriptions",
    "sync_bot_token",
]

# The get-manifest hook must swallow the extra flags the CLI appends
# (``--source=<dir>``); a bare ``cat`` chokes on them, hence the sh -c
# wrapper whose positional args are simply unused.
_HOOKS_JSON: Dict[str, Any] = {"hooks": {"get-manifest": "sh -c 'cat manifest.json'"}}


def hooks_file_content() -> str:
    """The exact ``.slack/hooks.json`` body every app project carries."""
    return json.dumps(_HOOKS_JSON, indent=2) + "\n"


def _run_slack(
    cli_bin: str,
    args: List[str],
    cwd: Path,
    timeout: int = 120,
) -> subprocess.CompletedProcess[str]:
    """Run the Slack CLI, mapping the failure modes to named fixes."""
    try:
        return subprocess.run(  # noqa: S603 - fixed binary, list argv, no shell
            [cli_bin, *args, "--skip-update", "--force"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise GitopsEmitterError(
            f"slack CLI not found at {cli_bin!r}. Install it "
            "(https://downloads.slack-edge.com/slack-cli/install.sh) or set "
            "SLACK_CLI_BIN to the binary's path."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise GitopsEmitterError(
            f"slack {args[0]} timed out after {timeout}s - the CLI may be "
            "waiting on an interactive prompt; re-run `slack auth list` on "
            "this host to confirm the login is still valid."
        ) from exc


def _raise_named(result: subprocess.CompletedProcess[str], team_id: str, doing: str) -> None:
    """Translate a failed CLI invocation into an actionable error."""
    text = (result.stdout or "") + (result.stderr or "")
    if "not logged in" in text.lower() or "credentials_not_found" in text:
        raise GitopsEmitterError(
            f"{doing}: the slack CLI has no login for this host. Run the "
            f"one-time handshake: `slack login` (approve the "
            f"/slackauthticket command inside the {team_id} workspace)."
        )
    if "team_not_found" in text or "not authorized" in text.lower():
        raise GitopsEmitterError(
            f"{doing}: the slack CLI login does not cover team {team_id}. "
            f"Run `slack login` while signed into that workspace "
            f"(`slack auth list` shows current teams)."
        )
    # Generic: surface the CLI's own words - they are already scrubbed of
    # tokens (the CLI never prints credentials).
    tail = "\n".join(text.strip().splitlines()[-6:])
    raise GitopsEmitterError(f"{doing} failed (exit {result.returncode}):\n{tail}")


def project_app_id(project_dir: Path, team_id: str) -> Optional[str]:
    """The app id the CLI recorded for *team_id*, or None before first install."""
    apps_file = project_dir / ".slack" / "apps.json"
    if not apps_file.exists():
        return None
    try:
        data = json.loads(apps_file.read_text())
    except (OSError, ValueError):
        return None
    entry = (data.get("apps") or {}).get(team_id) or {}
    app_id = entry.get("app_id")
    return str(app_id) if app_id else None


def _parse_manifest(manifest_json: str) -> Dict[str, Any]:
    """Parse + shape-check a manifest coming in from the environment."""
    try:
        manifest = json.loads(manifest_json)
    except ValueError as exc:
        raise GitopsEmitterError(f"SLACK_MANIFEST_JSON is not valid JSON: {exc}") from exc
    if not isinstance(manifest, dict) or "display_information" not in manifest:
        raise GitopsEmitterError(
            "SLACK_MANIFEST_JSON must be a Slack app manifest object "
            "(missing display_information)."
        )
    return manifest


def strip_event_subscriptions(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """A copy of *manifest* without ``settings.event_subscriptions``.

    Used on the CREATE path only: Slack challenges the events request_url
    at manifest apply, and at creation time the pod cannot yet hold the new
    app's signing secret — events attach in a later step, after the secret
    has rolled out (ADR 0175's two-phase rule).
    """
    stripped = json.loads(json.dumps(manifest))
    settings = stripped.get("settings")
    if isinstance(settings, dict):
        settings.pop("event_subscriptions", None)
    return stripped


def manifest_bot_scopes(manifest: Dict[str, Any]) -> List[str]:
    """The manifest's bot scopes — required by ``apps.developerInstall``.

    A scopeless install would mint a token that can do nothing, which is
    worse than a loud failure, so an empty list refuses.
    """
    scopes = ((manifest.get("oauth_config") or {}).get("scopes") or {}).get("bot") or []
    if not isinstance(scopes, list) or not scopes:
        raise GitopsEmitterError(
            "the manifest declares no oauth_config.scopes.bot - refusing to "
            "install a scopeless bot; fix the app's botScopes declaration"
        )
    return [str(s) for s in scopes]


def _write_project_record(
    project_dir: Path, team_id: str, manifest: Dict[str, Any], app_id: str
) -> None:
    """Materialize the Slack-CLI project record for *app_id* so later
    ``slack api ... --app <id>`` calls (bot-identity, channel joins) keep
    resolving their token through the CLI."""
    slack_dir = project_dir / ".slack"
    slack_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (slack_dir / "hooks.json").write_text(hooks_file_content())
    (slack_dir / "apps.json").write_text(
        json.dumps({"apps": {team_id: {"app_id": app_id, "team_id": team_id}}, "default": team_id})
    )


def bot_identity(cli_bin: str, project_dir: Path, team_id: str, app_id: str) -> Dict[str, str]:
    """The installed app's bot identity via ``auth.test`` run AS the bot.

    Returns ``{"user_id", "bot_id", "team_id"}``; fails loudly on a team
    mismatch (a response for the wrong workspace is worse than an error).
    """
    result = _run_slack(
        cli_bin,
        ["api", "auth.test", "--app", app_id, "--team", team_id],
        cwd=project_dir,
    )
    if result.returncode != 0:
        _raise_named(result, team_id, f"slack api auth.test ({app_id})")
    # The CLI prints the raw Web API JSON on stdout.
    try:
        payload = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise GitopsEmitterError(
            f"auth.test ({app_id}): could not parse the CLI's response as JSON."
        ) from exc
    if not payload.get("ok"):
        raise GitopsEmitterError(f"auth.test ({app_id}) returned ok=false: {payload.get('error')}")
    if payload.get("team_id") != team_id:
        raise GitopsEmitterError(
            f"auth.test ({app_id}) answered for team {payload.get('team_id')}, "
            f"expected {team_id} - refusing to hand back a foreign identity."
        )
    return {
        "user_id": str(payload.get("user_id", "")),
        "bot_id": str(payload.get("bot_id", "")),
        "team_id": str(payload.get("team_id", "")),
    }


def delete_app(cli_bin: str, project_dir: Path, team_id: str, app_id: str) -> Dict[str, str]:
    """Delete the app (opt-in destroy path; never wired by default)."""
    result = _run_slack(
        cli_bin,
        ["app", "delete", "--app", app_id, "--team", team_id],
        cwd=project_dir,
    )
    if result.returncode != 0:
        _raise_named(result, team_id, f"slack app delete ({app_id})")
    return {"app_id": app_id, "deleted": "true"}


# ---------------------------------------------------------------------------
# Bot-token sync (operator-run, NEVER inside `pulumi up`): fetch the app's
# bot token the same way the Slack CLI does internally - the undocumented
# `apps.developerInstall` method under the CLI's stored USER token
# (~/.slack/credentials.json, the self-refreshing pair `slack login` wrote)
# - and pipe it straight into `pulumi config set --secret` over stdin. The
# token is returned by Slack, handed to pulumi, and released: it is never
# printed, never in argv, never written to disk by this module. Built at
# operator direction (ADR 0174): the alternative is a manual copy from the
# app settings page per app, per rotation.
#
# The signing secret has NO equivalent fetch: Slack returns it exactly
# once, at app creation. For apps this module provisions (provision_app)
# it is captured at birth into encrypted Pulumi state; for ADOPTED apps
# (config-pinned appId) it remains a settings-page copy — that path is the
# escape hatch, and sync_bot_token below serves it.

_SLACK_API_BASE = "https://slack.com/api"


def _default_http_post(url: str, token: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """POST a Web API method with Bearer auth; parsed-JSON response.

    Encoding dispatches on the payload: all-string values ride form-encoded
    (keeping the live-proven ``apps.manifest.*`` calls byte-identical), any
    non-string value (``apps.developerInstall``'s ``bot_scopes`` array)
    switches the whole payload to a JSON body — matching how the Slack CLI
    itself posts that method (slack-cli ``internal/api/app.go``).
    """
    import urllib.parse
    import urllib.request

    if all(isinstance(v, str) for v in payload.values()):
        data = urllib.parse.urlencode(payload).encode()
        content_type = "application/x-www-form-urlencoded"
    else:
        data = json.dumps(payload).encode()
        content_type = "application/json"
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": content_type},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https API host
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _cli_user_token(credentials_file: Path, team_id: str) -> str:
    """The Slack CLI's stored user token for *team_id* - the auth its own
    internal calls ride. Read-only: the CLI owns rotation of this pair."""
    try:
        creds = json.loads(credentials_file.read_text())
    except OSError as exc:
        raise GitopsEmitterError(
            f"cannot read the Slack CLI credentials at {credentials_file} - "
            "run the one-time `slack login` handshake on this host first"
        ) from exc
    except ValueError as exc:
        raise GitopsEmitterError(f"{credentials_file} is not valid JSON") from exc
    entry = creds.get(team_id) or {}
    token = entry.get("token", "")
    if not token:
        raise GitopsEmitterError(
            f"the Slack CLI login covers no team {team_id} - run `slack login` "
            f"while signed into that workspace (`slack auth list` shows teams)"
        )
    return str(token)


def _token_hint(error: str) -> str:
    """A named fix for the one auth failure our raw-API path can cause:
    the Slack CLI self-refreshes its credential only when the CLI runs,
    and this module merely READS the file (found live 2026-08-29)."""
    if error == "token_expired":
        return (
            " - the Slack CLI's stored user token has expired: run "
            "`slack auth list` on this host (any CLI call refreshes the "
            "credential pair), then re-run"
        )
    return ""


def _bot_token_from_install(resp: Dict[str, Any]) -> str:
    """The bot token from an apps.developerInstall response. The live shape
    (confirmed from the Slack CLI's own successful calls) is
    ``api_access_tokens.bot``; older/other shapes carry ``bot_access_token``
    or ``credentials.bot_access_token``. Try all, in that order."""
    return str(
        (resp.get("api_access_tokens") or {}).get("bot")
        or resp.get("bot_access_token")
        or (resp.get("credentials") or {}).get("bot_access_token")
        or ""
    )


def _developer_install(
    post, api_base: str, token: str, app_id: str, bot_scopes: List[str]
) -> Dict[str, Any]:
    """apps.developerInstall with the arg shape the Slack CLI actually
    sends (slack-cli ``internal/api/app.go``, ``DeveloperAppInstall``): a
    JSON body of ``app_id`` + ``bot_scopes`` + ``outgoing_domains``, with
    ``team_id`` OMITTED on non-Enterprise workspaces and no ``set_active``
    — the earlier ``{team_id, app_id, set_active}`` guess is what drew
    ``invalid_argument`` in the 2026-08-27 probe. Enterprise Grid (where
    the field carries an enterprise grant id) is out of scope here.
    """
    return post(
        f"{api_base}/apps.developerInstall",
        token,
        {"app_id": app_id, "bot_scopes": sorted(bot_scopes), "outgoing_domains": []},
    )


def fetch_bot_token(
    credentials_file: Path,
    team_id: str,
    app_id: str,
    bot_scopes: List[str],
    http_post=None,
) -> str:
    """The installed app's bot token, via apps.developerInstall.

    Fails with a named explanation when the method refuses the token type
    (Slack has changed this surface before - it is undocumented), so the
    operator knows the fallback is the app settings page, not a retry.
    """
    post = http_post or _default_http_post
    token = _cli_user_token(credentials_file, team_id)
    resp = _developer_install(post, _SLACK_API_BASE, token, app_id, bot_scopes)
    if not resp.get("ok"):
        error = resp.get("error", "unknown")
        hint = (
            " - the CLI's stored token was refused for this undocumented "
            "method; copy the Bot User OAuth Token from "
            f"https://api.slack.com/apps/{app_id} (OAuth & Permissions) instead"
            if error in ("not_allowed_token_type", "invalid_auth", "missing_scope")
            else ""
        )
        raise GitopsEmitterError(f"apps.developerInstall ({app_id}): {error}{hint}")
    bot_token = _bot_token_from_install(resp)
    if not bot_token:
        raise GitopsEmitterError(
            f"apps.developerInstall ({app_id}) returned ok but no bot token "
            f"(keys: {', '.join(sorted(resp.keys()))}) - "
            "the response shape changed; fall back to the app settings page"
        )
    return bot_token


def sync_bot_token(
    credentials_file: Path,
    team_id: str,
    app_id: str,
    agent: str,
    pulumi_dir: Path,
    pulumi_stack: str,
    bot_scopes: List[str],
    http_post=None,
) -> Dict[str, str]:
    """Fetch the bot token and hand it to pulumi over STDIN - the one hop
    that keeps it out of argv, logs, and this module's own output.

    The adopted-app escape hatch (config-pinned appId keeps config-sourced
    secrets); provisioned apps never need it - their token lives in state.
    """
    bot_token = fetch_bot_token(
        credentials_file, team_id, app_id, bot_scopes, http_post=http_post
    )
    config_path = f"agentSecrets.{agent}.SLACK_BOT_TOKEN"
    try:
        result = subprocess.run(  # noqa: S603 - fixed binary, list argv, no shell
            ["pulumi", "-s", pulumi_stack, "config", "set", "--secret", "--path", config_path],
            cwd=str(pulumi_dir),
            input=bot_token,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError as exc:
        raise GitopsEmitterError("pulumi not found on PATH") from exc
    if result.returncode != 0:
        tail = "\n".join((result.stderr or "").strip().splitlines()[-4:])
        raise GitopsEmitterError(
            f"pulumi config set --path {config_path} failed (exit {result.returncode}):\n{tail}"
        )
    return {"app_id": app_id, "path": config_path, "synced": "true"}


# ---------------------------------------------------------------------------
# Stateful provisioning (RUNS INSIDE `pulumi up`, ADR 0175): create or
# update the app through the RAW manifest API so the signing secret -
# which Slack returns exactly once, at creation, and never again - is
# captured at birth alongside the bot token. Both ride stdout as the
# provision Command's secret-marked output; encrypted Pulumi state is
# their durable home, and AgentSecrets consumes them as resource outputs.
# Nothing here touches stack config (ADR 0174's objection was mutating
# stack config mid-`up`; resource outputs do not).
#
# This exists because the Slack CLI's `install` path calls
# apps.manifest.create internally and DISCARDS the signing secret. Doing
# the create ourselves is the only way to obtain it programmatically. Auth
# is the stored CLI user token (`slack login`).
#
# The undocumented surface (apps.manifest.create / .update / .delete /
# developerInstall under a user token) has changed before; each call's
# refusal names the settings-page fallback rather than retrying.


def _pulumi_set_secret(value: str, config_path: str, pulumi_dir: Path, pulumi_stack: str) -> None:
    """Pipe *value* into `pulumi config set --secret --path` over stdin."""
    try:
        result = subprocess.run(  # noqa: S603 - fixed binary, list argv, no shell
            ["pulumi", "-s", pulumi_stack, "config", "set", "--secret", "--path", config_path],
            cwd=str(pulumi_dir),
            input=value,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError as exc:
        raise GitopsEmitterError("pulumi not found on PATH") from exc
    if result.returncode != 0:
        tail = "\n".join((result.stderr or "").strip().splitlines()[-4:])
        raise GitopsEmitterError(
            f"pulumi config set --path {config_path} failed (exit {result.returncode}):\n{tail}"
        )


def delete_app_api(
    credentials_file: Path,
    team_id: str,
    app_id: str,
    http_post=None,
) -> Dict[str, str]:
    """Delete an app via apps.manifest.delete under the CLI user token."""
    post = http_post or _default_http_post
    token = _cli_user_token(credentials_file, team_id)
    resp = post(f"{_SLACK_API_BASE}/apps.manifest.delete", token, {"app_id": app_id})
    if not resp.get("ok"):
        raise GitopsEmitterError(
            f"apps.manifest.delete ({app_id}): {resp.get('error', 'unknown')}"
            + _token_hint(str(resp.get("error", "")))
        )
    return {"app_id": app_id, "deleted": "true"}


def _install_bot_token(post, token: str, app_id: str, manifest: Dict[str, Any], doing: str) -> str:
    """developerInstall + extract the bot token, failing loudly by name."""
    installed = _developer_install(
        post, _SLACK_API_BASE, token, app_id, manifest_bot_scopes(manifest)
    )
    if not installed.get("ok"):
        raise GitopsEmitterError(
            f"apps.developerInstall ({doing}, app {app_id}): "
            f"{installed.get('error', 'unknown')}"
            + _token_hint(str(installed.get("error", "")))
            + " - the app exists but the install was refused; the "
            f"settings-page fallback is https://api.slack.com/apps/{app_id} "
            "(OAuth & Permissions)"
        )
    bot_token = _bot_token_from_install(installed)
    if not bot_token:
        raise GitopsEmitterError(
            f"apps.developerInstall ({doing}) returned ok but no bot token "
            f"(keys: {', '.join(sorted(installed.keys()))}) - the response "
            "shape changed; fall back to the app settings page"
        )
    return bot_token


def _previous_provision(previous_stdout: str) -> Optional[Dict[str, Any]]:
    """The prior provision record from ``PULUMI_COMMAND_STDOUT``, or None
    when this is a first run (no/blank/non-JSON previous output)."""
    text = (previous_stdout or "").strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    if not isinstance(parsed, dict) or not parsed.get("app_id"):
        return None
    return parsed


def provision_app(
    credentials_file: Path,
    team_id: str,
    manifest_json: str,
    project_dir: Path,
    previous_stdout: str = "",
    http_post=None,
) -> Dict[str, str]:
    """Create or update the app, returning BOTH secrets for state capture.

    The provision Command's create/update entry point (ADR 0175). Branches
    on *previous_stdout* (``PULUMI_COMMAND_STDOUT``):

    - **Create** (no prior record): ``apps.manifest.create`` with
      ``event_subscriptions`` STRIPPED (the two-phase events rule) — the
      one call that returns the signing secret — then developerInstall for
      the bot token. A pre-existing project record naming a different app
      is reported as ``superseded_app_id`` and NEVER deleted here;
      retirement is an explicit post-proof runbook step.
    - **Update** (prior record with both secrets): ``apps.manifest.update``
      with the FULL manifest (safe: the pod already holds this app's
      unchanged signing secret, so the events challenge passes), then a
      fresh developerInstall — the signing secret carries forward from the
      prior record. A prior record MISSING the signing secret is a hard
      refusal naming recreation as the fix — never a silent re-create.
    """
    post = http_post or _default_http_post
    manifest = _parse_manifest(manifest_json)
    token = _cli_user_token(credentials_file, team_id)
    previous = _previous_provision(previous_stdout)

    if previous is not None:
        app_id = str(previous["app_id"])
        signing_secret = str(previous.get("signing_secret", ""))
        if not signing_secret:
            raise GitopsEmitterError(
                f"provision-app ({project_dir.name}): the previous run's "
                f"record for app {app_id} carries no signing secret - it "
                "cannot be re-fetched (Slack returns it once, at creation). "
                "Recreate the app: taint/replace this resource so the create "
                "path runs, then let the events step re-attach subscriptions."
            )
        updated = post(
            f"{_SLACK_API_BASE}/apps.manifest.update",
            token,
            {"app_id": app_id, "manifest": json.dumps(manifest)},
        )
        if not updated.get("ok"):
            raise GitopsEmitterError(
                f"apps.manifest.update ({project_dir.name}, app {app_id}): "
                f"{updated.get('error', 'unknown')}"
                + _token_hint(str(updated.get("error", "")))
                + " - the app was not changed; fix the manifest or the "
                "login and re-run"
            )
        bot_token = _install_bot_token(post, token, app_id, manifest, project_dir.name)
        _write_project_record(project_dir, team_id, manifest, app_id)
        return {
            "app_id": app_id,
            "signing_secret": signing_secret,
            "bot_token": bot_token,
            "superseded_app_id": "",
        }

    superseded = project_app_id(project_dir, team_id) or ""
    created = post(
        f"{_SLACK_API_BASE}/apps.manifest.create",
        token,
        {"team_id": team_id, "manifest": json.dumps(strip_event_subscriptions(manifest))},
    )
    if not created.get("ok"):
        raise GitopsEmitterError(
            f"apps.manifest.create ({project_dir.name}): "
            f"{created.get('error', 'unknown')}"
            + _token_hint(str(created.get("error", "")))
            + " - if the surface changed, the fallback is the app settings "
            "page (create by hand, copy both secrets, pin apps.<n>.appId)"
        )
    app_id = str(created.get("app_id", ""))
    signing_secret = str((created.get("credentials") or {}).get("signing_secret", ""))
    if not app_id or not signing_secret:
        raise GitopsEmitterError(
            f"apps.manifest.create ({project_dir.name}) returned ok but is "
            f"missing app_id/signing_secret (keys: {', '.join(sorted(created.keys()))})"
        )
    bot_token = _install_bot_token(post, token, app_id, manifest, project_dir.name)
    _write_project_record(project_dir, team_id, manifest, app_id)
    return {
        "app_id": app_id,
        "signing_secret": signing_secret,
        "bot_token": bot_token,
        "superseded_app_id": superseded if superseded != app_id else "",
    }


def _default_probe(url: str) -> Optional[int]:
    """Status of an unsigned POST to *url*; None while unreachable.

    The User-Agent matters: Cloudflare's bot rules 403 the stdlib's
    ``Python-urllib/…`` default before the origin ever sees the request
    (found live 2026-08-29 — curl passed, urllib did not)."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={"User-Agent": "hg-slack-probe/1.0", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 - operator-declared https URL
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except Exception:
        return None


def _await_events_endpoint(
    url: str, timeout_s: int, probe, sleep=None
) -> None:
    """Block until *url* answers an unsigned POST with 401 — eve serving
    AND verifying signatures, the precondition for Slack's
    ``url_verification`` challenge to succeed.

    On a FRESH deployment the secret roll passes on an absent StatefulSet
    ("first install"), so ordering alone cannot guarantee a running pod
    (Codex catch): Argo CD starts the workload asynchronously. Waiting
    bounded here turns a guaranteed first-`up` failure into a normally
    short wait, and a timeout fails loudly with the re-run instruction.
    """
    import time as _time

    do_sleep = sleep or _time.sleep
    deadline = _time.monotonic() + timeout_s
    last: Optional[int] = None
    first = True
    while first or _time.monotonic() < deadline:
        first = False
        last = probe(url)
        if last == 401:
            return
        if _time.monotonic() >= deadline:
            break
        do_sleep(5)
    raise GitopsEmitterError(
        f"events endpoint {url} did not answer 401-unsigned within "
        f"{timeout_s}s (last: {'unreachable' if last is None else last}) - "
        "the agent pod is not serving/verifying yet (Argo CD may still be "
        "starting it). Re-run `pulumi up` once the workload is Running; "
        "the events attach converges then."
    )


def apply_manifest(
    credentials_file: Path,
    team_id: str,
    app_id: str,
    manifest_json: str,
    probe_timeout_s: int = 180,
    http_post=None,
    probe=None,
    sleep=None,
) -> Dict[str, str]:
    """Apply the FULL manifest (events included) to an existing app.

    The events-attach Command's entry point: ordered after the agent's
    secret roll, AND gated on the events endpoint actually answering
    401-unsigned, so Slack's ``url_verification`` challenge lands on a
    pod that is running and holding the new signing secret.
    """
    post = http_post or _default_http_post
    manifest = _parse_manifest(manifest_json)
    request_url = str(
        ((manifest.get("settings") or {}).get("event_subscriptions") or {}).get("request_url", "")
    )
    if request_url:
        _await_events_endpoint(request_url, probe_timeout_s, probe or _default_probe, sleep)
    token = _cli_user_token(credentials_file, team_id)
    resp = post(
        f"{_SLACK_API_BASE}/apps.manifest.update",
        token,
        {"app_id": app_id, "manifest": json.dumps(manifest)},
    )
    if not resp.get("ok"):
        raise GitopsEmitterError(
            f"apps.manifest.update ({app_id}): {resp.get('error', 'unknown')}"
            + _token_hint(str(resp.get("error", "")))
            + (
                " - Slack's url_verification challenge failed; confirm the "
                "agent pod rolled onto the new signing secret, then re-run "
                "`pulumi up` (the ordering guard should make this rare)"
                if "url" in str(resp.get("error", "")).lower()
                else ""
            )
        )
    return {"app_id": app_id, "events_applied": "true"}
