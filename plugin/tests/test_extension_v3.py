"""Contract v3 (communication plane): dispatch, validation, strip, and the
byte-identical record guarantee.

Same discipline as test_extension_v2: the emitter never interprets a v3
key. A ``contractVersion: 3`` file validates against the vendored v1alpha3
schema, then projects onto the v1 shape (strip_extension_v3) before the
unchanged record pipeline runs. The communication plane's consumers are the
hg CLI's topology compiler and event router - which deliver events TO the
Hermes agent gateway, never replacing it - so the rendered record (the
agent runtime contract) must stay byte-for-byte v1.
"""

import json
import pathlib

import pytest

from gitops_emitter import render
from gitops_emitter.harness.hermes import GitopsEmitterError, load_extension_file
from gitops_emitter.render import (
    EXTENSION_KEYS_V3,
    V3_ONLY_APP_KEYS,
    strip_extension_v3,
    validate_extension_v3,
)

SCHEMAS = pathlib.Path(__file__).resolve().parents[2] / "agent-bundle-contracts"

V1_BLOCKS = {
    "apps": [
        {"name": "monitoring", "chart": "charts/monitoring", "repo": "local"},
    ],
    "backup": {"schedule": "0 3 * * *", "retention": 14},
}

COMMUNICATION = {
    "routes": [
        {
            "name": "operational-alerts",
            "from": {"app": "monitoring", "output": "alerts"},
            "delivery": {
                "mode": "queued",
                "ordering": {
                    "mode": "fifo",
                    "key": "subject",
                    "onFailure": "dead-letter-and-continue",
                },
            },
            "outputs": [
                {
                    "agent": {
                        "profile": "platform-sre",
                        "handler": "alerts",
                        "session": {"mode": "keyed", "key": "subject"},
                    }
                },
                {"chatops": "company_discord#123456789012345678"},
            ],
        }
    ],
    "externalInputs": [
        {
            "name": "demo-alert-source",
            "event": "source.demo.alert/v1",
            "verification": {
                "type": "hmac-sha256",
                "secretRef": {"name": "demo-alert-source-webhook", "key": "secret"},
            },
        }
    ],
}


def _v3_mapping():
    doc = {**V1_BLOCKS, "contractVersion": 3, "communication": COMMUNICATION}
    doc["apps"] = [dict(V1_BLOCKS["apps"][0])]
    doc["apps"][0]["outputs"] = [
        {
            "name": "alerts",
            "event": "observability.alert/v1",
            "adapter": {
                "type": "webhook",
                "inject": {"appValue": {"path": "alert.webhookUrl"}},
            },
        }
    ]
    return doc


class TestMirrorGuards:
    def test_v3_keys_equal_schema_properties(self):
        schema = json.loads(
            (SCHEMAS / "hermes-gitops-extension/v1alpha3/hermes-gitops.schema.json").read_text()
        )
        assert sorted(EXTENSION_KEYS_V3) == sorted(schema["properties"])

    def test_v3_app_entry_keys_cover_schema(self):
        schema = json.loads(
            (SCHEMAS / "hermes-gitops-extension/v1alpha3/hermes-gitops.schema.json").read_text()
        )
        app_props = set(schema["properties"]["apps"]["items"]["properties"])
        v1_app_props = {"name", "chart", "repo", "version", "values", "valuesRequired"}
        assert app_props == v1_app_props | set(V3_ONLY_APP_KEYS)


class TestValidateExtensionV3:
    def test_full_v3_mapping_validates(self):
        validate_extension_v3(_v3_mapping())

    def test_external_input_without_verification_rejected(self):
        doc = {
            "contractVersion": 3,
            "communication": {
                "externalInputs": [
                    {"name": "demo", "event": "source.demo.alert/v1"}
                ]
            },
        }
        with pytest.raises(GitopsEmitterError, match="verification"):
            validate_extension_v3(doc)

    def test_contract_version_two_rejected(self):
        with pytest.raises(GitopsEmitterError, match="contractVersion"):
            validate_extension_v3({"contractVersion": 2})


class TestLoadExtensionFileDispatch:
    def _write(self, tmp_path, doc):
        import yaml

        (tmp_path / "hermes-gitops.yaml").write_text(yaml.safe_dump(doc))
        return tmp_path

    def test_v3_file_loads_as_stripped_v1_shape(self, tmp_path):
        loaded = load_extension_file(self._write(tmp_path, _v3_mapping()))
        assert loaded == V1_BLOCKS
        for entry in loaded["apps"]:
            assert "outputs" not in entry

    def test_v3_unknown_key_fails_naming_the_v3_allowlist(self, tmp_path):
        doc = {"contractVersion": 3, "chatopsConnections": {}}
        with pytest.raises(GitopsEmitterError, match="chatopsConnections.*communication"):
            load_extension_file(self._write(tmp_path, doc))

    def test_v2_file_with_communication_fails(self, tmp_path):
        doc = {"contractVersion": 2, "communication": COMMUNICATION}
        with pytest.raises(GitopsEmitterError, match="communication"):
            load_extension_file(self._write(tmp_path, doc))

    def test_unsupported_version_fails_loudly(self, tmp_path):
        # 4 became supported with the optional-requirements bump (#143), 5
        # with the runtime block (ADR-149); the first UNsupported version
        # is now 6.
        with pytest.raises(GitopsEmitterError, match="unsupported contractVersion"):
            load_extension_file(self._write(tmp_path, {"contractVersion": 6}))


class TestByteIdenticalRecord:
    HOOK = {
        "source_url": "https://example.invalid/repo.git",
        "sha": "0" * 40,
        "distribution_version": "1.0.0",
    }

    def _record_for(self, root, defaults=None, overrides=None):
        ext = load_extension_file(root) or {}
        merged = render.deep_merge(render.deep_merge(defaults or {}, ext), overrides or {})
        app_values = merged.pop("appValues", None)
        apps = merged.pop("apps", None)
        merged["apps"] = render.resolve_apps(apps, app_values, persona="persona-x")
        record = render.build_record("persona-x", self.HOOK, merged, env_requires=["ANTHROPIC_API_KEY"])
        render.validate(record)
        return render.render_yaml(record)

    def test_v1_and_v3_authoring_render_identical_records(self, tmp_path):
        import yaml

        v1_dir = tmp_path / "v1"
        v3_dir = tmp_path / "v3"
        for d, doc in ((v1_dir, V1_BLOCKS), (v3_dir, _v3_mapping())):
            d.mkdir()
            (d / "hermes-gitops.yaml").write_text(yaml.safe_dump(doc))

        assert self._record_for(v1_dir) == self._record_for(v3_dir)

    def test_strip_v3_drops_communication_and_outputs(self):
        stripped = strip_extension_v3(_v3_mapping())
        assert "communication" not in stripped
        assert "contractVersion" not in stripped
        assert all("outputs" not in a for a in stripped["apps"])
