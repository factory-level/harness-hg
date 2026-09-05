"""Unit tests for the chart-shipped observer-metrics plugin
(harness/hermes/charts/hermes-profile/files/plugins/observer-metrics/) - the
in-pod hermes.observer.v1 -> Prometheus exporter behind the fleet
budget dashboard (charts/fleet-dashboard).

The plugin is NOT an installed package (it is chart payload, copied to
the profile's plugins/ dir by boot.sh), so it is loaded here by file
path. Its fork imports (agent.usage_pricing, hermes_constants) are
deliberately function-local and guarded - these tests run without the
fork on sys.path, which is itself part of the fail-open contract under
test: hooks and rendering must work (minus pricing/MTD) when the fork
internals are absent or broken.

The state.db fixture uses the sessions/session_model_usage DDL copied
from the fork's hermes_state.py SCHEMA_SQL (trimmed to the columns the
plugin's MTD query touches, plus enough to satisfy NOT NULLs).
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
PLUGIN_DIR = REPO_ROOT / "harness/hermes/charts/hermes-profile/files/plugins/observer-metrics"


def _load_plugin():
    spec = importlib.util.spec_from_file_location(
        "observer_metrics_under_test", PLUGIN_DIR / "__init__.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def plugin():
    return _load_plugin()


@pytest.fixture()
def state(plugin):
    st = plugin._State(profile="social-media")
    plugin._STATE = st
    yield st
    plugin._STATE = None


# -- fixture state.db --------------------------------------------------------

_FIXTURE_DDL = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    started_at REAL NOT NULL,
    profile_name TEXT
);
CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, model, billing_provider)
);
"""


def _make_state_db(path: Path, rows):
    """rows: (session_id, started_at_epoch, input, output, cost_usd)."""
    conn = sqlite3.connect(path)
    conn.executescript(_FIXTURE_DDL)
    for sid, started_at, inp, out, cost in rows:
        conn.execute(
            "INSERT INTO sessions (id, source, started_at) VALUES (?, 'cli', ?)",
            (sid, started_at),
        )
        conn.execute(
            "INSERT INTO session_model_usage "
            "(session_id, model, input_tokens, output_tokens, estimated_cost_usd) "
            "VALUES (?, 'claude-fable-5', ?, ?, ?)",
            (sid, inp, out, cost),
        )
    conn.commit()
    conn.close()


# -- hooks -------------------------------------------------------------------


def test_post_api_request_accumulates_all_buckets(plugin, state, monkeypatch):
    monkeypatch.setattr(plugin, "_estimate_cost", lambda *a, **k: 0.5)
    usage = {
        "input_tokens": 100,
        "output_tokens": 20,
        "cache_read_tokens": 300,
        "cache_write_tokens": 40,
        "reasoning_tokens": 5,
        "request_count": 1,  # present in real payloads, must be ignored
    }
    plugin._on_post_api_request(
        usage=usage,
        model="claude-fable-5",
        provider="anthropic",
        base_url=None,
        telemetry_schema_version="hermes.observer.v1",  # extra kwargs tolerated
        session_id="s1",
    )
    plugin._on_post_api_request(usage=usage, model="claude-fable-5", provider="anthropic")
    key = lambda t: ("claude-fable-5", "anthropic", t)
    assert state.tokens[key("input")] == 200
    assert state.tokens[key("output")] == 40
    assert state.tokens[key("cache_read")] == 600
    assert state.tokens[key("cache_creation")] == 80
    assert state.tokens[key("reasoning")] == 10
    assert state.cost[("claude-fable-5", "anthropic")] == pytest.approx(1.0)
    assert state.last_event_ts > 0


def test_hooks_are_fail_open(plugin, state, monkeypatch):
    # A hostile payload must not raise out of the hook.
    plugin._on_post_api_request(usage="not-a-dict", model=None, provider=None)
    plugin._on_api_request_error(status_code=500)
    # And with no state at all (register never ran) hooks are no-ops.
    plugin._STATE = None
    plugin._on_post_api_request(usage={"input_tokens": 1})


def test_estimate_cost_without_fork_returns_none(plugin):
    # The fork isn't importable in this test env - pricing must degrade
    # to None, never raise.
    assert plugin._estimate_cost("m", "p", None, {"input_tokens": 1}) is None


# -- MTD from state.db -------------------------------------------------------


def test_mtd_filters_on_session_start_month(plugin, state, tmp_path, monkeypatch):
    db = tmp_path / "state.db"
    now = datetime.now(timezone.utc).timestamp()
    month_start = plugin._month_start_epoch()
    _make_state_db(
        db,
        [
            ("this-month-1", month_start + 60, 100, 10, 1.25),
            ("this-month-2", now, 50, 5, 0.25),
            ("last-month", month_start - 60, 9999, 999, 99.0),
        ],
    )
    monkeypatch.setattr(plugin, "_state_db_path", lambda: str(db))
    mtd = plugin._get_mtd(state)
    assert mtd["input"] == 150
    assert mtd["output"] == 15
    assert mtd["cost_usd"] == pytest.approx(1.5)
    assert state.scrape_errors == 0


def test_mtd_cache_ttl_and_fail_open_stale(plugin, state, tmp_path, monkeypatch):
    db = tmp_path / "state.db"
    _make_state_db(db, [("s1", datetime.now(timezone.utc).timestamp(), 10, 1, 0.1)])
    monkeypatch.setattr(plugin, "_state_db_path", lambda: str(db))
    first = plugin._get_mtd(state)
    assert first["input"] == 10
    # Within TTL: cached value served, db not re-read.
    db.unlink()
    assert plugin._get_mtd(state) is first
    # Past TTL with the db gone: stale cache served, error counted.
    state.mtd_cache = (0.0, first)
    assert plugin._get_mtd(state) == first
    assert state.scrape_errors == 1


def test_mtd_missing_db_no_cache_returns_none(plugin, state, tmp_path, monkeypatch):
    monkeypatch.setattr(plugin, "_state_db_path", lambda: str(tmp_path / "absent.db"))
    assert plugin._get_mtd(state) is None
    assert state.scrape_errors == 1


# -- text exposition ---------------------------------------------------------


def test_render_text_format(plugin, state, tmp_path, monkeypatch):
    db = tmp_path / "state.db"
    _make_state_db(db, [("s1", datetime.now(timezone.utc).timestamp(), 100, 20, 2.5)])
    monkeypatch.setattr(plugin, "_state_db_path", lambda: str(db))
    monkeypatch.setattr(plugin, "_estimate_cost", lambda *a, **k: 0.75)
    plugin._on_post_api_request(
        usage={"input_tokens": 7, "output_tokens": 3},
        model="claude-fable-5",
        provider="anthropic",
    )
    out = plugin._render(state)
    assert (
        'hermes_usage_tokens_total{profile="social-media",model="claude-fable-5",provider="anthropic",type="input"} 7'
        in out
    )
    assert (
        'hermes_estimated_cost_usd_total{profile="social-media",model="claude-fable-5",provider="anthropic"} 0.750000'
        in out
    )
    assert 'hermes_cost_usd_mtd{profile="social-media"} 2.500000' in out
    assert 'hermes_tokens_mtd{profile="social-media",type="input"} 100' in out
    assert 'hermes_metrics_scrape_errors_total{profile="social-media"} 0' in out
    assert "# TYPE hermes_cost_usd_mtd gauge" in out
    assert out.endswith("\n")


def test_render_without_state_db_omits_mtd_only(plugin, state, tmp_path, monkeypatch):
    monkeypatch.setattr(plugin, "_state_db_path", lambda: str(tmp_path / "absent.db"))
    out = plugin._render(state)
    assert "hermes_cost_usd_mtd" not in out
    assert 'hermes_observer_last_event_timestamp_seconds{profile="social-media"} 0' in out
    assert 'hermes_metrics_scrape_errors_total{profile="social-media"} 1' in out


def test_render_escapes_label_values(plugin, monkeypatch, tmp_path):
    st = plugin._State(profile='we"ird\\prof')
    monkeypatch.setattr(plugin, "_state_db_path", lambda: str(tmp_path / "absent.db"))
    out = plugin._render(st)
    assert 'profile="we\\"ird\\\\prof"' in out


# -- env gating + manifest ---------------------------------------------------


def test_enabled_env_gates(plugin, monkeypatch):
    assert plugin._enabled()
    monkeypatch.setenv("HERMES_OBSERVER_METRICS", "0")
    assert not plugin._enabled()
    monkeypatch.setenv("HERMES_OBSERVER_METRICS", "1")
    monkeypatch.setenv("HERMES_OBSERVER_METRICS_DISABLED", "true")
    assert not plugin._enabled()


def test_register_is_fail_open_when_disabled(plugin, monkeypatch):
    monkeypatch.setenv("HERMES_OBSERVER_METRICS", "0")

    class Ctx:
        profile_name = "p"

        def register_hook(self, *a):  # must never be called when disabled
            raise AssertionError("hook registered while disabled")

    plugin.register(Ctx())
    assert plugin._STATE is None


def test_plugin_manifest_shape():
    import yaml

    manifest = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text())
    assert manifest["name"] == "observer-metrics"
    assert manifest["kind"] == "standalone"
    assert set(manifest["provides_hooks"]) == {"post_api_request", "api_request_error"}
