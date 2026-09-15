#!/usr/bin/env python3
"""Render release notes from conventional commits since the last release tag.

Same parser as derive-version.py, so the notes and the version number agree
by construction: every subject the version counts appears in the notes, and
an unparseable subject is invisible to both.

    python3 infra/scripts/release-notes.py            # since the newest v* tag, or all history
    python3 infra/scripts/release-notes.py --since v0.239.0
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from derive_version import HEADER, base_tag, git, version_string  # noqa: E402

SECTIONS = [
    ("Breaking", lambda k, b: b),
    ("Features", lambda k, b: k == "feat"),
    ("Fixes", lambda k, b: k in ("fix", "perf")),
    ("Docs", lambda k, b: k == "docs"),
    ("Chores", lambda k, b: k in ("chore", "refactor", "test", "build", "ci", "style", "revert")),
]
PR_REF = re.compile(r"\s*\(#(\d+)\)\s*$")
OVERLAY = [
    line.strip()
    for line in (Path(__file__).resolve().parent / "public-overlay.txt").read_text().splitlines()
    if line.strip() and not line.startswith("#")
]


def overlay_only(paths: list[str]) -> bool:
    """True when every path a commit touched is private overlay: not a public change."""
    return bool(paths) and all(
        any(p == o or p.startswith(o.rstrip("/") + "/") for o in OVERLAY) for p in paths
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since", help="tag or ref to start after (default: newest v* tag)")
    args = ap.parse_args()
    since = args.since or base_tag()[0]
    rng = [f"{since}..HEAD"] if since else []
    # %x1f: subject | body | changed paths (name-only, newline separated).
    log = git("log", "--reverse", "--name-only", "--pretty=%x1e%s%x1f%b%x1f", *rng)
    buckets: dict[str, list[str]] = {name: [] for name, _ in SECTIONS}
    for entry in log.split("\x1e"):
        if not entry.strip():
            continue
        subject, _, rest = entry.strip().partition("\x1f")
        body, _, files = rest.partition("\x1f")
        subject = subject.strip()
        if overlay_only([f for f in files.split("\n") if f.strip()]):
            continue
        m = HEADER.match(subject)
        if not m:
            continue
        kind, breaking = m.group("type"), bool(m.group("bang")) or "BREAKING CHANGE" in body
        # The (#NNN) suffix names a PR in the private ops fork; on the
        # public repository it would auto-link to an unrelated issue.
        line = PR_REF.sub("", subject[m.end():].strip())
        for name, pick in SECTIONS:
            if pick(kind, breaking):
                buckets[name].append(line)
                break
    version, _ = version_string()
    print(f"## {version.split('-dev+')[0]}")
    print()
    print(f"Changes since {since or 'the first commit'}.")
    for name, lines in buckets.items():
        if not lines:
            continue
        print()
        print(f"### {name}")
        print()
        for line in lines:
            print(f"- {line}")


if __name__ == "__main__":
    main()
