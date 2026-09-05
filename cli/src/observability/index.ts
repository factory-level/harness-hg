// hg observability (design 15, ADR-55): the CLI side of the normalized
// runtime overlay. `inspect` joins the canonical inventory
// (control-plane/nexus/inventory.json - the ONE declaration of control-plane
// vocabulary) with live source levels; `prove` emits the design-16
// ProofResult envelope over the overlay contract, OBS001..OBS012.
//
// The CLI COMPUTES no level anywhere here - it validates and reads the
// document the server built. That is the whole point of the document:
// a consumer that derives its own answer is a second ladder waiting to
// disagree.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { grafanaGet } from "../dash/index.ts";
import { CONTRACTS_ROOT, PLATFORM_ROOT } from "../lib.ts";
import { secretScan } from "../nexus/prove.ts";
import type { ProofFinding, ProofResult } from "../backup/platform.ts";

const SOURCE_KINDS = [
  "argocd",
  "grafana",
  "uptime",
  "eval",
  "backup",
  "communication",
  "reconciliation",
] as const;

const LEGAL_STATUS = new Set(["configured", "not configured", "failed", "stale"]);

interface OverlaySource {
  kind: string;
  status: string;
  level: string;
  summary: string;
  links?: { kind: string; url?: string; href?: string }[];
}

interface Overlay {
  apiVersion?: string;
  kind?: string;
  sources?: Record<string, OverlaySource>;
  components?: Record<string, { level: string; sources?: OverlaySource[] }>;
  instances?: Record<string, { links?: { kind: string; url?: string }[] }>;
}

export interface InventoryWorkload {
  id: string;
  name: string;
  abbr: string;
  role: string;
  namespace: string;
  installedBy: string;
  versionAuthority: string;
  source: string | null;
}

export function readInventory(): InventoryWorkload[] {
  const doc = JSON.parse(
    readFileSync(join(PLATFORM_ROOT, "control-plane", "nexus", "inventory.json"), "utf8"),
  ) as { workloads?: InventoryWorkload[] };
  if (!Array.isArray(doc.workloads) || doc.workloads.length === 0) {
    throw new Error("control-plane/nexus/inventory.json is empty or malformed");
  }
  return doc.workloads;
}

async function fetchOverlay(controlPlane: string): Promise<Overlay> {
  const resp = await fetch(`${controlPlane}/api/plugins/hermes-gitops/nexus/health`, {
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  });
  if (resp.status !== 200) throw new Error(`GET /nexus/health returned ${resp.status}`);
  return (await resp.json()) as Overlay;
}

/** The inventory joined with what the overlay says about each workload's
 * standing source. Without a control plane every level is unknown - the
 * vocabulary is still worth printing. */
export async function inspectObservability(
  controlPlane?: string,
): Promise<{ workloads: (InventoryWorkload & { level: string; status: string })[] }> {
  const inventory = readInventory();
  let sources: Record<string, OverlaySource> = {};
  if (controlPlane) {
    sources = (await fetchOverlay(controlPlane)).sources ?? {};
  }
  return {
    workloads: inventory.map((w) => ({
      ...w,
      level: (w.source && sources[w.source]?.level) || "unknown",
      status: (w.source && sources[w.source]?.status) || (controlPlane ? "not configured" : "unknown"),
    })),
  };
}

/** OBS001..OBS012 over the served overlay. Live findings report unknown
 * without --control-plane (never pass, never silently skipped - the
 * hg nexus prove convention). */
export async function proveObservability(inputs: {
  controlPlane?: string;
  /** Test seam: grafanaGet needs a cluster; the envelope logic does not. */
  grafana?: (apiPath: string) => string;
}): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });
  const grafana = inputs.grafana ?? grafanaGet;

  let overlay: Overlay | null = null;
  if (inputs.controlPlane) {
    try {
      overlay = await fetchOverlay(inputs.controlPlane);
    } catch (err) {
      add("OBS001", "fail", "overlay", `overlay unreachable: ${(err as Error).message}`);
    }
  } else {
    add("OBS001", "unknown", "overlay", "no --control-plane; live overlay not checked");
  }

  if (overlay) {
    // OBS001 - the document validates against the frozen schema. What the
    // server serves is checked against what the repo publishes, so a
    // server that drifts from the contract fails HERE, not in a browser.
    try {
      const schema = JSON.parse(
        readFileSync(
          join(CONTRACTS_ROOT, "runtime-overlay", "v1alpha1", "overlay.schema.json"),
          "utf8",
        ),
      );
      const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
      const validate = ajv.compile(schema);
      if (validate(overlay)) {
        add("OBS001", "pass", "overlay", "overlay validates against runtime-overlay/v1alpha1");
      } else {
        const first = (validate.errors ?? [])[0];
        add("OBS001", "fail", "overlay", `schema violation at ${first?.instancePath}: ${first?.message}`);
      }
    } catch (err) {
      add("OBS001", "fail", "overlay", `schema unreadable: ${(err as Error).message}`);
    }

    // OBS002 - every kind, always, with a legal status.
    const sources = overlay.sources ?? {};
    const missing = SOURCE_KINDS.filter((k) => !sources[k]);
    const illegal = Object.values(sources).filter((s) => !LEGAL_STATUS.has(s.status));
    add(
      "OBS002",
      missing.length === 0 && illegal.length === 0 ? "pass" : "fail",
      "sources",
      missing.length > 0
        ? `missing source kinds: ${missing.join(", ")}`
        : illegal.length > 0
          ? `illegal adapter status: ${illegal.map((s) => `${s.kind}=${s.status}`).join(", ")}`
          : "all 7 source kinds present with legal status",
    );

    // OBS003 - the never-green invariant, checked on the wire rather than
    // trusted to the constructor that enforces it.
    const lying = Object.values(sources).filter(
      (s) => (s.status === "not configured" || s.status === "failed") && s.level !== "unknown",
    );
    add(
      "OBS003",
      lying.length === 0 ? "pass" : "fail",
      "sources",
      lying.length === 0
        ? "no unconfigured or failed source reports a level"
        : `sources reporting a level without an observation: ${lying.map((s) => s.kind).join(", ")}`,
    );

    // OBS007 - Argo links carry exact identity: base/applications/<ns>/<name>.
    const links = [
      ...Object.values(overlay.instances ?? {}).flatMap((i) => i.links ?? []),
      ...Object.values(sources).flatMap((s) => s.links ?? []),
    ].filter((l) => l.kind === "external" && l.url && l.url.includes("/applications/"));
    const badLinks = links.filter((l) => {
      const tail = l.url!.split("/applications/")[1] ?? "";
      return tail.split("/").length !== 2 || tail.includes("?") || tail.includes("#");
    });
    add(
      "OBS007",
      links.length === 0 ? "unknown" : badLinks.length === 0 ? "pass" : "fail",
      "links",
      links.length === 0
        ? "no Argo links present to check (no base configured or nothing matched)"
        : badLinks.length === 0
          ? `${links.length} Argo link(s) namespace-qualified`
          : `malformed Argo links: ${badLinks.map((l) => l.url).join(" ")}`,
    );

    // OBS008 - nothing secret-shaped in the whole document.
    const hits = secretScan("overlay", JSON.stringify(overlay));
    add(
      "OBS008",
      hits.length === 0 ? "pass" : "fail",
      "overlay",
      hits.length === 0 ? "no secret-shaped content" : `secret-shaped content: ${hits.map((h) => h.pattern).join(", ")}`,
    );

    // OBS009 - failed keeps nothing green anywhere, including narrowed
    // per-component rows.
    const failedRows = Object.values(overlay.components ?? {})
      .flatMap((c) => c.sources ?? [])
      .filter((s) => s.status === "failed" && s.level !== "unknown");
    add(
      "OBS009",
      failedRows.length === 0 ? "pass" : "fail",
      "components",
      failedRows.length === 0
        ? "no failed adapter shows a level on any component"
        : `failed-but-levelled rows: ${failedRows.map((s) => s.kind).join(", ")}`,
    );

    // OBS010 - the reconciliation source exists. `unknown`/not configured
    // is a PASS until M01's writer lands - present and honest is the claim.
    const recon = sources["reconciliation"];
    add(
      "OBS010",
      recon && LEGAL_STATUS.has(recon.status) ? "pass" : "fail",
      "reconciliation",
      recon ? `present (${recon.status}: ${recon.summary})` : "reconciliation source missing",
    );

    // OBS011/OBS012 (#662) - the routing components report through the
    // overlay: the communication source (the event router's adapter) and
    // the grafana source (which carries the alert paths' health) must be
    // PRESENT with a legal status. Missing is a fail: the coverage
    // inventory (maintainers/observability-coverage.md) names these two
    // as the first gap candidates, and this is the gate that keeps their
    // coverage from silently regressing.
    const comm = sources["communication"];
    add(
      "OBS011",
      comm && LEGAL_STATUS.has(comm.status) ? "pass" : "fail",
      "event-router",
      comm ? `communication source present (${comm.status}: ${comm.summary})` : "communication source missing from the overlay",
    );
    const graf = sources["grafana"];
    add(
      "OBS012",
      graf && LEGAL_STATUS.has(graf.status) ? "pass" : "fail",
      "alert-router",
      graf ? `grafana source present (${graf.status}: ${graf.summary})` : "grafana source (alert paths) missing from the overlay",
    );
  } else if (inputs.controlPlane) {
    for (const id of ["OBS002", "OBS003", "OBS007", "OBS008", "OBS009", "OBS010", "OBS011", "OBS012"]) {
      add(id, "unknown", "overlay", "overlay unreachable");
    }
  } else {
    for (const id of ["OBS002", "OBS003", "OBS007", "OBS008", "OBS009", "OBS010", "OBS011", "OBS012"]) {
      add(id, "unknown", "overlay", "no --control-plane");
    }
  }

  // OBS004/005/006 - the promised dashboards, in the LIVE Grafana, with
  // resolvable datasources. Needs the cluster, not the control plane.
  for (const [id, uid] of [
    ["OBS004", "hg-control-plane-overview"],
    ["OBS005", "hg-control-plane-reconciliation"],
  ] as const) {
    try {
      const out = grafana(`/api/dashboards/uid/${uid}`);
      const imported = Boolean((JSON.parse(out) as { dashboard?: unknown }).dashboard);
      add(id, imported ? "pass" : "fail", "grafana", imported ? `${uid} imported` : `${uid} not imported`);
    } catch {
      add(id, "unknown", "grafana", `Grafana unreachable; ${uid} not checked`);
    }
  }
  try {
    const ds = JSON.parse(grafana("/api/datasources")) as { uid?: string }[];
    const uids = new Set(ds.map((d) => d.uid).filter(Boolean));
    add(
      "OBS006",
      uids.has("prometheus") ? "pass" : "fail",
      "grafana",
      uids.has("prometheus")
        ? "datasource uid `prometheus` resolves"
        : `datasource uid \`prometheus\` missing (have: ${[...uids].join(", ")})`,
    );
  } catch {
    add("OBS006", "unknown", "grafana", "Grafana unreachable; datasources not checked");
  }

  const summary = {
    pass: findings.filter((f) => f.status === "pass").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "observability prove",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    findings,
    summary,
  };
}
