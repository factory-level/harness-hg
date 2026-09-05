#!/usr/bin/env bash
# Builds the gitops-emitter wheel and proves the PACKAGED resources work
# from an installed wheel, not a source checkout (issue #28 [L1]):
#
#   1. The wheel contains gitops_emitter/gitops_template/** and
#      gitops_emitter/schema/hermesprofile-v1alpha3.schema.json —
#      force-included at build time from the canonical infra/gitops-template/ and
#      schemas/hermesprofile/v1alpha3/profile.schema.json (nothing is
#      committed twice).
#   2. From a clean venv with ONLY the wheel installed (no repo on
#      sys.path), render.validate() resolves the packaged schema and
#      scaffold.ensure_repo_and_scaffold() scaffolds a local bare git repo
#      from the packaged template — the exact runtime paths `hermes
#      profile install` exercises on an operator's machine.
#
# Requires: uv, git. Offline (file:// git remotes only).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

WORKDIR="$(mktemp -d -t gitops-emitter-wheel-smoke-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

log() { echo "[wheel-smoke] $*" >&2; }

log "building wheel"
uv build --wheel --out-dir "$WORKDIR/dist" >/dev/null 2>&1
WHEEL="$(ls "$WORKDIR"/dist/*.whl)"

log "checking packaged paths in $(basename "$WHEEL")"
python3 - "$WHEEL" <<'PY'
import sys, zipfile
names = set(zipfile.ZipFile(sys.argv[1]).namelist())
required = [
    "gitops_emitter/schema/hermesprofile-v1alpha3.schema.json",
    "gitops_emitter/gitops_template/bootstrap/project.yaml",
    "gitops_emitter/gitops_template/bootstrap/applicationset.yaml",
    "gitops_emitter/gitops_template/bootstrap/values/cluster-values.yaml",
]
missing = [r for r in required if r not in names]
assert not missing, f"wheel is missing packaged resources: {missing}"
print("[wheel-smoke] wheel contains all packaged resources")
PY

log "installing wheel into a clean venv"
uv venv --quiet "$WORKDIR/venv"
uv pip install --quiet --python "$WORKDIR/venv/bin/python" "$WHEEL" jsonschema

log "creating local bare GitOps repo"
git init --bare --quiet --initial-branch=main "$WORKDIR/gitops.git"

log "running installed-wheel smoke (validate + scaffold)"
# cd away from the repo so a stray CWD sys.path entry can't shadow the
# installed package with the source checkout.
cd "$WORKDIR"
GITOPS_URL="file://$WORKDIR/gitops.git" "$WORKDIR/venv/bin/python" - <<'PY'
import os
import pathlib
import subprocess

import gitops_emitter
from gitops_emitter import render, scaffold

# Prove we're exercising the installed wheel, not the source checkout.
pkg = pathlib.Path(gitops_emitter.__file__).resolve()
assert "site-packages" in str(pkg), f"gitops_emitter resolved outside the venv: {pkg}"

# 1. Schema loads from the packaged copy and validates a record.
render.validate(
    {
        "spec": {
            "persona": "wheel-smoke",
            "source": "github.com/example/wheel-smoke",
            "sha": "0123456789abcdef0123456789abcdef01234567",
        }
    }
)
print("[wheel-smoke] packaged schema validated a record OK")

# 2. Scaffold a local bare repo from the packaged template.
cfg = {
    "repo_url": os.environ["GITOPS_URL"],
    "branch": "main",
    "hermes_gitops_repo_url": "https://github.com/factory-level/harness-hg.git",
    "chart_revision": "main",
    "git_author_name": "wheel-smoke",
    "git_author_email": "wheel-smoke@hermes-gitops.local",
}
scaffold.ensure_repo_and_scaffold(cfg, token=None)

out = subprocess.run(
    ["git", "ls-tree", "-r", "--name-only", "main"],
    cwd=os.environ["GITOPS_URL"].removeprefix("file://"),
    capture_output=True,
    text=True,
    check=True,
).stdout.split()
for required in (
    "bootstrap/project.yaml",
    "bootstrap/applicationset.yaml",
    "bootstrap/values/cluster-values.yaml",
    "README.md",
):
    assert required in out, f"scaffold missing {required}; got {out}"
print("[wheel-smoke] packaged template scaffolded the bare repo OK")
PY

log "PASS"
