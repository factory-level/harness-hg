"""Unit tests for gitops_emitter/forge.py — the GitHub pulls client
(issue #17 [F1]). All HTTP is mocked at the `_http_request` seam."""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from gitops_emitter import forge  # noqa: E402
from gitops_emitter.harness.hermes import GitopsEmitterError  # noqa: E402

REPO = "https://github.com/example-org/gitops.git"


class _Responder:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, payload):
        self.calls.append((method, url, payload))
        return self.responses.pop(0)


def test_require_github_repo_parses_and_rejects():
    assert forge.require_github_repo(REPO, "PR mode") == ("example-org", "gitops")
    with pytest.raises(GitopsEmitterError, match="requires a github.com repo_url"):
        forge.require_github_repo("file:///tmp/gitops.git", "PR mode")


def test_open_pull_request_success(monkeypatch):
    responder = _Responder(
        [(201, json.dumps({"number": 7, "html_url": "https://github.com/x/pull/7"}))]
    )
    monkeypatch.setattr(forge, "_http_request", responder)
    pr = forge.open_pull_request(
        REPO, "tok", head="hermes-gitops/support-agent", base="main", title="t", body="b"
    )
    assert pr == {"number": 7, "html_url": "https://github.com/x/pull/7", "existing": False}
    method, url, payload = responder.calls[0]
    assert method == "POST"
    assert url.endswith("/repos/example-org/gitops/pulls")
    sent = json.loads(payload)
    assert sent["head"] == "hermes-gitops/support-agent"
    assert sent["base"] == "main"


def test_open_pull_request_already_exists_resolves_existing(monkeypatch):
    responder = _Responder(
        [
            (422, json.dumps({"errors": [{"message": "A pull request already exists"}]})),
            (200, json.dumps([{"number": 3, "html_url": "https://github.com/x/pull/3"}])),
        ]
    )
    monkeypatch.setattr(forge, "_http_request", responder)
    pr = forge.open_pull_request(
        REPO, "tok", head="hermes-gitops/support-agent", base="main", title="t", body="b"
    )
    assert pr["existing"] is True
    assert pr["number"] == 3
    assert responder.calls[1][0] == "GET"
    assert "head=example-org:hermes-gitops/support-agent" in responder.calls[1][1]


def test_open_pull_request_requires_token():
    with pytest.raises(GitopsEmitterError, match="requires GITOPS_GIT_TOKEN"):
        forge.open_pull_request(REPO, None, head="h", base="b", title="t", body="")


def test_open_pull_request_error_is_scrubbed(monkeypatch):
    responder = _Responder([(403, "forbidden for token sekret-token-value")])
    monkeypatch.setattr(forge, "_http_request", responder)
    with pytest.raises(GitopsEmitterError) as exc:
        forge.open_pull_request(
            REPO, "sekret-token-value", head="h", base="main", title="t", body=""
        )
    assert "sekret-token-value" not in str(exc.value)
    assert "HTTP 403" in str(exc.value)


def test_pulls_error_codes_map_to_distinct_actionable_messages(monkeypatch):
    """Issue #22 [F4]: 403/404/422 each get an operator-readable message."""
    cases = {
        403: "Pull requests: write",
        404: "cannot see this repository",
        422: "no commits between head and base",
    }
    for code, needle in cases.items():
        responder = _Responder([(code, "boom with sekret-tok")])
        monkeypatch.setattr(forge, "_http_request", responder)
        with pytest.raises(GitopsEmitterError) as exc:
            forge.open_pull_request(
                REPO, "sekret-tok", head="hermes-gitops/x", base="main", title="t", body=""
            )
        message = str(exc.value)
        assert needle in message, (code, message)
        assert "sekret-tok" not in message


def test_merge_error_is_scrubbed_and_mapped(monkeypatch):
    responder = _Responder([(403, "denied for sekret-tok")])
    monkeypatch.setattr(forge, "_http_request", responder)
    with pytest.raises(GitopsEmitterError) as exc:
        forge.merge_pull_request(REPO, "sekret-tok", 7)
    message = str(exc.value)
    assert "Pull requests: write" in message
    assert "remains open for manual review" in message
    assert "sekret-tok" not in message


def test_merge_pull_request_success(monkeypatch):
    responder = _Responder([(200, json.dumps({"sha": "a" * 40, "merged": True}))])
    monkeypatch.setattr(forge, "_http_request", responder)
    sha = forge.merge_pull_request(REPO, "tok", 7)
    assert sha == "a" * 40
    method, url, payload = responder.calls[0]
    assert method == "PUT"
    assert url.endswith("/pulls/7/merge")
    assert json.loads(payload)["merge_method"] == "squash"


def test_merge_pull_request_failure_says_pr_remains_open(monkeypatch):
    responder = _Responder([(405, json.dumps({"message": "Base branch was modified"}))])
    monkeypatch.setattr(forge, "_http_request", responder)
    with pytest.raises(GitopsEmitterError, match="remains\\s+open for manual review"):
        forge.merge_pull_request(REPO, "tok", 7)


def test_find_open_pull_request(monkeypatch):
    responder = _Responder(
        [
            (200, json.dumps([{"number": 4, "html_url": "https://github.com/x/pull/4"}])),
            (200, json.dumps([])),
        ]
    )
    monkeypatch.setattr(forge, "_http_request", responder)
    found = forge.find_open_pull_request(REPO, "tok", head="hermes-gitops/a", base="main")
    assert found == {"number": 4, "html_url": "https://github.com/x/pull/4", "existing": True}
    assert forge.find_open_pull_request(REPO, "tok", head="hermes-gitops/a", base="main") is None
    method, url, _ = responder.calls[0]
    assert method == "GET"
    assert "state=open" in url and "head=example-org:hermes-gitops/a" in url
