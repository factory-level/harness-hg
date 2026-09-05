# infra/pulumi/programs/cloudflare-tunnel

The Cloudflare Tunnel ingress path for one Hermes agent instance — invoked
by the Pulumi Kubernetes Operator via the Stack CR
`harness/hermes/charts/hermes-profile/templates/tunnel/stack-cloudflare.yaml` renders. See
that template's header comment and `cloudflare_tunnel/config.py` for the
config-key contract between the two (must byte-match; no automated
drift-check yet).

No stack files (`Pulumi.<stack>.yaml`) are committed — this program is
config-driven only, purely by design (every value it needs arrives via the
Stack CR's `spec.config`). `.gitignore` enforces this
(`infra/pulumi/programs/*/Pulumi.*.yaml`).

## Modules

| File | Owns |
|---|---|
| `cloudflare_tunnel/config.py` | Typed, validated read of the `cloudflare:*`/`hermes:*`/`gcp:*` config keys — split into a pure `_parse()` for direct offline unit testing (`tests/test_config.py`). |
| `cloudflare_tunnel/tunnel.py` | The `ZeroTrustTunnelCloudflared` connector, its remote ingress config (one rule per `spec.expose.services[]` entry + a mandatory catch-all), and the connector token data source. |
| `cloudflare_tunnel/dns.py` | The DNS CNAME publishing the tunnel's public hostname. |
| `cloudflare_tunnel/access.py` | The Zero Trust Access application + policy (service-token / idp / mixed) + a per-instance Access service token. |
| `cloudflare_tunnel/secrets.py` | Writes the minted tunnel token + Access service-token credentials to the configured secret backend (k8s Secret or GCP Secret Manager, config-switched). |

## Hostname pattern

One hostname per instance, `<name>.agents.<zone>`, with every
`spec.expose.services[]` entry routed by **path** under that same hostname
— the same one-host/per-service-path shape
`harness/hermes/charts/hermes-profile/templates/pod/ingress.yaml` already uses for the
plain-Ingress provider. This repo's original planning spec (referenced in
this task's brief as "spec section 6.2") was not present in this checkout
to consult directly; this is a reasoned, documented pick consistent with
that existing precedent, not a blind guess — see `_docs/wiki/platform/tunneling-cloudflare.md` for
the full write-up, including the "two services with the same/no `path`
collide" caveat this shares with `ingress.yaml` (operator error, not new
here).

## Access policy mapping

`spec.expose.access.policy` (schemas/hermesprofile/v1alpha2's enum) maps
to a single, reusable `ZeroTrustAccessPolicy`'s `includes` (OR'd — a user
needs to satisfy only one entry to be granted access):

| `access.policy` | `includes` |
|---|---|
| `service-token` (default) | `any_valid_service_token` only |
| `idp` | `login_method(id=cloudflare.access.idpId)` only |
| `mixed` | both (a valid service token OR a successful idp login) |

`cloudflare.access.idpId` (cluster-values) must reference an **existing**
Cloudflare Access Identity Provider integration — this program never
creates one (see `_docs/wiki/platform/tunneling-cloudflare.md`).

## Secret delivery

This program WRITES the tunnel connector token and the
Access service token's `client_id`/`client_secret` as plain
`pulumi_kubernetes.core.v1.Secret`s in the `hermes-secrets` namespace
(nothing else could pre-seed a value Pulumi itself hasn't minted yet),
under `hermes-<name>-cf-tunnel-token` / `hermes-<name>-access-token`
(naming convention: `hermes-<name>-<kebab(VAR)>`), read back into the
instance's own namespace by
`harness/hermes/charts/hermes-profile/templates/tunnel/cf-tunnel-token-secret.yaml`'s
ExternalSecret. k8s is the only secret backend (external backends were
removed — issue #30 [H1]).

The tunnel Stack's workspace ServiceAccount needs RBAC to write Secrets
into `hermes-secrets` — **not auto-provisioned by the chart**, an
operator sets it up out of band. See `_docs/wiki/platform/tunneling-cloudflare.md`'s "Kubernetes
RBAC for the workspace pod" section.

## Cloudflare provider authentication

`pulumi_cloudflare` reads `CLOUDFLARE_API_TOKEN` from the environment
(confirmed against the installed SDK's `config/vars.py` —
`apiToken`/`CLOUDFLARE_API_TOKEN`) — the Stack CR sets this as an envRef
sourced from a chart-rendered ExternalSecret
(`harness/hermes/charts/hermes-profile/templates/tunnel/cloudflare-api-token.yaml`),
reading a SHARED, fleet-wide remote key (an operator seeds ONE Cloudflare
API token for the whole fleet — see `_docs/wiki/platform/tunneling-cloudflare.md`'s "API token
scopes" section for exactly which scopes it needs).

## Verification tier reached (issue #25 [G4]: in-cluster half live-verified)

The IN-CLUSTER half of this path is live-verified on a real k3d cluster
by `infra/scripts/verify-cloudflare-local.sh` — PKO conditional install, the
tunnel Stack CR admitted + reconciled, and the whole k8s
secret-delivery/copy chain (fleet keys + written-back per-instance
token) with the cloudflared sidecar wired to the synced Secret. The
Cloudflare-API half (real tunnel/DNS/Access + the 403/200 round-trip)
still needs operator credentials — `_docs/wiki/platform/tunneling-cloudflare.md`'s "Manual
live-verification procedure". Original offline tier below.

### Offline tier (original, no Cloudflare credentials available)

- `python -m compileall __main__.py cloudflare_tunnel` — clean, no syntax
  errors.
- Every module import-checked.
- Every `pulumi_cloudflare`/`pulumi_kubernetes`/`pulumi_gcp` resource,
  Args class, and data-source function this program calls
  (`ZeroTrustTunnelCloudflared`, `ZeroTrustTunnelCloudflaredConfig` +
  its `Config`/`ConfigIngress` Args, `get_zero_trust_tunnel_cloudflared_token_output`,
  `Record`, `ZeroTrustAccessPolicy` + `PolicyInclude*` Args,
  `ZeroTrustAccessApplication` + `ApplicationDestination`/
  `ApplicationPolicy` Args, `ZeroTrustAccessServiceToken`,
  `k8s.core.v1.Secret`) had its actual installed-SDK signature inspected
  directly (`pulumi_cloudflare==6.18.0`, `pulumi_kubernetes==4.33.0`
  — `uv add`'d into a throwaway scratch project, then
  this program's own `pyproject.toml` pinned to compatible ranges and
  `uv sync`'d) to confirm every keyword argument this code passes is
  real, and that the `ZeroTrustTunnelCloudflared*`/`ZeroTrustAccess*`
  names (not the older `Tunnel`/`TunnelConfig`/`AccessApplication`/
  `AccessPolicy`/`AccessServiceToken` names, still present in 6.x for
  backwards compatibility) are in fact what the installed provider
  documents as current.
- `pytest` (`uv run --group dev pytest -q`, this program's own
  `.venv`/lockfile) — no network access, no Cloudflare/Kubernetes
  credentials, no live API call of any kind:
  - `tests/test_config.py` — pure, offline validation of every branch in
    `config._parse()` (missing required fields, empty `expose`, malformed
    `expose` entries, invalid/idp-without-idpId access policies,
    removed/unrecognized secret providers).
  - `tests/test_tunnel.py` — `hostname()`/`ingress_rules()` (per-service
    rule shape, mandatory trailing catch-all, zero-service edge case) -
    pure functions building `pulumi.input_type` Args objects with no
    active Pulumi runtime context needed (confirmed this constructs fine
    standalone against the installed SDK before relying on it here).
  - `tests/test_access.py` — `includes_for_policy()`'s
    service-token/idp/mixed mapping.
  - `tests/test_secrets.py` — `pulumi.runtime.set_mocks(...)`-based
    (Pulumi's own offline testing mechanism) coverage
    of `write_k8s_secret`/`deliver()`, plus the
    unsupported-backend rejection path — including a
    real, live-discovered detail: `pulumi_kubernetes` marks
    `Secret.string_data`'s VALUES as Pulumi secrets automatically, which
    only surfaced once these tests were written against the real SDK (not
    something recalled from memory) — see `test_secrets.py`'s comments
    for exactly where this mattered.
- **No `pulumi preview`/`pulumi up` was run against live Cloudflare
  APIs** — this task's brief explicitly prohibited any Cloudflare/GCP API
  call, and no credentials for either were available on this machine
  regardless. See `_docs/wiki/platform/tunneling-cloudflare.md`'s "Manual live-verification
  procedure" section for the documented, not-executed procedure an
  operator with real Cloudflare/GCP access would follow, and its "What was
  NOT live-verified" section for the honest, itemized list of everything
  this task could not confirm.
