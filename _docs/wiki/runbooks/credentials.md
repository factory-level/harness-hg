# Credentials

**Outcome:** you hold every credential the platform needs, placed through a declared path,
before anything depends on it.

## The rule

**A credential created by hand on the server is not declared state.** A rebuilt server does
not have it. Every credential arrives through a declared path: Pulumi secret config, or an
operator-placed file under `$HERMES_GITOPS_HOME/env/`.

**Secrets are never in backups.** A restore does not bring them. Place them first.

## The inventory

| Credential | Where it lives | Who uses it |
|---|---|---|
| ssh key for the server | your `~/.ssh` | `hg server *` |
| Pulumi backend (`gs://`) | `gcloud auth application-default login` | every `pulumi` run |
| GitHub token for the destination repo | Pulumi secret config `gitopsGitToken` | the emitter, the reconciler |
| Cloudflare API token | Pulumi secret config | `pulumi up`, `hg edge prove` |
| Slack app secrets | captured into Pulumi state at creation | the agent's env Secret |
| Backup writer key | `env/<key>.json` | the backup timers |
| Restore reader | impersonated via `HG_RESTORE_READER_SA`, no key | fetch, verify, the destroy gate |
| Agent env files | `env/<agent>.env` | agent pods, via the bootstrap |
| Nexus UI eval token | minted in the UI; used via `HG_EVAL_TOKEN` or `--token-file` | `hg eval publish` |

Transport is `scp` by an operator. Never Git, never a bucket, never an archive.

## The eval token

Minted in Nexus UI by an owner. Shown once, never again; only a digest is stored. Scoped to
component ids, may expire. Never a command-line argument. Not an identity token: a bearer
beginning `hgev_` is refused for sign-in.

```bash
export HG_EVAL_TOKEN=hgev_...
hg eval publish --control-plane <url> --report report.json --component <id>
```

To rotate: mint the replacement, switch the publisher, prove, then revoke the old one.

## `gcloud` on the server

The key file satisfies Pulumi. `gcloud` keeps its own account store. Activate once:

```bash
gcloud auth activate-service-account --key-file=$HERMES_GITOPS_HOME/env/<key>.json
gcloud config set project <project>
```

## Sequencing

1. Before `pulumi up`: `env/` populated.
2. Before scheduled backups: the writer key present.
3. Before a restore: repeat step 1 on the replacement server. Destruction wipes `env/` on
   purpose.

## Proof

Credentials are correct when the things that consume them say so:

```bash
hg auth prove [--control-plane <url>]     # sign-in resolves the right roles; an unbound identity is denied
HG_RESTORE_READER_SA=<env>-restore-reader@<project>.iam.gserviceaccount.com \
  hg platform verify-restore --from <backup-dir> --sink gs://...   # the reader reads what the writer wrote
hg backup verify                          # every routine's newest artifact holds what it claims
hg eval prove --control-plane <url> --component <id>   # EVALPUB001..004
hg launch prove                           # the aggregate
```

**Done when** every proof above passes with no `unknown` leg.
