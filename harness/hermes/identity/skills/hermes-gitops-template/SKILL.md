---
name: hermes-gitops-template
description: Scaffolds a Hermes GitOps distributed-profile repository from an interview — a `distributions/<name>/` folder (distribution.yaml, hermes-gitops.yaml, SOUL.md, config.yaml, local-testing config) seeded with a working site-reliability (SRE) agent, PLUS two starter Helm charts under `charts/`: the agent-application workload and a generic, self-documenting Grafana dashboard that plugs into the platform's Grafana and teaches the ecosystem's dashboard conventions. It then validates the result through the real gitops-emitter render pipeline and `helm lint`, and prints the install, chart-publish, and secret-seeding commands. Use this whenever the user wants to create a new Hermes GitOps agent/persona/profile, scaffold a distributed-profile or hermes-profile repo, stand up a new SRE (or other) agent distribution, add a starter Grafana dashboard chart in this ecosystem, or set up a repo to install with `hermes profile install` — even if they don't name the files explicitly.
---

# Hermes GitOps distributed-profile scaffolding

Turns a short interview into a ready-to-install **distributed-profile
repository**: one `distributions/<persona>/` folder plus the two starter
Helm charts it references. The seed persona is a **site-reliability agent**
— a realistic, working example, not a stub — so the author gets something
that renders, lints, and teaches the ecosystem's conventions on day one.

The templates are modeled directly on the canonical, real references in the
`harness-hg` repo:
`examples/distributed-profile/distributions/persona-echo/` (the profile
shape) and `charts/monitoring/` (the dashboard/sidecar convention). Read
those alongside this skill if anything is ambiguous.

**This skill assumes a checkout of `harness-hg` is reachable**
(this repo, or a sibling) — the Validate step runs the plugin's own
`cli/render_record.py`, and the operator commands cite its secret/naming
contract. If no such checkout is reachable, say so before scaffolding a repo
you can't actually validate.

## What you're building

```
<repo-root>/
  README.md                              # from templates/README.md
  distributions/
    <persona>/
      distribution.yaml                  # pure-Hermes manifest
      hermes-gitops.yaml                 # deployment intent: 3 apps, expose, disk
      hermes-gitops.test.yaml            # local-testing CLI config
      SOUL.md                            # the SRE agent's personality
      config.yaml                        # model / runtime settings
      skills/.gitkeep
      cron/example-heartbeat.yaml       # a declared scheduled job
  charts/
    <persona>-app/                       # from templates/charts/app
    <persona>-dashboard/                 # from templates/charts/dashboard (+ CONVENTIONS.md)
```

Every file above has a template under
`skills/hermes-gitops-template/templates/`. **Copy them, don't retype them**
— that keeps this skill's drift from the real schema/render pipeline down to
a single maintenance surface (the templates). The two charts are
name-agnostic: their Kubernetes objects key off `.Chart.Name`/`.Release.Name`,
so renaming a chart is just its directory name plus the `name:` field in its
`Chart.yaml`.

### The three apps the seed wires

`hermes-gitops.yaml` launches three Helm apps. Understand them before
editing:

| App | Source | Why it's here |
|---|---|---|
| `app` | remote (`<persona>-app`, this repo's chart) | The agent-application workload — the SRE agent's HTTP surface. |
| `monitoring` | `repo: local` (`charts/monitoring`) | The platform's **standard** per-profile dashboard + the three alerts every profile gets. Keep it — it's the safety net and the reference the teaching dashboard is modeled on. |
| `dashboard` | remote (`<persona>-dashboard`, this repo's chart) | The author's **starter** Grafana dashboard: generic, self-documenting, teaches conventions. |

A distribution can only reference a chart that is `local` (ships with the
platform) or published to a real Helm registry — there is **no
chart-by-relative-path**. So the two in-repo charts are referenced as remote
OCI (`oci://ghcr.io/<org>/charts` by default) and **must be published once**
(`helm push`) before a real deploy. Scaffold validation never pulls a chart,
so an unpublished chart still validates — publishing is a deploy-time step,
not a scaffold-time one.

## Step 1 — Interview

Ask only for what you can't safely default. Skip a question the user already
answered.

1. **Persona identity** — a `name` (DNS-1123 label: lowercase, digits,
   hyphens, ≤40 chars), a one-line `description`, `author`, and the
   `<org>`/`<repo>` this will live under (used for the OCI registry URL and
   install command). `version` defaults to `1.0.0`, `license` to `MIT`.
2. **Is a plain SRE agent the right seed?** The template SOUL is a
   site-reliability agent that reasons about the profile's Grafana dashboard
   and the three standard alerts. If the user wants a *different* kind of
   agent, keep the same file shape but rewrite `SOUL.md` (and the app
   chart's page copy) for that role — don't ship SRE text for a non-SRE
   agent.
3. **Secrets (`env_requires`)** — the seed declares one, `ANTHROPIC_API_KEY`
   (the model provider key). Confirm the agent's model/tools actually need
   it, add any others the persona genuinely reads at runtime, and swap it
   for a different provider key if the user's model needs one. **Don't pad
   this list** — every entry becomes an install-time secret an operator must
   seed before the instance goes Healthy.
4. **Candidate services to bundle and expose** — an agent-app usually serves
   more than one thing (a UI, an API, a webhook receiver, a metrics port).
   Don't just ask "what port?" — go **look for the candidates first**, then
   confirm with the user:
   - Inspect the agent's own repo/config for services it runs: `EXPOSE`
     lines and `-p` mappings in Dockerfiles/compose files, `ports:`/
     `containerPort` in any existing k8s manifests or Helm values, a
     `Procfile`, listen ports in the app's config, and the `expose` block of
     any sibling profile. Surface each as a candidate: name, port, what it
     serves.
   - Present the list and ask which to **bundle** (run as part of this
     profile) and which of those to **expose** through the Cloudflare Tunnel.
     Not every port should be public — a metrics or admin port often stays
     internal (bundle it, don't expose it).
   - For every service the user wants exposed, record `name` (DNS-1123;
     `http` is reserved), `port`, and a **distinct** `path` (the tunnel
     routes by path under one hostname, so two services on the same path
     collide). These become `hermes-gitops.yaml`'s `expose.services[]`, and
     each must line up with a Service in the app chart's `values.services`
     (same name + port) — keep the two files in sync.
   - Ask **who** may reach them (the whole agent shares one policy):
     `service-token` (machines only — the default), `idp` (humans log in
     through your Cloudflare identity provider — the IAM path), or `mixed`
     (either). If they choose `idp`/`mixed`, tell them the operator must set
     `cloudflare.access.idpId` in the cluster values at install time (the
     platform uses a pre-existing IdP, it never creates one) — and note this
     in the repo's README so it isn't forgotten.
5. **Deployment tuning** — usually skip (10 GiB disk default is fine). Ask
   only if the user raises storage/compute needs; `diskSizeGb` minimum is 10.

## Step 2 — Generate the files

Create the tree shown above and, for each template, copy it into place and
replace every `<ANGLE_BRACKET>` placeholder with the interview answers:

- `templates/README.md` → `<repo-root>/README.md`
- `templates/{distribution.yaml, hermes-gitops.yaml, hermes-gitops.test.yaml, SOUL.md, config.yaml}` → `distributions/<persona>/`
- `templates/skills/.gitkeep`, `templates/cron/example-heartbeat.yaml` → `distributions/<persona>/{skills,cron}/`
  — the cron file is a working declaration, not a placeholder. Keep it (renamed to
  something the persona actually needs) or delete it; do **not** replace it with a
  `.gitkeep`, which is how a repo ends up with an empty `cron/` that looks configured.
- `templates/charts/app/` → `charts/<persona>-app/` — then set `name:` in its `Chart.yaml` to `<persona>-app`.
- `templates/charts/dashboard/` → `charts/<persona>-dashboard/` (keep `CONVENTIONS.md`) — then set `name:` in its `Chart.yaml` to `<persona>-dashboard`.

Placeholders that appear across files: `<PERSONA>`, `<ORG>`, `<VERSION>`,
`<DESCRIPTION>`, `<AUTHOR>`, `<LICENSE>`, `<SERVICE_NAME>`, `<SERVICE_PORT>`.
Replace **all** of them — a leftover `<PERSONA>` in a chart name will fail
`helm lint`. If the interview dropped a field (e.g. a second service),
delete that block entirely rather than leaving a half-filled one.

**Multiple services**: when the interview turned up more than one service to
expose (step 1.4), add a matching entry in **three** places, keeping name +
port identical across them:
- `hermes-gitops.yaml` → `expose.services[]` (with a distinct `path`),
- `charts/<persona>-app/values.yaml` → `services[]` (with a `targetPort` —
  the container port it forwards to),
- `hermes-gitops.test.yaml` → one `smoke[]` check per exposed service
  (`service: hermes-<persona>-app-<name>`).
Set `access.policy` in `expose` to the value chosen in the interview; if it's
`idp` or `mixed`, add the `cloudflare.access.idpId` reminder to the README.

## Step 3 — Validate (do not skip)

Two checks; both must pass before you call the repo done.

**(a) The profile renders through the REAL pipeline.** From the
`harness-hg` checkout (not from inside the new repo — it has no
Python env), run the plugin's own render entry point:

```sh
cd <harness-hg checkout>
uv run python cli/render_record.py \
  --profile <new-repo>/distributions/<persona> \
  --name <persona> --source local-preview \
  --sha 0000000000000000000000000000000000000000 \
  --app-values '{"monitoring":{"alert":{"webhookUrl":"https://example.invalid/hook"}}}'
```

This runs the same `load_extension_file → resolve_apps → build_record →
validate → render_yaml` path a real `hermes profile install` runs. It prints
the resolved `profile.yaml` on success (exit 0) and, on any contract
violation, the emitter's own loud message naming the field (exit non-zero).
The `--app-values` webhook stands in for the operator-supplied receiver that
`monitoring`'s `valuesRequired: [alert.webhookUrl]` demands — omit it on
purpose once to *see* the fail-fast, then put it back. **Read the printed
record**: confirm all three apps resolved and `expose`/`envRequires` look
right — don't just check the exit code.

**(b) Both charts lint and render.** From the new repo root:

```sh
helm lint charts/<persona>-app charts/<persona>-dashboard
helm template t charts/<persona>-dashboard --namespace hermes-<persona> \
  | ...   # optional: extract the ConfigMap's *.json and json-parse it
```

`helm lint` must report 0 failed. The dashboard's embedded JSON must parse —
a stray comma there renders fine in Helm but breaks Grafana silently.

## Step 4 — Print the operator commands

Once both checks pass, print these with the persona's real values filled in
(never leave a placeholder in what you print):

**Publish the two charts** (once, before the first real deploy):
```sh
helm package charts/<persona>-app       && helm push <persona>-app-0.1.0.tgz       oci://ghcr.io/<org>/charts
helm package charts/<persona>-dashboard && helm push <persona>-dashboard-0.1.0.tgz oci://ghcr.io/<org>/charts
```

**Install** (pinned to a Git ref; the plugin resolves it to a full SHA):
```sh
hermes profile install "github.com/<org>/<repo>#v<version>&subdirectory=distributions/<persona>" -y
```

**Seed each secret** — one command per `env_requires` entry, using the exact
naming contract `hermes-<persona>-<var-lowercased-hyphenated>`. State which
backend you're assuming (ask if it isn't established); don't print both as if
either is equally likely:
```sh
# k8s secret backend:
kubectl -n hermes-secrets create secret generic hermes-<persona>-anthropic-api-key \
  --from-literal=value=<the-actual-key>
# OR gsm backend:
gcloud secrets create hermes-<persona>-anthropic-api-key --data-file=- <<< "<the-actual-key>"
```

## Step 5 — Checklist

Walk `skills/hermes-gitops-template/checklist.md` before telling the user the
repo is ready. Every item is verifiable against an actual file or command
output — not asserted from memory.
