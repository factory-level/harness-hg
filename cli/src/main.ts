#!/usr/bin/env bun
// hermes-gitops (alias: hg) - the local testing CLI (spec §27).
// A developer tool, never part of the runtime: onboard a profile, stand
// up a throwaway fleet-shaped platform, hot-reload through the REAL
// git → Argo CD sync path, run the deterministic test tiers, reset.
// See _docs/wiki/reference/cli/index.md.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  CLUSTER_NAME,
  CliError,
  HG_HOME,
  KCTX,
  PLATFORM_ROOT,
  SINK_LOG,
  STAGING,
  appOf,
  freePort,
  envOverlayFile,
  jsonOut,
  kubectl,
  deepMerge,
  loadEnvOverlay,
  loadState,
  loadTestConfig,
  log,
  nsOf,
  ok,
  parseDotenv,
  pidAlive,
  portAccepts,
  profileCtxs,
  repoScriptsAllowed,
  saveEnvOverlay,
  saveState,
  setJsonMode,
  sh,
  toRfc3339,
  AGENT_IMAGE,
  type AgentRuntime,
  type HgState,
  bundleAppOf,
  type ProfileCtx,
} from "./lib.ts";
import { runEval } from "./eval/index.ts";
import {
  fetchEvalResults,
  latestReport,
  proveEvalPublishing,
  publishEvalReport,
} from "./eval/publish.ts";
import { proveAuth } from "./auth/prove.ts";
import { cmdDiscord } from "./discord/index.ts";
import { cmdCron } from "./cron/index.ts";
import { cmdDebugWebhook } from "./debug/index.ts";
import {
  chartsWantedBy,
  ensureRegistry,
  publishPersonaCharts,
  redirectOciRepos,
} from "./platform/registry.ts";
import { proveGrafana } from "./grafana/prove.ts";
import { proveSlack, recordedAppId, slackSpecOf } from "./slack/prove.ts";
import { loadEnvironmentSpec } from "./env/spec.ts";
import { LAUNCH_FLAGS_OFF, LAUNCH_FLAGS_ON, proveLaunch } from "./launch/prove.ts";
import { tokenFor } from "./auth/prove.ts";
import { loadContracts, type Layout } from "./topology/contract.ts";
import { loadEnvironment } from "./topology/environment.ts";
import { compile as compileTopology } from "./topology/compile.ts";
import { renderTopology } from "./topology/print.ts";
import { deepCheck, fixToV2, lintRepo } from "./topology/doctor.ts";
import { renderTree, writeTree } from "./topology/emit.ts";
import { loadDashboard } from "./nexus/contract.ts";
import { compileNexus } from "./nexus/compile.ts";
import { compileBundles, loadBundleDeclarations, writeBundleTree } from "./platform/profile-bundles.ts";
import { cmdAgent } from "./agent/command.ts";
import { proveAgentRuntime } from "./agent/prove.ts";
import { listDeclaredHarnesses } from "./harness/registry.ts";
import { cmdBackup } from "./backup/command.ts";
import { cmdPlatform } from "./backup/platform-command.ts";
import { cmdDash } from "./dash/command.ts";
import { cmdEval } from "./eval/command.ts";
import { cmdGitops } from "./gitops/command.ts";
import { cmdDev } from "./local/dev.ts";
import { cmdEnvfile } from "./env/envfile.ts";
import { cmdEnvironment } from "./env/command.ts";
import { cmdEnvNew } from "./env/new.ts";
import { cmdBundle } from "./agent-bundle/command.ts";
import { cmdLogs, cmdPrompt } from "./local/interact.ts";
import { cmdOnboard } from "./local/onboard.ts";
import { cmdDown, cmdExpose, cmdOpen, cmdReset, cmdStatus } from "./local/session.ts";
import { envTargets, soleTarget } from "./local/shared.ts";
import { cmdTest } from "./local/test.ts";
import { cmdUp } from "./local/up.ts";
import { cmdNexus } from "./nexus/command.ts";
import { cmdTopology } from "./topology/command.ts";
import { cmdValidate } from "./validate/command.ts";
import { cmdWorkspace } from "./workspace/command.ts";
import {
  compileConnections,
  compileConnectionsFromRoot,
  connectionFiles,
  loadConnectionDeclarations,
  mergeConnectionsIntoBundles,
  writeConnectionTree,
  type NormalizedConnectionBinding,
} from "./connection/compile.ts";
import { bundleCoordinatesFor } from "./topology/environment.ts";
import { connectionRows, proveConnections, renderConnectionRows, setConnectionValues } from "./connection/command.ts";
import {
  compileWorkspaceBindings,
  loadWorkspaceDeclarations,
  mergeWorkspacesIntoBundles,
  readWorkspaceProfileRecords,
  workspaceFiles,
  writeWorkspaceTree,
  type NormalizedWorkspaceBinding,
} from "./workspace/bindings.ts";
import {
  desiredWorkspaces,
  runWorkspaceTier,
  workspaceDoctor,
  workspaceList,
  workspaceVerify,
} from "./workspace/index.ts";
import {
  NEXUS_MANAGED_TREES,
  NEXUS_PLAN_PATH,
  hasDashboardFiles,
  loadAvatarInventory,
  loadFontInventory,
  loadWorkloadEndpoints,
  nexusInputsHash,
  renderNexusTree,
  selectableAvatarIds,
} from "./nexus/emit.ts";
import { proveNexus } from "./nexus/prove.ts";
import { gitopsDoctor, gitopsUpgrade } from "./gitops/index.ts";
import { cmdChatops, cmdEvent } from "./communication/index.ts";
import { cmdCommunication } from "./communication/prove.ts";
import { cmdEdge } from "./edge/index.ts";
import { driverFor, invokeAgent, showAgent, type AgentSnapshot } from "./harness/index.ts";
import { serializeRuntimeManifest } from "./harness/manifest.ts";
import { gitopsRoot, resolveRuntimeManifest } from "./harness/resolve.ts";
import { cmdServer } from "./server/bootstrap.ts";
import { discoverContractDirs, readEveProjectName } from "./topology/contract.ts";
import type { ValidationFinding } from "./platform/index.ts";
import {
  createPlatformBackup,
  proveRecovery,
  readManifest,
  restorePlatformBackup,
  uploadPlatformBackup,
  type PlatformManifest,
} from "./backup/platform.ts";
import { DEFAULT_TIMERS, installBackupTimers, newestBackup } from "./backup/timers.ts";
import { ensureGcsEmulator, fetchBackup, listBackupIds, putVerification, sinkFromUrl } from "./backup/gcs-sink.ts";
import { emitLifecycleEvent } from "./communication/lifecycle-events.ts";
import {
  backupProof,
  backupStatus,
  discoverRoutines,
  exportArtifact,
  inspectSink,
  reconcile,
  renderStatusLine,
  restoreArtifact,
  restoreShapeOf,
  restoreViaHook,
  RESTORE_HOOK_ANNOTATION,
  runRoutine,
  verifyFindings,
  type ProfileBackupStatus,
} from "./backup/routines.ts";
import {
  dashboardContentErrors,
  declaredAlerts,
  declaredDashboards,
  grafanaCredentials,
  grafanaDatasourceUids,
  grafanaImportedDashboardUids,
  grafanaImportedRules,
  reconcileDashboards,
  reconcileRules,
} from "./dash/index.ts";
import {
  appConditions,
  appStatus,
  applyApplication,
  collectLogs,
  compiledCommunication,
  effectiveAppValues,
  ensureAppProject,
  ensureArgoCd,
  ensureIdentity,
  ensureIdentityForward,
  IDENTITY_USERS,
  issuerUrl,
  ensureCluster,
  ensureEnvSecret,
  ensureEventRouter,
  producerAppValues,
  ensureGitAuthSecret,
  ensureEso,
  ensureExposures,
  appStatusOf,
  applicationOf,
  applyBundleApplication,
  applyBundleChildApps,
  retirePerProfileApplication,
  bundleApplications,
  bundleDeclarationFile,
  workspaceDeclarationFile,
  connectionDeclarationFile,
  connectionTargets,
  bundleProfileSecretRefs,
  bundleRepositories,
  ensureRepositoryAuthSecret,
  ensurePlatformExposures,
  stopServers,
  PLATFORM_EXPOSURES,
  platformCredentials,
  ensureOciRepoSecrets,
  exposeServicesOf,
  ensureFleetDashboard,
  ensureNexus,
  ensureMonitoringPair,
  ensurePlatformMirror,
  ensureServers,
  ensureTools,
  gatewayIp,
  importAgentImage,
  agentImagePresent,
  ensureEveRuntimeImage,
  patchRecordDevVersions,
  profileDeclaresApp,
  publishGitops,
  pushDevChart,
  refreshApp,
  renderRecord,
  syncProfile,
  validateProfile,
  waitFor,
} from "./platform/index.ts";
import { COMMANDS, renderCommandHelp, renderUsage } from "./commands.ts";

// ---------------------------------------------------------------------------
// onboard
// ---------------------------------------------------------------------------

/** Read a distribution.yaml's name, loudly. */
/** The platform avatar inventory's directory (#426): the installed
 * plugin's copy when present, this checkout's otherwise - the same
 * resolution features.json uses. */

/** The brand-font inventory's directory (#435, ADR-105) - same
 * resolution as the avatars. */


/** Discover the catalogue: the root itself (single profile), or every
 * distributions/<x> and .hermes-dist/<x> subdirectory carrying a
 * distribution.yaml (design 02: an application repository is a
 * catalogue). */



// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

/** Render every onboarded profile's record from the staged source tree.
 * `devVersions` (dev REPL only) re-pins oci:// apps whose chart has a
 * freshly pushed -dev.N build. */



/** The oci:// repo the catalogue's profiles declare for a chart name, or
 * null when nothing pulls it remotely. */





/** Tier backup: declared intent has a live, unsuspended routine with an
 * intact sink convention. Read-only - artifact freshness is REPORTED here
 * but only gated by `hg backup verify`, because a just-booted cluster
 * legitimately has no artifact until the first schedule or a manual run. */

/** Every dashboard the PLATFORM promises, by stable uid: the fleet
 * budget/TCO surface and the two design-15 control-plane dashboards.
 * "Provisioned automatically with a fresh installation" is proven here,
 * not asserted in prose - if a fresh `up` doesn't get all three imported
 * by Grafana, register fails. */

/** Fleet-level registration: the platform-owned dashboards (installed by
 * `up` regardless of what the profile under test declares) must be
 * importable by Grafana. Kept OUTSIDE tierRegister's per-profile
 * monitoring gate on purpose - these exist whether or not this profile
 * declares a monitoring app. */




/** `hg eval publish|results|prove` (#280): the publisher client. Split out
 * of cmdEval because none of these need a suite directory - they operate
 * on an already-produced report and a control plane. */

// ---------------------------------------------------------------------------
// topology - compile an external repository's contracts against an
// environment, WITHOUT a cluster and WITHOUT state.json (design 10,
// ADR-33). --dir names the repo (a local path, or a git URL cloned into
// HG_HOME/clones - inspection never executes anything the repo contains).

/** Resolve --dir into a local checkout; git URLs clone/update under a
 * topology-owned cache - NEVER onboard's HG_HOME/clones, whose working
 * trees back a live environment (a pull here would advance the deployed
 * profileDir under state.json's feet). */


/** The repo's HEAD sha for catalogue provenance; undefined outside git. */


// ---------------------------------------------------------------------------
// nexus - compile authored dashboard contributions against the compiled
// topology plan into the Nexus canvas plan (design 11, ADR-42). Offline
// except `prove`'s live legs, the cmdTopology pattern: --dir/--source
// names the repo, nothing it contains is ever executed. NOT `hg dash` -
// that command reconciles Grafana ConfigMaps; this one owns the Nexus
// canvas.

import type { NexusOpts } from "./nexus/command.ts";










/** Resolve --profile to catalogue members: all of them without the flag
 * (set/unset then need it only when the catalogue has several). */


// ---------------------------------------------------------------------------
// agent - the CONFIGURATION surface, as opposed to the deployment one.
//
// `hg test` proves a profile DEPLOYS. `hg prompt` proves the agent ANSWERS.
// Neither proves it is CONFIGURED, and that gap is not theoretical: a
// catalogue can ship cron declarations, have every pod green, and run
// nothing at all, because copying a file onto a PVC is not the same as
// activating it. `agent show` answers "is it configured?", `agent apply`
// runs the same activation the chart's boot script runs, and `agent exec`
// is the escape hatch for finding out what to declare in the first place.
// ---------------------------------------------------------------------------

/** Sole target for the verbs that address one pod. `envTargets` is
 * permissive by design for read verbs; a write or an exec has exactly one
 * destination, so each such verb states its own arity (as `prompt` does). */


/** `hg agent inspect`: the resolved runtime manifest, in the layout the
 * runtime contract documents. Reports the documents it was built from, so
 * a surprising line is traceable to a file rather than to this code. */

/** The Eve half of `hg agent show`. Different questions, deliberately: an
 * Eve agent has channels, subagents, schedules and tool groups where a
 * Hermes one has plugins, MCP servers and cron jobs. Printing empty Hermes
 * rows for an Eve agent would read as "nothing configured". */



/** Compile `environment/bundles.yaml` into the gitops working copy, in the
 * SAME commit as the records it reads (the compiler resolves each declared
 * profile against `profiles/<name>/profile.yaml`, so it has to run after
 * they are written and before the commit).
 *
 * Opt-in and non-fatal: bundles are the ADR-28 migration target, not the
 * default, and a repository without a declaration is the normal case. A
 * broken declaration must say so without taking `up` down - the per-profile
 * path still works. */

/** The gitops-publish hook that keeps the in-cluster Nexus off demo data.
 *
 * Nexus reads deployments/control-plane/nexus-plan.json and NOTHING else. With
 * the file absent its API 503s and the browser quietly falls back to DEMO
 * DATA - so every integration link, including the embed debug view, reads
 * "not configured" on a cluster where Grafana is running fine. That is a
 * silent failure two hops from its cause, which is why it emits here, in
 * the same commit as the records.
 *
 * Best-effort by design: a repository that authors no dashboard/ files is
 * normal, and a compile error must not take `up` down with it. */






// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  // Value-carrying flags consume their next token; boolean flags stand
  // alone; everything else is a positional arg. Derived from the command
  // manifest, so a flag missing from commands.ts fails to PARSE instead of
  // failing silently (the value landing in positionals, flagValue()
  // returning undefined - a filter that filters nothing).
  // cli/tests/main-flags.test.ts asserts every flagValue/flagInt call site
  // has its flag in the manifest.
  const VALUE_FLAGS = new Set(
    COMMANDS.flatMap((c) =>
      c.subs.flatMap((s) => (s.flags ?? []).filter((f) => f.value !== undefined).map((f) => f.name)),
    ),
  );
  const flags = new Set<string>();
  const args: string[] = [];
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    // A bare `--` ends OUR flags: everything after it belongs to the
    // command being wrapped (`agent exec -- cron list --all`), and hg
    // parsing those would leave the user debugging the wrong CLI.
    if (a === "--") {
      args.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (!VALUE_FLAGS.has(a)) {
        flags.add(a);
        continue;
      }
      // A value flag must be followed by a VALUE, never by the next flag
      // (`--tail --json` used to eat --json and silently disable JSON).
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliError(`${a} needs a value`);
      }
      values[a] = next;
      i++;
    } else {
      args.push(a);
    }
  }
  const flagValue = (name: string): string | undefined => values[name];
  const flagInt = (name: string, fallback: number): number => {
    const raw = values[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new CliError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return n;
  };
  // A --help anywhere on the line prints the command's manual and stops -
  // before the --json gate, so `hg grafana --help` needs no state.
  if (flags.has("--help")) {
    console.log(cmd ? renderCommandHelp(cmd) : renderUsage());
    return;
  }
  // --json is only meaningful where a JSON document is actually emitted;
  // enabling it elsewhere would silence narration and print nothing.
  // Derived from the manifest's `json` markers.
  const JSON_COMMANDS = new Set(COMMANDS.filter((c) => c.json).map((c) => c.name));
  const json = flags.has("--json") && JSON_COMMANDS.has(cmd ?? "");
  if (flags.has("--json") && !json) {
    throw new CliError(
      `--json is not supported by ${JSON.stringify(cmd ?? "")} ` +
        `(supported: ${[...JSON_COMMANDS].join(", ")})`,
    );
  }
  setJsonMode(json);
  fs.mkdirSync(HG_HOME, { recursive: true });
  fs.mkdirSync(STAGING, { recursive: true });
  switch (cmd) {
    case "onboard":
      cmdOnboard(args[0], flagValue("--profile"), flagValue("--env"));
      break;
    case "up":
      await cmdUp();
      break;
    case "dev": {
      // The dev-loop front door (#673): cold with a repo path, absorb
      // the onramp - onboard -> up -> dev - narrating each command.
      let devState = true;
      try {
        loadState();
      } catch {
        devState = false;
      }
      if (!devState) {
        const target = args[0];
        if (!target) {
          throw new CliError(
            "nothing onboarded yet - hand me the repo: hg dev <./path | repo-url>\n" +
              "  (runs: hg onboard <repo> && hg up && hg dev)",
          );
        }
        log(`  → hg onboard ${target}`);
        cmdOnboard(target, flagValue("--profile"), flagValue("--env"));
        log("  → hg up");
        await cmdUp();
      }
      log("  → hg dev");
      await cmdDev();
      break;
    }
    case "test":
      await cmdTest(flagValue("--tier"), json, flags.has("--allow-repo-scripts"), flagValue("--gitops"));
      break;
    case "platform":
      await cmdPlatform(json, args, flagValue("--to"), flagValue("--from"), flagInt("--timeout", 300), {
        backupSchedule: flagValue("--schedule"),
        verifySchedule: flagValue("--verify-schedule"),
        // --now, not --enable: `--enable` is a VALUE flag elsewhere in
        // this CLI (`hg nexus features --enable <id>`), so reusing it
        // here would demand a value. `--now` is what `hg reconcile
        // install` already spells this.
        enable: flags.has("--now"),
        sink: flagValue("--sink"),
      });
      break;
    case "backup":
      cmdBackup(
        json,
        args,
        flagValue("--profile"),
        flagValue("--routine"),
        flags.has("--verify"),
        flagInt("--timeout", 180),
        flagValue("--to"),
        flagValue("--from"),
        flags.has("--allow-restore-hook"),
      );
      break;
    case "dash":
      cmdDash(json, args, flagValue("--profile"), flagValue("--app"));
      break;
    case "eval":
      await cmdEval(
        json,
        args,
        flagValue("--dir"),
        flagValue("--profile"),
        flagValue("--scenario"),
        flagValue("--repeat") !== undefined ? flagInt("--repeat", 1) : undefined,
        flagValue("--timeout") !== undefined ? flagInt("--timeout", 300) : undefined,
        flags.has("--allow-repo-scripts"),
        {
          controlPlane: flagValue("--control-plane"),
          component: flagValue("--component"),
          report: flagValue("--report"),
          tokenFile: flagValue("--token-file"),
          suite: flagValue("--suite"),
          scenario: flagValue("--scenario"),
          limit: flagValue("--limit") !== undefined ? flagInt("--limit", 50) : undefined,
        },
      );
      break;
    case "gitops":
      cmdGitops(json, args);
      break;
    case "topology":
      // --source/--repo are the DevX-contract spellings of --dir/--output.
      cmdTopology(json, args, flagValue("--dir") ?? flagValue("--source"), flagValue("--environment"), flagValue("--layout"), flags.has("--deep"), flags.has("--fix"), flagValue("--output") ?? flagValue("--repo"), flagValue("--router-image"), flagValue("--observer-url"), flagValue("--argo-destinations"));
      break;
    case "nexus":
      await cmdNexus(json, args, {
        dir: flagValue("--dir") ?? flagValue("--source"),
        environment: flagValue("--environment"),
        layout: flagValue("--layout"),
        workloadEndpoints: flagValue("--workload-endpoints"),
        output: flagValue("--output") ?? flagValue("--gitops"),
        plan: flagValue("--plan"),
        controlPlane: flagValue("--control-plane"),
        enable: flagValue("--enable"),
        disable: flagValue("--disable"),
        reset: flags.has("--reset"),
      });
      break;
    case "launch": {
      const state = loadState();
      if (args[0] !== "prove") throw new CliError("usage: hermes-gitops launch prove [--json] [--browser]");
      const nexusPort = state.expose?.["nexus"]?.localPort;
      const base = `http://127.0.0.1:${nexusPort ?? 0}/api/plugins/hermes-gitops`;
      // Nexus runs on the Hermes agent image; an Eve-only loop on a
      // machine without that image has no Nexus (hg up said so). That is
      // a WARNING here: every Nexus-backed leg reads unknown, and the
      // runtime subjects still run.
      let nexusAvailable = Boolean(nexusPort);
      if (nexusAvailable) {
        try {
          await fetch(`${base}/nexus/features`, { signal: AbortSignal.timeout(5_000) });
        } catch {
          nexusAvailable = false;
        }
      }
      if (!nexusAvailable) {
        console.error(
          "  ! nexus is not reachable (not deployed - no Hermes agent image on this machine?) - " +
            "LAUNCH002..006 and the auth/grafana subjects read unknown; the runtime subjects still run",
        );
      }
      // The token comes from Dex through the identity forward. A dead
      // forward is a degraded loop, not a crashed gate: the Nexus-backed
      // legs read unknown, exactly as when Nexus itself is unreachable.
      let bearer = "";
      if (nexusAvailable) {
        try {
          bearer = await tokenFor(state, "viewer", "nexus");
        } catch (e) {
          nexusAvailable = false;
          console.error(`  ! identity is not reachable (${(e as Error).message}) - LAUNCH002..006 and the auth/grafana subjects read unknown`);
        }
      }
      const fetchJson = async (url: string, init?: RequestInit) => {
        const r = await fetch(url, {
          ...init,
          headers: { authorization: `Bearer ${bearer}`, ...(init?.headers ?? {}) },
        });
        let body: unknown = null;
        try {
          body = await r.json();
        } catch {
          body = null;
        }
        return { status: r.status, body };
      };
      // Each subject matrix runs as ITSELF. A failure here means that
      // subject failed, not that the gate has its own opinion about it.
      const subjects: Record<string, Awaited<ReturnType<typeof proveAuth>> | null> = {};
      const run = async (name: string, fn: () => Promise<any>) => {
        try {
          subjects[name] = await fn();
        } catch {
          subjects[name] = null;
        }
      };
      const fetchAnon = async (url: string, init?: RequestInit) => {
        const r = await fetch(url, init);
        let body: unknown = null;
        try {
          body = await r.json();
        } catch {
          body = null;
        }
        return { status: r.status, body };
      };
      if (nexusAvailable) {
        await run("auth", () => proveAuth(state, { nexusBaseUrl: base, fetchJson, fetchAnon }));
      } else {
        subjects["auth"] = null;
      }
      const grafanaPort = state.expose?.["grafana"]?.localPort;
      if (nexusAvailable && grafanaPort && fs.existsSync(path.join(HG_HOME, "grafana-admin-password"))) {
        await run("grafana", () =>
          proveGrafana(state, {
            bearer,
            nexusBaseUrl: base,
            grafanaBaseUrl: `http://127.0.0.1:${grafanaPort}`,
            grafanaAuth: `admin:${fs.readFileSync(path.join(HG_HOME, "grafana-admin-password"), "utf8").trim()}`,
            fetchJson: (url: string) => fetchJson(url),
          }),
        );
      } else {
        subjects["grafana"] = null;
      }
      await run("backup", async () =>
        backupProof(
          envTargets(state, undefined, "backup").map((c) => backupStatus(c, true)),
          new Date().toISOString(),
          new Date().toISOString(),
        ),
      );
      // Recovery (PLAT001-007): the launch gate must assert the fleet is
      // REBUILDABLE, not merely backed up - the distinction one rehearsal
      // already caught the hard way (#306). No scaffolded backup means
      // unknown, never a pass.
      const newestForRecovery = newestBackup(path.join(HG_HOME, "platform-backups"));
      if (newestForRecovery) {
        await run("recovery", async () => proveRecovery(envTargets(state, undefined, "platform"), newestForRecovery));
      } else {
        subjects["recovery"] = null;
      }
      // The agent-runtime subject (ADR 0177) - registered for ANY
      // non-empty fleet: each harness runs its own matrix and the results
      // merge. Absent only when nothing is onboarded ("not applicable").
      const agentCtxs = profileCtxs(state);
      if (agentCtxs.length > 0) {
        await run("agent", () => proveAgentRuntime(agentCtxs));
      }
      // The connections subject (ADR-152) - only when the environment
      // declares one, for the same reason. A fleet whose agents reach
      // Discord and GitHub through a shared registration has a gateway and
      // a projection chain in its launch configuration, and the launch gate
      // is the one place that is supposed to notice every subject.
      if (connectionDeclarationFile(state)) {
        await run("connection", () => proveConnections(state));
      }
      const proof = await proveLaunch(state, { nexusBaseUrl: base, fetchJson, subjects, nexusAvailable });
      // --browser (#307): the acceptance matrix in a real layout engine,
      // pointed at the exposed Nexus. playwright-core drives the Chrome
      // already on this machine - a dev dependency of nexus-ui/, in no
      // image; the default gate stays browser-free. Runs BEFORE the
      // proof prints, and its output goes to stderr under --json so
      // stdout stays one JSON document (Codex catch).
      let browserFailed = false;
      if (flags.has("--browser")) {
        const suite = Bun.spawnSync(["bun", "test", "browser/"], {
          cwd: path.join(PLATFORM_ROOT, "nexus-ui"),
          env: { ...process.env, NX_BROWSER: "1", NX_TARGET: `http://127.0.0.1:${nexusPort}` },
          stdout: json ? "pipe" : "inherit",
          stderr: "inherit",
        });
        if (json && suite.stdout) console.error(suite.stdout.toString());
        browserFailed = suite.exitCode !== 0;
      }
      if (json) {
        jsonOut({ ...proof, browser: flags.has("--browser") ? (browserFailed ? "fail" : "pass") : undefined });
      } else {
        for (const f of proof.findings) {
          const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
          console.log(`  ${mark} [${f.id}] ${f.component}: ${f.message}`);
        }
        console.log(`[hg] launch: ${proof.summary.pass} pass, ${proof.summary.fail} fail, ${proof.summary.unknown} unknown`);
      }
      if (browserFailed) throw new CliError("launch prove --browser: the acceptance matrix failed");
      if (!proof.ok) throw new CliError(`launch prove: ${proof.summary.fail} finding(s) failed`);
      break;
    }
    case "grafana": {
      const state = loadState();
      if (args[0] !== "prove") throw new CliError("usage: hermes-gitops grafana prove [--json]");
      const nexusPort = state.expose?.["nexus"]?.localPort;
      const grafanaPort = state.expose?.["grafana"]?.localPort;
      if (!nexusPort || !grafanaPort) throw new CliError("nexus and grafana exposures are required - run: hermes-gitops up");
      const pwFile = path.join(HG_HOME, "grafana-admin-password");
      if (!fs.existsSync(pwFile)) throw new CliError("no grafana admin password on this host");
      // Read the panel routes as a real viewer would: the routes are
      // role-gated, and a prover reading them unauthenticated would be
      // proving a surface nobody else can reach.
      const bearer = await tokenFor(state, "viewer", "nexus");
      const proof = await proveGrafana(state, {
        bearer,
        nexusBaseUrl: `http://127.0.0.1:${nexusPort}/api/plugins/hermes-gitops`,
        grafanaBaseUrl: `http://127.0.0.1:${grafanaPort}`,
        // Admin, deliberately: this proof asks whether a panel EXISTS,
        // which is a question about the dashboard, not about what any
        // particular human may see. The RBAC half is hg auth prove.
        grafanaAuth: `admin:${fs.readFileSync(pwFile, "utf8").trim()}`,
        fetchJson: async (url: string) => {
          const r = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
          let body: unknown = null;
          try {
            body = await r.json();
          } catch {
            body = null;
          }
          return { status: r.status, body };
        },
      });
      if (json) {
        jsonOut(proof);
      } else {
        for (const f of proof.findings) {
          const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
          console.log(`  ${mark} [${f.id}] ${f.component}: ${f.message}`);
        }
      }
      if (!proof.ok) throw new CliError(`grafana prove: ${proof.summary.fail} finding(s) failed`);
      break;
    }
    case "slack": {
      if (args[0] !== "prove") throw new CliError("usage: hermes-gitops slack prove <environment> [--agent <name>] [--json]");
      const envName = args[1];
      if (!envName) throw new CliError("slack prove requires the environment name (e.g. hg slack prove factory)");
      const specFile =
        flagValue("--spec") ?? path.join(PLATFORM_ROOT, "infra", "environments", `${envName}.yaml`);
      const sl = slackSpecOf(loadEnvironmentSpec(specFile));
      const proof = await proveSlack({
        spec: sl,
        agent: flagValue("--agent"),
        // Ambient kubeconfig on purpose (no dev-cluster --context pin):
        // the operator points this at whatever cluster hosts the twins.
        secretKeys: (namespace: string) => {
          const out = Bun.spawnSync([
            "kubectl", "-n", namespace, "get", "secret", `${namespace}-env`,
            "-o", "jsonpath={.data}",
          ]);
          if ((out.exitCode ?? 1) !== 0) return null;
          try {
            return Object.keys(JSON.parse(out.stdout.toString() || "{}"));
          } catch {
            return null;
          }
        },
        runSlack: (cliArgs: string[], projectDir: string) => {
          const out = Bun.spawnSync([sl.cliBin, ...cliArgs], { cwd: projectDir });
          if (out.exitCode === null) return null;
          return { code: out.exitCode, stdout: out.stdout.toString() };
        },
        postStatus: async (url: string) => {
          try {
            const r = await fetch(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(10_000) });
            return r.status;
          } catch {
            return null;
          }
        },
        appIdOf: (agent: string) => recordedAppId(agent, sl.teamId),
        projectDirOf: (agent: string) => path.join(HG_HOME, "slack-apps", agent),
      });
      if (json) {
        jsonOut(proof);
      } else {
        for (const f of proof.findings) {
          const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
          console.log(`  ${mark} [${f.id}] ${f.component}: ${f.message}`);
        }
      }
      if (!proof.ok) throw new CliError(`slack prove: ${proof.summary.fail} finding(s) failed`);
      break;
    }
    case "harness": {
      if (args[0] !== undefined && args[0] !== "list") {
        throw new CliError("usage: hermes-gitops harness list [--json]");
      }
      const rows = listDeclaredHarnesses();
      if (json) jsonOut({ command: "harness-list", harnesses: rows });
      else for (const h of rows) log(`${h.name}  ${h.status}  gateway=${h.gateway}`);
      break;
    }
    case "auth": {
      const state = loadState();
      if (args[0] !== "prove") {
        throw new CliError("usage: hermes-gitops auth prove [--control-plane <url>] [--json]");
      }
      if (!state.ports?.identity) throw new CliError("identity is not installed - run: hermes-gitops up");
      const base =
        flagValue("--control-plane") ??
        (() => {
          const p = state.expose?.["nexus"]?.localPort;
          if (!p) throw new CliError("no nexus exposure - pass --control-plane <url>");
          return `http://127.0.0.1:${p}`;
        })();
      const proof = await proveAuth(state, {
        nexusBaseUrl: `${base}/api/plugins/hermes-gitops`,
        fetchJson: async (url: string, init?: RequestInit) => {
          const r = await fetch(url, init);
          let body: unknown = null;
          try {
            body = await r.json();
          } catch {
            body = null;
          }
          return { status: r.status, body };
        },
      });
      if (json) {
        jsonOut(proof);
      } else {
        for (const f of proof.findings) {
          const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
          console.log(`  ${mark} [${f.id}] ${f.component}: ${f.message}`);
        }
      }
      if (!proof.ok) throw new CliError(`auth prove: ${proof.summary.fail} finding(s) failed`);
      break;
    }
    case "bundle":
      cmdBundle(json, args, {
        agent: flagValue("--agent"),
        agents: flagValue("--agents"),
        gitops: flagValue("--gitops"),
        dryRun: flags.has("--dry-run"),
      });
      break;
    case "identity": {
      const state = loadState();
      if (!state.ports?.identity) {
        throw new CliError("identity is not installed yet - run: hermes-gitops up");
      }
      // Re-establish the forward before reporting: it dies with every
      // pod roll, and a status command that reports a dead issuer as
      // configured is the same lie every other surface here refuses.
      ensureIdentityForward(state);
      const issuer = issuerUrl(state);
      const clients = ["nexus", "argocd", "grafana", "hermes", "hg-proof"];
      const users = IDENTITY_USERS.map((u) => `${u}@hermes.local`);
      if (json) {
        jsonOut({ command: "identity-status", ok: true, issuer, clients, users });
      } else {
        log(`issuer:  ${issuer}`);
        log(`clients: ${clients.join(", ")}`);
        log(`users:   ${users.join(", ")}`);
        log("secrets: ~/.hermes-gitops/identity-secrets.json (0600) - never printed");
      }
      break;
    }
    case "reconcile": {
      const {
        reconcileOnce, readConfig: readReconcileConfig, readLedger: readReconcileLedger,
        realDeps, withLock,
      } = await import("./reconcile/index.ts");
      const sub = args[0];
      if (sub === "install") {
        const { installReconcile, readConfig: readExisting } = await import("./reconcile/index.ts");
        const repoUrl = flagValue("--repo");
        // Re-install (a version bump through pulumi) may omit flags and
        // keep the stored config; a first install must name the repo.
        let existing: import("./reconcile/index.ts").ReconcileConfig | null = null;
        try {
          existing = readExisting();
        } catch {
          existing = null;
        }
        if (!repoUrl && !existing) {
          console.error("usage: hermes-gitops reconcile install --repo <url> [--branch main] [--interval 60] [--checks 'a,b'] [--apply <cmd>] [--version <rev>] [--now]");
          process.exit(2);
        }
        const checksFlag = flagValue("--checks");
        const cfg = {
          version: flagValue("--version") ?? existing?.version ?? "unpinned",
          repoUrl: repoUrl ?? existing!.repoUrl,
          branch: flagValue("--branch") ?? existing?.branch ?? "main",
          intervalSeconds: Number(flagValue("--interval") ?? existing?.intervalSeconds ?? 60),
          checks: checksFlag !== undefined
            ? checksFlag.split(",").map((c) => c.trim()).filter(Boolean)
            : existing?.checks ?? ["hg topology doctor --dir .", "pulumi preview --non-interactive --cwd infra"],
          apply: flagValue("--apply") ?? existing?.apply ?? "pulumi up --yes --non-interactive --cwd infra",
          hermesHome: flagValue("--harness-home") ?? existing?.hermesHome ?? path.join(os.homedir(), ".hermes"),
          argocdTimeoutSec: Number(flagValue("--timeout") ?? existing?.argocdTimeoutSec ?? 900),
          ...(flagValue("--kube-context") ?? existing?.kubeContext
            ? { kubeContext: flagValue("--kube-context") ?? existing?.kubeContext }
            : {}),
          ...(flagValue("--status-namespace") ?? existing?.statusNamespace
            ? { statusNamespace: flagValue("--status-namespace") ?? existing?.statusNamespace }
            : {}),
        };
        // --now, not --enable: --enable is a VALUE flag elsewhere
        // (nexus features --enable <id>) and the shared parser would
        // swallow the next token. Mirrors `systemctl enable --now` anyway.
        installReconcile(cfg, { enable: flags.has("--now") });
      } else if (sub === "uninstall") {
        const { uninstallReconcile } = await import("./reconcile/index.ts");
        uninstallReconcile();
      } else if (sub === "prove") {
        const { proveReconcile } = await import("./reconcile/index.ts");
        const report = proveReconcile();
        if (json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const f of report.findings) {
            console.log(`${f.status.toUpperCase().padEnd(8)} ${f.id}  ${f.component}: ${f.message}`);
          }
          console.log(`\n${report.ok ? "OK" : "FAIL"}: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.unknown} unknown`);
        }
        if (!report.ok) process.exit(1);
      } else if (sub === "run" || sub === "sync" || sub === "retry") {
        // One code path for all three: the timer's tick, the operator's
        // forced tick, and the operator's gate-clearing tick - all under
        // the same flock (sync/retry are NOT systemctl wrappers, so they
        // work on a host without systemd too).
        withLock(process.argv.slice(1));
        const cfg = readReconcileConfig();
        // Lifecycle events fire on TRANSITIONS only - a tick that stays
        // synced (or stays failed) is not news, and a reconciler that
        // pinged on every tick would teach the channel to ignore it.
        const before = readReconcileLedger(cfg).state;
        const ledger = await reconcileOnce(
          { manual: sub !== "run", retry: sub === "retry" },
          realDeps(cfg),
        );
        const bad = (s: string) => s === "failed" || s === "authentication-required";
        if (!bad(before) && bad(ledger.state)) {
          await emitLifecycleEvent({
            kind: "reconcile", phase: "failed", environment: "",
            facts: { state: ledger.state, desiredSha: (ledger.desiredSha ?? "").slice(0, 12) },
          });
        } else if (bad(before) && ledger.state === "synced") {
          await emitLifecycleEvent({
            kind: "reconcile", phase: "completed", environment: "",
            facts: { state: "recovered", appliedSha: (ledger.appliedSha ?? "").slice(0, 12) },
          });
        }
        if (json) console.log(JSON.stringify(ledger, null, 2));
        if (ledger.state === "failed" || ledger.state === "authentication-required") process.exit(1);
      } else if (sub === "status") {
        // Read-only: no lock, no mutation, safe while a run is in flight.
        const ledger = readReconcileLedger(readReconcileConfig());
        if (json) {
          console.log(JSON.stringify(ledger, null, 2));
        } else {
          console.log(`state:     ${ledger.state}`);
          console.log(`desired:   ${ledger.desiredSha ?? "-"}`);
          console.log(`attempted: ${ledger.attemptedSha ?? "-"}`);
          console.log(`applied:   ${ledger.appliedSha ?? "-"}${ledger.appliedAt ? ` at ${ledger.appliedAt}` : ""}`);
          if (ledger.blocked) {
            console.log(`blocked:   ${ledger.blocked.sha.slice(0, 12)} (${ledger.blocked.attempts} attempt${ledger.blocked.attempts === 1 ? "" : "s"}) - hg reconcile retry to override`);
          }
          const last = ledger.history[ledger.history.length - 1];
          if (last) console.log(`last run:  ${last.result} (${last.trigger}) at ${last.finishedAt}`);
        }
      } else {
        console.error("usage: hermes-gitops reconcile install|run|status|sync|retry|prove|uninstall [--json]");
        process.exit(2);
      }
      break;
    }
    case "observability": {
      const sub = args[0];
      const controlPlane = flagValue("--control-plane");
      if (sub === "inspect") {
        const { inspectObservability } = await import("./observability/index.ts");
        const doc = await inspectObservability(controlPlane);
        if (json) {
          console.log(JSON.stringify(doc, null, 2));
        } else {
          for (const w of doc.workloads) {
            console.log(
              `${w.level.padEnd(9)} ${w.status.padEnd(15)} ${w.name.padEnd(24)} ${w.versionAuthority}`,
            );
          }
          if (!controlPlane) log("no --control-plane: levels are unknown; the vocabulary is still authoritative");
        }
      } else if (sub === "prove") {
        const { proveObservability } = await import("./observability/index.ts");
        const report = await proveObservability({ controlPlane });
        if (json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const f of report.findings) {
            console.log(`${f.status.toUpperCase().padEnd(8)} ${f.id}  ${f.component}: ${f.message}`);
          }
          console.log(
            `\n${report.ok ? "OK" : "FAIL"}: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.unknown} unknown`,
          );
        }
        if (!report.ok) process.exit(1);
      } else {
        console.error("usage: hermes-gitops observability inspect|prove [--control-plane <url>] [--json]");
        process.exit(2);
      }
      break;
    }
    case "event":
      await cmdEvent(json, args, {
        dir: flagValue("--dir"),
        environment: flagValue("--environment"),
        payload: flagValue("--payload"),
        from: flagValue("--from"),
        toAgent: flagValue("--to-agent"),
        toChatops: flagValue("--to-chatops"),
        correlation: flagValue("--correlation"),
        delivery: flagValue("--delivery"),
        orderingKey: flagValue("--ordering-key"),
        count: values["--count"] !== undefined ? flagInt("--count", 3) : undefined,
        signature: flagValue("--signature"),
        duplicate: flags.has("--duplicate"),
      });
      break;
    case "chatops":
      await cmdChatops(json, args, {
        dir: flagValue("--dir"),
        environment: flagValue("--environment"),
        payload: flagValue("--payload"),
        event: flagValue("--event"),
      });
      break;
    case "discord":
      cmdDiscord(json, args, flagValue("--profile"));
      break;
    case "cron": {
      // The scheduler surface. `soleTarget` because every cron verb acts
      // on ONE profile's job registry - a fleet-wide `cron run` would be
      // a different, more dangerous verb than the one an operator is
      // asking for.
      const ctx = soleTarget(loadState(), flagValue("--profile"), "cron");
      if (ctx.runtime === "eve") {
        const sub = args[0] ?? "list";
        if (sub === "run" || sub === "enable" || sub === "disable") {
          throw new CliError(
            `cron ${sub} is a Hermes verb; ${ctx.name} runs on Eve, whose schedules are declared in ` +
              "agent/schedules/ and compiled by `eve build` - edit the declaration and redeploy " +
              "(see `hg agent prove`, leg EVE015)",
          );
        }
        // list|show|history: a read-only projection of the declared
        // schedules from the live snapshot. Runs live in the world store;
        // `hg agent prove` EVE015 proves firing.
        const snap = await showAgent(ctx);
        if (!snap.ok) throw new CliError(`cron: cannot read ${ctx.name}: ${snap.error ?? "unreachable"}`);
        const schedules = snap.schedules ?? [];
        const wanted = sub === "show" ? schedules.filter((s) => s.id === args[1]) : schedules;
        if (sub === "show" && wanted.length === 0) {
          throw new CliError(`cron show: no declared schedule ${JSON.stringify(args[1] ?? "")}`);
        }
        if (json) jsonOut({ command: `cron-${sub}`, profile: ctx.name, projected: true, schedules: wanted });
        else {
          log(`[${ctx.name}] declared agent/schedules/ (Eve - projected, read-only):`);
          for (const s of wanted) log(`  ${s.id}  ${s.cron ?? "(no cron expression)"}`);
        }
        break;
      }
      cmdCron(json, args, ctx);
      break;
    }
    case "debug":
      cmdDebugWebhook(json, args, flagInt("--tail", 20), flagValue("--planes"));
      break;
    case "communication":
      await cmdCommunication(json, args, {
        dir: flagValue("--dir"),
        environment: flagValue("--environment"),
        requireLiveChatops: flags.has("--require-live-chatops"),
        requireLiveGrafana: flags.has("--require-live-grafana"),
        toChatops: flagValue("--to-chatops"),
        since: flagValue("--since"),
        stage: flagValue("--stage"),
      });
      break;
    case "server":
      await cmdServer(args[0], json, {
        host: flagValue("--host"),
        syncRoot: flagValue("--home"),
        allowLocalState: flags.has("--allow-local-state"),
        channel: flagValue("--channel"),
        role: flagValue("--role"),
        environment: flagValue("--environment"),
        backup: flagValue("--backup"),
        sink: flagValue("--sink"),
        nuclear: flags.has("--nuclear"),
      });
      break;
    case "edge":
      await cmdEdge(json, args, {
        stack: flagValue("--stack"),
        infraDir: flagValue("--infra-dir"),
        kubeconfig: flagValue("--kubeconfig"),
        skipIdempotency: flags.has("--skip-idempotency"),
        app: flagValue("--app"),
        service: flagValue("--service"),
        hostname: flagValue("--hostname"),
        email: flagValue("--email"),
        zone: flagValue("--zone"),
        all: flags.has("--all"),
      });
      break;
    case "validate":
      cmdValidate(json, flagValue("--dir") ?? flagValue("--source"));
      break;
    case "logs":
      cmdLogs(json, flagValue("--profile"), flagValue("--app"), flagInt("--tail", 50));
      break;
    case "prompt":
      await cmdPrompt(args, json, flagValue("--profile"), flagInt("--timeout", 300));
      break;
    case "envfile":
      cmdEnvfile(args, flags.has("--restart"), flagValue("--profile"));
      break;
    case "env":
      if (args[0] === "new") {
        if (!args[1]) throw new CliError("env new requires the environment name");
        await cmdEnvNew(json, args[1], { spec: flagValue("--spec"), dryRun: flags.has("--dry-run") });
        break;
      }
      cmdEnvironment(json, args, {
        state: flagValue("--state"),
        infra: flagValue("--infra"),
        out: flagValue("--out"),
        spec: flagValue("--spec"),
      });
      break;
    case "agent":
      await cmdAgent(args, json, flagValue("--profile"), flags.has("--dry-run"), flagValue("--gitops"), flagValue("--output"), flags.has("--deep"), flags.has("--strict"));
      break;
    case "connection": {
      const state = loadState();
      const sub = args[0];
      if (sub === "list" || sub === "plan" || sub === undefined) {
        const { declaration, rows, findings } = connectionRows(state);
        if (json) {
          jsonOut({ command: `connection-${sub ?? "list"}`, declaration, ok: !findings.some((f) => f.severity === "error"), connections: rows, findings });
        } else {
          if (!declaration) log("no environment/connections.yaml in the onboarded repository");
          renderConnectionRows(rows);
          for (const f of findings) console.error(`  ${f.severity === "error" ? "✗" : "!"} [${f.profile}] ${f.check}: ${f.message}${f.fix ? `\n      fix: ${f.fix}` : ""}`);
        }
        if (findings.some((f) => f.severity === "error")) throw new CliError("connection plan: error(s)");
        break;
      }
      if (sub === "set") {
        const name = args[1];
        const pairs = args.slice(2);
        if (!name || pairs.length === 0) throw new CliError("usage: hermes-gitops connection set <connection> KEY=value...");
        const changed = setConnectionValues(state, name, pairs);
        ok(`connection ${name}: set ${changed.join(", ")} (values never print); running pods keep their old env until restart`);
        if (json) jsonOut({ command: "connection-set", connection: name, keys: changed });
        break;
      }
      if (sub === "prove") {
        const proof = await proveConnections(state);
        if (json) jsonOut(proof);
        else for (const f of proof.findings) console.log(`  ${f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?"} [${f.id}] ${f.component}: ${f.message}`);
        if (!proof.ok) throw new CliError(`connection prove: ${proof.summary.fail} finding(s) failed`);
        break;
      }
      throw new CliError("usage: hermes-gitops connection list|plan|set|prove");
    }
    case "workspace":
      await cmdWorkspace(args[0], json, {
        dir: flagValue("--dir"),
        profile: flagValue("--profile"),
        repository: flagValue("--repository"),
        scenario: flagValue("--scenario"),
        gitops: flagValue("--gitops"),
        deep: flags.has("--deep"),
        record: flags.has("--record"),
      });
      break;
    case "open":
      cmdOpen(json, flagValue("--profile"));
      break;
    case "expose":
      await cmdExpose(flags.has("--stop"));
      break;
    case "down":
      cmdDown();
      break;
    case "reset":
      await cmdReset(flags.has("--nuclear"), flags.has("--allow-repo-scripts"));
      break;
    case "status":
      cmdStatus(json);
      break;
    case "help":
      console.log(args[0] ? renderCommandHelp(args[0]) : renderUsage());
      break;
    default:
      console.log(renderUsage());
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`hermes-gitops: ${err instanceof CliError ? err.message : err}`);
  process.exit(1);
});
