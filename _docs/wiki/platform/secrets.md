# Secrets

**What this page tells you:** where secrets come from, how they reach a workload, and what
never enters Git.

## The rule

**No secret value is ever committed.** Names and references are in Git. Values are not.

That is why a restore needs credentials placed by hand before it runs. They were never in the
backup either.

## Where secrets come from

| Origin | How |
|---|---|
| Pulumi secret configuration | encrypted in the stack config |
| A file on the destination host | `env/shared.env`, placed by hand |
| A provisioning step's output | captured into encrypted Pulumi state (Slack apps do this) |
| `hg connection set` | one platform Secret per third-party connection; values never print |

There is one secret store in the cluster: a `ClusterSecretStore` named `hermes-gitops`, using
the External Secrets Operator's `kubernetes` provider, pointed at its own cluster. It is not a
vault. It copies Secrets between namespaces. Vault, GCP Secret Manager and SOPS were removed.

## How a secret reaches a workload

An application declares what it needs, by name, in `envRequires`. Those names become one
Secret per instance, `ag-eve-<name>-env`, in the instance's namespace, mounted with `envFrom`.

A connection's keys are projected the same way, as `<instance>-connection-<name>`. In the pod
the projection wins over the env overlay, so `hg up` seeds the connection from `.env` to keep
the two in agreement.

## Who owns what

| The platform owns | Your repo owns |
|---|---|
| The store, and how values travel | Declaring which secrets it needs |
| The Secret objects and their names | The variable names it reads |
| Every actual value | Nothing about where values come from |

## In Git, and not

| In Git | Never in Git |
|---|---|
| `envRequires` names and flags | any value |
| credential references | the credentials |

The communication schema has no field a value could go in.

## Rotation

Rotation is mechanical. Replace the value and roll the workload. Nothing knows a credential
is about to expire. Rotating an agent's secret rolls the agent, not the supporting workloads
that share it.

## Where to go next

- [Credentials](../runbooks/credentials.md), what an operator must hold
- [Inbound events](inbound-events.md), connections and their keys
- [Contract files](../reference/contracts/index.md), the exact fields
