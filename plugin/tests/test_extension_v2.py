"""Contract v2 (ADR-33): dispatch, validation, strip, and the byte-identical
record guarantee.

The emitter never interprets a v2 key: a ``contractVersion: 2`` file is
validated against the vendored v1alpha2 schema, then projected onto the v1
shape (strip_extension_v2) before the unchanged record pipeline runs. The
load-bearing assertions here are the mirror guards (the hand-maintained key
tuples equal the schema files' property keys - the containment for the
three-mirror problem) and the byte-identical render (a v2 authoring of the
same five blocks produces the exact record its v1 authoring does).
"""

import json
import pathlib

import pytest

from gitops_emitter import render
from gitops_emitter.harness import hermes as emitter
from gitops_emitter.harness.hermes import GitopsEmitterError, load_extension_file
from gitops_emitter.render import (
    EXTENSION_KEYS,
    EXTENSION_KEYS_V2,
    V2_ONLY_APP_KEYS,
    strip_extension_v2,
    validate_extension_v2,
)

SCHEMAS = pathlib.Path(__file__).resolve().parents[2] / "agent-bundle-contracts"

V1_BLOCKS = {
    "apps": [
        {
            "name": "content-kanban",
            "chart": "content-kanban",
            "repo": "oci://ghcr.io/factory-level/charts",
            "version": "0.3.0",
            "values": {"alerts": {"webhookUrl": ""}},
        },
        {"name": "monitoring", "chart": "charts/monitoring", "repo": "local"},
    ],
    "deployment": {"diskSizeGb": 10},
    "backup": {"schedule": "0 3 * * *", "retention": 14},
    "gitAuthSecretRef": "hermes-example-git-auth",
}

V2_ADDITIONS = {
    "contractVersion": 2,
    "topology": {
        "supportedLayouts": ["single", "hub-spoke"],
        "agent": {"multiplicity": "per-region", "dataBoundary": "region"},
    },
    "endpoints": [
        {"name": "dashboard", "port": 9119, "path": "/", "type": "authenticated"}
    ],
    "requires": [
        {
            "capability": "alert-receiver",
            "locality": "same-region",
            "inject": {"appValue": {"app": "monitoring", "path": "alert.webhookUrl"}},
        }
    ],
}


def _v2_mapping():
    doc = {**V1_BLOCKS, **V2_ADDITIONS}
    # Per-app v2 keys ride along and must be stripped too.
    doc["apps"] = [dict(V1_BLOCKS["apps"][0]), dict(V1_BLOCKS["apps"][1])]
    doc["apps"][0]["topology"] = {"multiplicity": "singleton", "dataBoundary": "global"}
    doc["apps"][0]["endpoints"] = [
        {
            "name": "api",
            "service": "content-kanban",
            "port": 80,
            "path": "/api",
            "type": "private",
            "provides": "content-board",
        }
    ]
    return doc


class TestMirrorGuards:
    def test_v1_keys_equal_schema_properties(self):
        schema = json.loads(
            (SCHEMAS / "hermes-gitops-extension/v1alpha1/hermes-gitops.schema.json").read_text()
        )
        assert sorted(EXTENSION_KEYS) == sorted(schema["properties"])

    def test_v2_keys_equal_schema_properties(self):
        schema = json.loads(
            (SCHEMAS / "hermes-gitops-extension/v1alpha2/hermes-gitops.schema.json").read_text()
        )
        assert sorted(EXTENSION_KEYS_V2) == sorted(schema["properties"])

    def test_v2_app_entry_keys_cover_schema(self):
        schema = json.loads(
            (SCHEMAS / "hermes-gitops-extension/v1alpha2/hermes-gitops.schema.json").read_text()
        )
        app_props = set(schema["properties"]["apps"]["items"]["properties"])
        v1_app_props = {"name", "chart", "repo", "version", "values", "valuesRequired"}
        assert app_props == v1_app_props | set(V2_ONLY_APP_KEYS)


class TestValidateExtensionV2:
    def test_full_v2_mapping_validates(self):
        validate_extension_v2(_v2_mapping())

    def test_webhook_without_signature_rejected(self):
        doc = {
            "contractVersion": 2,
            "endpoints": [{"name": "hooks", "port": 8644, "type": "webhook"}],
        }
        with pytest.raises(GitopsEmitterError, match="signature"):
            validate_extension_v2(doc)

    def test_contract_version_one_rejected(self):
        with pytest.raises(GitopsEmitterError, match="contractVersion"):
            validate_extension_v2({"contractVersion": 1})


class TestLoadExtensionFileDispatch:
    def _write(self, tmp_path, doc):
        import yaml

        (tmp_path / "hermes-gitops.yaml").write_text(yaml.safe_dump(doc))
        return tmp_path

    def test_v2_file_loads_as_stripped_v1_shape(self, tmp_path):
        loaded = load_extension_file(self._write(tmp_path, _v2_mapping()))
        assert loaded == V1_BLOCKS
        for entry in loaded["apps"]:
            assert "topology" not in entry and "endpoints" not in entry

    def test_v2_unknown_key_fails_naming_the_v2_allowlist(self, tmp_path):
        doc = {"contractVersion": 2, "placement": {"target": "eu"}}
        with pytest.raises(GitopsEmitterError, match="placement.*contractVersion"):
            load_extension_file(self._write(tmp_path, doc))

    def test_v1_file_unchanged_behaviour(self, tmp_path):
        loaded = load_extension_file(self._write(tmp_path, dict(V1_BLOCKS)))
        assert loaded == V1_BLOCKS

    def test_v1_file_with_v2_keys_fails(self, tmp_path):
        doc = {**V1_BLOCKS, "topology": {"supportedLayouts": ["single"]}}
        with pytest.raises(GitopsEmitterError, match="topology"):
            load_extension_file(self._write(tmp_path, doc))


class TestByteIdenticalRecord:
    HOOK = {
        "source_url": "https://example.invalid/repo.git",
        "sha": "0" * 40,
        "distribution_version": "1.0.0",
    }

    def _record_for(self, root, defaults=None, overrides=None):
        """emit()'s exact chain (emitter.py: two deep_merges, pop appValues
        and apps, resolve, build) - not a shortcut, so leaks through ANY
        merge layer would land in the output and fail the comparison."""
        ext = load_extension_file(root) or {}
        merged = render.deep_merge(render.deep_merge(defaults or {}, ext), overrides or {})
        app_values = merged.pop("appValues", None)
        apps = merged.pop("apps", None)
        merged["apps"] = render.resolve_apps(apps, app_values, persona="persona-x")
        record = render.build_record("persona-x", self.HOOK, merged, env_requires=["ANTHROPIC_API_KEY"])
        render.validate(record)
        return render.render_yaml(record)

    def test_v1_and_v2_authoring_render_identical_records(self, tmp_path):
        """The whole point of D2: strip is a no-op on the record - including
        when fleet defaults and per-instance overrides smuggle v2 keys into
        the merge chain (build_record selects known blocks; this pins it)."""
        import yaml

        v1_dir = tmp_path / "v1"
        v2_dir = tmp_path / "v2"
        for d, doc in ((v1_dir, V1_BLOCKS), (v2_dir, _v2_mapping())):
            d.mkdir()
            (d / "hermes-gitops.yaml").write_text(yaml.safe_dump(doc))

        clean = self._record_for(v1_dir)
        assert clean == self._record_for(v2_dir)

        defaults_with_v2 = {
            "appValues": {"monitoring": {"alert": {"threshold": 5}}},
            "topology": {"supportedLayouts": ["replicated"]},
        }
        overrides_with_v2 = {"endpoints": [], "requires": []}
        tainted = self._record_for(v2_dir, defaults_with_v2, overrides_with_v2)
        expected = self._record_for(v1_dir, {"appValues": {"monitoring": {"alert": {"threshold": 5}}}})
        assert tainted == expected
        assert "topology" not in tainted and "endpoints" not in tainted
