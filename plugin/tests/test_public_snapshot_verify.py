"""The release verifier must gate the exported tree without release side effects."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

SOURCE = Path(__file__).resolve().parents[2] / 'infra/scripts/public-snapshot.sh'


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


@pytest.mark.parametrize('gate', ['pass', 'fail', 'dirty'])
def test_verify_only_exports_committed_tree_without_release_actions(tmp_path, gate):
    repo = tmp_path / 'ops'
    scripts = repo / 'infra/scripts'
    scripts.mkdir(parents=True)
    shutil.copy2(SOURCE, scripts / 'public-snapshot.sh')
    (scripts / 'public-overlay.txt').write_text('private.txt\ninfra/scripts/public-overlay.txt\n')
    (repo / 'private.txt').write_text('private fixture')
    (repo / 'public.txt').write_text('committed fixture')
    (scripts / 'check-public-clean.sh').write_text('''#!/bin/bash
set -eu
test "$1" = --strict
test ! -e private.txt
test ! -e infra/scripts/public-overlay.txt
test "$(cat public.txt)" = "committed fixture"
test -n "$(git ls-files)"
''')
    recipe = {'pass': '@true', 'fail': '@false', 'dirty': '@echo changed > public.txt'}[gate]
    (repo / 'Makefile').write_text(f'test:\n\t{recipe}\n')
    git(repo, 'init', '-q')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
    head = git(repo, 'rev-parse', 'HEAD')
    (repo / 'public.txt').write_text('uncommitted fixture')
    # A git wrapper rejects any attempt to contact remotes or create release refs.
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    real_git = shutil.which('git')
    (bin_dir / 'git').write_text(f'''#!/bin/bash
for arg in "$@"; do
  case "$arg" in fetch|push|tag|ls-remote) echo "FORBIDDEN release action" >&2; exit 91;; esac
done
exec "{real_git}" "$@"
''')
    (bin_dir / 'git').chmod(0o755)
    out = tmp_path / 'export'
    env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}'}
    result = subprocess.run(['bash', str(scripts / 'public-snapshot.sh'), '--verify-only', str(out)], env=env, text=True, capture_output=True)
    assert (result.returncode == 0) == (gate == 'pass'), result.stdout + result.stderr
    assert 'FORBIDDEN' not in result.stdout + result.stderr
    assert git(repo, 'rev-parse', 'HEAD') == head
    assert git(repo, 'tag') == ''
    assert not list(tmp_path.glob('*-notes.md'))
    assert not (out / 'private.txt').exists()
    assert (out / '_docs/adr/CHANGES.md').exists()
    if gate == 'pass':
        assert git(out, 'status', '--porcelain') == ''
        again = subprocess.run(['bash', str(scripts / 'public-snapshot.sh'), '--verify-only', str(out)], env=env, capture_output=True, text=True)
        assert again.returncode != 0
        assert 'refusing to overwrite' in again.stdout + again.stderr
