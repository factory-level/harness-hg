"""The package-wide error type, in a module with no other imports.

Historically ``GitopsEmitterError`` lived in ``harness/hermes.py`` so the
generic modules (``render.py``, ``gitrepo.py``, ``scaffold.py``,
``forge.py``) could import it without a circular dependency — at the cost
of the generic half importing from the harness half. This module removes
that inversion: both halves import from here, and ``harness/hermes.py``
re-exports the name so every historical import path keeps working.
"""

from __future__ import annotations


class GitopsEmitterError(Exception):
    """Raised for gitops-emitter-specific failures.

    Covers pure render-pipeline problems (schema violations, bad or
    under-supplied ``apps`` declarations — see ``render.py``),
    config/secret problems (this
    module), and the git push / repo-scaffold pipeline's own errors
    (``gitrepo.py``, ``scaffold.py``). Every message raised as this type,
    anywhere in the package, has already been scrubbed of the git token
    and of this package's own ephemeral tempdir paths where applicable —
    see ``gitrepo.py``'s module docstring. Handlers in
    ``gitops_emitter/__init__.py`` catch this (along with every other
    exception, per the fail-loud contract) and translate it into the
    ``{"error": ..., "fatal": True, "plugin": ...}`` dict rather than
    letting it propagate.
    """
