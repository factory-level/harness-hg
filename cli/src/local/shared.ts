// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as fs from "node:fs";
import { readAgentDeclaration } from "../layout.ts";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { NormalizedConnectionBinding, compileConnections, connectionFiles, loadConnectionDeclarations, mergeConnectionsIntoBundles, writeConnectionTree } from "../connection/compile.ts";
import { grafanaCredentials } from "../dash/index.ts";
import { AgentRuntime, CliError, HG_HOME, HgState, PLATFORM_ROOT, ProfileCtx, appOf, deepMerge, kubectl, loadTestConfig, log, nsOf, ok, profileCtxs, sh } from "../lib.ts";
import { compileNexus } from "../nexus/compile.ts";
import { loadDashboard } from "../nexus/contract.ts";
import { NEXUS_MANAGED_TREES, hasDashboardFiles, loadAvatarInventory, loadFontInventory, nexusInputsHash, renderNexusTree, selectableAvatarIds } from "../nexus/emit.ts";
import { ValidationFinding, bundleDeclarationFile, compiledCommunication, connectionDeclarationFile, connectionTargets, effectiveAppValues, ensureEnvSecret, patchRecordDevVersions, producerAppValues, profileDeclaresApp, renderRecord, workspaceDeclarationFile } from "../platform/index.ts";
import { compileBundles, loadBundleDeclarations, writeBundleTree } from "../platform/profile-bundles.ts";
import { compile as compileTopology } from "../topology/compile.ts";
import { discoverContractDirs, loadContracts, readEveProjectName } from "../topology/contract.ts";
import { writeTree } from "../topology/emit.ts";
import { bundleCoordinatesFor, loadEnvironment } from "../topology/environment.ts";
import { NormalizedWorkspaceBinding, compileWorkspaceBindings, loadWorkspaceDeclarations, mergeWorkspacesIntoBundles, readWorkspaceProfileRecords, workspaceFiles, writeWorkspaceTree } from "../workspace/bindings.ts";
import { parse as parseYaml } from "yaml";

// The platform inventories live under control-plane/nexus since the #732
// flip retired dashboard/. The fallback still named the retired tree, so
// on any host without an installed plugin copy the inventory read as
// EMPTY: `hg nexus emit` then flagged every declared avatar (NEXUS013) and
// pruned every avatar and font from the GitOps tree (found in the
// 2026-09-03 re-emit).
export function platformAvatarsDir(): string {
  const installed = path.join(os.homedir(), ".hermes", "plugins", "hermes-gitops", "dashboard", "avatars");
  return fs.existsSync(installed) ? installed : path.join(PLATFORM_ROOT, "control-plane", "nexus", "avatars");
}

export function platformFontsDir(): string {
  const installed = path.join(os.homedir(), ".hermes", "plugins", "hermes-gitops", "dashboard", "fonts");
  return fs.existsSync(installed) ? installed : path.join(PLATFORM_ROOT, "control-plane", "nexus", "fonts");
}

export function distributionName(dir: string): string {
  const manifest = path.join(dir, "distribution.yaml");
  const doc = parseYaml(fs.readFileSync(manifest, "utf8")) as { name?: string };
  if (!doc?.name) throw new CliError(`${manifest} has no name:`);
  return doc.name;
}

export function discoverProfiles(root: string): { name: string; subdir: string; runtime: AgentRuntime }[] {
  // One discovery for the whole CLI (the topology compiler's): Hermes
  // distributions AND agents/<name>/ Eve projects (ADR-149). The identity
  // comes from each runtime's own manifest.
  let dirs: ReturnType<typeof discoverContractDirs>;
  try {
    dirs = discoverContractDirs(root);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  return dirs.map(({ dir, subdir, runtime }) => ({
    name: runtime === "eve" ? readEveProjectNameOrThrow(dir) : distributionName(dir),
    subdir,
    runtime,
  }));
}

export function readEveProjectNameOrThrow(dir: string): string {
  try {
    return readEveProjectName(dir);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
}

export function renderAllRecords(
  state: HgState,
  sha: string,
  devVersions: Record<string, string> = {},
): { ctx: ProfileCtx; yaml: string }[] {
  // Communication-plane producer URLs (ADR-39): the compiled ingest URL
  // overrides the sink auto-default but stays UNDER the profile's own
  // test-config overrides - the operator always wins.
  const compiled = compiledCommunication(state);
  return profileCtxs(state).map((ctx) => {
    const testCfg = loadTestConfig(ctx.dir);
    const appValues = deepMerge(
      deepMerge(
        effectiveAppValues(state, { ...testCfg, appValues: {} }, profileDeclaresApp(ctx.dir, "monitoring")),
        producerAppValues(compiled, ctx.name),
      ),
      testCfg.appValues,
    );
    const yaml = patchRecordDevVersions(
      renderRecord(state, ctx, sha, appValues),
      devVersions,
    );
    return { ctx, yaml };
  });
}

export function ociRepoForChart(state: HgState, chartName: string): string | null {
  for (const ctx of profileCtxs(state)) {
    const ext = readAgentDeclaration(ctx.dir).raw as {
      apps?: { chart?: string; repo?: string }[];
    };
    const hit = ext?.apps?.find(
      (a) => a?.chart === chartName && a?.repo?.startsWith("oci://"),
    );
    if (hit?.repo) return hit.repo;
  }
  return null;
}

// ---------------------------------------------------------------------------
// test tiers
// ---------------------------------------------------------------------------

export function grafanaApi(apiPath: string): string {
  // The SAME Secret-read credentials dash.ts uses (#130 removed the
  // committed literal; this call-site had kept it). The stale literal was
  // worse than a failed check: five 401s trip Grafana's brute-force
  // lockout, which then 401s the CORRECT password everywhere else.
  const { user, password } = grafanaCredentials();
  return kubectl(
    [
      "-n", "hermes-monitoring", "exec", "deploy/monitoring-grafana", "-c", "grafana", "--",
      "sh", "-c", `wget -qO- 'http://${user}:${password}@127.0.0.1:3000${apiPath}'`,
    ],
    { allowFail: true, quiet: true },
  );
}

export function topologyRoot(dir: string): string {
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(dir)) {
    // Key by basename + URL hash: two remotes sharing a basename must
    // not reuse each other's checkout.
    const urlHash = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8);
    const cloneName = `${path.basename(dir).replace(/\.git$/, "")}-${urlHash}`;
    const dest = path.join(HG_HOME, "topology-clones", cloneName);
    if (fs.existsSync(dest)) {
      sh(["git", "-C", dest, "pull", "--ff-only"], { allowFail: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      sh(["git", "clone", dir, dest]);
    }
    return dest;
  }
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) throw new CliError(`topology: no such directory ${resolved}`);
  return resolved;
}

export function printFindings(findings: ValidationFinding[]): void {
  for (const f of findings) {
    const mark = f.severity === "error" ? "  ✗" : "  !";
    console.log(`${mark} [${f.profile}] ${f.check}: ${f.message}`);
    if (f.file) console.log(`      file: ${f.file}`);
    if (f.fix) console.log(`      fix:  ${f.fix}`);
  }
}

export function gitHeadOf(root: string): string | undefined {
  const r = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]);
  if (r.exitCode !== 0) return undefined;
  const sha = r.stdout.toString().trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

// ---------------------------------------------------------------------------
// env - the local mirror of the bootstrap's agentSecrets channel: an
// UNCOMMITTED dotenv overlay merged over hermes-gitops.test.yaml's
// committed dev defaults. Defaults to <profileDir>/.env when present;
// `env use <path>` pins any other file. Values never print.
// ---------------------------------------------------------------------------

export function reapplyEnv(state: HgState, ctxs: ProfileCtx[], restart: boolean): void {
  if (!state.ports) {
    log("platform not up yet - values apply on the next `hermes-gitops up`");
    return;
  }
  for (const ctx of ctxs) {
    ensureEnvSecret(state, ctx, loadTestConfig(ctx.dir));
    if (restart) {
      kubectl(
        ["-n", nsOf(ctx.name), "rollout", "restart", `statefulset/${appOf(ctx.name)}`],
        { allowFail: true },
      );
      ok(`${ctx.name}: agent pod restarting with the new env`);
    }
  }
  if (!restart) {
    log("note: running pods keep their old env until restart (--restart, or hermes-gitops reset)");
  }
}

export function envTargets(state: HgState, onlyProfile: string | undefined, verb: string): ProfileCtx[] {
  const ctxs = profileCtxs(state);
  if (!onlyProfile) {
    if (ctxs.length > 1 && (verb === "set" || verb === "unset")) {
      throw new CliError(
        `this catalogue has ${ctxs.length} profiles - name one: ` +
          `hermes-gitops env ${verb} ... --profile <${ctxs.map((c) => c.name).join("|")}>`,
      );
    }
    return ctxs;
  }
  const hit = ctxs.filter(
    (c) => c.name === onlyProfile || path.basename(c.subdir) === onlyProfile,
  );
  if (hit.length === 0) {
    throw new CliError(
      `--profile ${JSON.stringify(onlyProfile)} matches nothing ` +
        `(known: ${ctxs.map((c) => c.name).join(", ")})`,
    );
  }
  return hit;
}

export function soleTarget(state: HgState, onlyProfile: string | undefined, verb: string): ProfileCtx {
  const ctxs = envTargets(state, onlyProfile, verb);
  if (ctxs.length > 1) {
    throw new CliError(
      `this catalogue has ${ctxs.length} profiles - name one: ` +
        `hermes-gitops agent ${verb} --profile <${ctxs.map((c) => c.name).join("|")}>`,
    );
  }
  return ctxs[0]!;
}

export function compileBundlesInto(state: HgState, work: string): void {
  // Workspace bindings first (issue #361): they emit their own normalized
  // records AND fold into the bundle declarations below, so the existing
  // bundle compiler and chart deliver the per-profile mounts. Same
  // non-fatal envelope as bundles - `validate`/`workspace plan` are the
  // fatal gates, `up` must keep working profiles deployable.
  // Bundle placement is read FIRST (non-fatally): bindings to bundled
  // profiles travel through the bundle values, everyone else gets a
  // per-profile chart values file under deployments/workspaces/profiles/.
  const declaration = bundleDeclarationFile(state);
  let bundleDeclarations: ReturnType<typeof loadBundleDeclarations> | null = null;
  if (declaration) {
    try {
      bundleDeclarations = loadBundleDeclarations(declaration);
    } catch {
      // Reported by the bundle compile below - one message, not two.
    }
  }
  const bundledProfiles = new Set(
    (bundleDeclarations?.bundles ?? []).flatMap((bundle) => bundle.profiles.map((profile) => profile.name)),
  );

  let bindings: NormalizedWorkspaceBinding[] = [];
  const workspaceDeclaration = workspaceDeclarationFile(state);
  if (workspaceDeclaration) {
    try {
      const declarations = loadWorkspaceDeclarations(workspaceDeclaration);
      const result = compileWorkspaceBindings(declarations, readWorkspaceProfileRecords(work), {
        requireResolution: true,
      });
      const errors = result.findings.filter((finding) => finding.severity === "error");
      if (errors.length > 0) throw new Error(errors.map((finding) => finding.message).join("; "));
      bindings = result.bindings;
      writeWorkspaceTree(work, workspaceFiles(bindings, bundledProfiles), false);
      ok(`${bindings.length} workspace binding(s) compiled from ${path.basename(workspaceDeclaration)}`);
    } catch (err) {
      bindings = [];
      // Fail closed: prune the previously generated records too, so a
      // broken declaration cannot leave yesterday's access grants
      // sitting in the tree looking current.
      writeWorkspaceTree(work, new Map(), false);
      log(`! workspaces NOT compiled (${err instanceof Error ? err.message : String(err)}) - ` +
        "no profile receives a workspace mount from this pass");
    }
  } else {
    writeWorkspaceTree(work, new Map(), false); // prune stale generated records
  }

  // Connections (ADR-152): same envelope as workspaces - opt-in, fail
  // closed (a stale projection is a stale credential grant), folded into
  // the bundle declarations for bundled members.
  let connectionBindings: NormalizedConnectionBinding[] = [];
  const connectionDeclaration = connectionDeclarationFile(state);
  if (connectionDeclaration) {
    try {
      const declarations = loadConnectionDeclarations(connectionDeclaration);
      const bundledTargets = new Map<string, { namespace: string; service: string; port: number }>();
      for (const [name, p] of Object.entries(loadEnvironment(state.profileDir).environment.bundledProfiles ?? {})) {
        const ctx = profileCtxs(state).find((c) => c.name === name);
        const coords = bundleCoordinatesFor(p, ctx?.runtime === "eve" ? "eve" : "hermes");
        bundledTargets.set(name, { ...coords, port: p.apiServerPort ?? (ctx?.runtime === "eve" ? 3000 + p.memberIndex : 8644) });
      }
      const result = compileConnections(declarations, connectionTargets(profileCtxs(state), bundledTargets));
      const errors = result.findings.filter((f) => f.severity === "error");
      if (errors.length > 0) throw new Error(errors.map((f) => f.message).join("; "));
      connectionBindings = result.bindings;
      writeConnectionTree(work, connectionFiles(connectionBindings, bundledProfiles), false);
      ok(`${connectionBindings.length} connection binding(s) compiled from ${path.basename(connectionDeclaration)}`);
    } catch (err) {
      connectionBindings = [];
      writeConnectionTree(work, new Map(), false);
      log(`! connections NOT compiled (${err instanceof Error ? err.message : String(err)}) - ` +
        "no profile receives a connection from this pass");
    }
  } else {
    writeConnectionTree(work, new Map(), false);
  }

  if (!declaration) {
    // No declaration = no bundles. Prune what an EARLIER onboarding
    // compiled (the workspaces branch does the same): found live when a
    // repository onboarded after a bundled one kept deploying into the
    // retired bundle - `up` derives membership from this tree, so a stale
    // record is a stale deployment.
    writeBundleTree(work, { bundles: [], files: new Map() }, false);
    return;
  }
  try {
    let declarations = bundleDeclarations ?? loadBundleDeclarations(declaration);
    if (bindings.length > 0) declarations = mergeWorkspacesIntoBundles(declarations, bindings);
    if (connectionBindings.length > 0) declarations = mergeConnectionsIntoBundles(declarations, connectionBindings);
    const compiled = compileBundles(work, declarations);
    writeBundleTree(work, compiled, false);
    ok(`${compiled.bundles.length} bundle(s) compiled from ${path.basename(declaration)}`);
  } catch (err) {
    log(`! bundles NOT compiled (${err instanceof Error ? err.message : String(err)}) - ` +
      "the per-profile path is unaffected");
  }
}

export function emitNexusInto(state: HgState): (work: string) => void {
  return (work) => {
    compileBundlesInto(state, work);
    if (!hasDashboardFiles(state.profileDir)) return;
    try {
      emitNexusTree(state.profileDir, work);
      ok("nexus plan emitted into the gitops repo");
    } catch (err) {
      log(
        `! nexus plan NOT emitted (${err instanceof Error ? err.message : String(err)}) - ` +
          "the in-cluster Nexus will serve demo data; fix with `hg nexus emit`",
      );
    }
  };
}

/** Compile the onboarded repository's dashboard contributions and write
 * the Nexus tree into a GitOps working copy. Shared by `hg nexus emit` and
 * by `up`, because the in-cluster Nexus reads exactly one artifact -
 * deployments/control-plane/nexus-plan.json - and without it the API 503s, the
 * browser silently falls back to DEMO DATA, and every integration link
 * (including the embed debug view) reports "not configured" on a cluster
 * where Grafana is running fine. Returns the written paths.
 *
 * Throws on compile findings; callers decide whether that is fatal. */
export function emitNexusTree(root: string, gitopsDir: string): { written: string[]; deleted: string[] } {
  const env = loadEnvironment(root);
  const loaded = loadContracts(root);
  const topology = compileTopology(loaded.contracts, env.environment, {
    priorFindings: [...loaded.findings, ...env.findings],
  });
  const avatarInventory = loadAvatarInventory(platformAvatarsDir());
  const fontInventory = loadFontInventory(platformFontsDir());
  const result = compileNexus({
    ...loadDashboard(root),
    findings: [...loadDashboard(root).findings, ...topology.findings],
    topology,
    bundledProfiles: env.environment.bundledProfiles,
    workloadEndpoints: undefined,
    sourceSha: gitHeadOf(root) ?? "0".repeat(40),
    avatarIds: selectableAvatarIds(avatarInventory),
    inputsHash: nexusInputsHash(root, { avatarAssets: avatarInventory, fontAssets: fontInventory }),
  });
  if (!result.ok) {
    const n = result.findings.filter((f) => f.severity === "error").length;
    throw new CliError(`nexus compile: ${n} error(s)`);
  }
  return writeTree(
    path.resolve(gitopsDir),
    renderNexusTree(result.plan, result.icons, avatarInventory, fontInventory),
    NEXUS_MANAGED_TREES,
  );
}
