// The identity issuer's pure parts (ADR-50, #284).
//
// The one thing that can silently break this whole milestone is the
// ISSUER STRING. It lands in every token's `iss` claim and is the base
// every client fetches discovery and JWKS from, so it has to resolve to
// the same Dex from a browser on the host AND from inside a pod. A
// mismatch surfaces as an opaque `oidc: issuer did not match` deep inside
// a redirect, which is why it is computed in one function and asserted
// here rather than assembled at each call site.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  grafanaOidcValues,
  hermesOidcEnv,
  IDENTITY_USERS,
  issuerUrl,
  localRedirectUris,
  nexusOidcValues,
  OIDC_USERS,
} from "../src/platform/index.ts";
import { MATRIX } from "../src/auth/prove.ts";
import type { HgState } from "../src/lib.ts";

const state = (over: Partial<HgState> = {}): HgState =>
  ({
    profileDir: "/x",
    profileName: "x",
    trusted: true,
    gatewayIp: "172.25.0.1",
    ports: { git: 1, http: 8080, sink: 3, identity: 5000 },
    ...over,
  }) as HgState;

describe("issuerUrl", () => {
  test("is the host-gateway address, which BOTH sides can reach", () => {
    // Not 127.0.0.1 (pods cannot reach it) and not the in-cluster
    // Service DNS name (a browser cannot resolve it).
    expect(issuerUrl(state())).toBe("http://172.25.0.1:5000/dex");
  });

  test("carries the /dex path prefix the chart serves on", () => {
    expect(issuerUrl(state())).toEndWith("/dex");
  });
});

describe("localRedirectUris", () => {
  test("nexus returns to the plugin's own callback on its exposed port", () => {
    const s = state({ expose: { nexus: { localPort: 41234 } } });
    expect(localRedirectUris(s, "nexus")).toEqual([
      "http://127.0.0.1:41234/api/plugins/hermes-gitops/nexus/auth/callback",
    ]);
  });

  test("nexus with no exposure declares NO redirect rather than a wrong one", () => {
    // A redirect URI that does not match where the browser actually is
    // fails at the callback with an unhelpful error; declaring none fails
    // at sign-in with a clear one.
    expect(localRedirectUris(state(), "nexus")).toEqual([]);
  });

  test("the proof client has no browser leg at all", () => {
    // It exists only for the password grant. A redirect URI on it would
    // be an authorization-code path nobody drives and nobody reviews.
    expect(localRedirectUris(state(), "hg-proof")).toEqual([]);
  });

  test("an unknown client id gets nothing, never a guess", () => {
    expect(localRedirectUris(state(), "whatever")).toEqual([]);
  });
});

describe("the committed bootstrap Application", () => {
  const app = parseYaml(
    readFileSync(
      join(import.meta.dir, "..", "..", "infra", "gitops-template", "bootstrap", "identity.yaml"),
      "utf8",
    ),
  ) as { spec: { source: { targetRevision: string; helm: { valuesObject: Record<string, any> } } } };
  const config = app.spec.source.helm.valuesObject.config;

  test("the chart version is pinned", () => {
    expect(app.spec.source.targetRevision).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the password connector is enabled - without it the RBAC proof is browser-only", () => {
    // Dex answers `unsupported_grant_type` to the password grant without
    // this, even with enablePasswordDB on, and discovery advertises the
    // grant either way - so nothing but a live attempt reveals it.
    expect(config.oauth2.passwordConnector).toBe("local");
    expect(config.enablePasswordDB).toBe(true);
  });

  test("no client secret or password hash is committed", () => {
    // Every one arrives through the environment from a Secret. This is
    // the assertion that keeps the file safe to commit.
    const body = JSON.stringify(app);
    for (const client of config.staticClients) {
      expect(client.secret).toBeUndefined();
      expect(client.secretEnv).toMatch(/^DEX_[A-Z]+_SECRET$/);
    }
    for (const user of config.staticPasswords) {
      expect(user.hash).toBeUndefined();
      expect(user.hashFromEnv).toMatch(/^DEX_[A-Z]+_HASH$/);
    }
    expect(body).not.toMatch(/\$2[aby]\$/); // no bcrypt hash anywhere
  });

  test("an unbound user exists and authenticates - that is the point", () => {
    // "unbound is denied" is unprovable without an identity that signs in
    // successfully and is then refused by every service. A user who
    // cannot authenticate proves the wrong thing.
    const emails = config.staticPasswords.map((u: { email: string }) => u.email);
    expect(emails).toContain("unbound@hermes.local");
    expect(emails.sort()).toEqual(IDENTITY_USERS.map((u) => `${u}@hermes.local`).sort());
  });

  test("no connector is declared - a half-configured one fails at redirect time", () => {
    expect(config.connectors).toEqual([]);
  });

  test("storage survives a pod roll", () => {
    // `memory` would log everyone out on every restart, which reads as an
    // outage rather than a deployment.
    expect(config.storage.type).toBe("kubernetes");
  });

  test("approval is not skipped", () => {
    expect(config.oauth2.skipApprovalScreen).toBe(false);
  });
});

// Per-service role mappings (#284). SSO shares identity; each service
// keeps its own authorization vocabulary. These assert the one property
// every mapping must have: an identity the operator has NOT placed in a
// role gets nothing, from any of them.
describe("per-service role mappings", () => {
  const s = state({ ports: { git: 1, http: 8080, sink: 3, identity: 5000 } });

  test("grafana maps the three roles and refuses everyone else", () => {
    const ini = (grafanaOidcValues(s) as any).grafana["grafana.ini"];
    const path = ini["auth.generic_oauth"].role_attribute_path as string;
    expect(path).toContain("owner@hermes.local");
    expect(path).toContain("'Admin'");
    expect(path).toContain("'Editor'");
    expect(path).toContain("'Viewer'");
    // No trailing literal fallback. Grafana's documented escape hatch is
    // `|| 'Viewer'`, which would hand every unmapped identity a working
    // read-only login - and there goes "unbound is denied".
    expect(path).not.toMatch(/\|\|\s*'(Viewer|Editor|Admin)'\s*$/);
    expect(ini["auth.generic_oauth"].role_attribute_strict).toBe(true);
    expect(ini["auth.generic_oauth"].allow_assign_grafana_admin).toBe(false);
  });

  test("grafana turns anonymous access OFF once an issuer exists", () => {
    // An anonymous Viewer makes every "denied" assertion vacuous, and
    // design 14 is explicit that the MVP runs no anonymous Grafana.
    const ini = (grafanaOidcValues(s) as any).grafana["grafana.ini"];
    expect(ini["auth.anonymous"].enabled).toBe(false);
  });

  test("grafana is untouched when there is no issuer", () => {
    expect(grafanaOidcValues(state({ ports: { git: 1, http: 2, sink: 3 } }))).toEqual({});
  });

  test("the unbound account appears in NO service's role map", () => {
    const grafana = JSON.stringify(grafanaOidcValues(s));
    // It exists as an account and is mapped nowhere. That pair is what
    // makes the denial provable rather than assumed.
    expect(OIDC_USERS.unbound).toBe("unbound@hermes.local");
    expect(grafana).not.toContain(OIDC_USERS.unbound);
  });

  test("nexus never receives a role map naming the unbound account", () => {
    const nexus = JSON.stringify(nexusOidcValues(s));
    expect(nexus).not.toContain(OIDC_USERS.unbound);
    expect(nexus).toContain(OIDC_USERS.owner);
  });
});

describe("no secret reaches a values file", () => {
  test("grafana's client secret is a reference, not a literal", () => {
    // The subchart refuses a literal outright (assertNoLeakedSecrets) -
    // found the hard way, by a failed helm upgrade on the live cluster.
    // This keeps the fix from regressing quietly.
    const v = grafanaOidcValues(
      state({ ports: { git: 1, http: 8080, sink: 3, identity: 5000 } }),
    ) as any;
    expect(v.grafana["grafana.ini"]["auth.generic_oauth"].client_secret).toBeUndefined();
    expect(v.grafana.envValueFrom.GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET.secretKeyRef.name).toBe(
      "grafana-oidc",
    );
  });

  test("nexus's client secret is a reference too", () => {
    const v = JSON.stringify(nexusOidcValues(state({ ports: { git: 1, http: 2, sink: 3, identity: 5000 } })));
    expect(v).not.toContain("clientSecret");
    expect(v).toContain('"clientId":"nexus"');
  });
});

// Hermes Classic (#284). The fork already ships a conformant self-hosted
// OIDC provider, and the profile chart already delivers dashboard-auth
// vars through the env Secret - so this leg is configuration, and these
// assert it is the RIGHT configuration.
describe("hermesOidcEnv", () => {
  const s = state({ ports: { git: 1, http: 8080, sink: 3, identity: 5000 } });

  test("points the dashboard at the same issuer as everything else", () => {
    const env = hermesOidcEnv(s);
    expect(env.HERMES_DASHBOARD_OIDC_ISSUER).toBe(issuerUrl(s));
    expect(env.HERMES_DASHBOARD_OIDC_CLIENT_ID).toBe("hermes");
    expect(env.HERMES_DASHBOARD).toBe("1");
  });

  test("requests the groups scope", () => {
    // The provider carries a groups claim into the session, which is
    // what a role mapping reads. Without the scope there is no claim.
    expect(hermesOidcEnv(s).HERMES_DASHBOARD_OIDC_SCOPES).toContain("groups");
  });

  test("a fleet with no issuer keeps whatever auth it had", () => {
    expect(hermesOidcEnv(state({ ports: { git: 1, http: 2, sink: 3 } }))).toEqual({});
  });
});

describe("the hermes client accepts every agent dashboard", () => {
  test("one redirect URI per exposed dashboard, not just the first", () => {
    // Each profile runs its own Hermes instance behind its own forward,
    // and they share this client - so a single URI would break sign-in
    // for every agent but one.
    const s = state({
      ports: { git: 1, http: 8080, sink: 3, identity: 5000 },
      expose: {
        "marketing-sre:dashboard": { localPort: 31111 },
        "marketing-engagement:dashboard": { localPort: 32222 },
        "marketing-sre:hooks": { localPort: 33333 },
      },
    });
    const uris = localRedirectUris(s, "hermes");
    expect(uris).toEqual([
      "http://127.0.0.1:31111/auth/callback",
      "http://127.0.0.1:32222/auth/callback",
    ]);
    // A non-dashboard exposure is not a browser surface.
    expect(uris.join()).not.toContain("33333");
  });
});

// The expectation table (#284). It is the SPECIFICATION - `hg auth
// prove` only checks reality against it - so a policy change shows up
// here as a diff a reviewer can read.
describe("the RBAC matrix", () => {
  test("only the owner may write", () => {
    expect(MATRIX.owner.nexusWrite).toBe(true);
    for (const u of ["operator", "viewer", "unbound"] as const) {
      expect(MATRIX[u].nexusWrite).toBe(false);
    }
  });

  test("unbound is authorized NOWHERE", () => {
    // It authenticates everywhere and is authorized nowhere. Every entry
    // for it has to be the denying one, or the account stops proving
    // anything at all.
    expect(MATRIX.unbound).toEqual({
      nexusWrite: false,
      nexusRead: false,
      argocdRole: null,
      grafanaRole: null,
    });
  });

  test("every account has an expectation - no silent gaps", () => {
    for (const u of IDENTITY_USERS) expect(MATRIX[u]).toBeDefined();
  });

  test("the roles descend without a tie", () => {
    // Two accounts with identical expectations would let a bug in either
    // hide behind the other.
    const seen = new Set(
      IDENTITY_USERS.map((u) => JSON.stringify(MATRIX[u])),
    );
    expect(seen.size).toBe(IDENTITY_USERS.length);
  });
});
