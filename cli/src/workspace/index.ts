// hg workspace - the runtime verbs over #361's repository bindings (#365).
//
// The split mirrors backup.ts: DATA ASSEMBLY lives here (desired state
// from the compiler, observed state from one kubectl exec per profile),
// rendering stays in main.ts. Every probe is kubectl truth from the
// running containers - never a prompt asking an agent what it thinks it
// can see - and every kubectl call addresses the profile through the
// same bundle-aware resolution backups use (backupNsOf), because a
// bundled profile probed at hermes-<name> reads "mount absent" for a
// mount that is present.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { backupNsOf } from "../backup/routines.ts";
import { invokeForEval, type EvalInvokeSpec } from "../communication/index.ts";
import {
  KCTX,
  STAGING,
  appOf,
  kubectl,
  log,
  nsOf,
  profileCtxs,
  sh,
  type HgState,
  type ProfileCtx,
} from "../lib.ts";
import { workspaceDeclarationFile, bundleDeclarationFile, type ValidationFinding } from "../platform/index.ts";
import { loadBundleDeclarations } from "../platform/profile-bundles.ts";
import {
  compileWorkspaceBindings,
  loadWorkspaceDeclarations,
  mergeWorkspacesIntoBundles,
  readWorkspaceProfileRecords,
  workspaceFiles,
  writeWorkspaceTree,
  type NormalizedWorkspaceBinding,
  type WorkspaceProfileRecord,
} from "./bindings.ts";

// ---------------------------------------------------------------------------
// Desired state - one derivation shared by list/verify/doctor/test, the
// SAME compile `hg workspace plan` runs (profile-ctx seeds overlaid by
// emitted records, requireResolution on).

export interface DesiredWorkspaces {
  declaration: string | null;
  bindings: NormalizedWorkspaceBinding[];
  findings: ValidationFinding[];
  /** Repository name -> the declaration said `source: self`. Lost in the
   * normalized binding (self resolves to a concrete url per profile), and
   * the scenario classification needs it back. */
  selfRepositories: Set<string>;
  /** Profiles a bundle declaration claims - the emission split authority. */
  bundledProfiles: Set<string>;
}

export function desiredWorkspaces(
  state: HgState,
  gitopsDir?: string,
  opts: { requireResolution?: boolean } = {},
): DesiredWorkspaces {
  const declaration = workspaceDeclarationFile(state);
  const empty: DesiredWorkspaces = {
    declaration,
    bindings: [],
    findings: [],
    selfRepositories: new Set(),
    bundledProfiles: new Set(),
  };
  if (!declaration) return empty;

  // Records overlay: the local loop's staging tree by default; on a
  // reconciled environment (ADR-54) the emitted records live in the
  // GitOps repository on GitHub, so `--gitops <clone>` points here at a
  // checkout of it - the same convention `hg nexus install` uses.
  const records = new Map<string, WorkspaceProfileRecord>();
  for (const ctx of profileCtxs(state)) records.set(ctx.name, {});
  for (const [name, record] of readWorkspaceProfileRecords(gitopsDir ?? path.join(STAGING, "gitops"))) {
    records.set(name, record);
  }
  try {
    const declarations = loadWorkspaceDeclarations(declaration);
    // requireResolution: true against a deployed environment; the
    // one-shot pre-deploy form (workspace doctor --dir, #673) turns it
    // off - `source: self` resolves at emit, and refusing a repo that
    // has never deployed would make the front door's own scaffold fail
    // its own gate.
    const result = compileWorkspaceBindings(declarations, records, {
      requireResolution: opts.requireResolution ?? true,
    });
    const selfRepositories = new Set(
      declarations.repositories.filter((r) => r.source === "self").map((r) => r.name),
    );
    const bundleFile = bundleDeclarationFile(state);
    const bundledProfiles = new Set<string>();
    if (bundleFile) {
      try {
        const bundleDeclarations = loadBundleDeclarations(bundleFile);
        for (const bundle of bundleDeclarations.bundles ?? []) {
          for (const profile of bundle.profiles) bundledProfiles.add(profile.name);
        }
        // Plan/up parity: run the same merge `hg up` applies (bundle-level
        // mount coherence), reporting refusals instead of shipping them.
        if (result.bindings.length > 0) {
          mergeWorkspacesIntoBundles(bundleDeclarations, result.bindings);
        }
      } catch (err) {
        result.findings.push({
          profile: "*",
          severity: "error",
          check: "workspaces",
          message: err instanceof Error ? err.message : String(err),
          file: bundleFile,
        });
      }
    }
    return { declaration, bindings: result.bindings, findings: result.findings, selfRepositories, bundledProfiles };
  } catch (err) {
    return {
      ...empty,
      findings: [
        {
          profile: "*",
          severity: "error",
          check: "workspaces",
          message: err instanceof Error ? err.message : String(err),
          file: declaration,
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Deployed shape - where a profile's container actually is. Declared
// bundle membership says where it WOULD be; the namespace probe says
// whether this deployment bundles at all (backupNsOf owns that check).

export interface WorkspaceShape {
  profile: string;
  deployed: "bundled" | "independent";
  namespace: string;
  container: string;
  /** The agent runtime (ADR-149): decides the container name and where a
   * workspace checkout lives. Hermes mounts each repository at its declared
   * mountPath; an Eve agent gets every binding under EVE_WORKSPACES_ROOT
   * (/app/workspaces standalone, /workspaces in a bundle) and reaches it
   * through EVE_WORKSPACE_<NAME> - the declared mountPath is not honoured
   * (ADR-150 cost). */
  runtime: "hermes" | "eve";
}

export function shapeOf(ctx: ProfileCtx): WorkspaceShape {
  const namespace = backupNsOf(ctx);
  const bundled = namespace !== nsOf(ctx.name);
  const runtime = ctx.runtime === "eve" ? "eve" : "hermes";
  return {
    profile: ctx.name,
    deployed: bundled ? "bundled" : "independent",
    namespace,
    container: runtime === "eve" ? (bundled ? ctx.name : "eve-agent") : bundled ? `profile-${ctx.name}` : "hermes-agent",
    runtime,
  };
}

/** The profile's running agent pod: `<app>-0` when the StatefulSet answers
 * to the profile's own name, else the first Running non-Job pod in the
 * bundle namespace (the eval runner's rule). Null when nothing runs. */
export function agentPodOf(shape: WorkspaceShape): string | null {
  if (shape.deployed === "independent") {
    const name = `${appOf(shape.profile)}-0`;
    const probe = sh(
      ["kubectl", "--context", KCTX, "-n", shape.namespace, "get", "pod", name, "-o",
        "jsonpath={.status.phase}"],
      { allowFail: true, quiet: true },
    ).trim();
    return probe === "Running" ? name : null;
  }
  const out = kubectl(["-n", shape.namespace, "get", "pods", "-o", "json"], {
    allowFail: true,
    quiet: true,
  });
  if (!out.trim()) return null;
  try {
    const doc = JSON.parse(out) as {
      items?: {
        metadata?: { name?: string; ownerReferences?: { kind?: string }[] };
        status?: { phase?: string };
      }[];
    };
    return (
      (doc.items ?? []).find(
        (p) =>
          p.status?.phase === "Running" &&
          !(p.metadata?.ownerReferences ?? []).some((o) => o.kind === "Job"),
      )?.metadata?.name ?? null
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The probe - ONE exec per profile, every repository in one script. Each
// line is `<repo> key=value`; parsing tolerates anything else the shell
// prints. The write probe is the read-only proof: readOnly is a kernel
// mount option in the chart, so `touch` failing with EROFS is the real
// guarantee, not a prompt.

export interface MountProbe {
  repository: string;
  present: boolean;
  /** `git rev-parse HEAD` inside the mount; null when absent/unreadable. */
  revision: string | null;
  readable: boolean;
  /** null when the mount is absent (nothing to write into). */
  writable: boolean | null;
  /** The sync routine's stamp: sha = converged, unavailable = clone/fetch
   * failed (served stale or empty), missing = no marker written. */
  marker: "sha" | "unavailable" | "missing";
}

function probeScript(repos: { name: string; mountPath: string }[], runtime: "hermes" | "eve" = "hermes"): string {
  const lines = ["set +e"];
  if (runtime === "eve") {
    // The Eve layout (eve-agent/eve-bundle files/boot.sh): checkouts under
    // EVE_WORKSPACES_ROOT/<name>, one stamp per repository under
    // .stamps/<name> (the sha) or .stamps/<name>.unavailable (clone failed,
    // degraded). The root is exported on the container, so the probe reads
    // it rather than guessing the chart's layout.
    lines.push('R="${EVE_WORKSPACES_ROOT:-/app/workspaces}"');
    for (const { name } of repos) {
      const m = `"$R/${name}"`;
      lines.push(
        `if [ -e ${m} ]; then echo "${name} mount=present"; else echo "${name} mount=absent"; fi`,
        `h=$(git -C ${m} rev-parse HEAD 2>/dev/null) && echo "${name} head=$h"`,
        `ls ${m} >/dev/null 2>&1 && echo "${name} read=ok"`,
        `if touch ${m}/.hg-workspace-probe 2>/dev/null; then rm -f ${m}/.hg-workspace-probe; echo "${name} write=ok"; else echo "${name} write=denied"; fi`,
        `if [ -e "$R/.stamps/${name}.unavailable" ]; then echo "${name} marker=unavailable"; elif [ -e "$R/.stamps/${name}" ]; then echo "${name} marker=sha"; else echo "${name} marker=missing"; fi`,
      );
    }
    lines.push("exit 0");
    return lines.join("\n");
  }
  for (const { name, mountPath } of repos) {
    const m = mountPath;
    lines.push(
      `if [ -e ${m} ]; then echo "${name} mount=present"; else echo "${name} mount=absent"; fi`,
      `h=$(git -C ${m} rev-parse HEAD 2>/dev/null) && echo "${name} head=$h"`,
      `ls ${m} >/dev/null 2>&1 && echo "${name} read=ok"`,
      `if touch ${m}/.hg-workspace-probe 2>/dev/null; then rm -f ${m}/.hg-workspace-probe; echo "${name} write=ok"; else echo "${name} write=denied"; fi`,
      // Both chart layouts: the independent chart stamps under
      // .hermes-gitops/workspaces, the bundle chart under
      // .hermes-gitops/bundles/<bundle>. One path per test - `ls A B`
      // exits nonzero when only A exists, which read as marker=missing
      // on the first factory run.
      `S="\${HERMES_HOME:-/opt/data}/.hermes-gitops"`,
      `if [ -e "$S/workspaces/workspace-${name}.unavailable" ] || ls "$S"/bundles/*/workspace-${name}.unavailable >/dev/null 2>&1; then echo "${name} marker=unavailable"; elif [ -e "$S/workspaces/workspace-${name}.sha" ] || ls "$S"/bundles/*/workspace-${name}.sha >/dev/null 2>&1; then echo "${name} marker=sha"; else echo "${name} marker=missing"; fi`,
    );
  }
  lines.push("exit 0");
  return lines.join("\n");
}

/** Parse the probe output - exported for offline tests. */
export function parseProbeOutput(
  output: string,
  repos: { name: string; mountPath: string }[],
): MountProbe[] {
  const byRepo = new Map<string, Record<string, string>>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const repo = line.slice(0, space);
    const kv = line.slice(space + 1);
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    const entry = byRepo.get(repo) ?? {};
    entry[kv.slice(0, eq)] = kv.slice(eq + 1);
    byRepo.set(repo, entry);
  }
  return repos.map(({ name }) => {
    const entry = byRepo.get(name) ?? {};
    const present = entry["mount"] === "present";
    return {
      repository: name,
      present,
      revision: entry["head"] ?? null,
      readable: entry["read"] === "ok",
      writable: present ? entry["write"] === "ok" : null,
      marker:
        entry["marker"] === "sha" ? "sha" : entry["marker"] === "unavailable" ? "unavailable" : "missing",
    };
  });
}

function probeProfile(
  shape: WorkspaceShape,
  pod: string,
  repos: { name: string; mountPath: string }[],
): MountProbe[] {
  const out = kubectl(
    ["-n", shape.namespace, "exec", pod, "-c", shape.container, "--", "sh", "-c", probeScript(repos, shape.runtime)],
    { quiet: true },
  );
  return parseProbeOutput(out, repos);
}

// ---------------------------------------------------------------------------
// Repository groups. A `self` binding expands to one normalized binding
// per profile - same repository NAME, same mount, per-profile source and
// revision - so every consumer here reasons per REPOSITORY, resolving a
// profile's own binding inside the group. Treating each normalized
// binding alone would call a sibling's bound mount "leaked".

export interface RepositoryGroup {
  repository: string;
  mountPath: string;
  access: "read-only" | "read-write";
  purpose: string;
  bindings: NormalizedWorkspaceBinding[];
  /** profile -> the binding that grants IT the mount. */
  targetOf: Map<string, NormalizedWorkspaceBinding>;
}

export function groupBindings(bindings: NormalizedWorkspaceBinding[]): RepositoryGroup[] {
  const groups = new Map<string, RepositoryGroup>();
  for (const binding of bindings) {
    let group = groups.get(binding.repository);
    if (!group) {
      group = {
        repository: binding.repository,
        mountPath: binding.mountPath,
        access: binding.access,
        purpose: binding.purpose,
        bindings: [],
        targetOf: new Map(),
      };
      groups.set(binding.repository, group);
    }
    group.bindings.push(binding);
    for (const profile of binding.targetProfiles) group.targetOf.set(profile, binding);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Verify - desired vs observed, assembled into per-(profile, repository)
// rows. EVERY onboarded profile is probed against EVERY repository: bound
// rows prove presence/revision/read-only, unbound rows prove ABSENCE -
// the boundary is as much the contract as the mount.

export interface VerifyRow {
  profile: string;
  repository: string;
  namespace: string;
  shape: "bundled" | "independent";
  expected: "mounted" | "absent";
  mountPath: string;
  access: "read-only" | "read-write";
  resolvedRevision: string;
  probe: MountProbe | null;
  /** Declared credential present in the profile's namespace; null = no
   * credential declared (public source). */
  credentialOk: boolean | null;
  ok: boolean;
  problems: string[];
}

export interface VerifyResult {
  rows: VerifyRow[];
  /** Profiles that could not be probed at all (no running pod). */
  unreachable: string[];
  ok: boolean;
}

function judgeBound(
  binding: NormalizedWorkspaceBinding,
  probe: MountProbe,
  credentialOk: boolean | null,
): string[] {
  const problems: string[] = [];
  if (!probe.present) problems.push("mount absent");
  else {
    if (!probe.readable) problems.push("mount not readable");
    if (probe.revision !== binding.resolvedRevision) {
      problems.push(
        `revision drift: observed ${probe.revision?.slice(0, 12) ?? "none"} != resolved ${binding.resolvedRevision.slice(0, 12)}`,
      );
    }
    if (binding.access === "read-only" && probe.writable === true) {
      problems.push("WRITABLE though declared read-only");
    }
    if (binding.access === "read-write" && probe.writable === false) {
      problems.push("not writable though declared read-write");
    }
  }
  if (probe.marker === "unavailable") {
    problems.push("sync marker says unavailable - the checkout is stale or empty");
  }
  if (credentialOk === false) problems.push("declared credential Secret is missing");
  return problems;
}

export function workspaceVerify(
  state: HgState,
  desired: DesiredWorkspaces,
  filter: { profile?: string; repository?: string } = {},
): VerifyResult {
  const groups = groupBindings(desired.bindings).filter(
    (g) => !filter.repository || g.repository === filter.repository,
  );
  const ctxs = profileCtxs(state).filter((c) => !filter.profile || c.name === filter.profile);
  const rows: VerifyRow[] = [];
  const unreachable: string[] = [];
  const secretCache = new Map<string, boolean>();
  const secretOk = (ns: string, name: string): boolean => {
    const key = `${ns}/${name}`;
    const hit = secretCache.get(key);
    if (hit !== undefined) return hit;
    const out = sh(
      ["kubectl", "--context", KCTX, "-n", ns, "get", "secret", name, "-o", "name"],
      { allowFail: true, quiet: true },
    ).trim();
    secretCache.set(key, Boolean(out));
    return Boolean(out);
  };

  for (const ctx of ctxs) {
    if (groups.length === 0) continue;
    const shape = shapeOf(ctx);
    const pod = agentPodOf(shape);
    if (!pod) {
      unreachable.push(ctx.name);
      for (const group of groups) {
        const mine = group.targetOf.get(ctx.name);
        rows.push({
          profile: ctx.name,
          repository: group.repository,
          namespace: shape.namespace,
          shape: shape.deployed,
          expected: mine ? "mounted" : "absent",
          mountPath: group.mountPath,
          access: group.access,
          resolvedRevision: (mine ?? group.bindings[0]!).resolvedRevision,
          probe: null,
          credentialOk: null,
          ok: false,
          problems: ["no running pod - cannot observe"],
        });
      }
      continue;
    }
    const probes = probeProfile(
      shape,
      pod,
      groups.map((g) => ({ name: g.repository, mountPath: g.mountPath })),
    );
    const probeByRepo = new Map(probes.map((p) => [p.repository, p]));
    for (const group of groups) {
      const mine = group.targetOf.get(ctx.name);
      const probe = probeByRepo.get(group.repository)!;
      const credentialOk =
        mine?.authSecretRef ? secretOk(shape.namespace, mine.authSecretRef) : null;
      const problems = mine
        ? judgeBound(mine, probe, credentialOk)
        : probe.present
          ? ["visible to a profile its binding does not name"]
          : [];
      rows.push({
        profile: ctx.name,
        repository: group.repository,
        namespace: shape.namespace,
        shape: shape.deployed,
        expected: mine ? "mounted" : "absent",
        mountPath: group.mountPath,
        access: group.access,
        resolvedRevision: (mine ?? group.bindings[0]!).resolvedRevision,
        probe,
        credentialOk,
        ok: problems.length === 0,
        problems,
      });
    }
  }
  return { rows, unreachable, ok: rows.every((r) => r.ok) && unreachable.length === 0 };
}

// ---------------------------------------------------------------------------
// Doctor - does the WRITTEN tree still reproduce from the declaration,
// and do the referenced Secrets exist? --deep adds the verify probes.

export interface DoctorFinding {
  severity: "error" | "warning";
  message: string;
}

export function workspaceDoctor(
  state: HgState,
  desired: DesiredWorkspaces,
  gitopsDir?: string,
): DoctorFinding[] {
  const findings: DoctorFinding[] = desired.findings.map((f) => ({
    severity: f.severity,
    message: `[${f.profile}] ${f.message}`,
  }));
  if (!desired.declaration) return findings;

  // Byte-reproducibility: the generated tree (staging, or the --gitops
  // clone on a reconciled environment) must be exactly what the compiler
  // emits today - drift means an edit landed in the GENERATED records, or
  // the tree was never re-emitted after the declaration moved. The
  // emission split follows DEPLOYED shape (a declared bundle an
  // environment runs unbundled emits per-profile files), so the set comes
  // from the same namespace probe verify addresses pods with.
  try {
    const deployedBundled = new Set(
      profileCtxs(state)
        .filter((ctx) => shapeOf(ctx).deployed === "bundled")
        .map((ctx) => ctx.name),
    );
    const files = workspaceFiles(desired.bindings, deployedBundled);
    const gitops = gitopsDir ?? path.join(STAGING, "gitops");
    const drift = writeWorkspaceTree(gitops, files, true);
    if (drift.changed) {
      findings.push({
        severity: "error",
        message:
          `generated workspace records drift from the declaration ` +
          `(${[...drift.written, ...drift.deleted].join(", ")}) - run hg up (local loop) ` +
          "or re-emit and PR the tree (reconciled); never edit deployments/workspaces/ by hand",
      });
    }
  } catch (err) {
    findings.push({
      severity: "error",
      message: `generated records cannot be produced: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Declared credentials must exist where the bound profiles run.
  const checked = new Set<string>();
  for (const binding of desired.bindings) {
    if (!binding.authSecretRef) continue;
    for (const profile of binding.targetProfiles) {
      const ctx = profileCtxs(state).find((c) => c.name === profile);
      if (!ctx) continue;
      const ns = backupNsOf(ctx);
      const key = `${ns}/${binding.authSecretRef}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const out = sh(
        ["kubectl", "--context", KCTX, "-n", ns, "get", "secret", binding.authSecretRef, "-o", "name"],
        { allowFail: true, quiet: true },
      ).trim();
      if (!out) {
        findings.push({
          severity: "error",
          message: `Secret ${binding.authSecretRef} missing in ${ns} (repository ${binding.repository})`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Scenarios - the ticket's two reference shapes, DERIVED from the
// declaration rather than hardcoded: a `self` repository is the
// operation-source scenario, anything else is business context. The
// declaration is the authority for who must see what; the ticket's
// original profile list predates a binding Calvin widened.

export interface WorkspaceScenario {
  name: string;
  repository: string;
  revisionMatched: boolean;
  expectedVisibleProfiles: string[];
  unexpectedVisibleProfiles: string[];
  readOnlyVerified: boolean;
  alertTraceId?: string;
  sourceReadToolRuns?: number;
  runtimeDiagnosticToolRuns?: number;
  pass: boolean;
  problems: string[];
}

export function scenarioNameFor(desired: DesiredWorkspaces, repository: string): string {
  return desired.selfRepositories.has(repository) ? "sre-operation-source" : "business-context";
}

/** Assemble a scenario from verify rows - pure, offline-testable. Each
 * bound row is judged against ITS OWN binding's resolved revision (rows
 * carry it), so a `self` group with per-profile revisions stays honest. */
export function scenarioFromRows(
  desired: DesiredWorkspaces,
  group: RepositoryGroup,
  rows: VerifyRow[],
): WorkspaceScenario {
  const mine = rows.filter((r) => r.repository === group.repository);
  const bound = mine.filter((r) => r.expected === "mounted");
  const unbound = mine.filter((r) => r.expected === "absent");
  const problems: string[] = [];
  for (const row of mine) for (const p of row.problems) problems.push(`${row.profile}: ${p}`);
  const revisionMatched =
    bound.length > 0 && bound.every((r) => r.probe?.revision === r.resolvedRevision);
  const readOnlyVerified =
    group.access !== "read-only" ||
    (bound.length > 0 && bound.every((r) => r.probe?.present === true && r.probe.writable === false));
  const unexpectedVisibleProfiles = unbound
    .filter((r) => r.probe?.present === true)
    .map((r) => r.profile);
  return {
    name: scenarioNameFor(desired, group.repository),
    repository: group.repository,
    revisionMatched,
    expectedVisibleProfiles: [...group.targetOf.keys()],
    unexpectedVisibleProfiles,
    readOnlyVerified,
    pass: problems.length === 0 && revisionMatched && readOnlyVerified && unexpectedVisibleProfiles.length === 0,
    problems,
  };
}

// ---------------------------------------------------------------------------
// The alert-trace leg (sre-operation-source only): fire the persona's own
// alert eval fixture through the REAL router, then read the handling
// session from the agent's state.db - the workspace.read records the
// source-inspection skill prints carry the incident correlation id, which
// is what "source-read correlated to a real alert trace" means.

interface EvalScenarioDoc {
  name?: string;
  invoke?: EvalInvokeSpec;
  expect?: { outputs?: { agent?: { profile?: string } }[] };
}

/** Find a repo-owned eval scenario that drives an event to `profile` -
 * the persona already maintains the alert fixture; reuse it rather than
 * inventing a second payload that must track the event schema. */
export function findAlertScenario(
  repoRoot: string,
  profile: string,
): { dir: string; spec: EvalInvokeSpec } | null {
  const root = path.join(repoRoot, "evals", "scenarios");
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root).sort()) {
    const file = path.join(root, entry, "scenario.yaml");
    if (!fs.existsSync(file)) continue;
    let doc: EvalScenarioDoc | null;
    try {
      doc = parseYaml(fs.readFileSync(file, "utf8")) as EvalScenarioDoc;
    } catch {
      continue;
    }
    if (!doc?.invoke?.event) continue;
    const targets = (doc.expect?.outputs ?? []).some((o) => o.agent?.profile === profile);
    if (targets) return { dir: path.join(root, entry), spec: doc.invoke };
  }
  return null;
}

/** Read the handling session's evidence from the agent's state.db.
 *
 * Three facts the first factory run taught: the DB is PER-PROFILE
 * (`$HERMES_HOME/profiles/<name>/state.db`; the root state.db exists but
 * holds no sessions); a `mode=ro` URI open fails against the live WAL
 * (plain connect works - WAL readers never block the writer); and
 * session keys are GATEWAY-native (`agent:main:webhook:...`), so the
 * router's sessionKey matches nothing - the correlation id in the
 * delivered payload is the join, searched in message content. */
const SESSION_PROBE = `
import json, os, sqlite3, sys
profile, trace = sys.argv[1], sys.argv[2]
home = os.environ.get("HERMES_HOME", "/opt/data")
for db in (os.path.join(home, "profiles", profile, "state.db"), os.path.join(home, "state.db")):
    if not os.path.exists(db):
        continue
    try:
        c = sqlite3.connect(db)
        row = c.execute(
            "select session_id from messages where content like ? limit 1",
            ("%" + trace + "%",),
        ).fetchone()
        if not row:
            continue
        sid = row[0]
        srow = c.execute("select tool_call_count, ended_at from sessions where id=?", (sid,)).fetchone()
        reads = c.execute(
            "select count(*) from messages where session_id=? and content like ? and content like ?",
            (sid, "%workspace.read%", "%" + trace + "%"),
        ).fetchone()[0]
        print(json.dumps({
            "session": sid,
            "toolRuns": (srow[0] if srow else 0) or 0,
            "sourceReads": reads,
            "ended": bool(srow and srow[1]),
        }))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(0)
print(json.dumps({"session": None}))
`;

export interface AlertTraceEvidence {
  alertTraceId: string;
  sessionKey: string | null;
  sourceReadToolRuns: number;
  runtimeDiagnosticToolRuns: number;
  problems: string[];
}

export async function collectAlertTrace(
  state: HgState,
  profile: string,
  opts: { timeoutMs?: number } = {},
): Promise<AlertTraceEvidence | null> {
  const found = findAlertScenario(state.profileDir, profile);
  if (!found) return null;
  log(`firing the persona's alert fixture at ${profile} through the router`);
  const invocation = await invokeForEval(found.spec, { scenarioDir: found.dir });
  const problems: string[] = [];
  const trace = invocation.correlationIds[0] ?? "";
  if (!invocation.ok || !trace) {
    return {
      alertTraceId: trace,
      sessionKey: null,
      sourceReadToolRuns: 0,
      runtimeDiagnosticToolRuns: 0,
      problems: [`alert invocation failed: ${invocation.error ?? "no correlation id"}`],
    };
  }
  const agentReceipt = invocation.receipts.find(
    (r) => r.kind === "agent" && ["accepted", "delivered"].includes(r.status),
  ) as { sessionKey?: string } | undefined;
  const sessionKey = agentReceipt?.sessionKey ?? null;
  if (!sessionKey) {
    return {
      alertTraceId: trace,
      sessionKey: null,
      sourceReadToolRuns: 0,
      runtimeDiagnosticToolRuns: 0,
      problems: ["no accepted agent delivery carrying a session key"],
    };
  }

  const ctx = profileCtxs(state).find((c) => c.name === profile);
  if (!ctx) {
    return { alertTraceId: trace, sessionKey, sourceReadToolRuns: 0, runtimeDiagnosticToolRuns: 0, problems: [`profile ${profile} not onboarded`] };
  }
  const shape = shapeOf(ctx);
  const pod = agentPodOf(shape);
  if (!pod) {
    return { alertTraceId: trace, sessionKey, sourceReadToolRuns: 0, runtimeDiagnosticToolRuns: 0, problems: ["no running pod to read the session from"] };
  }

  // The delivery is accepted before the agent finishes THINKING - and
  // tool_call_count keeps growing until the session ENDS, so breaking on
  // the first source read under-counted the diagnostics that follow it.
  // Poll until the handling session ends (or the window closes) and
  // judge the final counts.
  const deadline = Date.now() + (opts.timeoutMs ?? 240_000);
  let last: { session?: string | null; toolRuns?: number; sourceReads?: number; ended?: boolean; error?: string } = {};
  for (;;) {
    const out = kubectl(
      ["-n", shape.namespace, "exec", pod, "-c", shape.container, "--",
        "python3", "-c", SESSION_PROBE, profile, trace],
      { allowFail: true, quiet: true },
    ).trim();
    try {
      last = JSON.parse(out.split("\n").pop() ?? "{}");
    } catch {
      last = { error: out.slice(0, 200) };
    }
    if ((last.session && last.ended) || Date.now() > deadline) break;
    sh(["sleep", "10"], { quiet: true });
  }
  if (last.error) problems.push(`session probe failed: ${last.error}`);
  if (!last.session) problems.push(`no session carrying ${trace} in state.db`);
  const reads = last.sourceReads ?? 0;
  if (reads === 0) problems.push("no workspace.read record carrying the alert correlation id");
  const toolRuns = last.toolRuns ?? 0;
  if (toolRuns - reads <= 0) problems.push("no runtime-diagnostic tool runs beside the source read");
  return {
    alertTraceId: trace,
    sessionKey,
    sourceReadToolRuns: reads,
    runtimeDiagnosticToolRuns: Math.max(0, toolRuns - reads),
    problems,
  };
}

// ---------------------------------------------------------------------------
// The tier assembly: verify everything, fold into scenarios, run the
// alert-trace leg for the operation-source scenario. This is `hg test
// --tier workspace-bindings` AND `hg workspace test --scenario X` - one
// engine, one contract.

export interface WorkspaceTierResult {
  tier: "workspace-bindings";
  pass: boolean;
  testRunId: string;
  scenarios: WorkspaceScenario[];
  /** Per-profile pass rows for the shared `hg test` results table. */
  profiles: { profile: string; pass: boolean }[];
  unreachable: string[];
}

export async function runWorkspaceTier(
  state: HgState,
  opts: { scenario?: string; withAlertTrace?: boolean; gitopsDir?: string } = {},
): Promise<WorkspaceTierResult> {
  const desired = desiredWorkspaces(state, opts.gitopsDir);
  const testRunId = crypto.randomUUID();
  const compileErrors = desired.findings.filter((f) => f.severity === "error");
  if (!desired.declaration || desired.bindings.length === 0 || compileErrors.length > 0) {
    return {
      tier: "workspace-bindings",
      pass: compileErrors.length === 0, // no declaration = vacuous pass
      testRunId,
      scenarios: compileErrors.map((f) => ({
        name: "compile",
        repository: "*",
        revisionMatched: false,
        expectedVisibleProfiles: [],
        unexpectedVisibleProfiles: [],
        readOnlyVerified: false,
        pass: false,
        problems: [f.message],
      })),
      profiles: [],
      unreachable: [],
    };
  }
  const verify = workspaceVerify(state, desired);
  const scenarios: WorkspaceScenario[] = [];
  for (const group of groupBindings(desired.bindings)) {
    const scenario = scenarioFromRows(desired, group, verify.rows);
    if (opts.scenario && scenario.name !== opts.scenario) continue;
    const targets = [...group.targetOf.keys()];
    if (
      scenario.name === "sre-operation-source" &&
      (opts.withAlertTrace ?? true) &&
      targets.length > 0
    ) {
      const trace = await collectAlertTrace(state, targets[0]!);
      if (trace) {
        scenario.alertTraceId = trace.alertTraceId;
        scenario.sourceReadToolRuns = trace.sourceReadToolRuns;
        scenario.runtimeDiagnosticToolRuns = trace.runtimeDiagnosticToolRuns;
        scenario.problems.push(...trace.problems);
        scenario.pass = scenario.pass && trace.problems.length === 0;
      } else {
        scenario.problems.push(
          "no eval scenario drives an event to this profile - the alert-trace leg cannot run",
        );
        scenario.pass = false;
      }
    }
    scenarios.push(scenario);
  }
  if (opts.scenario && scenarios.length === 0) {
    throw new Error(
      `--scenario ${opts.scenario} matches no binding (have: ${[
        ...new Set(desired.bindings.map((b) => scenarioNameFor(desired, b.repository))),
      ].join(", ")})`,
    );
  }
  const profiles = [...new Set(verify.rows.map((r) => r.profile))].map((profile) => ({
    profile,
    pass: verify.rows.filter((r) => r.profile === profile).every((r) => r.ok),
  }));
  return {
    tier: "workspace-bindings",
    pass: scenarios.every((s) => s.pass) && verify.unreachable.length === 0,
    testRunId,
    scenarios,
    profiles,
    unreachable: verify.unreachable,
  };
}

// ---------------------------------------------------------------------------
// List decoration - the authored view joined with deployment shape.

export interface WorkspaceListRow {
  repository: string;
  source: string;
  resolvedRevision: string;
  mountPath: string;
  access: "read-only" | "read-write";
  purpose: string;
  authSecretRef?: string;
  classification: string;
  profiles: { profile: string; shape: "bundled" | "independent"; terminalCwd: string | null }[];
}

export function workspaceList(state: HgState, desired: DesiredWorkspaces): WorkspaceListRow[] {
  const groups = groupBindings(desired.bindings);
  const repoCountByProfile = new Map<string, number>();
  for (const group of groups) {
    for (const profile of group.targetOf.keys()) {
      repoCountByProfile.set(profile, (repoCountByProfile.get(profile) ?? 0) + 1);
    }
  }
  return groups.map((group) => {
    const sources = [...new Set(group.bindings.map((b) => b.source))];
    const revisions = [...new Set(group.bindings.map((b) => b.resolvedRevision))];
    const secret = group.bindings.find((b) => b.authSecretRef)?.authSecretRef;
    return {
      repository: group.repository,
      source: sources.join(" | "),
      // Per-profile revisions (a self group) render as a set; verify
      // judges each profile against its own.
      resolvedRevision: revisions.join(" | "),
      mountPath: group.mountPath,
      access: group.access,
      purpose: group.purpose,
      ...(secret ? { authSecretRef: secret } : {}),
      classification: scenarioNameFor(desired, group.repository),
      profiles: [...group.targetOf.keys()].map((profile) => ({
        profile,
        shape: desired.bundledProfiles.has(profile) ? ("bundled" as const) : ("independent" as const),
        // The chart's default: a single-repository profile lands its
        // terminal in the mount; several repositories have no authored cwd
        // surface yet (the compiler refuses that for independents).
        terminalCwd: (repoCountByProfile.get(profile) ?? 0) === 1 ? group.mountPath : null,
      })),
    };
  });
}
