"""The supported plugin-config write surface (issue #10 [E1]).

``python -m gitops_emitter.config_cli apply`` configures the
gitops-emitter block of the operating profile's ``config.yaml`` and the
``GITOPS_GIT_TOKEN`` line of its ``.env`` — replacing the bootstrap's old
inline PyYAML round-trip script, which dropped every comment in the file.

Ownership contract: ``config.yaml`` is OPERATOR-authored;
``plugins.entries.gitops-emitter`` (plus the plugin's ``plugins.enabled``
entry) is the one block this tool owns. Writes are comment- and
format-preserving for the whole rest of the file (ruamel.yaml round-trip),
so an operator's hand-tuned config survives every ``pulumi up``.

Config comes from the environment (same contract as the bootstrap's
previous script — values never appear on a command line, and the token
never leaves env vars):

- ``HERMES_HOME``                     (optional; default ``~/.hermes``)
- ``HERMES_GITOPS_GITOPS_REPO_URL``     -> ``repo_url``       (required)
- ``HERMES_GITOPS_GITOPS_BRANCH``       -> ``branch``         (required)
- ``HERMES_GITOPS_GITOPS_SCAFFOLD``     -> ``scaffold``       ("true"/"false")
- ``HERMES_GITOPS_HERMES_GITOPS_REPO_URL``-> ``hermes_gitops_repo_url`` (required)
- ``HERMES_GITOPS_CHART_REVISION``      -> ``chart_revision`` (required)
- ``GITOPS_GIT_TOKEN``                -> ``.env`` upsert    (optional)

Optional plugin-config fields (issue #13 [E3]) — written to the block
only when SET; unset keeps ``load_plugin_config``'s fallback defaults
(the single source of default values), so behavior is unchanged:

- ``HERMES_GITOPS_PROFILES_PATH``       -> ``profiles_path``
- ``HERMES_GITOPS_DEFAULTS_FILE``       -> ``defaults_file``
- ``HERMES_GITOPS_OVERRIDES_DIR``       -> ``overrides_dir``
- ``HERMES_GITOPS_GIT_AUTHOR_NAME``     -> ``git_author_name``
- ``HERMES_GITOPS_GIT_AUTHOR_EMAIL``    -> ``git_author_email``
- ``HERMES_GITOPS_IMAGE_REPOSITORY``    -> ``image_repository``
- ``HERMES_GITOPS_IMAGE_TAG``           -> ``image_tag``

Booleans have their own explicit coercion rather than riding the optional
map: ``HERMES_GITOPS_GITOPS_SCAFFOLD``, ``HERMES_GITOPS_PR_AUTO_MERGE`` and
``HERMES_GITOPS_ALLOW_DIRECT_COMMIT`` (ADR-2's escape hatch, #140 — off
unless the string is exactly ``"true"``).

Fleet defaults (the BOTTOM of the override chain — issue #13 [E3]):
``HERMES_GITOPS_FLEET_DEFAULTS_JSON`` (a JSON object) is materialized as
the fleet ``defaults.yaml`` at the effective ``defaults_file`` path.
That file is WHOLLY OWNED by this tool when the env var is set
(regenerated on every apply — hand-edits to it do not survive; author
the defaults in stack config instead). Unset = the file is left alone
(hand-authoring remains possible, and its absence stays a documented
no-op). ``apply`` also guarantees the effective ``overrides_dir``
exists.

After writing, ``apply`` READS the config back through the same supported
seam the plugin itself loads from at hook time (``hermes_cli.config
.load_config`` when the fork is importable, a plain YAML read otherwise)
and asserts every key round-tripped — so stage 1 directly proves the
config the emitter will actually see, not just that a write happened.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict

from ruamel.yaml import YAML

PLUGIN_KEY = "gitops-emitter"

_REQUIRED_ENV = {
    "HERMES_GITOPS_GITOPS_REPO_URL": "repo_url",
    "HERMES_GITOPS_GITOPS_BRANCH": "branch",
    "HERMES_GITOPS_HERMES_GITOPS_REPO_URL": "hermes_gitops_repo_url",
    "HERMES_GITOPS_CHART_REVISION": "chart_revision",
}

_OPTIONAL_ENV = {
    "HERMES_GITOPS_MODE": "mode",
    "HERMES_GITOPS_PROFILES_PATH": "profiles_path",
    "HERMES_GITOPS_DEFAULTS_FILE": "defaults_file",
    "HERMES_GITOPS_OVERRIDES_DIR": "overrides_dir",
    "HERMES_GITOPS_GIT_AUTHOR_NAME": "git_author_name",
    "HERMES_GITOPS_GIT_AUTHOR_EMAIL": "git_author_email",
    "HERMES_GITOPS_IMAGE_REPOSITORY": "image_repository",
    "HERMES_GITOPS_IMAGE_TAG": "image_tag",
}


class ConfigCliError(Exception):
    """Raised for invalid input or a failed read-back assertion."""


def desired_entry_from_env(env: Dict[str, str]) -> Dict[str, Any]:
    """Build the desired ``plugins.entries.gitops-emitter`` block from the
    environment contract above. Pure — unit-tested directly."""
    missing = [var for var in _REQUIRED_ENV if not env.get(var)]
    if missing:
        raise ConfigCliError(
            "gitops-emitter config apply: missing required environment "
            f"variable(s): {', '.join(sorted(missing))}"
        )
    entry: Dict[str, Any] = {
        target: env[var] for var, target in _REQUIRED_ENV.items()
    }
    entry["scaffold"] = env.get("HERMES_GITOPS_GITOPS_SCAFFOLD", "true") == "true"
    for var, target in _OPTIONAL_ENV.items():
        if env.get(var):
            entry[target] = env[var]
    if env.get("HERMES_GITOPS_PR_AUTO_MERGE"):
        entry["pr_auto_merge"] = env["HERMES_GITOPS_PR_AUTO_MERGE"] == "true"
    # Booleans go through explicit coercion, never `_OPTIONAL_ENV`: that
    # loop writes the raw string, and the string "false" is truthy. A
    # bypass flag that turns itself ON when set to "false" is the worst
    # possible version of this bug (#140).
    if env.get("HERMES_GITOPS_ALLOW_DIRECT_COMMIT"):
        entry["allow_direct_commit"] = env["HERMES_GITOPS_ALLOW_DIRECT_COMMIT"] == "true"
    return entry


def apply_config_yaml(config_path: Path, desired: Dict[str, Any]) -> None:
    """Merge the plugin-owned block into ``config_path``, preserving every
    comment and the formatting of everything this tool does not own."""
    yaml = YAML()
    yaml.preserve_quotes = True

    data: Any = None
    if config_path.is_file():
        text = config_path.read_text(encoding="utf-8")
        data = yaml.load(text) if text.strip() else None
    if data is None:
        data = yaml.map()
    if not isinstance(data, dict):
        raise ConfigCliError(f"{config_path} does not contain a YAML mapping")

    plugins = data.setdefault("plugins", yaml.map())
    if not isinstance(plugins, dict):
        raise ConfigCliError(f"{config_path}'s 'plugins' key is not a mapping")
    enabled = plugins.setdefault("enabled", yaml.seq())
    if not isinstance(enabled, list):
        raise ConfigCliError(f"{config_path}'s plugins.enabled is not a list")
    if PLUGIN_KEY not in enabled:
        enabled.append(PLUGIN_KEY)

    entries = plugins.setdefault("entries", yaml.map())
    if not isinstance(entries, dict):
        raise ConfigCliError(f"{config_path}'s plugins.entries is not a mapping")
    entry = entries.setdefault(PLUGIN_KEY, yaml.map())
    if not isinstance(entry, dict):
        raise ConfigCliError(
            f"{config_path}'s plugins.entries.{PLUGIN_KEY} is not a mapping"
        )
    for key, value in desired.items():
        entry[key] = value

    config_path.parent.mkdir(parents=True, exist_ok=True)
    with config_path.open("w", encoding="utf-8") as f:
        yaml.dump(data, f)


def upsert_env_token(env_path: Path, token: str) -> None:
    """Upsert ``GITOPS_GIT_TOKEN=<token>`` into ``env_path``, preserving
    every other line byte-for-byte."""
    lines = (
        env_path.read_text(encoding="utf-8").splitlines() if env_path.is_file() else []
    )
    out = []
    found = False
    for line in lines:
        if line.startswith("GITOPS_GIT_TOKEN="):
            out.append(f"GITOPS_GIT_TOKEN={token}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"GITOPS_GIT_TOKEN={token}")
    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("\n".join(out) + "\n", encoding="utf-8")


def read_back_entry(config_path: Path) -> Dict[str, Any]:
    """Read the plugin's config block through the supported seam.

    Prefers ``hermes_cli.config.load_config`` (exactly what the plugin's
    own ``load_plugin_config`` reads through at hook time) when the fork
    is importable; falls back to a plain YAML read for environments
    without the fork (unit tests, standalone use).
    """
    try:
        from hermes_cli.config import load_config  # type: ignore[import-not-found]

        config = load_config()
    except Exception:
        yaml = YAML()
        config = (
            yaml.load(config_path.read_text(encoding="utf-8"))
            if config_path.is_file()
            else {}
        ) or {}
    plugins = config.get("plugins") or {}
    entries = plugins.get("entries") or {}
    return dict(entries.get(PLUGIN_KEY) or {})


def assert_applied(config_path: Path, desired: Dict[str, Any]) -> None:
    """Assert every desired key round-tripped through the supported read
    seam — the direct stage-1 config assertion (issues #10 [E1] / #16 [I2])."""
    actual = read_back_entry(config_path)
    mismatched = {
        key: (value, actual.get(key))
        for key, value in desired.items()
        if actual.get(key) != value
    }
    if mismatched:
        detail = "; ".join(
            f"{key}: wrote {wrote!r}, read back {got!r}"
            for key, (wrote, got) in sorted(mismatched.items())
        )
        raise ConfigCliError(
            f"gitops-emitter config apply: read-back assertion failed ({detail})"
        )


def seed_fleet_defaults(defaults_file: Path, defaults: Dict[str, Any]) -> None:
    """Materialize the fleet ``defaults.yaml`` (bottom of the override
    chain) at *defaults_file*. Tool-owned when driven: regenerated
    wholesale on every apply — see the module docstring."""
    yaml = YAML()
    defaults_file.parent.mkdir(parents=True, exist_ok=True)
    with defaults_file.open("w", encoding="utf-8") as f:
        f.write(
            "# Fleet-wide defaults - the BOTTOM of the gitops-emitter override\n"
            "# chain. GENERATED by `python -m gitops_emitter.config_cli apply`\n"
            "# from the Pulumi stack's hermes-gitops-bootstrap:fleetDefaults\n"
            "# config; hand-edits here are overwritten on the next apply -\n"
            "# author changes in the stack config instead.\n"
        )
        yaml.dump(defaults if defaults else {}, f)


def _effective_paths(desired: Dict[str, Any]) -> tuple[Path, Path]:
    """The defaults-file/overrides-dir paths this apply is responsible
    for: the configured values when set, else ``load_plugin_config``'s
    own fallback defaults (imported, not duplicated — single source)."""
    from .harness.hermes import default_defaults_file, default_overrides_dir

    defaults_file = Path(
        desired.get("defaults_file") or default_defaults_file()
    ).expanduser()
    overrides_dir = Path(
        desired.get("overrides_dir") or default_overrides_dir()
    ).expanduser()
    return defaults_file, overrides_dir


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if args != ["apply"]:
        print(
            "usage: python -m gitops_emitter.config_cli apply\n"
            "(config via environment - see the module docstring)",
            file=sys.stderr,
        )
        raise SystemExit(2)

    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    config_path = home / "config.yaml"

    desired = desired_entry_from_env(dict(os.environ))
    apply_config_yaml(config_path, desired)
    assert_applied(config_path, desired)
    print(f"gitops-emitter: configured + verified in {config_path}")

    defaults_file, overrides_dir = _effective_paths(desired)
    raw_defaults = os.environ.get("HERMES_GITOPS_FLEET_DEFAULTS_JSON")
    if raw_defaults is not None:
        import json

        try:
            fleet_defaults = json.loads(raw_defaults)
        except json.JSONDecodeError as exc:
            raise ConfigCliError(
                "HERMES_GITOPS_FLEET_DEFAULTS_JSON is not valid JSON"
            ) from exc
        if not isinstance(fleet_defaults, dict):
            raise ConfigCliError(
                "HERMES_GITOPS_FLEET_DEFAULTS_JSON must be a JSON object"
            )
        seed_fleet_defaults(defaults_file, fleet_defaults)
        print(f"gitops-emitter: fleet defaults seeded in {defaults_file}")
    overrides_dir.mkdir(parents=True, exist_ok=True)
    print(f"gitops-emitter: overrides dir ensured at {overrides_dir}")

    token = os.environ.get("GITOPS_GIT_TOKEN", "")
    if token:
        env_path = home / ".env"
        upsert_env_token(env_path, token)
        with env_path.open(encoding="utf-8") as f:
            assert any(
                line.startswith("GITOPS_GIT_TOKEN=") for line in f
            ), f"GITOPS_GIT_TOKEN missing from {env_path} after upsert"
        print(f"gitops-emitter: GITOPS_GIT_TOKEN written + verified in {env_path}")


if __name__ == "__main__":
    main()
