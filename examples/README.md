# Examples

**What this page tells you:** what each example directory is, and which loop it serves.

These are **reference authorings and proof fixtures**, not templates: the e2e gates run
against them (`make e2e-offline` validates each; `distributed-profile` is the dev loop's
fixture and its deliberate `valuesRequired` gap is the negative leg). To START something,
use the front doors — `hg bundle init` scaffolds a new agent-bundle repo; `hg env new`
stands up an environment (see the wiki's Get Started quickstarts).

| Directory | What it is | Loop |
|---|---|---|
| `distributed-profile/` | An external agent catalogue (Hermes runtime) — the dev loop's fixture (`hg onboard examples/distributed-profile`). Its `persona-echo` deliberately omits a required override so the contract gate has something to refuse. (Legacy layout — kept as the dual-reader regression guard.) | dev |
| `agent-team/` | **The demo team.** `hg bundle init --agents eve:manager,eve:research`'s output, plus a shared pod (`bundles.yaml`), a test-page app (`apps.yaml`), a subagent, a schedule and evals — the dev loop's fixture (`hg dev examples/agent-team`). | dev, agent-bundle |
| `eve-agent/` | Two Eve agents + environment declarations — the smallest complete Eve authoring; validates clean. (Legacy layout — kept as the dual-reader regression guard.) | agent-bundle |
| `communication-plane/` | Two distributions + the event/chatops declarations — the communication contract worked end to end. (Legacy layout — kept as the dual-reader regression guard.) | agent-bundle |
| `gitops-repo/` | A worked **destination** repo: what the emitter's scaffold + `hg topology emit` produce. Read it to understand the output; never author in it by hand (`hg gitops doctor` refuses edited managed files). | reference |
| `charts/site/` | A minimal persona-owned app chart. | reference |
| `invalid-chart-boundary/` | MUST fail `make chart-boundary` — the gate's self-test. | gate fixture |
