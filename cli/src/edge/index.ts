// hg edge prove - the ADR-40/41 live edge acceptance matrix as ONE command.
// Verifies the REAL Cloudflare tunnel + Zero Trust Access the Pulumi stack
// provisioned: API-token permissions, DNS propagation, unauthenticated and
// bogus-token denial, undeclared hostnames unpublished, no public Service
// bypass, and `pulumi preview --expect-no-changes` idempotency.
//
// Read-only against Cloudflare and the cluster; the only mutation risk is
// none - every probe is a GET. Exit nonzero on any failed stage; one JSON
// report with --json. Pure helpers are exported for offline tests;
// transport is proven by the live run (same convention as dash/backup).

import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, HG_HOME, PLATFORM_ROOT, jsonOut, kubectl, log, ok, sh } from "../lib.ts";

interface Stage {
  stage: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface EdgeOptions {
  stack?: string;
  infraDir?: string;
  kubeconfig?: string;
  skipIdempotency: boolean;
  /** publish: substring matching ONE in-cluster Service (e.g. "postiz"). */
  app?: string;
  /** publish: explicit ns/service:port override when --app is ambiguous. */
  service?: string;
  /** publish: hostname label (default: "<app>-test"). unpublish: which URL. */
  hostname?: string;
  /** publish: comma-separated emails allowed through Access. */
  email?: string;
  /** publish: zone name when the token sees more than one. */
  zone?: string;
  /** unpublish: tear down every published test URL. */
  all: boolean;
}

export interface EdgeTarget {
  key: string;
  host: string;
  /** Published with no Access app (a webhook hostname, ADR 0174): the
   * provider's request signature is the auth, so the edge must answer
   * unauthenticated. Absent = Access-gated. */
  noAccess?: boolean;
}

export type Verdict =
  | "access-challenge"
  | "reachable"
  | "denied"
  | "not-published"
  | "origin-error"
  | "unreachable";

/** Classify one edge HTTP answer. `unreachable` is never produced here -
 * only by the fetch wrapper on a network error (NXDOMAIN, refused). */
export function classifyEdgeResponse(status: number, headers: Record<string, string>): Verdict {
  const location = headers["location"] ?? "";
  if (status >= 300 && status < 400) {
    let host = "";
    try {
      host = new URL(location).hostname;
    } catch {
      // relative redirect - the app's own (e.g. /login), not Access
    }
    return host.endsWith(".cloudflareaccess.com") ? "access-challenge" : "reachable";
  }
  if (status === 530) return "not-published"; // Cloudflare 1016/1033: hostname routed nowhere
  if (status === 401 || status === 403) return "denied";
  if (status >= 500) return "origin-error";
  return "reachable";
}

export interface EdgePlan {
  targets: EdgeTarget[];
  /** Access-gated hostnames: must challenge or deny an unauthenticated request. */
  accessGated: EdgeTarget[];
  /** No-Access webhook hostnames: must answer WITHOUT an Access challenge. */
  webhooks: EdgeTarget[];
  workloads: EdgeTarget[];
  grafana: EdgeTarget | undefined;
  unpublishedProbeHost: string;
}

export interface EdgeOutputs {
  edge_targets?: EdgeTarget[];
}

/** Build the check matrix from stack outputs. Pure - unit-tested. */
export function planEdgeChecks(outputs: EdgeOutputs): EdgePlan {
  const targets = outputs.edge_targets ?? [];
  if (targets.length === 0) {
    throw new Error(
      'stack has no edge_targets output - is controlPlaneIngress.provider "cloudflare", ' +
        "and has `pulumi up -s <stack>` run against current infra/?",
    );
  }
  const zone = targets[0]!.host.split(".").slice(1).join(".");
  return {
    targets,
    accessGated: targets.filter((t) => !t.noAccess),
    webhooks: targets.filter((t) => t.noAccess === true),
    workloads: targets.filter((t) => t.key.startsWith("workload-")),
    grafana: targets.find((t) => t.key === "grafana"),
    unpublishedProbeHost: `hg-edge-prove-unpublished.${zone}`,
  };
}

// The permission groups the bootstrap needs (edge.md "credential chain"),
// each probed by a read on the API surface that group governs. A read
// probe proves the permission GROUP is on the token, not its Edit level -
// Edit implies Read, and proving Edit would require mutating.
const TOKEN_PROBES: Array<{ permission: string; pathFor: (acct: string, zone: string) => string | null }> = [
  { permission: "Zone / DNS", pathFor: (_a, z) => (z ? `/zones/${z}/dns_records?per_page=1` : null) },
  { permission: "Account / Cloudflare Tunnel", pathFor: (a) => (a ? `/accounts/${a}/cfd_tunnel?per_page=1&is_deleted=false` : null) },
  { permission: "Account / Access: Apps and Policies", pathFor: (a) => (a ? `/accounts/${a}/access/apps?per_page=1` : null) },
  { permission: "Account / Access: Service Tokens", pathFor: (a) => (a ? `/accounts/${a}/access/service_tokens?per_page=1` : null) },
  { permission: "Account / Access: Groups", pathFor: (a) => (a ? `/accounts/${a}/access/groups?per_page=1` : null) },
];

export interface TokenProbeResult {
  permission: string;
  httpStatus: number;
  success: boolean;
}

/** Which permission groups the probes say are missing. Pure - unit-tested. */
export function missingPermissions(results: TokenProbeResult[]): string[] {
  return results.filter((r) => !r.success).map((r) => r.permission);
}

/** Read CLOUDFLARE_API_TOKEN without ever printing it: process env first,
 * then the repo-root .env (gitignored), then the stack's Pulumi secret. */
function resolveApiToken(stack: string, infraDir: string): string | null {
  if (process.env["CLOUDFLARE_API_TOKEN"]) return process.env["CLOUDFLARE_API_TOKEN"];
  const dotenv = path.join(PLATFORM_ROOT, ".env");
  if (fs.existsSync(dotenv)) {
    for (const line of fs.readFileSync(dotenv, "utf8").split("\n")) {
      const m = line.match(/^CLOUDFLARE_API_TOKEN=(.+)$/);
      if (m) return m[1]!.trim();
    }
  }
  if (!stack) return null;
  const fromPulumi = sh(
    ["pulumi", "config", "get", "hermes-gitops-bootstrap:cloudflareApiToken", "-s", stack],
    { cwd: infraDir, quiet: true, allowFail: true },
  ).trim();
  return fromPulumi || null;
}

interface CfResponse {
  status: number;
  success: boolean;
  result: unknown;
  errors: Array<{ code: number; message: string }>;
}

async function cfCall(
  token: string,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<CfResponse> {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: unknown;
      errors?: Array<{ code: number; message: string }>;
    };
    return {
      status: res.status,
      success: res.ok && parsed.success === true,
      result: parsed.result ?? null,
      errors: parsed.errors ?? [],
    };
  } catch {
    return { status: 0, success: false, result: null, errors: [{ code: 0, message: "network error" }] };
  }
}

async function cfApi(token: string, apiPath: string): Promise<{ status: number; success: boolean }> {
  const r = await cfCall(token, "GET", apiPath);
  return { status: r.status, success: r.success };
}

/** Throw with Cloudflare's own error text when a mutating call fails. */
function must<T>(r: CfResponse, what: string): T {
  if (!r.success) {
    const why = r.errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${r.status}`;
    throw new Error(`${what} failed - ${why}`);
  }
  return r.result as T;
}

async function fetchEdge(
  url: string,
  headers?: Record<string, string>,
): Promise<{ verdict: Verdict; status: number }> {
  try {
    const res = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
    await res.arrayBuffer().catch(() => undefined); // drain
    return { verdict: classifyEdgeResponse(res.status, h), status: res.status };
  } catch {
    return { verdict: "unreachable", status: 0 };
  }
}

// ---------------------------------------------------------------------------
// Test URLs: publish/unpublish a temporary hostname + Zero Trust Access app
// in front of ONE in-cluster Service, via the Cloudflare API directly (no
// Pulumi). This is the hg-loop counterpart of the bootstrap's control-plane
// ingress: same resource graph (tunnel → Access app+policy → tunnel config
// with audTags → connector → proxied DNS), same ordering (Access exists
// before the hostname does), torn down as one unit.

export interface ZoneInfo {
  id: string;
  name: string;
  account: { id: string };
}

/** Pick the zone: by name when given, else the only one the token sees. */
export function pickZone(zones: ZoneInfo[], wanted?: string): ZoneInfo {
  if (wanted) {
    const z = zones.find((x) => x.name === wanted);
    if (!z) {
      throw new Error(
        `zone ${JSON.stringify(wanted)} not visible to this token ` +
          `(visible: ${zones.map((x) => x.name).join(", ") || "<none>"})`,
      );
    }
    return z;
  }
  if (zones.length === 1) return zones[0]!;
  throw new Error(
    zones.length === 0
      ? "the token sees no zones - scope it to the target zone"
      : `the token sees ${zones.length} zones (${zones.map((x) => x.name).join(", ")}) - pass --zone`,
  );
}

export interface SvcInfo {
  namespace: string;
  name: string;
  port: number;
}

/** Match ONE Service by substring; ambiguity and no-match both fail loudly. */
export function pickService(services: SvcInfo[], query: string): SvcInfo {
  const hits = services.filter((s) => s.name.includes(query));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) {
    throw new Error(`no Service matches ${JSON.stringify(query)} - check \`kubectl get svc -A\``);
  }
  throw new Error(
    `${hits.length} Services match ${JSON.stringify(query)}: ` +
      hits.map((s) => `${s.namespace}/${s.name}`).join(", ") +
      " - narrow the match or pass --service <ns>/<name>:<port>",
  );
}

/** The remotely-managed tunnel config: one ingress rule with Access
 * enforced at the connector (audTags), catch-all 404 last. */
export function tunnelConfig(
  hostname: string,
  origin: string,
  teamName: string,
  aud: string,
): unknown {
  return {
    config: {
      ingress: [
        {
          hostname,
          service: origin,
          originRequest: { access: { required: true, teamName: teamName, audTag: [aud] } },
        },
        { service: "http_status:404" },
      ],
    },
  };
}

/** Connector manifests (plain kubectl apply - no Helm, so nothing collides
 * with the hg loop's own releases). One namespace shared by all test URLs;
 * one secret + deployment per URL. */
export function connectorManifests(ns: string, name: string, tunnelToken: string): unknown[] {
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: ns } },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: `${name}-token`, namespace: ns },
      stringData: { TUNNEL_TOKEN: tunnelToken },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace: ns, labels: { "hg.dev/edge-test": name } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [
              {
                name: "cloudflared",
                image: "cloudflare/cloudflared:2025.6.1",
                args: ["tunnel", "--no-autoupdate", "run"],
                env: [
                  {
                    name: "TUNNEL_TOKEN",
                    valueFrom: { secretKeyRef: { name: `${name}-token`, key: "TUNNEL_TOKEN" } },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  ];
}

const EDGE_TEST_NS = "hg-edge-test";
const EDGE_TESTS_FILE = () => path.join(HG_HOME, "edge-tests.json");

interface EdgeTestRecord {
  hostname: string;
  origin: string;
  zoneId: string;
  accountId: string;
  tunnelId: string;
  appId: string;
  dnsRecordId: string;
  deployment: string;
  emails: string[];
  createdAt: string;
}

function loadEdgeTests(): EdgeTestRecord[] {
  try {
    return JSON.parse(fs.readFileSync(EDGE_TESTS_FILE(), "utf8")) as EdgeTestRecord[];
  } catch {
    return [];
  }
}

function saveEdgeTests(records: EdgeTestRecord[]): void {
  fs.mkdirSync(HG_HOME, { recursive: true });
  fs.writeFileSync(EDGE_TESTS_FILE(), JSON.stringify(records, null, 2));
}

function requireToken(opts: EdgeOptions): string {
  const token = resolveApiToken(opts.stack ?? "", opts.infraDir ?? path.join(PLATFORM_ROOT, "infra"));
  if (!token) {
    throw new CliError(
      "no Cloudflare credential: set CLOUDFLARE_API_TOKEN in the environment or the repo .env",
    );
  }
  return token;
}

async function edgePublish(json: boolean, opts: EdgeOptions): Promise<void> {
  if (!opts.app && !opts.service) {
    throw new CliError('edge publish needs --app <name-substring> (e.g. --app postiz) or --service <ns>/<name>:<port>');
  }
  const emails = (opts.email ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) {
    throw new CliError("edge publish needs --email <addr>[,addr...] - the identities Access will admit");
  }
  const token = requireToken(opts);

  // Who and where: zone chosen, Zero Trust org present. Listing zones is
  // also the validity check - account-owned tokens (cfat_*) fail the
  // user-token verify endpoint while being perfectly valid.
  const zones = must<ZoneInfo[]>(await cfCall(token, "GET", "/zones?per_page=50"), "list zones");
  const zone = pickZone(zones, opts.zone);
  const accountId = zone.account.id;
  const org = must<{ auth_domain?: string }>(
    await cfCall(token, "GET", `/accounts/${accountId}/access/organizations`),
    "read Zero Trust organization (configure the Zero Trust team first)",
  );
  const teamName = (org.auth_domain ?? "").split(".")[0] ?? "";
  if (!teamName) throw new CliError("the account has no Zero Trust team - set one up in the dashboard first");

  // The origin: ONE in-cluster Service.
  let svc: SvcInfo;
  if (opts.service) {
    const m = opts.service.match(/^([a-z0-9-]+)\/([a-z0-9-]+):(\d+)$/);
    if (!m) throw new CliError("--service must be <namespace>/<name>:<port>");
    svc = { namespace: m[1]!, name: m[2]!, port: Number(m[3]) };
  } else {
    const raw = JSON.parse(kubectl(["get", "svc", "-A", "-o", "json"], { quiet: true })) as {
      items: Array<{ metadata: { namespace: string; name: string }; spec: { ports?: Array<{ port: number }> } }>;
    };
    svc = pickService(
      raw.items
        .filter((s) => s.spec.ports?.length)
        .map((s) => ({ namespace: s.metadata.namespace, name: s.metadata.name, port: s.spec.ports![0]!.port })),
      opts.app!,
    );
  }
  const origin = `http://${svc.name}.${svc.namespace}.svc.cluster.local:${svc.port}`;

  const label = (opts.hostname ?? `${opts.app ?? svc.name}-test`).replace(/[^a-z0-9-]/g, "-");
  const hostname = `${label}.${zone.name}`;
  if (loadEdgeTests().some((r) => r.hostname === hostname)) {
    throw new CliError(`${hostname} is already published - \`hg edge unpublish --hostname ${label}\` first`);
  }
  log(`publishing https://${hostname} → ${origin} (Access: ${emails.join(", ")})`);

  // Same ordering as the bootstrap: Access protection exists before the
  // hostname resolves anywhere.
  const tunnel = must<{ id: string }>(
    await cfCall(token, "POST", `/accounts/${accountId}/cfd_tunnel`, {
      name: `hg-edge-${label}`,
      config_src: "cloudflare",
    }),
    "create tunnel",
  );
  const rollback: Array<() => Promise<void>> = [
    async () => void (await cfCall(token, "DELETE", `/accounts/${accountId}/cfd_tunnel/${tunnel.id}`)),
  ];
  try {
    const app = must<{ id: string; aud: string }>(
      await cfCall(token, "POST", `/accounts/${accountId}/access/apps`, {
        name: `hg-edge-${label}`,
        domain: hostname,
        type: "self_hosted",
        session_duration: "12h",
      }),
      "create Access application",
    );
    rollback.push(async () => void (await cfCall(token, "DELETE", `/accounts/${accountId}/access/apps/${app.id}`)));
    must(
      await cfCall(token, "POST", `/accounts/${accountId}/access/apps/${app.id}/policies`, {
        name: `hg-edge-${label}-allow`,
        decision: "allow",
        precedence: 1,
        include: emails.map((e) => ({ email: { email: e } })),
      }),
      "create Access policy",
    );
    must(
      await cfCall(
        token,
        "PUT",
        `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`,
        tunnelConfig(hostname, origin, teamName, app.aud),
      ),
      "configure tunnel ingress",
    );
    const tunnelToken = must<string>(
      await cfCall(token, "GET", `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`),
      "fetch tunnel token",
    );
    const deployment = `cf-${label}`;
    for (const manifest of connectorManifests(EDGE_TEST_NS, deployment, tunnelToken)) {
      kubectl(["apply", "-f", "-"], { input: JSON.stringify(manifest), quiet: true });
    }
    rollback.push(async () => {
      kubectl(["delete", "deployment", deployment, "-n", EDGE_TEST_NS], { quiet: true, allowFail: true });
      kubectl(["delete", "secret", `${deployment}-token`, "-n", EDGE_TEST_NS], { quiet: true, allowFail: true });
    });
    const dns = must<{ id: string }>(
      await cfCall(token, "POST", `/zones/${zone.id}/dns_records`, {
        type: "CNAME",
        name: hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      }),
      "create DNS record",
    );
    const record: EdgeTestRecord = {
      hostname,
      origin,
      zoneId: zone.id,
      accountId,
      tunnelId: tunnel.id,
      appId: app.id,
      dnsRecordId: dns.id,
      deployment,
      emails,
      createdAt: new Date().toISOString(),
    };
    saveEdgeTests([...loadEdgeTests(), record]);

    // Wait until the edge answers, then confirm the Access challenge.
    let live = false;
    for (let i = 0; i < 18 && !live; i++) {
      await Bun.sleep(10_000);
      const r = await fetchEdge(`https://${hostname}/`);
      live = r.verdict !== "unreachable";
    }
    const check = await fetchEdge(`https://${hostname}/`);
    const summary = {
      command: "edge-publish",
      ok: true,
      url: `https://${hostname}`,
      origin,
      emails,
      unauthenticatedVerdict: check.verdict,
      note:
        check.verdict === "access-challenge"
          ? "live - unauthenticated requests get the Access login"
          : `published; current unauthenticated verdict is ${check.verdict} (DNS may still be propagating)`,
    };
    if (json) jsonOut(summary);
    else ok(`${summary.url} → ${origin} [${summary.note}]`);
  } catch (err) {
    for (const undo of rollback.reverse()) await undo().catch(() => undefined);
    throw err instanceof CliError ? err : new CliError(`edge publish: ${(err as Error).message}`);
  }
}

async function edgeUnpublish(json: boolean, opts: EdgeOptions): Promise<void> {
  const records = loadEdgeTests();
  const targets = opts.all
    ? records
    : records.filter(
        (r) => r.hostname === opts.hostname || r.hostname.split(".")[0] === opts.hostname,
      );
  if (targets.length === 0) {
    throw new CliError(
      opts.all
        ? "no published test URLs"
        : `no published test URL matches ${JSON.stringify(opts.hostname ?? "")} - ` +
          `published: ${records.map((r) => r.hostname).join(", ") || "<none>"} (or --all)`,
    );
  }
  const token = requireToken(opts);
  const removed: string[] = [];
  for (const r of targets) {
    kubectl(["delete", "deployment", r.deployment, "-n", EDGE_TEST_NS], { quiet: true, allowFail: true });
    kubectl(["delete", "secret", `${r.deployment}-token`, "-n", EDGE_TEST_NS], { quiet: true, allowFail: true });
    await cfCall(token, "DELETE", `/zones/${r.zoneId}/dns_records/${r.dnsRecordId}`);
    await cfCall(token, "DELETE", `/accounts/${r.accountId}/access/apps/${r.appId}`);
    // The connector needs a moment to drop; stale connections block deletion.
    for (let i = 0; i < 6; i++) {
      await cfCall(token, "DELETE", `/accounts/${r.accountId}/cfd_tunnel/${r.tunnelId}/connections`);
      const del = await cfCall(token, "DELETE", `/accounts/${r.accountId}/cfd_tunnel/${r.tunnelId}`);
      if (del.success || del.status === 404) break;
      await Bun.sleep(5_000);
    }
    removed.push(r.hostname);
    if (!json) ok(`removed ${r.hostname}`);
  }
  const remaining = loadEdgeTests().filter((r) => !removed.includes(r.hostname));
  saveEdgeTests(remaining);
  if (remaining.length === 0) {
    kubectl(["delete", "namespace", EDGE_TEST_NS], { quiet: true, allowFail: true });
  }
  if (json) jsonOut({ command: "edge-unpublish", ok: true, removed });
}

function edgeList(json: boolean): void {
  const records = loadEdgeTests();
  if (json) {
    jsonOut({ command: "edge-list", ok: true, urls: records });
    return;
  }
  if (records.length === 0) log("no published test URLs");
  for (const r of records) {
    log(`https://${r.hostname} → ${r.origin} (emails: ${r.emails.join(", ")}; since ${r.createdAt})`);
  }
}

export async function cmdEdge(json: boolean, args: string[], opts: EdgeOptions): Promise<void> {
  const [sub] = args;
  if (sub === "publish") return edgePublish(json, opts);
  if (sub === "unpublish") return edgeUnpublish(json, opts);
  if (sub === "list") return edgeList(json);
  if (sub !== "prove") throw new CliError("unknown edge subcommand (prove, publish, unpublish, list)");
  if (!opts.stack) throw new CliError("edge prove needs --stack <pulumi stack name>");
  const stack = opts.stack;
  const infraDir = opts.infraDir ?? path.join(PLATFORM_ROOT, "infra");

  const stages: Stage[] = [];
  const stage = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      const detail = await fn();
      stages.push({ stage: name, ok: true, detail });
      if (!json) ok(`${name}: ${detail}`);
    } catch (err) {
      stages.push({ stage: name, ok: false, detail: (err as Error).message });
      if (!json) console.error(`  ✗ ${name}: ${(err as Error).message}`);
    }
  };
  const skip = (name: string, why: string): void => {
    stages.push({ stage: name, ok: true, skipped: true, detail: `skipped: ${why}` });
    if (!json) log(`${name}: skipped (${why})`);
  };
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(msg);
  };

  // --- 1. The API token has the permissions the bootstrap needs ------------
  const token = resolveApiToken(stack, infraDir);
  if (!token) {
    skip(
      "api-token-permissions",
      "no CLOUDFLARE_API_TOKEN in the environment or repo .env, and no " +
        "cloudflareApiToken Pulumi secret readable for this stack",
    );
  } else {
    await stage("api-token-permissions", async () => {
      // User tokens verify at /user/tokens/verify; account-owned tokens
      // (cfat_*) fail there while being valid - /accounts is the check
      // that covers both.
      const verify = await cfApi(token, "/user/tokens/verify");
      const accounts = verify.success ? verify : await cfApi(token, "/accounts");
      assert(
        accounts.success,
        `the token authenticates neither as a user token nor an account token ` +
          `(HTTP ${accounts.status}) - it is invalid, expired, or disabled`,
      );
      const cpiRaw = sh(
        ["pulumi", "config", "get", "hermes-gitops-bootstrap:controlPlaneIngress", "-s", stack],
        { cwd: infraDir, quiet: true, allowFail: true },
      ).trim();
      let accountId = "";
      let zoneId = "";
      try {
        const cpi = JSON.parse(cpiRaw) as { accountId?: string; zoneId?: string };
        accountId = cpi.accountId ?? "";
        zoneId = cpi.zoneId ?? "";
      } catch {
        // config not set yet - probes below degrade to verify-only
      }
      const results: TokenProbeResult[] = [];
      let probed = 0;
      for (const probe of TOKEN_PROBES) {
        const apiPath = probe.pathFor(accountId, zoneId);
        if (apiPath === null) continue;
        probed += 1;
        const r = await cfApi(token, apiPath);
        results.push({ permission: probe.permission, httpStatus: r.status, success: r.success });
      }
      const missing = missingPermissions(results);
      assert(
        missing.length === 0,
        `token is active but lacks permission group(s): ${missing.join(", ")} - ` +
          "recreate it with Zone/DNS/Edit, Account/Cloudflare Tunnel/Edit, " +
          "Access: Apps and Policies/Edit, Access: Service Tokens/Edit, Access: Groups/Edit",
      );
      return probed === 0
        ? "token active (accountId/zoneId not in stack config yet - permission probes pending)"
        : `token active, ${probed} permission group(s) probed, none missing`;
    });
  }

  // --- 2. Stack outputs → check matrix -------------------------------------
  let plan: EdgePlan | null = null;
  let outputs: EdgeOutputs = {};
  await stage("stack-outputs", async () => {
    outputs = JSON.parse(
      sh(["pulumi", "stack", "output", "--json", "--show-secrets", "-s", stack], {
        cwd: infraDir,
        quiet: true,
      }),
    ) as EdgeOutputs;
    plan = planEdgeChecks(outputs);
    return `${plan.targets.length} published target(s), ${plan.workloads.length} workload(s)`;
  });
  if (plan === null) {
    // Everything downstream needs the matrix; secondary failures would only
    // obscure the one real error above.
    for (const name of [
      "dns-propagation",
      "unauthenticated-denied",
      "bogus-token-denied",
      "webhook-reachable-unauthenticated",
      "undeclared-not-published",
      "no-origin-bypass",
      "pulumi-idempotency",
    ]) {
      skip(name, "no published targets resolved");
    }
    return finish(json, stages);
  }
  const p: EdgePlan = plan;

  // --- 3. DNS propagation --------------------------------------------------
  await stage("dns-propagation", async () => {
    // First `pulumi up` mints proxied CNAMEs; propagation takes minutes.
    let pending = [...p.targets];
    for (let attempt = 0; attempt < 12 && pending.length > 0; attempt++) {
      if (attempt > 0) await Bun.sleep(10_000);
      const still: EdgeTarget[] = [];
      for (const t of pending) {
        const r = await fetchEdge(`https://${t.host}/`);
        if (r.verdict === "unreachable") still.push(t);
      }
      pending = still;
    }
    assert(
      pending.length === 0,
      `no HTTP answer after ~2min from: ${pending.map((t) => t.host).join(", ")} - ` +
        "DNS not propagated, or the record was never created",
    );
    return `${p.targets.length} hostname(s) answering`;
  });

  // --- 5. Unauthenticated request is challenged (§18.2, browser path) ------
  await stage("unauthenticated-denied", async () => {
    for (const t of p.accessGated) {
      const r = await fetchEdge(`https://${t.host}/`);
      assert(
        r.verdict === "access-challenge" || r.verdict === "denied",
        `${t.key} (${t.host}): expected an Access challenge without credentials, got ${r.verdict} (HTTP ${r.status})`,
      );
    }
    return `${p.accessGated.length} Access-gated target(s) challenge unauthenticated requests`;
  });

  // --- 6. A bogus service token is denied (§18.2, machine path) ------------
  await stage("bogus-token-denied", async () => {
    const bogus = {
      "CF-Access-Client-Id": "hg-edge-prove-bogus.access",
      "CF-Access-Client-Secret": "0000000000000000000000000000000000000000000000000000000000000000",
    };
    for (const t of p.accessGated) {
      const r = await fetchEdge(`https://${t.host}/`, bogus);
      assert(
        r.verdict === "denied" || r.verdict === "access-challenge",
        `${t.key} (${t.host}): a bogus service token got ${r.verdict} (HTTP ${r.status})`,
      );
    }
    return `${p.accessGated.length} Access-gated target(s) reject a bogus service token`;
  });

  // --- 7. No-Access webhook hostnames answer WITHOUT a challenge (ADR 0174)
  // A Slack/GitHub events URL cannot present an Access credential; the
  // signature verified at the origin is its auth. The edge must therefore
  // pass the request through - an Access challenge here means the hostname
  // was published gated and the provider's deliveries are silently lost.
  if (p.webhooks.length === 0) {
    skip("webhook-reachable-unauthenticated", "no no-Access webhook hostnames declared");
  } else {
    await stage("webhook-reachable-unauthenticated", async () => {
      for (const t of p.webhooks) {
        const r = await fetchEdge(`https://${t.host}/`);
        assert(
          r.verdict !== "access-challenge",
          `${t.key} (${t.host}): a no-Access webhook hostname answered an Access challenge - ` +
            "the provider cannot sign in; it was published gated",
        );
        assert(
          r.verdict !== "not-published" && r.verdict !== "unreachable",
          `${t.key} (${t.host}): not reachable through the edge (${r.verdict}, HTTP ${r.status})`,
        );
      }
      return `${p.webhooks.length} webhook hostname(s) reach the origin unauthenticated`;
    });
  }

  // --- 8. An undeclared hostname is not published (§18.6) ------------------
  await stage("undeclared-not-published", async () => {
    const r = await fetchEdge(`https://${p.unpublishedProbeHost}/`);
    assert(
      r.verdict === "unreachable" || r.verdict === "not-published",
      `${p.unpublishedProbeHost}: expected NXDOMAIN or 530, got ${r.verdict} (HTTP ${r.status}) - ` +
        "something published a hostname nothing declared",
    );
    return `${p.unpublishedProbeHost} is ${r.verdict}`;
  });

  // --- 9. No public Service bypasses the tunnel (§18.7) --------------------
  if (!opts.kubeconfig) {
    skip("no-origin-bypass", "pass --kubeconfig to check the cluster for public Service exposure");
  } else {
    const kc = opts.kubeconfig;
    await stage("no-origin-bypass", async () => {
      const svcs = JSON.parse(
        sh(["kubectl", "--kubeconfig", kc, "get", "svc", "-A", "-o", "json"], { quiet: true }),
      ) as { items: Array<{ metadata: { namespace: string; name: string }; spec: { type?: string } }> };
      // ponytail: coarse - flags ANY LoadBalancer/NodePort (k3s's bundled
      // servicelb for traefik will trip it); an allowlist of known-fronting
      // Services is the upgrade path if that proves too noisy.
      const pub = svcs.items.filter(
        (s) => s.spec.type === "LoadBalancer" || s.spec.type === "NodePort",
      );
      assert(
        pub.length === 0,
        `publicly exposed Service(s): ${pub.map((s) => `${s.metadata.namespace}/${s.metadata.name} (${s.spec.type})`).join(", ")}`,
      );
      return `${svcs.items.length} Service(s), none LoadBalancer/NodePort`;
    });
  }

  // --- 10. A second pulumi up changes nothing (§18.8) ----------------------
  if (opts.skipIdempotency) {
    skip("pulumi-idempotency", "--skip-idempotency");
  } else {
    await stage("pulumi-idempotency", async () => {
      sh(["pulumi", "preview", "--expect-no-changes", "-s", stack], { cwd: infraDir, quiet: true });
      return "pulumi preview --expect-no-changes is clean";
    });
  }

  return finish(json, stages);
}

function finish(json: boolean, stages: Stage[]): void {
  const failed = stages.filter((s) => !s.ok);
  const report = {
    command: "edge-prove",
    ok: failed.length === 0,
    stages,
    summary: {
      total: stages.length,
      passed: stages.filter((s) => s.ok && !s.skipped).length,
      skipped: stages.filter((s) => s.skipped).length,
      failed: failed.length,
    },
  };
  if (json) jsonOut(report);
  else if (report.ok) ok(`edge prove: ${report.summary.passed} stage(s) passed, ${report.summary.skipped} skipped`);
  if (!report.ok) {
    throw new CliError(
      `edge prove: ${failed.length} stage(s) FAILED (${failed.map((f) => f.stage).join(", ")})`,
    );
  }
}
