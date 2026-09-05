// Control-plane ingress (spec section 25): ONE outbound-only Cloudflare
// Tunnel publishing the operator-facing control-plane services (Grafana,
// Argo CD, optionally Hermes) PLUS one subdomain per installed agent,
// every hostname gated by its own Cloudflare Zero Trust Access
// application before traffic ever reaches the tunnel.
//
// Design principles carried from the spec:
//   - No inbound exposure: cloudflared dials OUT to Cloudflare's edge; the
//     cluster gets no public LoadBalancer, port, or IP.
//   - Identity at the edge: every ingress rule sets
//     originRequest.access.required with the matching app's AUD tag, so
//     cloudflared itself rejects any request that didn't pass Access
//     (defense in depth over the DNS-level gate).
//   - Declarative and stateful: tunnel, ingress rules, DNS, Access apps +
//     policies, token Secret and the cloudflared Deployment are all
//     resources of THIS component. Recovery is `pulumi up` (the same
//     backup-authority row as the rest of the bootstrap).
//   - Secret containment: the tunnel token is read via the provider's
//     token invoke and lands ONLY in a Kubernetes Secret consumed by the
//     cloudflared Deployment; the Cloudflare API token stays in Pulumi
//     secret config.
//
// Per-agent subdomains: each agents[] entry gets
// "<name>.<zoneName>" -> services.traefik with the host header rewritten
// to "<name>.<agentHostHeaderDomain>", so the profile's EXISTING
// in-cluster Ingress rules (examples/charts/site at /, charts/secret-tester at
// /secret-tester, ...) route the request without knowing Cloudflare
// exists. Adding an agent adds one hostname + Access app; no
// architectural change (the spec's "future enhancements" promise, made
// structural).
//
// Deviation from the spec's prose, on purpose: the cloudflared Deployment
// is Pulumi-managed here rather than Argo-CD-reconciled from Git. The
// scaffolded bootstrap/ tree is static and unconditional, while this
// whole feature is config-gated — a Git-reconciled Deployment would
// crash-loop on every fleet that doesn't use Cloudflare. Pulumi owns the
// tunnel lifecycle end to end instead, which also keeps token rotation a
// single `pulumi up`.
//
// Provider SDK: pulumi-cloudflare v6 (the ZeroTrust* resource family).
// v6 made Access policies STANDALONE: a policy no longer takes an
// applicationId; the application references its policies by id instead.

import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import * as random from "@pulumi/random";
import * as k8s from "@pulumi/kubernetes";
import {
  controlPlaneHostnames,
  type BootstrapConfig,
  type PublishedHostname,
} from "../../control-flow/config.ts";

export const CLOUDFLARED_NS = "cloudflare-tunnel";
export const TUNNEL_TOKEN_SECRET = "cloudflared-token";
// Pinned like every other bootstrap image/chart (deterministic deploys);
// bump deliberately.
const CLOUDFLARED_IMAGE = "cloudflare/cloudflared:2025.6.1";

export interface CloudflareIngressArgs {
  provider: k8s.Provider;
  config: BootstrapConfig;
}

export class CloudflareIngress extends pulumi.ComponentResource {
  readonly tunnelId: pulumi.Output<string>;
  readonly hostnames: string[];
  // The eval publisher's Access identity (ADR-81), null when nexus is not
  // published. Exported as stack outputs for HG_CF_ACCESS_CLIENT_ID/_SECRET.
  readonly evalPublisherClientId: pulumi.Output<string> | null;
  readonly evalPublisherClientSecret: pulumi.Output<string> | null;

  constructor(name: string, args: CloudflareIngressArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:CloudflareIngress", name, {}, opts);

    const cpi = args.config.controlPlaneIngress;
    if (args.config.cloudflareApiToken === null) {
      // validatePrerequisites already fails preview on this; the throw
      // here keeps the component safe standalone.
      throw new Error("cloudflare-ingress: cloudflareApiToken is required");
    }

    const cf = new cloudflare.Provider(
      "cloudflare",
      { apiToken: args.config.cloudflareApiToken },
      { parent: this },
    );
    const cfOpts = { parent: this, provider: cf };

    const published = controlPlaneHostnames(cpi, args.config.agents);
    this.hostnames = published.map((p) => p.host);

    // The eval publisher's identity (ADR-81): the service token `hg eval
    // publish|results|prove` sends as CF-Access-Client-Id/Secret headers
    // to traverse the nexus Access app from outside the cluster - the app
    // itself still demands an hgev_ bearer (write) or serves read routes,
    // and owner routes refuse non-owner identities, so this token
    // traverses the edge without becoming an owner. Scoped to the NEXUS
    // hostname's non_identity policy only, unlike the prober, which must
    // traverse every app. duration "forever" for the prober's reason:
    // rotation is a deliberate operator action, not an expiry surprise.
    const evalPublisher = published.some((p) => p.key === "nexus")
      ? new cloudflare.ZeroTrustAccessServiceToken(
          "eval-publisher",
          { accountId: cpi.accountId, name: "hermes-eval-publisher", duration: "forever" },
          cfOpts,
        )
      : null;
    this.evalPublisherClientId = evalPublisher?.clientId ?? null;
    this.evalPublisherClientSecret =
      evalPublisher === null ? null : pulumi.secret(evalPublisher.clientSecret);

    // Google login at the edge (#332): one account-level Zero Trust
    // identity provider from the operator's hand-minted OAuth client
    // (runbooks/google-sso.md - Google has no API for client creation).
    // Deliberately NOT pinned to any Access app (no allowedIdps, no
    // autoRedirectToIdentity): the account's one-time-PIN method stays
    // offered next to it, so a typo'd client id can never lock the
    // operator out of the edge, and Access remains only the first of two
    // gates ("you still have to sign in if you pass the Cloudflare").
    if (cpi.access.googleClientId !== "") {
      new cloudflare.ZeroTrustAccessIdentityProvider(
        "google-idp",
        {
          accountId: cpi.accountId,
          name: "Google",
          type: "google",
          config: {
            clientId: cpi.access.googleClientId,
            clientSecret: pulumi.secret(cpi.access.googleClientSecret),
          },
        },
        cfOpts,
      );
    }

    // 32-byte tunnel secret; rotating it (pulumi up with a new
    // RandomBytes, or taint) re-keys the tunnel and rolls cloudflared.
    const tunnelSecret = new random.RandomBytes(
      "tunnel-secret",
      { length: 32 },
      { parent: this },
    );

    // 1. The tunnel — remotely managed (configSrc cloudflare): its
    // ingress rules live in the Config resource below, not a local
    // config file, so `pulumi up` is the single mutation path.
    const tunnel = new cloudflare.ZeroTrustTunnelCloudflared(
      "control-plane",
      {
        accountId: cpi.accountId,
        name: "hermes-control-plane",
        tunnelSecret: tunnelSecret.base64,
        configSrc: "cloudflare",
      },
      cfOpts,
    );
    this.tunnelId = tunnel.id;

    // 2a. Named Access GROUPS (cloudflare.ZeroTrustAccessGroup) — the
    // reusable identity bundles per-target policies reference by id.
    // Declared once in accessGroups, assigned per target via
    // access.groups (resolved into each PublishedHostname.groups by
    // controlPlaneHostnames), so "platform-admins reach Argo CD, the
    // support team reaches only its own agent" is pure config.
    const accessGroups = new Map<string, cloudflare.ZeroTrustAccessGroup>();
    for (const [groupName, spec] of Object.entries(cpi.accessGroups)) {
      const groupIncludes: cloudflare.types.input.ZeroTrustAccessGroupInclude[] = [
        ...spec.emails.map((email) => ({ email: { email } })),
        ...spec.emailDomains.map((domain) => ({ emailDomain: { domain } })),
        ...spec.serviceTokenIds.map((tokenId) => ({ serviceToken: { tokenId } })),
      ];
      accessGroups.set(
        groupName,
        new cloudflare.ZeroTrustAccessGroup(
          `group-${groupName}`,
          { accountId: cpi.accountId, name: groupName, includes: groupIncludes },
          cfOpts,
        ),
      );
    }

    // 2b. Access application + policy per hostname. Per-application
    // policies mean scopes never leak between services (tighten Argo CD
    // to an admin group later without touching Grafana or the agents).
    // A hostname with group assignments gets EXACTLY those groups; only
    // unassigned hostnames use the flat fallback include (config
    // validation guarantees no hostname ends up with neither).
    const fallbackIncludes: cloudflare.types.input.ZeroTrustAccessPolicyInclude[] = [];
    if (cpi.access.emailDomain) {
      fallbackIncludes.push({ emailDomain: { domain: cpi.access.emailDomain } });
    }
    for (const tokenId of cpi.access.serviceTokenIds) {
      fallbackIncludes.push({ serviceToken: { tokenId } });
    }

    const apps = new Map<string, cloudflare.ZeroTrustAccessApplication>();
    for (const entry of published) {
      // Webhook endpoints (ADR 0174) are published WITHOUT Access: the
      // provider (Slack, GitHub, …) is an unauthenticated machine and its
      // request signature is the authentication, verified at the origin.
      // No Access application, no policy, no aud tag - the ingress rule
      // below sets access.required:false for these.
      if (entry.noAccess) continue;
      // Humans and service tokens CANNOT share a policy: an "allow"
      // decision authenticates identities, and Cloudflare evaluates a
      // service token only under a "non_identity" decision - mixing them
      // leaves every machine probe stuck at the login challenge. Found
      // live by `hg edge prove` on the first real environment (the #112
      // smoke checklist predicted exactly this and had never run).
      const humanIncludes: cloudflare.types.input.ZeroTrustAccessPolicyInclude[] =
        entry.groups.length > 0
          ? entry.groups.map((groupName) => ({
              group: { id: accessGroups.get(groupName)!.id },
            }))
          : fallbackIncludes.filter((i) => !("serviceToken" in i));
      const serviceTokenIncludes =
        entry.groups.length > 0 ? [] : fallbackIncludes.filter((i) => "serviceToken" in i);
      const tokenIncludes: cloudflare.types.input.ZeroTrustAccessPolicyInclude[] =
        entry.key === "nexus" && evalPublisher !== null
          ? [...serviceTokenIncludes, { serviceToken: { tokenId: evalPublisher.id } }]
          : serviceTokenIncludes;
      const policy = new cloudflare.ZeroTrustAccessPolicy(
        `${entry.key}-policy`,
        {
          accountId: cpi.accountId,
          name: `${entry.host}-allow`,
          decision: "allow",
          includes: humanIncludes,
        },
        cfOpts,
      );
      const appPolicies: { id: pulumi.Input<string>; precedence: number }[] = [
        { id: policy.id, precedence: 1 },
      ];
      if (tokenIncludes.length > 0) {
        const tokenPolicy = new cloudflare.ZeroTrustAccessPolicy(
          `${entry.key}-service-auth`,
          {
            accountId: cpi.accountId,
            name: `${entry.host}-service-auth`,
            decision: "non_identity",
            includes: tokenIncludes,
          },
          cfOpts,
        );
        appPolicies.push({ id: tokenPolicy.id, precedence: 2 });
      }
      const app = new cloudflare.ZeroTrustAccessApplication(
        `${entry.key}-app`,
        {
          accountId: cpi.accountId,
          name: entry.host,
          domain: entry.host,
          type: "self_hosted",
          sessionDuration: cpi.sessionDuration,
          policies: appPolicies,
        },
        cfOpts,
      );
      apps.set(entry.key, app);
    }

    // 3. Ingress rules — hostname order mirrors `published`; the
    // catch-all 404 MUST be last (cloudflared refuses the config
    // otherwise). Each rule re-enforces its own Access app via audTags.
    const ingressRule = (
      entry: PublishedHostname,
    ): cloudflare.types.input.ZeroTrustTunnelCloudflaredConfigConfigIngress => ({
      hostname: entry.host,
      service: entry.service,
      originRequest: {
        // A webhook endpoint has no Access app; do not require Access (and
        // never dereference apps.get, which is empty for it).
        ...(entry.noAccess
          ? {}
          : {
              access: {
                required: true,
                teamName: cpi.teamName,
                audTags: [apps.get(entry.key)!.aud],
              },
            }),
        ...(entry.hostHeader ? { httpHostHeader: entry.hostHeader } : {}),
        ...(entry.noTlsVerify ? { noTlsVerify: true } : {}),
      },
    });
    new cloudflare.ZeroTrustTunnelCloudflaredConfig(
      "control-plane-config",
      {
        accountId: cpi.accountId,
        tunnelId: tunnel.id,
        config: {
          ingresses: [...published.map(ingressRule), { service: "http_status:404" }],
        },
      },
      cfOpts,
    );

    // 4. DNS — proxied CNAME per hostname onto the tunnel. ttl 1 =
    // "automatic" (required for proxied records).
    for (const entry of published) {
      new cloudflare.DnsRecord(
        `${entry.key}-dns`,
        {
          zoneId: cpi.zoneId,
          name: entry.host,
          type: "CNAME",
          content: pulumi.interpolate`${tunnel.id}.cfargotunnel.com`,
          proxied: true,
          ttl: 1,
        },
        cfOpts,
      );
    }

    // 5. Tunnel token -> Kubernetes Secret -> cloudflared Deployment
    // (2 replicas: connector HA, so one pod restart never drops operator
    // access). The token is fetched via the provider invoke — v6's
    // tunnel resource does not export it directly.
    const token = cloudflare.getZeroTrustTunnelCloudflaredTokenOutput(
      { accountId: cpi.accountId, tunnelId: tunnel.id },
      { parent: this, provider: cf },
    ).token;

    const ns = new k8s.core.v1.Namespace(
      "cloudflared-ns",
      { metadata: { name: CLOUDFLARED_NS } },
      { parent: this, provider: args.provider },
    );
    const tokenSecret = new k8s.core.v1.Secret(
      "cloudflared-token",
      {
        metadata: { name: TUNNEL_TOKEN_SECRET, namespace: CLOUDFLARED_NS },
        stringData: { token: pulumi.secret(token) },
      },
      { parent: this, provider: args.provider, dependsOn: [ns] },
    );

    const labels = { "app.kubernetes.io/name": "cloudflared" };
    new k8s.apps.v1.Deployment(
      "cloudflared",
      {
        metadata: { name: "cloudflared", namespace: CLOUDFLARED_NS, labels },
        spec: {
          replicas: 2,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name: "cloudflared",
                  image: CLOUDFLARED_IMAGE,
                  args: ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"],
                  env: [
                    {
                      name: "TUNNEL_TOKEN",
                      valueFrom: {
                        secretKeyRef: { name: TUNNEL_TOKEN_SECRET, key: "token" },
                      },
                    },
                  ],
                  livenessProbe: {
                    httpGet: { path: "/ready", port: 2000 },
                    initialDelaySeconds: 10,
                    periodSeconds: 10,
                    failureThreshold: 3,
                  },
                },
              ],
            },
          },
        },
      },
      { parent: this, provider: args.provider, dependsOn: [tokenSecret] },
    );

    this.registerOutputs({ tunnelId: this.tunnelId });
  }
}
