"""observer-metrics: hermes.observer.v1 -> Prometheus text exposition.

Ships with the hermes-profile chart (delivered via ConfigMap + boot.sh
into the profile's plugins/ dir) and runs inside the agent process. It
subscribes to the fork's read-only observer contract and serves
/metrics on HERMES_OBSERVER_METRICS_PORT (default 9464), scraped by the
platform Prometheus through the pod's prometheus.io/* annotations.

Two kinds of series, deliberately:

  - process-lifetime counters (hermes_usage_tokens_total,
    hermes_estimated_cost_usd_total) accumulated from post_api_request
    events - good for rates ("who is burning right now");
  - month-to-date gauges (hermes_cost_usd_mtd, hermes_tokens_mtd)
    computed from the fork's persisted state.db at scrape time - the
    AUTHORITY for budget math: they survive pod restarts, cover every
    hermes process on this PVC (gateway, cron/kanban subprocesses), and
    need no Prometheus retention (the platform default keeps 2d).

Costs are the fork's canonical usage-pricing ESTIMATES, not provider
billing.

Fail-open everywhere: no exception may ever escape into the agent. The
fork's invoke_hook already isolates callbacks, but this module also
guards every path itself (hooks, sqlite reads, the server thread). If
another hermes process on this pod already owns the port (cron/kanban
chat subprocesses load plugins too), the bind failure is logged and the
hooks stay registered - the gateway's server is the authoritative one,
and state.db covers the subprocess usage.

Kill switches, strongest first: metrics.enabled=false (chart value ->
HERMES_OBSERVER_METRICS=0), HERMES_OBSERVER_METRICS_DISABLED=1 (per
profile, via the profile's env Secret), HERMES_SAFE_MODE=1 (fork-level,
disables all plugins).
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logger = logging.getLogger(__name__)

# Observer usage keys -> the metric's `type` label.
_TYPE_MAP = {
    "input_tokens": "input",
    "output_tokens": "output",
    "cache_read_tokens": "cache_read",
    "cache_write_tokens": "cache_creation",
    "reasoning_tokens": "reasoning",
}
_MTD_TYPES = ("input", "output", "cache_read", "cache_creation", "reasoning")
_MTD_TTL_SECONDS = 15.0

# Whole-session usage is attributed to the month the session STARTED in;
# a session spanning the boundary misattributes its tail (the
# alternative, last_seen, would misattribute the head instead).
_MTD_SQL = """
SELECT COALESCE(SUM(u.input_tokens), 0),
       COALESCE(SUM(u.output_tokens), 0),
       COALESCE(SUM(u.cache_read_tokens), 0),
       COALESCE(SUM(u.cache_write_tokens), 0),
       COALESCE(SUM(u.reasoning_tokens), 0),
       COALESCE(SUM(u.estimated_cost_usd), 0)
FROM session_model_usage u
JOIN sessions s ON s.id = u.session_id
WHERE s.started_at >= ?
"""


class _State:
    def __init__(self, profile: str):
        self.profile = profile
        self.lock = threading.Lock()
        self.tokens: dict[tuple[str, str, str], int] = {}
        self.cost: dict[tuple[str, str], float] = {}
        self.last_event_ts = 0.0
        self.scrape_errors = 0
        # (fetched_at, values) - kept on read failure so a locked/missing
        # state.db serves stale-but-sane numbers instead of a gap.
        self.mtd_cache: tuple[float, dict] | None = None


_STATE: _State | None = None


def _enabled() -> bool:
    if os.getenv("HERMES_OBSERVER_METRICS", "1").strip().lower() in {"0", "false", "no", "off"}:
        return False
    if os.getenv("HERMES_OBSERVER_METRICS_DISABLED", "").strip().lower() in {"1", "true", "yes", "on"}:
        return False
    return True


def _estimate_cost(model, provider, base_url, usage: dict):
    """Price one event via the fork's canonical pricing. Lazily imported
    and fully guarded: unit tests monkeypatch this, and a broken fork
    import must never break the hook."""
    try:
        from agent.usage_pricing import CanonicalUsage, estimate_usage_cost

        cu = CanonicalUsage(
            input_tokens=int(usage.get("input_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            cache_read_tokens=int(usage.get("cache_read_tokens") or 0),
            cache_write_tokens=int(usage.get("cache_write_tokens") or 0),
            reasoning_tokens=int(usage.get("reasoning_tokens") or 0),
        )
        result = estimate_usage_cost(model, cu, provider=provider, base_url=base_url)
        return float(result.amount_usd) if result.amount_usd is not None else None
    except Exception:
        return None


def _on_post_api_request(**kwargs):
    st = _STATE
    if st is None:
        return
    try:
        usage = kwargs.get("usage") or {}
        model = str(kwargs.get("model") or "unknown")
        provider = str(kwargs.get("provider") or "unknown")
        with st.lock:
            for key, label in _TYPE_MAP.items():
                n = int(usage.get(key) or 0)
                if n:
                    k = (model, provider, label)
                    st.tokens[k] = st.tokens.get(k, 0) + n
            st.last_event_ts = time.time()
        cost = _estimate_cost(model, provider, kwargs.get("base_url"), usage)
        if cost:
            with st.lock:
                st.cost[(model, provider)] = st.cost.get((model, provider), 0.0) + cost
    except Exception:
        logger.debug("observer-metrics: post_api_request hook failed", exc_info=True)


def _on_api_request_error(**kwargs):
    # Errors carry no usage; they still prove the observer is alive.
    st = _STATE
    if st is None:
        return
    try:
        with st.lock:
            st.last_event_ts = time.time()
    except Exception:
        pass


def _month_start_epoch(now=None) -> float:
    now = now or datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc).timestamp()


def _read_mtd(db_path: str) -> dict:
    # Read-only URI + short busy timeout: WAL readers coexist with the
    # agent's writer (hermes_state.py sets WAL, DELETE fallback).
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
    try:
        row = conn.execute(_MTD_SQL, (_month_start_epoch(),)).fetchone()
    finally:
        conn.close()
    return {
        "input": row[0],
        "output": row[1],
        "cache_read": row[2],
        "cache_creation": row[3],
        "reasoning": row[4],
        "cost_usd": row[5],
    }


def _state_db_path() -> str:
    from hermes_constants import get_hermes_home

    return str(get_hermes_home() / "state.db")


def _get_mtd(st: _State):
    now = time.time()
    if st.mtd_cache and now - st.mtd_cache[0] < _MTD_TTL_SECONDS:
        return st.mtd_cache[1]
    try:
        data = _read_mtd(_state_db_path())
        st.mtd_cache = (now, data)
        return data
    except Exception:
        with st.lock:
            st.scrape_errors += 1
        return st.mtd_cache[1] if st.mtd_cache else None


def _esc(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _render(st: _State) -> str:
    p = _esc(st.profile)
    with st.lock:
        tokens = dict(st.tokens)
        cost = dict(st.cost)
        last_ts = st.last_event_ts
    lines = [
        "# HELP hermes_usage_tokens_total Tokens consumed by bucket (this process's lifetime).",
        "# TYPE hermes_usage_tokens_total counter",
    ]
    for (m, pr, t), v in sorted(tokens.items()):
        lines.append(
            f'hermes_usage_tokens_total{{profile="{p}",model="{_esc(m)}",provider="{_esc(pr)}",type="{t}"}} {v}'
        )
    lines += [
        "# HELP hermes_estimated_cost_usd_total Estimated spend in USD (this process's lifetime).",
        "# TYPE hermes_estimated_cost_usd_total counter",
    ]
    for (m, pr), v in sorted(cost.items()):
        lines.append(
            f'hermes_estimated_cost_usd_total{{profile="{p}",model="{_esc(m)}",provider="{_esc(pr)}"}} {v:.6f}'
        )
    mtd = _get_mtd(st)
    if mtd is not None:
        lines += [
            "# HELP hermes_cost_usd_mtd Month-to-date estimated spend in USD, from persisted state.db (all processes; authority for budgets).",
            "# TYPE hermes_cost_usd_mtd gauge",
            f'hermes_cost_usd_mtd{{profile="{p}"}} {mtd["cost_usd"]:.6f}',
            "# HELP hermes_tokens_mtd Month-to-date tokens by bucket, from persisted state.db.",
            "# TYPE hermes_tokens_mtd gauge",
        ]
        for t in _MTD_TYPES:
            lines.append(f'hermes_tokens_mtd{{profile="{p}",type="{t}"}} {mtd[t]}')
    # scrape_errors is read after _get_mtd so a failing read is visible
    # on the same scrape that suffered it.
    with st.lock:
        errs = st.scrape_errors
    lines += [
        "# HELP hermes_observer_last_event_timestamp_seconds Unix time of the last observer event seen by this process.",
        "# TYPE hermes_observer_last_event_timestamp_seconds gauge",
        f'hermes_observer_last_event_timestamp_seconds{{profile="{p}"}} {last_ts}',
        "# HELP hermes_metrics_scrape_errors_total state.db read failures.",
        "# TYPE hermes_metrics_scrape_errors_total counter",
        f'hermes_metrics_scrape_errors_total{{profile="{p}"}} {errs}',
    ]
    return "\n".join(lines) + "\n"


def _start_server(st: _State, port: int) -> bool:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?")[0] != "/metrics":
                self.send_response(404)
                self.end_headers()
                return
            try:
                body = _render(st).encode()
            except Exception:
                logger.debug("observer-metrics: render failed", exc_info=True)
                self.send_response(500)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        server.daemon_threads = True
    except OSError:
        logger.debug(
            "observer-metrics: port %d already bound (another hermes process "
            "owns the exporter) - hooks stay registered, no server here",
            port,
        )
        return False
    threading.Thread(target=server.serve_forever, name="observer-metrics", daemon=True).start()
    logger.info("observer-metrics: serving /metrics on :%d", port)
    return True


def register(ctx):
    global _STATE
    try:
        if not _enabled():
            logger.info("observer-metrics: disabled via environment")
            return
        _STATE = _State(profile=str(ctx.profile_name or "unknown"))
        ctx.register_hook("post_api_request", _on_post_api_request)
        ctx.register_hook("api_request_error", _on_api_request_error)
        port = int(os.getenv("HERMES_OBSERVER_METRICS_PORT", "9464"))
        _start_server(_STATE, port)
    except Exception:
        logger.warning("observer-metrics: register failed (metrics disabled)", exc_info=True)
