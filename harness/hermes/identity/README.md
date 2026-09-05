# harness/hermes/identity/ — this repo's Hermes identity (was .hermes/)

This repo is itself a Hermes agent. The installable persona payload
(`distribution.yaml`, `SOUL.md`, `config.yaml`) lives under
`.hermes-dist/distribution-agent/` and is installed via the fork's
subdirectory form (`--subdir` / `#subdirectory=`). This dir holds the
rest of the repo's Hermes-facing assets:

- `examples/` — example personas (persona-echo) and their rendered
  records.
- `skills/hermes-gitops-template/` — the Claude Skill that scaffolds a new
  persona repo.

The full config contract (file-by-file, how to extend it, how to launch
this repo's own agent) is documented first-class at
`_docs/wiki/platform/reconciliation.md`. Repos packaged for Hermes GitOps deployment also
carry a `hermes-gitops.yaml` beside their `distribution.yaml` — see
`_docs/wiki/platform/reconciliation.md`.
