#!/usr/bin/env python3
"""Every `hg` invocation the WIKI prints must exist in the CLI manifest.

The subsequence check in check-quickstart-drift.sh runs one way only —
script to page — and deliberately welcomes extra prose commands. So a page
could invoke a verb that does not exist and still pass. That is exactly how
the wiki printed `hg platform backup install-timer` (which the parser
rejects) while the generated reference agreed with it, and how the runbooks
— gated by nothing at all — drifted for months.

`cli/src/commands.ts` is the manifest and prints itself as JSON. A command
whose sub list contains "" takes positionals rather than a subcommand, so
only subcommand-requiring commands are checked.

    make quickstart-drift   (part of `make test`; cluster-free, fast)
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PLACEHOLDER = re.compile(r"^[<$`{|]")


def manifest() -> dict[str, set[str]]:
    proc = subprocess.run(
        ["bun", "src/commands.ts"], cwd=ROOT / "cli", capture_output=True, text=True
    )
    if proc.returncode != 0:
        sys.exit(f"wiki-commands: `bun src/commands.ts` exited {proc.returncode}\n{proc.stderr}")
    return {c["name"]: {s["name"] for s in (c.get("subs") or [])} for c in json.loads(proc.stdout)}


def check(tail: str, page: pathlib.Path, n: int, subs_by_cmd, bad: list[str]) -> None:
    words = [w for w in tail.split() if w and not w.startswith("-")]
    # Prose shorthand, not an invocation: `hg agent inspect|render`, `hg server *`.
    if any("|" in w or "*" in w for w in words[:2]):
        return
    if not words or PLACEHOLDER.match(words[0]):
        return
    cmd, rest = words[0], words[1:]
    where = f"{page.relative_to(ROOT)}:{n}"
    if cmd not in subs_by_cmd:
        bad.append(f"  {where}: `hg {cmd}` is not a command")
        return
    subs = subs_by_cmd[cmd]
    if "" in subs:  # takes positionals, not a subcommand
        return
    if not rest or PLACEHOLDER.match(rest[0]):
        return
    if " ".join(rest[:2]) in subs or rest[0] in subs:
        return
    bad.append(f"  {where}: `hg {' '.join([cmd] + rest[:2])}` is not a subcommand of `hg {cmd}`")


def main() -> None:
    subs_by_cmd = manifest()
    bad: list[str] = []

    for page in sorted((ROOT / "_docs/wiki").rglob("*.md")):
        text = page.read_text()
        if "GENERATED" in text:  # rendered from the manifest or the schemas;
            continue             # a bad command in one is a generator bug
        fenced = False
        for n, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("```"):
                fenced = not fenced
                continue
            if not fenced:
                for inline in re.findall(r"`hg ([^`]+)`", line):
                    check(inline, page, n, subs_by_cmd, bad)
                continue
            m = re.match(r"^\s*(?:\$\s*)?hg\s+(.*)$", line.split("#")[0])
            if m:
                check(m.group(1), page, n, subs_by_cmd, bad)

    # Generated pages are skipped above because their text comes from the
    # schemas — so check the SCHEMAS. `hg communication trace` and
    # `hg discord test` reached the published reference this way, neither
    # having ever existed.
    # Frozen schemas are immutable, so a spelling retired AFTER a schema
    # froze legitimately survives there as history (ADR 0177's cost
    # section). List each such spelling here when its command dies.
    frozen_ok = ("eve ",)
    for schema in sorted(pathlib.Path(ROOT / "agent-bundle-contracts").rglob("*.json")):
        for n, line in enumerate(schema.read_text().splitlines(), 1):
            for inline in re.findall(r"`hg ([^`]+)`", line):
                if any(inline.startswith(p) for p in frozen_ok):
                    continue
                check(inline, schema, n, subs_by_cmd, bad)

    if bad:
        print("FAIL the wiki invokes commands the manifest does not define:")
        print("\n".join(bad))
        sys.exit(1)
    print("OK   every `hg` command the wiki prints exists in the manifest")


if __name__ == "__main__":
    main()
