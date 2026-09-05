// Extracted from main.ts (final-pass #657): see the subject directory contract.
import { appOf, bundleAppOf, loadEnvOverlay, loadState, nsOf, loadTestConfig, log, ok, profileCtxs, saveState } from "../lib.ts";
import { appStatus, appStatusOf, applyApplication, applyBundleApplication, applyBundleChildApps, bundleApplications, bundleProfileSecretRefs, bundleRepositories, ensureAppProject, ensureArgoCd, ensureCluster, ensureEnvSecret, ensureEso, ensureEveRuntimeImage, ensureEventRouter, ensureExposures, ensureFleetDashboard, ensureGitAuthSecret, ensureIdentity, ensureMonitoringPair, ensureNexus, ensureOciRepoSecrets, ensurePlatformExposures, ensurePlatformMirror, ensureRepositoryAuthSecret, ensureServers, profileRepositories, ensureTools, gatewayIp, importAgentImage, publishGitops, retirePerProfileApplication, syncProfile, waitFor, ensureLoki, ensureWiki } from "../platform/index.ts";
import { chartsWantedBy, ensureRegistry, publishPersonaCharts, redirectOciRepos } from "../platform/registry.ts";
import { emitNexusInto, renderAllRecords } from "./shared.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export async function cmdUp(): Promise<void> {
  const state = loadState();
  ensureTools();
  ensureCluster();
  state.gatewayIp = gatewayIp();
  saveState(state);
  ensureServers(state);
  ensurePlatformMirror(state);

  const { sha } = syncProfile(state);
  const rendered = renderAllRecords(state, sha);
  // Persona app charts are private OCI artifacts (ADR-31). Nothing on
  // this loop can pull them - Argo CD gets a 403 and the Application
  // sits `Unknown / Healthy`, which is to say the app never deployed
  // while looking fine (#302). So the loop serves its own registry and
  // redirects the records IT applies; the emitted record and the
  // persona repository keep the real one.
  ensureRegistry(state);
  const wanted = chartsWantedBy(rendered.map((r) => r.yaml), (y) => parseYaml(y));
  if (wanted.size > 0) {
    publishPersonaCharts(state, state.profileDir, wanted);
  }
  const records = rendered.map((r) => ({
    ...r,
    yaml: redirectOciRepos(r.yaml, state, (y) => parseYaml(y), (o) => stringifyYaml(o)),
  }));
  publishGitops(state, records.map((r) => ({ name: r.ctx.name, yaml: r.yaml })), emitNexusInto(state));
  ok(`${records.length} record(s) rendered + published (source @ ${sha.slice(0, 12)})`);

  // Identity FIRST: Argo CD and Grafana bake the issuer and their client
  // secrets into their own config, so an issuer that arrives after them
  // reaches neither until something forces a re-install.
  ensureIdentity(state);
  ensureArgoCd(state);
  ensureEso();
  ensureMonitoringPair(state);
  ensureFleetDashboard(state);
  ensureLoki();
  ensureWiki();
  ensureEventRouter(state);
  // The legacy Hermes agent image is needed only when a Hermes agent is
  // onboarded; Nexus runs on its own image now (#845), built by
  // ensureNexus, so an Eve-only catalogue needs no fork checkout at all.
  const ctxsForUp = profileCtxs(state);
  if (ctxsForUp.some((c) => c.runtime !== "eve")) importAgentImage();
  // The Eve runtime image (ADR-149) only when the catalogue has an Eve
  // agent - a Hermes-only loop builds nothing extra.
  if (ctxsForUp.some((c) => c.runtime === "eve")) ensureEveRuntimeImage();
  // Before ensureNexus, not after: the chart bakes browser-reachable Argo
  // CD and Grafana URLs into its config, and those URLs are these forwards.
  ensurePlatformExposures(state);
  // Identity BEFORE nexus: the nexus chart bakes the issuer and its
  // client secret into its config, and both come from here. The four
  // services' redirect URIs are the exposures just established, which is
  // why this cannot move earlier either.
  // Re-run now that the exposures exist: the browser redirect URIs are
  // those forwards, and on a cold cluster they did not exist yet.
  ensureIdentity(state);
  ensureNexus(state);
  for (const { ctx, yaml } of records) {
    ensureEnvSecret(state, ctx, loadTestConfig(ctx.dir));
    ensureGitAuthSecret(ctx, yaml);
    ensureOciRepoSecrets(yaml);
  }
  ensureAppProject(state, records.map((r) => r.yaml));
  // Derived from what actually COMPILED, never from the declaration. A
  // declaration that fails to compile must not make its profiles vanish:
  // skipping on intent alone left two personas deployed nowhere, with the
  // only clue a warning several screens earlier.
  const bundles = bundleApplications(state);
  const bundled = new Set(bundles.flatMap((b) => b.profiles));
  const gitTokenOf = (name: string): string | undefined => {
    const rec = records.find((r) => r.ctx.name === name);
    return rec ? loadEnvOverlay(state, rec.ctx)["GIT_TOKEN"] || undefined : undefined;
  };
  // The credential copy ADR-28 names as the cutover prerequisite. Without
  // it the bundle pod sits in Init forever on FailedMount, with the missing
  // Secret named only in `describe pod` - the per-profile Secrets exist,
  // just in the namespace the profile no longer runs in.
  for (const b of bundles) {
    for (const profileName of b.profiles) {
      const rec = records.find((r) => r.ctx.name === profileName);
      if (!rec) continue;
      const declared = bundleProfileSecretRefs(state, b.name, profileName);
      if (declared.envSecretRef) {
        ensureEnvSecret(state, rec.ctx, loadTestConfig(rec.ctx.dir), {
          namespace: b.namespace,
          name: declared.envSecretRef,
        });
      }
      if (declared.gitAuthSecretRef) {
        ensureGitAuthSecret(rec.ctx, rec.yaml, {
          namespace: b.namespace,
          name: declared.gitAuthSecretRef,
        });
      }
    }
    // The bundle's REPOSITORY credentials, which nothing created until
    // now. Found by the destructive rehearsal: after a nuclear rebuild
    // the bundle pod sat in Init:0/1 for fifteen minutes waiting on
    // `hermes-vision-manager-git`, a Secret that had only ever existed
    // because an operator ran `kubectl create secret` by hand in #278.
    //
    // A credential created by hand is not declared state, so a fleet
    // that depends on one is not rebuildable - which is the exact claim
    // design 13's recovery gate exists to test, and the first honest run
    // of that gate found it. The placeholder does not make a private
    // clone work; it makes the failure ARRIVE, loudly, at apply time
    // rather than as a pod that hangs forever with a mount error nobody
    // is watching.
    const token = b.profiles.map((n) => gitTokenOf(n)).find(Boolean);
    for (const repo of bundleRepositories(state, b.name)) {
      if (!repo.gitAuthSecretRef) continue;
      ensureRepositoryAuthSecret(b.namespace, repo.gitAuthSecretRef, repo, token);
    }
  }
  const standalone = records.filter((r) => !bundled.has(r.ctx.name));
  for (const { ctx } of records) {
    if (bundled.has(ctx.name)) {
      // Not merely skipped - REMOVED. Skipping alone leaves the previous
      // per-profile Application running, so the persona exists twice: once
      // in its own namespace and once in the bundle, two agents on one
      // identity. The credential copy above is ADR-28's stated precondition
      // for this, and it has just run.
      retirePerProfileApplication(ctx);
      continue;
    }
    // A standalone profile with a workspace binding mounts the same
    // credential Secret a bundle member does; without it the pod sits in
    // Init:0/1 on a mount error forever (found live: marketing-engagement).
    for (const repo of profileRepositories(ctx.name)) {
      if (!repo.gitAuthSecretRef) continue;
      ensureRepositoryAuthSecret(nsOf(ctx.name), repo.gitAuthSecretRef, repo, gitTokenOf(ctx.name));
    }
    applyApplication(state, ctx);
  }
  for (const b of bundles) {
    applyBundleApplication(state, b);
    // The members' own apps, which the bundle chart does not deploy (#301).
    applyBundleChildApps(state, b);
  }

  log(`waiting for ${standalone.length + bundles.length} Application(s) to converge...`);
  for (const b of bundles) {
    const app = bundleAppOf(b.name, b.chart === "eve-bundle" ? "eve" : "hermes");
    await waitFor(`${app} Synced+Healthy`, 900, () => {
      const { sync, health } = appStatusOf(app);
      return sync === "Synced" && health === "Healthy";
    });
    ok(`Application ${app} is Synced+Healthy`);
  }
  for (const { ctx } of standalone) {
    await waitFor(`${appOf(ctx.name)} Synced+Healthy`, 900, () => {
      const { sync, health } = appStatus(ctx.name);
      return sync === "Synced" && health === "Healthy";
    });
    ok(`Application ${appOf(ctx.name)} is Synced+Healthy`);
  }
  // Contract-driven exposure: every declared expose.services entry gets
  // its stable local URL as part of "up" - no separate command.
  ensureExposures(state);
  log("platform is up. next: hermes-gitops test (or hermes-gitops dev)");
}
