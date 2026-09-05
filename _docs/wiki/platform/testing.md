# Testing

**What this page tells you:** what the platform proves about itself, and how to read a proof.

## Proof, not green checkmarks

Every verification command emits a **ProofResult**: numbered checks, each pass, fail or
`unknown`. **A check that could not run never reads as a pass.** An aggregate with an
`unknown` is not green.

| Command | Proves |
|---|---|
| `hg launch prove` | the whole acceptance matrix, aggregated |
| `hg server preflight` | a host is ready to become a destination |
| `hg platform backup prove` | a restore produced a working environment |
| `hg observability prove` | no source reads green without data |
| `hg edge prove` | the tunnel and access policy, against the real provider |
| `hg eval prove` | anonymous refused, forged refused, readback complete |
| `hg communication prove` | the communication matrix |
| `hg auth prove` | sign-in resolves the right role; an unbound identity is denied |
| `hg agent prove` | the harness legs, EVE001..024 |
| `hg slack prove` | a Slack app is provisioned, reachable and answering |
| `hg connection prove` | a connection compiles, projects and verifies |
| `hg grafana prove` | the embedded panel set is real |
| `hg backup verify` | the newest artifact holds what the routine claims |

## Test tiers

```bash
hg validate                  # contract gate, no cluster, every failure at once
hg test --tier register      # agents register
hg test --tier smoke         # they run
hg test --tier backup        # routines produce restorable artifacts
hg test --tier workspace-bindings
```

## What the repository gates on

```bash
make test
```

Schema fixtures, chart lint and golden renders, the emitter's tests, the Nexus UI suite, the
docs drift checks, the strict wiki build, the link checker and the ADR gate. The CLI and
infra unit suites run separately: `cd cli && bun test`, `cd infra && bun test`.

Heavier runs sit outside it: a drift test on a throwaway cluster, and the recovery rehearsal.

## Where to go next

- [Security](security.md), what you can rely on
- [The destructive test](../runbooks/destructive-test.md), the strongest proof
