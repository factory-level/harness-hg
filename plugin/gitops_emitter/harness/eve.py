"""The EveAgent record builder (ADR-149).

An Eve agent is an npm project - ``package.json`` plus an ``agent/``
directory - at ``agents/<name>/`` in its source repository, with
``hermes-gitops.yaml`` (contract version 5, ``runtime.kind: eve``) beside
``package.json``. This module turns that project, at one commit, into the
record ``profiles/<name>/profile.yaml`` the eve-agent chart consumes
(``agent-bundle-contracts/eveagent/v1alpha3``).

It is the Eve counterpart of the Hermes pipeline in ``emitter.emit``:
``read_eve_manifest`` replaces the distribution.yaml read (identity comes
from ``package.json`` ``name``), ``load_eve_extension`` reads the v5 file
WITHOUT stripping it (the ``runtime`` block is this record's env contract),
and ``build_eve_record`` produces a record whose bytes are a pure function
of its inputs (``render.render_yaml`` canonicalizes). Nothing here touches
Git - ``emit_cli`` hands the rendered record to ``emitter.publish_record``,
the same publisher the Hermes hook uses.

Everything fails loudly and early: a project without a lockfile, without
instructions, whose name is not a DNS label, or whose extension selects
another runtime stops here with the fix named, before anything is written.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from .hermes import (
    EXTENSION_FILE_RELPATH,
    GitopsEmitterError,
    _extract_env_requires,
    _load_yaml_mapping,
)
from .. import layout
from ..render import (
    _APP_FIELD_ORDER,
    _BACKUP_FIELD_ORDER,
    _ordered,
    load_vendored_schema,
    resolve_apps,
    validate_extension_v5,
    validate_name,
)

try:  # same soft dependency as render.py
    import jsonschema
except ImportError:  # pragma: no cover
    jsonschema = None  # type: ignore[assignment]

RUNTIME = "eve"
_INSTRUCTION_SOURCES = ("instructions.md", "instructions.ts", "instructions")


def read_eve_manifest(agent_dir: Path) -> Dict[str, Any]:
    """Identify an Eve project and check the properties the chart's build
    step will need - the early half of every failure the initContainer
    could otherwise only report from inside the cluster."""
    agent_dir = Path(agent_dir)
    package_json = agent_dir / "package.json"
    if not package_json.is_file():
        raise GitopsEmitterError(
            f"gitops-emitter: {agent_dir} has no package.json - an Eve agent is an npm "
            "project (package.json + agent/), conventionally at agents/<name>/"
        )
    try:
        pkg = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GitopsEmitterError(f"gitops-emitter: {package_json} is not valid JSON: {exc}") from exc
    name = pkg.get("name") if isinstance(pkg, dict) else None
    if not isinstance(name, str) or not name:
        raise GitopsEmitterError(
            f"gitops-emitter: {package_json} has no \"name\" - the package name is the "
            "agent's identity (a DNS-1123 label of at most 40 characters)"
        )
    try:
        validate_name(name)
    except GitopsEmitterError as exc:
        raise GitopsEmitterError(
            f"gitops-emitter: {package_json} name {name!r} is not usable as an agent identity: {exc}"
        ) from exc
    if not (agent_dir / "agent").is_dir():
        raise GitopsEmitterError(
            f"gitops-emitter: {agent_dir} has no agent/ directory - eve discovers the agent "
            "from agent/ (instructions, tools, channels, ...)"
        )
    agent_sub = agent_dir / "agent"
    has_instructions = (
        (agent_sub / "instructions.md").is_file()
        or (agent_sub / "instructions.ts").is_file()
        or (agent_sub / "instructions").is_dir()
    )
    if not has_instructions:
        raise GitopsEmitterError(
            f"gitops-emitter: {agent_dir}/agent has no instructions.md, instructions.ts or "
            "instructions/ - eve requires instructions on the root agent, and `eve build` "
            "would refuse in the cluster; add them here first"
        )
    deps = pkg.get("dependencies") if isinstance(pkg, dict) else None
    eve_dep = deps.get("eve") if isinstance(deps, dict) else None
    if not isinstance(eve_dep, str) or not eve_dep:
        raise GitopsEmitterError(
            f"gitops-emitter: {package_json} does not depend on \"eve\" - the project's own eve "
            "builds and serves the agent in the pod; add it to dependencies (pinned to the "
            "platform's runtime version)"
        )
    lock_path = agent_dir / "package-lock.json"
    if not lock_path.is_file():
        raise GitopsEmitterError(
            f"gitops-emitter: {agent_dir} has no package-lock.json - the pod builds with "
            "`npm ci`, which needs the lockfile; commit one (npm install --package-lock-only)"
        )
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GitopsEmitterError(f"gitops-emitter: {lock_path} is not valid JSON: {exc}") from exc
    locked = ((lock.get("packages") or {}).get("node_modules/eve") or {}) if isinstance(lock, dict) else {}
    locked_eve = locked.get("version") if isinstance(locked, dict) else None
    if not isinstance(locked_eve, str) or not locked_eve:
        raise GitopsEmitterError(
            f"gitops-emitter: {lock_path} does not resolve \"eve\" - refresh the lockfile "
            "(npm install --package-lock-only) so `npm ci` can install the runtime"
        )
    return {"name": name, "eve_dependency": eve_dep, "eve_locked": locked_eve}


def check_eve_version(manifest: Dict[str, Any], *, expected: Optional[str], extension: Dict[str, Any]) -> None:
    """The platform pins the runtime (versions.json runtimes.eve, ADR-63).
    The chart's build step refuses a mismatch inside the cluster; this is
    the same check at emit time, so it fails before anything reaches Git.
    ``expected`` is the platform pin the caller passes (Pulumi and hg both
    import versions.json); ``deployment.runtimeImageTag`` is the author's
    override and, when set, is what the locked eve must equal instead."""
    locked = manifest["eve_locked"]
    deployment = extension.get("deployment") or {}
    override = deployment.get("runtimeImageTag") if isinstance(deployment, dict) else None
    want = override or expected
    if want and locked != want:
        source = "deployment.runtimeImageTag" if override else "the platform's pinned runtime"
        raise GitopsEmitterError(
            f"gitops-emitter: the project's lockfile resolves eve@{locked} but {source} is "
            f"eve@{want} - pin \"eve\": \"{want}\" in package.json and refresh package-lock.json"
            + ("" if override else ", or set deployment.runtimeImageTag to a platform image that ships "
               f"{locked}")
        )


def load_eve_extension(
    agent_dir: Path, contract_dir: Optional[str] = None, source_subdir: Optional[str] = None
) -> Dict[str, Any]:
    """Read and validate the v5 hermes-gitops.yaml beside package.json. For
    an Eve agent the file is REQUIRED - it is what says the directory is an
    Eve project - and is returned whole (not stripped): the ``runtime``
    block carries the env contract the record needs."""
    # Agent-team layout (ADR 0178): harness-hg/agent.yaml + siblings fold
    # into the v5 shape and go through the same checks below.
    try:
        folded, agent_file = layout.load_agent_declaration(Path(agent_dir), contract_dir, source_subdir)
    except layout.LayoutError as exc:
        raise GitopsEmitterError(str(exc)) from exc
    if folded is not None:
        mapping = folded
        path = agent_file
    else:
        path = Path(agent_dir) / EXTENSION_FILE_RELPATH
        if not path.is_file():
            raise GitopsEmitterError(
                f"gitops-emitter: {path} is missing - an Eve agent declares itself with "
                "`contractVersion: 5` and `runtime: {kind: eve}` beside package.json"
            )
        mapping = _load_yaml_mapping(path, label=str(EXTENSION_FILE_RELPATH))
    version = mapping.get("contractVersion")
    if version != 5:
        raise GitopsEmitterError(
            f"gitops-emitter: {path} has contractVersion {version!r}; an Eve agent needs "
            "contractVersion: 5 (the first version with a runtime block)"
        )
    validate_extension_v5(mapping)
    runtime = mapping.get("runtime")
    kind = runtime.get("kind") if isinstance(runtime, dict) else None
    if kind != RUNTIME:
        raise GitopsEmitterError(
            f"gitops-emitter: {path} has no `runtime: {{kind: eve}}` block - without it the "
            "directory is a Hermes profile and this builder does not apply"
        )
    return mapping


def eve_env_requires(extension: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The normalized env contract ({name, required, secret[, description]})
    from ``runtime.envRequires`` - the same entry shape and the same
    conservative defaults the HermesProfile record carries."""
    entries = (extension.get("runtime") or {}).get("envRequires") or []
    # Canonical order (by name), the order render_yaml writes - so the
    # in-memory record equals its own rendering.
    return sorted(_extract_env_requires({"env_requires": entries}), key=lambda e: e["name"])


_OVERLAY_FIELD_ORDER = ("id", "kind", "mode", "target", "source", "contentHash", "gitAuthSecretRef")
_OVERLAY_SOURCE_FIELD_ORDER = ("repository", "commit", "path")
_OVERLAY_TOKEN = re.compile(r"[^\s\x00-\x1f\x7f]+")


def _string_leaves(value: Any):
    """Every string anywhere inside one overlay entry."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _string_leaves(item)
    elif isinstance(value, list):
        for item in value:
            yield from _string_leaves(item)


def eve_overlays(document: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The operator-overlay half of the record (ADR 0194), or ``None``.

    ``document`` is what the team compiler writes for one agent after
    fetching, hashing and approval: ``{"overlays": [...], "overlayTreeHash":
    "<sha256>"}``. Entries keep their application order - order IS the merge
    semantics, so they are never sorted - and schema field order. Two rules
    the schema cannot state are enforced here: ids are unique, and a target
    has one writer unless every writer is an instructions overlay (an
    optional override first, then appends). An absent or empty document
    yields nothing, so a record without overlays renders byte-identical to
    its v1alpha2 form."""
    if document is None:
        return None
    if not isinstance(document, dict):
        raise GitopsEmitterError(
            "gitops-emitter: the overlays document must be an object "
            "{\"overlays\": [...], \"overlayTreeHash\": \"<sha256>\"}"
        )
    unknown = sorted(str(key) for key in set(document) - {"overlays", "overlayTreeHash"})
    if unknown:
        raise GitopsEmitterError(
            f"gitops-emitter: the overlays document has unknown keys {', '.join(unknown)} - it "
            "carries only overlays and overlayTreeHash, and a misspelled key is never ignored"
        )
    entries = document.get("overlays", [])
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise GitopsEmitterError("gitops-emitter: overlays must be a list of overlay objects")
    if not entries:
        if "overlayTreeHash" in document:
            raise GitopsEmitterError(
                "gitops-emitter: the overlays document has overlayTreeHash but no overlays - "
                "the tree hash exists only to verify an applied overlay"
            )
        return None
    tree_hash = document.get("overlayTreeHash")
    if not isinstance(tree_hash, str) or not tree_hash:
        raise GitopsEmitterError(
            "gitops-emitter: overlays need overlayTreeHash - the merged agent/ tree hash the "
            "build container verifies before it builds"
        )
    # Every overlay value is one token: the build container reads overlays as
    # whitespace-separated lines, and Python's `$` would otherwise let a
    # trailing newline through patterns an ECMA-262 validator refuses.
    if not _OVERLAY_TOKEN.fullmatch(tree_hash):
        raise GitopsEmitterError(
            "gitops-emitter: overlayTreeHash contains whitespace or control characters"
        )
    seen: set = set()
    writers: Dict[Any, List[Dict[str, Any]]] = {}
    ordered: List[Dict[str, Any]] = []
    for index, entry in enumerate(entries):
        if not all(_OVERLAY_TOKEN.fullmatch(value) for value in _string_leaves(entry)):
            raise GitopsEmitterError(
                f"gitops-emitter: overlay #{index + 1} has a value with whitespace or control "
                "characters - every overlay field is a single token"
            )
        overlay_id = entry.get("id")
        if overlay_id in seen:
            raise GitopsEmitterError(
                f"gitops-emitter: overlay id {overlay_id!r} appears twice - overlay ids are "
                "unique within an agent"
            )
        seen.add(overlay_id)
        writers.setdefault(entry.get("target"), []).append(entry)
        item = _ordered(entry, _OVERLAY_FIELD_ORDER)
        if isinstance(item.get("source"), dict):
            item["source"] = _ordered(item["source"], _OVERLAY_SOURCE_FIELD_ORDER)
        ordered.append(item)
    for target, group in writers.items():
        if len(group) < 2:
            continue
        stacked = all(entry.get("kind") == "instructions" for entry in group) and all(
            entry.get("mode") == "append" for entry in group[1:]
        )
        if not stacked:
            ids = ", ".join(str(entry.get("id")) for entry in group)
            raise GitopsEmitterError(
                f"gitops-emitter: target {target!r} is written by overlays {ids} - one overlay "
                "per target; only instructions stack (an optional override first, then appends)"
            )
    return {"overlays": ordered, "overlayTreeHash": tree_hash}


def build_eve_record(
    name: str,
    *,
    source: str,
    sha: str,
    ref: Optional[str],
    subdir: Optional[str],
    extension: Dict[str, Any],
    app_values: Optional[Dict[str, Any]] = None,
    overlays: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Assemble the EveAgent record. Field set = the v1alpha3 schema;
    ``env`` (the compiled overlay) is the topology compiler's, never
    emitted here. ``apps`` goes through the same ``resolve_apps`` the
    Hermes pipeline uses (author values + ``app_values`` overrides
    deep-merged, every ``valuesRequired`` path proven non-null) so a child
    Application renders from identical inputs on either runtime; ``backup``
    is copied as intent (schedule + retention) for the chart's routine;
    ``overlays`` (ADR 0194) is the team compiler's approved operator-overlay
    document, carried last and only when it has entries."""
    spec: Dict[str, Any] = {
        "persona": name,
        "runtime": RUNTIME,
        "source": source,
        "sha": sha,
    }
    if ref:
        spec["ref"] = ref
    if subdir:
        spec["sourceSubdir"] = subdir
    git_auth = extension.get("gitAuthSecretRef")
    if git_auth:
        spec["gitAuthSecretRef"] = git_auth
    env_requires = eve_env_requires(extension)
    if env_requires:
        spec["envRequires"] = env_requires
    resolved_apps = resolve_apps(extension.get("apps"), app_values, persona=name)
    if resolved_apps:
        spec["apps"] = [_ordered(app, _APP_FIELD_ORDER) for app in resolved_apps]
    deployment = extension.get("deployment")
    if isinstance(deployment, dict) and deployment:
        if "baseImageTag" in deployment:
            raise GitopsEmitterError(
                f"gitops-emitter: {EXTENSION_FILE_RELPATH} deployment.baseImageTag names the "
                "Hermes image; an Eve agent overrides its runtime image with "
                "deployment.runtimeImageTag"
            )
        spec["deployment"] = dict(deployment)
    backup = extension.get("backup")
    if isinstance(backup, dict) and backup:
        spec["backup"] = _ordered(backup, _BACKUP_FIELD_ORDER)
    resolved_overlays = eve_overlays(overlays)
    if resolved_overlays:
        spec["overlays"] = resolved_overlays["overlays"]
        spec["overlayTreeHash"] = resolved_overlays["overlayTreeHash"]
    return {"spec": spec}


_RECORD_SCHEMA_CACHE: Optional[Dict[str, Any]] = None
# Validators whose messages name keys or counts, never the rejected value.
_STRUCTURAL_VALIDATORS = frozenset(
    {"required", "additionalProperties", "dependentRequired", "minItems", "maxItems", "uniqueItems"}
)


def _record_schema() -> Dict[str, Any]:
    global _RECORD_SCHEMA_CACHE
    if _RECORD_SCHEMA_CACHE is None:
        _RECORD_SCHEMA_CACHE = load_vendored_schema(
            "eveagent-v1alpha3.schema.json", "eveagent", "v1alpha3", "eveagent.schema.json"
        )
    return _RECORD_SCHEMA_CACHE


def validate_eve_record(record: Dict[str, Any]) -> None:
    """Validate against the vendored eveagent/v1alpha3 schema before
    anything is written (same soft-dependency contract as render.validate)."""
    if jsonschema is None:  # pragma: no cover - soft dependency
        return
    try:
        jsonschema.validate(instance=record, schema=_record_schema())
    except jsonschema.exceptions.ValidationError as exc:
        path = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        # Value-checking validators quote the rejected value, and an overlay
        # repository URL can carry a credential: only structural messages are
        # echoed, the rest name the constraint at the path.
        if exc.validator in _STRUCTURAL_VALIDATORS:
            detail = exc.message
        else:
            detail = f"the value does not satisfy its {exc.validator} constraint"
        raise GitopsEmitterError(
            f"gitops-emitter: EveAgent record failed schema validation at {path}: {detail}"
        ) from exc
