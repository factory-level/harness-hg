# ADR 0160 — The harness chart migration

2026-08-25 · executes the chart half of
[#652](https://github.com/factory-level/harness-hg/issues/652), part of the final-pass epic
[#646](https://github.com/factory-level/harness-hg/issues/646). Supersedes ADR-153's
"charts and images stay outside `harness/`" costing (see **Reason**).

## Decision

The runtime charts move under their harness; the event-router chart becomes a
`control-plane/` resident:

```
infra/charts/eve-agent            → harness/eve/charts/eve-agent
infra/charts/eve-bundle           → harness/eve/charts/eve-bundle
infra/charts/hermes-profile       → harness/hermes/charts/hermes-profile
infra/charts/hermes-bundle        → harness/hermes/charts/hermes-bundle
infra/charts/hermes-endpoint      → harness/hermes/charts/hermes-endpoint
infra/charts/hermes-event-router  → control-plane/event-router/chart
```

**The two-parent split is expressed by a name branch, not a schema change.** Emitted
records keep stamping bare chart names (`spec.chart`) — the ApplicationSet templates map
the name to its parent (`eve-*` → `harness/eve/charts/…`, else
`harness/hermes/charts/…`). Record bytes do not change; the deployment-neutrality proof
stays `cmp`.

**The migration is a copy → flip → delete choreography**, because scaffolded destination
repos hold their own frozen copy of the bootstrap pointing at `infra/charts/...`:

1. This change **copies** the charts (old paths intact) and rewrites the seed templates +
   the CLI's local-loop paths to the new ones. Every old-path destination repo keeps
   syncing.
2. The live destination repos take the rewritten bootstrap (`hg gitops upgrade`, or a
   manual PR), flipping their Applications to the new paths.
3. After the fleet syncs green (`hg launch prove`, Argo apps Healthy), a deletion PR
   removes the `infra/charts/` copies. `infra/charts/` existing past that point is a bug.

**One StatefulSet roll is accepted and spent here.** The charts' self-referential path
comments (`boot.sh` headers, `configmap-boot.yaml`'s marker, the `_helpers.tpl` fail
string) are corrected in the new copies; those comments render into ConfigMaps, so the
pod-spec checksum changes once. Goldens regenerate accordingly. The eve-agent↔eve-bundle
`files/` byte-identity contract and the `examples/` channel-eve `cmp` both hold across the
move.

## Reason

ADR-153 declined this move at 86 references "for no runtime gain", settling for "every
driver is in `harness/`, not everything about a harness". The final pass changes the
trade: the scaffold ([ADR 0157](0157-target-scaffold.md)) makes tree position the
statement of ownership, `charts/` and `infra/charts/` are both dissolving anyway (no
`charts/` tree survives; application charts left the platform repo), and the reference
count only ever grows — it went 86 → ~174 in the two months since ADR-153. The one-time
churn is paid now, against the epic's internal-clean bar, with the fleet migration made
explicit instead of accidental.

## Cost

- **A three-step, two-repo choreography** where step 2 touches every live destination repo
  by hand or by `gitops upgrade` — a fleet whose operator never flips keeps deploying from
  paths the platform will delete in step 3.
- **One fleet-wide StatefulSet roll** from the ConfigMap comment fixes — every agent pod
  restarts once when its destination repo flips.
- The name branch hard-codes the `eve-*` prefix convention in four templates; a third
  harness means touching them again (the record-schema alternative was rejected to keep
  records `cmp`-stable).
- Until step 3, two byte-diverging copies of six charts exist (old copies keep the stale
  comments deliberately — touching them would roll the fleet twice).
