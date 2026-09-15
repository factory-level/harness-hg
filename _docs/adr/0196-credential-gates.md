# 0196 — Credential gates: name the missing or unreadable credential before anything runs

**Status:** Accepted (layer 1 built; layers 2 and 3 to follow)
**Changes:** `_docs/design/cli.md`, `_docs/design/platform.md`

## Decision

A team installation fails loudly, early and completely when a credential it needs is missing,
unreadable or invalid. Three layers, each catching what the one before cannot see.

1. **Install time** (built). `hg team plan`, `apply`, `resume`, `publish` and `compile` refuse at
   the `validated` stage, before anything is read, provisioned or published. Unattended, the
   run exits 1 and the report carries the findings. Every problem arrives in one refusal, and
   no refusal prints a value.
   - *Access first.* The bootstrap stack's state backend is derived from the environment spec
     named for the stack, never inherited from the operator's last `pulumi login`. An operator
     `PULUMI_BACKEND_URL` that differs is refused, naming both, and no derivable backend (an
     absent, unreadable or malformed spec) refuses before any Pulumi call. The probe then checks
     that every stack file the plan names is readable and parses, that the stack exists on that
     backend, that Google credentials work, and that the plan's kube context exists, answers and
     may read each declared Secret by name. An access failure judges no input missing, and no
     refusal quotes a stack file or a declared value.
   - *Completeness next*, from the stack files alone and without decrypting. Every
     `credentials.inputs` path is filled. No stack file holds the generator's
     `<UNSET - see findings>` placeholder. Every binding, private source, overlay, agent runtime
     and app-value credential has a source: the environment, an input, a Kubernetes Secret input
     or an integration output.
   - *Delivery after rendering.* Every required `spec.envRequires` entry of every rendered record
     reaches the pod Secret `ag-eve-<name>-env`, through the bootstrap config, a binding into
     `agentSecrets.<agent>`, or a provisioned Slack app. It is not empty plaintext and not the
     placeholder. A required secret is also in the plan's `agents[].environment`, so the
     production startup proof runs with it; the two names a provisioned Slack app yields are
     exempt, because they exist only after provisioning.
   - Failed child processes are classified: Google re-authentication, KMS denial, backend login,
     stack or config key missing, kube context missing, API server unreachable, RBAC denial,
     Argo CD unable to reach the application cluster, an Eve build validation error (naming the
     agent and source file), and a command that failed inside an agent pod (naming pod, container
     and acceptance scenario). Each names its cause and fix instead of "repair the declared
     input". An unrecognised failure surfaces its last meaningful error line, with npm notices,
     blank lines and anything credential-shaped removed and declared secret values scrubbed.
   - `hg env apply` and `hg env new` write nothing while any secret is unset, and the team
     watcher refuses a stack file that still holds the placeholder.
2. **Pod start** (to follow). The Eve container refuses to start when a required variable is
   unset or empty and writes the names to its termination message. The pod crash-loops, which
   readiness already fails, and `hg team status` names the variable.
3. **Validity** (to follow). An opt-in credential-probes contract lets an agent declare probes
   (presets for Anthropic, Slack, Apify and Postiz, or a plain HTTP check) that the smoke Job
   runs. A rejected credential fails the sync.

## Reason

- The emitter's required-secret check never ran on the team path. `hg team` renders with
  `emit_cli --render-only`, and the chart's `envFrom` fails only when the whole Secret is absent.
  An undelivered or empty required key gave a Ready pod that did nothing.
- The failures the team path did report were misreported. An expired Google ADC session, a
  `pulumi login` pointing at a backend without the stack, and a missing kube context each
  surfaced as "pulumi failed" or "kubectl failed ... repair the declared input". They arrived one
  run at a time, with the cause only in a private diagnostics log.
- `hg env apply` wrote `secure: <UNSET - see findings>` into the stack file before refusing.
  Pulumi then rejects the whole configuration ("validating stack config: bad value") without
  naming a path, and any other reader counts the placeholder as a present value.
- The backend is derived rather than declared because a derivation already exists. The stack
  name is the environment name: `hg env apply <name>` refuses a spec named otherwise and writes
  `Pulumi.<name>.yaml`. `envStateBucketUri` is the one spelling of that environment's backend. A
  new `bootstrap.backend` plan field would be a second spelling that could disagree with it.

## Cost

- **Encrypted values cannot be judged empty at install time.** Presence is read without
  decrypting, so a `secure:` value that encrypts an empty string passes layer 1. Layer 2 catches
  it at pod start. A revoked credential needs layer 3.
- The credentials that actually broke in production (APIFY_API_TOKEN, POSTIZ_API_KEY) are
  declared `required: false`. Layer 1 does not check them; only layer 3 will.
- **Breaking.** A plan now refuses if it was silently missing a required secret, left a required
  secret out of its startup environment, or relied on an inherited `pulumi login`. A drift-only
  `hg env apply` no longer writes while any secret is unset.
- A placeholder at a path a binding overwrites is still refused. The team path would replace it
  in its temporary provisioning copy, but the committed baseline is unusable for any other
  Pulumi run.
- Every run adds one `pulumi stack ls` per stack (seconds per watcher tick), and a `gcloud` token
  check when Pulumi did not already exercise Google credentials.
- Kubernetes Secret inputs are probed for context and RBAC only. Each key is still read, and can
  still be missing, when the run starts.
- Integration stacks are assumed to live on the bootstrap stack's backend.
- `hg team compile` runs the probe and the completeness check but does not read
  `credentials.inputs`. A source token available only through an input still fails at its
  fetch.
- The Pulumi program cannot refuse the placeholder itself: Pulumi rejects the stack
  configuration before the program starts. The refusal exists only in `hg`.
- **Breaking.** A bootstrap stack with no environment spec deriving its backend can no longer be
  driven through Pulumi by `hg team`; add the spec (`hg env import` writes one).
- `hg env new` checks the infra stack's secrets only after the state stack exists. They cannot be
  encrypted before the backend that step creates, so a refusal there follows real mutations and
  says which.
- The team reader of delivered names re-implements `availableSecretNames`. A parity test, not
  shared code, keeps the two equal.
