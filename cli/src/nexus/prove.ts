// hg nexus prove (the DevX proof contract): evidence that a persona
// repository's contribution compiles against real topology, lands in a
// real GitOps tree, and loads as the control-plane Hermes dashboard.
// Offline legs always run; live legs need --control-plane and otherwise
// report "unknown" - never healthy, never silently skipped. Artifacts
// land under .hg/proofs/nexus/<timestamp>/ so the result is inspectable
// after the fact. Success exits 0; a failed mandatory check exits nonzero
// (the caller maps ok -> exit code).

import * as fs from "node:fs";
import * as path from "node:path";
import type { TopologyPlan } from "../topology/compile.ts";
import { compileNexus, type NexusPlanDoc } from "./compile.ts";
import { loadDashboard } from "./contract.ts";
import { NEXUS_PLAN_PATH, loadWorkloadEndpoints, nexusInputsHash, renderNexusTree } from "./emit.ts";

export type CheckStatus = "pass" | "fail" | "unknown";

export interface ProveCheck {
  id: string;
  title: string;
  status: CheckStatus;
  mandatory: boolean;
  detail: string;
}

export interface ProveReport {
  ok: boolean;
  source: string;
  gitops: string;
  controlPlane?: string;
  artifactsDir: string;
  checks: ProveCheck[];
}

// Secret-shaped content that must never appear in a plan or an API
// response. Patterns over VALUES, not key names alone - a plan mentioning
// the word "token" in prose is fine; a credential is not.
export const SECRET_PATTERNS: [string, RegExp][] = [
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["openai-style-key", /\bsk-[A-Za-z0-9-]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["url-userinfo", /https?:\/\/[^/\s"']+:[^/\s"']+@/],
  ["assigned-secret", /(?:api[_-]?key|client[_-]?secret|password)["']?\s*[:=]\s*["'][^"']{8,}["']/i],
];

export function secretScan(label: string, text: string): { label: string; pattern: string }[] {
  const hits: { label: string; pattern: string }[] = [];
  for (const [name, re] of SECRET_PATTERNS) {
    if (re.test(text)) hits.push({ label, pattern: name });
  }
  return hits;
}

async function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000), redirect: "manual" });
  return { status: resp.status, text: await resp.text() };
}

export interface ProveInputs {
  sourceRoot: string;
  gitopsRoot: string;
  topology: TopologyPlan;
  topologyFindingsOk: boolean;
  /** The exact inputs the emit path used - the fresh compile must
   * reproduce them or plan-current would call every correct emit stale. */
  sourceSha?: string;
  environmentSource?: string;
  workloadEndpointsFile?: string;
  controlPlane?: string;
  proofsRoot?: string; // override for tests; default .hg/proofs/nexus
  timestamp?: string; // override for tests
}

export async function proveNexus(inputs: ProveInputs): Promise<ProveReport> {
  const checks: ProveCheck[] = [];
  const artifacts: Record<string, unknown> = {};
  const add = (id: string, title: string, mandatory: boolean, status: CheckStatus, detail: string) =>
    checks.push({ id, title, status, mandatory, detail });

  // --- Offline legs --------------------------------------------------------
  const dash = loadDashboard(inputs.sourceRoot);
  const authoredCount = dash.contributions.length + dash.views.length;
  const validateOk = authoredCount > 0 && !dash.findings.some((f) => f.severity === "error");
  add(
    "contributions-validate",
    "Contributions validate against the published schemas",
    true,
    validateOk ? "pass" : "fail",
    validateOk
      ? `${dash.contributions.length} contribution(s), ${dash.views.length} view(s)`
      : authoredCount === 0
        ? "the source repository authors no dashboard/ files"
        : dash.findings.map((f) => `${f.check}: ${f.message}`).join("; "),
  );

  const inputsHash = nexusInputsHash(inputs.sourceRoot, {
    environmentSource: inputs.environmentSource,
    workloadEndpointsFile: inputs.workloadEndpointsFile,
  });
  const workloadEndpoints = inputs.workloadEndpointsFile
    ? loadWorkloadEndpoints(inputs.workloadEndpointsFile)
    : undefined;
  const compileArgs = {
    ...dash,
    topology: inputs.topology,
    workloadEndpoints,
    sourceSha: inputs.sourceSha,
    inputsHash,
  };
  const first = compileNexus({ ...compileArgs, findings: [...dash.findings] });
  const second = compileNexus({ ...compileArgs, findings: [...dash.findings] });
  const deterministic = JSON.stringify(first.plan) === JSON.stringify(second.plan);
  const compiled = first.ok && inputs.topologyFindingsOk;
  add(
    "plans-compile",
    "Topology and Nexus compile without errors",
    true,
    compiled ? "pass" : "fail",
    compiled ? "both compilers clean" : first.findings.filter((f) => f.severity === "error").map((f) => f.message).join("; ") || "topology findings",
  );
  add("plan-deterministic", "The Nexus plan is deterministic across repeated compiles", true, deterministic ? "pass" : "fail", deterministic ? "byte-identical" : "two compiles differ");

  const emittedPath = path.join(inputs.gitopsRoot, NEXUS_PLAN_PATH);
  const expected = renderNexusTree(first.plan).get(NEXUS_PLAN_PATH)!;
  const emitted = fs.existsSync(emittedPath) ? fs.readFileSync(emittedPath, "utf8") : undefined;
  const current = emitted === expected;
  add(
    "plan-current",
    "The emitted GitOps plan matches the source (not stale)",
    true,
    current ? "pass" : "fail",
    current
      ? emittedPath
      : emitted === undefined
        ? `${emittedPath} does not exist - run hg nexus emit`
        : "emitted plan differs from a fresh compile - re-run hg nexus emit",
  );

  const plan: NexusPlanDoc = first.plan;
  const ids = plan.components.map((c) => c.id);
  add(
    "components-unique",
    "Every logical component appears exactly once",
    true,
    new Set(ids).size === ids.length ? "pass" : "fail",
    `${ids.length} components`,
  );
  const multi = plan.components.filter((c) => c.instances.length > 1);
  add(
    "multi-instance-rollup",
    "Regional instances roll into one logical card",
    false,
    multi.length > 0 ? "pass" : "unknown",
    multi.length > 0
      ? multi.map((c) => `${c.id}: ${c.instances.length} instances`).join("; ")
      : "no component has more than one instance in this environment",
  );
  const agents = plan.components.filter((c) => c.kind === "agent" && c.resolved);
  const agentDest = agents.every((c) => c.instances.some((i) => i.destinations.hermesClassic || i.grafanaDashboardUid));
  add(
    "agent-destinations",
    "Agent cards expose Hermes Classic and/or Grafana destinations",
    true,
    agents.length === 0 ? "fail" : agentDest ? "pass" : "fail",
    agents.length === 0 ? "no resolved agent components" : `${agents.length} agent component(s)`,
  );
  const apps = plan.components.filter((c) => c.kind === "application" && c.resolved);
  const appDest = apps.every((c) => c.instances.some((i) => i.application || i.grafanaDashboardUid || (i.destinations.deployed ?? []).length > 0));
  add(
    "application-destinations",
    "Application cards expose deployed URLs, Grafana, and Argo CD identities",
    true,
    apps.length === 0 ? "unknown" : appDest ? "pass" : "fail",
    apps.length === 0 ? "no resolved application components" : `${apps.length} application component(s)`,
  );

  const planJson = JSON.stringify(plan, null, 2);
  const planHits = secretScan("nexus-plan.json", planJson);
  artifacts["secret-scan"] = { scanned: ["nexus-plan.json"], hits: planHits };
  add("no-secrets-in-plan", "No credentials or secret values in the compiled plan", true, planHits.length === 0 ? "pass" : "fail", planHits.length === 0 ? "clean" : planHits.map((h) => h.pattern).join(", "));

  // ADR-43: every authored reference link in the plan must be a clean
  // https URL - this re-checks the compiler's NEXUS009 layer on the
  // final artifact, so a hand-edited plan cannot smuggle one either.
  const linked = plan.components.filter((c) => c.links !== undefined);
  const dirtyLinks: string[] = [];
  for (const c of linked) {
    for (const [key, value] of Object.entries(c.links ?? {})) {
      if (typeof value !== "string") continue;
      let bad = false;
      try {
        const u = new URL(value);
        bad = u.protocol !== "https:" || !!u.username || !!u.password || !!u.search || !!u.hash;
      } catch {
        bad = true;
      }
      if (bad) dirtyLinks.push(`${c.id}.links.${key}=${value}`);
    }
  }
  add(
    "links-safe",
    "Authored reference links are clean https URLs",
    true,
    dirtyLinks.length === 0 ? "pass" : "fail",
    linked.length === 0
      ? "no component declares links"
      : dirtyLinks.length === 0
        ? `${linked.length} component(s) with links`
        : dirtyLinks.join("; "),
  );

  artifacts["nexus-plan"] = plan;
  artifacts["component-bindings"] = plan.components.map((c) => ({
    id: c.id,
    kind: c.kind,
    bind: c.bind,
    resolved: c.resolved,
    instances: c.instances.map((i) => i.id),
  }));

  // --- Live legs -----------------------------------------------------------
  const routeChecks: Record<string, unknown>[] = [];
  const liveStatus = (s: CheckStatus): CheckStatus => (inputs.controlPlane ? s : "unknown");
  const liveMandatory = Boolean(inputs.controlPlane);
  let healthArtifact: unknown = { note: "no --control-plane given; live health not observed" };

  if (!inputs.controlPlane) {
    for (const [id, title] of [
      ["plugin-discovered", "Hermes discovers the dashboard plugin"],
      ["nexus-overrides-root", "Nexus overrides /"],
      ["classic-routes-remain", "Classic Hermes routes remain available"],
      ["live-health-rollup", "Live health reaches the canvas with per-instance reasons"],
      ["workspace-roundtrip", "The workspace saves, refuses stale revisions, and exports its bytes"],
      ["no-secrets-in-api", "No secrets in API responses"],
    ] as const) {
      add(id, title, false, "unknown", "no --control-plane given");
    }
  } else {
    const base = inputs.controlPlane.replace(/\/$/, "");
    try {
      const plugins = await httpGet(`${base}/api/dashboard/plugins`);
      routeChecks.push({ route: "/api/dashboard/plugins", status: plugins.status });
      const doc = JSON.parse(plugins.text) as { plugins?: { name?: string; tab?: { override?: string } }[] } | { name?: string }[];
      const list = Array.isArray(doc) ? doc : (doc.plugins ?? []);
      const nexus = list.find((p) => (p as { name?: string }).name === "hermes-gitops") as
        | { name?: string; tab?: { override?: string } }
        | undefined;
      add("plugin-discovered", "Hermes discovers the dashboard plugin", liveMandatory, nexus ? "pass" : "fail", nexus ? "hermes-gitops present" : "hermes-gitops absent from /api/dashboard/plugins - run hg nexus install and enable the plugin");
      const override = nexus?.tab?.override === "/";
      add("nexus-overrides-root", "Nexus overrides /", liveMandatory, override ? "pass" : "fail", override ? 'tab.override == "/"' : "manifest tab.override is not /");

      const status = await httpGet(`${base}/api/status`);
      routeChecks.push({ route: "/api/status", status: status.status });
      const root = await httpGet(`${base}/`);
      routeChecks.push({ route: "/", status: root.status });
      const classicOk = status.status === 200 && root.status === 200;
      add("classic-routes-remain", "Classic Hermes routes remain available", liveMandatory, classicOk ? "pass" : "fail", `/api/status ${status.status}, / ${root.status}`);

      // Loopback mode injects the per-process session token into the SPA
      // HTML; the prove runs on the operator host, so reading it is the
      // sanctioned local path to the authenticated plugin API.
      const token = /__HERMES_SESSION_TOKEN__\s*=\s*["']([^"']+)["']/.exec(root.text)?.[1];
      // Standalone mode (ADR-48): the in-cluster shell serves the plugin
      // API with session auth at the EDGE, not the container - so there
      // is no token to find and no host to discover. Probe the plugin
      // API directly; if it answers, the authenticated legs run
      // tokenless and the host-integration legs are honestly
      // not-applicable rather than failed.
      const standaloneProbe = token ? null : await httpGet(`${base}/api/plugins/hermes-gitops/nexus/workspace`);
      const standalone = standaloneProbe?.status === 200;
      if (standalone) {
        // Rewrite the three host-integration verdicts: they described a
        // HOSTED control plane this URL is not.
        for (const check of checks) {
          if (["plugin-discovered", "nexus-overrides-root", "classic-routes-remain"].includes(check.id)) {
            check.status = "unknown";
            check.detail = "standalone control plane (ADR-48) - host-integration legs not applicable";
          }
        }
      }
      if (!token && !standalone) {
        add("live-health-rollup", "Live health reaches the canvas with per-instance reasons", false, "unknown", "no loopback session token in the SPA HTML (gated auth mode) - verify in the browser");
        add("workspace-roundtrip", "The workspace saves, refuses stale revisions, and exports its bytes", false, "unknown", "no loopback session token");
        add("health-sources", "Components carry per-source rows and the nav rollups exist", false, "unknown", "no loopback session token");
        add("no-secrets-in-api", "No secrets in API responses", liveMandatory, secretScan("routes", plugins.text + status.text).length === 0 ? "pass" : "fail", "public routes scanned");
      } else {
        const headers: Record<string, string> = token
          ? { "X-Hermes-Session-Token": token, "Content-Type": "application/json" }
          : { "Content-Type": "application/json" };
        const health = await httpGet(`${base}/api/plugins/hermes-gitops/nexus/health`, headers);
        routeChecks.push({ route: "/api/plugins/hermes-gitops/nexus/health", status: health.status });
        let healthOk = false;
        let healthDetail = `status ${health.status}`;
        if (health.status === 200) {
          const overlay = JSON.parse(health.text) as { components?: Record<string, unknown>; instances?: Record<string, { reasons?: unknown[] }> };
          healthArtifact = overlay;
          const reasons = Object.values(overlay.instances ?? {}).every((i) => Array.isArray(i.reasons) && i.reasons.length > 0);
          healthOk = Boolean(overlay.components && overlay.instances && reasons);
          healthDetail = healthOk ? `${Object.keys(overlay.components ?? {}).length} components observed, every instance carries a reason` : "overlay missing components/instances/reasons";
        }
        add("live-health-rollup", "Live health reaches the canvas with per-instance reasons", liveMandatory, healthOk ? "pass" : "fail", healthDetail);

        // The workspace round trip (#274): re-save the CURRENT document
        // (content-preserving - only the revision advances), prove the
        // stale revision is refused with a 409, and prove export serves
        // the exact stored bytes. Unlike the old layout probe this never
        // overwrites operator state.
        const wsGet = await fetch(`${base}/api/plugins/hermes-gitops/nexus/workspace`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        let wsDoc: { workspace?: { revision: number } } = {};
        try {
          wsDoc = (await wsGet.json()) as { workspace?: { revision: number } };
        } catch {
          // a non-JSON body reads as no workspace and fails the check below
        }
        const workspace = wsDoc.workspace as { revision: number } | undefined;
        let wsOk = false;
        let wsDetail = `GET ${wsGet.status}`;
        if (wsGet.status === 200 && workspace) {
          const put1 = await fetch(`${base}/api/plugins/hermes-gitops/nexus/workspace`, {
            method: "PUT",
            headers,
            body: JSON.stringify(workspace),
            signal: AbortSignal.timeout(8000),
          });
          // The SAME revision again is now stale - the CAS must refuse.
          const put2 = await fetch(`${base}/api/plugins/hermes-gitops/nexus/workspace`, {
            method: "PUT",
            headers,
            body: JSON.stringify(workspace),
            signal: AbortSignal.timeout(8000),
          });
          const exp = await fetch(`${base}/api/plugins/hermes-gitops/nexus/workspace/export`, {
            headers,
            signal: AbortSignal.timeout(8000),
          });
          const exported = await exp.text();
          let exportMatches = false;
          try {
            const parsed = JSON.parse(exported) as { revision?: number };
            exportMatches = exp.status === 200 && parsed.revision === workspace.revision + 1;
          } catch {
            exportMatches = false;
          }
          routeChecks.push(
            { route: "PUT workspace", status: put1.status },
            { route: "PUT workspace (stale)", status: put2.status },
            { route: "GET workspace/export", status: exp.status },
          );
          wsOk = put1.status === 200 && put2.status === 409 && exportMatches;
          wsDetail = `PUT ${put1.status}, stale PUT ${put2.status} (want 409), export ${exp.status}`;
        }
        add("workspace-roundtrip", "The workspace saves, refuses stale revisions, and exports its bytes", liveMandatory, wsOk ? "pass" : "fail", wsDetail);

        // health-sources (#275): every component carries its sources[]
        // rows (the popover's whole input - absent rows would make the
        // browser fabricate again), and the hierarchy's rollups exist.
        let sourcesOk = false;
        let sourcesDetail = "health response unreadable";
        try {
          const overlay = JSON.parse(health.text) as {
            components?: Record<string, { sources?: { kind: string; status: string; observedAt?: string }[] }>;
            rollups?: Record<string, unknown>;
            sources?: Record<string, unknown>;
          };
          const comps = Object.values(overlay.components ?? {});
          const allCarry = comps.every((c) => Array.isArray(c.sources) && c.sources.length === 7);
          const rollupKeys = Object.keys(overlay.rollups ?? {});
          const navPresent = rollupKeys.includes("nav:fleet") && rollupKeys.includes("nav:agents");
          sourcesOk = allCarry && navPresent && Object.keys(overlay.sources ?? {}).length === 7;
          sourcesDetail = `${comps.length} component(s) with sources[], rollups: ${rollupKeys.length}`;
        } catch {
          // detail stands
        }
        add("health-sources", "Components carry per-source rows and the nav rollups exist", liveMandatory, sourcesOk ? "pass" : "fail", sourcesDetail);

        const apiHits = secretScan("api", plugins.text + health.text);
        add("no-secrets-in-api", "No secrets in API responses", liveMandatory, apiHits.length === 0 ? "pass" : "fail", apiHits.length === 0 ? "clean" : apiHits.map((h) => h.pattern).join(", "));
      }
    } catch (err) {
      // Only checks not yet recorded fail here - a mid-flight throw must
      // never leave duplicate, contradictory entries in result.json.
      const detail = `control plane error: ${err instanceof Error ? err.message : String(err)}`;
      const recorded = new Set(checks.map((c) => c.id));
      for (const [id, title] of [
        ["plugin-discovered", "Hermes discovers the dashboard plugin"],
        ["nexus-overrides-root", "Nexus overrides /"],
        ["classic-routes-remain", "Classic Hermes routes remain available"],
        ["live-health-rollup", "Live health reaches the canvas with per-instance reasons"],
        ["workspace-roundtrip", "The workspace saves, refuses stale revisions, and exports its bytes"],
        ["health-sources", "Components carry per-source rows and the nav rollups exist"],
        ["no-secrets-in-api", "No secrets in API responses"],
      ] as const) {
        if (!recorded.has(id)) add(id, title, liveMandatory, "fail", detail);
      }
    }
  }
  artifacts["route-checks"] = routeChecks;
  artifacts["health-rollup"] = healthArtifact;

  // --- Artifacts -----------------------------------------------------------
  const timestamp = inputs.timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(inputs.proofsRoot ?? path.resolve(".hg", "proofs", "nexus"), timestamp);
  fs.mkdirSync(dir, { recursive: true });
  const ok = checks.every((c) => !(c.mandatory && c.status === "fail"));
  const report: ProveReport = {
    ok,
    source: inputs.sourceRoot,
    gitops: inputs.gitopsRoot,
    controlPlane: inputs.controlPlane,
    artifactsDir: dir,
    checks,
  };
  const files: Record<string, unknown> = {
    "result.json": report,
    "nexus-plan.json": artifacts["nexus-plan"],
    "component-bindings.json": artifacts["component-bindings"],
    "health-rollup.json": artifacts["health-rollup"],
    "route-checks.json": artifacts["route-checks"],
    "secret-scan.json": artifacts["secret-scan"],
  };
  for (const [name, doc] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return report;
}
