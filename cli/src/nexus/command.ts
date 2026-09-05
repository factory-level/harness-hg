// Extracted from main.ts (final-pass #657): see the subject directory contract.

export interface NexusOpts {
  dir?: string;
  environment?: string;
  layout?: string;
  workloadEndpoints?: string;
  output?: string;
  plan?: string;
  controlPlane?: string;
  enable?: string;
  disable?: string;
  reset?: boolean;
}
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LAUNCH_FLAGS_OFF, LAUNCH_FLAGS_ON } from "../launch/prove.ts";
import { CliError, PLATFORM_ROOT, jsonOut, loadState, ok, saveState } from "../lib.ts";
import { gitHeadOf, platformAvatarsDir, platformFontsDir, printFindings, topologyRoot } from "../local/shared.ts";
import { compile as compileTopology } from "../topology/compile.ts";
import { Layout, loadContracts } from "../topology/contract.ts";
import { writeTree } from "../topology/emit.ts";
import { loadEnvironment } from "../topology/environment.ts";
import { compileNexus } from "./compile.ts";
import { loadDashboard } from "./contract.ts";
import { NEXUS_MANAGED_TREES, hasDashboardFiles, loadAvatarInventory, loadFontInventory, loadWorkloadEndpoints, nexusInputsHash, renderNexusTree, selectableAvatarIds } from "./emit.ts";
import { proveNexus } from "./prove.ts";

/** The installable Nexus unit — re-homed from the old dashboard tree at the
 * #732 flip. `hg nexus install` copies THIS tree (minus its chart) into
 * the local Hermes plugin dir; tests pin the path so a future re-home
 * cannot silently break install again (#736). */
export const NEXUS_PLUGIN_SRC = path.join(PLATFORM_ROOT, "control-plane", "nexus");

export async function cmdNexus(json: boolean, args: string[], opts: NexusOpts): Promise<void> {
  const [sub, subArg] = args;
  if (opts.layout && !["single", "replicated", "hub-spoke"].includes(opts.layout)) {
    throw new CliError(`--layout must be single|replicated|hub-spoke, got ${JSON.stringify(opts.layout)}`);
  }

  // inspect reads a compiled plan file directly - no repo needed.
  if (sub === "inspect") {
    if (!subArg) throw new CliError("nexus inspect requires a component id (hg nexus inspect <id> --plan <file>)");
    if (!opts.plan) throw new CliError("nexus inspect requires --plan <nexus-plan.json>");
    const doc = JSON.parse(fs.readFileSync(opts.plan, "utf8")) as {
      components?: {
        id: string;
        kind: string;
        title: string;
        resolved: boolean;
        unresolvedReason?: string;
        bind?: { profile: string; app?: string };
        crons?: unknown[];
        instances: {
          id: string;
          scope: string;
          target?: string;
          application?: string;
          grafanaDashboardUid?: string;
          destinations: { hermesClassic?: string; deployed?: { name: string; url: string }[] };
        }[];
      }[];
    };
    const component = (doc.components ?? []).find((c) => c.id === subArg);
    if (!component) {
      throw new CliError(
        `nexus inspect: no component ${JSON.stringify(subArg)} in ${opts.plan} ` +
          `(known: ${(doc.components ?? []).map((c) => c.id).join(", ")})`,
      );
    }
    const destinations = new Set<string>();
    const healthSources = new Set<string>(["Argo CD"]);
    for (const i of component.instances) {
      if (i.destinations.hermesClassic) destinations.add("Hermes Classic");
      if (i.grafanaDashboardUid) destinations.add("Grafana");
      if (i.application) destinations.add("Argo CD");
      for (const d of i.destinations.deployed ?? []) destinations.add(d.name);
      if (i.destinations.hermesClassic) healthSources.add("Hermes");
      if (i.grafanaDashboardUid) healthSources.add("Grafana");
    }
    if (json) {
      jsonOut({ command: "nexus-inspect", ok: true, component });
      return;
    }
    console.log(component.id);
    console.log(`Kind: ${component.kind}`);
    if (component.bind) {
      console.log(`Bind: ${component.bind.profile}${component.bind.app ? `/${component.bind.app}` : ""}`);
    }
    if (!component.resolved) console.log(`UNRESOLVED: ${component.unresolvedReason ?? "binding unresolved"}`);
    console.log(`Instances: ${component.instances.length}`);
    for (const i of component.instances) {
      console.log(`  ${i.id}  target=${i.target ?? "-"}${i.application ? `  argo=${i.application}` : ""}`);
    }
    console.log(`Destinations: ${[...destinations].sort().join(", ") || "none"}`);
    console.log(`Health: ${[...healthSources].sort().join(", ")}`);
    return;
  }

  // features: the CLI half of the ADR-43 flag system - list and flip
  // workspace capabilities on the local control-plane install. The
  // registry is the features.json shipped inside the plugin payload
  // (the installed copy when present, this checkout's otherwise); state
  // is the same operator overlay the backend reads fresh per request,
  // so a flip takes effect on the next render - no restart.
  if (sub === "features") {
    const pluginRoot = path.join(os.homedir(), ".hermes", "plugins", "hermes-gitops");
    const installedReg = path.join(pluginRoot, "dashboard", "features.json");
    const regPath = fs.existsSync(installedReg)
      ? installedReg
      : path.join(NEXUS_PLUGIN_SRC, "features.json");
    const reg = JSON.parse(fs.readFileSync(regPath, "utf8")) as {
      features?: { id: string; title?: string; milestone?: string; defaultOff?: boolean }[];
    };
    const registry = (reg.features ?? []).filter((f) => typeof f.id === "string");
    const known = new Set(registry.map((f) => f.id));
    const statePath = path.join(pluginRoot, "state", "features.json");
    if (opts.reset) fs.rmSync(statePath, { force: true }); // back to registry defaults
    let stored: Record<string, boolean> = {};
    try {
      const doc = JSON.parse(fs.readFileSync(statePath, "utf8")) as { enabled?: Record<string, boolean> };
      if (doc && typeof doc.enabled === "object" && doc.enabled) stored = doc.enabled;
    } catch {
      // No state yet - registry defaults.
    }
    // `launch` is the #285 configuration as ONE word. A fresh install has
    // every flag off, so reaching the launch posture used to mean
    // hand-crafting a PUT against the features route - which is both
    // error-prone and undiscoverable, and `hg launch prove` fails until
    // it is done. Naming the set here keeps the gate and the way to
    // satisfy it in the same place.
    const parseList = (v?: string) =>
      v === "all"
        ? [...known]
        : v === "launch"
          ? [...LAUNCH_FLAGS_ON].filter((f) => known.has(f))
          : (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const enable = parseList(opts.enable);
    const disable =
      opts.disable === "launch"
        ? [...LAUNCH_FLAGS_OFF].filter((f) => known.has(f))
        : parseList(opts.disable);
    for (const id of [...enable, ...disable]) {
      if (!known.has(id)) {
        throw new CliError(
          `nexus features: unknown flag ${JSON.stringify(id)} (known: ${[...known].join(", ") || "none registered yet"})`,
        );
      }
    }
    if (enable.length > 0 || disable.length > 0) {
      const next = { ...stored };
      for (const id of enable) next[id] = true;
      for (const id of disable) next[id] = false;
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      // pid-suffixed tmp: the plugin backend writes the same file, and a
      // shared tmp path would let concurrent writers steal the rename.
      const tmp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, enabled: next }, null, 2)}\n`);
      fs.renameSync(tmp, statePath);
      stored = next;
    }
    const resolved = registry.map((f) => ({
      id: f.id,
      title: f.title ?? f.id,
      milestone: f.milestone ?? "",
      enabled: stored[f.id] ?? !(f.defaultOff ?? true),
    }));
    if (json) {
      jsonOut({ command: "nexus-features", ok: true, registry: regPath, state: statePath, features: resolved });
      return;
    }
    if (resolved.length === 0) {
      console.log("  no flags registered yet - capabilities from later milestones appear here as they land");
    }
    for (const f of resolved) {
      console.log(`  ${f.enabled ? "on " : "off"}  ${f.id}${f.milestone ? `  (${f.milestone})` : ""}`);
    }
    ok(`nexus features: ${resolved.filter((f) => f.enabled).length} of ${resolved.length} enabled`);
    return;
  }

  // set: chart-value overrides for the local loop's Nexus install.
  // ADR-53's reciprocal rule - the Pulumi bootstrap can set any
  // charts/nexus value, so the CLI must be able to as well, or a laptop
  // silently becomes a weaker environment than a deployed one. Values are
  // stored in hg state and applied by `up` (ensureNexus), so they survive
  // re-installs. No --source needed.
  if (sub === "set") {
    // loadState throws with the onboard hint when nothing is onboarded.
    const state = loadState();
    const pairs = args.slice(1).filter((a) => !a.startsWith("-"));
    if (pairs.length === 0) {
      if (json) jsonOut({ command: "nexus-set", ok: true, values: state.nexusValues ?? {} });
      else {
        const cur = Object.entries(state.nexusValues ?? {});
        if (cur.length === 0) console.log("  (no overrides; chart defaults apply)");
        for (const [k, v] of cur) console.log(`  ${k}=${v}`);
      }
      return;
    }
    state.nexusValues ??= {};
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new CliError(`nexus set: expected key=value, got ${JSON.stringify(pair)}`);
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // An empty value CLEARS the override rather than setting "" - that
      // is the only way back to the chart default.
      if (value === "") delete state.nexusValues[key];
      else state.nexusValues[key] = value;
    }
    saveState(state);
    if (json) jsonOut({ command: "nexus-set", ok: true, values: state.nexusValues });
    else ok(`nexus set: ${Object.keys(state.nexusValues).length} override(s) - applied on the next \`hg up\``);
    return;
  }

  if (!opts.dir) {
    throw new CliError("nexus requires --source <repo-path-or-git-url> (alias: --dir)");
  }
  const root = topologyRoot(opts.dir);

  // install: wire THIS checkout's dashboard plugin into the local
  // control-plane Hermes. A COPY, not a symlink: Hermes discovers
  // <name>/dashboard/manifest.json, and a symlinked plugin dir would
  // route the operator's config.yaml INTO this git checkout. Re-run
  // after rebuilding the dist. Idempotent.
  if (sub === "install") {
    if (!opts.output) throw new CliError("nexus install requires --gitops <gitops-repo-dir> (alias: --output)");
    const pluginSrc = NEXUS_PLUGIN_SRC;
    const pluginRoot = path.join(os.homedir(), ".hermes", "plugins", "hermes-gitops");
    const payloadDst = path.join(pluginRoot, "dashboard");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.rmSync(payloadDst, { recursive: true, force: true });
    // The re-homed unit (#732) keeps its Helm chart beside the payload;
    // the chart (and stray caches) are not part of what Hermes mounts.
    fs.cpSync(pluginSrc, payloadDst, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(pluginSrc, src);
        return rel !== "chart" && !rel.startsWith(`chart${path.sep}`) && !rel.includes("__pycache__");
      },
    });
    const cfgPath = path.join(pluginRoot, "config.yaml");
    const repoPath = path.resolve(opts.output);
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, `repoPath: ${repoPath}\n`);
    } else if (!fs.readFileSync(cfgPath, "utf8").includes(repoPath)) {
      console.log(`  ! ${cfgPath} exists and does not name ${repoPath} - update repoPath yourself`);
    }
    // spawnSync THROWS when the binary is absent (fresh machine, no
    // Hermes install) - the graceful "run it yourself" hint below must
    // survive that, not crash after the copy already landed (#736).
    let enabled = false;
    try {
      enabled = Bun.spawnSync(["hermes", "plugins", "enable", "hermes-gitops"]).exitCode === 0;
    } catch {
      enabled = false;
    }
    if (json) {
      jsonOut({ command: "nexus-install", ok: true, plugin: payloadDst, config: cfgPath, repoPath, enabled });
    } else {
      console.log(`  plugin  ${payloadDst} (copied from ${pluginSrc})`);
      console.log(`  config  ${cfgPath} (repoPath: ${repoPath})`);
      if (!enabled) {
        console.log("  ! `hermes plugins enable hermes-gitops` failed - run it on the control-plane host, then restart `hermes dashboard`");
      }
      ok(`nexus install: plugin wired${enabled ? " and enabled" : ""} - restart the dashboard to (re)mount the backend`);
    }
    return;
  }

  const dash = loadDashboard(root);

  switch (sub ?? "compile") {
    case "validate": {
      const okAll = !dash.findings.some((f) => f.severity === "error");
      const files = {
        contributions: dash.contributions.map((c) => c.relPath),
        views: dash.views.map((v) => v.relPath),
      };
      if (json) jsonOut({ command: "nexus-validate", ok: okAll, ...files, findings: dash.findings });
      else {
        for (const f of files.contributions) console.log(`  contribution ${f}`);
        for (const f of files.views) console.log(`  view         ${f}`);
        printFindings(dash.findings);
      }
      if (!okAll) {
        throw new CliError(`nexus validate: ${dash.findings.filter((f) => f.severity === "error").length} error(s)`);
      }
      if (!json) ok(`nexus validate: ${files.contributions.length} contribution(s), ${files.views.length} view(s)`);
      return;
    }
    case "prove": {
      if (!opts.output) throw new CliError("nexus prove requires --gitops <gitops-repo-dir>");
      const env = loadEnvironment(root, opts.environment);
      const loaded = loadContracts(root);
      const topology = compileTopology(loaded.contracts, env.environment, {
        layout: opts.layout as Layout | undefined,
        priorFindings: [...loaded.findings, ...env.findings],
      });
      const report = await proveNexus({
        sourceRoot: root,
        gitopsRoot: path.resolve(opts.output),
        topology,
        topologyFindingsOk: topology.ok,
        sourceSha: gitHeadOf(root),
        environmentSource: opts.environment,
        workloadEndpointsFile: opts.workloadEndpoints,
        controlPlane: opts.controlPlane,
        proofsRoot: process.env["HG_PROOFS_DIR"],
      });
      if (json) jsonOut({ command: "nexus-prove", ...report });
      else {
        for (const c of report.checks) {
          const mark = c.status === "pass" ? "  ✓" : c.status === "unknown" ? "  ?" : "  ✗";
          console.log(`${mark} ${c.title}`);
          console.log(`      ${c.detail}`);
        }
        console.log(`  artifacts: ${report.artifactsDir}`);
      }
      if (!report.ok) {
        throw new CliError(`nexus prove: ${report.checks.filter((c) => c.mandatory && c.status === "fail").length} mandatory check(s) failed`);
      }
      if (!json) ok("nexus prove: every mandatory check passed");
      return;
    }
    case "compile":
    case "print":
    case "emit": {
      if (!hasDashboardFiles(root)) {
        throw new CliError(
          `nexus ${sub}: ${root} authors no dashboard/ files - nothing to compile ` +
            "(add dashboard/contribution.yaml or distributions/*/dashboard/components.yaml)",
        );
      }
      const env = loadEnvironment(root, opts.environment);
      const loaded = loadContracts(root);
      const topology = compileTopology(loaded.contracts, env.environment, {
        layout: opts.layout as Layout | undefined,
        priorFindings: [...loaded.findings, ...env.findings],
      });
      const workloadEndpoints = opts.workloadEndpoints ? loadWorkloadEndpoints(opts.workloadEndpoints) : undefined;
      const sourceSha = gitHeadOf(root) ?? "0".repeat(40);
      const avatarInventory = loadAvatarInventory(platformAvatarsDir());
      const fontInventory = loadFontInventory(platformFontsDir());
      const result = compileNexus({
        ...dash,
        findings: [...dash.findings, ...topology.findings],
        topology,
        bundledProfiles: env.environment.bundledProfiles,
        workloadEndpoints,
        sourceSha,
        avatarIds: selectableAvatarIds(avatarInventory),
        inputsHash: nexusInputsHash(root, {
          environmentSource: opts.environment,
          workloadEndpointsFile: opts.workloadEndpoints,
          avatarAssets: avatarInventory,
          fontAssets: fontInventory,
        }),
      });
      const { plan, findings } = result;
      if (sub === "emit" || (sub === "compile" && opts.output)) {
        // `compile --gitops <dir>` is the DevX-contract spelling of emit.
        if (!opts.output) throw new CliError("nexus emit requires --output <gitops-repo-dir> (alias: --gitops)");
        if (!result.ok) {
          const n = findings.filter((f) => f.severity === "error").length;
          if (json) jsonOut({ command: "nexus-emit", ok: false, findings, written: [], deleted: [] });
          else printFindings(findings);
          throw new CliError(`nexus ${sub}: ${n} error(s) - nothing was written`);
        }
        const written = writeTree(
          path.resolve(opts.output),
          renderNexusTree(plan, result.icons, avatarInventory, fontInventory),
          NEXUS_MANAGED_TREES,
        );
        if (json) {
          jsonOut({ command: "nexus-emit", ok: true, output: path.resolve(opts.output), ...written, findings });
        } else {
          for (const f of written.written) console.log(`  + ${f}`);
          for (const f of written.deleted) console.log(`  - ${f}`);
          printFindings(findings);
          ok(
            `nexus ${sub}: ${written.written.length} written, ${written.unchanged.length} unchanged, ${written.deleted.length} deleted -> ${opts.output}`,
          );
        }
        return;
      }
      if (sub === "print") {
        if (json) jsonOut({ command: "nexus-print", ok: result.ok, plan, findings });
        else {
          for (const c of plan.components) {
            const badge = c.resolved ? "" : "  UNRESOLVED";
            console.log(`${c.kind.padEnd(11)} ${c.id}  "${c.title}"${badge}`);
            for (const i of c.instances) {
              const dests = [
                i.destinations.hermesClassic ? "classic" : undefined,
                i.grafanaDashboardUid ? "grafana" : undefined,
                ...(i.destinations.deployed ?? []).map((d) => d.name),
              ].filter(Boolean);
              console.log(`    ${i.id}  target=${i.target ?? "-"}${dests.length ? `  [${dests.join(", ")}]` : ""}`);
            }
          }
          for (const r of plan.relationships) console.log(`edge        ${r.from} -${r.label}-> ${r.to}`);
          printFindings(findings);
        }
      } else if (json) {
        jsonOut({ command: "nexus-compile", ok: result.ok, plan, findings });
      } else {
        printFindings(findings);
      }
      if (!result.ok) {
        throw new CliError(`nexus ${sub}: ${findings.filter((f) => f.severity === "error").length} error(s)`);
      }
      if (!json) {
        ok(`nexus ${sub}: ok (${plan.components.length} components, ${plan.relationships.length} edges)`);
      }
      return;
    }
    default:
      throw new CliError(`unknown nexus subcommand ${JSON.stringify(sub)} (validate|compile|print|emit|inspect|install|prove)`);
  }
}
