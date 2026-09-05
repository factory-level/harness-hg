# ADR 0162 — The gateway is part of the harness contract

2026-08-25 · executes [#653](https://github.com/factory-level/harness-hg/issues/653), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646). Pairs
with [#654](https://github.com/factory-level/harness-hg/issues/654) (the Eve
implementation behind the declaration).

## Decision

- **A harness declares its gateway; the platform ships no universal one.** New contract
  family `agent-bundle-contracts/harness-declaration/v1alpha1`: one `harness.yaml` per
  harness directory, with a mandatory `gateway` block — `native` (the harness ships its
  own), `external-service` (a named provider), or `none`. `external-service` must name its
  provider; `native`/`none` may not carry one.
- **Enforced, not advisory**: `hg validate` fails the gate for any registered harness (the
  `DRIVERS` registry) with a missing or invalid declaration, and a name that disagrees
  with its directory fails too. Both harnesses validate green: Hermes declares `native`
  (frozen-legacy), Eve declares `external-service` / `vercel-ai-gateway`.
- **The universal-gateway / custom API-controller work is scope-cut, closed.** The reopen
  condition, recorded here: *a demonstrated platform requirement that no harness gateway
  can meet.* A future platform-owned gateway, if that condition is ever met, lands
  **behind** this declaration (a harness would declare it as its provider) — no consumer
  may bypass the contract.

## Reason

Building a bespoke platform-wide gateway was premature: Hermes already ships its own and
Eve launches on the Vercel AI Gateway. The stable abstraction is "each harness comes with
its gateway" — cheaper to own, honest about who provides connectivity, and it turns the
question "how do this harness's agents reach a model" from folklore into a validated fact.

## Cost

- Gateway capability becomes deliberately non-uniform: what Eve's gateway offers
  (provider fallback, usage accounting) Hermes agents simply do not get, and the contract
  makes that asymmetry permanent until a harness changes its own declaration.
- A third harness must bring or name a gateway before it can validate at all — a real
  onboarding hurdle, accepted as the point.
- The declaration is descriptive: nothing yet *enforces* that runtime traffic actually
  flows through the declared provider. The acceptance of
  [#654](https://github.com/factory-level/harness-hg/issues/654) covers Eve; Hermes'
  native path is taken on faith as frozen legacy.
