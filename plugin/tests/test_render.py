"""Tests for gitops_emitter.render (the pure render pipeline) and the
profile-hook handler contract in gitops_emitter/__init__.py.
"""

from __future__ import annotations

from pathlib import Path

import jsonschema
import pytest
import yaml

import gitops_emitter
from gitops_emitter.harness.hermes import GitopsEmitterError
from gitops_emitter.render import (
    EXTENSION_KEYS,
    LOCAL_REPO,
    validate_name,
    build_record,
    deep_merge,
    render_yaml,
    resolve_apps,
    secret_name,
    validate,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _schema() -> dict:
    """The schema the EMITTER validates against, not a copy of it.

    This used to hardcode a version directory, and it had been left on
    `v1alpha1` through the v1alpha2 bump - so every test using it was
    checking records against a contract two versions out of date, and
    would have kept passing while production rejected the same record.
    Borrowing `render`'s own loader makes that impossible: there is one
    answer to "which version is current" and both sides read it.
    """
    from gitops_emitter.render import _load_schema

    return _load_schema()


# ---------------------------------------------------------------------------
# EXTENSION_KEYS — the hermes-gitops.yaml surface
# ---------------------------------------------------------------------------


class TestExtensionKeys:
    def test_new_contract_key_set(self):
        # hermes-gitops.yaml is the ONE carrier; these are its only legal
        # top-level keys (mirrors the extension schema).
        assert EXTENSION_KEYS == (
            "apps",
            "deployment",
            "expose",
            "backup",
            "gitAuthSecretRef",
        )

    def test_legacy_keys_are_gone(self):
        for legacy in ("workloads", "reach", "targetCluster"):
            assert legacy not in EXTENSION_KEYS


# ---------------------------------------------------------------------------
# deep_merge
# ---------------------------------------------------------------------------


class TestDeepMerge:
    def test_scalar_override(self):
        base = {"region": "us-west1", "diskSizeGb": 50}
        override = {"diskSizeGb": 100}
        result = deep_merge(base, override)
        assert result == {"region": "us-west1", "diskSizeGb": 100}

    def test_nested_dict_merge(self):
        base = {"deployment": {"region": "us-west1", "machineType": "e2-standard-4"}}
        override = {"deployment": {"machineType": "e2-standard-8"}}
        result = deep_merge(base, override)
        assert result == {
            "deployment": {"region": "us-west1", "machineType": "e2-standard-8"}
        }

    def test_list_replaced_wholesale_not_merged(self):
        # Positional list merging is forbidden by contract: an override
        # touching a list must restate the whole list.
        base = {"regions": ["us-west", "eu-west"]}
        override = {"regions": ["ap-south"]}
        result = deep_merge(base, override)
        assert result == {"regions": ["ap-south"]}

    def test_absent_layers_pass_through(self):
        base = {"deployment": {"region": "us-west1"}}
        override = {"expose": {"services": []}}
        result = deep_merge(base, override)
        assert result == {
            "deployment": {"region": "us-west1"},
            "expose": {"services": []},
        }

    def test_does_not_mutate_inputs(self):
        base = {"deployment": {"region": "us-west1"}}
        override = {"deployment": {"machineType": "e2-standard-8"}}
        base_copy = {"deployment": {"region": "us-west1"}}
        override_copy = {"deployment": {"machineType": "e2-standard-8"}}
        deep_merge(base, override)
        assert base == base_copy
        assert override == override_copy

    def test_returns_new_dict_not_same_object(self):
        base = {"a": 1}
        result = deep_merge(base, {})
        assert result is not base

    def test_deeply_nested_merge(self):
        base = {"a": {"b": {"c": 1, "d": 2}}}
        override = {"a": {"b": {"c": 99}}}
        result = deep_merge(base, override)
        assert result == {"a": {"b": {"c": 99, "d": 2}}}

    def test_override_dict_replaces_non_dict_base_value(self):
        base = {"expose": "legacy-string"}
        override = {"expose": {"services": []}}
        result = deep_merge(base, override)
        assert result == {"expose": {"services": []}}


# ---------------------------------------------------------------------------
# secret_name
# ---------------------------------------------------------------------------


class TestSecretName:
    def test_spec_example(self):
        assert (
            secret_name("support-agent", "DISCORD_BOT_TOKEN")
            == "hermes-support-agent-discord-bot-token"
        )

    def test_lowercases_env_var(self):
        assert secret_name("foo", "API_KEY") == "hermes-foo-api-key"

    def test_underscores_become_hyphens(self):
        assert (
            secret_name("foo", "SOME_LONG_ENV_VAR_NAME")
            == "hermes-foo-some-long-env-var-name"
        )

    def test_single_word_env_var(self):
        assert secret_name("foo", "TOKEN") == "hermes-foo-token"


# ---------------------------------------------------------------------------
# resolve_apps
# ---------------------------------------------------------------------------


def _remote_app(**overrides) -> dict:
    app = {
        "name": "vector-db",
        "chart": "qdrant",
        "repo": "https://qdrant.github.io/qdrant-helm",
        "version": "1.9.1",
    }
    app.update(overrides)
    return app


def _local_app(**overrides) -> dict:
    app = {
        "name": "docs-site",
        "chart": "charts/test-page",
        "repo": "local",
    }
    app.update(overrides)
    return app


class TestResolveApps:
    def test_empty_or_absent_resolves_to_empty_list(self):
        assert resolve_apps(None) == []
        assert resolve_apps([]) == []

    def test_remote_and_local_apps_resolve(self):
        result = resolve_apps([_remote_app(values={"replicas": 1}), _local_app()])
        assert result == [
            {
                "name": "vector-db",
                "chart": "qdrant",
                "repo": "https://qdrant.github.io/qdrant-helm",
                "version": "1.9.1",
                "values": {"replicas": 1},
            },
            {"name": "docs-site", "chart": "charts/test-page", "repo": "local"},
        ]

    def test_oci_repo_is_remote(self):
        result = resolve_apps(
            [_remote_app(repo="oci://ghcr.io/org/charts", version="2.0.0")]
        )
        assert result[0]["repo"] == "oci://ghcr.io/org/charts"
        assert result[0]["version"] == "2.0.0"

    def test_author_order_preserved(self):
        result = resolve_apps([_local_app(), _remote_app()])
        assert [app["name"] for app in result] == ["docs-site", "vector-db"]

    def test_duplicate_names_raise(self):
        with pytest.raises(GitopsEmitterError, match="duplicate app name 'vector-db'"):
            resolve_apps([_remote_app(), _remote_app(chart="other-chart")])

    def test_non_dns_label_name_raises(self):
        with pytest.raises(GitopsEmitterError, match="DNS-1123"):
            resolve_apps([_remote_app(name="Vector_DB")])

    def test_missing_chart_raises(self):
        app = _remote_app()
        del app["chart"]
        with pytest.raises(GitopsEmitterError, match="chart must be a non-empty string"):
            resolve_apps([app])

    def test_local_with_version_raises(self):
        with pytest.raises(GitopsEmitterError, match="version is not allowed with repo: local"):
            resolve_apps([_local_app(version="1.0.0")])

    def test_remote_without_version_raises(self):
        app = _remote_app()
        del app["version"]
        with pytest.raises(GitopsEmitterError, match="version is required for remote repo"):
            resolve_apps([app])

    def test_bad_repo_scheme_raises(self):
        with pytest.raises(GitopsEmitterError, match="must be 'local' or start with"):
            resolve_apps([_remote_app(repo="git@github.com:org/charts.git")])

    def test_missing_repo_raises(self):
        app = _remote_app()
        del app["repo"]
        with pytest.raises(GitopsEmitterError, match="must be 'local' or start with"):
            resolve_apps([app])

    def test_non_list_apps_raises(self):
        with pytest.raises(GitopsEmitterError, match="apps must be a list"):
            resolve_apps({"name": "x"})

    def test_non_mapping_entry_raises(self):
        with pytest.raises(GitopsEmitterError, match=r"apps\[0\] must be a mapping"):
            resolve_apps(["vector-db"])

    def test_local_repo_constant(self):
        assert LOCAL_REPO == "local"


class TestResolveAppsAppValues:
    """The `appValues: {<appName>: {<values fragment>}}` override mechanism
    (carried by fleet defaults and/or per-instance overrides): fragments
    deep-merge into that app's values; lists are replaced wholesale
    (positional list merging is forbidden)."""

    def test_fragment_deep_merges_into_author_values(self):
        result = resolve_apps(
            [_remote_app(values={"replicas": 1, "auth": {"mode": "token"}})],
            {"vector-db": {"auth": {"apiKeySecretRef": "my-secret"}}},
        )
        assert result[0]["values"] == {
            "replicas": 1,
            "auth": {"mode": "token", "apiKeySecretRef": "my-secret"},
        }

    def test_fragment_wins_on_conflict(self):
        result = resolve_apps(
            [_remote_app(values={"replicas": 1})],
            {"vector-db": {"replicas": 3}},
        )
        assert result[0]["values"] == {"replicas": 3}

    def test_lists_replaced_wholesale_never_positionally_merged(self):
        result = resolve_apps(
            [_remote_app(values={"tolerations": [{"key": "a"}, {"key": "b"}]})],
            {"vector-db": {"tolerations": [{"key": "c"}]}},
        )
        assert result[0]["values"]["tolerations"] == [{"key": "c"}]

    def test_fragment_for_undeclared_app_is_ignored(self):
        # Fleet defaults are one file shared across every persona, so they
        # may carry appValues for apps only some personas declare.
        result = resolve_apps([_local_app()], {"vector-db": {"replicas": 3}})
        assert result == [
            {"name": "docs-site", "chart": "charts/test-page", "repo": "local"}
        ]

    def test_fragment_alone_creates_values_block(self):
        result = resolve_apps([_local_app()], {"docs-site": {"page": {"title": "Hi"}}})
        assert result[0]["values"] == {"page": {"title": "Hi"}}

    def test_non_mapping_fragment_raises(self):
        with pytest.raises(GitopsEmitterError, match="appValues.vector-db must be a mapping"):
            resolve_apps([_remote_app()], {"vector-db": ["not-a-mapping"]})

    def test_non_mapping_app_values_raises(self):
        with pytest.raises(GitopsEmitterError, match="appValues must be a mapping"):
            resolve_apps([_remote_app()], ["not-a-mapping"])


class TestResolveAppsValuesRequired:
    """valuesRequired: every dot-path must resolve non-null in the merged
    values, else the install fails BEFORE any manifest is generated,
    listing each missing path and the exact override command."""

    def test_satisfied_by_author_values_passes_and_is_dropped(self):
        result = resolve_apps(
            [
                _remote_app(
                    values={"auth": {"apiKeySecretRef": "sec"}},
                    valuesRequired=["auth.apiKeySecretRef"],
                )
            ]
        )
        assert "valuesRequired" not in result[0]
        assert result[0]["values"]["auth"]["apiKeySecretRef"] == "sec"

    def test_satisfied_by_app_values_override_passes(self):
        result = resolve_apps(
            [_remote_app(valuesRequired=["auth.apiKeySecretRef"])],
            {"vector-db": {"auth": {"apiKeySecretRef": "sec"}}},
        )
        assert "valuesRequired" not in result[0]

    def test_missing_path_fails_naming_path_and_override_command(self):
        with pytest.raises(GitopsEmitterError) as exc:
            resolve_apps(
                [_remote_app(valuesRequired=["auth.apiKeySecretRef"])],
                persona="support-agent",
            )
        message = str(exc.value)
        assert "auth.apiKeySecretRef" in message
        assert "'vector-db'" in message
        # The exact override commands, both surfaces:
        assert "python -m gitops_emitter.overrides_cli set support-agent" in message
        assert (
            "pulumi config set --path "
            "'agents[<i>].overrides.appValues.vector-db.auth.apiKeySecretRef'"
            in message
        )
        # Fails pre-render, by contract wording:
        assert "BEFORE any manifest is generated" in message

    def test_every_missing_path_is_listed_across_apps(self):
        with pytest.raises(GitopsEmitterError) as exc:
            resolve_apps(
                [
                    _remote_app(valuesRequired=["auth.apiKeySecretRef", "tls.certRef"]),
                    _local_app(valuesRequired=["page.title"]),
                ],
                persona="support-agent",
            )
        message = str(exc.value)
        assert "auth.apiKeySecretRef" in message
        assert "tls.certRef" in message
        assert "page.title" in message

    def test_explicit_null_value_counts_as_missing(self):
        with pytest.raises(GitopsEmitterError, match="auth.apiKeySecretRef"):
            resolve_apps(
                [
                    _remote_app(
                        values={"auth": {"apiKeySecretRef": None}},
                        valuesRequired=["auth.apiKeySecretRef"],
                    )
                ]
            )

    def test_intermediate_non_mapping_counts_as_missing(self):
        with pytest.raises(GitopsEmitterError, match="auth.apiKeySecretRef"):
            resolve_apps(
                [
                    _remote_app(
                        values={"auth": "token"},
                        valuesRequired=["auth.apiKeySecretRef"],
                    )
                ]
            )

    def test_false_and_zero_and_empty_string_are_not_missing(self):
        result = resolve_apps(
            [
                _remote_app(
                    values={"a": False, "b": 0, "c": ""},
                    valuesRequired=["a", "b", "c"],
                )
            ]
        )
        assert result[0]["values"] == {"a": False, "b": 0, "c": ""}

    def test_bad_values_required_shape_raises(self):
        with pytest.raises(GitopsEmitterError, match="valuesRequired must be a list"):
            resolve_apps([_remote_app(valuesRequired="auth.apiKeySecretRef")])


# ---------------------------------------------------------------------------
# validate_name
# ---------------------------------------------------------------------------


class TestValidateName:
    def test_valid_dns_label_passes(self):
        validate_name("support-agent")  # must not raise

    def test_uppercase_rejected(self):
        with pytest.raises(GitopsEmitterError, match="DNS-1123"):
            validate_name("Support-Agent")

    def test_too_long_rejected(self):
        with pytest.raises(GitopsEmitterError, match="max 40"):
            validate_name("a" * 41)

    def test_leading_hyphen_rejected(self):
        with pytest.raises(GitopsEmitterError, match="DNS-1123"):
            validate_name("-support-agent")


# ---------------------------------------------------------------------------
# build_record
# ---------------------------------------------------------------------------


class TestBuildRecord:
    def test_minimal_record_omits_all_optional_blocks(self):
        hook_kwargs = {
            "source_url": "github.com/factorylevel/support-agent",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            "ref": "",
            "distribution_version": "",
        }
        record = build_record("support-agent", hook_kwargs, {}, env_requires=None)

        assert record == {
            "spec": {
                "persona": "support-agent",
                "source": "github.com/factorylevel/support-agent",
                "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            },
        }
        for key in ("ref", "distributionVersion", "deployment", "apps", "envRequires", "expose"):
            assert key not in record["spec"]
        validate(record)  # must not raise
        jsonschema.validate(instance=record, schema=_schema())

    def test_full_record_includes_every_block_in_fixed_order(self):
        hook_kwargs = {
            "source_url": "github.com/factorylevel/support-agent",
            "ref": "v1.3.0",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            "distribution_version": "1.3.0",
        }
        merged_ext = {
            "deployment": {
                "baseImageTag": "hermes-base-2026-07",
                "diskSizeGb": 100,
            },
            "apps": resolve_apps(
                [_remote_app(values={"replicas": 1}), _local_app()]
            ),
            "expose": {
                "services": [
                    {"name": "tools", "port": 8080, "path": "/"},
                    {"name": "metrics", "port": 9090},
                ],
                "access": {"policy": "service-token"},
            },
        }
        record = build_record(
            "support-agent",
            hook_kwargs,
            merged_ext,
            env_requires=["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
        )

        assert list(record.keys()) == ["spec"]
        assert list(record["spec"].keys()) == [
            "persona",
            "source",
            "ref",
            "sha",
            "distributionVersion",
            "deployment",
            "apps",
            "envRequires",
            "expose",
        ]
        # apps / expose.services preserve author order (NOT sorted by
        # build_record; render_yaml sorts only order-insensitive fields).
        assert [a["name"] for a in record["spec"]["apps"]] == ["vector-db", "docs-site"]
        assert [s["name"] for s in record["spec"]["expose"]["services"]] == [
            "tools",
            "metrics",
        ]
        validate(record)  # must not raise
        jsonschema.validate(instance=record, schema=_schema())

    def test_app_entry_fields_in_fixed_order(self):
        # Deliberately shuffled entry: build_record must reorder to
        # name, chart, repo, version, values.
        record = build_record(
            "support-agent",
            {
                "source_url": "github.com/factorylevel/support-agent",
                "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            },
            {
                "apps": [
                    {
                        "values": {"replicas": 1},
                        "version": "1.9.1",
                        "repo": "https://qdrant.github.io/qdrant-helm",
                        "chart": "qdrant",
                        "name": "vector-db",
                    }
                ]
            },
        )
        assert list(record["spec"]["apps"][0].keys()) == [
            "name",
            "chart",
            "repo",
            "version",
            "values",
        ]
        validate(record)

    def test_falsy_optional_hook_fields_are_omitted(self):
        hook_kwargs = {
            "source_url": "github.com/factorylevel/support-agent",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            "ref": None,
            "distribution_version": None,
        }
        record = build_record("support-agent", hook_kwargs, {}, env_requires=[])
        assert "ref" not in record["spec"]
        assert "distributionVersion" not in record["spec"]
        assert "envRequires" not in record["spec"]

    def test_empty_extension_blocks_are_omitted(self):
        hook_kwargs = {
            "source_url": "github.com/factorylevel/support-agent",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        }
        merged_ext = {"deployment": {}, "apps": [], "expose": {}}
        record = build_record("support-agent", hook_kwargs, merged_ext)
        for key in ("deployment", "apps", "expose"):
            assert key not in record["spec"]

    def test_backup_is_an_extension_key(self):
        assert "backup" in EXTENSION_KEYS

    def test_record_includes_backup_in_fixed_order(self):
        hook_kwargs = {
            "source_url": "github.com/factorylevel/support-agent",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        }
        # Deliberately retention-first: build_record must reorder to the
        # schema's declared order (schedule, retention).
        record = build_record(
            "support-agent",
            hook_kwargs,
            {"backup": {"retention": 7, "schedule": "0 3 * * *"}},
        )
        assert list(record["spec"]["backup"].keys()) == ["schedule", "retention"]
        validate(record)  # must not raise
        jsonschema.validate(instance=record, schema=_schema())

    def test_backup_without_schedule_fails_validate(self):
        hook_kwargs = {
            "source_url": "github.com/factorylevel/support-agent",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        }
        record = build_record("support-agent", hook_kwargs, {"backup": {"retention": 7}})
        with pytest.raises(GitopsEmitterError):
            validate(record)

    def test_empty_backup_block_is_omitted(self):
        hook_kwargs = {
            "source_url": "github.com/factorylevel/support-agent",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        }
        record = build_record("support-agent", hook_kwargs, {"backup": {}})
        assert "backup" not in record["spec"]

    def test_invalid_record_fails_validate(self):
        bad_record = {
            "spec": {
                "persona": "x",
                "source": "y",
                "sha": "not-a-valid-sha",
            },
        }
        with pytest.raises(GitopsEmitterError):
            validate(bad_record)

    def test_legacy_cr_wrapper_fails_validate(self):
        # The old custom-resource shape (apiVersion/kind/metadata) is no
        # longer schema-legal: records are plain Helm values with a single
        # top-level spec block (issue #50 [G9]).
        legacy_record = {
            "apiVersion": "hermes-gitops.factorylevel.dev/v1alpha1",
            "kind": "HermesProfile",
            "metadata": {"name": "support-agent"},
            "spec": {
                "persona": "support-agent",
                "source": "github.com/factorylevel/support-agent",
                "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            },
        }
        with pytest.raises(GitopsEmitterError):
            validate(legacy_record)


class TestRecordSchemaApps:
    """The record schema's own spec.apps rules — validated both ways."""

    HOOK_KWARGS = {
        "source_url": "github.com/factorylevel/support-agent",
        "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
    }

    def _record_with_apps(self, apps):
        return {
            "spec": {
                "persona": "support-agent",
                "source": "github.com/factorylevel/support-agent",
                "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
                "apps": apps,
            }
        }

    def test_resolved_remote_and_local_apps_validate(self):
        record = self._record_with_apps(
            resolve_apps([_remote_app(values={"replicas": 1}), _local_app()])
        )
        validate(record)  # must not raise
        jsonschema.validate(instance=record, schema=_schema())

    def test_legacy_workloads_list_fails_schema(self):
        record = {
            "spec": {
                "persona": "support-agent",
                "source": "github.com/factorylevel/support-agent",
                "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
                "workloads": ["vector-store"],
            }
        }
        with pytest.raises(GitopsEmitterError, match="workloads"):
            validate(record)

    def test_values_required_in_record_fails_schema(self):
        # valuesRequired is validated pre-render and DROPPED; a record
        # still carrying it means the render pipeline was bypassed.
        record = self._record_with_apps(
            [_remote_app(valuesRequired=["auth.apiKeySecretRef"])]
        )
        with pytest.raises(GitopsEmitterError):
            validate(record)

    def test_remote_app_without_version_fails_schema(self):
        app = _remote_app()
        del app["version"]
        with pytest.raises(GitopsEmitterError):
            validate(self._record_with_apps([app]))

    def test_local_app_with_version_fails_schema(self):
        with pytest.raises(GitopsEmitterError):
            validate(self._record_with_apps([_local_app(version="1.0.0")]))

    def test_bad_repo_scheme_fails_schema(self):
        with pytest.raises(GitopsEmitterError):
            validate(
                self._record_with_apps([_remote_app(repo="git@github.com:o/r.git")])
            )


# ---------------------------------------------------------------------------
# render_yaml — determinism, sorting, golden file
# ---------------------------------------------------------------------------


def _reference_hook_kwargs():
    return {
        "source_url": "github.com/factorylevel/support-agent",
        "ref": "v1.3.0",
        "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        "distribution_version": "1.3.0",
    }


def _reference_merged_ext():
    return {
        "deployment": {
            "baseImageTag": "hermes-base-2026-07",
            "diskSizeGb": 100,
        },
        "apps": resolve_apps(
            [
                _remote_app(
                    values={"replicas": 1, "auth": {"apiKeySecretRef": "sec"}},
                    valuesRequired=["auth.apiKeySecretRef"],
                ),
                _local_app(),
            ]
        ),
        "expose": {
            "services": [
                {"name": "tools", "port": 8080, "path": "/"},
                {"name": "metrics", "port": 9090},
            ],
            "access": {"policy": "service-token"},
        },
    }


def _reference_env_requires():
    # The v1alpha3 shape (#141): a declaration carries its metadata. One
    # rich entry and one bare name, because build_record accepts both and
    # the golden should show what each renders to.
    return [
        {
            "name": "OPENAI_API_KEY",
            "required": True,
            "secret": True,
            "description": "Model access",
        },
        "DISCORD_BOT_TOKEN",
    ]


class TestRenderYamlDeterminism:
    def test_same_logical_input_different_insertion_order_is_byte_identical(self):
        # Build the exact same logical inputs via two different dict
        # insertion orders and confirm build_record's fixed field order
        # (not caller insertion order) drives the output.
        hook_kwargs_a = _reference_hook_kwargs()

        hook_kwargs_b = {}
        for key in reversed(list(hook_kwargs_a.keys())):
            hook_kwargs_b[key] = hook_kwargs_a[key]

        merged_ext_a = _reference_merged_ext()
        merged_ext_b = {}
        for key in reversed(list(merged_ext_a.keys())):
            merged_ext_b[key] = merged_ext_a[key]
        # Also reorder keys within the nested deployment dict and within
        # each app entry (including its values mapping).
        merged_ext_b["deployment"] = {
            k: merged_ext_a["deployment"][k]
            for k in reversed(list(merged_ext_a["deployment"].keys()))
        }
        merged_ext_b["apps"] = [
            {k: app[k] for k in reversed(list(app.keys()))}
            for app in merged_ext_a["apps"]
        ]

        env_requires_a = _reference_env_requires()
        env_requires_b = list(reversed(env_requires_a))

        record_a = build_record(
            "support-agent", hook_kwargs_a, merged_ext_a, env_requires_a
        )
        record_b = build_record(
            "support-agent", hook_kwargs_b, merged_ext_b, env_requires_b
        )

        yaml_a = render_yaml(record_a)
        yaml_b = render_yaml(record_b)
        assert yaml_a == yaml_b

    def test_rerendering_is_idempotent(self):
        record = build_record(
            "support-agent",
            _reference_hook_kwargs(),
            _reference_merged_ext(),
            _reference_env_requires(),
        )
        assert render_yaml(record) == render_yaml(record)

    def test_exactly_one_trailing_newline(self):
        record = build_record(
            "support-agent",
            _reference_hook_kwargs(),
            _reference_merged_ext(),
            _reference_env_requires(),
        )
        text = render_yaml(record)
        assert text.endswith("\n")
        assert not text.endswith("\n\n")

    def test_env_requires_sorted_alphabetically(self):
        record = build_record(
            "support-agent",
            _reference_hook_kwargs(),
            _reference_merged_ext(),
            _reference_env_requires(),  # given as [OPENAI_API_KEY, DISCORD_BOT_TOKEN]
        )
        text = render_yaml(record)
        parsed = yaml.safe_load(text)
        # Sorted BY NAME - the entries are mappings now, and a set-like
        # field still has to serialise deterministically or every re-emit
        # is a spurious diff.
        assert [e["name"] for e in parsed["spec"]["envRequires"]] == [
            "DISCORD_BOT_TOKEN",
            "OPENAI_API_KEY",
        ]

    def test_app_values_keys_sorted_alphabetically(self):
        # apps[].values mappings are order-insensitive helm values; the
        # renderer key-sorts them so merge-layer insertion order can never
        # produce two different byte streams for the same logical record.
        record = build_record(
            "support-agent",
            _reference_hook_kwargs(),
            _reference_merged_ext(),
            _reference_env_requires(),
        )
        parsed = yaml.safe_load(render_yaml(record))
        assert list(parsed["spec"]["apps"][0]["values"].keys()) == ["auth", "replicas"]

    def test_apps_and_expose_services_order_preserved(self):
        record = build_record(
            "support-agent",
            _reference_hook_kwargs(),
            _reference_merged_ext(),
            _reference_env_requires(),
        )
        text = render_yaml(record)
        parsed = yaml.safe_load(text)
        assert [a["name"] for a in parsed["spec"]["apps"]] == ["vector-db", "docs-site"]
        assert [s["name"] for s in parsed["spec"]["expose"]["services"]] == [
            "tools",
            "metrics",
        ]

    def test_expose_service_name_http_is_rejected_at_build_time(self):
        # "http" is reserved for the agent API port (8642) -
        # harness/hermes/charts/hermes-profile's hermes.exposeServiceNamesGuard already
        # rejects this at `helm template`/ArgoCD sync time, but that
        # surfaces as a Degraded Application well after `hermes profile
        # install` already pushed the record. build_record must reject it
        # HERE too, so the operator gets a readable error at install time.
        merged_ext = _reference_merged_ext()
        merged_ext["expose"]["services"] = [{"name": "http", "port": 8080}]
        with pytest.raises(GitopsEmitterError, match="name='http' is reserved"):
            build_record(
                "support-agent",
                _reference_hook_kwargs(),
                merged_ext,
                _reference_env_requires(),
            )

    def test_golden_file_byte_for_byte(self):
        record = build_record(
            "support-agent",
            _reference_hook_kwargs(),
            _reference_merged_ext(),
            _reference_env_requires(),
        )
        text = render_yaml(record)
        golden_path = FIXTURES / "support-agent.golden.yaml"
        expected = golden_path.read_text(encoding="utf-8")
        assert text == expected

    def test_golden_file_is_schema_valid(self):
        golden_path = FIXTURES / "support-agent.golden.yaml"
        parsed = yaml.safe_load(golden_path.read_text(encoding="utf-8"))
        jsonschema.validate(instance=parsed, schema=_schema())
        validate(parsed)  # must not raise


# ---------------------------------------------------------------------------
# Handler contract (gitops_emitter/__init__.py)
# ---------------------------------------------------------------------------


class TestHandlerContract:
    def test_on_profile_install_returns_fatal_dict_when_emit_raises_gitops_error(self, monkeypatch):
        # GitopsEmitterError messages are scrubbed at their source
        # (gitrepo.py/scaffold.py/emitter.py) and pass through verbatim.
        def _boom(kwargs):
            raise GitopsEmitterError("push failed: permission denied")

        monkeypatch.setattr(gitops_emitter, "emit", _boom)

        result = gitops_emitter._on_profile_install(
            name="support-agent",
            source_url="github.com/factorylevel/support-agent",
            ref="v1.3.0",
            sha="9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            distribution_version="1.3.0",
            target_dir="/home/user/.hermes/profiles/support-agent",
            event="install",
        )

        assert result == {
            "error": "push failed: permission denied",
            "fatal": True,
            "plugin": "gitops-emitter",
        }

    def test_on_profile_install_sanitizes_generic_exception_message(self, monkeypatch):
        # A non-GitopsEmitterError has NOT been through the token/path
        # scrubbing pipeline, so its raw str() must never reach the
        # CLI-facing fatal dict (carried finding from Task 4's review).
        def _boom(kwargs):
            raise RuntimeError("push failed: permission denied for token ghp_SECRET123")

        monkeypatch.setattr(gitops_emitter, "emit", _boom)

        result = gitops_emitter._on_profile_install(
            name="support-agent",
            source_url="github.com/factorylevel/support-agent",
            ref="v1.3.0",
            sha="9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            distribution_version="1.3.0",
            target_dir="/home/user/.hermes/profiles/support-agent",
            event="install",
        )

        assert result["fatal"] is True
        assert result["plugin"] == "gitops-emitter"
        assert "ghp_SECRET123" not in result["error"]
        assert "permission denied" not in result["error"]
        assert "RuntimeError" in result["error"]

    def test_on_profile_update_returns_fatal_dict_when_emit_raises(self, monkeypatch):
        def _boom(kwargs):
            raise GitopsEmitterError("push failed")

        monkeypatch.setattr(gitops_emitter, "emit", _boom)

        result = gitops_emitter._on_profile_update(
            name="support-agent",
            source_url="github.com/factorylevel/support-agent",
            ref="v1.3.0",
            sha="9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            distribution_version="1.3.0",
            target_dir="/home/user/.hermes/profiles/support-agent",
            event="update",
            previous_version="1.2.0",
            previous_sha="a" * 40,
        )

        assert result["fatal"] is True
        assert result["plugin"] == "gitops-emitter"
        assert result["error"] == "push failed"

    def test_accepts_unknown_extra_kwargs_injected_by_invoke_hook(self, monkeypatch):
        received = {}

        def _capture(kwargs):
            received.update(kwargs)

        monkeypatch.setattr(gitops_emitter, "emit", _capture)

        result = gitops_emitter._on_profile_install(
            name="support-agent",
            source_url="github.com/factorylevel/support-agent",
            ref="v1.3.0",
            sha="9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
            distribution_version="1.3.0",
            target_dir="/home/user/.hermes/profiles/support-agent",
            event="install",
            telemetry_schema_version=1,
        )

        assert result is None
        assert received["telemetry_schema_version"] == 1

    def test_on_profile_install_failed_is_log_only_and_accepts_extra_kwargs(self, caplog):
        result = gitops_emitter._on_profile_install_failed(
            name="",
            source_url="github.com/factorylevel/support-agent",
            ref="",
            error="staging failed: 404",
            event="install_failed",
            telemetry_schema_version=1,
        )
        assert result is None

    def test_register_subscribes_all_three_hooks(self):
        class FakeCtx:
            def __init__(self):
                self.registered = []

            def register_hook(self, name, callback):
                self.registered.append(name)

        ctx = FakeCtx()
        gitops_emitter.register(ctx)
        assert ctx.registered == [
            "profile_install",
            "profile_update",
            "profile_install_failed",
        ]


class TestGitAuthSecretRef:
    """Issue #18 [G1]: the private-source credential reference flows
    through the extension chain into the rendered record."""

    def test_flows_into_spec_after_source(self):
        hook_kwargs = {
            "source_url": "github.com/org/private-agent",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        }
        record = build_record(
            "support-agent", hook_kwargs, {"gitAuthSecretRef": "hermes-support-agent-git-auth"}
        )
        keys = list(record["spec"].keys())
        assert keys.index("gitAuthSecretRef") == keys.index("source") + 1
        assert record["spec"]["gitAuthSecretRef"] == "hermes-support-agent-git-auth"
        validate(record)  # schema-legal

    def test_absent_when_undeclared(self):
        hook_kwargs = {
            "source_url": "github.com/org/agent",
            "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        }
        record = build_record("support-agent", hook_kwargs, {})
        assert "gitAuthSecretRef" not in record["spec"]

    def test_is_an_extension_key(self):
        assert "gitAuthSecretRef" in EXTENSION_KEYS


class TestSourceSubdir:
    """spec.sourceSubdir carries the fork's subdir install form through to
    the record (pod boot installs /tmp/dist/<sourceSubdir>)."""

    HOOK_KWARGS = {
        "source_url": "github.com/org/monorepo",
        "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
        "subdir": ".hermes-dist/agent",
    }

    def test_flows_into_spec_and_validates(self):
        record = build_record("support-agent", self.HOOK_KWARGS, {})
        assert record["spec"]["sourceSubdir"] == ".hermes-dist/agent"
        validate(record)  # schema-legal

    def test_absent_when_root_layout(self):
        kwargs = dict(self.HOOK_KWARGS)
        kwargs["subdir"] = ""
        record = build_record("support-agent", kwargs, {})
        assert "sourceSubdir" not in record["spec"]
        validate(record)


class TestTargetCluster:
    """spec.targetCluster is GONE as of hermesprofile v1alpha2 (#132,
    ADR-8). It was never read: the ApplicationSet hardcodes
    destination.name: in-cluster, and the chart's own values schema
    declares spec as additionalProperties:false without it - so a record
    carrying the field would already have failed to render.

    Its successor is NOT a record field (#176, ADR-33): placement is the
    environment's decision. The profile declares what it supports; the
    compiler emits argoDestination per instance; the per-instance
    ApplicationSets read it. The environment-side remote-cluster
    REGISTRATION is that model's input - see the migration note in
    agent-bundle-contracts/README.md."""

    HOOK_KWARGS = {
        "source_url": "github.com/org/agent",
        "sha": "9f2c1ab3d4e5f60718293a4b5c6d7e8f9a0b1c2d",
    }

    def test_is_never_emitted_even_when_declared(self):
        # A fleet default or instance override still carrying it is
        # DROPPED rather than passed through - passing it through would
        # produce a record the chart refuses.
        record = build_record(
            "support-agent", self.HOOK_KWARGS, {"targetCluster": "workload-eu-1"}
        )
        assert "targetCluster" not in record["spec"]
        validate(record)

    def test_absent_when_undeclared(self):
        record = build_record("support-agent", self.HOOK_KWARGS, {})
        assert "targetCluster" not in record["spec"]
        validate(record)

    def test_not_an_extension_key(self):
        assert "targetCluster" not in EXTENSION_KEYS

    def test_the_schema_itself_refuses_it(self):
        import pytest

        record = build_record("support-agent", self.HOOK_KWARGS, {})
        record["spec"]["targetCluster"] = "workload-eu-1"
        with pytest.raises(Exception):
            validate(record)
