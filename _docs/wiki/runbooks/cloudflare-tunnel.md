# Cloudflare Tunnel setup

**Outcome:** the control plane reachable over HTTPS through a Cloudflare Tunnel, with an
access policy in front of it, verified against the real account, and no inbound port on
the server.

The model: [Tunnels](../platform/tunneling.md).

## Prerequisites

- A Cloudflare account with a zone you control and Zero Trust enabled.
- A bootstrapped destination server: [Install a destination server](install.md).
- In `infra/environments/<env>.yaml`: `controlPlaneIngress.{accountId,zoneId,zoneName,teamName}`
  and at least one Access rule (`access.emailDomain`, `serviceTokenIds` or `groups`).

## 1. Create the API token

One token builds the whole edge and can destroy public routes into your environment. Scope
it to one account and one zone. Never use a Global API Key.

| Scope | Permission |
|---|---|
| Account · Cloudflare Tunnel | Edit |
| Account · Access: Apps and Policies | Edit |
| Account · Access: Service Tokens | Edit |
| Account · Access: Groups | Edit |
| Account · Access: Organizations, Identity Providers | Edit (for Google sign-in only) |
| Zone · DNS | Edit |

## 2. Give it to the platform

```bash
pulumi config set --secret cloudflareApiToken <token> --cwd infra
```

## 3. Select the provider

```bash
pulumi -s <env> config set --path 'controlPlaneIngress.provider' cloudflare --cwd infra
```

This is the step people miss. Everything below is gated on it. Author non-secret values in
`infra/environments/<env>.yaml` and run `hg env apply <env>`, or the next apply overwrites
them.

## 4. Apply

```bash
pulumi up --cwd infra
```

That creates the tunnel, the DNS records, a Zero Trust Access application per hostname and
its policies. The connector runs in-cluster and dials out.

## 5. Add an identity provider

Until you attach one, you have published a public URL. Do
[Google sign-in at the edge](google-sso.md) now.

## Common failures

| Symptom | Cause |
|---|---|
| nothing is tunnelled | step 3 |
| token preflight fails | a permission from step 1 is missing |
| DNS does not resolve | propagation, or the wrong zone |
| an anonymous request succeeds | no Access application in front: step 5, urgent |
| connector `CrashLoopBackOff` | the tunnel token Secret has not reached the namespace |

## Rotation

```bash
pulumi config set --secret cloudflareApiToken <new-token> --cwd infra
pulumi up --cwd infra
hg edge prove --stack <stack>      # prove before revoking the old token
```

## Cleanup

```bash
pulumi -s <env> config set --path 'controlPlaneIngress.provider' none --cwd infra
pulumi up -s <env> --cwd infra
```

Temporary URLs from `hg edge publish` are separate; remove them with `hg edge unpublish`.

## Proof

```bash
hg edge prove --stack <stack> --kubeconfig <path>
```

`--stack` is required. `--kubeconfig` enables the bypass check; without it that check is
skipped. It verifies against the real account: token permissions, DNS, a real HTTP answer,
denial for anonymous and bogus-token requests, no undeclared hostname published, no public
Service around the tunnel, and `pulumi preview --expect-no-changes`.

**Done when** it exits zero. The denials matter as much as the success.
