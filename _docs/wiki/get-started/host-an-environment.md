# Host an environment

**Outcome:** a real environment, a server reconciling your fleet from GitHub, converged from
one spec file and proven by the acceptance matrix.

This is the **ops loop**. It assumes [Install the tools](install-the-tools.md) is done on
your operator machine. Where a step here summarises a runbook, the runbook wins:
[Runbooks](../runbooks/index.md).

## 1. The root of trust, once, by hand

Pulumi state lives in Google Cloud Storage. Its secrets are encrypted with Cloud KMS. That
chain has to start somewhere Pulumi cannot manage: a bucket and a key you create once, as
[`state/README.md`](https://github.com/factory-level/harness-hg/blob/main/state/README.md)
says. It is the only by-hand step.

You also need credentials: a GitHub token for the destination repo, a Cloudflare API token
for the tunnel, and ssh with sudo on the host. The full list, and where each one lives:
[Credentials](../runbooks/credentials.md).

## 2. Declare the environment

One file is the source of truth for everything Pulumi applies:
`infra/environments/<name>.yaml`. It names the project, the state split, the destination
repo, the providers and the agents. Secret values never live in the spec. A
`{secret: true}` marker means the value exists only as encrypted text in the generated stack
files. Fields and subcommands: [hg env](../reference/cli/env.md).

## 3. Day 0: converge from the spec

```bash
hg env new <name> --dry-run   # print every command; apply nothing
hg env new <name>             # stacks created, config generated, pulumi up, hand-off
```

Dry run first, always. The real run converges both Pulumi stacks and ends by printing the
host steps it cannot do for you:

```bash
hg server preflight --host <user@host>   # readiness findings: fix what it names, rerun
hg server bootstrap --host <user@host>   # pinned k3s, kubectl, helm, bun
```

Credentials on the host, the reconcile timer and scheduled backups are the install
runbook: [Install a destination server](../runbooks/install.md). Reachability and sign-in are
[Cloudflare Tunnel setup](../runbooks/cloudflare-tunnel.md) and then
[Google sign-in at the edge](../runbooks/google-sso.md). A tunnel with no access policy is a
public URL, so do not stop between those two.

## 4. The operator's dailies

```bash
hg reconcile status   # the last reconcile outcome; read-only, safe any time
hg backup verify      # open the newest backup and check it holds what it claims
```

Whenever the spec and the generated stacks might have drifted: `hg env plan <name>` diffs
them and exits 1 on drift.

## Proof

```bash
hg launch prove
```

**Done when** `hg launch prove` reports **no failures and no `unknown` legs**. It runs every
subject's acceptance matrix plus the installation-level checks. A leg that could not run
reads `unknown`. That is never a pass, and it means the step it proves is not done.

## Where to go next

- [Runbooks](../runbooks/index.md), the same ground with every flag and failure table
- [Platform](../platform/index.md), what you just built
