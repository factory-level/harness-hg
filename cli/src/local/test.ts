// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as path from "node:path";
import { backupStatus, renderStatusLine } from "../backup/routines.ts";
import { declaredAlerts, declaredDashboards, grafanaImportedDashboardUids, grafanaImportedRules, reconcileDashboards, reconcileRules } from "../dash/index.ts";
import { eveSmoke } from "../harness/eve/driver.ts";
import { CliError, HgState, KCTX, ProfileCtx, appOf, freePort, jsonOut, kubectl, loadState, loadTestConfig, log, ok, profileCtxs, repoScriptsAllowed, sh } from "../lib.ts";
import { appStatusOf, applicationOf, profileDeclaresApp, waitFor } from "../platform/index.ts";
import { runWorkspaceTier } from "../workspace/index.ts";
import { grafanaApi } from "./shared.ts";

export async function tierRegister(ctx: ProfileCtx, state: HgState): Promise<boolean> {
  log(`tier register [${ctx.name}]: did the profile's surface land in a fleet-shaped environment?`);
  let pass = true;
  // A bundled profile has no Application of its own (hg up retired it);
  // its Application is the bundle's. Derived from what COMPILED, like up.
  const { application, bundle, namespace: ns } = applicationOf(state, ctx.name);
  const { sync, health } = appStatusOf(application);
  if (sync === "Synced" && health === "Healthy") {
    ok(`Application ${application}: Synced+Healthy${bundle ? ` (bundle ${bundle})` : ""}`);
  } else {
    console.error(`  ✗ Application ${application}: sync=${sync || "?"} health=${health || "?"}`);
    pass = false;
  }
  const declaresMonitoring = profileDeclaresApp(ctx.dir, "monitoring");
  if (declaresMonitoring) {
    for (const kind of ["dashboard", "alerts"]) {
      const name = `${appOf(ctx.name)}-monitoring-${kind}`;
      const found = kubectl(["-n", ns, "get", "configmap", name, "-o", "name"], {
        allowFail: true,
        quiet: true,
      }).trim();
      if (found) ok(`ConfigMap ${name} exists`);
      else {
        console.error(`  ✗ ConfigMap ${name} missing`);
        pass = false;
      }
    }
  } else {
    // No monitoring app - the platform pair is not expected, but any APP
    // chart's labelled ConfigMaps still are: the declared-CM sweep below
    // runs regardless, so a postiz-without-monitoring profile still has
    // its dashboards asserted.
    log("  (no monitoring app declared - skipping the platform dashboard/alert pair only)");
  }
  // Grafana's sidecars import on their own cycle - minutes on a cold
  // cluster - so registration checks poll rather than sample once.
  //
  // Assertions are per DECLARED ConfigMap and matched BY UID, never by
  // title substring: postiz's dashboard title contains the profile name,
  // so a substring search once reported "the profile's dashboard loaded"
  // while the monitoring chart's dashboard had never imported at all.
  const declaredDash = declaredDashboards(ns);
  const declaredA = declaredAlerts(ns);
  const declaredRuleCount = declaredA.reduce((n, c) => n + c.rules.length, 0);
  // Guard against the vacuous pass: a monitoring app whose ConfigMaps
  // exist but parsed to ZERO dashboards/rules (missing labels, broken
  // YAML) must fail, not sail through an empty reconciliation.
  if (declaresMonitoring && (declaredDash.length === 0 || declaredRuleCount === 0)) {
    console.error(
      `  ✗ monitoring app declared but only ${declaredDash.length} dashboard(s) and ` +
        `${declaredRuleCount} rule(s) parsed from labelled ConfigMaps - nothing to verify is a failure`,
    );
    pass = false;
  }
  // Warm path first: one fetch, and only fall into the 5s poll (which
  // re-downloads the fleet rule set per tick) when the first look fails.
  try {
    if (reconcileRules(declaredA, grafanaImportedRules()).length > 0) {
      await waitFor(
        `Grafana to import every declared alert rule (${declaredRuleCount})`,
        600,
        () => reconcileRules(declaredA, grafanaImportedRules()).length === 0,
      );
    }
    ok("every declared alert rule imported, uid-for-uid, all evaluator params numbers");
  } catch {
    for (const f of reconcileRules(declaredA, grafanaImportedRules())) {
      console.error(`  ✗ ${f.message}`);
    }
    pass = false;
  }
  try {
    if (reconcileDashboards(declaredDash, grafanaImportedDashboardUids()).length > 0) {
      await waitFor(
        `Grafana to import every declared dashboard (${declaredDash.length})`,
        300,
        () => reconcileDashboards(declaredDash, grafanaImportedDashboardUids()).length === 0,
      );
    }
    ok(`every declared dashboard imported by uid (${declaredDash.map((d) => d.uid).join(", ")})`);
  } catch {
    for (const f of reconcileDashboards(declaredDash, grafanaImportedDashboardUids())) {
      console.error(`  ✗ ${f.message}`);
    }
    pass = false;
  }
  // The override proof: a locally-lowered threshold must arrive in the
  // IMPORTED rule as that number - the Pulumi channel delivers strings,
  // and a string param means the rule imports clean and never fires.
  const testCfg = loadTestConfig(ctx.dir);
  const threshold = (testCfg.appValues as Record<string, any>)["monitoring"]?.alert?.siteVisits5m
    ?.threshold;
  if (threshold !== undefined) {
    const visitsUid = `${appOf(ctx.name)}-visits`;
    const live = grafanaImportedRules().find((r) => r.uid === visitsUid);
    if (live && (live.params[0] as unknown[])?.[0] === Number(threshold)) {
      ok(`threshold override reached Grafana: rule ${visitsUid} param = ${live.params[0]} (number)`);
    } else {
      console.error(
        `  ✗ threshold override did NOT reach Grafana: rule ${visitsUid} params = ` +
          `${JSON.stringify(live?.params ?? "rule missing")}, expected [${Number(threshold)}]`,
      );
      pass = false;
    }
  }
  return pass;
}

export async function tierSmoke(ctx: ProfileCtx): Promise<boolean> {
  log(`tier smoke [${ctx.name}]: deterministic functional checks`);
  const testCfg = loadTestConfig(ctx.dir);
  // A bundled profile's workloads live in the bundle's namespace, and its
  // own Service is gone: a check against it targets the bundle's Service,
  // which carries the member's api port only when bundles.yaml gave it one.
  const { bundle, namespace: ns, service: bundleService, apiServerPort } = applicationOf(loadState(), ctx.name);
  let pass = true;

  // Every workload the profile deployed must be ready.
  const notReady = kubectl(
    ["-n", ns, "get", "pods", "--field-selector=status.phase!=Succeeded", "-o",
      'jsonpath={range .items[*]}{.metadata.name}={.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}'],
    { allowFail: true, quiet: true },
  )
    .split("\n")
    .filter((l) => l.trim() && !l.endsWith("=True"));
  if (notReady.length === 0) ok(`all pods Ready in ${ns}`);
  else {
    console.error(`  ✗ pods not Ready: ${notReady.join(", ")}`);
    pass = false;
  }

  // Declared HTTP checks, through a short-lived port-forward each.
  for (const check of testCfg.smoke) {
    let service = check.service;
    if (bundle && check.service === appOf(ctx.name)) {
      if (!apiServerPort) {
        log(`  (skip smoke ${check.service}${check.path}: ${ctx.name} is bundled in ${bundle} without an apiServerPort, so it has no API surface)`);
        continue;
      }
      service = bundleService;
    }
    const local = freePort();
    const pf = Bun.spawn(
      ["kubectl", "--context", KCTX, "-n", ns, "port-forward",
        `svc/${service}`, `${local}:${check.port}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      await Bun.sleep(1500);
      let body = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          body = await (await fetch(`http://127.0.0.1:${local}${check.path}`)).text();
          if (body.includes(check.expect_contains)) break;
        } catch {
          /* retry */
        }
        await Bun.sleep(2000);
      }
      if (body.includes(check.expect_contains)) {
        ok(`smoke: ${check.service}${check.path} contains ${JSON.stringify(check.expect_contains)}`);
      } else {
        console.error(
          `  ✗ smoke: ${check.service}${check.path} did not contain ` +
            `${JSON.stringify(check.expect_contains)} (got: ${body.slice(0, 120)})`,
        );
        pass = false;
      }
    } finally {
      pf.kill();
    }
  }
  if (testCfg.smoke.length === 0) log("  (no smoke checks declared in hermes-gitops.test.yaml)");
  return pass;
}

export function tierBehavioral(state: HgState, ctx: ProfileCtx, allowRepoScripts: boolean): boolean {
  log(`tier behavioral [${ctx.name}]: golden cases (makes model calls)`);
  log("  note: this tier is deprecated - hg eval --dir <evals> is the behavioural runner");
  const testCfg = loadTestConfig(ctx.dir);
  if (testCfg.pyeval) {
    // Repo-owned pytest is arbitrary repo code - same §27 gate as reset
    // hooks and eval scenarios (this path ran ungated before hg eval).
    if (!repoScriptsAllowed(state, allowRepoScripts)) {
      console.error(
        `  ✗ skipped pyeval suite ${testCfg.pyeval}: this profile was onboarded from a ` +
          "URL and repo scripts are untrusted - re-run with --allow-repo-scripts to consent",
      );
      return false;
    }
    log(`running pyeval suite: ${testCfg.pyeval}`);
    try {
      sh(["uv", "run", "pytest", "-q", path.join(ctx.dir, testCfg.pyeval)], {
        cwd: ctx.dir,
      });
      ok("pyeval suite passed");
      return true;
    } catch (err) {
      console.error(`  ✗ pyeval suite failed:\n${(err as Error).message}`);
      return false;
    }
  }
  if (testCfg.behavioral.length > 0) {
    throw new CliError(
      "behavioral cases in hermes-gitops.test.yaml were never implemented and " +
        "are deprecated - write an evals/ suite and run it with " +
        "`hermes-gitops eval --dir <repo>` (schema: cli/schemas/evals/v1alpha1)",
    );
  }
  log("  (no behavioral cases declared - skipped)");
  return true;
}

export function tierBackup(ctx: ProfileCtx): boolean {
  log(`tier backup [${ctx.name}]: declared intent vs discovered routines`);
  const status = backupStatus(ctx, false);
  if (!status.declaresBackup && status.routines.length === 0) {
    log("  (no backup declared and no routines present - skipped)");
    return true;
  }
  for (const r of status.routines) console.log(`  ${renderStatusLine(r)}`);
  let pass = true;
  for (const f of status.findings) {
    if (f.severity === "error") {
      console.error(`  ✗ ${f.message}`);
      pass = false;
    } else console.error(`  ! ${f.message}`);
  }
  if (pass) ok(`${status.routines.length} routine(s) discovered, none broken`);
  return pass;
}

export const PLATFORM_DASHBOARD_UIDS = [
  "hermes-fleet-tco",
  "hg-control-plane-overview",
  "hg-control-plane-reconciliation",
  "hg-backup-history",
];

export async function fleetRegister(): Promise<boolean> {
  log("fleet: platform-level dashboard registration");
  let pass = true;
  for (const uid of PLATFORM_DASHBOARD_UIDS) {
    try {
      await waitFor(`Grafana to load ${uid}`, 300, () => {
        const out = grafanaApi(`/api/dashboards/uid/${uid}`);
        try {
          return Boolean((JSON.parse(out) as { dashboard?: unknown }).dashboard);
        } catch {
          return false;
        }
      });
      ok(`Grafana loaded ${uid}`);
    } catch {
      console.error(`  ✗ Grafana never loaded ${uid}`);
      pass = false;
    }
  }
  return pass;
}

export async function cmdTest(
  tier: string | undefined,
  json: boolean,
  allowRepoScripts: boolean,
  gitopsDir?: string,
): Promise<void> {
  const state = loadState();
  const tiers = tier ? [tier] : ["register", "smoke"];
  const ctxs = profileCtxs(state);
  const results: { profile: string; tier: string; pass: boolean }[] = [];
  // The workspace tier's structured contract (#365): the ticket's
  // {tier, pass, testRunId, scenarios[]} envelope rides the shared JSON
  // output under this key when the tier ran.
  let workspaceTier: Awaited<ReturnType<typeof runWorkspaceTier>> | undefined;
  let pass = true;
  for (const t of tiers) {
    if (t === "register") {
      const fleet = await fleetRegister();
      results.push({ profile: "<fleet>", tier: "register", pass: fleet });
      pass = fleet && pass;
      for (const ctx of ctxs) {
        const r = await tierRegister(ctx, state);
        results.push({ profile: ctx.name, tier: t, pass: r });
        pass = r && pass;
      }
    } else if (t === "smoke") {
      for (const ctx of ctxs) {
        const r = ctx.runtime === "eve" ? await eveSmoke(ctx) : await tierSmoke(ctx);
        results.push({ profile: ctx.name, tier: t, pass: r });
        pass = r && pass;
      }
    } else if (t === "behavioral") {
      for (const ctx of ctxs) {
        const r = tierBehavioral(state, ctx, allowRepoScripts);
        results.push({ profile: ctx.name, tier: t, pass: r });
        pass = r && pass;
      }
    } else if (t === "backup") {
      for (const ctx of ctxs) {
        const r = tierBackup(ctx);
        results.push({ profile: ctx.name, tier: t, pass: r });
        pass = r && pass;
      }
    } else if (t === "workspace-bindings") {
      // Fleet-scoped like register: the unbound-sibling assertion is a
      // CROSS-profile fact, so the engine probes everyone in one pass and
      // the per-profile rows here are its projection.
      workspaceTier = await runWorkspaceTier(state, { gitopsDir });
      for (const s of workspaceTier.scenarios) {
        log(`scenario ${s.name} (${s.repository}): ${s.pass ? "pass" : "FAIL"}`);
        for (const p of s.problems) log(`  ! ${p}`);
      }
      results.push({ profile: "<fleet>", tier: t, pass: workspaceTier.pass });
      for (const row of workspaceTier.profiles) {
        results.push({ profile: row.profile, tier: t, pass: row.pass });
      }
      pass = workspaceTier.pass && pass;
    } else {
      throw new CliError(
        `unknown tier ${JSON.stringify(t)} (register|smoke|backup|behavioral|workspace-bindings)`,
      );
    }
  }
  if (json) {
    jsonOut({
      command: "test",
      tiers,
      ok: pass,
      results,
      failed: results.filter((r) => !r.pass),
      ...(workspaceTier
        ? {
            workspace: {
              tier: workspaceTier.tier,
              pass: workspaceTier.pass,
              testRunId: workspaceTier.testRunId,
              scenarios: workspaceTier.scenarios,
            },
          }
        : {}),
    });
  }
  if (!pass) throw new CliError("test tier(s) FAILED");
  if (!json) ok(`test ${tiers.join("+")} across ${ctxs.length} profile(s): PASS`);
}
