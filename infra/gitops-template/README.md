# gitops-template

This directory is the **app-of-apps scaffold** that the `gitops-emitter`
Hermes plugin's scaffold step copies into a user's GitOps repository the
first time it initializes one. It is not meant to be used in place — it is
a template, with placeholder tokens, that gets rendered into a real repo.

> **This file, once scaffolded, becomes `README.md` at the root of the
> GitOps repo.** Everything under `bootstrap/` in that repo is
> plugin-managed and Argo CD-synced: hand edits to `bootstrap/project.yaml`
> or `bootstrap/applicationset.yaml` will be overwritten or drift-detected.
> Only `profiles/*/profile.yaml` (written by the plugin on every
> `hermes profile install`) and `bootstrap/values/cluster-values.yaml`
> (operator-owned cluster config) are meant to be edited after scaffolding,
> and even `profiles/*/profile.yaml` is a generated instance record — treat
> it as data, not as something to hand-author.

## Layout

```
bootstrap/
  project.yaml               # Argo CD AppProject "hermes-gitops" — source/dest allowlist
  applicationset.yaml        # Argo CD ApplicationSet — one Application per profile
  values/
    cluster-values.yaml      # per-cluster Helm values (providers, image, platformRepo, appProject)
profiles/
  <persona-name>/
    profile.yaml             # one fully-resolved HermesProfile instance record per agent
                             # (plain Helm values: a top-level `spec:` block only —
                             # the directory name IS the record's identity)
```

`bootstrap/` is synced to the cluster by the `hermes-gitops-root` Application
created by bootstrap stage 3 (see the top-level `README.md`'s "three-stage
bootstrap sequence" section - there is no separate `bootstrap/README.md`
in this repo; the stage-3 Pulumi program itself lives under
`infra/src/`).
`profiles/` is populated incrementally, one subdirectory per installed
agent, by the gitops-emitter plugin.

## Placeholder tokens

Files under `bootstrap/` contain `__DOUBLE_UNDERSCORE__` tokens, substituted
**once**, verbatim (string replace), by the emitter's scaffold step when it
renders this template into a real GitOps repo:

| Token                       | Meaning                                                             |
|------------------------------|----------------------------------------------------------------------|
| `__GITOPS_REPO_URL__`        | This GitOps repo's own clone URL (used by Argo CD to sync itself)   |
| `__GITOPS_BRANCH__`          | The branch Argo CD tracks (e.g. `main`)                             |
| `__HERMES_GITOPS_REPO_URL__`   | The harness-hg repo URL (source of `harness/hermes/charts/hermes-profile`) |
| `__CHART_REVISION__`         | Git ref/tag/sha of the chart to deploy (pinned by the operator)     |
| `__IMAGE_REPOSITORY__`       | Default Hermes agent container image repository                    |
| `__IMAGE_TAG__`              | Default Hermes agent container image tag                            |
| `__OPERATOR_SOURCE_REPOS__`  | Whole-line token in `project.yaml`: the environment's `appProject.sourceRepos` from `values/cluster-values.yaml`, rendered as list items on every scaffold reconcile (each `oci://` entry plus its scheme-less twin); empty renders nothing |

This token alphabet (`__UPPER_SNAKE__`, no braces) was deliberately chosen
to share **no characters** with Argo CD ApplicationSet Go-template
delimiters (`{{ .foo }}` / `{{- -}}`, see `applicationset.yaml`'s header
comment). A plain string-replace scaffold step can substitute one language
without any risk of mangling the other. Do not introduce a `{{ }}`-based
scaffold token anywhere under `bootstrap/`.

## ArgoCD version validated against

This ApplicationSet design was validated against **Argo CD v3.4.5**
(Helm chart `argo-cd` version `10.1.4` from `argo-helm`, confirmed via that
chart's `Chart.yaml` on 2026-07-16 — `appVersion: v3.4.5`, current stable at
time of writing per the upstream GitHub releases page). Bootstrap stage 3
(`infra/src/components/argocd/`) pins the same chart version.

### Evidence trail (WebSearch/WebFetch, 2026-07-16)

1. **git "files" generator + `goTemplate`/`.path.basename`** — confirmed
   against `argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Generators-Git/`
   and `.../GoTemplate/`. `spec.goTemplate: true` +
   `goTemplateOptions: ["missingkey=error"]` is the documented,
   recommended configuration; the git files generator's `files: [{path: <glob>}]`
   form combined with `goTemplate` exposes `{{.path.basename}}` as the
   right-most path segment matched by the glob (here, the profile's
   directory name under `profiles/`). `{{.path.basename}}` is the
   record's **identity**: `applicationset.yaml` derives the generated
   Application's name, Helm release name, and destination namespace
   (`hermes-{{.path.basename}}`) from it, and uses it to locate
   `profiles/{{.path.basename}}/profile.yaml` as a second Helm
   valueFiles entry. (`profile.yaml` itself is plain Helm values — a
   top-level `spec:` block, no `metadata` — so the directory name is the
   only place the instance name lives; only the persona label is read
   from the record's contents, as `{{.spec.persona}}`.)
2. **Multi-source `$ref` valueFiles inside an ApplicationSet template** —
   confirmed against `argo-cd.readthedocs.io/en/stable/user-guide/multiple_sources/`
   (documents the `ref:`/`$<ref>/path` syntax for a Helm source pulling
   `valueFiles` from a second, non-chart source) **and** against
   [argoproj/argo-cd#19703](https://github.com/argoproj/argo-cd/issues/19703),
   where an Argo CD maintainer (`gdsoumya`) states explicitly: *"you can
   specify whatever configuration you want to for the Application source as
   long as it's valid for a normal application. So in your case helm repo +
   values from git is a supported pattern in apps so appsets will also
   support it."* The issue reporter's original problem turned out to be a
   malformed values file, not a platform limitation — the pattern itself
   works and has been supported since multi-source Applications landed in
   Argo CD 2.6. **No `NEEDS_CONTEXT` escape hatch was triggered.**
3. **`configs.params` / `configs.cm` shape for the ArgoCD Helm chart** and
   the **`resource.customizations.health.<group>_<kind>` Lua health-check
   key format** — confirmed against the argo-helm `argo-cd` chart's
   `values.yaml` at tag `argo-cd-10.1.4` and
   `argo-cd.readthedocs.io/en/latest/operator-manual/health/`.

If a future Argo CD major version changes any of the above (git file
generator semantics, multi-source `$ref`, or the Lua health-check
ConfigMap key format), re-validate this file and bump the pinned chart
version in `versions.json` together.
