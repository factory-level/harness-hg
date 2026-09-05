"""Regenerates .hermes/examples/rendered/profile-echo.yaml from
.hermes/examples/persona-echo/'s distribution.yaml + hermes-gitops.yaml
(the extension file beside it — the ONE carrier of infra intent) using the
REAL gitops_emitter render pipeline (gitops_emitter/render.py) — not a
hand-written fixture — so the example stays in lockstep with whatever
render.py actually produces.

Run directly to (re)write the golden file after an intentional change to
.hermes/examples/persona-echo/:

    uv run python tests/render_persona_echo_example.py --write

tests/test_persona_echo_example.py imports `render_example()` from here and
asserts it matches the committed .hermes/examples/rendered/profile-echo.yaml
byte-for-byte (same "golden render, diffed on every run" pattern as
infra/scripts/render-test.sh uses for the Helm chart).

HOOK_KWARGS below is a fixed, documented stand-in for a real
profile_install hook payload — persona-echo is a documentation example, not
something infra/scripts/smoke-local.sh actually installs, so there is no real
`hermes profile install` run to source these values from. The ref/sha are
arbitrary but schema-valid (sha must be exactly 40 lowercase hex chars).
"""

from __future__ import annotations

import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
DIST_DIR = REPO_ROOT / "harness" / "hermes" / "identity" / "examples" / "persona-echo"
OUT_PATH = REPO_ROOT / "harness" / "hermes" / "identity" / "examples" / "rendered" / "profile-echo.yaml"

# Fixed example hook payload — see module docstring.
HOOK_KWARGS = {
    "name": "persona-echo",
    "source_url": "github.com/factory-level/persona-echo",
    "ref": "v1.0.0",
    "sha": "e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
    "distribution_version": "1.0.0",
}


def render_example() -> str:
    import yaml

    from gitops_emitter.harness.hermes import load_extension_file
    from gitops_emitter.render import (
        build_record,
        render_yaml,
        resolve_apps,
        validate,
    )

    manifest = yaml.safe_load((DIST_DIR / "distribution.yaml").read_text(encoding="utf-8"))
    env_requires = [entry["name"] for entry in manifest.get("env_requires", [])]

    # Mirrors emitter.emit()'s own handling: the extension comes from
    # hermes-gitops.yaml BESIDE distribution.yaml (the only carrier;
    # distribution.yaml stays pure Hermes), and `apps` must be resolved by
    # resolve_apps() (validation + appValues merging + valuesRequired
    # enforcement — no fleet defaults or per-instance overrides in this
    # documentation example) before build_record() sees it.
    extensions = load_extension_file(DIST_DIR) or {}
    merged_ext = dict(extensions)
    raw_apps = merged_ext.pop("apps", None)
    resolved = resolve_apps(raw_apps, None, persona=HOOK_KWARGS["name"])
    if resolved:
        merged_ext["apps"] = resolved

    record = build_record(HOOK_KWARGS["name"], HOOK_KWARGS, merged_ext, env_requires=env_requires)
    validate(record)
    return render_yaml(record)


def main() -> int:
    write = "--write" in sys.argv[1:]
    text = render_example()
    if write:
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(text, encoding="utf-8")
        print(f"wrote {OUT_PATH}")
        return 0

    current = OUT_PATH.read_text(encoding="utf-8") if OUT_PATH.is_file() else ""
    if current != text:
        print(
            f"{OUT_PATH} is out of date with .hermes/examples/persona-echo/distribution.yaml "
            "— run 'uv run python tests/render_persona_echo_example.py --write' to regenerate",
            file=sys.stderr,
        )
        return 1
    print(f"{OUT_PATH} is up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
