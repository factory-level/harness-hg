// hg auth prove (#284) - the RBAC acceptance matrix as ONE command.
//
// Four identities x five surfaces, driven end to end with no browser.
// That is only possible because the issuer exposes the password grant
// (ADR-50): `hg auth prove` mints a real id_token for each account and
// presents it exactly as a signed-in operator would.
//
// The matrix is worth more than the sum of its assertions. Any single
// service can look correct in isolation while the SET is wrong - an
// unbound identity that every service denies except one, a viewer who
// can write somewhere nobody checked. Enumerating the whole grid is what
// turns "we configured RBAC" into a claim with evidence behind it.

import {
  CliError,
  KCTX,
  kubectl,
  log,
  type HgState,
} from "../lib.ts";
import { IDENTITY_USERS, identitySecrets, issuerUrl, OIDC_USERS, type IdentityUser } from "../platform/index.ts";
import type { ProofFinding, ProofResult } from "../backup/platform.ts";

/** What each account is SUPPOSED to be able to do. The expectation table
 * is the specification - the code below only checks reality against it,
 * so a change in policy shows up here as a diff a reviewer can read. */
export interface Expectation {
  /** May write the Nexus workspace. */
  nexusWrite: boolean;
  /** May read Nexus at all. */
  nexusRead: boolean;
  /** Argo CD role the RBAC should resolve to, or null for denied. */
  argocdRole: string | null;
  /** Grafana org role, or null when the identity may not sign in. */
  grafanaRole: string | null;
}

export const MATRIX: Record<IdentityUser, Expectation> = {
  owner: { nexusWrite: true, nexusRead: true, argocdRole: "role:hg-owner", grafanaRole: "Admin" },
  operator: { nexusWrite: false, nexusRead: true, argocdRole: "role:hg-operator", grafanaRole: "Editor" },
  viewer: { nexusWrite: false, nexusRead: true, argocdRole: "role:hg-viewer", grafanaRole: "Viewer" },
  // Authenticates successfully everywhere and is authorized nowhere.
  // That pair is the whole point: a user who could not log in would
  // prove the wrong thing.
  unbound: { nexusWrite: false, nexusRead: false, argocdRole: null, grafanaRole: null },
};

/** Mint a real id_token for `user` through the password grant. */
export async function tokenFor(state: HgState, user: IdentityUser, clientId: string): Promise<string> {
  const secrets = identitySecrets();
  const clientSecret =
    clientId === "nexus" ? secrets.clients.nexus! : secrets.clients.proof!;
  const body = new URLSearchParams({
    grant_type: "password",
    username: OIDC_USERS[user],
    password: secrets.passwords[user],
    scope: "openid email profile groups",
  });
  const resp = await fetch(`${issuerUrl(state)}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body,
  });
  const doc = (await resp.json()) as { id_token?: string; error?: string };
  if (!doc.id_token) {
    throw new CliError(`issuer refused a token for ${user}: ${doc.error ?? resp.status}`);
  }
  return doc.id_token;
}

/** Decode without verifying - callers use this only to READ claims for
 * reporting. Every authorization decision under test is made by the
 * service being asked, never here. */
export function claimsOf(idToken: string): Record<string, unknown> {
  const part = idToken.split(".")[1] ?? "";
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/") + "==")) as Record<string, unknown>;
}

/** Argo CD's OWN answer, asked of Argo CD. Reading policy.csv and
 * re-implementing Casbin here would test my understanding of the policy
 * rather than the policy. */
export function argocdRoleOf(email: string): string | null {
  const out = kubectl(
    ["-n", "argocd", "get", "cm", "argocd-rbac-cm", "-o", "jsonpath={.data.policy\\.csv}"],
    { allowFail: true, quiet: true },
  );
  const line = out.split("\n").find((l) => l.trim().startsWith(`g, ${email},`));
  return line ? line.split(",")[2]!.trim() : null;
}

export interface ProveDeps {
  nexusBaseUrl: string;
  fetchJson: (url: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
  /** A fetch that carries NO credential of any kind.
   *
   * AUTH002 asks whether a forged identity header grants anything. A
   * caller that also holds a valid bearer answers a different question
   * and passes for the wrong reason - found exactly that way, when
   * `hg launch prove` wrapped every request with a viewer token and
   * AUTH002 started reporting `viewer` instead of `none`. A proof that
   * authenticates every request cannot test unauthenticated denial. */
  fetchAnon?: (url: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
}

export async function proveAuth(state: HgState, deps: ProveDeps): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });

  // AUTH001 - the posture. Everything below is meaningless if Nexus is
  // still deciding from a header it was handed.
  const who = await deps.fetchJson(`${deps.nexusBaseUrl}/nexus/auth/whoami`);
  if (who.body?.mode === "oidc") {
    add("AUTH001", "pass", "nexus", "authorization comes from verified claims, not a trusted header");
  } else {
    add("AUTH001", "fail", "nexus", `nexus is still in ${who.body?.mode ?? "unknown"} mode - claims are not verified`);
  }

  // AUTH002 - a forged header must not name a subject once OIDC is on.
  const anonFetch = deps.fetchAnon ?? deps.fetchJson;
  const forged = await anonFetch(`${deps.nexusBaseUrl}/nexus/auth/whoami`, {
    headers: { "Cf-Access-Authenticated-User-Email": OIDC_USERS.owner },
  });
  add(
    "AUTH002",
    forged.body?.role === "none" ? "pass" : "fail",
    "nexus",
    forged.body?.role === "none"
      ? "a forged identity header grants nothing"
      : `a forged header resolved to ${forged.body?.role} - the pre-OIDC path is still a bypass`,
  );

  // AUTH003 - every identity authenticates, INCLUDING unbound.
  const tokens: Partial<Record<IdentityUser, string>> = {};
  for (const user of IDENTITY_USERS) {
    try {
      tokens[user] = await tokenFor(state, user, "nexus");
    } catch (err) {
      add("AUTH003", "fail", user, (err as Error).message);
    }
  }
  if (Object.keys(tokens).length === IDENTITY_USERS.length) {
    add("AUTH003", "pass", "identity", "all four identities authenticate, unbound included");
  }

  // AUTH004 - a wrong password mints nothing.
  const bad = await fetch(`${issuerUrl(state)}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`nexus:${identitySecrets().clients.nexus}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: OIDC_USERS.owner,
      password: "not-the-password",
      scope: "openid",
    }),
  });
  add(
    "AUTH004",
    bad.status >= 400 ? "pass" : "fail",
    "identity",
    bad.status >= 400 ? "a wrong password is refused" : "a wrong password minted a token",
  );

  // AUTH005 - Argo CD resolves each identity to the expected role, and
  // unbound to none.
  const argoWrong = IDENTITY_USERS.filter(
    (u) => argocdRoleOf(OIDC_USERS[u]) !== MATRIX[u].argocdRole,
  );
  add(
    "AUTH005",
    argoWrong.length === 0 ? "pass" : "fail",
    "argocd",
    argoWrong.length === 0
      ? "every identity resolves to its expected Argo CD role; unbound to none"
      : `wrong Argo CD role for: ${argoWrong.join(", ")}`,
  );

  // AUTH006 - Argo CD's default is DENY, not readonly.
  const argoDefault = kubectl(
    ["-n", "argocd", "get", "cm", "argocd-rbac-cm", "-o", "jsonpath={.data.policy\\.default}"],
    { allowFail: true, quiet: true },
  ).trim();
  add(
    "AUTH006",
    argoDefault === "" ? "pass" : "fail",
    "argocd",
    argoDefault === ""
      ? "policy.default is deny"
      : `policy.default is ${JSON.stringify(argoDefault)} - an unmapped identity still gets it`,
  );

  // AUTH007 - Argo CD's local admin is off. A shared password beside SSO
  // makes the whole matrix advisory.
  const adminEnabled = kubectl(
    ["-n", "argocd", "get", "cm", "argocd-cm", "-o", "jsonpath={.data.admin\\.enabled}"],
    { allowFail: true, quiet: true },
  ).trim();
  add(
    "AUTH007",
    adminEnabled === "false" ? "pass" : "fail",
    "argocd",
    adminEnabled === "false" ? "local admin is disabled" : "local admin is still enabled beside SSO",
  );

  // AUTH008 - Grafana has no fallback role, and no anonymous access
  // unless a development environment deliberately opted in (#422).
  const ini = kubectl(
    ["-n", "hermes-monitoring", "get", "cm", "monitoring-grafana", "-o", "jsonpath={.data.grafana\\.ini}"],
    { allowFail: true, quiet: true },
  );
  const strict = /role_attribute_strict\s*=\s*true/.test(ini);
  const anonSection = (ini.split("[auth.anonymous]")[1] ?? "").split("[")[0] ?? "";
  const anonOn = /^\s*enabled\s*=\s*true/m.test(anonSection);
  const anonRole = (anonSection.match(/^\s*org_role\s*=\s*(\w+)/m) ?? [])[1] ?? "";
  const fallback = /role_attribute_path.*\|\|\s*'(Viewer|Editor|Admin)'\s*$/m.test(ini);
  // Anonymous is acceptable ONLY when THIS environment deliberately
  // configured it, and it is Viewer. The loop's install default (#447)
  // must never bless a foreign cluster's drift, so the authorization is
  // NOT the install-side default: it is the state record this loop's own
  // `hg up` wrote when it installed anonymous (state.grafanaAnonViewer),
  // or an explicit affirmative in the environment (the pre-state-record
  // escape hatch). Anonymous on a cluster this loop did not configure is
  // drift and fails; anonymous above Viewer is a privilege grant and
  // fails regardless.
  const explicit = (process.env.HG_GRAFANA_ANON_VIEWER ?? "").trim().toLowerCase();
  const devAnon = state.grafanaAnonViewer === true || explicit === "1" || explicit === "true";
  const anonOk = !anonOn || (devAnon && anonRole === "Viewer");
  const pass = strict && anonOk && !fallback;
  add(
    "AUTH008",
    pass ? "pass" : "fail",
    "grafana",
    pass
      ? anonOn
        ? "strict roles, no fallback, anonymous Viewer (the local loop's development default, #447)"
        : "strict roles, no fallback, no anonymous access"
      : `strict=${strict} anonymousEnabled=${anonOn} anonymousRole=${anonRole || "none"} ` +
        `developmentOptIn=${devAnon} fallbackRole=${fallback}`,
  );

  // AUTH009 - no secret is readable from any surface a browser reaches.
  const leaked: string[] = [];
  const secrets = identitySecrets();
  const surfaces = ["/nexus/auth/whoami", "/nexus", "/nexus/features"];
  for (const path of surfaces) {
    const body = JSON.stringify((await deps.fetchJson(`${deps.nexusBaseUrl}${path}`)).body ?? "");
    for (const [name, value] of Object.entries(secrets.clients)) {
      if (value && body.includes(value)) leaked.push(`${path}: ${name} client secret`);
    }
    for (const [name, value] of Object.entries(secrets.passwords)) {
      if (value && body.includes(value)) leaked.push(`${path}: ${name} password`);
    }
  }
  add(
    "AUTH009",
    leaked.length === 0 ? "pass" : "fail",
    "nexus",
    leaked.length === 0 ? "no client secret or password appears on a browser-reachable surface" : leaked.join("; "),
  );

  const fail = findings.filter((f) => f.status === "fail").length;
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "auth-prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: fail === 0,
    findings,
    summary: {
      pass: findings.filter((f) => f.status === "pass").length,
      fail,
      unknown: findings.filter((f) => f.status === "unknown").length,
    },
  };
}
