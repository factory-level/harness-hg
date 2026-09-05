# 0172 — The three loop front doors exist, and the bundle names its destination

**Decision.** Each operator loop opens with one command that orchestrates the underlying
verbs (#673): `hg env new` (ops — day-0 from the root-of-trust coordinates, #676), `hg dev`
(dev — cold with a repo path it absorbs `onboard → up → dev`, narrating each command), and
`hg bundle init` (agent-bundle — scaffolds an Eve-only bundle repo and proves it against its
own `hg validate --dir` gate before handing back the loop). All three narrate through one
step-runner (`cli/src/frontdoor.ts`): every step announces the command it delegates to,
probes idempotently, and resumes by re-run; `--dry-run` prints the hand-executable sequence.
`hg --help` and the CLI reference index lead with the three doors (manifest `frontDoor`
markers — the docs derive them, never re-declare). The loop walkthrough scripts start FROM
the doors: `agent-bundle-loop.sh` gates a repo `bundle init` created seconds earlier,
`dev-loop.sh` asserts the cold onramp, `ops-loop.sh` opens with the day-0 dry run.

A bundle repo now declares its destination: `.harness-hg/destination.yaml`
(`agent-bundle-contracts/bundle-destination/v1alpha1`, the first implementation of ADR 0158's
dotdir convention). `hg topology emit` uses it as the default when no `--output` names one.

The skeleton is **Eve-only**: Hermes is frozen legacy (#646's standing rule) and grows no new
authoring surface; a Hermes repo keeps copy-from-`examples/`.

**Reason.** The walkthroughs' step-① gaps were all "know the order before you start" — the
epic's worst onboarding. A front door that narrates its delegation teaches the order instead
of hiding it; the self-validating scaffold caught three of its own template bugs during
authoring, which is the gate doing exactly its job.

**Cost.** `bundle init` needs the npm registry once (`npm install --package-lock-only` — the
pod's `npm ci` contract demands a committed lockfile), so the agent-bundle loop's step 0 is
not network-free; the chain from step 1 on still is. The dev door absorbs onboard/up but not
toolchain INSTALLATION — `ensureTools` now reports every missing tool at once, and installing
them stays the operator's act (versions.json pins what `hg server bootstrap` installs on a
server; a laptop keeps its own package manager). The `bundle` noun now carries two registers
(this repo-scaffolding subject vs ADR-28 profile bundles); both files state the distinction
in their headers, and the subject dir is `cli/src/agent-bundle/` to keep greps honest.
