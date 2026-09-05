# Scaffold checklist

Run through this before telling the user the distributed-profile repo is
ready. Every item is checkable against an actual file or command output —
not a vibe check.

## Layout

- [ ] `distributions/<persona>/` exists with `distribution.yaml`,
      `hermes-gitops.yaml`, `hermes-gitops.test.yaml`, `SOUL.md`,
      `config.yaml`, `skills/.gitkeep`, and either a real `cron/<job>.yaml`
      declaration or no `cron/` at all.
- [ ] `charts/<persona>-app/` and `charts/<persona>-dashboard/` exist, and
      each chart's `Chart.yaml` `name:` matches its directory name.
- [ ] `charts/<persona>-dashboard/CONVENTIONS.md` is present (the dashboard
      conventions guide — don't drop it).
- [ ] `README.md` exists at the repo root and names the real `<org>`/`<repo>`.
- [ ] No `<ANGLE_BRACKET>` placeholder survives anywhere
      (`grep -rn '<[A-Z_]*>' .` returns nothing).

## Manifest correctness

- [ ] `distribution.yaml` `name` is a valid DNS-1123 label (lowercase,
      digits, hyphens, ≤40 chars).
- [ ] Every `env_requires` entry is a secret the persona's SOUL/config/tools
      actually read — and nothing the persona reads is missing from the list.
- [ ] Every `hermes-gitops.yaml` `expose.services[]` entry has a matching
      Service in `charts/<persona>-app/values.yaml` `services[]` (same name +
      port), and each exposed service has a **distinct** `path` (the tunnel
      routes by path under one hostname — shared paths collide).
- [ ] `expose.access.policy` is set to what the user actually wanted
      (`service-token` / `idp` / `mixed`). If `idp` or `mixed`, the README
      records that the operator must supply `cloudflare.access.idpId` in the
      cluster values at install time.
- [ ] The `monitoring` app is still present with `repo: local` and
      `valuesRequired: [alert.webhookUrl]` (the standard alerts + the
      fail-fast receiver contract).
- [ ] The two remote apps' `version` fields match the `version:` in their
      charts' `Chart.yaml`.

## Validation (the actual acceptance bar)

- [ ] `cli/render_record.py` (run from the plugin checkout, with the
      `--app-values` webhook) exits 0 and prints a record with all THREE
      apps resolved, plus the expected `expose` and `envRequires`. Read the
      printed record — don't just trust the exit code.
- [ ] `helm lint charts/<persona>-app charts/<persona>-dashboard` reports
      0 charts failed.
- [ ] The dashboard chart renders and its embedded `*-dashboard.json`
      parses as JSON (a stray comma passes Helm but breaks Grafana).
- [ ] `SOUL.md` describes this persona's real behavior — it is not still the
      SRE template text when the user asked for a different agent.

## Runtime configuration (deploying ≠ configured)

A profile can deploy green and still run nothing: a cron declaration is a
file on a volume until it is activated, and an MCP server in the wrong file
is read by nobody. Check the running agent, not the repo.

- [ ] `hg validate` is clean — it parses every `cron/*.yaml` and warns about
      an `mcp.json` (the runtime reads `mcp_servers` in `config.yaml`).
- [ ] `hg agent show --profile <persona>` after `hg up` reports the model,
      the skills this distribution ships, and each declared cron job. Nothing
      says "declared but NOT activated".
- [ ] Anything the persona depends on is written down in `config.yaml`
      rather than left to a default — especially messaging platforms, which
      some adapters enable from an environment token alone.

## Behaviour (optional but recommended)

- [ ] If the persona has observable outcomes worth guarding (an approval
      boundary, a side effect, an inbound event), the repo ships an
      `evals/` suite runnable with `hg eval --dir <repo>` — schema
      `cli/schemas/evals/v1alpha1/`, style guide `_docs/wiki/platform/nexus.md`,
      the reference team's `evals/`.
      Optional by contract: deployment never reads it.

## Handoff

- [ ] The chart-publish, install, and secret-seeding commands were printed
      with this persona's REAL name/org/vars filled in — no placeholders —
      and named which secret backend they assume.
