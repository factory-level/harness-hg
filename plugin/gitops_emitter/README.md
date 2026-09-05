# gitops_emitter

The Hermes plugin that turns `hermes profile install` / `hermes profile
update` into a pushed `HermesProfile` GitOps record. Subscribes to the
fork's `profile_install`, `profile_update`, and `profile_install_failed`
lifecycle hooks (see `gitops_emitter/__init__.py`).

## What happens on install/update

1. Load this plugin's config (`load_plugin_config`, below).
2. Read the installed profile's `hermes-gitops.yaml` (the ONE carrier of
   infra intent, sitting beside `distribution.yaml` — see
   `render.EXTENSION_KEYS` for the allowed keys: `apps`, `deployment`,
   `expose`, `backup`, `gitAuthSecretRef`). A missing file is NOT an
   error: the profile declares no infra intent (the agent pod still
   renders; zero apps). `distribution.yaml` stays pure Hermes — only its
   `env_requires` is read.
3. Deep-merge, in order: fleet-wide defaults → the extension file →
   per-instance overrides (see "Override chain" below).
4. Resolve `apps` (`render.resolve_apps`): validate names/repos/versions,
   deep-merge each `appValues` fragment into that app's `values`, and
   prove every `valuesRequired` dot-path resolves non-null — otherwise
   the install fails BEFORE any manifest is generated, listing each
   missing path and the exact override command. Then build +
   JSON-Schema-validate + render the `HermesProfile` record (`render.py`
   — pure, no I/O beyond a packaged schema read).
5. If `scaffold: true` (the default): create the GitOps repo if it doesn't
   exist yet and seed it with the app-of-apps bootstrap tree, if that
   hasn't happened already (`scaffold.py`).
6. Commit and push `<profiles_path>/<name>/profile.yaml` to the configured
   branch (`gitrepo.py`).

Every step raises `GitopsEmitterError` on failure. `gitops_emitter/__init__.py`
turns that into the fork's fail-loud fatal-dict contract
(`{"error": ..., "fatal": True, "plugin": "gitops-emitter"}`), which makes
`hermes profile install`/`update` exit non-zero **without** rolling back the
already-durable local profile install — see the fork's
`ProfileHookError` docstring. Enable `HERMES_GITOPS_REQUIRE_EMITTER=1` in any
environment where a fleet install must not silently proceed without this
plugin subscribed at all (e.g. a broken plugin load) — see the fork's
`hermes_cli/profile_distribution.py::_fire_profile_lifecycle_hook`.

## Config reference

Lives under `plugins.entries.gitops-emitter` in the fork's
`~/.hermes/config.yaml`, with the plugin enabled via `plugins.enabled`
(in whichever Hermes profile actually runs `hermes profile install`).

**The supported write surface** (issue #10 [E1]) is
`python -m gitops_emitter.config_cli apply` — run with the installed
tool's own interpreter, config via `HERMES_GITOPS_*` env vars (plus
`GITOPS_GIT_TOKEN` for the `.env` upsert; see that module's docstring for
the full contract). It owns exactly this one block, preserves every
comment and all formatting elsewhere in the operator's `config.yaml`
(ruamel round-trip), and asserts the written config back through the same
seam the plugin reads at hook time before reporting success. The infra
program's stage-1 `hermes-profile-config` Command drives it; hand-editing
the block still works (it is merged, not regenerated wholesale), but the
apply command is what `pulumi up` converges it with:

```yaml
plugins:
  enabled: [gitops-emitter]
  entries:
    gitops-emitter:
      repo_url: https://github.com/<org>/<gitops-repo>   # REQUIRED, no default
      branch: main                                        # default: main
      profiles_path: profiles                              # default: profiles
      defaults_file: ~/.hermes/gitops-emitter/defaults.yaml
      overrides_dir: ~/.hermes/gitops-emitter/overrides
      git_author_name: hermes-gitops-bot
      git_author_email: hg-bot@users.noreply.github.com
      scaffold: true            # create-if-missing repo + app-of-apps bootstrap
      hermes_gitops_repo_url: https://github.com/<org>/harness-hg
      chart_revision: main       # git ref/tag/sha of harness/hermes/charts/hermes-profile to deploy
      image_repository: ghcr.io/factory-level/hermes-agent
      image_tag: latest
```

| Field | Required | Default | Purpose |
|---|---|---|---|
| `repo_url` | **yes** | — | GitOps repo clone URL. Missing this is treated as explicit misconfiguration — `GitopsEmitterError`, not a silent no-op. |
| `branch` | no | `main` | Branch the profile record (and, if scaffolding, the bootstrap tree) is pushed to — in `pr` mode, the PR's base branch. |
| `mode` | no | `direct` | `direct` commits straight to `branch` (no review gate). `pr` (issues #17/#19/#21 [F1]/[F2]/[F3], **github.com repos only** — the bootstrap defaults to it for github.com `repo_url`s): **install events still commit direct** (a fresh fleet's non-interactive `pulumi up` converges without waiting on a human), while **update events** push each change to a stable per-persona head branch `hermes-gitops/<name>` (reset from `branch` on every change, so it always carries exactly one commit of delta) and open a pull request into `branch` via the GitHub pulls API. Fully idempotent update-or-noop: base already identical → nothing at all; head already identical → nothing pushed, the existing open PR is left untouched (a re-run never force-push-churns it); content changed → the existing open PR's head is updated in place; only when no open PR exists is one created (matched by head branch + open state — the `hermes-gitops/` branch namespace is plugin-owned). |
| `pr_auto_merge` | no | `true` | `pr` mode only: squash-merge the PR immediately after opening it, so a non-interactive `pulumi up` completes end-to-end (the resolved bootstrap posture). Set `false` for a human review gate — the install then succeeds with the PR left open, and the record lands in GitOps when a human merges. |
| `profiles_path` | no | `profiles` | Directory prefix under which `<name>/profile.yaml` is written. |
| `defaults_file` | no | `~/.hermes/gitops-emitter/defaults.yaml` | Fleet-wide default extension values (see "Override chain"). Missing file → `{}`, not an error. |
| `overrides_dir` | no | `~/.hermes/gitops-emitter/overrides` | Where per-instance override YAML is persisted. |
| `git_author_name` / `git_author_email` | no | `hermes-gitops-bot` / `hg-bot@users.noreply.github.com` | Commit identity, applied via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars only — this plugin never reads or writes the operator's global git config. |
| `scaffold` | no | `true` | Create-if-missing the GitOps repo (github.com only) and seed the app-of-apps bootstrap tree on first use. |
| `hermes_gitops_repo_url` | no | `""` | Substituted into the scaffold's `__HERMES_GITOPS_REPO_URL__` token — the repo Argo CD pulls `harness/hermes/charts/hermes-profile` from. Only matters when `scaffold: true` scaffolds a fresh repo; set it for real fleets. |
| `chart_revision` | no | `main` | Substituted into `__CHART_REVISION__` — the chart ref/tag/sha Argo CD pins. Mirrors `bootstrap/hermes_gitops_bootstrap/config.py`'s `DEFAULT_CHART_REVISION`. |
| `image_repository` / `image_tag` | no | `ghcr.io/factory-level/hermes-agent` / `latest` | Substituted into `bootstrap/values/cluster-values.yaml`'s `__IMAGE_REPOSITORY__`/`__IMAGE_TAG__` tokens (the default agent container image every scaffolded profile inherits, per `applicationset.yaml`'s valueFiles layering). |

## Override chain

For each install/update, three layers are deep-merged (later wins;
dicts merge key-by-key, lists replace wholesale — see
`render.deep_merge`), in this order:

1. **Fleet defaults** — `defaults_file`, shared across every persona.
   Seeded declaratively by the infra program (issue #13 [E3]): setting
   `hermes-gitops-bootstrap:fleetDefaults` in the Pulumi stack materializes
   this file WHOLESALE on every apply (a generated header marks it;
   hand-edits are overwritten — author changes in stack config). Leaving
   `fleetDefaults` unset leaves the file unmanaged: hand-authoring still
   works, and a missing file is still just `{}`.
2. **The extension file** — `hermes-gitops.yaml`'s blocks (`apps` /
   `deployment` / `expose` / `backup` / `gitAuthSecretRef`), the persona
   author's own declaration for their agent.
3. **Instance overrides** — see below; the operator's per-install
   escape hatch.

`appValues` (`{<appName>: {<chart-values fragment>}}`) is a special key:
it is not one of the extension blocks, but rides through the same merge
chain, so it can be set in `defaults.yaml` and/or overridden per
instance. After the merge, each app's fragment is deep-merged ON TOP of
that app's author `values` (`render.resolve_apps`). Merge semantics are
`render.deep_merge`'s: mappings merge key-by-key; **lists are replaced
wholesale — positional list merging is forbidden**, so an override that
touches a list must restate the entire list. Fragments naming apps a
profile doesn't declare are ignored (fleet defaults are shared across
every persona); this is what makes `valuesRequired` satisfiable by the
operator without editing the persona's repo.

### `HERMES_GITOPS_OVERRIDES` contract

Per-instance overrides are ordinary YAML matching the extension-block
shape (plus the optional `appValues` key), e.g.:

```yaml
deployment:
  diskSizeGb: 250
appValues:
  vector-db:
    auth:
      apiKeySecretRef: hermes-support-agent-qdrant-api-key
```

* **`HERMES_GITOPS_OVERRIDES=<path>` set** (the infra program sets it per
  install when the agent declares `overrides`): that file is
  loaded, AND a byte-identical copy is persisted to
  `<overrides_dir>/<name>.yaml` — so a later `hermes profile update`
  (run without the env var, e.g. from a cron job) still picks up the
  same instance-specific overrides.
* **`HERMES_GITOPS_OVERRIDES_CLEAR` set (and `HERMES_GITOPS_OVERRIDES`
  unset)** — the caller *declares this persona has no overrides* (issue
  #11 [E2]; the infra program sets it whenever an agent's stack entry
  has no `overrides`): the persisted copy is
  **deleted** and `{}` is used. This is what makes removing an override
  from the Pulumi stack actually clear it on the next `pulumi up` —
  no silent stickiness.
* **Neither env var set** (plain `hermes profile install/update` outside
  Pulumi): the persisted copy at `<overrides_dir>/<name>.yaml` is used if
  present, else `{}` — the backward-compatible reuse behavior.

### Managed lifecycle: `python -m gitops_emitter.overrides_cli`

The explicit operator surface over the same persisted files:

```sh
python -m gitops_emitter.overrides_cli list                # personas with a persisted override
python -m gitops_emitter.overrides_cli get <name>          # print it (exit 1 if none)
python -m gitops_emitter.overrides_cli set <name> <file>   # validate + persist
python -m gitops_emitter.overrides_cli unset <name>        # remove (revert to defaults + extensions)
```

`overrides_dir` resolves from `HERMES_GITOPS_OVERRIDES_DIR`, else the
configured `overrides_dir`, else the default. Note that under the
bootstrap flow the Pulumi stack is the source of truth: an out-of-band
`set` survives only until that persona's next `pulumi up` re-declares
(or declares-absent) its overrides.

## Secret naming

| Secret | Where read from | Purpose |
|---|---|---|
| `GITOPS_GIT_TOKEN` | `<target_dir>/.env` (via `python-dotenv`), falling back to the process environment | See the scope table below — what the token needs depends on which features are on. |

### Token scopes per mode

| Feature | Fine-grained PAT permission | Classic PAT scope | When required |
|---|---|---|---|
| Push the record (`mode: direct`, and PR-mode installs) | `Contents: write` | `repo` | Always |
| Open/update pull requests (`mode: pr`) | `Pull requests: write` (plus `Contents: write` for the head-branch push) | `repo` | `mode: pr` (issues #17/#22 [F1]/[F4]) |
| Auto-merge PRs (`pr_auto_merge: true`) | `Pull requests: write` + `Contents: write` | `repo` | `mode: pr` with auto-merge (the default) |
| Create the repo on first scaffold (`scaffold: true`, repo missing) | `Administration: write` (scoped to the target org/user) | `repo` | Only until the repo exists |

A missing PR scope surfaces as a distinct HTTP-403 error naming this
table; a token that can't see the repo at all surfaces as HTTP 404
("wrong owner/repo, or the token isn't granted access"). There is no
startup scope probe — errors are mapped at the first API call that
needs the scope, which is early (before any base-branch mutation in PR
mode).

`GITOPS_GIT_TOKEN` is embedded into the clone URL **in memory only**
(`https://x-access-token:{token}@host/path`) for the lifetime of one
temporary clone directory, and is never written to a durable git config
file or logged. Every `GitopsEmitterError` raised by `gitrepo.py` or
`scaffold.py` has the token scrubbed from its message before it can reach
the CLI-facing fatal dict — this is asserted directly in
`tests/test_gitrepo.py`'s and `tests/test_scaffold.py`'s failure-path
tests. A non-`GitopsEmitterError` exception (a bug, a `KeyError`, ...) has
*not* been through that scrubbing pipeline, so `gitops_emitter/__init__.py`
withholds its raw message from the fatal dict entirely rather than risk a
leak — see `_sanitize_generic_exception`.

## Fail-loud semantics

* Any `GitopsEmitterError` (misconfiguration, missing token, unreachable
  repo, push conflict that can't be rebased, ...) becomes the fork's fatal
  hook-result dict, which makes the CLI command exit non-zero. The profile
  itself stays installed on disk either way — only the exit code and the
  printed error reflect the gitops-emitter failure.
* A non-`GitopsEmitterError` exception is sanitized (see "Secret naming"
  above) before reaching the fatal dict, but full detail is always logged
  at `WARNING` (`gitops-emitter: profile hook failed: ...`) — check
  `hermes logs` / `agent.log` for the real cause.
* Set `HERMES_GITOPS_REQUIRE_EMITTER=1` (recommended for any automated /
  fleet-managed install path) so an install/update where **no** plugin is
  even subscribed to the hook (e.g. gitops-emitter isn't in
  `plugins.enabled`, or failed to load) also fails loud, instead of
  silently proceeding as if GitOps sync were optional.

## Scaffold behavior

Only fires when `scaffold: true` (default), before the profile record
itself is pushed:

1. **Existence check** — `git ls-remote <repo_url>`.
2. **Missing + github.com URL** — create it via the GitHub REST API
   (`POST /orgs/{owner}/repos`, falling back to `POST /user/repos` on a
   404 — GitHub has no single endpoint that covers both org- and
   user-owned repos), **private by default**, using `GITOPS_GIT_TOKEN`.
   Requires the token have repo-creation scope (see "Secret naming").
3. **Missing + non-github.com URL** — `GitopsEmitterError` telling the
   operator to create the (empty) repository themselves; this plugin has
   no generic "create a repo on an arbitrary git host" capability.
4. **Scaffold** — clone (or `git init` for a genuinely empty repo) and, if
   `bootstrap/` isn't already at the repo root, copy in the app-of-apps
   template (the repo-root `infra/gitops-template/`, packaged into the wheel at
   build time — see "Schema and template packaging" below), substituting
   its `__DOUBLE_UNDERSCORE__` tokens
   from this plugin's config, then commit
   (`gitops-emitter: scaffold app-of-apps bootstrap`) and push.
   **Idempotent**: a repo that already has `bootstrap/` is left untouched
   (no commit, no push) on every subsequent install.

Token substitution is scoped to files under `bootstrap/` only — the
template's own `README.md` (which becomes the GitOps repo's root
`README.md` once scaffolded) documents the token syntax by naming the
literal token strings, and is copied verbatim so that documentation isn't
corrupted by the substitution it describes.

## Schema and template packaging

Two resources this package needs at runtime have a single canonical
source elsewhere in the repo and are **packaged into the wheel at build
time** (issue #28 [L1] — nothing is committed twice; see
`pyproject.toml`'s `[tool.hatch.build.targets.wheel.force-include]`):

* `schemas/hermesprofile/v1alpha2/profile.schema.json` → packaged as
  `gitops_emitter/schema/hermesprofile-v1alpha2.schema.json` (read by
  `render.py`'s `_load_schema`).
* `infra/gitops-template/` → packaged as `gitops_emitter/gitops_template/`
  (copied into a fresh GitOps repo by `scaffold.py`). That directory is
  owned by a different concern and is off-limits to changes originating
  in `gitops_emitter/`.

From an installed wheel both resolve via `importlib.resources`; from a
source checkout / editable install (where the packaged paths don't exist
on disk) both loaders fall back to the canonical repo-root paths. `make
wheel-smoke` (part of `make test` and CI) builds the wheel and proves the
packaged copies validate a record and scaffold a repo from a clean venv.

## Why hermes-gitops.yaml is the only carrier

The fork's installer (`hermes_cli/profile_distribution.py`'s
`_copy_dist_payload()`) finishes every install/update by re-serializing
`DistributionManifest.to_dict()` over the installed profile's
`distribution.yaml` — any top-level key that dataclass doesn't model is
silently dropped before this plugin's hook fires. Embedded extension
blocks in `distribution.yaml` were therefore never reliable, and the old
recovery workaround (re-cloning the source to read them back) is gone
along with the embedded-carrier support itself. `hermes-gitops.yaml`
survives the payload copy byte-for-byte (the rewrite only touches
`distribution.yaml`), so the INSTALLED profile is always authoritative
and no source re-fetch is ever needed. A repo with no
`hermes-gitops.yaml` simply declares no infra intent — the record still
renders (agent pod, zero apps).

## Testing without `hermes_cli`

`hermes_cli` (the fork's package) is importable at runtime, inside the
fork, but is **not** a dependency of this repo and is not importable in
this repo's own test environment. Every touchpoint with it
(`hermes_cli.config.load_config`) is imported lazily, inside a small seam
function (`emitter._load_hermes_config`) that tests monkeypatch directly —
see `tests/test_emitter.py`. `read_git_token`'s use of `python-dotenv` is
a real dependency of this package (`pyproject.toml`), not a fork
touchpoint, so it needs no seam.
