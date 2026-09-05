"""Where an agent's contract lives (ADR 0178) - the emitter's half of the
one layout helper (``cli/src/layout.ts`` is the CLI's; the two fold the
same files into the same shape, and ``plugin/tests/test_layout.py`` pins the
record they render byte-for-byte against the legacy authoring).

Two layouts:

  legacy      ``<payload>/hermes-gitops.yaml`` beside distribution.yaml or
              package.json - read by ``load_extension_file`` /
              ``load_eve_extension`` exactly as before.
  agent-team  ``agents/<harness>/<name>/harness-hg/*.yaml`` beside the
              payload ``agents/<harness>/<name>/src/``; the team's
              ``<root>/harness-hg/apps.yaml`` carries the apps this agent
              owns. Folded here into the legacy raw shape (contract v5, or
              v3 when the Hermes-only ``expose`` block is present - the last
              version that carried it) and handed to the SAME version
              dispatch the legacy file goes through.

How the contract directory is found, in order: an explicit path (the
``--contract-dir`` flag, or ``HERMES_GITOPS_CONTRACT_DIR`` - what the Pulumi
``hermes-agent`` component exports, because ``hermes profile install
--subdir`` stages ``src/`` alone and the payload cannot see ``../harness-hg``
from inside the install); else ``../harness-hg/`` beside a payload named
``src``; else legacy.

The refusal that matters: an agent whose SOURCE SUBDIR ends in ``/src`` (the
agent-team layout by construction - what ``hermes profile install --subdir``
and ``emit_cli --subdir`` are told) with no contract found is an error, never
"no infra intent". In the Hermes hook path the installed payload is named
after the profile, so the directory name proves nothing; the subdir does.
Silently emitting a record with zero apps for a migrated Hermes profile is an
Argo prune of the team's board and publisher. A legacy directory that merely
happens to be called ``src`` stays legacy, exactly as in the CLI.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from .render import load_vendored_schema

try:  # same soft dependency as render.py
    import jsonschema
except ImportError:  # pragma: no cover
    jsonschema = None  # type: ignore[assignment]

CONTRACT_DIRNAME = "harness-hg"
SRC_DIRNAME = "src"
ENV_CONTRACT_DIR = "HERMES_GITOPS_CONTRACT_DIR"
HARNESSES = ("eve", "hermes")
TEAM_API_VERSION = "hermes-gitops.factorylevel.dev/agent-team/v1alpha1"


class LayoutError(Exception):
    """Raised for any way the split authoring disagrees with itself. The
    Hermes hook and emit_cli re-raise it as GitopsEmitterError (this module
    imports nothing from harness/ to stay import-cycle free)."""


_SCHEMA_CACHE: Dict[str, Dict[str, Any]] = {}


def _schema(stem: str) -> Dict[str, Any]:
    if stem not in _SCHEMA_CACHE:
        _SCHEMA_CACHE[stem] = load_vendored_schema(
            f"agent-team-{stem}-v1alpha1.schema.json", "agent-team", "v1alpha1", f"{stem}.schema.json"
        )
    return _SCHEMA_CACHE[stem]


def _read(path: Path, stem: str) -> Optional[Dict[str, Any]]:
    """Read + validate one agent-team file; None when absent."""
    if not path.is_file():
        return None
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise LayoutError(f"gitops-emitter: failed to parse {path}: {exc}") from exc
    if doc is None:
        doc = {}
    if not isinstance(doc, dict):
        raise LayoutError(f"gitops-emitter: {path} must be a YAML mapping")
    if jsonschema is not None:
        try:
            jsonschema.validate(instance=doc, schema=_schema(stem))
        except jsonschema.exceptions.ValidationError as exc:
            where = "/".join(str(p) for p in exc.absolute_path) or "<root>"
            raise LayoutError(
                f"gitops-emitter: {path} failed agent-team/v1alpha1 {stem} schema validation at {where}: {exc.message}"
            ) from exc
    return doc


def contract_dir_for(
    payload_dir: Path, explicit: Optional[str] = None, source_subdir: Optional[str] = None
) -> Optional[Path]:
    """The agent's contract directory, or None for the legacy layout."""
    payload_dir = Path(payload_dir)
    chosen = explicit or os.environ.get(ENV_CONTRACT_DIR)
    if chosen:
        cdir = Path(chosen)
        if not (cdir / "agent.yaml").is_file():
            raise LayoutError(
                f"gitops-emitter: contract dir {cdir} has no agent.yaml (--contract-dir / "
                f"{ENV_CONTRACT_DIR} must name an agents/<harness>/<name>/{CONTRACT_DIRNAME}/ directory)"
            )
        return cdir
    beside = payload_dir.parent / CONTRACT_DIRNAME
    if payload_dir.name == SRC_DIRNAME and (beside / "agent.yaml").is_file():
        return beside
    team_subdir = source_subdir is not None and (
        source_subdir == SRC_DIRNAME or source_subdir.rstrip("/").endswith(f"/{SRC_DIRNAME}")
    )
    if team_subdir and not (payload_dir / "hermes-gitops.yaml").is_file():
        raise LayoutError(
            f"gitops-emitter: source subdir {source_subdir!r} is an agent-team `{SRC_DIRNAME}/` payload but no "
            f"contract was found: neither {beside}/agent.yaml beside {payload_dir}, nor --contract-dir / "
            f"{ENV_CONTRACT_DIR}, nor a legacy hermes-gitops.yaml inside it. Refusing to emit a record with "
            "no infra intent for an agent-team-layout agent - that would prune every app it owns"
        )
    return None


def _team_dir(contract_dir: Path) -> Path:
    # <root>/agents/<harness>/<name>/harness-hg -> <root>/harness-hg
    return contract_dir.parents[3] / CONTRACT_DIRNAME


def load_agent_declaration(
    payload_dir: Path, explicit_contract_dir: Optional[str] = None, source_subdir: Optional[str] = None
) -> Tuple[Optional[Dict[str, Any]], Optional[Path]]:
    """``(raw, agent_file)`` - the agent's declaration in the LEGACY raw
    shape and the file that stands for it in the catalogue. ``(None, None)``
    means legacy layout: the caller reads hermes-gitops.yaml as before."""
    cdir = contract_dir_for(payload_dir, explicit_contract_dir, source_subdir)
    if cdir is None:
        return None, None
    agent_dir = cdir.parent
    harness = agent_dir.parent.name
    name = agent_dir.name
    if harness not in HARNESSES:
        raise LayoutError(
            f"gitops-emitter: {cdir}: agents/{harness}/ is not a declared harness ({', '.join(HARNESSES)})"
        )
    agent = _read(cdir / "agent.yaml", "agent") or {}
    backup = _read(cdir / "backup.yaml", "backup")
    endpoints = _read(cdir / "endpoints.yaml", "endpoints") or {}
    apps_doc = _read(_team_dir(cdir) / "apps.yaml", "apps") or {}

    if agent.get("harness") != harness:
        raise LayoutError(
            f"gitops-emitter: {cdir / 'agent.yaml'}: harness: {agent.get('harness')!r} but the directory is "
            f"agents/{harness}/ - the path and the declaration must agree"
        )
    expose = endpoints.get("expose")
    if expose is not None and harness != "hermes":
        raise LayoutError(
            f"gitops-emitter: {cdir / 'endpoints.yaml'}: expose is Hermes-only (the record's expose block); "
            "an Eve agent declares endpoints[]"
        )
    optional_req = next((r for r in agent.get("requires") or [] if "optional" in r), None)
    if expose is not None and optional_req is not None:
        raise LayoutError(
            f"gitops-emitter: {cdir / 'agent.yaml'}: requires[] capability {optional_req.get('capability')}: "
            "`optional` cannot be carried beside endpoints.yaml's expose block (expose is the contract-v3 "
            "record shape, which predates optional requirements) - drop one until the endpoints generator "
            "is promoted"
        )
    mine: List[Dict[str, Any]] = []
    for app in apps_doc.get("apps") or []:
        for route in app.get("routes") or []:
            if (route.get("from") or {}).get("app") != app.get("name"):
                raise LayoutError(
                    f"gitops-emitter: {_team_dir(cdir) / 'apps.yaml'}: app {app.get('name')}: route "
                    f"{route.get('name')} is from app {(route.get('from') or {}).get('app')!r} - a route "
                    "under an app must be from that app"
                )
        if app.get("agent") == name:
            mine.append(app)

    # ---- the fold: agent-team files -> the legacy raw shape ----------------
    raw: Dict[str, Any] = {"contractVersion": 3 if expose is not None else 5}
    if harness == "eve":
        raw["runtime"] = {"kind": "eve", "envRequires": agent.get("envRequires") or []}
    for key in ("topology", "requires", "deployment", "gitAuthSecretRef"):
        if key in agent:
            raw[key] = agent[key]
    if backup is not None:
        raw["backup"] = {k: v for k, v in backup.items() if k not in ("apiVersion", "kind")}
    if "endpoints" in endpoints:
        raw["endpoints"] = endpoints["endpoints"]
    if expose is not None:
        raw["expose"] = expose
    routes = list(endpoints.get("routes") or [])
    for app in mine:
        routes.extend(app.get("routes") or [])
    external_inputs = list(endpoints.get("externalInputs") or [])
    if routes or external_inputs:
        communication: Dict[str, Any] = {}
        if external_inputs:
            communication["externalInputs"] = external_inputs
        if routes:
            communication["routes"] = routes
        raw["communication"] = communication
    if mine:
        raw["apps"] = [{k: v for k, v in app.items() if k not in ("agent", "routes")} for app in mine]
    return raw, cdir / "agent.yaml"


def dashboard_files(contract_dir: Path) -> Tuple[Optional[Path], Optional[Path]]:
    """``(dashboard.yaml, icons/)`` of an agent-team contract dir, each None
    when absent - the emitter catalogues them beside the legacy
    ``dashboard/`` tree's shape."""
    dash = contract_dir / "dashboard.yaml"
    icons = contract_dir / "icons"
    return (dash if dash.is_file() else None), (icons if icons.is_dir() else None)
