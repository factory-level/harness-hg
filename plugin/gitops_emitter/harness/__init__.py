"""The AI harness drivers (ADR-153): one directory, one module per runtime.

A "harness" here is an agent runtime the platform can deploy an agent onto.
Each driver turns a persona repository at ONE commit into the record its
chart consumes, and nothing else: no Git, no Kubernetes, no publishing.
``emit_cli`` (the wire entry point, ``python -m gitops_emitter.emit_cli``)
and the Hermes install hook in ``gitops_emitter/__init__.py`` choose a
driver and hand its rendered record to ``gitrepo.publish``.

- ``hermes`` — the legacy runtime: ``distribution.yaml`` + the extension,
  merged over the profile defaults, published by the ``hermes profile
  install`` hook.
- ``eve`` — the Vercel Eve runtime (ADR-149): an npm project at
  ``agents/<name>/``, no install hook at all.

What is deliberately NOT here: ``render.py`` (the shared canonicalizer and
the app resolver both drivers use), ``gitrepo.py`` (publishing),
``scaffold.py`` and the ``*_cli.py`` entry points. They are shared plumbing
or wire contracts, and a driver directory that swallowed them would just be
the package again under a new name.
"""

from __future__ import annotations

#: The runtimes a record can be built for. ``emit_cli --runtime`` validates
#: against this, so adding a harness means adding a module beside this file
#: and a name here.
RUNTIMES = ("hermes", "eve")

__all__ = ["RUNTIMES"]
