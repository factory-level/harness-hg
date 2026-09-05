# Google sign-in at the edge

**Outcome:** the Cloudflare Access page in front of every published hostname offers
**Sign in with Google** beside the email one-time PIN. The PIN stays as the fallback, so a
broken OAuth client can never lock you out.

This is the edge gate only. Services behind it keep their own logins. See
[IAM](../platform/identity.md).

## Prerequisites

- [Cloudflare Tunnel setup](cloudflare-tunnel.md) done.
- A Google Cloud project that owns your operator identity.

## 1. Create the OAuth client

In the Google Cloud console, **APIs & Services → Credentials → Create credentials → OAuth
client ID**. No API exists for this step.

1. Application type **Web application**.
2. One authorized redirect URI: `https://<teamName>.cloudflareaccess.com/cdn-cgi/access/callback`.
3. Consent screen scopes `openid`, `email`, `profile`. Internal if your org allows it.
4. Record the client id and secret. From here they exist only in the console and in Pulumi
   config.

## 2. Configure and apply

```bash
cd infra
pulumi -s <env> config set --path 'controlPlaneIngress.access.googleClientId' <id>.apps.googleusercontent.com
pulumi -s <env> config set --secret --path 'controlPlaneIngress.access.googleClientSecret' <secret>
pulumi up -s <env>
```

Author the client id in `infra/environments/<env>.yaml` and `hg env apply <env>` too, or the
next apply overwrites it. Both keys or neither: a half-configured pair is refused.

## Rotation

Rotate the secret in the console, rerun the two `config set` lines and `pulumi up`. Deleting
both keys removes the provider; the PIN remains.

## Proof

**This proof is a person in a browser. There is no command for it.**

- A fresh browser on any published hostname shows both methods. The Google path signs in
  without a password.
- The PIN path still works.
- An email that matches no Access rule is denied whichever method it used.

The layer underneath is machine-checkable and is a different question:

```bash
hg auth prove --control-plane <url>      # AUTH001..009
```

**Done when** the three browser checks pass and `hg auth prove` is green.
