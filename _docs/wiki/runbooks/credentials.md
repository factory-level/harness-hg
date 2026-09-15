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

## When `hg team` refuses a credential

`hg team plan`, `apply`, `resume` and `compile` check credentials before reading, provisioning or
publishing anything, in three steps. Each step lists everything it finds, and a step runs only
when the one before it passes. No refusal prints a value.

**1. Access.** Nothing is judged missing until hg can read what the plan names.

| Refusal | Fix |
|---|---|
| Google credentials need re-authentication | `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a deployer key |
| `PULUMI_BACKEND_URL` differs from the installation's backend | unset it, or export the backend the message names |
| no environment spec derives the stack's backend | add or repair `infra/environments/<stack>.yaml` with the stack's `name` and `project` |
| a stack config file cannot be read, or is not valid YAML | fix its permissions, or the YAML at the line and column named |
| stack not found on backend | create the stack on the named backend, or correct the stack name |
| Pulumi is not logged in to a backend | export the `PULUMI_BACKEND_URL` the message names |
| Cloud KMS refused to decrypt | grant `roles/cloudkms.cryptoKeyDecrypter` on the stack's key, or impersonate the deployer |
| kube context does not exist | run on the destination host, or merge that cluster's kubeconfig under the context name |
| Kubernetes API server unreachable | fix the network path to the context's server |
| RBAC denies get on a declared Secret | grant `get` on that Secret, by name, to the context's identity |

hg derives the backend from the environment spec named for the bootstrap stack:
`infra/environments/<stack>.yaml`, or `infra/environments/<dir>/environment.yaml`. It never falls
back to your last `pulumi login`.

**2. Completeness.** Every missing value, grouped by agent, each with its config path and fix:

- an input path that is absent, empty, or still `<UNSET - see findings>`;
- that placeholder anywhere in a stack file the plan names;
- a binding, source, runtime or app-value variable with no source.

The fix stores the value encrypted in the stack config, then points the plan at it:

```bash
(cd infra && PULUMI_BACKEND_URL=<backend> pulumi config set --secret --path '<path>' \
  --stack <stack> --config-file <file>)
```

`pulumi config set` reads the value from the prompt or stdin. Never pass it as an argument.

**3. Delivery.** After rendering, every required `envRequires` variable must reach the agent's
pod Secret: delivered, not empty plaintext, not a placeholder, and listed in the agent's
`environment` so the startup check runs with it.

`hg env apply` writes nothing while any secret is unset. It prints one `pulumi config set` per
secret instead.

## Proof

Credentials are correct when the things that consume them say so:

```bash
hg auth prove [--control-plane <url>]     # sign-in resolves the right roles; an unbound identity is denied
HG_RESTORE_READER_SA=<env>-restore-reader@<project>.iam.gserviceaccount.com \
  hg platform verify-restore --from <backup-dir> --sink gs://...   # the reader reads what the writer wrote
hg backup verify                          # every routine's newest artifact holds what it claims
hg eval prove --control-plane <url> --component <id>   # EVALPUB001..004
hg launch prove                           # the aggregate
hg team plan --plan <installation.yaml> --dir <bootstrap>   # no credential refusal
```

**Done when** every proof above passes with no `unknown` leg.
