"""MkDocs hook: compute the docs version at build time (#616).

The version embeds the HEAD sha for unreleased docs, which means a COMMITTED
version file is stale the instant it is committed — a drift gate over it would
fail on every commit forever. So nothing is committed: this hook computes the
value during `mkdocs build` and hands it to the template.

MkDocs supports `hooks:` natively (1.4+), so this needs no plugin and no new
dependency in the docs group.

The rule itself lives in derive-version.py, which stays the single source of
truth and is still runnable on its own (`make version`).
"""

from __future__ import annotations

import importlib.util
import pathlib

_HERE = pathlib.Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location("derive_version", _HERE / "derive-version.py")
_DERIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC and _SPEC.loader
_SPEC.loader.exec_module(_DERIVE)


def on_config(config, **kwargs):  # noqa: ANN001, ANN003 - MkDocs hook signature
    try:
        version, released = _DERIVE.version_string()
    except Exception:  # noqa: BLE001
        # A tarball with no .git is a legitimate way to build these docs. Losing
        # the badge is a much better outcome than failing the build for it.
        version, released = "", False
    config["extra"] = dict(config.get("extra") or {})
    config["extra"]["hg_version"] = version
    config["extra"]["hg_released"] = released
    return config
