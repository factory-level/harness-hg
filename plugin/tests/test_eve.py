"""The EveAgent record builder (gitops_emitter/harness/eve.py, ADR-149): manifest
checks, extension dispatch, record shape, determinism, schema rejection.
Pure - no Git, no network."""

from __future__ import annotations

import json
import pathlib
import shutil
import sys

import pytest
import yaml

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from gitops_emitter.harness import eve  # noqa: E402
from gitops_emitter.harness.hermes import GitopsEmitterError  # noqa: E402
from gitops_emitter.render import render_yaml  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
EXAMPLE = REPO_ROOT / "examples" / "eve-agent" / "agents" / "echo"
SHA = "3f06a1b2c3d4e5f60718293a4b5c6d7e8f901234"
SRC = "https://github.com/factorylevel/eve-agents.git"


@pytest.fixture()
def project(tmp_path):
    """A copy of the example project the tests can mutate."""
    dst = tmp_path / "agents" / "echo"
    shutil.copytree(EXAMPLE, dst)
    return dst


def _set_pkg(project, **fields):
    pkg = json.loads((project / "package.json").read_text())
    pkg.update(fields)
    (project / "package.json").write_text(json.dumps(pkg))


class TestManifest:
    def test_example_is_a_valid_eve_project(self):
        m = eve.read_eve_manifest(EXAMPLE)
        assert m["name"] == "echo"
        assert m["eve_dependency"]

    def test_name_is_the_identity_and_must_be_a_dns_label(self, project):
        _set_pkg(project, name="@factorylevel/echo")
        with pytest.raises(GitopsEmitterError, match="not usable as an agent identity"):
            eve.read_eve_manifest(project)

    def test_missing_name_fails(self, project):
        pkg = json.loads((project / "package.json").read_text())
        del pkg["name"]
        (project / "package.json").write_text(json.dumps(pkg))
        with pytest.raises(GitopsEmitterError, match='"name"'):
            eve.read_eve_manifest(project)

    def test_no_package_json_fails(self, tmp_path):
        with pytest.raises(GitopsEmitterError, match="no package.json"):
            eve.read_eve_manifest(tmp_path)

    def test_no_agent_dir_fails(self, project):
        shutil.rmtree(project / "agent")
        with pytest.raises(GitopsEmitterError, match="no agent/ directory"):
            eve.read_eve_manifest(project)

    def test_no_instructions_fails_before_the_cluster_would(self, project):
        (project / "agent" / "instructions.md").unlink()
        with pytest.raises(GitopsEmitterError, match="instructions"):
            eve.read_eve_manifest(project)

    def test_no_lockfile_fails_before_the_cluster_would(self, project):
        (project / "package-lock.json").unlink()
        with pytest.raises(GitopsEmitterError, match="package-lock.json"):
            eve.read_eve_manifest(project)

    def test_instructions_must_have_the_right_shape(self, project):
        (project / "agent" / "instructions.md").unlink()
        (project / "agent" / "instructions.md").mkdir()  # a directory is not the file form
        with pytest.raises(GitopsEmitterError, match="instructions"):
            eve.read_eve_manifest(project)
        (project / "agent" / "instructions.md").rmdir()
        (project / "agent" / "instructions").mkdir()  # the directory form IS accepted
        assert eve.read_eve_manifest(project)["name"] == "echo"

    def test_eve_must_be_a_dependency(self, project):
        pkg = json.loads((project / "package.json").read_text())
        del pkg["dependencies"]["eve"]
        (project / "package.json").write_text(json.dumps(pkg))
        with pytest.raises(GitopsEmitterError, match='depend on "eve"'):
            eve.read_eve_manifest(project)

    def test_lockfile_must_resolve_eve(self, project):
        lock = json.loads((project / "package-lock.json").read_text())
        del lock["packages"]["node_modules/eve"]
        (project / "package-lock.json").write_text(json.dumps(lock))
        with pytest.raises(GitopsEmitterError, match="does not resolve"):
            eve.read_eve_manifest(project)

    def test_locked_version_is_reported(self):
        m = eve.read_eve_manifest(EXAMPLE)
        assert m["eve_locked"] == m["eve_dependency"]


class TestVersionPin:
    def _manifest(self, locked="0.42.0"):
        return {"name": "echo", "eve_dependency": locked, "eve_locked": locked}

    def test_no_expectation_no_override_passes(self):
        eve.check_eve_version(self._manifest(), expected=None, extension={})

    def test_platform_pin_must_match_lock(self):
        eve.check_eve_version(self._manifest("0.42.0"), expected="0.42.0", extension={})
        with pytest.raises(GitopsEmitterError, match="platform's pinned runtime is eve@0.43.0"):
            eve.check_eve_version(self._manifest("0.42.0"), expected="0.43.0", extension={})

    def test_runtime_image_tag_override_wins_over_the_pin(self):
        ext = {"deployment": {"runtimeImageTag": "0.41.0"}}
        eve.check_eve_version(self._manifest("0.41.0"), expected="0.42.0", extension=ext)
        with pytest.raises(GitopsEmitterError, match="runtimeImageTag is eve@0.41.0"):
            eve.check_eve_version(self._manifest("0.42.0"), expected="0.42.0", extension=ext)


class TestExtension:
    def test_example_extension_loads_whole(self):
        ext = eve.load_eve_extension(EXAMPLE)
        assert ext["contractVersion"] == 5
        assert ext["runtime"]["kind"] == "eve"

    def test_missing_file_is_an_error_for_eve(self, project):
        (project / "hermes-gitops.yaml").unlink()
        with pytest.raises(GitopsEmitterError, match="is missing"):
            eve.load_eve_extension(project)

    def test_v4_marker_is_refused(self, project):
        (project / "hermes-gitops.yaml").write_text("contractVersion: 4\n")
        with pytest.raises(GitopsEmitterError, match="contractVersion: 5"):
            eve.load_eve_extension(project)

    def test_hermes_profile_is_refused(self, project):
        (project / "hermes-gitops.yaml").write_text("contractVersion: 5\n")
        with pytest.raises(GitopsEmitterError, match="runtime"):
            eve.load_eve_extension(project)

    def test_schema_violations_surface(self, project):
        (project / "hermes-gitops.yaml").write_text(
            "contractVersion: 5\nruntime:\n  kind: eve\n  envRequires: [lower]\n"
        )
        with pytest.raises(GitopsEmitterError, match="schema validation"):
            eve.load_eve_extension(project)


class TestRecord:
    def _record(self, ext=None, **kw):
        ext = ext if ext is not None else eve.load_eve_extension(EXAMPLE)
        args = dict(source=SRC, sha=SHA, ref="main", subdir="agents/echo", extension=ext)
        args.update(kw)
        return eve.build_eve_record("echo", **args)

    def test_shape_and_normalized_env_requires(self):
        rec = self._record()
        eve.validate_eve_record(rec)
        assert rec == {
            "spec": {
                "persona": "echo",
                "runtime": "eve",
                "source": SRC,
                "sha": SHA,
                "ref": "main",
                "sourceSubdir": "agents/echo",
                "envRequires": [
                    {
                        "name": "ANTHROPIC_API_KEY",
                        "required": True,
                        "secret": True,
                        "description": "Anthropic API key; agent.ts calls the provider directly.",
                    }
                ],
                # The example declares a local child app and archive intent
                # (ADR-150): apps resolved (author values kept, no overrides),
                # backup copied in schema field order.
                "apps": [
                    {
                        "name": "docs-site",
                        "chart": "cli/test-env/charts/test-page",
                        "repo": "local",
                        "values": {"page": {"title": "echo's page"}},
                    }
                ],
                "backup": {"schedule": "0 3 * * *", "retention": 7},
            }
        }

    def test_optional_fields_absent_when_unset(self):
        rec = self._record(
            ext={"contractVersion": 5, "runtime": {"kind": "eve"}}, ref=None, subdir=None
        )
        eve.validate_eve_record(rec)
        assert set(rec["spec"]) == {"persona", "runtime", "source", "sha"}

    def test_deployment_and_git_auth_carry_over(self):
        ext = {
            "contractVersion": 5,
            "runtime": {"kind": "eve", "envRequires": ["AI_GATEWAY_API_KEY"]},
            "deployment": {"runtimeImageTag": "0.42.0", "diskSizeGb": 20},
            "gitAuthSecretRef": "hermes-echo-git-auth",
        }
        rec = self._record(ext=ext)
        eve.validate_eve_record(rec)
        assert rec["spec"]["deployment"] == {"runtimeImageTag": "0.42.0", "diskSizeGb": 20}
        assert rec["spec"]["gitAuthSecretRef"] == "hermes-echo-git-auth"
        assert rec["spec"]["envRequires"] == [
            {"name": "AI_GATEWAY_API_KEY", "required": True, "secret": True}
        ]

    def test_apps_are_resolved_like_the_hermes_pipeline(self):
        # ADR-150: spec.apps is the RESOLVED list (author values + app_values
        # deep-merged, valuesRequired satisfied and dropped), in author
        # order, with the same field order the HermesProfile record uses.
        ext = {
            "contractVersion": 5,
            "runtime": {"kind": "eve"},
            "apps": [
                {
                    "name": "vector-db",
                    "chart": "qdrant",
                    "repo": "https://qdrant.github.io/qdrant-helm",
                    "version": "1.9.1",
                    "values": {"replicas": 1, "auth": {"apiKey": None}},
                    "valuesRequired": ["auth.apiKey"],
                },
                {"name": "docs-site", "chart": "cli/test-env/charts/test-page", "repo": "local"},
            ],
        }
        rec = self._record(ext=ext, app_values={"vector-db": {"auth": {"apiKey": "k"}}})
        eve.validate_eve_record(rec)
        assert rec["spec"]["apps"] == [
            {
                "name": "vector-db",
                "chart": "qdrant",
                "repo": "https://qdrant.github.io/qdrant-helm",
                "version": "1.9.1",
                "values": {"replicas": 1, "auth": {"apiKey": "k"}},
            },
            {"name": "docs-site", "chart": "cli/test-env/charts/test-page", "repo": "local"},
        ]
        assert "valuesRequired" not in rec["spec"]["apps"][0]

    def test_unsatisfied_values_required_is_refused_before_render(self):
        ext = {
            "contractVersion": 5,
            "runtime": {"kind": "eve"},
            "apps": [
                {
                    "name": "vector-db",
                    "chart": "qdrant",
                    "repo": "https://qdrant.github.io/qdrant-helm",
                    "version": "1.9.1",
                    "valuesRequired": ["auth.apiKey"],
                }
            ],
        }
        with pytest.raises(GitopsEmitterError, match="auth.apiKey"):
            self._record(ext=ext)

    def test_backup_intent_is_copied_in_field_order(self):
        ext = {
            "contractVersion": 5,
            "runtime": {"kind": "eve"},
            "backup": {"retention": 3, "schedule": "0 3 * * *"},
        }
        rec = self._record(ext=ext)
        eve.validate_eve_record(rec)
        assert list(rec["spec"]["backup"].items()) == [("schedule", "0 3 * * *"), ("retention", 3)]

    def test_no_apps_no_backup_renders_as_before(self):
        # Deployment-neutrality of the v1alpha2 move: a v5 file declaring
        # neither key yields a record without either key.
        rec = self._record(ext={"contractVersion": 5, "runtime": {"kind": "eve"}})
        assert "apps" not in rec["spec"] and "backup" not in rec["spec"]

    def test_hermes_image_tag_is_refused_for_eve(self):
        ext = {
            "contractVersion": 5,
            "runtime": {"kind": "eve"},
            "deployment": {"baseImageTag": "wave-3"},
        }
        with pytest.raises(GitopsEmitterError, match="runtimeImageTag"):
            self._record(ext=ext)

    def test_record_bytes_are_deterministic(self):
        a = render_yaml(self._record())
        b = render_yaml(self._record())
        assert a == b
        # and round-trips to the same record
        assert yaml.safe_load(a) == self._record()

    def test_schema_rejects_what_the_builder_cannot_produce(self):
        rec = self._record()
        rec["spec"]["expose"] = {}
        with pytest.raises(GitopsEmitterError, match="schema validation"):
            eve.validate_eve_record(rec)
        rec = self._record()
        rec["spec"]["backup"] = {"retention": 2}
        with pytest.raises(GitopsEmitterError, match="schema validation"):
            eve.validate_eve_record(rec)
        rec = self._record()
        rec["spec"]["sha"] = "short"
        with pytest.raises(GitopsEmitterError, match="sha"):
            eve.validate_eve_record(rec)
