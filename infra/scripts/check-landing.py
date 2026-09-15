#!/usr/bin/env python3
"""Check the public landing pages without a browser or third-party Python packages."""
import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shlex
import struct
import subprocess
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
BASE = 'https://factory-level.github.io/harness-hg/'


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.meta, self.links, self.ids, self.canonical = {}, [], set(), []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if 'id' in a:
            self.ids.add(a['id'])
        if tag == 'meta':
            self.meta[a.get('property', a.get('name'))] = a.get('content')
        if tag == 'link' and a.get('rel') == 'canonical':
            self.canonical.append(a.get('href'))
        for key in ('href', 'src'):
            if a.get(key):
                self.links.append(a[key])


def validate_commands(source, commands):
    errors = []
    scenes = re.findall(r"\{ verb: '([^']+)', target: '([^']*)'", source)
    if not scenes:
        return ['no scene commands found']
    for verb, target in scenes:
        cmd = next((c for c in commands if c['name'] == verb), None)
        words = shlex.split(target)
        if not cmd:
            errors.append(f'unknown scene command: hg {verb} {target}')
            continue
        sub = next((s for s in sorted(cmd['subs'], key=lambda s: len(s['name']), reverse=True)
                    if words[:len(s['name'].split())] == s['name'].split()), None)
        if sub is None:
            errors.append(f'unknown scene subcommand: hg {verb} {target}')
            continue
        remaining = words[len(sub['name'].split()):]
        flags = {f['name']: f for f in sub.get('flags', [])}
        positionals = []
        while remaining:
            arg = remaining.pop(0)
            if arg.startswith('--'):
                if arg not in flags:
                    errors.append(f'unknown scene flag: {arg}')
                elif flags[arg].get('value'):
                    if not remaining or remaining[0].startswith('--'):
                        errors.append(f'missing scene flag value: {arg}')
                    else:
                        remaining.pop(0)
            else:
                positionals.append(arg)
        synopsis = sub.get('args', '')
        if positionals and not synopsis:
            errors.append(f'unexpected scene argument: hg {verb} {target}')
        if synopsis.startswith('<') and not positionals:
            errors.append(f'missing scene argument: hg {verb} {target}')
    return errors


def check(site=None):
    errors, tokens = [], set()
    landing = ROOT / 'landing'
    tree = (ROOT / site).resolve() if site else landing
    pages = {}
    def parsed(path):
        if path not in pages:
            pages[path] = Page(path.read_text())
        return pages[path]

    for src in sorted(landing.rglob('*.html')):
        rel = src.relative_to(landing)
        path = tree / rel
        page = parsed(path)
        expected = BASE + str(rel).removesuffix('index.html')
        if page.canonical != [expected] or page.meta.get('og:url') != expected:
            errors.append(f'{rel}: canonical/og:url must be {expected}')
        for name in ('description', 'og:title', 'og:description', 'og:image:alt'):
            if not page.meta.get(name):
                errors.append(f'{rel}: missing {name}')
        for name, value in {'og:site_name': 'Harness Hg', 'og:image': BASE+'assets/share-card.png',
                            'twitter:image': BASE+'assets/share-card.png',
                            'twitter:card': 'summary_large_image',
                            'og:image:width': '1200', 'og:image:height': '630'}.items():
            if page.meta.get(name) != value:
                errors.append(f'{rel}: incorrect {name}')
        for link in page.links:
            url = urlsplit(link)
            if url.scheme or url.netloc:
                continue
            if url.path.startswith('/'):
                errors.append(f'{rel}: origin-absolute link breaks Pages prefix: {link}')
                continue
            dest = (path.parent / unquote(url.path)).resolve() if url.path else path
            if not dest.is_relative_to(tree):
                errors.append(f'{rel}: link escapes site: {link}')
                continue
            part = dest.relative_to(tree).parts
            if not site and part and part[0] in ('docs', 'demo'):
                continue  # checked after assembly by make site
            if dest.is_dir():
                dest /= 'index.html'
            if not dest.is_file():
                errors.append(f'{rel}: missing link/asset: {link}')
            elif url.fragment and dest.suffix == '.html' and unquote(url.fragment) not in parsed(dest).ids:
                errors.append(f'{rel}: missing anchor: {link}')
            if dest.suffix in ('.css', '.js', '.svg', '.woff2'):
                if not re.fullmatch(r'v=\d+', url.query):
                    errors.append(f'{rel}: missing asset cache token: {link}')
                else:
                    tokens.add(url.query)
    css = (landing / 'styles.css').read_text()
    tokens.update(re.findall(r'v=\d+', css))
    if len(tokens) != 1:
        errors.append(f'asset cache tokens differ: {sorted(tokens)}')
    png = landing / 'assets/share-card.png'
    if not png.exists() or png.read_bytes()[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', png.read_bytes()[16:24]) != (1200, 630):
        errors.append('share-card.png must be a 1200×630 PNG')
    commands = json.loads(subprocess.check_output(['bun', 'cli/src/commands.ts'], cwd=ROOT))
    errors.extend(validate_commands((landing / 'hero.js').read_text(), commands))
    return errors


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', help='assembled site directory; also check docs/demo destinations')
    args = parser.parse_args()
    failures = check(args.site)
    for failure in failures:
        print(f'landing: {failure}')
    if failures:
        raise SystemExit(1)
    print('landing: metadata, links, assets and CLI scenes checked' + (' against assembled site' if args.site else ''))
