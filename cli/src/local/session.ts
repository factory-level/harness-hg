// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as fs from "node:fs";
import * as path from "node:path";
import { CLUSTER_NAME, SINK_LOG, appOf, jsonOut, kubectl, loadEnvOverlay, loadState, loadTestConfig, log, nsOf, ok, pidAlive, portAccepts, profileCtxs, repoScriptsAllowed, saveState, sh } from "../lib.ts";
import { PLATFORM_EXPOSURES, appConditions, appStatus, applyApplication, ensureEnvSecret, ensureExposures, exposeServicesOf, platformCredentials, profileDeclaresApp, stopServers, waitFor } from "../platform/index.ts";
import { envTargets, grafanaApi } from "./shared.ts";

// ---------------------------------------------------------------------------
// expose - the MANUAL surface over contract-driven exposure. up/dev/reset
// start (and dev's watchdog heals) the forwards automatically from the
// profile's expose.services declarations; this command refreshes them on
// demand or tears them down (--stop). Routing is host-local, NEVER the
// tunnel - and Access/service-token enforcement is absent locally by
// design (documented divergence, design 08).
// ---------------------------------------------------------------------------

export async function cmdExpose(stop: boolean): Promise<void> {
  const state = loadState();
  // No state.ports gate: a destination server never ran `hg up`, and its
  // proofs still need the same forwards (same reasoning as cmdPlatform).

  if (stop) {
    for (const [name, entry] of Object.entries(state.expose ?? {})) {
      if (pidAlive(entry.pid)) process.kill(entry.pid!, "SIGTERM");
      log(`stopped ${name}`);
    }
    state.expose = {};
    saveState(state);
    ok("all exposures stopped (up/dev/reset re-start them from the contract)");
    return;
  }

  // No early return on "no profile declares expose.services": the
  // control-plane UIs (PLATFORM_EXPOSURES) exist as soon as the platform
  // is up, whether or not anything is onboarded.
  ensureExposures(state);
  await Bun.sleep(1200); // let fresh forwards bind before the caller curls
}

// ---------------------------------------------------------------------------
// down - the counterpart to `up` for everything that runs on the HOST: the
// git daemon, the profile-source http server, the alert sink and every
// port-forward. The cluster is deliberately untouched - `reset` is the
// command that destroys workloads, and conflating "stop my daemons" with
// "delete my agents" is not a mistake worth making available.
//
// This existed nowhere before. The host servers outlived every session,
// and the stale pids they left in state were what made a dead daemon look
// alive to the boot check - a leak that presented as a cluster-side clone
// failure an hour later.
// ---------------------------------------------------------------------------

export function cmdDown(): void {
  const state = loadState();
  for (const [name, entry] of Object.entries(state.expose ?? {})) {
    if (pidAlive(entry.pid)) {
      process.kill(entry.pid!, "SIGTERM");
      log(`stopped forward ${name}`);
    }
  }
  state.expose = {};
  stopServers(state);
  ok("host side down - the cluster is untouched (`hermes-gitops up` brings it all back)");
}

// ---------------------------------------------------------------------------
// open - "where are my agents", and "where is the control plane". Every
// profile's exposed URLs in one list (until ADR-28's profile bundles land
// each agent has its OWN console, so that means listing N of them), plus
// the control plane's own UIs WITH the credential to log into each - the
// point being that a browser is useless without one, and Grafana's lived
// only inside dash.ts where no human ever saw it.
// ---------------------------------------------------------------------------

export function cmdOpen(json: boolean, onlyProfile: string | undefined): void {
  const state = loadState();
  const ctxs = onlyProfile ? envTargets(state, onlyProfile, "open") : profileCtxs(state);
  const rows = ctxs.flatMap((ctx) =>
    exposeServicesOf(ctx.dir).map((svc) => {
      const entry = state.expose?.[`${ctx.name}:${svc.name}`];
      return {
        profile: ctx.name,
        service: svc.name,
        url: entry ? `http://127.0.0.1:${entry.localPort}${svc.path}` : null,
        live: Boolean(entry && pidAlive(entry.pid) && portAccepts(entry.localPort)),
      };
    }),
  );
  // Credentials are only read when the platform is actually up - a
  // kubectl call per `open` against a dead cluster is pure latency.
  const anyPlatformLive = PLATFORM_EXPOSURES.some((p) => {
    const e = state.expose?.[p.key];
    return Boolean(e && pidAlive(e.pid) && portAccepts(e.localPort));
  });
  const creds = anyPlatformLive ? platformCredentials() : {};
  const platform = PLATFORM_EXPOSURES.map((p) => {
    const entry = state.expose?.[p.key];
    return {
      service: p.key,
      url: entry ? `http://127.0.0.1:${entry.localPort}` : null,
      live: Boolean(entry && pidAlive(entry.pid) && portAccepts(entry.localPort)),
      credential: creds[p.key] ?? null,
    };
  });

  if (json) {
    jsonOut({ command: "open", platform, services: rows });
    return;
  }

  console.log("  control plane");
  for (const p of platform) {
    const where = p.url ?? "(not exposed yet - run: hermes-gitops up)";
    // Prometheus has no auth of its own. Say so rather than leaving a
    // blank column: locally that is convenience, but through the tunnel
    // it means Access is the ONLY gate in front of it.
    const cred = p.credential
      ? `  login ${p.credential.user} / ${p.credential.password}`
      : p.service === "prometheus"
        ? "  (no auth)"
        : "  (initial-admin Secret already deleted - password was changed)";
    console.log(`  ${p.live ? "✓" : "✗"} ${p.service.padEnd(10)} ${where}${cred}`);
  }

  if (rows.length === 0) {
    log("no profile declares expose.services - no agent consoles to open");
  } else {
    console.log("  agents");
    for (const r of rows) {
      const where = r.url ?? "(not exposed yet - run: hermes-gitops up)";
      console.log(`  ${r.live ? "✓" : "✗"} ${r.profile}:${r.service}  ${where}`);
    }
  }
  if ([...platform, ...rows].some((r) => !r.live)) {
    log("dead/absent forwards are respawned by `hermes-gitops expose` (or up/dev/reset)");
  }

  // "Can Nexus frame Grafana?" is answered by the Nexus plugin itself, at
  // #/embed-debug behind the embed-debug flag (ADR-44) - NOT by a page the
  // CLI serves. A page on the loop's http.server carries a different
  // origin, session and response headers than the dashboard, so it can
  // tell you Grafana is willing to be framed and nothing about whether
  // Nexus could do it. Point at the real thing instead of a lookalike.
  if (platform.some((p) => p.service === "grafana" && p.live)) {
    console.log("  embed debug  <dashboard>/#/embed-debug   (hg nexus features --enable embed-debug)");
  }
}

// ---------------------------------------------------------------------------
// reset - generic prune (owns the preserve contract) → declarative block
// → imperative hook (trust-gated). Augment, never replace (spec §27).
// ---------------------------------------------------------------------------

export async function cmdReset(nuclear: boolean, allowRepoScripts: boolean): Promise<void> {
  const state = loadState();
  if (nuclear) {
    log(`nuclear reset: deleting cluster ${CLUSTER_NAME}...`);
    sh(["k3d", "cluster", "delete", CLUSTER_NAME], { allowFail: true });
    // The host servers exist only to serve THAT cluster, and the forwards
    // point into it. Leaving them running left orphaned daemons plus stale
    // pids in state, which is precisely what made the next `up` believe a
    // dead git daemon was alive.
    for (const [name, entry] of Object.entries(state.expose ?? {})) {
      if (pidAlive(entry.pid)) {
        process.kill(entry.pid!, "SIGTERM");
        log(`stopped forward ${name}`);
      }
    }
    state.expose = {};
    stopServers(state);
    ok("cluster deleted and host side down - `hermes-gitops up` rebuilds from scratch");
    return;
  }
  for (const ctx of profileCtxs(state)) {
    const testCfg = loadTestConfig(ctx.dir);
    const ns = nsOf(ctx.name);

    // 1. Generic prune - and the CLI, not the profile, honors the preserve
    // contract: label-preserved (plus reset.preserve-named) Secrets are
    // snapshotted and restored after the wipe.
    log(`[${ctx.name}] scoped reset: generic prune (honoring hermes.dev/preserve=true)...`);
    const preservedYaml = kubectl(
      ["-n", ns, "get", "secrets", "-l", "hermes.dev/preserve=true", "-o", "yaml"],
      { allowFail: true, quiet: true },
    );
    const extraPreserved = testCfg.reset.preserve
      .map((name) =>
        kubectl(["-n", ns, "get", "secret", name, "-o", "yaml"], { allowFail: true, quiet: true }),
      )
      .filter((y) => y.trim());
    kubectl(["-n", "argocd", "delete", "application", appOf(ctx.name), "--wait=true"], {
      allowFail: true,
    });
    kubectl(["delete", "namespace", ns, "--wait=true"], { allowFail: true });
    ok(`[${ctx.name}] Application + namespace pruned`);

    // 2. Declarative profile-owned reset (data, not code - always safe).
    for (const pvc of testCfg.reset.delete_pvcs) {
      kubectl(["delete", "pvc", pvc, "-n", ns, "--ignore-not-found"], { allowFail: true });
    }
    for (const wipeNs of testCfg.reset.wipe_namespaces) {
      kubectl(["delete", "namespace", wipeNs, "--ignore-not-found", "--wait=true"], {
        allowFail: true,
      });
    }
    if (testCfg.reset.delete_pvcs.length || testCfg.reset.wipe_namespaces.length) {
      ok(`[${ctx.name}] declarative reset: block applied`);
    }

    // 3. Imperative hook - arbitrary repo code; trust-gated.
    const script = testCfg.reset.script ?? "hermes-gitops.reset.sh";
    const scriptPath = path.join(ctx.dir, script);
    if (fs.existsSync(scriptPath)) {
      if (repoScriptsAllowed(state, allowRepoScripts)) {
        log(`[${ctx.name}] running profile reset hook: ${script}`);
        sh(["bash", scriptPath], { cwd: ctx.dir });
        ok(`[${ctx.name}] reset hook completed`);
      } else {
        console.error(
          `  ! skipped ${script}: this profile was onboarded from a URL and repo ` +
            "scripts are untrusted - re-run with --allow-repo-scripts to consent",
        );
      }
    }

    // Re-sync clean: restore preserved secrets, re-apply the Application.
    kubectl(["create", "namespace", ns], { allowFail: true, quiet: true });
    for (const doc of [preservedYaml, ...extraPreserved]) {
      if (!doc.trim() || doc.includes("items: []")) continue;
      kubectl(["apply", "-f", "-"], { input: doc, allowFail: true, quiet: true });
    }
    ensureEnvSecret(state, ctx, testCfg);
    applyApplication(state, ctx);
  }
  for (const ctx of profileCtxs(state)) {
    await waitFor(`${appOf(ctx.name)} Synced+Healthy after reset`, 900, () => {
      const { sync, health } = appStatus(ctx.name);
      return sync === "Synced" && health === "Healthy";
    });
  }
  // The prune recreated the pods - re-ensure the declared exposures.
  ensureExposures(state);
  ok("reset complete: apps re-synced clean, platform stayed warm");
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function cmdStatus(json: boolean): void {
  const state = loadState();
  const ctxs = profileCtxs(state);
  if (json) {
    jsonOut({
      command: "status",
      root: state.profileDir,
      envFile: state.envFile ?? null,
      profiles: ctxs.map((ctx) => {
        const { sync, health } = appStatus(ctx.name);
        return {
          name: ctx.name,
          subdir: ctx.subdir,
          dir: ctx.dir,
          sync,
          health,
          conditions: appConditions(ctx.name),
          exposures: Object.entries(state.expose ?? {})
            .filter(([key]) => key.startsWith(`${ctx.name}:`))
            .map(([key, entry]) => ({
              service: key.split(":")[1],
              url: `http://127.0.0.1:${entry.localPort}/`,
              live: pidAlive(entry.pid),
            })),
          envNames: Object.keys({
            ...loadTestConfig(ctx.dir).secrets,
            ...loadEnvOverlay(state, ctx),
          }),
        };
      }),
    });
    return;
  }
  log(`${ctxs.length} profile(s) from ${state.profileDir}`);
  for (const ctx of ctxs) {
    const { sync, health } = appStatus(ctx.name);
    log(`[${ctx.name}] application ${appOf(ctx.name)}: sync=${sync || "<absent>"} health=${health || "<absent>"}`);
    const ns = nsOf(ctx.name);
    const pods = kubectl(["-n", ns, "get", "pods", "--no-headers"], {
      allowFail: true,
      quiet: true,
    }).trim();
    log(pods ? `  pods in ${ns}:\n${pods.replace(/^/gm, "    ")}` : `  no pods in ${ns}`);
    for (const [key, entry] of Object.entries(state.expose ?? {})) {
      if (!key.startsWith(`${ctx.name}:`)) continue;
      const alive = pidAlive(entry.pid) && portAccepts(entry.localPort);
      log(`  expose ${key.split(":")[1]}: http://127.0.0.1:${entry.localPort}/ ${alive ? "(live)" : "(dead - up/dev/expose respawns)"}`);
    }
    if (profileDeclaresApp(ctx.dir, "monitoring")) {
      const rules = grafanaApi("/api/v1/provisioning/alert-rules");
      let count = 0;
      try {
        count = (JSON.parse(rules) as { title?: string }[]).filter((r) =>
          (r.title ?? "").includes(`(${ctx.name})`),
        ).length;
      } catch {
        /* grafana not up */
      }
      log(`  grafana: ${count} alert rule(s) registered for ${ctx.name}`);
    }
  }
  if (fs.existsSync(SINK_LOG)) {
    const lines = fs.readFileSync(SINK_LOG, "utf8").trim().split("\n").filter(Boolean);
    log(`alert sink: ${lines.length} notification(s) received (${SINK_LOG})`);
  }
}
