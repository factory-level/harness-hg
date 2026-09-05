"""Managed lifecycle for per-instance overrides (issue #11 [E2]).

``python -m gitops_emitter.overrides_cli <verb> ...`` operates on the
persisted per-instance override files (``<overrides_dir>/<name>.yaml`` —
the third, highest-precedence layer of the emitter's merge chain):

- ``list``            — personas with a persisted override
- ``get <name>``      — print a persona's persisted override (exit 1 +
                        stderr message when none exists)
- ``set <name> <file>``— validate + persist *file* as the persona's
                        override (the explicit form of what
                        ``HERMES_GITOPS_OVERRIDES`` does implicitly at
                        install time; the file may carry any extension
                        block plus ``appValues: {<appName>: fragment}``
                        chart-values fragments — the surface the
                        valuesRequired failure message points at)
- ``unset <name>``    — remove the persisted override, reverting the
                        persona to fleet defaults + the distribution's
                        hermes-gitops.yaml on its next install/update

``overrides_dir`` resolution order: ``HERMES_GITOPS_OVERRIDES_DIR`` env var
-> the configured ``plugins.entries.gitops-emitter.overrides_dir`` (when
the fork's config is loadable) -> the emitter's default (HERMES_HOME-
anchored). One resolution path shared with the emitter — no drift.

The DECLARATIVE half of the lifecycle lives in the emitter itself: at
install/update time, ``HERMES_GITOPS_OVERRIDES_CLEAR`` (set by the infra
program when an agent declares no ``overrides``) deletes
the persisted copy — so removing an override from the Pulumi stack
actually clears it on the next ``pulumi up``; see
``emitter.load_instance_overrides``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import yaml

from .harness.hermes import GitopsEmitterError, _provenance_header, default_overrides_dir
from .render import validate_name


def resolve_overrides_dir() -> Path:
    env_dir = os.environ.get("HERMES_GITOPS_OVERRIDES_DIR")
    if env_dir:
        return Path(env_dir).expanduser()
    try:
        from .harness.hermes import load_plugin_config

        return Path(load_plugin_config()["overrides_dir"]).expanduser()
    except Exception:
        return Path(default_overrides_dir()).expanduser()


def cmd_list(overrides_dir: Path) -> int:
    if not overrides_dir.is_dir():
        return 0
    for entry in sorted(overrides_dir.glob("*.yaml")):
        print(entry.stem)
    return 0


def cmd_get(overrides_dir: Path, name: str) -> int:
    validate_name(name)
    path = overrides_dir / f"{name}.yaml"
    if not path.is_file():
        print(f"gitops-emitter overrides: no persisted override for {name!r}", file=sys.stderr)
        return 1
    sys.stdout.write(path.read_text(encoding="utf-8"))
    return 0


def cmd_set(overrides_dir: Path, name: str, source: Path) -> int:
    validate_name(name)
    try:
        text = source.read_text(encoding="utf-8")
    except OSError as exc:
        raise GitopsEmitterError(
            f"gitops-emitter overrides: failed to read {source}: {exc}"
        ) from exc
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise GitopsEmitterError(
            f"gitops-emitter overrides: {source} is not valid YAML: {exc}"
        ) from exc
    if data is not None and not isinstance(data, dict):
        raise GitopsEmitterError(
            f"gitops-emitter overrides: {source} must be a YAML mapping, "
            f"got {type(data).__name__}"
        )
    overrides_dir.mkdir(parents=True, exist_ok=True)
    # Stamped, like every other write to this directory (ADR-4, #180).
    # This verb IS the explicit, named local path #180 asks for - a
    # deliberate command an operator runs, not the ambient "a file happens
    # to be here" capability the emitter used to honour. The stamp records
    # WHICH of the two wrote it, so a reader can tell a local decision
    # from the stack's.
    (overrides_dir / f"{name}.yaml").write_text(
        _provenance_header("overrides_cli") + text, encoding="utf-8"
    )
    print(f"gitops-emitter overrides: set for {name!r}")
    return 0


def cmd_unset(overrides_dir: Path, name: str) -> int:
    validate_name(name)
    path = overrides_dir / f"{name}.yaml"
    if path.is_file():
        path.unlink()
        print(f"gitops-emitter overrides: unset for {name!r}")
    else:
        print(f"gitops-emitter overrides: nothing persisted for {name!r} (no-op)")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    usage = (
        "usage: python -m gitops_emitter.overrides_cli "
        "{list | get <name> | set <name> <file> | unset <name>}"
    )
    overrides_dir = resolve_overrides_dir()
    try:
        if args == ["list"]:
            return cmd_list(overrides_dir)
        if len(args) == 2 and args[0] == "get":
            return cmd_get(overrides_dir, args[1])
        if len(args) == 3 and args[0] == "set":
            return cmd_set(overrides_dir, args[1], Path(args[2]).expanduser())
        if len(args) == 2 and args[0] == "unset":
            return cmd_unset(overrides_dir, args[1])
    except GitopsEmitterError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(usage, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
