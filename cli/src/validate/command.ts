// Extracted from main.ts (final-pass #657): see the subject directory contract.
import { compileConnections, loadConnectionDeclarations } from "../connection/compile.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, HgState, jsonOut, loadState, loadTestConfig, log, ok, profileCtxs } from "../lib.ts";
import { discoverProfiles } from "../local/shared.ts";
import { bundleDeclarationFile, connectionDeclarationFile, connectionTargets, validateProfile, workspaceDeclarationFile } from "../platform/index.ts";
import { loadBundleDeclarations } from "../platform/profile-bundles.ts";
import { validateHarnessDeclarations } from "../harness/declaration.ts";
import { isControlPlaneNamespace } from "../platform/planes.ts";
import { nsOf } from "../lib.ts";
import { compileWorkspaceBindings, loadWorkspaceDeclarations, mergeWorkspacesIntoBundles } from "../workspace/bindings.ts";

// ---------------------------------------------------------------------------
// validate - the fast gate: contract checks with NO cluster and no git
// remote, reporting EVERY failure at once (design 08: a gate that
// reports one error at a time turns a five-minute fix into five round
// trips). Exit 1 on any error; warnings do not fail.
// ---------------------------------------------------------------------------

/** --dir makes validate a ONE-SHOT gate over an arbitrary agent-bundle
 * repo: the state is synthesized from the directory exactly the way
 * onboard would build it, but nothing is persisted and no prior onboard
 * is required (#669; the #161 shape - a contract gate you can run
 * before the repo has ever met this machine). Without --dir the gate
 * covers every onboarded profile, as always. */
export function cmdValidate(json: boolean, dir?: string): void {
  const state = dir ? oneShotState(dir) : loadState();
  const findings = profileCtxs(state).flatMap((ctx) =>
    validateProfile(state, ctx, loadTestConfig(ctx.dir)),
  );
  // Platform-side: every registered harness declares its gateway
  // (ADR 0162) - a fact about this checkout, so it needs no profiles.
  findings.push(...validateHarnessDeclarations());
  // PLANE001 (#660): a declaration cannot land an agent in a control-plane
  // namespace - a profile named "system" would derive hermes-system.
  for (const ctx of profileCtxs(state)) {
    const ns = nsOf(ctx.name);
    if (isControlPlaneNamespace(ns)) {
      findings.push({
        profile: ctx.name, severity: "error", check: "plane",
        message: `PLANE001 profile ${ctx.name} derives namespace ${ns}, which is a control-plane namespace (control-plane/planes.yaml) - rename the profile`,
      });
    }
  }
  // Environment-level checks (the first ones this gate has): the
  // workspace-bindings declaration, validated with NO gitops clone -
  // profiles come from the onboarded contracts with no sha, so every
  // structural rule fires while revision RESOLUTION stays where records
  // exist (`hg up` / `hg workspace plan`).
  const workspaceDeclaration = workspaceDeclarationFile(state);
  if (workspaceDeclaration) {
    try {
      const declarations = loadWorkspaceDeclarations(workspaceDeclaration);
      const known = new Map(profileCtxs(state).map((ctx) => [ctx.name, {}]));
      const result = compileWorkspaceBindings(declarations, known, { requireResolution: false });
      findings.push(...result.findings);
      const bundleDeclaration = bundleDeclarationFile(state);
      if (bundleDeclaration) {
        try {
          mergeWorkspacesIntoBundles(loadBundleDeclarations(bundleDeclaration), result.bindings);
        } catch (err) {
          findings.push({
            profile: "*",
            severity: "error",
            check: "workspaces",
            message: err instanceof Error ? err.message : String(err),
            file: bundleDeclaration,
          });
        }
      }
    } catch (err) {
      findings.push({
        profile: "*",
        severity: "error",
        check: "workspaces",
        message: err instanceof Error ? err.message : String(err),
        file: workspaceDeclaration,
      });
    }
  }
  const connectionDeclaration = connectionDeclarationFile(state);
  if (connectionDeclaration) {
    try {
      const declarations = loadConnectionDeclarations(connectionDeclaration);
      findings.push(...compileConnections(declarations, connectionTargets(profileCtxs(state))).findings);
    } catch (err) {
      findings.push({
        profile: "*",
        severity: "error",
        check: "connections",
        message: err instanceof Error ? err.message : String(err),
        file: connectionDeclaration,
      });
    }
  }
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  if (json) {
    jsonOut({
      command: "validate",
      profiles: profileCtxs(state).map((c) => c.name),
      ok: errors.length === 0,
      errors,
      warnings,
    });
  } else {
    for (const f of findings) {
      const mark = f.severity === "error" ? "  ✗" : "  !";
      console.log(`${mark} [${f.profile}] ${f.check}: ${f.message}`);
      if (f.file) console.log(`      file: ${f.file}`);
      if (f.fix) console.log(`      fix:  ${f.fix}`);
    }
    if (findings.length === 0) ok(`validate: ${profileCtxs(state).length} profile(s) clean`);
    else log(`validate: ${errors.length} error(s), ${warnings.length} warning(s)`);
  }
  if (errors.length > 0) throw new CliError(`validate: ${errors.length} contract error(s)`);
}

export function oneShotState(dir: string): HgState {
  const profileDir = path.resolve(dir);
  if (!fs.existsSync(profileDir)) throw new CliError(`validate --dir ${profileDir} does not exist`);
  const profiles = discoverProfiles(profileDir);
  const profileName =
    profiles.length === 1 && !profiles[0]!.subdir ? profiles[0]!.name : path.basename(profileDir);
  return { profileDir, profileName, profiles, trusted: true };
}
