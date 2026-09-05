# `state/` — the state-backend stack (spec §23)

Pulumi state lives in GCS; secrets are encrypted with Cloud KMS. The
chain roots in a **manually created bucket and key** (below), because
Pulumi cannot store the state of the stack that creates the state bucket
inside that same bucket. This stack is the only one whose backend is
that manual root; it provisions, per agent, a state bucket + deploy
service account + IAM for the `infra/` stacks — so different users and
service accounts apply infra changes by logging in to exactly the
backend bucket (and identity) for the agent they deploy, and nothing
else.

Full guide: the ops quickstart in the wiki (#675).

## 1. The manual root of trust (super-admin, once, by hand)

Its IAM stays manual — Pulumi never touches the root bucket's or root
key's access policy. Only the `infra-root@` group may run this stack.

```bash
PROJECT="<project-id>"
ROOT_GROUP="infra-root@example.dev"

# root state bucket — versioned, private, uniform IAM
gcloud storage buckets create "gs://${PROJECT}-pulumi-root-state" \
  --location=US --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://${PROJECT}-pulumi-root-state" --versioning
gcloud storage buckets add-iam-policy-binding "gs://${PROJECT}-pulumi-root-state" \
  --member="group:${ROOT_GROUP}" --role="roles/storage.objectAdmin"

# root KMS key — encrypts state/ secrets (and, by default, agent secrets)
gcloud kms keyrings create pulumi --location=us
gcloud kms keys create pulumi-root \
  --location=us --keyring=pulumi --purpose=encryption --rotation-period=90d \
  --next-rotation-time="$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)"
gcloud kms keys add-iam-policy-binding pulumi-root \
  --location=us --keyring=pulumi \
  --member="group:${ROOT_GROUP}" --role="roles/cloudkms.cryptoKeyEncrypterDecrypter"
```

## 2. Then: `hg env new`

Everything after the root of trust belongs to the front door (#676).
Declare the environment once — `infra/environments/<name>.yaml`
(schema `cli/schemas/environment/v1alpha1`) — and:

```bash
gcloud auth application-default login   # as an infra-root member
hg env new <name> --dry-run             # the exact sequence, hand-executable
hg env new <name>                       # preflight (ENV001..) -> both stacks
                                        # init'd, config generated, pulumi up,
                                        # hand-off to hg server bootstrap
```

`hg` assembles every `gs://` and `gcpkms://` URI from the spec; re-running
resumes (completed steps skip by probe). Adding an agent to an environment
is one spec change + `hg env apply` + `pulumi up`.

Outputs of this stack: `agentBackends` (agent → `gs://` bucket),
`agentDeployers` (agent → SA email), `agentSecretsProviders` (agent →
`--secrets-provider` value — the root key, or the agent's own key in
`perAgentKeys` mode).
