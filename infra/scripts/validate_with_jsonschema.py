#!/usr/bin/env python3
"""Fallback fixture validator used when `check-jsonschema` can't be installed
(e.g. no network access). Validates one YAML fixture against one JSON Schema
file using the `jsonschema` + `pyyaml` libraries.

Usage: validate_with_jsonschema.py <schema.json> <fixture.yaml>
Exit code 0 = fixture is valid against the schema; 1 = invalid or error.

Run via `uv run --with pyyaml --with jsonschema infra/scripts/validate_with_jsonschema.py ...`
so the two third-party deps are resolved into an ephemeral env rather than
requiring a pre-provisioned virtualenv.
"""
import json
import sys

import yaml
from jsonschema import Draft202012Validator


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <schema.json> <fixture.yaml>", file=sys.stderr)
        return 2

    schema_path, fixture_path = sys.argv[1], sys.argv[2]

    with open(schema_path, "r", encoding="utf-8") as f:
        schema = json.load(f)

    with open(fixture_path, "r", encoding="utf-8") as f:
        instance = yaml.safe_load(f)

    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(instance), key=lambda e: e.path)

    if not errors:
        print(f"{fixture_path}: OK")
        return 0

    print(f"{fixture_path}: INVALID", file=sys.stderr)
    for err in errors:
        path = "/".join(str(p) for p in err.absolute_path) or "<root>"
        print(f"  - at {path}: {err.message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
