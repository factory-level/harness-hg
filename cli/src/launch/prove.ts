// hg launch prove (#285) - the one mandatory release gate.
//
// Not a new set of checks. Every milestone already built its own matrix,
// and each is the authority on its own subject: OBS for observability,
// BKUP for backups, AUTH for authorization, PANEL for embeds, PLAT for
// recovery. Re-implementing any of them here would create a second
// opinion, and the second opinion is always the one that rots.
//
// What this adds is the part no milestone owns: whether the INSTALLATION
// is in its launch configuration. A fleet can pass every subject matrix
// while shipping a diagnostic tab, a flag whose data path is broken, or
// an authorization posture that still trusts a header - and none of the
// per-subject proofs would notice, because none of them is looking at
// the shape of the product.

import { CliError, kubectl, type HgState } from "../lib.ts";
import type { ProofFinding, ProofResult } from "../backup/platform.ts";

/** The launch navigation, exactly (#285). Order matters: it is what an
 * operator learns, and a fifth tab appearing is a product change nobody
 * decided. */
export const LAUNCH_NAV = ["Fleet Canvas", "Communication", "Agents", "Backups"] as const;

/** Flags that must be ON at launch, because a surface the release
 * promises and does not show is the same defect as one that shows
 * something untrue. */
export const LAUNCH_FLAGS_ON = [
  "communication-view",
  "agents-view",
  "backups-view",
  "repository-links",
  // The avatar-code page (#426): launch reference material, not a
  // diagnostic - bootstrap authoring depends on it being reachable.
  "avatar-gallery",
] as const;

/** Flags that must be OFF. `embed-debug` frames Grafana from the page's
 * own origin to answer "could we embed at all"; catalogued panels answer
 * that now, and a diagnostic beside four product views reads as a fifth
 * product view. */
export const LAUNCH_FLAGS_OFF = ["embed-debug", "canvas-object-demo"] as const;

export interface LaunchDeps {
  nexusBaseUrl: string;
  fetchJson: (url: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
  /** Each subject matrix, already run. `null` means it could not run at
   * all, which is reported as unknown rather than folded into a pass. */
  subjects: Record<string, ProofResult | null>;
  /** False when Nexus is not deployed in this environment (an Eve-only
   * loop on a machine without the Hermes agent image, ADR-149). Every
   * Nexus-backed leg then reads `unknown` - a missing surface is a
   * warning, never a pass and never a fail of something else. */
  nexusAvailable?: boolean;
}

const NEXUS_LEGS: [string, string][] = [
  ["LAUNCH002", "feature registry"],
  ["LAUNCH003", "authorization"],
  ["LAUNCH004", "reconciliation"],
  ["LAUNCH005", "secret exposure"],
  ["LAUNCH006", "in-cluster addresses"],
];

export async function proveLaunch(_state: HgState, deps: LaunchDeps): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });

  // LAUNCH001 - every subject matrix passed. Their findings are NOT
  // copied in: an aggregate that restates 30 findings buries the one
  // that matters, and each subject's own command prints them in full.
  for (const [name, proof] of Object.entries(deps.subjects)) {
    if (!proof) {
      add("LAUNCH001", "unknown", name, `${name} could not run - its subject is unproven, not passing`);
      continue;
    }
    add(
      "LAUNCH001",
      proof.ok ? "pass" : "fail",
      name,
      proof.ok
        ? `${proof.summary.pass} check(s) passed`
        : `${proof.summary.fail} failed: ${proof.findings.filter((f) => f.status === "fail").map((f) => f.id).join(", ")}`,
    );
  }

  if (deps.nexusAvailable === false) {
    for (const [id, component] of NEXUS_LEGS) {
      add(id, "unknown", component, "Nexus is not deployed here (no Hermes agent image) - unproven, not failed");
    }
    return finish(startedAt, findings);
  }

  // LAUNCH002 - the feature registry is in its launch configuration.
  const features = await deps.fetchJson(`${deps.nexusBaseUrl}/nexus/features`);
  const enabled = new Map<string, boolean>(
    (features.body?.features ?? []).map((f: any) => [f.id, Boolean(f.enabled)]),
  );
  const wrongOn = LAUNCH_FLAGS_ON.filter((f) => enabled.get(f) !== true);
  const wrongOff = LAUNCH_FLAGS_OFF.filter((f) => enabled.get(f) === true);
  add(
    "LAUNCH002",
    wrongOn.length === 0 && wrongOff.length === 0 ? "pass" : "fail",
    "features",
    wrongOn.length === 0 && wrongOff.length === 0
      ? `${LAUNCH_FLAGS_ON.length} launch flag(s) on, ${LAUNCH_FLAGS_OFF.length} diagnostic(s) off`
      : [
          wrongOn.length ? `missing: ${wrongOn.join(", ")}` : "",
          wrongOff.length ? `diagnostic still on: ${wrongOff.join(", ")}` : "",
        ].filter(Boolean).join("; "),
  );

  // LAUNCH003 - authorization comes from verified claims. A release that
  // still decides from an edge header is one misconfigured ingress away
  // from having no authorization at all.
  const who = await deps.fetchJson(`${deps.nexusBaseUrl}/nexus/auth/whoami`);
  add(
    "LAUNCH003",
    who.body?.mode === "oidc" ? "pass" : "fail",
    "auth",
    who.body?.mode === "oidc"
      ? "authorization decides from verified claims"
      : `authorization is in ${who.body?.mode ?? "unknown"} mode - a trusted header is not a launch posture`,
  );

  // LAUNCH004 - the reconciliation path is live and current. The whole
  // release claim is "a clean server accepts a Git change"; a dead timer
  // makes that untestable regardless of what else passes.
  const recon = kubectl(
    ["-n", "hermes-nexus", "get", "cm", "hermes-reconciliation-status", "-o", "jsonpath={.data.status\\.json}"],
    { allowFail: true, quiet: true },
  ).trim();
  let reconOk = false;
  let reconWhy = "no reconciliation record is published";
  if (recon) {
    try {
      const doc = JSON.parse(recon) as { phase?: string; appliedSha?: string };
      reconOk = Boolean(doc.appliedSha) && doc.phase !== "failed" && doc.phase !== "authentication-required";
      reconWhy = `phase ${doc.phase}, applied ${String(doc.appliedSha).slice(0, 12)}`;
    } catch {
      reconWhy = "the reconciliation record is malformed";
    }
  }
  add("LAUNCH004", reconOk ? "pass" : "fail", "reconciliation", reconWhy);

  // LAUNCH005 - no secret is readable from a browser-reachable surface.
  // Deliberately re-run here even though AUTH009 checks a subset: this
  // sweeps every surface the launch nav exposes, and the cost of missing
  // one is not comparable to the cost of running it twice.
  const surfaces = ["/nexus", "/nexus/features", "/nexus/health", "/nexus/auth/whoami", "/nexus/backups", "/nexus/communication"];
  const leaked: string[] = [];
  for (const p of surfaces) {
    const body = JSON.stringify((await deps.fetchJson(`${deps.nexusBaseUrl}${p}`)).body ?? "");
    for (const pattern of LAUNCH_SECRET_PATTERNS) {
      if (pattern.re.test(body)) leaked.push(`${p}: ${pattern.name}`);
    }
  }
  add(
    "LAUNCH005",
    leaked.length === 0 ? "pass" : "fail",
    "secrets",
    leaked.length === 0 ? `${surfaces.length} surface(s) carry nothing secret-shaped` : leaked.join("; "),
  );

  // LAUNCH006 - no in-cluster address reaches the browser. The plan is a
  // projection for humans outside the cluster; a Service DNS name in it
  // is both useless to them and a map of the inside.
  const planBody = JSON.stringify((await deps.fetchJson(`${deps.nexusBaseUrl}/nexus`)).body ?? "");
  const internals = ["svc.cluster.local", ".svc:", "kubernetes.default"].filter((n) => planBody.includes(n));
  add(
    "LAUNCH006",
    internals.length === 0 ? "pass" : "fail",
    "plan",
    internals.length === 0 ? "no in-cluster addressing in the served plan" : `plan carries: ${internals.join(", ")}`,
  );

  return finish(startedAt, findings);
}

function finish(startedAt: string, findings: ProofFinding[]): ProofResult {
  const fail = findings.filter((f) => f.status === "fail").length;
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "launch-prove",
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

/** Shapes that must never appear in a browser-reachable payload. Kept
 * narrow on purpose: a pattern that fires on ordinary prose gets
 * silenced, and a silenced sweep is worse than none. */
export const LAUNCH_SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "a bearer/publish token", re: /\bhgev_[A-Za-z0-9_-]{16,}/ },
  { name: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "a bcrypt hash", re: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/ },
  { name: "a JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "userinfo in a URL", re: /https?:\/\/[^/\s"]+:[^/\s"@]+@/ },
];
