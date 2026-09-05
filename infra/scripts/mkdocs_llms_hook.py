"""MkDocs hook: publish each page's markdown, plus /llms.txt (ADR 0176).

The site is HTML; the source is markdown. Without this, taking a page away
as markdown means scraping the rendered page and hoping. So every page is
also published at its own source path, and two indexes name them.

MkDocs supports `hooks:` natively, so this needs no plugin and no new
dependency in the docs group — the same reasoning as mkdocs_version_hook.py
beside it.

`on_page_markdown` is the capture point rather than `on_files`: it runs after
exclusions and after any other hook has had its say, so what is written is
what the page actually rendered from.
"""

from __future__ import annotations

import pathlib
import re

# (src_uri, title, url, markdown), in nav order. Reset per build so that
# `mkdocs serve`'s rebuilds do not accumulate.
_PAGES: list[tuple[str, str, str, str]] = []

# Every page opens with a bolded lede - "**What this page tells you:** ..." or
# "**Outcome:** ...". That sentence is the one-line summary llms.txt wants.
_LEDE = re.compile(r"^\*\*(?:What this page tells you|Outcome|Goal):\*\*\s*(.+?)(?:\n\n|\Z)", re.M | re.S)


def on_config(config, **kwargs):  # noqa: ANN001, ANN003 - MkDocs hook signature
    _PAGES.clear()
    return config


def on_page_markdown(markdown, page, config, files, **kwargs):  # noqa: ANN001, ANN003
    _PAGES.append((page.file.src_uri, page.title or page.file.src_uri, page.url, markdown))
    return markdown


def _summary(markdown: str) -> str:
    m = _LEDE.search(markdown)
    if not m:
        return ""
    return " ".join(m.group(1).split()).split(". ")[0].rstrip(".")


def on_post_build(config, **kwargs):  # noqa: ANN001, ANN003
    site = pathlib.Path(config["site_dir"])
    base = (config.get("site_url") or "/").rstrip("/")

    # 1. the markdown itself, at the source path
    for src_uri, _title, _url, markdown in _PAGES:
        out = site / src_uri
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(markdown, encoding="utf-8")

    # 2. llms.txt - the index, grouped by top-level section
    lines = [f"# {config['site_name']}", ""]
    if config.get("site_description"):
        lines += [f"> {config['site_description']}", ""]
    lines += ["Every page below is also served as markdown at the same path.", ""]

    section = None
    for src_uri, title, _url, markdown in _PAGES:
        top = src_uri.split("/")[0] if "/" in src_uri else ""
        if top != section:
            section = top
            lines += ["", f"## {top or 'Home'}", ""]
        summary = _summary(markdown)
        lines.append(f"- [{title}]({base}/{src_uri})" + (f": {summary}" if summary else ""))
    (site / "llms.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # 3. llms-full.txt - the whole corpus, one file
    full = [f"# {config['site_name']} - complete documentation", ""]
    for src_uri, title, _url, markdown in _PAGES:
        full += [f"<!-- {src_uri} -->", "", markdown, "", "---", ""]
    (site / "llms-full.txt").write_text("\n".join(full), encoding="utf-8")
