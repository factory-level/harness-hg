"""Standalone Nexus service (ADR-48): the same plugin router the Hermes
dashboard mounts, served by its own uvicorn in-cluster - plus the static
UI. The router is unchanged; only the mounting differs:

- routes appear under ``/api/plugins/hermes-gitops/`` exactly as the host
  dashboard mounts them, so the bundle's fetch paths work verbatim;
- ``/`` serves a minimal shell that loads ``dist/standalone.js`` (the
  self-hosted SDK: bundles React, provides fetchJSON, mounts the plugin);
- session auth is the deployment's concern (Cloudflare Access today, the
  common OIDC issuer when ADR-50 lands) - the container itself is as
  unauthenticated as any other in-cluster control-plane UI reached only
  through the edge or a port-forward.

Run: ``uvicorn standalone:app --host 0.0.0.0 --port 8080`` with HOME
pointed at the state volume (plugin_api resolves every state path from
``Path.home()``, so the PVC mount IS the persistence change).
"""

import hashlib
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from plugin_api import content_security_policy, grafana_base_url, router

# No .resolve(): a ConfigMap mount serves files through a timestamped
# symlink dir, and resolving __file__ would follow it PAST the mount
# point, where the sibling dist mount does not exist.
HERE = Path(__file__).parent
DIST = HERE / "dist"

app = FastAPI(title="hermes-gitops Nexus", docs_url=None, redoc_url=None)
app.include_router(router, prefix="/api/plugins/hermes-gitops")
app.mount("/dist", StaticFiles(directory=str(DIST)), name="dist")

def _dist_version() -> str:
    """A build stamp for the asset URLs: sha256 of the three served files,
    12 hex chars, computed once at import.

    Why the URLs must carry it: `/` is DYNAMIC at the edge but `.js`/`.css`
    are cached by default, so a redeployed pod kept serving the previous
    UI through Cloudflare for the whole TTL - `cf-cache-status: HIT`,
    `age: 5671`, the old bundle byte-for-byte, while the origin had the new
    one (found live). A rebuilt bundle now IS a different URL, so the edge
    misses on it and no purge is needed. A missing file contributes
    nothing rather than raising: an incomplete mount must not turn the
    whole shell into a 500."""
    h = hashlib.sha256()
    for name in ("index.js", "standalone.js", "style.css"):
        p = DIST / name
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()[:12]


DIST_VERSION = _dist_version()

_INDEX = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Nexus</title>
  <link rel="stylesheet" href="/dist/style.css?v={DIST_VERSION}"/>
</head>
<body>
  <div id="nexus-root" data-dist-version="{DIST_VERSION}"></div>
  <script type="module" src="/dist/standalone.js?v={DIST_VERSION}"></script>
</body>
</html>
"""


@app.middleware("http")
async def _security_headers(request, call_next):
    """One place, every response (design 14, #281).

    Set here rather than on the HTML route because a policy that covers
    only the document is a policy with holes: an error page, a redirect
    or a JSON body served without it is still a page a browser will
    render under the wrong rules."""
    response = await call_next(request)
    response.headers.setdefault("content-security-policy", content_security_policy(grafana_base_url()))
    response.headers.setdefault("x-content-type-options", "nosniff")
    response.headers.setdefault("referrer-policy", "no-referrer")
    return response


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    # The shell must ALWAYS revalidate: it carries the dist version, and
    # without a Cache-Control the browser heuristically reuses it - a
    # redeployed pod then serves the new bundle to nobody (the #333
    # failure, one layer up). The versioned asset URLs stay long-cached;
    # this tiny document is the one thing that must never be stale.
    return HTMLResponse(content=_INDEX, headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    return FileResponse(str(DIST / "style.css"), media_type="image/x-icon")


@app.get("/metrics")
def metrics() -> Response:
    """Published eval results as Prometheus text. Outside the plugin
    prefix on purpose: the monitoring stack's existing kubernetes-pods
    annotation job scrapes `/metrics`, so this needs no ServiceMonitor and
    no monitoring-chart change - just the pod annotations."""
    from plugin_api import eval_metrics_text

    return Response(content=eval_metrics_text(), media_type="text/plain; version=0.0.4")
