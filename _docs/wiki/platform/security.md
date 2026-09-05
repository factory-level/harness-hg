# Security

**What this page tells you:** the security properties you can rely on, and the ones you
cannot.

## You can rely on

- **Secrets never enter Git.** The schemas have no field a value could go in. Error paths
  scrub, and the evidence bundler sweeps for secret shapes before writing.
- **No credential is a command-line argument.** Tokens come from the environment or a file.
- **Writer and reader are separate.** Backups are written by one identity and verified by
  another that could not have written them.
- **The cluster opens no inbound port.** Everything pulls or dials out.
- **Failures are loud and early.** A missing secret stops the pipeline before anything is
  written to Git, and names the fix.
- **Negative fixtures are part of every contract.** A new constraint ships with the
  `invalid-*` example that proves it rejects.

## You cannot rely on

- **No audit trail.** Logs are aggregated for 168 hours. Kubernetes audit logging is off.
- **No secret rotation lifecycle.** Nothing knows a credential is about to expire.
- **Rotation rolls the agent only.** Supporting workloads keep the old value.
- **In-cluster services are unauthenticated.** Pod admission is the boundary.
- **One API token builds the entire edge.** It can create and destroy public routes.
- **Webhook hostnames have no access policy.** The request signature is the whole check.

## Where to go next

- [Secrets](secrets.md), the model in full
- [IAM](identity.md), who may do what
- [Testing](testing.md), the proof commands
