# <ORG> distributed profiles

This repository ships **distributed profiles** — external, portable AI-agent
distributions a Hermes GitOps platform installs *by Git reference*. Each
profile is a folder under `distributions/`; the shared Helm charts they use
live under `charts/`.

```
.
├── distributions/
│   └── <PERSONA>/                  # the seed profile: a site-reliability agent
│       ├── distribution.yaml       # pure-Hermes manifest (name, version, secrets)
│       ├── hermes-gitops.yaml      # deployment intent (Helm apps, expose, disk)
│       ├── hermes-gitops.test.yaml # local-testing CLI config
│       ├── SOUL.md                 # the agent's personality
│       ├── config.yaml             # model / runtime settings
│       ├── skills/                 # optional agent skills
│       └── cron/                   # optional scheduled tasks
└── charts/
    ├── <PERSONA>-app/              # the agent-application workload
    └── <PERSONA>-dashboard/        # a starter Grafana dashboard (+ CONVENTIONS.md)
```

## Install a profile

Every install is pinned to a Git reference; the plugin resolves it to a full
commit SHA and records it, so the same record always deploys the same content.

```bash
hermes profile install "github.com/<ORG>/<REPO>#v<VERSION>&subdirectory=distributions/<PERSONA>" -y
```

In a fleet you don't run this by hand — the repo is listed in the platform's
fleet configuration and `pulumi up` runs it for you.

## Publish the charts (do this once, before the first real deploy)

A distribution can only reference a chart that is either `local` (ships with
the platform) or published to a real Helm registry. The two charts in
`charts/` are yours, so publish them to the registry named in
`distributions/<PERSONA>/hermes-gitops.yaml` (`oci://ghcr.io/<ORG>/charts` by
default):

```bash
helm package charts/<PERSONA>-app       && helm push <PERSONA>-app-0.1.0.tgz       oci://ghcr.io/<ORG>/charts
helm package charts/<PERSONA>-dashboard && helm push <PERSONA>-dashboard-0.1.0.tgz oci://ghcr.io/<ORG>/charts
```

Bump the chart `version` in each `Chart.yaml` (and the matching `version:` in
`hermes-gitops.yaml`) every time you change a chart — registries reject a
re-push of the same version, and Argo CD caches by version.

## Test locally, without a cluster or a registry

Scaffold-level validation renders the profile through the real emitter
pipeline (it never pulls the charts, so unpublished charts are fine):

```bash
# from a harness-hg checkout:
uv run python cli/render_record.py \
  --profile <path-to>/distributions/<PERSONA> \
  --name <PERSONA> --source local-preview --sha 0000000000000000000000000000000000000000 \
  --app-values '{"monitoring":{"alert":{"webhookUrl":"https://example.invalid/hook"}}}'
```

For the full loop on a throwaway cluster (Argo CD + Grafana), publish the
charts first, then use `hermes-gitops onboard` → `up` → `test`.

## Exposing services through the Cloudflare Tunnel

The services your agent-app publishes are listed in
`distributions/<PERSONA>/hermes-gitops.yaml` under `expose.services` — each
one lines up with a Service in `charts/<PERSONA>-app/values.yaml`. They are
reached at `<PERSONA>.agents.<zone>/<path>`, so every service needs a
distinct `path`.

Who is allowed in is set once, in `expose.access.policy`:

| Policy | Who gets in |
|---|---|
| `service-token` | Machines only, with a Cloudflare service token (default). |
| `idp` | People, after logging in through your Cloudflare identity provider (Google/GitHub/OIDC/SAML/email OTP). |
| `mixed` | Either a service token or a human login. |

**If you use `idp` or `mixed`:** the operator must set
`cloudflare.access.idpId` in the cluster's values at install time — the
platform uses a Cloudflare identity provider you have **already created** in
the Zero Trust dashboard; it never creates one. Install fails preview if the
id is missing. See `_docs/wiki/platform/tunneling-cloudflare.md`.

## The dashboard conventions

`charts/<PERSONA>-dashboard/CONVENTIONS.md` explains how Grafana dashboards
work on this platform — how the sidecar discovers them, which datasource to
query, how uids stay stable, and why "what fires is what you see." Read it
before adding panels.
