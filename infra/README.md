# infra/ — the Hermes GitOps bootstrap Pulumi program

A bun/TypeScript Pulumi program (following the `factory-level/inferops`
`infra/foundation` mental model)
that launches the whole platform in one `pulumi up`:

1. **Stage 1** — install the Hermes fork CLI + the gitops-emitter plugin,
   then enable + configure the plugin in the operating profile
   (`src/components/harness/hermes-install`).
2. **Stage 2** — `hermes profile install` per entry in the `agents:` stack
   config list; the plugin renders each agent's profile record and pushes
   it to the GitOps repo (`src/components/harness/hermes-agent`).
3. **Stage 3** — the cluster control plane: Argo CD, ESO, a
   ClusterSecretStore, optionally the Pulumi Kubernetes Operator, and the
   `hermes-gitops-root` Application (`src/control-flow/control-plane.ts`).

## Structure (components → control-flow → index)

| Path | Responsibility |
|---|---|
| `src/components/<name>/` | Leaf `ComponentResource`s: `namespaces`, `argocd`, `eso`, `secret-store`, `pulumi-operator`, `root-app`, `hermes-install`, `hermes-agent`. |
| `src/control-flow/` | Workflows composing components (`hermes.ts` stages 1–2, `control-plane.ts` stage 3) + the typed env-config contract (`config.ts`). |
| `src/index.ts` | The top-level bootstrap control flow: read env-config → run the workflows in dependency order → export. |

Per-env `Pulumi.<env>.yaml` files carry config/secrets — see
`Pulumi.local.yaml.example` for the full annotated shape (config keys live
under the `hermes-gitops-bootstrap:` namespace, unchanged from the Python
predecessor this program replaced).

## Running

```sh
hg env new <env>       # the day-0 front door (#676): declares -> inits ->
                       # configures -> pulumi up, from infra/environments/<env>.yaml
```

(Direct `pulumi stack init` + hand config survives as the escape hatch —
`hg env new <env> --dry-run` prints that exact sequence.)

## Developing

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # offline unit tests (config parsing, script builders)
```

The live loops live in `scripts/`: `verify-bootstrap-git-side.sh` (stages
1–2 against a local bare git repo, no cluster) and `smoke-local.sh` /
`test-drift-and-decommission.sh` (full loop on a local k3d cluster).
