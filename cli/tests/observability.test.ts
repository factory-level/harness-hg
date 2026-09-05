// hg observability: the finding logic against fixture overlays and a
// fake Grafana - no cluster. The overlay fixtures are deliberately built
// from the same shapes plugin/tests feeds build_overlay, so the CLI and
// the server are judged against one contract.

import { describe, expect, test } from "bun:test";
import { proveObservability, readInventory } from "../src/observability/index.ts";

function overlay(mutate?: (o: Record<string, unknown>) => void): Record<string, unknown> {
  const src = (kind: string, status: string, level: string) => ({
    kind,
    status,
    level,
    summary: `${kind} summary`,
  });
  const doc: Record<string, unknown> = {
    apiVersion: "nexus.hermes.ai/v1alpha1",
    kind: "RuntimeOverlay",
    observedAt: "2026-07-31T12:00:00Z",
    stale: false,
    sources: {
      argocd: src("argocd", "configured", "healthy"),
      grafana: src("grafana", "not configured", "unknown"),
      uptime: src("uptime", "not configured", "unknown"),
      eval: src("eval", "not configured", "unknown"),
      backup: src("backup", "not configured", "unknown"),
      communication: src("communication", "not configured", "unknown"),
      reconciliation: src("reconciliation", "not configured", "unknown"),
    },
    components: {},
    instances: {
      "manager@ca-west": {
        level: "healthy",
        reasons: [{ source: "argocd", message: "Synced / Healthy" }],
        observedAt: "2026-07-31T12:00:00Z",
        links: [
          {
            label: "Open in Argo CD",
            kind: "external",
            url: "https://argocd.test/applications/argocd/hermes-manager-ca-west",
          },
        ],
      },
    },
    rollups: {},
  };
  mutate?.(doc);
  return doc;
}

/** Serve one overlay on a loopback port, return its base URL. */
function serve(doc: Record<string, unknown>): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const grafanaOk = (apiPath: string): string => {
  if (apiPath.startsWith("/api/dashboards/uid/")) return JSON.stringify({ dashboard: { uid: "x" } });
  if (apiPath === "/api/datasources") return JSON.stringify([{ uid: "prometheus" }]);
  throw new Error(`unexpected ${apiPath}`);
};

describe("hg observability", () => {
  test("the inventory declares all twelve control-plane workloads once", () => {
    const inv = readInventory();
    const ids = inv.map((w) => w.id);
    for (const id of [
      "argocd", "prometheus", "grafana", "alertmanager",
      "communication-router", "communication-queue", "webhook-gateway",
      "cloudflare-tunnel", "chatops", "backup-services", "nexus", "hermes-runtime",
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of inv) expect(w.versionAuthority.length).toBeGreaterThan(0);
  });

  test("a conforming overlay passes every live finding", async () => {
    const { url, stop } = serve(overlay());
    try {
      const report = await proveObservability({ controlPlane: url, grafana: grafanaOk });
      const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
      for (const id of ["OBS001", "OBS002", "OBS003", "OBS004", "OBS005", "OBS006", "OBS007", "OBS008", "OBS009", "OBS010"]) {
        expect(byId[id]?.status).toBe("pass");
      }
      expect(report.ok).toBe(true);
      expect(report.kind).toBe("ProofResult");
    } finally {
      stop();
    }
  });

  test("a source reporting green without an observation fails OBS003", async () => {
    const { url, stop } = serve(
      overlay((o) => {
        (o.sources as Record<string, Record<string, unknown>>).backup = {
          kind: "backup",
          status: "failed",
          level: "healthy",
          summary: "lying",
        };
      }),
    );
    try {
      const report = await proveObservability({ controlPlane: url, grafana: grafanaOk });
      const f = report.findings.find((x) => x.id === "OBS003")!;
      expect(f.status).toBe("fail");
      expect(f.message).toContain("backup");
      expect(report.ok).toBe(false);
    } finally {
      stop();
    }
  });

  test("a missing source kind fails OBS002 - omitted is indistinguishable from healthy", async () => {
    const { url, stop } = serve(
      overlay((o) => {
        delete (o.sources as Record<string, unknown>).reconciliation;
      }),
    );
    try {
      const report = await proveObservability({ controlPlane: url, grafana: grafanaOk });
      expect(report.findings.find((x) => x.id === "OBS002")!.status).toBe("fail");
      expect(report.findings.find((x) => x.id === "OBS010")!.status).toBe("fail");
    } finally {
      stop();
    }
  });

  test("a name-only Argo link fails OBS007", async () => {
    const { url, stop } = serve(
      overlay((o) => {
        (o.instances as Record<string, { links: { kind: string; url: string }[] }>)[
          "manager@ca-west"
        ].links = [
          { label: "Open in Argo CD", kind: "external", url: "https://argocd.test/applications/hermes-manager-ca-west" } as never,
        ];
      }),
    );
    try {
      const report = await proveObservability({ controlPlane: url, grafana: grafanaOk });
      expect(report.findings.find((x) => x.id === "OBS007")!.status).toBe("fail");
    } finally {
      stop();
    }
  });

  test("secret-shaped content anywhere in the document fails OBS008", async () => {
    const { url, stop } = serve(
      overlay((o) => {
        (o.sources as Record<string, Record<string, unknown>>).grafana!.summary =
          "token ghp_abcdefghijklmnopqrstuvwx0123456789";
      }),
    );
    try {
      const report = await proveObservability({ controlPlane: url, grafana: grafanaOk });
      expect(report.findings.find((x) => x.id === "OBS008")!.status).toBe("fail");
    } finally {
      stop();
    }
  });

  test("without a control plane every live finding is unknown, never pass", async () => {
    const report = await proveObservability({
      grafana: () => {
        throw new Error("no cluster");
      },
    });
    for (const f of report.findings) {
      expect(f.status).toBe("unknown");
    }
    // Unknown is not failure: the proof is honest about what it did not check.
    expect(report.ok).toBe(true);
  });

  test("a missing promised dashboard fails its finding", async () => {
    const { url, stop } = serve(overlay());
    try {
      const report = await proveObservability({
        controlPlane: url,
        grafana: (apiPath: string) => {
          if (apiPath.includes("hg-control-plane-overview")) return JSON.stringify({ message: "not found" });
          return grafanaOk(apiPath);
        },
      });
      expect(report.findings.find((x) => x.id === "OBS004")!.status).toBe("fail");
      expect(report.findings.find((x) => x.id === "OBS005")!.status).toBe("pass");
    } finally {
      stop();
    }
  });
});
