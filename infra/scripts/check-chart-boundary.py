#!/usr/bin/env python3
"""The chart-boundary gate (#659, ADR 0163).

The old two-root chart violation existed because nothing failed
when a chart landed in the wrong tree. This validator makes the boundary
structural: every `Chart.yaml` in the repo must be declared in
`chart-boundary.yaml` with a class, every class has exactly one allowed
root, `application` is not a class at all (application charts live only
in persona repos), and a control-plane chart referencing another
component's name without a declared `dependsOn` fails.

Rules are data (the manifest), not code: adding a chart means adding an
entry. Runs in `make test` (and therefore CI) via the `chart-boundary`
target. `--self-test` proves the gate bites by running it over the
negative fixture tree in `examples/invalid-chart-boundary/`.

No third-party dependencies (the docs-drift precedent): the manifest is
parsed with a purpose-built reader for its flat mapping-list shape, so
the gate cannot rot when the venv is absent.
"""

from __future__ import annotations

import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
MANIFEST = pathlib.Path(__file__).resolve().parent / "chart-boundary.yaml"

ALLOWED_ROOT = {
    "control-plane": re.compile(r"^control-plane/[a-z0-9-]+/chart$"),
    "library": re.compile(r"^control-plane/[a-z0-9-]+/lib$"),
    "harness": re.compile(r"^harness/[a-z0-9-]+/charts/[a-z0-9-]+$"),
    "test-fixture": re.compile(r"^cli/test-env/charts/[a-z0-9-]+$"),
    "subchart-copy": re.compile(r"^(control-plane|harness)/.+/charts/[a-z0-9-]+$"),
}


def parse_manifest(text: str) -> list[dict[str, object]]:
    """Reads the manifest's `- { key: value, ... }` entry lines."""
    entries: list[dict[str, object]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("- {"):
            continue
        body = line[3:].rstrip("}").strip()
        entry: dict[str, object] = {}
        for part in re.split(r",\s*(?![^\[]*\])", body):
            key, _, value = part.partition(":")
            value = value.strip().strip('"')
            if value.startswith("["):
                entry[key.strip()] = [v.strip() for v in value.strip("[]").split(",") if v.strip()]
            else:
                entry[key.strip()] = value
        entries.append(entry)
    return entries


def find_charts(root: pathlib.Path) -> list[str]:
    out = []
    for p in root.rglob("Chart.yaml"):
        rel = p.parent.relative_to(root).as_posix()
        # Anything under a dot-directory is scratch, never a chart: stale git
        # worktrees (.worktrees/, .claude/worktrees/), agent eval output
        # (.hermes/), the venv. No tracked Chart.yaml lives under one, and
        # letting them through is how `make test` failed on old-tree charts
        # that were not in the repository at all.
        if any(part.startswith(".") for part in p.parent.relative_to(root).parts):
            continue
        # harness/hermes/identity holds the persona-scaffolding SKILL, whose
        # chart stubs are authoring templates, not deployable charts.
        if "node_modules" in rel or rel.startswith(("examples/", "harness/hermes/identity/")):
            continue
        out.append(rel)
    return sorted(out)


def check(root: pathlib.Path, manifest_text: str) -> list[str]:
    errors: list[str] = []
    entries = parse_manifest(manifest_text)
    declared = {str(e["path"]): e for e in entries}

    for e in entries:
        cls = str(e.get("class", ""))
        path = str(e["path"])
        if cls == "application":
            errors.append(f"{path}: class `application` is forbidden - application charts live only in persona repos")
            continue
        if cls not in ALLOWED_ROOT:
            errors.append(f"{path}: unknown class {cls!r}")
            continue
        if not ALLOWED_ROOT[cls].match(path):
            errors.append(f"{path}: class {cls} does not allow this location (expected {ALLOWED_ROOT[cls].pattern})")

    found = find_charts(root)
    for path in found:
        if path not in declared:
            errors.append(f"{path}: Chart.yaml not declared in chart-boundary.yaml - declare its class or remove the chart")
    for path in declared:
        if path not in found and (root / path).is_dir() is False and path not in found:
            if not (root / path / "Chart.yaml").exists():
                errors.append(f"{path}: declared but no Chart.yaml there - stale manifest entry")

    # Cross-component references: a control-plane chart naming another
    # component (by its manifest `component` name) in its templates must
    # declare dependsOn. Compat/subchart copies are exempt (frozen).
    components = {str(e.get("component")): str(e["path"]) for e in entries if e.get("component")}
    for e in entries:
        if str(e.get("class")) != "control-plane":
            continue
        path = str(e["path"])
        own = str(e.get("component"))
        deps = set(e.get("dependsOn") or [])
        tdir = root / path / "templates"
        if not tdir.is_dir():
            continue
        for tf in tdir.rglob("*"):
            if not tf.is_file():
                continue
            text = tf.read_text(encoding="utf-8", errors="replace")
            for comp in components:
                if comp in (own, ""):
                    continue
                token = "hermes-alerting" if comp == "alert-router" else comp
                if re.search(rf'\b{re.escape(token)}\b', text) and comp not in deps:
                    errors.append(
                        f"{path}: templates/{tf.relative_to(tdir)} references component "
                        f"`{comp}` without dependsOn: [{comp}] in chart-boundary.yaml"
                    )
                    break
            else:
                continue
            break
    return errors


def main() -> int:
    if "--self-test" in sys.argv:
        fixture = REPO_ROOT / "examples" / "invalid-chart-boundary"
        errs = check(fixture, (fixture / "chart-boundary.yaml").read_text())
        if not errs:
            print("FAIL chart-boundary self-test: the negative fixture passed", file=sys.stderr)
            return 1
        print(f"OK   [fail as expected] examples/invalid-chart-boundary ({len(errs)} finding(s))")
        return 0
    errs = check(REPO_ROOT, MANIFEST.read_text())
    if errs:
        print("chart-boundary: FAIL", file=sys.stderr)
        for e in errs:
            print(f"  ✗ {e}", file=sys.stderr)
        return 1
    print("OK   every chart is declared, homed, and within its dependency boundary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
