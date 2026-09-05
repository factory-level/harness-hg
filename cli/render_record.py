#!/usr/bin/env python3
"""Render a HermesProfile record for the local-testing CLI (spec §27).

The CLI's bridge into the REAL render pipeline: same
load-extension → resolve_apps (appValues merge, valuesRequired
enforcement) → build_record → validate → render_yaml path the
gitops-emitter runs on a fleet install, so what the local loop deploys is
byte-shaped like what the fleet would. Run via `uv run python
cli/render_record.py` from the platform repo root (gitops_emitter is the
repo's own package).

Args (all required unless noted):
  --profile <dir>        profile directory (distribution.yaml + hermes-gitops.yaml)
  --name <name>          instance name (spec.persona)
  --source <url>         spec.source (the CLI's local dumb-http mirror)
  --sha <sha>            spec.sha (the mirror's HEAD)
  --contract-dir <dir>   optional: the agent-team harness-hg/ dir (ADR 0178)
  --app-values <json>    optional appValues map merged onto author values
Prints the record YAML on stdout; exits non-zero with the emitter's own
loud error message on any contract violation (missing valuesRequired,
unknown keys, schema mismatch).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from gitops_emitter.harness.hermes import (
    GitopsEmitterError,
    _extract_env_requires,
    load_extension_file,
    read_target_manifest,
)
from gitops_emitter.render import build_record, render_yaml, resolve_apps, validate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--sha", required=True)
    # Catalogue member: the profile's subdirectory inside the served
    # source repo -> spec.sourceSubdir (the pod's boot clone installs
    # <clone>/<subdir>), exactly like `hermes profile install --subdir`.
    parser.add_argument("--subdir", default="")
    # Agent-team layout (ADR 0178): the agent's harness-hg/ directory when
    # it is not ../harness-hg beside a src/ payload.
    parser.add_argument("--contract-dir", default=None)
    parser.add_argument("--app-values", default="{}")
    args = parser.parse_args()

    profile_dir = Path(args.profile)
    manifest = read_target_manifest(str(profile_dir))
    env_requires = _extract_env_requires(manifest)
    ext = load_extension_file(profile_dir, args.contract_dir, args.subdir or None) or {}
    app_values = json.loads(args.app_values)

    raw_apps = ext.pop("apps", None)
    ext["apps"] = resolve_apps(raw_apps, app_values, persona=args.name)
    if not ext["apps"]:
        del ext["apps"]

    hook_kwargs = {"name": args.name, "source_url": args.source, "sha": args.sha}
    if args.subdir:
        hook_kwargs["subdir"] = args.subdir
    record = build_record(
        args.name,
        hook_kwargs,
        ext,
        env_requires=env_requires,
    )
    validate(record)
    sys.stdout.write(render_yaml(record))


if __name__ == "__main__":
    try:
        main()
    except (GitopsEmitterError, yaml.YAMLError, json.JSONDecodeError) as exc:
        print(f"render_record: {exc}", file=sys.stderr)
        raise SystemExit(1)
