#!/usr/bin/env python3
"""Generates the schema-derived reference pages from the frozen contracts:

  _docs/wiki/reference/profile-record.md   — the HermesProfile record (bespoke page)
  _docs/wiki/reference/contracts/<id>.md   — one field reference per contract family
                                        (CONTRACTS below; the hand-written
                                        contracts/index.md routes to them)

No third-party dependencies (stdlib `json` only), so it needs no `uv run`/venv.

Usage:
  infra/scripts/generate-schema-docs.py           # write every page
  infra/scripts/generate-schema-docs.py --check   # diff against the committed
                                                  # pages; exit 1 on drift.
                                                  # Wired as `make docs-drift`.

Output is deterministic (dict iteration follows the schema file's own key
order, which `json.load` preserves) — no timestamps, no environment-
dependent content — so a byte-for-byte diff against the committed file is a
meaningful drift check, not a false-positive generator.

Version resolution is PER SCHEMA FILE, not per contract directory: a version
directory only ships the files that changed (runtime-overlay/v1alpha3 holds
only platform-backup-status), so each basename resolves to the newest
directory that contains it.
"""
from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCHEMA_DIR = REPO_ROOT / "agent-bundle-contracts" / "hermesprofile"
RENDER_PY = REPO_ROOT / "plugin" / "gitops_emitter" / "render.py"
CONTRACTS_OUT = REPO_ROOT / "_docs" / "wiki" / "reference" / "contracts"


def _version_key(name: str) -> int:
    return int(name.removeprefix("v1alpha"))


def _current_version() -> str:
    """The record version the emitter actually validates against.

    Resolved rather than hardcoded: this script spent three releases
    generating a reference for v1alpha2 while the emitter had moved to
    v1alpha3, and the drift check could not see it — it only ever compared
    the page against the version it was told to read.
    """
    versions = sorted(
        (d.name for d in SCHEMA_DIR.iterdir() if (d / "profile.schema.json").exists()),
        key=_version_key,
    )
    if not versions:
        sys.exit("schema-docs: no versioned profile schema found")
    newest = versions[-1]
    # The newest directory is only the contract if the emitter loads it.
    if newest not in RENDER_PY.read_text(encoding="utf-8"):
        sys.exit(
            f"schema-docs: {newest} is the newest profile schema but "
            f"plugin/gitops_emitter/render.py does not mention it — the reference would "
            f"document a contract nothing emits"
        )
    return newest


VERSION = _current_version()
SCHEMA_PATH = SCHEMA_DIR / VERSION / "profile.schema.json"
PROFILE_OUT = REPO_ROOT / "_docs" / "wiki" / "reference" / "profile-record.md"

TYPE_LABELS = {
    "string": "string",
    "integer": "integer",
    "number": "number",
    "boolean": "boolean",
    "object": "object",
    "array": "array",
}

# One entry per contract family under agent-bundle-contracts/ (plus cli/schemas/evals).
# `files` are schema basenames, each resolved to its own newest version dir;
# `example` is a fixture path inside the FIRST file's version dir, embedded on
# the page (already validated by `make schema-validate`, so it cannot lie).
# The hermesprofile family keeps its bespoke page (profile-record.md) above.
CONTRACTS: list[dict] = [
    {
        "id": "cluster-values",
        "title": "Cluster values",
        "dir": "agent-bundle-contracts/cluster-values",
        "files": ["cluster-values.schema.json"],
        "intro": "Written by the **operator** as `bootstrap/values/cluster-values.yaml`: the \"where\" layer (providers, image, platform repo). Argo CD layers it under every record, so each field is also a Helm value.",
        "example": "examples/cluster-values-local.yaml",
    },
    {
        "id": "environment-topology",
        "title": "Environment topology and policy",
        "dir": "agent-bundle-contracts/environment-topology",
        "files": ["topology.schema.json", "policy.schema.json"],
        "intro": "Written by the **operator**. `environment/topology.yaml` says what the environment is: layout, regions, targets, DNS. `environment/policy.yaml` says what it allows: the chart-source allowlist. Both are read by `hg topology`.",
        "example": "examples/topology/valid-single.yaml",
        "see": ["../cli/topology.md"],
    },
    {
        "id": "environment-capabilities",
        "title": "Environment capabilities",
        "dir": "agent-bundle-contracts/environment-capabilities",
        "files": ["capabilities.schema.json"],
        "intro": "Written by the **operator** as `environment/capabilities.yaml`: the capabilities the environment provides, bound to implementations. An agent's `requires[]` names a capability; a provider is either a peer agent's endpoint or an entry here.",
        "example": "examples/valid-minimal.yaml",
    },
    {
        "id": "environment-communication",
        "title": "Environment communication",
        "dir": "agent-bundle-contracts/environment-communication",
        "files": ["communication.schema.json"],
        "intro": "Written by the **operator** as `environment/communication.yaml`: binds the agents' communication intent to real providers and durable transport. Credential references only; the schema forbids values. In v1alpha2 an absent `inbound` block means deny.",
        "example": "examples/valid-discord-sandbox.yaml",
        "see": ["../cli/event.md", "../cli/chatops.md"],
    },
    {
        "id": "environment-bundles",
        "title": "Environment bundles",
        "dir": "agent-bundle-contracts/environment-bundles",
        "files": ["bundles.schema.json"],
        "intro": "Written by the **team** as `harness-hg/bundles.yaml`: which agents share one pod. The bundles generator matches nothing until this file exists.",
        "example": "examples/bundles/valid-distribution-and-bundle.yaml",
    },
    {
        "id": "environment-workspaces",
        "title": "Environment workspaces",
        "dir": "agent-bundle-contracts/environment-workspaces",
        "files": ["workspaces.schema.json"],
        "intro": "Written by the **team** as `harness-hg/workspaces.yaml` (`kind: WorkspaceBindings`): pinned Git checkouts assigned to agents. A repository reaches an agent only when a binding names both. The default is nothing.",
        "example": "examples/workspaces/valid-pinned.yaml",
        "see": ["../cli/workspace.md"],
    },
    {
        "id": "environment-connections",
        "title": "Environment connections",
        "dir": "agent-bundle-contracts/environment-connections",
        "files": ["connections.schema.json"],
        "intro": "Written by the **team** as `harness-hg/connections.yaml` (`kind: Connections`): one third-party app registration per connection, declared once and bound to agents. No secret is in the file. The keys live in one platform Secret, `hermes-secrets/connection-<name>`, projected into every bound agent and mounted by the event router, whose gateway verifies the provider's signature on `/v1/connect/<provider>/<name>`.",
        "example": "examples/connections/valid-full.yaml",
        "see": ["../cli/connection.md"],
    },
    {
        "id": "agent-team",
        "title": "Agent team",
        "dir": "agent-bundle-contracts/agent-team",
        "files": [
            "team.schema.json",
            "agent.schema.json",
            "apps.schema.json",
            "endpoints.schema.json",
            "backup.schema.json",
            "test.schema.json",
            "topology.schema.json",
        ],
        "intro": "Written by the **team** as `harness-hg/*.yaml` at the root and `agents/<harness>/<name>/harness-hg/*.yaml` per agent. `harness-hg/` at any level is exactly what the platform reads. This family holds the shapes that are new: the team identity, the per-agent declaration, the team's apps with their routes, the agent's endpoints with its inbound routes, backup, the test config, and the target-free topology whose cluster half is the environment spec's `grants`.",
        "example": "examples/team/valid-two-harnesses.yaml",
        "see": ["../cli/bundle.md", "../cli/topology.md", "../cli/validate.md", "../repo-scaffolds.md"],
    },
    {
        "id": "eveagent",
        "title": "EveAgent record",
        "dir": "agent-bundle-contracts/eveagent",
        "files": ["eveagent.schema.json"],
        "intro": "**Generated** by the emitter for an Eve agent: `profiles/<name>/profile.yaml`, plain Helm values for the `eve-agent` chart, never a custom resource. `spec.runtime: eve` is what the agents ApplicationSet routes on. v1alpha2 adds `spec.apps` and `spec.backup`; v1alpha1 records stay valid.",
        "example": "examples/valid-full.yaml",
    },
    {
        "id": "agent-runtime",
        "title": "Agent runtime manifest",
        "dir": "agent-bundle-contracts/agent-runtime",
        "files": ["agent-runtime.schema.json"],
        "intro": "**Generated**, and purely descriptive: what one deployed agent got. Engine, resolved source revision, every workspace with the path the pod reads it at, the env variable names it needs, and its bound connections. The eve charts render it into a ConfigMap at `/hg/runtime-manifest.json`; `hg agent inspect` computes the same document offline, and `hg agent prove` compares the two. Names only; no value ever enters it.",
        "example": "examples/valid-full.yaml",
        "see": ["../cli/agent.md"],
    },
    {
        "id": "harness-declaration",
        "title": "Harness declaration",
        "dir": "agent-bundle-contracts/harness-declaration",
        "files": ["harness.schema.json"],
        "intro": "What a harness declares about itself, one file per harness at `harness/<name>/harness.yaml`. The gateway declaration is mandatory: the platform ships no universal gateway, so every harness states how its agents reach a model. `hg validate` fails a registered harness with no declaration.",
        "example": "examples/valid-eve.yaml",
        "see": ["../cli/validate.md"],
    },
    {
        "id": "dashboard-contribution",
        "title": "Dashboard contribution",
        "dir": "agent-bundle-contracts/dashboard-contribution",
        "files": ["contribution.schema.json", "view.schema.json"],
        "intro": "Written by the **team**: an agent's `harness-hg/dashboard.yaml` and the repo's `dashboard/` (components, people, groups, relationships, and the default view). Data, never code. Read by `hg nexus compile`.",
        "example": "examples/contribution/valid-minimal.yaml",
        "see": ["../cli/nexus.md"],
    },
    {
        "id": "evals",
        "title": "Eval suite and scenarios",
        "dir": "cli/schemas/evals",
        "files": ["suite.schema.json", "scenario.schema.json"],
        "intro": "Written by the **team** as `evals/suite.yaml` and `evals/scenarios/*/scenario.yaml`. Optional, and not a deployment contract: read by `hg eval --dir` and by nothing in the cluster.",
        "example": "examples/suite/valid-minimal.yaml",
        "see": ["../cli/eval.md"],
    },
    {
        "id": "topology-plan",
        "title": "Topology plan",
        "dir": "agent-bundle-contracts/topology-plan",
        "files": ["plan.schema.json", "deployment.schema.json", "provenance.schema.json"],
        "intro": "**Generated** by `hg topology emit`. `deployments/plan.yaml` is the fleet summary and carries `inputsHash`, the staleness signal the doctors compare. `deployments/{agents,apps,endpoints}/<id>/deployment.yaml` is one physical instance. `catalog/profiles/<name>/provenance.yaml` sits beside the verbatim contract copy.",
        "example": "examples/plan/valid-plan.yaml",
        "see": ["../cli/topology.md"],
    },
    {
        "id": "communication-deployment",
        "title": "Communication deployment",
        "dir": "agent-bundle-contracts/communication-deployment",
        "files": ["deployment.schema.json", "values.schema.json", "plan.schema.json"],
        "intro": "**Generated** by `hg topology emit` under `deployments/communication/`: "
        "one event-router instance record per scope, its operative `values.yaml` "
        "configuration, and the whole-plane summary.",
        "example": "examples/deployment/valid-router.yaml",
        "see": ["../cli/event.md"],
    },
    {
        "id": "dashboard-plan",
        "title": "Dashboard plan",
        "dir": "agent-bundle-contracts/dashboard-plan",
        "files": ["plan.schema.json", "provenance.schema.json"],
        "intro": "**Generated** by `hg nexus emit`: `deployments/control-plane/nexus-plan.json` is the "
        "compiled join of dashboard contributions and the topology plan (deterministic — "
        "health is layered on at runtime, never baked in), and "
        "`catalog/dashboard/sources/<id>/provenance.yaml` sits beside the verbatim copies "
        "of the authored dashboard files.",
        "example": "examples/plan/valid-plan.yaml",
        "see": ["../cli/nexus.md"],
    },
    {
        "id": "runtime-overlay",
        "title": "Runtime overlay and status records",
        "dir": "agent-bundle-contracts/runtime-overlay",
        "files": [
            "overlay.schema.json",
            "platform-backup-status.schema.json",
            "reconciliation-status.schema.json",
        ],
        "intro": "**Runtime, not files** — never committed. The overlay is the response of "
        "`GET /nexus/health`: every operational source reports through the same shape, so a "
        "source nobody configured reads `unknown` rather than green. The two status records "
        "are ConfigMaps (`hermes-platform-backup-status`, `hermes-reconciliation-status`) "
        "published by the host-side timers for Nexus to read.",
        "example": "examples/overlay/valid-overlay.yaml",
        "see": ["../cli/observability.md", "../cli/reconcile.md"],
    },
    {
        "id": "eval-result",
        "title": "Eval result batch",
        "dir": "agent-bundle-contracts/eval-result",
        "files": ["eval-result.schema.json"],
        "intro": "The body of `POST /nexus/evals/publish`. Frozen because it is the "
        "contract an **external harness** targets: anything that can produce this document "
        "can publish results without using the CLI.",
        "example": "examples/eval-result/valid-minimal.yaml",
        "see": ["../cli/eval.md"],
    },
    {
        "id": "lifecycle-record",
        "title": "Lifecycle record",
        "dir": "agent-bundle-contracts/lifecycle-record",
        "files": ["lifecycle-record.schema.json"],
        "intro": "The shared telemetry envelope (#349): one record shape for every plane that emits "
        "lifecycle telemetry — the Discord gateway, the native cron scheduler, the event "
        "router, alerting, and agent and tool execution. Carries **metadata only**, never "
        "message content; a digest stands in for the payload.",
        "example": "examples/valid-cron-triggered.yaml",
    },
    {
        "id": "panel-catalog",
        "title": "Panel catalog",
        "dir": "agent-bundle-contracts/panel-catalog",
        "files": ["panel-catalog.schema.json"],
        "intro": "The closed set of Grafana panels Nexus is allowed to embed. "
        "It exists because the browser must never be able to name a dashboard: every embed "
        "URL is built on the server from an entry in this file, and an identifier that is "
        "not here does not resolve.",
        "example": "examples/catalog/valid-platform-catalog.yaml",
    },
    {
        "id": "bundle-destination",
        "title": "Bundle destination",
        "dir": "agent-bundle-contracts/bundle-destination",
        "files": ["destination.schema.json"],
        "intro": "Authored by the **agent-team repository** as `harness-hg/destination.yaml` "
        "("
        "written by `hg bundle init`): where this repo's emitted records go. "
        "`hg topology emit` reads it as the default destination when no `--output` names one.",
        "example": "examples/valid-minimal.yaml",
    },
]


def _type_label(schema: dict) -> str:
    if "const" in schema:
        return f"const `{schema['const']}`"
    t = schema.get("type")
    if isinstance(t, list):
        return " \\| ".join(TYPE_LABELS.get(x, x) for x in t)
    if t == "array":
        items = schema.get("items", {})
        return f"array of {_type_label(items)}"
    return TYPE_LABELS.get(t, t or "any")


def _constraints(schema: dict) -> str:
    bits = []
    if "enum" in schema:
        bits.append("enum: " + ", ".join(f"`{v}`" for v in schema["enum"]))
    if "pattern" in schema:
        bits.append(f"pattern: `{schema['pattern']}`")
    if "minLength" in schema:
        bits.append(f"minLength: {schema['minLength']}")
    if "maxLength" in schema:
        bits.append(f"maxLength: {schema['maxLength']}")
    if "minimum" in schema:
        bits.append(f"minimum: {schema['minimum']}")
    if "maximum" in schema:
        bits.append(f"maximum: {schema['maximum']}")
    if "minItems" in schema:
        bits.append(f"minItems: {schema['minItems']}")
    if schema.get("uniqueItems"):
        bits.append("uniqueItems")
    return "; ".join(bits) if bits else "—"


def _cell(text: str) -> str:
    """Multi-line schema prose flattened for a table cell."""
    return " ".join(text.split())


def _table(properties: dict, required: list[str]) -> list[str]:
    lines = [
        "| Field | Type | Required | Constraints | Description |",
        "|---|---|---|---|---|",
    ]
    for name, sub in properties.items():
        req = "**yes**" if name in required else "no"
        desc = _cell(sub.get("description", "—"))
        lines.append(
            f"| `{name}` | {_type_label(sub)} | {req} | {_constraints(sub)} | {desc} |"
        )
    return lines


def _walk_object(path: str, schema: dict, out: list[str], level: int) -> None:
    """Emits a heading + table for one object schema, then recurses into
    every object-typed (or array-of-object-typed) property so nested blocks
    (spec.deployment, spec.expose.services[], ...) each get their own
    section instead of one unreadable flattened table.
    """
    properties = schema.get("properties", {})
    required = schema.get("required", [])
    heading = "#" * level
    out.append(f"{heading} `{path}`" if path else f"{heading} (root)")
    out.append("")
    if schema.get("description"):
        out.append(schema["description"])
        out.append("")
    if schema.get("additionalProperties") is False:
        out.append("_Unknown fields are rejected (`additionalProperties: false`)._")
        out.append("")
    if not properties:
        out.append("_No properties declared beyond what's shown above._")
        out.append("")
        return
    out.extend(_table(properties, required))
    out.append("")
    for name, sub in properties.items():
        sub_path = f"{path}.{name}" if path else name
        if sub.get("type") == "object" and sub.get("properties"):
            _walk_object(sub_path, sub, out, level + 1)
        elif sub.get("type") == "array":
            items = sub.get("items", {})
            if items.get("type") == "object" and items.get("properties"):
                _walk_object(f"{sub_path}[]", items, out, level + 1)


def generate_profile() -> str:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    out: list[str] = []
    out.append("<!-- GENERATED FILE — DO NOT HAND-EDIT.")
    out.append(
        f"     Source of truth: agent-bundle-contracts/hermesprofile/{VERSION}/profile.schema.json"
    )
    out.append(
        "     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py)."
    )
    out.append(
        "     `make docs-drift` (part of `make test`) fails the build if this"
    )
    out.append("     file and the schema have diverged. -->")
    out.append("")
    out.append("# Profile record reference")
    out.append("")
    out.append(
        "This page is generated directly from "
        f"`agent-bundle-contracts/hermesprofile/{VERSION}/profile.schema.json` — the versioned, "
        "frozen contract described in `agent-bundle-contracts/README.md`. It documents the "
        "shape of one `HermesProfile` instance record "
        "(`profiles/<name>/profile.yaml` in the GitOps repo, produced by "
        "`gitops_emitter/render.py` on `hermes profile install`/`update` — see "
        "`gitops_emitter/README.md`). If a field described here looks wrong, "
        "the schema file is the source of truth, not this page — file the fix "
        "there and re-run `make docs`."
    )
    out.append("")
    out.append(
        f"Schema `$id`: `{schema.get('$id', '(none)')}` — see "
        f"`agent-bundle-contracts/README.md`'s \"Versioning rule\" for what a schema change "
        f"of any kind implies (a new `v1alpha3`+ directory, never editing "
        f"this one in place)."
    )
    out.append("")
    _walk_object("", schema, out, level=2)
    out.append("## See also")
    out.append("")
    out.append(
        f"- `agent-bundle-contracts/hermesprofile/{VERSION}/examples/` — fixtures validated "
        "against this exact schema by `make schema-validate` (`invalid-*` "
        "fixtures must fail; everything else must pass)."
    )
    out.append(
        "- `harness/hermes/identity/examples/persona-echo/` — a realistic, non-minimal "
        "`distribution.yaml` (the gitops-emitter INPUT this record is "
        "rendered from, not the record itself) and its rendered output "
        "(`harness/hermes/identity/examples/rendered/profile-echo.yaml`)."
    )
    out.append(
        "- `maintainers/built.md` — how this record fits into the "
        "rest of the system."
    )
    out.append("")
    return "\n".join(out) + "\n"


def _resolve(contract_dir: Path, basename: str) -> Path:
    """Newest version directory that ships this schema file."""
    versions = sorted(
        (d for d in contract_dir.iterdir() if d.is_dir() and (d / basename).exists()),
        key=lambda d: _version_key(d.name),
    )
    if not versions:
        sys.exit(f"schema-docs: no version of {contract_dir.name}/{basename} found")
    return versions[-1] / basename


def generate_contract(entry: dict) -> str:
    contract_dir = REPO_ROOT / entry["dir"]
    resolved = [_resolve(contract_dir, f) for f in entry["files"]]
    single = len(resolved) == 1

    out: list[str] = []
    out.append("<!-- GENERATED FILE — DO NOT HAND-EDIT.")
    out.append("     Sources:")
    for p in resolved:
        out.append(f"       {p.relative_to(REPO_ROOT)}")
    out.append(
        "     Regenerate with `make docs` (infra/scripts/generate-schema-docs.py);"
    )
    out.append("     `make docs-drift` (part of `make test`) fails on stale. -->")
    out.append("")
    out.append(f"# {entry['title']}")
    out.append("")
    out.append(
        "**What this page tells you:** every field of this contract, with types, "
        "constraints and defaults — generated from the frozen schema, so it cannot "
        "drift from what validates."
    )
    out.append("")
    if any("discord" in p.read_text(encoding="utf-8").lower() for p in resolved):
        out.append(
            "> This frozen contract includes historical Discord syntax. Current loaders and "
            "runtimes reject Discord integrations; they are roadmap-only. Schema acceptance "
            "alone does not establish current provider support."
        )
        out.append("")
    out.append(entry["intro"])
    out.append("")

    for path in resolved:
        schema = json.loads(path.read_text(encoding="utf-8"))
        version = path.parent.name
        if not single:
            out.append(f"## `{path.stem.removesuffix('.schema')}` ({version})")
            out.append("")
        line = f"Schema: `{path.relative_to(REPO_ROOT)}`"
        if schema.get("title"):
            line += f" — **{schema['title']}**"
        out.append(line)
        out.append("")
        # The walk prints the root description itself, under its own heading.
        _walk_object("", schema, out, level=2 if single else 3)

    example = resolved[0].parent / entry["example"]
    if not example.exists():
        sys.exit(f"schema-docs: example fixture {example} does not exist")
    out.append("## Example")
    out.append("")
    out.append(
        f"`{example.relative_to(REPO_ROOT)}` — a fixture validated against this "
        "exact schema by `make schema-validate`, so it cannot go stale:"
    )
    out.append("")
    out.append("```yaml")
    out.append(example.read_text(encoding="utf-8").rstrip("\n"))
    out.append("```")
    out.append("")
    out.append("## See also")
    out.append("")
    out.append("- [Contract files](index.md) — every contract, who writes it, who reads it.")
    out.append(
        f"- `{entry['dir']}/<version>/examples/` — all fixtures for this contract "
        "(`invalid-*` fixtures must fail validation; everything else must pass)."
    )
    for link in entry.get("see", []):
        name = Path(link).stem.replace("-", " ")
        out.append(f"- [{name}]({link})")
    out.append("")
    return "\n".join(out) + "\n"


def render_all() -> dict[Path, str]:
    pages = {PROFILE_OUT: generate_profile()}
    for entry in CONTRACTS:
        pages[CONTRACTS_OUT / f"{entry['id']}.md"] = generate_contract(entry)
    return pages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Don't write; diff the generated content against the committed "
        "pages and exit 1 on drift.",
    )
    args = parser.parse_args()

    pages = render_all()
    # contracts/index.md is HAND-WRITTEN (the router page); everything else in
    # the directory must be one of ours.
    existing = {p for p in CONTRACTS_OUT.glob("*.md") if p.name != "index.md"} if CONTRACTS_OUT.exists() else set()
    strays = sorted(existing - set(pages))

    if args.check:
        failed = []
        for target, content in sorted(pages.items()):
            have = target.read_text(encoding="utf-8") if target.exists() else ""
            if have != content:
                failed.append(str(target.relative_to(REPO_ROOT)))
                sys.stderr.write(
                    "".join(
                        difflib.unified_diff(
                            have.splitlines(keepends=True),
                            content.splitlines(keepends=True),
                            fromfile=str(target),
                            tofile="<generated>",
                        )
                    )
                )
        failed += [f"{s.relative_to(REPO_ROOT)} (stray — no such contract)" for s in strays]
        if failed:
            sys.stderr.write(
                "ERROR: schema reference pages have drifted — run 'make docs':\n  "
                + "\n  ".join(failed)
                + "\n"
            )
            return 1
        return 0

    for target, content in sorted(pages.items()):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        print(f"wrote {target.relative_to(REPO_ROOT)}")
    for s in strays:
        s.unlink()
        print(f"removed stray {s.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
