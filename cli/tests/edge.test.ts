// Pure-function coverage for hg edge prove. Transport (real Cloudflare,
// pulumi, kubectl) is proven by the live run, per the CLI convention.

import { describe, expect, test } from "bun:test";
import {
  classifyEdgeResponse,
  connectorManifests,
  missingPermissions,
  pickService,
  pickZone,
  planEdgeChecks,
  tunnelConfig,
  type EdgeTarget,
  type SvcInfo,
  type ZoneInfo,
} from "../src/edge/index.ts";

describe("classifyEdgeResponse", () => {
  test("302 to the Access team domain is an access-challenge", () => {
    expect(
      classifyEdgeResponse(302, {
        location: "https://myteam.cloudflareaccess.com/cdn-cgi/access/login/x",
      }),
    ).toBe("access-challenge");
  });

  test("a relative redirect is the app's own (reachable), not Access", () => {
    expect(classifyEdgeResponse(302, { location: "/login" })).toBe("reachable");
  });

  test("2xx is reachable", () => {
    expect(classifyEdgeResponse(200, {})).toBe("reachable");
  });

  test("401/403 are denied", () => {
    expect(classifyEdgeResponse(401, {})).toBe("denied");
    expect(classifyEdgeResponse(403, {})).toBe("denied");
  });

  test("530 is not-published (hostname routed to no tunnel)", () => {
    expect(classifyEdgeResponse(530, {})).toBe("not-published");
  });

  test("5xx is origin-error", () => {
    expect(classifyEdgeResponse(502, {})).toBe("origin-error");
  });
});

describe("planEdgeChecks", () => {
  const TARGETS: EdgeTarget[] = [
    { key: "grafana", host: "grafana.example.com" },
    { key: "argocd", host: "argocd.example.com" },
    { key: "agent-crm", host: "crm.example.com" },
    { key: "workload-crm-postiz", host: "postiz.example.com" },
  ];

  test("splits workloads by key prefix and finds grafana", () => {
    const plan = planEdgeChecks({ edge_targets: TARGETS });
    expect(plan.targets.length).toBe(4);
    expect(plan.workloads.map((w) => w.key)).toEqual(["workload-crm-postiz"]);
    expect(plan.grafana?.host).toBe("grafana.example.com");
  });

  test("derives the undeclared probe host from the first target's zone", () => {
    const plan = planEdgeChecks({ edge_targets: TARGETS });
    expect(plan.unpublishedProbeHost).toBe("hg-edge-prove-unpublished.example.com");
  });

  test("splits Access-gated hostnames from no-Access webhook hostnames", () => {
    const plan = planEdgeChecks({
      edge_targets: [
        ...TARGETS,
        { key: "webhook-slack-manager", host: "slack-manager.example.com", noAccess: true },
        { key: "webhook-github", host: "gh.example.com", noAccess: false },
      ],
    });
    expect(plan.targets.length).toBe(6);
    expect(plan.webhooks.map((t) => t.key)).toEqual(["webhook-slack-manager"]);
    expect(plan.accessGated.map((t) => t.key)).toEqual([
      "grafana",
      "argocd",
      "agent-crm",
      "workload-crm-postiz",
      "webhook-github",
    ]);
  });

  test("without noAccess every target is Access-gated and no webhook leg is planned", () => {
    const plan = planEdgeChecks({ edge_targets: TARGETS });
    expect(plan.webhooks).toEqual([]);
    expect(plan.accessGated.length).toBe(4);
  });

  test("missing/empty edge_targets throws the provider hint", () => {
    expect(() => planEdgeChecks({})).toThrow(/controlPlaneIngress\.provider "cloudflare"/);
    expect(() => planEdgeChecks({ edge_targets: [] })).toThrow(/pulumi up -s <stack>/);
  });
});

describe("missingPermissions", () => {
  test("names exactly the failed permission groups", () => {
    expect(
      missingPermissions([
        { permission: "Zone / DNS", httpStatus: 200, success: true },
        { permission: "Account / Cloudflare Tunnel", httpStatus: 403, success: false },
        { permission: "Account / Access: Groups", httpStatus: 403, success: false },
      ]),
    ).toEqual(["Account / Cloudflare Tunnel", "Account / Access: Groups"]);
  });

  test("all-green probes report nothing missing", () => {
    expect(
      missingPermissions([{ permission: "Zone / DNS", httpStatus: 200, success: true }]),
    ).toEqual([]);
  });
});

describe("pickZone", () => {
  const ZONES: ZoneInfo[] = [
    { id: "z1", name: "example.com", account: { id: "a1" } },
    { id: "z2", name: "other.io", account: { id: "a1" } },
  ];

  test("picks by name and rejects unknown names with the visible list", () => {
    expect(pickZone(ZONES, "other.io").id).toBe("z2");
    expect(() => pickZone(ZONES, "nope.dev")).toThrow(/example\.com, other\.io/);
  });

  test("a single-zone token needs no --zone; multi-zone demands it", () => {
    expect(pickZone([ZONES[0]!]).id).toBe("z1");
    expect(() => pickZone(ZONES)).toThrow(/pass --zone/);
    expect(() => pickZone([])).toThrow(/no zones/);
  });
});

describe("pickService", () => {
  const SVCS: SvcInfo[] = [
    { namespace: "hermes-marketing-engagement", name: "hermes-marketing-engagement-postiz-postiz", port: 5000 },
    { namespace: "hermes-marketing-engagement", name: "hermes-marketing-engagement-postiz-postiz-db", port: 5432 },
    { namespace: "hermes-monitoring", name: "monitoring-grafana", port: 80 },
  ];

  test("a unique substring resolves", () => {
    expect(pickService(SVCS, "grafana").port).toBe(80);
  });

  test("ambiguity names every hit; no match says so", () => {
    expect(() => pickService(SVCS, "postiz")).toThrow(/2 Services match .*postiz-postiz-db/s);
    expect(() => pickService(SVCS, "nothing")).toThrow(/no Service matches/);
  });
});

describe("tunnelConfig / connectorManifests", () => {
  test("ingress enforces Access at the connector and keeps 404 last", () => {
    const cfg = tunnelConfig("postiz-test.example.com", "http://svc.ns.svc.cluster.local:5000", "myteam", "aud123") as {
      config: { ingress: Array<{ hostname?: string; service: string; originRequest?: { access: { required: boolean; teamName: string; audTag: string[] } } }> };
    };
    expect(cfg.config.ingress.length).toBe(2);
    expect(cfg.config.ingress[0]!.originRequest!.access).toEqual({ required: true, teamName: "myteam", audTag: ["aud123"] });
    expect(cfg.config.ingress[1]!.service).toBe("http_status:404");
  });

  test("manifests are namespace + secret + deployment, token only in the secret", () => {
    const [ns, secret, deploy] = connectorManifests("hg-edge-test", "cf-postiz-test", "tok") as [
      { kind: string; metadata: { name: string } },
      { kind: string; stringData: { TUNNEL_TOKEN: string } },
      { kind: string; spec: { template: { spec: { containers: Array<{ env: Array<{ valueFrom?: unknown }> }> } } } },
    ];
    expect(ns.kind).toBe("Namespace");
    expect(secret.stringData.TUNNEL_TOKEN).toBe("tok");
    expect(deploy.kind).toBe("Deployment");
    expect(JSON.stringify(deploy)).not.toContain("tok\"");
  });
});
