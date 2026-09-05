"""Side-effecting emit pipeline for gitops-emitter.

This module is the target of the ``emitter.emit()`` call made by the
profile_install / profile_update hook handlers in
``gitops_emitter/__init__.py``. It owns:

* loading this plugin's own config block (``plugins.entries.gitops-emitter``
  in the fork's ``~/.hermes/config.yaml``, via ``hermes_cli.config``);
* loading fleet-wide defaults and per-instance overrides;
* reading the installed profile's ``distribution.yaml`` and its
  ``GITOPS_GIT_TOKEN`` secret;
* orchestrating the pure render pipeline in ``render.py`` against all of
  the above; and
* handing the rendered YAML off to ``scaffold.py`` (create-if-missing repo
  + app-of-apps bootstrap) and ``gitrepo.py`` (commit + push).

``GitopsEmitterError`` lives in ``gitops_emitter.errors`` (re-exported
here for compatibility) so the generic modules never import from the
harness half; this module still imports all three of them at the bottom
of the file.
"""

from __future__ import annotations

import logging
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from ..errors import GitopsEmitterError

logger = logging.getLogger(__name__)

__all__ = [
    "GitopsEmitterError",
    "load_plugin_config",
    "load_defaults",
    "load_instance_overrides",
    "read_target_manifest",
    "required_secret_names",
    "read_git_token",
    "emit",
]



# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_KEY = "gitops-emitter"

_DEFAULT_BRANCH = "main"
_DEFAULT_PROFILES_PATH = "profiles"


def _hermes_home() -> Path:
    """The operating profile home — HERMES_HOME when set (the same
    isolation contract the whole bootstrap flow honors), else
    ``~/.hermes``."""
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def default_defaults_file() -> str:
    """Default fleet-defaults path, anchored at the operating profile
    home (issue #13 [E3] — single source for the plugin and the config
    CLI's seeding)."""
    return str(_hermes_home() / "gitops-emitter" / "defaults.yaml")


def default_overrides_dir() -> str:
    """Default per-instance overrides dir, anchored like
    ``default_defaults_file``."""
    return str(_hermes_home() / "gitops-emitter" / "overrides")
_DEFAULT_GIT_AUTHOR_NAME = "hermes-gitops-bot"
_DEFAULT_GIT_AUTHOR_EMAIL = "hg-bot@users.noreply.github.com"
# Mirrors infra/src/control-flow/config.ts's DEFAULT_CHART_REVISION
# and the image repository used in
# schemas/cluster-values/v1alpha1/examples/cluster-values-local.yaml, so an
# operator who hasn't set these explicitly gets the same fleet defaults
# bootstrap stage 3 assumes.
_DEFAULT_CHART_REVISION = "main"
_DEFAULT_IMAGE_REPOSITORY = "ghcr.io/factory-level/hermes-agent"
_DEFAULT_IMAGE_TAG = "latest"


def _load_hermes_config() -> Dict[str, Any]:
    """Seam around ``hermes_cli.config.load_config``.

    ``hermes_cli`` is importable only inside the fork's runtime, not in
    this repo's own test environment (see this package's README) — the
    import is deliberately lazy (inside the function body, not at module
    load time) so importing ``gitops_emitter`` never requires the fork to
    be installed. Tests monkeypatch this function directly
    (``monkeypatch.setattr(emitter, "_load_hermes_config", ...)``) rather
    than faking ``sys.modules["hermes_cli"]``.
    """
    from hermes_cli.config import load_config  # noqa: PLC0415

    return load_config() or {}


CONFIG_SOURCE_ENV = "HERMES_GITOPS_CONFIG_SOURCE"
CONFIG_JSON_ENV = "HERMES_GITOPS_CONFIG_JSON"


def load_plugin_config() -> Dict[str, Any]:
    """Load and validate this plugin's config block.

    Three sources, the first that applies wins; the resolved shape is the
    same whichever supplied it (``normalize_plugin_entry``):

    - ``HERMES_GITOPS_CONFIG_JSON=<path>``: a JSON file holding the entry.
    - ``HERMES_GITOPS_CONFIG_SOURCE=env``: the entry is built from the
      ``HERMES_GITOPS_*`` variables ``config_cli`` already defines - the
      same variables the bootstrap sets when it writes config.yaml. This is
      how a host with NO Hermes (an Eve-only deploy, ADR-149) configures
      every CLI in this package without ``$HERMES_HOME/config.yaml``.
    - otherwise ``plugins.entries.gitops-emitter`` from the fork's
      ``config.yaml`` (see ``_load_hermes_config``).

    ``repo_url`` has no default — a plugin that's enabled but not
    configured with a target repo is a misconfiguration, not "do nothing
    quietly", so it raises ``GitopsEmitterError`` rather than silently
    no-op'ing an install.
    """
    json_path = os.environ.get(CONFIG_JSON_ENV)
    if json_path:
        try:
            entry = json.loads(Path(json_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise GitopsEmitterError(
                f"gitops-emitter: {CONFIG_JSON_ENV}={json_path} is not a readable JSON file: {exc}"
            ) from exc
        return normalize_plugin_entry(entry)
    source = os.environ.get(CONFIG_SOURCE_ENV)
    if source == "env":
        return load_plugin_config_from_env(dict(os.environ))
    if source not in (None, "", "hermes"):
        # An explicit but unrecognized source must not fall through to the
        # Hermes config.yaml - on an Eve-only host that import fails with a
        # traceback instead of this message.
        raise GitopsEmitterError(
            f"gitops-emitter: {CONFIG_SOURCE_ENV}={source!r} is not a recognized config source "
            "(env | hermes; or set HERMES_GITOPS_CONFIG_JSON to a file)"
        )
    try:
        cfg = _load_hermes_config()
    except ImportError as exc:
        raise GitopsEmitterError(
            "gitops-emitter: no Hermes installation to read config.yaml from (hermes_cli is not "
            f"importable) - on a host without Hermes set {CONFIG_SOURCE_ENV}=env with the "
            f"HERMES_GITOPS_* variables, or {CONFIG_JSON_ENV}=<file>"
        ) from exc
    entries = (cfg.get("plugins") or {}).get("entries") or {}
    return normalize_plugin_entry(entries.get(CONFIG_KEY) or {})


def load_plugin_config_from_env(env: Dict[str, str]) -> Dict[str, Any]:
    """The plugin config from the ``HERMES_GITOPS_*`` environment contract
    (``config_cli.desired_entry_from_env``), normalized. Pure."""
    from ..config_cli import ConfigCliError, desired_entry_from_env  # noqa: PLC0415

    try:
        entry = desired_entry_from_env(env)
    except ConfigCliError as exc:
        raise GitopsEmitterError(str(exc)) from exc
    return normalize_plugin_entry(entry)


def normalize_plugin_entry(entry: Any) -> Dict[str, Any]:
    """Validate a raw ``plugins.entries.gitops-emitter`` mapping and fill in
    defaults for every optional field. Pure - the one place the resolved
    config shape is defined, whichever source supplied the entry."""
    if not isinstance(entry, dict):
        raise GitopsEmitterError(
            f"gitops-emitter: plugins.entries.{CONFIG_KEY} must be a mapping "
            f"in config.yaml, got {type(entry).__name__}"
        )

    repo_url = entry.get("repo_url")
    if not repo_url:
        raise GitopsEmitterError(
            f"gitops-emitter: plugins.entries.{CONFIG_KEY}.repo_url is required "
            "in config.yaml (no default) — set it to your GitOps repo's clone "
            "URL, e.g. https://github.com/<org>/<gitops-repo>."
        )

    mode = entry.get("mode") or "direct"
    if mode not in ("direct", "pr"):
        raise GitopsEmitterError(
            f"gitops-emitter: plugins.entries.{CONFIG_KEY}.mode must be "
            f"'direct' or 'pr', got {mode!r}"
        )

    return {
        "repo_url": repo_url,
        # PR flow (issue #17 [F1], GitHub-only by decision): 'direct'
        # commits straight to the tracked branch (today's behavior);
        # 'pr' pushes each change to a stable per-persona head branch
        # (hermes-gitops/<name>) and opens a pull request into `branch`.
        # pr_auto_merge (default true - the resolved bootstrap posture,
        # so a non-interactive `pulumi up` completes) merges it
        # immediately; set false for a human review gate.
        "mode": mode,
        "pr_auto_merge": bool(entry.get("pr_auto_merge", True)),
        # The explicit escape hatch (ADR-2, #140). Replaces a carve-out
        # that silently downgraded `pr` to `direct` for install events -
        # an exception keyed on event type, invisible exactly where it
        # mattered. Default OFF: a bootstrap that wants it sets it
        # deliberately, sees it in `pulumi preview`, and reads it in the
        # log on every use.
        #
        # #179 adds server-side branch protection, which makes a direct
        # push IMPOSSIBLE rather than merely discouraged. When that is on
        # and this is set, the push fails loudly - which is the point:
        # a flag that silently no-ops would be worse than the carve-out
        # it replaced.
        "allow_direct_commit": bool(entry.get("allow_direct_commit", False)),
        "branch": entry.get("branch") or _DEFAULT_BRANCH,
        "profiles_path": (entry.get("profiles_path") or _DEFAULT_PROFILES_PATH).strip("/"),
        "defaults_file": entry.get("defaults_file") or default_defaults_file(),
        "overrides_dir": entry.get("overrides_dir") or default_overrides_dir(),
        "git_author_name": entry.get("git_author_name") or _DEFAULT_GIT_AUTHOR_NAME,
        "git_author_email": entry.get("git_author_email") or _DEFAULT_GIT_AUTHOR_EMAIL,
        "scaffold": bool(entry.get("scaffold", True)),
        "hermes_gitops_repo_url": entry.get("hermes_gitops_repo_url") or "",
        "chart_revision": entry.get("chart_revision") or _DEFAULT_CHART_REVISION,
        "image_repository": entry.get("image_repository") or _DEFAULT_IMAGE_REPOSITORY,
        "image_tag": entry.get("image_tag") or _DEFAULT_IMAGE_TAG,
    }


def _load_yaml_mapping(path: Path, *, label: str) -> Dict[str, Any]:
    """Read and parse *path* as a YAML mapping. Missing file -> ``{}``."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise GitopsEmitterError(f"gitops-emitter: failed to read {label} at {path}: {exc}") from exc

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise GitopsEmitterError(f"gitops-emitter: failed to parse {label} at {path}: {exc}") from exc

    if data is None:
        return {}
    if not isinstance(data, dict):
        raise GitopsEmitterError(
            f"gitops-emitter: {label} at {path} must be a YAML mapping, got {type(data).__name__}"
        )
    return data


def load_defaults(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Load the fleet-wide defaults YAML (``cfg["defaults_file"]``).

    Missing file -> ``{}`` (defaults are optional; nothing forces an
    operator to author one).
    """
    path = Path(cfg["defaults_file"]).expanduser()
    return _load_yaml_mapping(path, label="defaults file")


# --- Override files are a regenerable cache (ADR-4, #180) ----------------
#
# ADR-4 decided that Pulumi stack configuration is the ONLY environment
# authority and that the files under HERMES_HOME are a cache of it. The
# code still let those files be hand-authored and reused, which quietly
# created a second authority for the same decisions - an operator edits
# one, it shapes every later record, and the stack config that is supposed
# to be authoritative says something else.
#
# Every file the tooling writes now carries a provenance header. A file
# WITHOUT one was not written by any tool that has a stack behind it, so
# reading it would be exactly the second authority ADR-4 rules out - and
# it fails loudly, naming the stack key to set instead.
#
# A comment rather than a data key: `yaml.safe_load` ignores it, so the
# merged record is unaffected and a pre-existing file's CONTENT still
# round-trips byte-identically once re-stamped. It also tells a human who
# opens the file what wrote it.

_PROVENANCE_PREFIX = "# gitops-emitter:written-by "


def _provenance_header(source: str) -> str:
    return (
        f"{_PROVENANCE_PREFIX}{source}\n"
        "# This file is a CACHE, regenerated from the environment authority.\n"
        "# Editing it by hand is not an authoring path (ADR-4): author the\n"
        "# values in the Pulumi stack's agents[].overrides instead, or use\n"
        "# `python -m gitops_emitter.overrides_cli set <name> <file>`.\n"
    )


def _provenance_of(text: str) -> Optional[str]:
    """The recorded writer, or ``None`` for a file no tool stamped."""
    for line in text.splitlines():
        if line.startswith(_PROVENANCE_PREFIX):
            return line[len(_PROVENANCE_PREFIX) :].strip() or None
        if line.strip() and not line.lstrip().startswith("#"):
            # Content before any stamp: the header is only ever at the top.
            return None
    return None


def load_instance_overrides(name: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Load per-instance overrides for persona *name*.

    Contract (issue #11 [E2] adds the declared-absent case):

    * ``HERMES_GITOPS_OVERRIDES`` env var set -> load that YAML file AND
      persist a byte-identical copy to
      ``<overrides_dir>/<name>.yaml`` (so a later ``hermes profile update``
      run, made without the env var set, still finds and reuses it).
    * ``HERMES_GITOPS_OVERRIDES_CLEAR`` truthy (and ``HERMES_GITOPS_OVERRIDES``
      unset) -> the caller DECLARES this persona has no overrides: delete
      the persisted copy if present and return ``{}``. This is how a
      removed ``agents[].overrides`` in the Pulumi stack
      actually clears the sticky file on the next apply, instead of the
      last-written copy silently shaping every later update.
    * neither env var -> use the persisted copy at
      ``<overrides_dir>/<name>.yaml`` if present, else ``{}`` (unchanged
      backward-compatible reuse for plain ``hermes profile update`` runs
      outside Pulumi).

    ``python -m gitops_emitter.overrides_cli`` provides the explicit
    get/list/set/unset lifecycle over the same persisted files.
    """
    overrides_dir = Path(cfg["overrides_dir"]).expanduser()
    persisted_path = overrides_dir / f"{name}.yaml"

    if not os.environ.get("HERMES_GITOPS_OVERRIDES") and os.environ.get(
        "HERMES_GITOPS_OVERRIDES_CLEAR"
    ):
        if persisted_path.is_file():
            persisted_path.unlink()
            logger.info(
                "gitops-emitter: cleared persisted overrides for %s (declared absent)",
                name,
            )
        return {}

    env_path = os.environ.get("HERMES_GITOPS_OVERRIDES")
    if env_path:
        source = Path(env_path).expanduser()
        try:
            text = source.read_text(encoding="utf-8")
        except OSError as exc:
            raise GitopsEmitterError(
                f"gitops-emitter: failed to read HERMES_GITOPS_OVERRIDES file {source}: {exc}"
            ) from exc

        try:
            data = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise GitopsEmitterError(
                f"gitops-emitter: failed to parse HERMES_GITOPS_OVERRIDES file {source}: {exc}"
            ) from exc
        data = data or {}
        if not isinstance(data, dict):
            raise GitopsEmitterError(
                f"gitops-emitter: HERMES_GITOPS_OVERRIDES file {source} must be a YAML mapping, "
                f"got {type(data).__name__}"
            )

        try:
            overrides_dir.mkdir(parents=True, exist_ok=True)
            # Stamped as ours: this copy came from the environment
            # authority via HERMES_GITOPS_OVERRIDES, which is what makes
            # it a legitimate cache rather than a second opinion.
            persisted_path.write_text(
                _provenance_header("pulumi") + text, encoding="utf-8"
            )
        except OSError as exc:
            raise GitopsEmitterError(
                f"gitops-emitter: failed to persist a copy of the overrides to "
                f"{persisted_path}: {exc}"
            ) from exc

        return data

    if not persisted_path.is_file():
        return {}

    try:
        persisted_text = persisted_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise GitopsEmitterError(
            f"gitops-emitter: failed to read persisted overrides file {persisted_path}: {exc}"
        ) from exc

    if _provenance_of(persisted_text) is None:
        raise GitopsEmitterError(
            f"gitops-emitter: {persisted_path} was not written by this tooling.\n\n"
            "Override files under HERMES_HOME are a regenerable CACHE of the "
            "environment authority, never an authoring surface (ADR-4) - a "
            "hand-authored one is a second authority for decisions the Pulumi "
            "stack already owns, and it would silently shape every record from "
            "here on.\n\n"
            f"Author these values in the stack's `agents[]` entry for {name!r}, "
            "under `overrides`, and re-run - or, for a deliberate local-only "
            f"change outside Pulumi, `python -m gitops_emitter.overrides_cli set {name} <file>`.\n\n"
            f"To discard it: rm {persisted_path}"
        )

    return _load_yaml_mapping(persisted_path, label="persisted overrides file")


def read_target_manifest(target_dir: str) -> Dict[str, Any]:
    """Read the raw ``distribution.yaml`` dict from an installed profile.

    Raw, not the fork's parsed ``DistributionManifest`` dataclass — this
    plugin only cares about ``env_requires`` (the infra intent lives in
    hermes-gitops.yaml, read separately by ``load_extension_file``), and
    reading the file directly avoids depending on
    ``hermes_cli.profile_distribution`` (which isn't importable in this
    repo's test env either).
    """
    path = Path(target_dir) / "distribution.yaml"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise GitopsEmitterError(
            f"gitops-emitter: failed to read distribution.yaml from the installed "
            f"profile's target_dir: {exc}"
        ) from exc

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise GitopsEmitterError(f"gitops-emitter: failed to parse distribution.yaml: {exc}") from exc

    if not isinstance(data, dict):
        raise GitopsEmitterError(
            f"gitops-emitter: distribution.yaml must be a YAML mapping, got {type(data).__name__}"
        )
    return data


def _extract_env_requires(manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract env-var declarations from a raw ``distribution.yaml``,
    KEEPING their metadata (#141, record schema v1alpha3).

    This used to return a flat list of names. `distribution.yaml` declares
    each variable with a description and a `required` flag, and the record
    stored neither — so optionality, purpose and the secret-versus-config
    distinction were all discarded at the one point they could have been
    written down. Those are exactly the three facts the capability model
    (#171) and the secret lifecycle (#149) need in order to tell a
    credential from a setting, or a mandatory variable from an optional
    one. Design 03 states it positively: **a declaration carries its
    metadata**.

    Accepts both shapes the fork's ``EnvRequirement`` implies are
    legitimate — a bare name string, and a
    ``{name, description, required, default}`` mapping — because we read
    the raw YAML ourselves and so do not get the fork's validation for
    free.

    Returns one normalised mapping per entry, always carrying ``name``,
    ``required`` and ``secret``; ``description`` only when the declaration
    had one, because inventing a description is worse than having none.

    Two defaults, both deliberately conservative:

    * **``required`` absent means TRUE**, matching the fork's own default.
      An entry that says nothing is mandatory.
    * **``secret`` absent means TRUE.** `distribution.yaml` has no such
      field today, so every existing declaration resolves to a secret.
      That is the safe direction: treating a setting as a secret costs an
      ExternalSecret, while treating a secret as config puts its value in
      a rendered manifest.
    """
    raw = manifest.get("env_requires") or []
    if not isinstance(raw, list):
        raise GitopsEmitterError("gitops-emitter: distribution.yaml env_requires must be a list")

    out: List[Dict[str, Any]] = []
    for entry in raw:
        if isinstance(entry, str):
            if entry:
                out.append({"name": entry, "required": True, "secret": True})
        elif isinstance(entry, dict):
            name = entry.get("name")
            if not name:
                raise GitopsEmitterError(
                    "gitops-emitter: distribution.yaml env_requires entry missing 'name'"
                )
            resolved: Dict[str, Any] = {
                "name": str(name),
                "required": bool(entry.get("required", True)),
                "secret": bool(entry.get("secret", True)),
            }
            description = entry.get("description")
            if isinstance(description, str) and description.strip():
                resolved["description"] = description.strip()
            out.append(resolved)
        else:
            raise GitopsEmitterError(
                "gitops-emitter: distribution.yaml env_requires entry must be a string "
                f"or mapping, got {type(entry).__name__}"
            )
    return out


def required_secret_names(env_requires: List[Dict[str, Any]]) -> List[str]:
    """The names that must be present for an install to proceed.

    Required AND secret. A `required: false` variable (an optional API
    key, a dashboard URL) must never fail an install for being unset, and
    a non-secret one is configuration that has no business in the
    fail-loud secret check at all — that second filter is new with the
    `secret` flag, and it is the point of carrying it.
    """
    return [e["name"] for e in env_requires if e["required"] and e["secret"]]


def read_git_token(target_dir: str) -> str:
    """Read ``GITOPS_GIT_TOKEN`` from the installed profile's ``.env``.

    ``<target_dir>/.env`` first (via ``python-dotenv``'s ``dotenv_values``,
    which parses without mutating ``os.environ``), falling back to the
    process environment. Missing/empty in both places is a fatal
    misconfiguration — gitops-emitter cannot push or scaffold without it.
    """
    from dotenv import dotenv_values  # noqa: PLC0415 - keep import local to this seam

    env_path = Path(target_dir) / ".env"
    values: Dict[str, Optional[str]] = dotenv_values(str(env_path)) if env_path.is_file() else {}
    token = values.get("GITOPS_GIT_TOKEN") or os.environ.get("GITOPS_GIT_TOKEN")
    if not token:
        raise GitopsEmitterError(
            "gitops-emitter: GITOPS_GIT_TOKEN not found in the profile's .env or "
            "the process environment. Set it to a token with push access to the "
            "GitOps repo (and repository-creation scope if scaffold: true)."
        )
    return token


EXTENSION_FILE_RELPATH = Path("hermes-gitops.yaml")


def _agent_declaration(
    root: Path, contract_dir: Optional[str], source_subdir: Optional[str] = None
) -> Tuple[Optional[Dict[str, Any]], Optional[Path]]:
    """The agent-team layout's fold (ADR 0178), or (None, None) for legacy.
    LayoutError becomes this module's error type at the boundary."""
    try:
        return layout.load_agent_declaration(Path(root), contract_dir, source_subdir)
    except layout.LayoutError as exc:
        raise GitopsEmitterError(str(exc)) from exc


def load_extension_file(
    root: Path, contract_dir: Optional[str] = None, source_subdir: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Read ``<root>/hermes-gitops.yaml`` — the ONE carrier of a profile's
    infra intent (schema published at
    agent-bundle-contracts/hermes-gitops-extension/v1alpha1/). *root* is the
    DISTRIBUTION root: the file sits BESIDE distribution.yaml — the repo
    root for root-layout repos, the subdirectory (e.g.
    ``.hermes-dist/<name>/``) for subdir-layout repos, and the profile
    root once installed (the fork stages the subtree as the payload
    root). Returns ``None`` when the file doesn't exist — that is NOT an
    error: the profile simply declares no infra intent (the agent pod
    still renders; zero apps). distribution.yaml stays pure Hermes — the
    old embedded-extension-blocks fallback (and its source-re-fetch
    workaround for the fork's manifest rewrite) is gone.

    Unknown keys fail loudly: unlike distribution.yaml (a larger manifest
    this plugin only reads ``env_requires`` from), this file exists ONLY to
    carry the extension, so an unrecognized key is a typo that would
    otherwise be silently dropped from the rendered record — exactly what
    the fail-fast contract forbids. Value-shape validation happens
    downstream, where it already lives: render.resolve_apps rejects bad
    ``apps`` entries pre-render, and render.validate() rejects a bad
    record against the profile schema.
    """
    # Agent-team layout (ADR 0178): the split files fold into the same raw
    # shape and go through the same version dispatch below, so a migrated
    # profile renders the record its legacy file would have.
    folded, _agent_file = _agent_declaration(root, contract_dir, source_subdir)
    if folded is not None:
        mapping = folded
    else:
        path = root / EXTENSION_FILE_RELPATH
        if not path.is_file():
            return None
        mapping = _load_yaml_mapping(path, label=str(EXTENSION_FILE_RELPATH))
    if "contractVersion" in mapping:
        # Contract v2/v3 (ADR-33): the marker's VALUE selects the schema
        # (a marked file can never validate as v1 - the v1 schema admits
        # no unknown key, so no file is valid under both). Validate the
        # WHOLE file, then strip the versioned keys: their consumers are
        # the topology compiler and event router in the hg CLI, and the
        # record pipeline below stays byte-for-byte v1 - the agent
        # runtime contract (including its gateway) is untouched by the
        # communication plane.
        version = mapping.get("contractVersion")
        if version == 5:
            unknown = [key for key in mapping if key not in EXTENSION_KEYS_V5]
            if unknown:
                raise GitopsEmitterError(
                    f"{EXTENSION_FILE_RELPATH}: unknown key(s) "
                    f"{', '.join(sorted(unknown))} "
                    f"(allowed: {', '.join(EXTENSION_KEYS_V5)}) "
                    "- unknown keys would be silently dropped from the "
                    "rendered record, so packaging fails here instead"
                )
            validate_extension_v5(mapping)
            runtime = mapping.get("runtime")
            if isinstance(runtime, dict) and runtime.get("kind") == "eve":
                # This pipeline renders the HERMES record. An Eve project
                # reaching it means someone ran `hermes profile install`
                # on an agents/<name>/ directory - refuse rather than
                # emit a Hermes record for a runtime that cannot boot it.
                raise GitopsEmitterError(
                    f"{EXTENSION_FILE_RELPATH}: runtime.kind is eve - this "
                    "directory is an Eve project, not a Hermes profile. Emit "
                    "its record with `python -m gitops_emitter.emit_cli "
                    "--runtime eve` (Pulumi agents[].runtime: eve, or hg), "
                    "not with hermes profile install"
                )
            return strip_extension_v5(mapping)
        if version == 4:
            unknown = [key for key in mapping if key not in EXTENSION_KEYS_V4]
            if unknown:
                raise GitopsEmitterError(
                    f"{EXTENSION_FILE_RELPATH}: unknown key(s) "
                    f"{', '.join(sorted(unknown))} "
                    f"(allowed: {', '.join(EXTENSION_KEYS_V4)}) "
                    "- unknown keys would be silently dropped from the "
                    "rendered record, so packaging fails here instead"
                )
            validate_extension_v4(mapping)
            return strip_extension_v4(mapping)
        if version == 3:
            unknown = [key for key in mapping if key not in EXTENSION_KEYS_V3]
            if unknown:
                raise GitopsEmitterError(
                    f"{EXTENSION_FILE_RELPATH}: unknown key(s) "
                    f"{', '.join(sorted(unknown))} "
                    f"(allowed: {', '.join(EXTENSION_KEYS_V3)}) "
                    "- unknown keys would be silently dropped from the "
                    "rendered record, so packaging fails here instead"
                )
            validate_extension_v3(mapping)
            return strip_extension_v3(mapping)
        if version != 2:
            raise GitopsEmitterError(
                f"{EXTENSION_FILE_RELPATH}: unsupported contractVersion "
                f"{version!r} (supported: 2, 3, 4, 5)"
            )
        unknown = [key for key in mapping if key not in EXTENSION_KEYS_V2]
        if unknown:
            raise GitopsEmitterError(
                f"{EXTENSION_FILE_RELPATH}: unknown key(s) "
                f"{', '.join(sorted(unknown))} "
                f"(allowed: {', '.join(EXTENSION_KEYS_V2)}) "
                "- unknown keys would be silently dropped from the rendered "
                "record, so packaging fails here instead"
            )
        validate_extension_v2(mapping)
        return strip_extension_v2(mapping)
    unknown = [key for key in mapping if key not in EXTENSION_KEYS]
    if unknown:
        raise GitopsEmitterError(
            f"{EXTENSION_FILE_RELPATH}: unknown key(s) "
            f"{', '.join(sorted(unknown))} (allowed: {', '.join(EXTENSION_KEYS)}) "
            "- unknown keys would be silently dropped from the rendered "
            "record, so packaging fails here instead"
        )
    return mapping


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def _check_required_secrets(name: str, env_requires: List[str]) -> None:
    """Fail-loud secret-presence check (issue #37 [K5], UX_TARGET point 3).

    Opt-in via ``HERMES_GITOPS_AVAILABLE_SECRETS_JSON`` — set by the infra
    program's per-agent install Commands to a JSON object
    ``{instanceName: ["ENV_VAR", ...]}`` naming which vars the Pulumi
    stack's ``agentSecrets`` config carries (names only, never values).
    When set, an agent whose distribution declares ``env_requires`` vars
    absent from the stack fails the install with a message naming each
    missing key and the exact ``pulumi config set`` command that fixes it
    — the failure propagates hermes -> Command -> ``pulumi up`` (same
    fail-loud chain as ``HERMES_GITOPS_REQUIRE_EMITTER``). Unset (plain
    ``hermes profile install`` outside Pulumi), the check is skipped —
    there is no stack to validate against.
    """
    raw = os.environ.get("HERMES_GITOPS_AVAILABLE_SECRETS_JSON")
    if raw is None or not env_requires:
        return
    try:
        available_map = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GitopsEmitterError(
            "gitops-emitter: HERMES_GITOPS_AVAILABLE_SECRETS_JSON is not valid JSON"
        ) from exc
    if not isinstance(available_map, dict):
        raise GitopsEmitterError(
            "gitops-emitter: HERMES_GITOPS_AVAILABLE_SECRETS_JSON must be a JSON "
            "object of {instanceName: [ENV_VAR, ...]}"
        )
    available = set(available_map.get(name) or [])
    missing = [var for var in env_requires if var not in available]
    if missing:
        fixes = "; ".join(
            f"pulumi config set --secret --path 'agentSecrets.{name}.{var}' <value>"
            for var in missing
        )
        raise GitopsEmitterError(
            f"agent {name!r} declares required secret(s) not present in the "
            f"Pulumi stack: {', '.join(missing)}. Set each with: {fixes} "
            f"(then re-run `pulumi up`)."
        )


_ICON_MAX_BYTES = 256 * 1024


def _validate_icon_asset(name: str, rel: str, suffix: str, data: bytes) -> None:
    """Design 12 repository-owned icons: bounded PNG/WebP only - no SVG
    (script risk), no remote URLs. Magic bytes decide, not the extension;
    a mislabeled file refuses loudly rather than shipping bytes the
    dashboard would serve with the wrong content type."""
    if suffix not in (".png", ".webp"):
        raise GitopsEmitterError(
            f"{name}: {rel}: icon assets must be .png or .webp; got "
            f"{suffix or 'no extension'}"
        )
    genuine = (
        data.startswith(b"\x89PNG\r\n\x1a\n")
        if suffix == ".png"
        else data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    )
    if not genuine:
        raise GitopsEmitterError(
            f"{name}: {rel}: content does not match its {suffix} extension - "
            "refusing to catalogue it"
        )
    if len(data) > _ICON_MAX_BYTES:
        raise GitopsEmitterError(
            f"{name}: {rel}: icon asset is {len(data)} bytes; the limit is "
            f"{_ICON_MAX_BYTES} - shrink the image"
        )


def _dashboard_catalogue_files(
    name: str, target_dir: Path, sha: str, contract_dir: Optional[Path] = None
) -> List[tuple]:
    """Nexus dashboard co-publish (ADR-42): the profile-owned dashboard/
    files from the installed payload, validated against their published
    v1alpha1 schemas and copied byte-for-byte into the dashboard
    catalogue, plus a hand-formatted provenance record (the ADR-34
    two-language byte-parity discipline). The emitter learns no dashboard
    semantics - the Nexus compiler is the only interpreter. That includes
    dashboard/icons/ image assets (design 12 repository-owned icons):
    bounded, magic-byte-checked, copied as opaque bytes - which filename
    maps to which component is the compiler's business.

    Only per-profile files exist in the payload; a repository-level
    dashboard/contribution.yaml never reaches an installed profile, so
    provenance paths here are payload-relative. Symlinks refuse loudly -
    a link inside dashboard/ could pull operator files into Git.
    """
    if contract_dir is not None:
        # Agent-team layout (ADR 0178): harness-hg/dashboard.yaml + harness-hg/icons/,
        # catalogued under the same tree with their own names; provenance
        # paths are relative to the agent directory (the contract's parent).
        return _team_dashboard_catalogue_files(name, contract_dir, sha)
    dash_dir = target_dir / "dashboard"
    if not dash_dir.is_dir():
        return []
    if dash_dir.is_symlink():
        raise GitopsEmitterError(f"{name}: dashboard/ is a symlink - refusing to catalogue it")
    files: List[tuple] = []
    rels: List[str] = []
    for p in sorted(dash_dir.rglob("*.yaml")):
        if not p.is_file():
            continue
        probe = p
        while probe != target_dir:
            if probe.is_symlink():
                raise GitopsEmitterError(
                    f"{name}: {p.relative_to(target_dir)} is (or sits under) a symlink - refusing to catalogue it"
                )
            probe = probe.parent
        # read_bytes(): CRLF byte parity, the contract.yaml discipline.
        raw = p.read_bytes().decode("utf-8")
        rel_payload = p.relative_to(target_dir).as_posix()
        validate_dashboard_file(rel_payload, yaml.safe_load(raw))
        rels.append(rel_payload)
        files.append((f"catalog/dashboard/sources/{name}/{p.relative_to(dash_dir).as_posix()}", raw))
    icons_dir = dash_dir / "icons"
    if icons_dir.is_dir():
        for p in sorted(icons_dir.iterdir()):
            if not p.is_file() and not p.is_symlink():
                continue
            probe = p
            while probe != target_dir:
                if probe.is_symlink():
                    raise GitopsEmitterError(
                        f"{name}: {p.relative_to(target_dir)} is (or sits under) a symlink - refusing to catalogue it"
                    )
                probe = probe.parent
            data = p.read_bytes()
            rel_payload = p.relative_to(target_dir).as_posix()
            _validate_icon_asset(name, rel_payload, p.suffix, data)
            rels.append(rel_payload)
            files.append(
                (f"catalog/dashboard/sources/{name}/{p.relative_to(dash_dir).as_posix()}", data)
            )
    if not files:
        return []
    paths_yaml = "".join(f"  - {rel}\n" for rel in rels)
    files.append(
        (
            f"catalog/dashboard/sources/{name}/provenance.yaml",
            f'sourceSha: "{sha}"\nsourcePaths:\n{paths_yaml}',
        )
    )
    return files


def _team_dashboard_catalogue_files(name: str, contract_dir: Path, sha: str) -> List[tuple]:
    dash, icons = layout.dashboard_files(contract_dir)
    agent_dir = contract_dir.parent

    def _refuse_links(p: Path) -> None:
        # Same discipline as the legacy tree: nothing on the path from the
        # agent dir down may be a symlink - a link could pull operator
        # files into Git.
        probe = p
        while probe != agent_dir and probe != probe.parent:
            if probe.is_symlink():
                raise GitopsEmitterError(
                    f"{name}: {p.relative_to(agent_dir)} is (or sits under) a symlink - refusing to catalogue it"
                )
            probe = probe.parent

    files: List[tuple] = []
    rels: List[str] = []
    for p in ([dash] if dash else []):
        _refuse_links(p)
        raw = p.read_bytes().decode("utf-8")
        rel_payload = p.relative_to(agent_dir).as_posix()
        validate_dashboard_file(rel_payload, yaml.safe_load(raw))
        rels.append(rel_payload)
        files.append((f"catalog/dashboard/sources/{name}/{p.name}", raw))
    if icons is not None:
        _refuse_links(icons)
        for p in sorted(icons.iterdir()):
            _refuse_links(p)
            if not p.is_file():
                continue
            data = p.read_bytes()
            rel_payload = p.relative_to(agent_dir).as_posix()
            _validate_icon_asset(name, rel_payload, p.suffix, data)
            rels.append(rel_payload)
            files.append((f"catalog/dashboard/sources/{name}/icons/{p.name}", data))
    if not files:
        return []
    paths_yaml = "".join(f"  - {rel}\n" for rel in rels)
    files.append((f"catalog/dashboard/sources/{name}/provenance.yaml", f'sourceSha: "{sha}"\nsourcePaths:\n{paths_yaml}'))
    return files


def emit(kwargs: Dict[str, Any]) -> Optional[str]:
    """Render and push the gitops record for a profile install/update event.

    ``kwargs`` is the raw hook payload (``name``, ``source_url``, ``ref``,
    ``sha``, ``distribution_version``, ``target_dir``, ``event``, plus
    ``previous_version``/``previous_sha`` on updates, and whatever extra
    kwargs ``invoke_hook`` injects, e.g. ``telemetry_schema_version`` —
    those extras are accepted and ignored).

    Pipeline: load config -> read the installed profile's
    hermes-gitops.yaml (the ONE extension carrier; missing file = empty
    extension) and distribution.yaml's ``env_requires`` -> deep-merge
    fleet defaults, the extension, and per-instance overrides -> resolve
    ``apps`` (validate names/repos/versions, deep-merge ``appValues``
    fragments, enforce ``valuesRequired`` — see ``render.resolve_apps``)
    -> build + validate + render the ``HermesProfile`` record -> (if
    configured) create/scaffold the GitOps repo -> commit + push the
    record.

    Fleet defaults and per-instance overrides may carry
    ``appValues: {<appName>: {<values fragment>}}`` — those fragments ride
    the same defaults -> extension -> overrides deep-merge chain and are
    then deep-merged into the matching app's ``values``. Mappings merge
    key-by-key; lists are replaced wholesale (positional list merging is
    forbidden — an override touching a list restates the whole list).

    On an update where ``sha == previous_sha`` (re-running against the
    same commit), the pipeline still runs to completion — ``gitrepo.publish``'s
    byte-identical check makes that a cheap no-op (no new commit) rather
    than something this function needs to special-case.

    Returns the new commit's SHA, or ``None`` if the push was a no-op
    (content already up to date).
    """
    name = kwargs["name"]
    validate_name(name)
    target_dir = kwargs["target_dir"]
    sha = kwargs["sha"]
    event = kwargs.get("event") or "install"
    distribution_version = kwargs.get("distribution_version") or ""

    cfg = load_plugin_config()

    manifest = read_target_manifest(target_dir)
    env_requires = _extract_env_requires(manifest)
    _check_required_secrets(name, required_secret_names(env_requires))

    # hermes-gitops.yaml (beside distribution.yaml, staged into the
    # installed profile root by the fork's payload copy) is the ONLY
    # extension carrier. No file => the profile declares no infra intent —
    # the record still renders (agent pod, zero apps). The fork's manifest
    # rewrite can't touch this file (it only re-serializes
    # distribution.yaml), so the INSTALLED profile is authoritative and no
    # source re-fetch is ever needed.
    contract_dir = kwargs.get("contract_dir")
    source_subdir = kwargs.get("subdir")
    extensions = load_extension_file(Path(target_dir), contract_dir, source_subdir) or {}
    _folded, agent_file = _agent_declaration(Path(target_dir), contract_dir, source_subdir)

    defaults = load_defaults(cfg)
    instance_overrides = load_instance_overrides(name, cfg)

    merged = deep_merge(defaults, extensions)
    merged = deep_merge(merged, instance_overrides)

    # `appValues` ({appName: values fragment}) is an override instruction,
    # not an extension block — fleet defaults and/or instance overrides may
    # carry it, with the normal override precedence applying since it rode
    # the same deep-merge chain. Pull it (and the raw apps declaration)
    # out before build_record, which expects `apps` to already be the
    # RESOLVED list (resolve_apps' output: appValues fragments deep-merged
    # into each app's values — lists replaced wholesale, never merged
    # positionally — and every valuesRequired dot-path proven non-null).
    app_values = merged.pop("appValues", None)
    raw_apps = merged.pop("apps", None)
    resolved_apps = resolve_apps(raw_apps, app_values, persona=name)
    if resolved_apps:
        merged["apps"] = resolved_apps

    record = build_record(name, kwargs, merged, env_requires=env_requires)
    validate(record)
    yaml_text = render_yaml(record)

    token = read_git_token(target_dir)

    if cfg["scaffold"]:
        ensure_repo_and_scaffold(cfg, token)

    rel_path = f"{cfg['profiles_path']}/{name}/profile.yaml"
    # The trees this emitter owns (ADR-19, #173). `profiles/` is the
    # record; `catalog/` is the ADR-42 dashboard catalogue and the ADR-34
    # contract/provenance pair - both generated, both overwritten on every
    # emit, neither an authoring surface. Everything else in the GitOps
    # repository belongs to the operator, and gitrepo refuses to write
    # there rather than trusting this string to be built correctly.
    generated_trees = [cfg["profiles_path"], "catalog"]

    # The logical catalogue (ADR-34), committed WITH the record in the
    # same commit: the authored contract copied BYTE-FOR-BYTE (comments,
    # line endings, everything - the emitter interprets no v2 key) plus a
    # hand-formatted provenance file. read_bytes(), never read_text() -
    # universal-newline translation would break CRLF byte parity with the
    # CLI emitter. Hand-formatted, not serialized, so
    # the CLI's emit produces identical bytes with no shared YAML
    # serializer between the two languages.
    _ext_path = agent_file if agent_file is not None else Path(target_dir) / EXTENSION_FILE_RELPATH
    catalogue_files = [
        (
            f"catalog/profiles/{name}/contract.yaml",
            _ext_path.read_bytes().decode("utf-8")
            if _ext_path.is_file()
            else "# no hermes-gitops.yaml - the profile declares no infra intent\n",
        ),
        (
            f"catalog/profiles/{name}/provenance.yaml",
            f'profile: {name}\nsourceSha: "{sha}"\n',
        ),
    ]
    catalogue_files.extend(
        _dashboard_catalogue_files(name, Path(target_dir), sha, contract_dir=agent_file.parent if agent_file else None)
    )
    message = f"gitops-emitter: {event} {name} {distribution_version} @ {sha[:12]}"
    return publish_record(
        cfg,
        name=name,
        rel_path=rel_path,
        yaml_text=yaml_text,
        catalogue_files=catalogue_files,
        generated_trees=generated_trees,
        message=message,
        token=token,
        event=event,
        pr_body=(
            f"Rendered profile record for `{name}` "
            f"({event}, {distribution_version or 'unversioned'} @ `{sha[:12]}`).\n\n"
            f"Opened by gitops-emitter; the head branch is reset from "
            f"`{cfg['branch']}` on every change."
        ),
    )


def publish_record(
    cfg: Dict[str, Any],
    *,
    name: str,
    rel_path: str,
    yaml_text: str,
    catalogue_files: List[Any],
    generated_trees: List[str],
    message: str,
    token: str,
    event: str,
    pr_body: str,
) -> Optional[str]:
    """Commit a rendered record (plus its catalogue files) to the GitOps
    repository under the configured mode - ``direct`` or ``pr`` - with the
    idempotency, branch-protection and auto-merge behaviour every runtime
    shares. The Hermes hook path and the Eve ``emit_cli`` both end here;
    nothing in this function knows what kind of record it is publishing.

    Returns the new commit's SHA (the merge SHA under auto-merge), or
    ``None`` if nothing changed.
    """
    author = {"name": cfg["git_author_name"], "email": cfg["git_author_email"]}

    # The PR gate applies to EVERY change, including the first install
    # (ADR-2, #140). It used to have a carve-out keyed on event type -
    # `pr` mode silently became `direct` when `event == "install"` - which
    # made the rule "every change goes through a pull request" false in
    # exactly the situation nobody would think to check, and invisible
    # anywhere an operator might look.
    #
    # What replaces it is an EXPLICIT escape hatch. `allow_direct_commit`
    # is off by default, has to be set deliberately, appears in the
    # rendered config an operator can read, and says so in the log every
    # time it is used. The difference is not behavioural for someone who
    # sets it - it is that the exception is now something you can see.
    effective_mode = cfg["mode"]
    if effective_mode == "pr" and cfg["allow_direct_commit"]:
        effective_mode = "direct"
        logger.warning(
            "gitops-emitter: allow_direct_commit is SET - %s (%s) commits "
            "straight to %s, bypassing the pull-request gate that ADR-2 "
            "and ADR-12 rest on. Unset it once bootstrap is complete.",
            name,
            event,
            cfg["branch"],
        )

    if effective_mode == "pr":
        from .. import forge  # local import: forge imports back from this module

        forge.require_github_repo(cfg["repo_url"], "mode: pr")
        head_branch = f"hermes-gitops/{name}"

        # Idempotency decision table (issue #19 [F2]):
        #   base already identical        -> (None, False): no commit, no PR
        #   head already identical        -> (sha, False): existing PR (if
        #                                    any) already reflects desired;
        #                                    nothing pushed, nothing opened
        #   changed                       -> (sha, True): head force-updated;
        #                                    the existing open PR now shows
        #                                    it, or a new one is opened
        commit_sha, pushed = publish_to_head(
            cfg["repo_url"],
            cfg["branch"],
            head_branch,
            rel_path,
            yaml_text,
            message,
            token,
            author,
            extra_files=catalogue_files,
            replace_trees=[f"catalog/dashboard/sources/{name}"],
            allowed_prefixes=generated_trees,
        )
        if commit_sha is None:
            return None  # byte-identical vs base: no commit, no PR

        pr = forge.find_open_pull_request(
            cfg["repo_url"], token, head=head_branch, base=cfg["branch"]
        )
        if pr is None:
            pr = forge.open_pull_request(
                cfg["repo_url"],
                token,
                head=head_branch,
                base=cfg["branch"],
                title=message,
                body=pr_body,
            )
            logger.info(
                "gitops-emitter: opened PR #%s for %s: %s",
                pr.get("number"),
                name,
                pr.get("html_url") or "<no url>",
            )
        elif pushed:
            logger.info(
                "gitops-emitter: updated existing PR #%s for %s (head force-updated): %s",
                pr.get("number"),
                name,
                pr.get("html_url") or "<no url>",
            )
        else:
            logger.info(
                "gitops-emitter: PR #%s for %s already reflects the desired record; nothing to do",
                pr.get("number"),
                name,
            )
        if cfg["pr_auto_merge"]:
            merge_sha = forge.merge_pull_request(
                cfg["repo_url"], token, pr["number"]
            )
            logger.info(
                "gitops-emitter: auto-merged PR #%s for %s @ %s",
                pr.get("number"),
                name,
                merge_sha[:12],
            )
            return merge_sha
        return commit_sha

    return publish(
        cfg["repo_url"], cfg["branch"], rel_path, yaml_text, message, token, author,
        extra_files=catalogue_files,
        replace_trees=[f"catalog/dashboard/sources/{name}"],
        allowed_prefixes=generated_trees,
    )


# Imported after GitopsEmitterError is defined (these modules import it back
# from here) to avoid a circular-import failure at package load time — see
# this module's docstring and render.py's own docstring for the same
# pattern already established in Task 4.
from .. import layout
from ..render import (  # noqa: E402
    EXTENSION_KEYS,
    EXTENSION_KEYS_V2,
    EXTENSION_KEYS_V3,
    EXTENSION_KEYS_V4,
    EXTENSION_KEYS_V5,
    build_record,
    deep_merge,
    render_yaml,
    resolve_apps,
    strip_extension_v2,
    strip_extension_v3,
    strip_extension_v4,
    strip_extension_v5,
    validate,
    validate_dashboard_file,
    validate_extension_v2,
    validate_extension_v3,
    validate_extension_v4,
    validate_extension_v5,
    validate_name,
)
from ..gitrepo import publish, publish_to_head  # noqa: E402
from ..scaffold import ensure_repo_and_scaffold  # noqa: E402
