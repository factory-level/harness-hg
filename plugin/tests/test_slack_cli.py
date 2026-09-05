"""Tests for gitops_emitter.slack — the provisioning module the bootstrap's
SlackWorkspace component shells. HTTP is faked through the injected
``http_post`` seam and the ``slack`` binary with a stub script, so every
test is offline and asserts the exact contract: request shapes, the
materialized project files, stdout payloads, and the named-fix errors.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from gitops_emitter.errors import GitopsEmitterError
from gitops_emitter.slack import (
    apply_manifest,
    bot_identity,
    fetch_bot_token,
    hooks_file_content,
    manifest_bot_scopes,
    project_app_id,
    provision_app,
    strip_event_subscriptions,
    sync_bot_token,
)

REPO_ROOT = Path(__file__).resolve().parent.parent

TEAM = "T0000000000"
MANIFEST_DICT = {
    "display_information": {"name": "Test App"},
    "features": {"bot_user": {"display_name": "test-app", "always_online": True}},
    "oauth_config": {"scopes": {"bot": ["app_mentions:read", "chat:write"]}},
    "settings": {
        "socket_mode_enabled": False,
        "event_subscriptions": {
            "request_url": "https://slack-test.example.dev/eve/v1/slack",
            "bot_events": ["app_mention"],
        },
    },
}
MANIFEST = json.dumps(MANIFEST_DICT)


def _stub(tmp_path: Path, body: str) -> str:
    """Write an executable fake ``slack`` binary and return its path."""
    path = tmp_path / "slack-stub"
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def _api_stub(tmp_path: Path) -> str:
    """A stub whose ``api auth.test`` answers as the bot."""
    return _stub(
        tmp_path,
        f"""
case "$1" in
  api)
    printf '{{"ok":true,"team_id":"{TEAM}","user_id":"U0TESTBOT01","bot_id":"B0TESTBOT01","user":"test-app"}}\\n'
    ;;
  app)
    echo "deleted" >&2
    ;;
esac
exit 0
""",
    )


def _creds(tmp_path: Path) -> Path:
    path = tmp_path / "credentials.json"
    path.write_text(json.dumps({TEAM: {"token": "xoxe.xoxp-user-token", "team_id": TEAM}}))
    return path


def _provision_post(events=None, app_id="A0NEWAPP001"):
    """A well-behaved fake Slack API recording (method, payload) pairs."""
    events = events if events is not None else []

    def post(url, token, payload):
        method = url.rsplit("/", 1)[-1]
        events.append((method, payload))
        if method == "apps.manifest.create":
            return {
                "ok": True,
                "app_id": app_id,
                "credentials": {"signing_secret": "sign-sec-value"},
            }
        if method == "apps.manifest.update":
            return {"ok": True, "app_id": payload["app_id"]}
        if method == "apps.developerInstall":
            return {"ok": True, "api_access_tokens": {"bot": "xoxb-new-value"}}
        if method == "apps.manifest.delete":
            return {"ok": True}
        raise AssertionError(method)

    post.events = events
    return post


# ---------------------------------------------------------------------------
# pure helpers


def test_strip_event_subscriptions_removes_only_events() -> None:
    stripped = strip_event_subscriptions(MANIFEST_DICT)
    assert "event_subscriptions" not in stripped["settings"]
    assert stripped["settings"]["socket_mode_enabled"] is False
    # The input is untouched (it is also the Command's triggers entry).
    assert "event_subscriptions" in MANIFEST_DICT["settings"]


def test_manifest_bot_scopes_reads_and_refuses_empty() -> None:
    assert manifest_bot_scopes(MANIFEST_DICT) == ["app_mentions:read", "chat:write"]
    with pytest.raises(GitopsEmitterError, match="scopeless"):
        manifest_bot_scopes({"oauth_config": {"scopes": {"bot": []}}})
    with pytest.raises(GitopsEmitterError, match="scopeless"):
        manifest_bot_scopes({})


# ---------------------------------------------------------------------------
# provision_app — CREATE path


def test_provision_create_captures_both_secrets(tmp_path: Path) -> None:
    post = _provision_post()
    project = tmp_path / "proj"
    out = provision_app(_creds(tmp_path), TEAM, MANIFEST, project, http_post=post)
    assert out == {
        "app_id": "A0NEWAPP001",
        "signing_secret": "sign-sec-value",
        "bot_token": "xoxb-new-value",
        "superseded_app_id": "",
    }
    methods = [m for m, _ in post.events]
    assert methods == ["apps.manifest.create", "apps.developerInstall"]
    # The project record is written for `slack api` calls to keep working.
    assert project_app_id(project, TEAM) == "A0NEWAPP001"
    assert (project / ".slack" / "hooks.json").read_text() == hooks_file_content()
    # The FULL manifest (events included) lands on disk for later steps.
    on_disk = json.loads((project / "manifest.json").read_text())
    assert "event_subscriptions" in on_disk["settings"]


def test_provision_create_strips_events_from_the_create_call(tmp_path: Path) -> None:
    post = _provision_post()
    provision_app(_creds(tmp_path), TEAM, MANIFEST, tmp_path / "proj", http_post=post)
    _, create_payload = post.events[0]
    sent = json.loads(create_payload["manifest"])
    assert "event_subscriptions" not in sent["settings"]
    assert create_payload["team_id"] == TEAM


def test_provision_create_developer_install_uses_cracked_shape(tmp_path: Path) -> None:
    post = _provision_post()
    provision_app(_creds(tmp_path), TEAM, MANIFEST, tmp_path / "proj", http_post=post)
    _, install_payload = post.events[1]
    # The shape the Slack CLI itself sends (internal/api/app.go): app_id +
    # bot_scopes + outgoing_domains; NO team_id off-Grid, NO set_active.
    assert install_payload == {
        "app_id": "A0NEWAPP001",
        "bot_scopes": ["app_mentions:read", "chat:write"],
        "outgoing_domains": [],
    }


def test_provision_create_reports_superseded_and_never_deletes(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    # A pre-existing record from a previous generation of the app.
    (project / ".slack").mkdir(parents=True)
    (project / ".slack" / "apps.json").write_text(
        json.dumps({"apps": {TEAM: {"app_id": "A0OLDAPP001", "team_id": TEAM}}})
    )
    post = _provision_post()
    out = provision_app(_creds(tmp_path), TEAM, MANIFEST, project, http_post=post)
    assert out["superseded_app_id"] == "A0OLDAPP001"
    assert "apps.manifest.delete" not in [m for m, _ in post.events]
    assert project_app_id(project, TEAM) == "A0NEWAPP001"


def test_provision_create_refusal_names_fallback(tmp_path: Path) -> None:
    def post(url, token, payload):
        return {"ok": False, "error": "not_allowed_token_type"}

    with pytest.raises(GitopsEmitterError, match="app settings page"):
        provision_app(_creds(tmp_path), TEAM, MANIFEST, tmp_path / "proj", http_post=post)


def test_token_expired_names_the_cli_refresh(tmp_path: Path) -> None:
    # Found live 2026-08-29: the CLI self-refreshes its credential only
    # when the CLI runs; our raw-API reads must name the refresh command.
    def post(url, token, payload):
        return {"ok": False, "error": "token_expired"}

    with pytest.raises(GitopsEmitterError, match="slack auth list"):
        provision_app(_creds(tmp_path), TEAM, MANIFEST, tmp_path / "proj", http_post=post)


def test_provision_create_install_failure_is_loud(tmp_path: Path) -> None:
    def post(url, token, payload):
        method = url.rsplit("/", 1)[-1]
        if method == "apps.manifest.create":
            return {"ok": True, "app_id": "A0NEWAPP001", "credentials": {"signing_secret": "s"}}
        return {"ok": False, "error": "internal_error"}

    with pytest.raises(GitopsEmitterError, match="internal_error"):
        provision_app(_creds(tmp_path), TEAM, MANIFEST, tmp_path / "proj", http_post=post)


# ---------------------------------------------------------------------------
# provision_app — UPDATE path (PULUMI_COMMAND_STDOUT carry-forward)


def _previous_stdout() -> str:
    return json.dumps(
        {
            "app_id": "A0NEWAPP001",
            "signing_secret": "sign-sec-value",
            "bot_token": "xoxb-old-value",
            "superseded_app_id": "",
        }
    )


def test_provision_update_carries_signing_secret_forward(tmp_path: Path) -> None:
    post = _provision_post()
    out = provision_app(
        _creds(tmp_path), TEAM, MANIFEST, tmp_path / "proj",
        previous_stdout=_previous_stdout(), http_post=post,
    )
    methods = [m for m, _ in post.events]
    # No create on the update path — the FULL manifest updates in place.
    assert methods == ["apps.manifest.update", "apps.developerInstall"]
    _, update_payload = post.events[0]
    assert update_payload["app_id"] == "A0NEWAPP001"
    assert "event_subscriptions" in json.loads(update_payload["manifest"])["settings"]
    # Signing secret carried, bot token fresh from the re-install.
    assert out["signing_secret"] == "sign-sec-value"
    assert out["bot_token"] == "xoxb-new-value"


def test_provision_update_without_signing_secret_refuses(tmp_path: Path) -> None:
    previous = json.dumps({"app_id": "A0NEWAPP001"})
    with pytest.raises(GitopsEmitterError, match="[Rr]ecreate"):
        provision_app(
            _creds(tmp_path), TEAM, MANIFEST, tmp_path / "proj",
            previous_stdout=previous, http_post=_provision_post(),
        )


def test_provision_blank_or_junk_stdout_takes_create_path(tmp_path: Path) -> None:
    for previous in ("", "   ", "not json", "[]"):
        post = _provision_post()
        provision_app(
            _creds(tmp_path), TEAM, MANIFEST, tmp_path / f"proj-{len(previous)}",
            previous_stdout=previous, http_post=post,
        )
        assert [m for m, _ in post.events][0] == "apps.manifest.create"


def test_provision_rejects_bad_manifest(tmp_path: Path) -> None:
    with pytest.raises(GitopsEmitterError, match="not valid JSON"):
        provision_app(_creds(tmp_path), TEAM, "{nope", tmp_path / "p", http_post=_provision_post())
    with pytest.raises(GitopsEmitterError, match="display_information"):
        provision_app(
            _creds(tmp_path), TEAM, '{"features": {}}', tmp_path / "p",
            http_post=_provision_post(),
        )


# ---------------------------------------------------------------------------
# apply_manifest — the events-attach step


def test_apply_manifest_probes_then_sends_full_manifest(tmp_path: Path) -> None:
    post = _provision_post()
    probed: list[str] = []

    def probe(url):
        probed.append(url)
        return 401

    out = apply_manifest(
        _creds(tmp_path), TEAM, "A0NEWAPP001", MANIFEST, http_post=post, probe=probe,
    )
    assert out == {"app_id": "A0NEWAPP001", "events_applied": "true"}
    # The endpoint was probed BEFORE the update - a challenge never fires
    # at a pod that is not serving.
    assert probed == ["https://slack-test.example.dev/eve/v1/slack"]
    method, payload = post.events[0]
    assert method == "apps.manifest.update"
    assert "event_subscriptions" in json.loads(payload["manifest"])["settings"]


def test_apply_manifest_waits_out_an_unready_endpoint(tmp_path: Path) -> None:
    # Fresh deployment: the secret roll passes on an absent StatefulSet, so
    # readiness must be probed here. An endpoint that never answers 401
    # fails loudly with the re-run instruction, and no update is sent.
    def post(url, token, payload):
        raise AssertionError("manifest.update must not be reached")

    with pytest.raises(GitopsEmitterError, match="Re-run `pulumi up`"):
        apply_manifest(
            _creds(tmp_path), TEAM, "A0NEWAPP001", MANIFEST,
            probe_timeout_s=0, http_post=post, probe=lambda url: None, sleep=lambda s: None,
        )


def test_apply_manifest_skips_probe_without_events(tmp_path: Path) -> None:
    post = _provision_post()
    eventless = json.dumps(strip_event_subscriptions(MANIFEST_DICT))

    def probe(url):
        raise AssertionError("no events, no probe")

    out = apply_manifest(_creds(tmp_path), TEAM, "A0NEWAPP001", eventless, http_post=post, probe=probe)
    assert out["events_applied"] == "true"


def test_apply_manifest_url_verification_failure_names_the_fix(tmp_path: Path) -> None:
    def post(url, token, payload):
        return {"ok": False, "error": "invalid_request_url"}

    with pytest.raises(GitopsEmitterError, match="signing secret"):
        apply_manifest(
            _creds(tmp_path), TEAM, "A0NEWAPP001", MANIFEST,
            http_post=post, probe=lambda url: 401,
        )


# ---------------------------------------------------------------------------
# bot_identity (unchanged CLI-shelling path)


def test_bot_identity_parses_and_pins_the_team(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    provision_app(_creds(tmp_path), TEAM, MANIFEST, project, http_post=_provision_post())
    out = bot_identity(_api_stub(tmp_path), project, TEAM, "A0NEWAPP001")
    assert out == {"user_id": "U0TESTBOT01", "bot_id": "B0TESTBOT01", "team_id": TEAM}


def test_bot_identity_refuses_a_foreign_team(tmp_path: Path) -> None:
    cli = _stub(
        tmp_path,
        'printf \'{"ok":true,"team_id":"T0WRONGTEAM","user_id":"U1","bot_id":"B1"}\\n\'; exit 0\n',
    )
    with pytest.raises(GitopsEmitterError, match="foreign identity"):
        bot_identity(cli, tmp_path, TEAM, "A0TESTAPP01")


def test_bot_identity_surfaces_api_error(tmp_path: Path) -> None:
    cli = _stub(tmp_path, 'printf \'{"ok":false,"error":"app_not_installed"}\\n\'; exit 0\n')
    with pytest.raises(GitopsEmitterError, match="app_not_installed"):
        bot_identity(cli, tmp_path, TEAM, "A0TESTAPP01")


# ---------------------------------------------------------------------------
# fetch_bot_token / sync_bot_token — the ADOPTED-app escape hatch


SCOPES = ["app_mentions:read", "chat:write"]


def test_fetch_bot_token_happy_path(tmp_path: Path) -> None:
    calls = []

    def post(url, token, payload):
        calls.append((url, token, payload))
        return {"ok": True, "api_access_tokens": {"bot": "xoxb-fetched"}}

    token = fetch_bot_token(_creds(tmp_path), TEAM, "A0TESTAPP01", SCOPES, http_post=post)
    assert token == "xoxb-fetched"
    url, auth, payload = calls[0]
    assert url.endswith("/apps.developerInstall")
    assert auth == "xoxe.xoxp-user-token"
    assert payload == {
        "app_id": "A0TESTAPP01",
        "bot_scopes": SCOPES,
        "outgoing_domains": [],
    }


def test_fetch_bot_token_names_the_fallback_on_refusal(tmp_path: Path) -> None:
    def post(url, token, payload):
        return {"ok": False, "error": "not_allowed_token_type"}

    with pytest.raises(GitopsEmitterError, match="OAuth & Permissions"):
        fetch_bot_token(_creds(tmp_path), TEAM, "A0TESTAPP01", SCOPES, http_post=post)


def test_fetch_bot_token_missing_login_names_the_handshake(tmp_path: Path) -> None:
    with pytest.raises(GitopsEmitterError, match="slack login"):
        fetch_bot_token(tmp_path / "nope.json", TEAM, "A0TESTAPP01", SCOPES, http_post=lambda *a: {})
    creds = tmp_path / "other-team.json"
    creds.write_text(json.dumps({"T0OTHERTEAM": {"token": "x"}}))
    with pytest.raises(GitopsEmitterError, match="slack login"):
        fetch_bot_token(creds, TEAM, "A0TESTAPP01", SCOPES, http_post=lambda *a: {})


def test_fetch_bot_token_shape_change_fails_loudly(tmp_path: Path) -> None:
    def post(url, token, payload):
        return {"ok": True, "something_else": "x"}

    with pytest.raises(GitopsEmitterError, match="response shape changed"):
        fetch_bot_token(_creds(tmp_path), TEAM, "A0TESTAPP01", SCOPES, http_post=post)


def test_sync_bot_token_pipes_stdin_never_argv(tmp_path: Path) -> None:
    # A fake `pulumi` on PATH records its argv and stdin.
    record = tmp_path / "pulumi-call.json"
    fake = tmp_path / "bin" / "pulumi"
    fake.parent.mkdir()
    fake.write_text(
        "#!/bin/sh\n"
        f'printf \'{{"argv": "%s", "stdin": "%s"}}\' "$*" "$(cat)" > {record}\n'
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)

    def post(url, token, payload):
        return {"ok": True, "bot_access_token": "xoxb-secret-value"}

    old_path = os.environ["PATH"]
    os.environ["PATH"] = f"{fake.parent}:{old_path}"
    try:
        out = sync_bot_token(
            _creds(tmp_path), TEAM, "A0TESTAPP01", "my-agent",
            tmp_path, "factory", SCOPES, http_post=post,
        )
    finally:
        os.environ["PATH"] = old_path

    assert out == {
        "app_id": "A0TESTAPP01",
        "path": "agentSecrets.my-agent.SLACK_BOT_TOKEN",
        "synced": "true",
    }
    call = json.loads(record.read_text())
    # The token reaches pulumi over STDIN and appears nowhere in argv.
    assert "xoxb-secret-value" in call["stdin"]
    assert "xoxb-secret-value" not in call["argv"]
    assert "--secret" in call["argv"]
    assert "agentSecrets.my-agent.SLACK_BOT_TOKEN" in call["argv"]


# ---------------------------------------------------------------------------
# the module CLI (subprocess seam the component actually uses)


def _run_cli(sub: str, env: dict, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "gitops_emitter.slack_cli", sub],
        env={**os.environ, **env},
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )


def test_cli_provision_app_requires_manifest(tmp_path: Path) -> None:
    result = _run_cli(
        "provision-app",
        {"SLACK_TEAM_ID": TEAM, "SLACK_PROJECT_DIR": str(tmp_path / "proj")},
        tmp_path,
    )
    assert result.returncode == 2
    assert "SLACK_MANIFEST_JSON is required" in result.stderr
    assert result.stdout == ""


def test_cli_requires_team_and_project(tmp_path: Path) -> None:
    result = _run_cli("provision-app", {"SLACK_TEAM_ID": "", "SLACK_PROJECT_DIR": ""}, tmp_path)
    assert result.returncode == 2
    assert "SLACK_TEAM_ID is required" in result.stderr
    assert result.stdout == ""


def test_cli_rejects_retired_subcommands(tmp_path: Path) -> None:
    for retired in ("ensure-app", "bootstrap-app"):
        result = _run_cli(
            retired,
            {"SLACK_TEAM_ID": TEAM, "SLACK_PROJECT_DIR": str(tmp_path)},
            tmp_path,
        )
        assert result.returncode == 2
        assert "usage:" in result.stderr


def test_cli_sync_bot_token_without_manifest_names_the_fix(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    (project / ".slack").mkdir(parents=True)
    (project / ".slack" / "apps.json").write_text(
        json.dumps({"apps": {TEAM: {"app_id": "A0TESTAPP01", "team_id": TEAM}}})
    )
    result = _run_cli(
        "sync-bot-token",
        {
            "SLACK_TEAM_ID": TEAM,
            "SLACK_PROJECT_DIR": str(project),
            "AGENT_NAME": "my-agent",
            "PULUMI_DIR": str(tmp_path),
            "PULUMI_STACK": "factory",
        },
        tmp_path,
    )
    assert result.returncode == 2
    assert "SLACK_MANIFEST_JSON" in result.stderr


def test_cli_bot_identity_falls_back_to_project_record(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    provision_app(_creds(tmp_path), TEAM, MANIFEST, project, http_post=_provision_post())
    result = _run_cli(
        "bot-identity",
        {
            "SLACK_CLI_BIN": _api_stub(tmp_path),
            "SLACK_TEAM_ID": TEAM,
            "SLACK_PROJECT_DIR": str(project),
        },
        tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["user_id"] == "U0TESTBOT01"
