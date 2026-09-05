"""Pure render pipeline for gitops-emitter.

Turns a parsed hermes-gitops.yaml extension (the ONE carrier of a
profile's infra intent, read beside distribution.yaml) plus a
profile-hook payload into a
fully-resolved HermesProfile record (a plain dict of Helm values — a single
top-level ``spec`` block, no Kubernetes apiVersion/kind/metadata wrapper;
there is no HermesProfile CRD) and its canonical YAML serialization. The
record's identity is its directory name in the GitOps repo
(``profiles/<name>/profile.yaml``), so the instance-name rules (DNS-1123
label, max 40 chars) are enforced here by ``validate_name``, not by the
JSON schema. Nothing in this module touches disk (other than reading
the vendored schema once, lazily), the network, or git — see ``emitter.py``
for the side-effecting pipeline (implemented in a later task).

Determinism is the whole point: the same logical input, regardless of how
its source dicts happened to be built up, must always render to the same
bytes. ``build_record`` is what guarantees this — it assembles the output
dict field-by-field in a fixed order rather than trusting caller-supplied
dict ordering.
"""

from __future__ import annotations

import json
import pathlib
import re
from importlib import resources
from typing import Any, Dict, List, Optional

import yaml

from .errors import GitopsEmitterError

# The canonical schema tree in a source checkout (the wheel's force-included
# copies win when present — see load_vendored_schema). ONE definition: every
# fallback in this module resolves through it, so a schema-tree move is a
# one-line change here plus pyproject's force-include list.
SCHEMAS_ROOT = pathlib.Path(__file__).resolve().parents[2] / "agent-bundle-contracts"

try:
    import jsonschema
except ImportError:  # pragma: no cover - soft dependency, see validate()
    jsonschema = None  # type: ignore[assignment]

__all__ = [
    "EXTENSION_KEYS",
    "LOCAL_REPO",
    "validate_name",
    "deep_merge",
    "secret_name",
    "resolve_apps",
    "build_record",
    "render_yaml",
    "validate",
]

# The allowed top-level keys of hermes-gitops.yaml (the ONE carrier of a
# profile's infra intent — embedded blocks in distribution.yaml are no
# longer read). Mirrors the extension schema
# (agent-bundle-contracts/hermes-gitops-extension/v1alpha1/hermes-gitops.schema.json);
# emitter.load_extension_file rejects anything else loudly.
EXTENSION_KEYS = (
    "apps",
    "deployment",
    "expose",
    "backup",
    "gitAuthSecretRef",
)

# Contract v2 (ADR-33): the four keys a `contractVersion: 2` file adds on
# top of EXTENSION_KEYS. Their consumer is the topology compiler in the hg
# CLI - the emitter validates the file against the vendored v1alpha2
# schema and then STRIPS them (strip_extension_v2), so the rendered
# v1alpha1 record is byte-identical to the same five blocks authored as
# v1. Mirrors agent-bundle-contracts/hermes-gitops-extension/v1alpha2/ (guarded by
# a properties-equality test, not by hand-sync).
V2_ONLY_KEYS = ("contractVersion", "topology", "endpoints", "requires")
EXTENSION_KEYS_V2 = EXTENSION_KEYS + V2_ONLY_KEYS

# v2-only keys inside an apps[] entry, stripped alongside the top level.
V2_ONLY_APP_KEYS = ("topology", "endpoints")

# Contract v3 (communication plane): one key on top of v2 - the
# communication block (routes + externalInputs) - plus outputs[] inside
# apps[] entries. Consumers are the topology compiler and the event
# router in the hg CLI; the emitter validates against the vendored
# v1alpha3 schema and STRIPS them, so the rendered record stays
# byte-identical v1. The communication plane delivers to the Hermes agent
# gateway - stripping here is what keeps the agent runtime contract
# untouched.
V3_ONLY_KEYS = V2_ONLY_KEYS + ("communication",)
EXTENSION_KEYS_V3 = EXTENSION_KEYS + V3_ONLY_KEYS
V3_ONLY_APP_KEYS = V2_ONLY_APP_KEYS + ("outputs",)

# Contract v4 (#143, #147/ADR-99): requires[].optional arrives (a field
# INSIDE a block v2 already strips whole), and the legacy `expose` block
# LEAVES - v4 ends the additive window, exposure is per-endpoint type
# only. So the v4 allowlist is v3's minus expose; a v4 file carrying
# expose fails the unknown-key check (and the schema) rather than being
# silently dropped into an unexposed deploy.
V4_ONLY_KEYS = V3_ONLY_KEYS
EXTENSION_KEYS_V4 = tuple(k for k in EXTENSION_KEYS if k != "expose") + V4_ONLY_KEYS
V4_ONLY_APP_KEYS = V3_ONLY_APP_KEYS

# Contract v5 (ADR-149, the agent runtime): one key on top of v4 - the
# `runtime` block (kind + envRequires). For a Hermes profile the block is
# absent and v5 is v4 under a new marker, so the strip drops it and the
# record stays byte-identical. A file carrying `runtime.kind: eve` is an
# Eve project and never reaches this (Hermes) record pipeline - the Eve
# record builder in gitops_emitter.harness.eve reads the block instead.
V5_ONLY_KEYS = V4_ONLY_KEYS + ("runtime",)
EXTENSION_KEYS_V5 = tuple(k for k in EXTENSION_KEYS if k != "expose") + V5_ONLY_KEYS
V5_ONLY_APP_KEYS = V4_ONLY_APP_KEYS

# The reserved apps[].repo word: the chart ships with the platform/GitOps
# repo (apps[].chart is then a path into that tree) and versions with the
# platform revision — no per-app `version` allowed.
LOCAL_REPO = "local"

# Fixed field orders for the nested object shapes inside spec, mirroring the
# vendored schema's own property declaration order. build_record uses these
# to reorder each nested dict's keys regardless of how the caller (deep_merge
# output, parsed YAML, ...) happened to build it up, so determinism holds not
# just for the top-level spec fields but for every dict anywhere in the
# document. Unknown keys (shouldn't occur — the schema forbids
# additionalProperties) are appended after the known ones rather than
# dropped, so a schema mismatch surfaces as a validate() error, not silent
# data loss.
# v1alpha2 dropped machineType/region/diskType: pod is the only compute
# path, so they described nothing this platform provisions (#132, ADR-8).
_DEPLOYMENT_FIELD_ORDER = (
    "baseImageTag",
    "diskSizeGb",
)
_APP_FIELD_ORDER = ("name", "chart", "repo", "version", "values")
_EXPOSE_FIELD_ORDER = ("services", "access")
_EXPOSE_SERVICE_FIELD_ORDER = ("name", "port", "path")
_EXPOSE_ACCESS_FIELD_ORDER = ("policy",)
_BACKUP_FIELD_ORDER = ("schedule", "retention")


def _ordered(d: Dict[str, Any], field_order: tuple) -> Dict[str, Any]:
    """Return a copy of dict *d* with keys reordered to match *field_order*.

    Keys from *d* not present in *field_order* are appended afterward, in
    their original relative order, so nothing is ever silently dropped.
    """
    result = {key: d[key] for key in field_order if key in d}
    for key, value in d.items():
        if key not in result:
            result[key] = value
    return result


_SCHEMA_CACHE: Optional[Dict[str, Any]] = None


def _load_schema() -> Dict[str, Any]:
    """Load (and cache) the HermesProfile v1alpha1 JSON Schema.

    Installed wheel: the canonical schema is packaged into the wheel at
    build time (pyproject.toml's [tool.hatch.build.targets.wheel.force-include],
    issue #28 [L1] — nothing is committed twice) under
    ``gitops_emitter/schema/``, resolved via importlib.resources.

    Source checkout / editable install: that packaged path doesn't exist
    on disk, so fall back to the canonical file at the repo root
    (``agent-bundle-contracts/hermesprofile/v1alpha3/profile.schema.json``) — the single
    source of truth the build step packages from.
    """
    global _SCHEMA_CACHE
    if _SCHEMA_CACHE is None:
        packaged = resources.files(__package__).joinpath(
            "schema", "hermesprofile-v1alpha3.schema.json"
        )
        if packaged.is_file():
            schema_text = packaged.read_text(encoding="utf-8")
        else:
            canonical = (
                SCHEMAS_ROOT
                / "hermesprofile"
                / "v1alpha3"
                / "profile.schema.json"
            )
            schema_text = canonical.read_text(encoding="utf-8")
        _SCHEMA_CACHE = json.loads(schema_text)
    return _SCHEMA_CACHE


_EXT_V2_SCHEMA_CACHE: Optional[Dict[str, Any]] = None


def _load_extension_v2_schema() -> Dict[str, Any]:
    """Load (and cache) the hermes-gitops-extension v1alpha2 schema, with
    the same packaged-then-canonical resolution as ``_load_schema``."""
    global _EXT_V2_SCHEMA_CACHE
    if _EXT_V2_SCHEMA_CACHE is None:
        packaged = resources.files(__package__).joinpath(
            "schema", "hermes-gitops-extension-v1alpha2.schema.json"
        )
        if packaged.is_file():
            schema_text = packaged.read_text(encoding="utf-8")
        else:
            canonical = (
                SCHEMAS_ROOT
                / "hermes-gitops-extension"
                / "v1alpha2"
                / "hermes-gitops.schema.json"
            )
            schema_text = canonical.read_text(encoding="utf-8")
        _EXT_V2_SCHEMA_CACHE = json.loads(schema_text)
    return _EXT_V2_SCHEMA_CACHE


def validate_extension_v2(mapping: Dict[str, Any]) -> None:
    """Validate a ``contractVersion: 2`` hermes-gitops.yaml against the
    vendored v1alpha2 schema.

    Same soft-dependency contract as ``validate()``: without ``jsonschema``
    this is a no-op, and the key-allowlist check in ``load_extension_file``
    still guards the top level.
    """
    if jsonschema is None:  # pragma: no cover - soft dependency
        return
    try:
        jsonschema.validate(instance=mapping, schema=_load_extension_v2_schema())
    except jsonschema.exceptions.ValidationError as exc:
        path = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        raise GitopsEmitterError(
            "hermes-gitops.yaml (contractVersion: 2) schema validation "
            f"failed at {path}: {exc.message}"
        ) from exc


_EXT_V3_SCHEMA_CACHE: Optional[Dict[str, Any]] = None


def _load_extension_v3_schema() -> Dict[str, Any]:
    """Load (and cache) the hermes-gitops-extension v1alpha3 schema, with
    the same packaged-then-canonical resolution as ``_load_schema``."""
    global _EXT_V3_SCHEMA_CACHE
    if _EXT_V3_SCHEMA_CACHE is None:
        packaged = resources.files(__package__).joinpath(
            "schema", "hermes-gitops-extension-v1alpha3.schema.json"
        )
        if packaged.is_file():
            schema_text = packaged.read_text(encoding="utf-8")
        else:
            canonical = (
                SCHEMAS_ROOT
                / "hermes-gitops-extension"
                / "v1alpha3"
                / "hermes-gitops.schema.json"
            )
            schema_text = canonical.read_text(encoding="utf-8")
        _EXT_V3_SCHEMA_CACHE = json.loads(schema_text)
    return _EXT_V3_SCHEMA_CACHE


def validate_extension_v3(mapping: Dict[str, Any]) -> None:
    """Validate a ``contractVersion: 3`` hermes-gitops.yaml against the
    vendored v1alpha3 schema (same soft-dependency contract as v2)."""
    if jsonschema is None:  # pragma: no cover - soft dependency
        return
    try:
        jsonschema.validate(instance=mapping, schema=_load_extension_v3_schema())
    except jsonschema.exceptions.ValidationError as exc:
        path = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        raise GitopsEmitterError(
            "hermes-gitops.yaml (contractVersion: 3) schema validation "
            f"failed at {path}: {exc.message}"
        ) from exc


def strip_extension_v2(mapping: Dict[str, Any]) -> Dict[str, Any]:
    """Project a v2 extension onto the v1 shape the record pipeline consumes.

    Drops the v2-only top-level keys and each apps[] entry's v2-only keys.
    The emitter never interprets topology semantics (ADR-33); the result
    renders a record byte-identical to the v1 authoring of the same five
    blocks (proven by test_extension_v2).
    """
    return _strip_extension(mapping, V2_ONLY_APP_KEYS)


def strip_extension_v3(mapping: Dict[str, Any]) -> Dict[str, Any]:
    """Project a v3 extension onto the v1 record shape - same discipline as
    v2, additionally dropping ``communication`` (not in EXTENSION_KEYS) and
    each apps[] entry's ``outputs``. The record pipeline never sees the
    communication plane (proven by test_extension_v3)."""
    return _strip_extension(mapping, V3_ONLY_APP_KEYS)


_EXT_V4_SCHEMA_CACHE: Optional[Dict[str, Any]] = None


def _load_extension_v4_schema() -> Dict[str, Any]:
    """Load (and cache) the hermes-gitops-extension v1alpha4 schema, with
    the same packaged-then-canonical resolution as ``_load_schema``."""
    global _EXT_V4_SCHEMA_CACHE
    if _EXT_V4_SCHEMA_CACHE is None:
        packaged = resources.files(__package__).joinpath(
            "schema", "hermes-gitops-extension-v1alpha4.schema.json"
        )
        if packaged.is_file():
            schema_text = packaged.read_text(encoding="utf-8")
        else:
            canonical = (
                SCHEMAS_ROOT
                / "hermes-gitops-extension"
                / "v1alpha4"
                / "hermes-gitops.schema.json"
            )
            schema_text = canonical.read_text(encoding="utf-8")
        _EXT_V4_SCHEMA_CACHE = json.loads(schema_text)
    return _EXT_V4_SCHEMA_CACHE


def validate_extension_v4(mapping: Dict[str, Any]) -> None:
    """Validate a ``contractVersion: 4`` hermes-gitops.yaml against the
    vendored v1alpha4 schema (same soft-dependency contract as v2/v3)."""
    if jsonschema is None:  # pragma: no cover - soft dependency
        return
    try:
        jsonschema.validate(instance=mapping, schema=_load_extension_v4_schema())
    except jsonschema.exceptions.ValidationError as exc:
        path = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        raise GitopsEmitterError(
            "hermes-gitops.yaml (contractVersion: 4) schema validation "
            f"failed at {path}: {exc.message}"
        ) from exc


def strip_extension_v4(mapping: Dict[str, Any]) -> Dict[str, Any]:
    """Project a v4 extension onto the v1 record shape - byte-identical to
    the v3 strip, because v4 adds no new keys (requires[].optional lives
    inside a block the strip already drops whole)."""
    return _strip_extension(mapping, V4_ONLY_APP_KEYS)


_EXT_V5_SCHEMA_CACHE: Optional[Dict[str, Any]] = None


def load_vendored_schema(packaged_name: str, *canonical_parts: str) -> Dict[str, Any]:
    """Load a schema the wheel force-includes as ``schema/<packaged_name>``,
    falling back to its canonical ``agent-bundle-contracts/<parts>`` path in a source
    checkout - the resolution every versioned loader in this module uses."""
    packaged = resources.files(__package__).joinpath("schema", packaged_name)
    if packaged.is_file():
        return json.loads(packaged.read_text(encoding="utf-8"))
    canonical = SCHEMAS_ROOT
    for part in canonical_parts:
        canonical = canonical / part
    return json.loads(canonical.read_text(encoding="utf-8"))


def _load_extension_v5_schema() -> Dict[str, Any]:
    global _EXT_V5_SCHEMA_CACHE
    if _EXT_V5_SCHEMA_CACHE is None:
        _EXT_V5_SCHEMA_CACHE = load_vendored_schema(
            "hermes-gitops-extension-v1alpha5.schema.json",
            "hermes-gitops-extension",
            "v1alpha5",
            "hermes-gitops.schema.json",
        )
    return _EXT_V5_SCHEMA_CACHE


def validate_extension_v5(mapping: Dict[str, Any]) -> None:
    """Validate a ``contractVersion: 5`` hermes-gitops.yaml against the
    vendored v1alpha5 schema (same soft-dependency contract as v2-v4)."""
    if jsonschema is None:  # pragma: no cover - soft dependency
        return
    try:
        jsonschema.validate(instance=mapping, schema=_load_extension_v5_schema())
    except jsonschema.exceptions.ValidationError as exc:
        path = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        raise GitopsEmitterError(
            "hermes-gitops.yaml (contractVersion: 5) schema validation "
            f"failed at {path}: {exc.message}"
        ) from exc


def strip_extension_v5(mapping: Dict[str, Any]) -> Dict[str, Any]:
    """Project a v5 extension onto the v1 record shape - byte-identical to
    the v4 strip; `runtime` is dropped with the other versioned keys."""
    return _strip_extension(mapping, V5_ONLY_APP_KEYS)


def _strip_extension(mapping: Dict[str, Any], app_keys: tuple) -> Dict[str, Any]:
    out = {k: v for k, v in mapping.items() if k in EXTENSION_KEYS}
    apps = out.get("apps")
    if isinstance(apps, list):
        out["apps"] = [
            {k: v for k, v in entry.items() if k not in app_keys}
            if isinstance(entry, dict)
            else entry
            for entry in apps
        ]
    return out


_NAME_MAX_LENGTH = 40
_NAME_PATTERN = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")


def validate_name(name: str) -> None:
    """Validate an instance name (the record's directory name).

    The name becomes ``profiles/<name>/`` in the GitOps repo and, via the
    ApplicationSet's ``{{.path.basename}}``, the ``hermes-<name>``
    Application/release/namespace — so it must be a DNS-1123 label of at
    most 40 chars (leaving room for the ``hermes-`` prefix and derived
    names under the 63-char DNS label limit). The JSON schema can't check
    this (the record no longer carries a name field), so it's enforced
    here, at the front of the emit pipeline.
    """
    if len(name) > _NAME_MAX_LENGTH:
        raise GitopsEmitterError(
            f"instance name {name!r} is {len(name)} chars long "
            f"(max {_NAME_MAX_LENGTH})"
        )
    if not _NAME_PATTERN.match(name):
        raise GitopsEmitterError(
            f"instance name {name!r} is not a DNS-1123 label "
            "(lowercase alphanumerics and hyphens, must start/end alphanumeric)"
        )


def deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively merge ``override`` onto ``base``.

    - Nested dicts are merged key-by-key, recursively.
    - Lists (and every other non-dict type) are replaced wholesale by the
      override's value — never concatenated or merged element-wise.
    - A key present in only one of the two inputs passes through unchanged.
    - Neither input is mutated; a new dict is returned.
    """
    result = dict(base)
    for key, override_value in override.items():
        base_value = result.get(key)
        if isinstance(base_value, dict) and isinstance(override_value, dict):
            result[key] = deep_merge(base_value, override_value)
        else:
            result[key] = override_value
    return result


def secret_name(instance: str, env_var: str) -> str:
    """Derive the Kubernetes Secret name gitops-emitter uses for one env var.

    ``("support-agent", "DISCORD_BOT_TOKEN")`` -> ``"hermes-support-agent-discord-bot-token"``.
    """
    return f"hermes-{instance}-{env_var.lower().replace('_', '-')}"


_REMOTE_REPO_SCHEMES = ("https://", "oci://")


def _resolve_dot_path(values: Dict[str, Any], dot_path: str) -> Any:
    """Resolve *dot_path* (e.g. ``auth.apiKeySecretRef``) inside *values*.

    Returns the resolved value, or ``None`` when any segment is missing,
    any intermediate segment is not a mapping, or the final value is
    ``null``. Paths only traverse mappings — a ``valuesRequired`` path
    cannot point inside a list.
    """
    node: Any = values
    for segment in dot_path.split("."):
        if not isinstance(node, dict) or segment not in node:
            return None
        node = node[segment]
    return node


def resolve_apps(
    apps: Optional[List[Dict[str, Any]]],
    app_values: Optional[Dict[str, Any]] = None,
    *,
    persona: str = "<name>",
) -> List[Dict[str, Any]]:
    """Validate + resolve the extension's ``apps`` list into the record shape.

    ``apps`` is hermes-gitops.yaml's ``apps:`` block — the helm apps this
    profile launches, in author order (each entry:
    ``{name, chart, repo, version?, values?, valuesRequired?}``).

    ``app_values`` is the merged per-app values-override map — fleet
    defaults and per-instance overrides may each carry
    ``appValues: {<appName>: {<values fragment>}}``; those layers ride the
    normal defaults→extension→overrides ``deep_merge`` chain, and the
    resulting fragment for each app is deep-merged here ON TOP of the
    author's own ``values``. Merge semantics are ``deep_merge``'s:
    mappings merge key-by-key, while lists (and every other non-mapping
    value) are REPLACED WHOLESALE — positional list merging is forbidden,
    so an override that touches a list must restate the entire list.

    Validation (all of it BEFORE any manifest generation, K5 fail-fast):

    * every entry is a mapping with a DNS-label ``name``, unique within
      the list;
    * ``chart`` is a non-empty string;
    * ``repo`` is the reserved word ``local`` or starts with ``https://``
      / ``oci://``;
    * ``version`` is REQUIRED for remote repos and FORBIDDEN for
      ``local`` ones;
    * ``app_values`` entries naming apps this profile does not declare
      are ignored (fleet defaults are shared across personas — see the
      inline note below);
    * after merging, every ``valuesRequired`` dot-path must resolve to a
      non-null value — otherwise ``GitopsEmitterError`` lists EVERY
      missing path together with the exact override command that supplies
      it.

    Returns the resolved list for ``spec.apps``: merged ``values``
    inlined, ``valuesRequired`` (already satisfied) dropped, fields in the
    record's fixed order. Empty/absent input resolves to ``[]``.
    """
    if apps is None:
        apps = []
    if not isinstance(apps, list):
        raise GitopsEmitterError(
            f"hermes-gitops.yaml: apps must be a list, got {type(apps).__name__}"
        )
    app_values = app_values or {}
    if not isinstance(app_values, dict):
        raise GitopsEmitterError(
            f"appValues must be a mapping of {{appName: values fragment}}, "
            f"got {type(app_values).__name__}"
        )

    resolved: List[Dict[str, Any]] = []
    seen: set = set()
    missing_required: List[tuple] = []  # (app name, dot path)

    for index, entry in enumerate(apps):
        if not isinstance(entry, dict):
            raise GitopsEmitterError(
                f"apps[{index}] must be a mapping, got {type(entry).__name__}"
            )
        name = entry.get("name")
        if not isinstance(name, str) or not _NAME_PATTERN.match(name):
            raise GitopsEmitterError(
                f"apps[{index}].name {name!r} is not a DNS-1123 label "
                "(lowercase alphanumerics and hyphens, must start/end alphanumeric)"
            )
        if name in seen:
            raise GitopsEmitterError(
                f"duplicate app name {name!r}: apps[].name must be unique "
                "within hermes-gitops.yaml"
            )
        seen.add(name)

        chart = entry.get("chart")
        if not isinstance(chart, str) or not chart:
            raise GitopsEmitterError(f"app {name!r}: chart must be a non-empty string")

        repo = entry.get("repo")
        version = entry.get("version")
        if repo == LOCAL_REPO:
            if version is not None:
                raise GitopsEmitterError(
                    f"app {name!r}: version is not allowed with repo: local — "
                    "local charts ship with the platform/GitOps repo and "
                    "version with the platform revision"
                )
        elif isinstance(repo, str) and repo.startswith(_REMOTE_REPO_SCHEMES):
            if not isinstance(version, str) or not version:
                raise GitopsEmitterError(
                    f"app {name!r}: version is required for remote repo "
                    f"{repo!r} (deterministic deploys need a pinned chart version)"
                )
        else:
            raise GitopsEmitterError(
                f"app {name!r}: repo {repo!r} must be 'local' or start with "
                "https:// or oci://"
            )

        author_values = entry.get("values") or {}
        if not isinstance(author_values, dict):
            raise GitopsEmitterError(
                f"app {name!r}: values must be a mapping, got "
                f"{type(author_values).__name__}"
            )
        override_fragment = app_values.get(name) or {}
        if not isinstance(override_fragment, dict):
            raise GitopsEmitterError(
                f"appValues.{name} must be a mapping (a chart-values fragment), "
                f"got {type(override_fragment).__name__}"
            )
        merged_values = deep_merge(author_values, override_fragment)

        values_required = entry.get("valuesRequired") or []
        if not isinstance(values_required, list) or not all(
            isinstance(path, str) and path for path in values_required
        ):
            raise GitopsEmitterError(
                f"app {name!r}: valuesRequired must be a list of non-empty "
                "dot-path strings"
            )
        for dot_path in values_required:
            if _resolve_dot_path(merged_values, dot_path) is None:
                missing_required.append((name, dot_path))

        record_entry: Dict[str, Any] = {"name": name, "chart": chart, "repo": repo}
        if repo != LOCAL_REPO:
            record_entry["version"] = version
        if merged_values:
            record_entry["values"] = merged_values
        resolved.append(record_entry)

    # NOTE: appValues entries naming apps this profile does NOT declare are
    # deliberately ignored (not an error): fleet defaults are one file
    # shared across every persona, so they may legitimately carry
    # appValues for apps only some personas declare. A typo'd app name in
    # an override that was meant to satisfy a valuesRequired path still
    # fails loudly below — the required path stays unresolved.

    if missing_required:
        lines = [
            f"  - app {app!r} is missing required value {path!r}; supply it with: "
            f"python -m gitops_emitter.overrides_cli set {persona} <overrides-file> "
            f"where the file contains appValues.{app}.{path} "
            f"(or pulumi config set --path "
            f"'agents[<i>].overrides.appValues.{app}.{path}' <value> "
            "and re-run pulumi up)"
            for app, path in missing_required
        ]
        raise GitopsEmitterError(
            "valuesRequired not satisfied — after merging author values + fleet "
            "defaults + per-instance overrides, the following dot-paths still "
            "resolve to nothing (or null); the install fails BEFORE any manifest "
            "is generated:\n" + "\n".join(lines)
        )

    return resolved


def build_record(
    name: str,
    hook_kwargs: Dict[str, Any],
    merged_ext: Dict[str, Any],
    env_requires: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Assemble the HermesProfile record, in fixed field order.

    The record is PLAIN HELM VALUES — a single top-level ``spec`` block,
    no apiVersion/kind/metadata wrapper. Its identity is the directory
    the caller writes it to (``profiles/<name>/profile.yaml``).

    ``name`` is the installed instance name — used for ``spec.persona``
    (identical to the directory name for v1).

    ``hook_kwargs`` is the raw profile_install/profile_update hook payload
    (snake_case keys: ``source_url``, ``ref``, ``sha``,
    ``distribution_version``, ...).

    ``merged_ext`` holds the already-merged, already-resolved extension
    blocks (``deployment``, ``expose``, ...) plus the RESOLVED apps list
    under ``"apps"`` (the output of ``resolve_apps`` — merged values
    inlined, ``valuesRequired`` already satisfied and dropped — not the
    raw hermes-gitops.yaml block).

    ``env_requires`` is the flat list of required env-var-name strings.

    Optional blocks absent from the inputs are omitted from the output
    entirely (never emitted as ``null`` or ``{}``/``[]``). Field order is
    fixed regardless of the insertion order of any input dict, which is
    what makes ``render_yaml`` deterministic.
    """
    spec: Dict[str, Any] = {
        "persona": name,
        "source": hook_kwargs["source_url"],
    }

    git_auth_secret_ref = merged_ext.get("gitAuthSecretRef")
    if git_auth_secret_ref:
        spec["gitAuthSecretRef"] = git_auth_secret_ref

    ref = hook_kwargs.get("ref")
    if ref:
        spec["ref"] = ref

    # Subdirectory of the source repo containing the distribution (the
    # fork's --subdir / #subdirectory= install form). The pod boot path
    # installs /tmp/dist/<sourceSubdir> from its clone; omitted for
    # root-layout sources.
    source_subdir = hook_kwargs.get("subdir")
    if source_subdir:
        spec["sourceSubdir"] = source_subdir

    spec["sha"] = hook_kwargs["sha"]

    distribution_version = hook_kwargs.get("distribution_version")
    if distribution_version:
        spec["distributionVersion"] = distribution_version

    # spec.targetCluster is NOT emitted: v1alpha2 removed it (#132), and
    # its successor is NOT a record field (#176, ADR-33) - placement is
    # the environment's decision. The profile declares what it supports
    # (topology.supportedLayouts / agent.multiplicity); environment/
    # topology.yaml places instances onto targets; the topology compiler
    # emits argoDestination per instance record and the per-instance
    # ApplicationSets read it (TOPO017 joins destinations against the
    # registered targetClusters[]). The environment-side registration
    # (config.ts TargetClusterSpec, argocd/index.ts) is that model's
    # input, not a vestige.

    deployment = merged_ext.get("deployment")
    if deployment:
        spec["deployment"] = _ordered(deployment, _DEPLOYMENT_FIELD_ORDER)

    apps = merged_ext.get("apps")
    if apps:
        spec["apps"] = [_ordered(app, _APP_FIELD_ORDER) for app in apps]

    # spec.reach is NOT emitted: v1alpha2 removed it (#132). Its only key
    # was `regions`, which nothing read.

    if env_requires:
        # Entries carry their metadata now (#141, v1alpha3). A bare string
        # is still accepted and normalised here as well as in the
        # extractor: this function is called directly by tests, by the
        # local render harness and by anything reconstructing a record,
        # and a caller holding names should not have to know the richer
        # shape to produce a valid one.
        #
        # A shallow copy per entry, never the caller's dicts: build_record
        # does not hand back a structure that aliases its inputs.
        spec["envRequires"] = [
            {"name": e, "required": True, "secret": True} if isinstance(e, str) else dict(e)
            for e in env_requires
        ]

    expose = merged_ext.get("expose")
    if expose:
        ordered_expose = _ordered(expose, _EXPOSE_FIELD_ORDER)
        if "services" in ordered_expose:
            # "http" is reserved for the agent API port (8642, hardcoded
            # in harness/hermes/charts/hermes-profile/templates/pod/service.yaml) - the
            # chart's own hermes.exposeServiceNamesGuard (_helpers.tpl)
            # already rejects it, but only at `helm template`/ArgoCD sync
            # time, which surfaces as a Degraded Application well after
            # `hermes profile install` already pushed the (invalid)
            # record. Reject it HERE too, so the operator gets a readable
            # error at install time instead of a later ArgoCD sync
            # failure - see tests/test_render.py for the regression test.
            for service in ordered_expose["services"]:
                if service.get("name") == "http":
                    raise GitopsEmitterError(
                        "spec.expose.services[].name='http' is reserved for "
                        "the agent API port (8642); choose a different name"
                    )
            ordered_expose["services"] = [
                _ordered(service, _EXPOSE_SERVICE_FIELD_ORDER)
                for service in ordered_expose["services"]
            ]
        if "access" in ordered_expose:
            ordered_expose["access"] = _ordered(
                ordered_expose["access"], _EXPOSE_ACCESS_FIELD_ORDER
            )
        spec["expose"] = ordered_expose

    # Backup intent (schedule + retention only — the destination is a
    # platform concern, configured in cluster-values, never here).
    backup = merged_ext.get("backup")
    if backup:
        spec["backup"] = _ordered(backup, _BACKUP_FIELD_ORDER)

    return {"spec": spec}


def _sort_mapping_keys(value: Any) -> Any:
    """Recursively key-sort every mapping in *value* (lists keep their
    element order; only dict keys are sorted). Used to canonicalize
    ``apps[].values`` before dumping."""
    if isinstance(value, dict):
        return {key: _sort_mapping_keys(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_sort_mapping_keys(item) for item in value]
    return value


def _canonicalize_for_dump(record: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of ``record`` with the order-insensitive fields sorted.

    ``reach.regions`` and ``envRequires`` are sets in all but name — sort them
    alphabetically so two logically-identical records always render
    byte-identical YAML. Each ``apps[].values`` mapping is key-sorted
    recursively for the same reason (helm values are order-insensitive,
    and the merged dict's insertion order depends on which layer
    contributed which key). ``apps`` (the list itself) and
    ``expose.services`` are NOT reordered: their order is author-semantic
    and must be preserved as given.
    """
    record = dict(record)
    spec = dict(record.get("spec", {}))

    apps = spec.get("apps")
    if isinstance(apps, list):
        canonical_apps = []
        for app in apps:
            app = dict(app)
            if isinstance(app.get("values"), dict):
                app["values"] = _sort_mapping_keys(app["values"])
            canonical_apps.append(app)
        spec["apps"] = canonical_apps

    reach = spec.get("reach")
    if isinstance(reach, dict) and "regions" in reach:
        reach = dict(reach)
        reach["regions"] = sorted(reach["regions"])
        spec["reach"] = reach

    if "envRequires" in spec:
        # Sorted BY NAME rather than by value: the entries are mappings
        # now, and a set-like field still has to serialise deterministically
        # or every re-emit is a spurious diff.
        spec["envRequires"] = sorted(
            spec["envRequires"],
            key=lambda e: e["name"] if isinstance(e, dict) else str(e),
        )

    record["spec"] = spec
    return record


def render_yaml(record: Dict[str, Any]) -> str:
    """Serialize a HermesProfile record to its canonical YAML text.

    Same logical input always produces byte-identical output: field order
    comes from ``build_record``, order-insensitive collections
    (``reach.regions``, ``envRequires``, each ``apps[].values`` mapping's
    keys) are sorted here, order-sensitive ones (``apps``,
    ``expose.services``) are left as given, and the result always ends in
    exactly one trailing newline. No timestamps or other
    non-deterministic content is ever included.

    ``width=4096`` is set explicitly (PyYAML's default is 80) so a long
    scalar value — a long source URL, a future free-text field — is never
    line-folded. Folding is harmless to re-parse but would make two
    logically-identical records with differently-long values diverge from
    the "one field, one line" shape every other field in this document
    has, which is worth avoiding even though no field emitted by
    ``build_record`` today is long enough to trigger it.
    """
    canonical = _canonicalize_for_dump(record)
    text = yaml.safe_dump(
        canonical,
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
        width=4096,
    )
    return text.rstrip("\n") + "\n"


def validate(record: Dict[str, Any]) -> None:
    """Validate ``record`` against the vendored HermesProfile v1alpha1 schema.

    Raises ``GitopsEmitterError`` with a readable message on any violation.
    ``jsonschema`` is a soft runtime dependency: if it isn't installed,
    validation is skipped silently (the test suite always has it installed).
    """
    if jsonschema is None:  # pragma: no cover - exercised only without the dep
        return

    schema = _load_schema()
    try:
        jsonschema.validate(instance=record, schema=schema)
    except jsonschema.exceptions.ValidationError as exc:
        path = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        raise GitopsEmitterError(
            f"HermesProfile schema validation failed at {path}: {exc.message}"
        ) from exc


_DASH_SCHEMA_CACHE: Dict[str, Dict[str, Any]] = {}


# The FULL apiVersion string is the allowlist key - dispatching on a
# suffix would let `other.vendor/v1alpha2` (or a bare `v1alpha2`) slip
# through the refusal when the optional jsonschema dependency is absent.
_DASH_API_VERSIONS = {
    "dashboard.hermes-gitops/v1alpha1": "v1alpha1",
    "dashboard.hermes-gitops/v1alpha2": "v1alpha2",
}


def _load_dashboard_schema(kind: str, version: str) -> Dict[str, Any]:
    """Load (and cache) a dashboard-contribution schema by authored
    ``kind`` (``NexusContribution`` | ``NexusView``) and version
    directory, with the same packaged-then-canonical resolution as
    ``_load_schema``."""
    names = {
        "NexusContribution": ("dashboard-contribution", "contribution.schema.json"),
        "NexusView": ("dashboard-view", "view.schema.json"),
    }
    key = f"{kind}/{version}"
    if key not in _DASH_SCHEMA_CACHE:
        packaged_prefix, canonical_name = names[kind]
        packaged = resources.files(__package__).joinpath(
            "schema", f"{packaged_prefix}-{version}.schema.json"
        )
        if packaged.is_file():
            schema_text = packaged.read_text(encoding="utf-8")
        else:
            canonical = (
                SCHEMAS_ROOT
                / "dashboard-contribution"
                / version
                / canonical_name
            )
            schema_text = canonical.read_text(encoding="utf-8")
        _DASH_SCHEMA_CACHE[key] = json.loads(schema_text)
    return _DASH_SCHEMA_CACHE[key]


def validate_dashboard_file(rel_path: str, mapping: Any) -> None:
    """Validate one authored Nexus dashboard file (ADR-42) against its
    published schema, dispatched on the authored ``kind`` and
    ``apiVersion`` (v1alpha1 or v1alpha2 - the ADR-43 links widening).

    The emitter interprets NO dashboard semantics - this is the whole
    check: a mapping, a known kind, a known version, schema validity.
    Same soft-dependency contract as ``validate()``: without
    ``jsonschema`` the schema step is skipped (the kind and version
    allowlists still apply).
    """
    if not isinstance(mapping, dict):
        raise GitopsEmitterError(f"{rel_path}: not a YAML mapping")
    kind = mapping.get("kind")
    if kind not in ("NexusContribution", "NexusView"):
        raise GitopsEmitterError(
            f"{rel_path}: kind must be NexusContribution or NexusView, got {kind!r}"
        )
    api_version = mapping.get("apiVersion")
    version = _DASH_API_VERSIONS.get(api_version) if isinstance(api_version, str) else None
    if version is None:
        raise GitopsEmitterError(
            f"{rel_path}: apiVersion must be one of "
            f"{sorted(_DASH_API_VERSIONS)}, got {api_version!r}"
        )
    if jsonschema is None:  # pragma: no cover - soft dependency
        return
    try:
        jsonschema.validate(instance=mapping, schema=_load_dashboard_schema(kind, version))
    except jsonschema.exceptions.ValidationError as exc:
        path = "/".join(str(part) for part in exc.absolute_path) or "<root>"
        raise GitopsEmitterError(
            f"{rel_path} ({kind}) schema validation failed at {path}: {exc.message}"
        ) from exc
