"""Contract v4 (#143, optional requirements): dispatch, validation, strip.

v4 adds exactly one field - ``requires[].optional`` - inside a block the
strip already drops whole, so the byte-identical-record guarantee needs no
new proof beyond strip parity with v3: same keys in, same v1 shape out.
The field's CONSUMER is the topology compiler in the hg CLI (an
unsatisfied optional requirement is a warning and an absent injection,
never TOPO004); the emitter only validates and strips.
"""

import pytest

from gitops_emitter.harness.hermes import GitopsEmitterError, load_extension_file
from gitops_emitter.render import (
    EXTENSION_KEYS_V3,
    EXTENSION_KEYS_V4,
    V3_ONLY_APP_KEYS,
    V4_ONLY_APP_KEYS,
    strip_extension_v3,
    strip_extension_v4,
    validate_extension_v4,
)

V4_MAPPING = {
    "contractVersion": 4,
    "requires": [
        {
            "capability": "sentiment-feed",
            "optional": True,
            "inject": {"env": "HERMES_CAP_SENTIMENT_FEED_URL"},
        },
        {
            "capability": "content-board",
            "inject": {"env": "HERMES_CAP_CONTENT_BOARD_URL"},
        },
    ],
    "apps": [{"name": "monitoring", "chart": "charts/monitoring", "repo": "local"}],
    "backup": {"schedule": "0 3 * * *", "retention": 14},
}


class TestValidation:
    def test_v4_with_optional_validates(self):
        validate_extension_v4(V4_MAPPING)

    def test_optional_must_be_boolean(self):
        # A truthy STRING silently coerced would flip a mandatory
        # requirement optional - the one direction a type error must
        # not fail in.
        doc = {
            "contractVersion": 4,
            "requires": [
                {
                    "capability": "sentiment-feed",
                    "optional": "true",
                    "inject": {"env": "HERMES_CAP_SENTIMENT_FEED_URL"},
                }
            ],
        }
        with pytest.raises(GitopsEmitterError, match="optional"):
            validate_extension_v4(doc)

    def test_v3_file_does_not_validate_as_v4(self):
        with pytest.raises(GitopsEmitterError, match="contractVersion"):
            validate_extension_v4({"contractVersion": 3})


class TestDispatchAndStrip:
    def _write(self, tmp_path, doc):
        import yaml

        (tmp_path / "hermes-gitops.yaml").write_text(yaml.safe_dump(doc))
        return tmp_path

    def test_v4_file_loads_and_strips_to_v1_shape(self, tmp_path):
        stripped = load_extension_file(self._write(tmp_path, V4_MAPPING))
        assert "requires" not in stripped
        assert "contractVersion" not in stripped
        assert stripped["apps"] == V4_MAPPING["apps"]
        assert stripped["backup"] == V4_MAPPING["backup"]

    def test_v4_allowlist_is_v3_minus_expose(self):
        # ADR-99: v4 ends the additive window - expose leaves, nothing
        # else moves. Divergence beyond that one key means a v4-only key
        # leaked into (or out of) the record pipeline.
        assert set(EXTENSION_KEYS_V3) - set(EXTENSION_KEYS_V4) == {"expose"}
        assert V4_ONLY_APP_KEYS == V3_ONLY_APP_KEYS
        doc = {k: v for k, v in V4_MAPPING.items()}
        assert strip_extension_v4(doc) == strip_extension_v3(doc)

    def test_v4_file_with_expose_fails_loudly(self, tmp_path):
        # Silently dropping expose would UNEXPOSE services on the next
        # deploy - the one direction this migration must not fail in.
        doc = {
            "contractVersion": 4,
            "expose": {"services": [{"name": "dashboard", "port": 9119}]},
        }
        with pytest.raises(GitopsEmitterError, match="expose"):
            load_extension_file(self._write(tmp_path, doc))
