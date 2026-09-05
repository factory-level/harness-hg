"""gitops-emitter — Hermes plugin entry point.

Packaged for the fork's pip/entry-point plugin loader (see
``hermes_cli/plugins.py`` in the hermes-agent-gitops fork:
``ENTRY_POINTS_GROUP = "hermes_agent.plugins"``). The entry point declared in
this repo's ``pyproject.toml`` points at this module by its bare dotted path
(``gitops_emitter``, with no ``:attr`` suffix), so
``importlib.metadata.EntryPoint.load()`` imports and returns this module
object itself — not a class or a callable. The loader then does
``getattr(module, "register", None)`` and calls ``register(ctx)``, which is
exactly the shape defined below.

IMPORTANT: do not change the entry point to ``gitops_emitter:register``
(pointing directly at the function). ``EntryPoint.load()`` would then return
the *function*, and the loader's `getattr(module, "register", None)` lookup
against a bare function has no `.register` attribute — the plugin would
silently fail to load with "no register() function".

NOTE on manifest metadata: for entry-point-sourced plugins the fork's loader
builds its ``PluginManifest`` purely from ``ep.name`` (-> ``manifest.name``
and ``manifest.key``) and ``ep.value`` (-> ``manifest.path``) — see
``PluginManager._scan_entry_points``. Unlike directory-based plugins, it does
NOT read a ``plugin.yaml`` or any module-level metadata for this source, so
``manifest.version``/``description``/``requires_env``/etc. stay at their
dataclass defaults ("", [], ...) for us today. The constants below are kept
for documentation and for any future entry-point manifest introspection the
fork might add; nothing in the fork currently reads them.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from .harness.hermes import GitopsEmitterError, emit

__all__ = ["register", "GitopsEmitterError", "PLUGIN_NAME", "__version__"]

logger = logging.getLogger(__name__)

# Registry key this plugin loads under (must match the entry-point name in
# pyproject.toml's [project.entry-points."hermes_agent.plugins"] table) and
# the value the fail-loud hook contract's `"plugin"` field must carry.
PLUGIN_NAME = "gitops-emitter"
__version__ = "0.1.0"
PLUGIN_DESCRIPTION = (
    "Renders fully-resolved HermesProfile GitOps records on profile "
    "install/update and pushes them to the fleet's gitops repo."
)
PROVIDES_HOOKS = ("profile_install", "profile_update", "profile_install_failed")


def _sanitize_generic_exception(exc: Exception) -> str:
    """Produce an operator-readable message for a non-``GitopsEmitterError``.

    Every ``GitopsEmitterError`` raised anywhere in this package has
    already been scrubbed of secrets (see ``gitrepo.py``'s module
    docstring) and is safe to surface verbatim. A generic exception
    (``KeyError``, ``OSError``, an unexpected bug, ...) has NOT been through
    that scrubbing pipeline — it could in principle echo back a raw kwarg
    value or path — so its ``str()`` is deliberately withheld from the
    CLI-facing fatal dict. The full exception is still logged (see
    ``_fatal``) for operators who have log access.
    """
    return (
        f"gitops-emitter: unexpected {type(exc).__name__} while processing the "
        "profile hook — see the agent's logs for the full error (withheld "
        "here because generic exceptions aren't guaranteed to be free of "
        "secrets/paths)."
    )


def _fatal(exc: Exception) -> Dict[str, Any]:
    """Translate ANY exception into the fail-loud fatal-dict contract.

    profile_install/profile_update hook callbacks must never raise: the
    fork's ``invoke_hook()`` wraps each callback in its own try/except and
    merely logs a warning on an uncaught exception, which would silently
    hide a gitops-emitter failure from the operator. Returning
    ``{"error": ..., "fatal": True, "plugin": ...}`` instead is what makes
    ``hermes profile install/update`` exit non-zero (while leaving the
    profile installed, per the hook contract) so the failure is visible.

    ``GitopsEmitterError`` messages are already scrubbed at their source
    (gitrepo.py / scaffold.py / emitter.py) and pass through verbatim as
    the ``error`` value. Any other exception type goes through
    ``_sanitize_generic_exception`` instead, since it was never guaranteed
    to be secret-free.
    """
    logger.warning("gitops-emitter: profile hook failed: %s", exc)
    message = str(exc) if isinstance(exc, GitopsEmitterError) else _sanitize_generic_exception(exc)
    return {"error": message, "fatal": True, "plugin": PLUGIN_NAME}


def _log_pushed(name: str, commit_sha: Optional[str]) -> None:
    """Log the outcome of a successful ``emit()`` call at info level."""
    if commit_sha:
        logger.info("gitops-emitter: pushed HermesProfile/%s @ %s", name, commit_sha)
    else:
        logger.info(
            "gitops-emitter: HermesProfile/%s already up to date, nothing pushed", name
        )


def _on_profile_install(**kwargs: Any) -> Optional[Dict[str, Any]]:
    """profile_install hook callback. Accepts arbitrary extra kwargs
    (e.g. ``telemetry_schema_version``, injected by ``invoke_hook``)."""
    try:
        commit_sha = emit(kwargs)
    except Exception as exc:  # noqa: BLE001 - fail-loud by contract, never raise
        return _fatal(exc)
    _log_pushed(kwargs.get("name") or "<unknown>", commit_sha)
    return None


def _on_profile_update(**kwargs: Any) -> Optional[Dict[str, Any]]:
    """profile_update hook callback. Same contract as ``_on_profile_install``;
    ``kwargs`` additionally carries ``previous_version``/``previous_sha``."""
    try:
        commit_sha = emit(kwargs)
    except Exception as exc:  # noqa: BLE001 - fail-loud by contract, never raise
        return _fatal(exc)
    _log_pushed(kwargs.get("name") or "<unknown>", commit_sha)
    return None


def _on_profile_install_failed(**kwargs: Any) -> None:
    """profile_install_failed hook callback — observer only.

    Return values from this hook are always ignored by the fork (whether the
    original install/update failure surfaces to the operator is decided
    upstream of us). We just log for visibility. ``name`` may be ``""`` if
    staging failed before name resolution.
    """
    name = kwargs.get("name") or "<unresolved>"
    logger.warning(
        "gitops-emitter: upstream profile %s failed (%s): %s",
        name,
        kwargs.get("event", "install_failed"),
        kwargs.get("error"),
    )


def register(ctx: Any) -> None:
    """Called by the fork's PluginManager once this module is loaded.

    Subscribes to the three profile-distribution lifecycle hooks. See the
    module docstring for why this function must live directly on the
    ``gitops_emitter`` module (not a submodule) given the entry-point value
    we register.
    """
    ctx.register_hook("profile_install", _on_profile_install)
    ctx.register_hook("profile_update", _on_profile_update)
    ctx.register_hook("profile_install_failed", _on_profile_install_failed)
