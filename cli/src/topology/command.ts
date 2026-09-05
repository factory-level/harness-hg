// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as fs from "node:fs";
import { agentLayout } from "../layout.ts";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { compileConnectionsFromRoot } from "../connection/compile.ts";
import { CliError, HG_HOME, jsonOut, log, ok } from "../lib.ts";
import { gitHeadOf, printFindings, topologyRoot } from "../local/shared.ts";
import { ValidationFinding } from "../platform/index.ts";
import { compile as compileTopology } from "./compile.ts";
import { Layout, discoverContractDirs, loadContracts } from "./contract.ts";
import { deepCheck, fixToV2, lintRepo } from "./doctor.ts";
import { renderTree, writeTree } from "./emit.ts";
import { loadEnvironment } from "./environment.ts";
import { renderTopology } from "./print.ts";

export function cmdTopology(
  json: boolean,
  args: string[],
  dir: string | undefined,
  environment: string | undefined,
  layoutFlag: string | undefined,
  deep: boolean,
  fix: boolean,
  output: string | undefined,
  routerImage?: string,
  observerUrl?: string,
  argoDestinations?: string,
): void {
  const [sub] = args;
  if (!dir) {
    throw new CliError("topology requires --dir <repo-path-or-git-url>");
  }
  if (layoutFlag && !["single", "replicated", "hub-spoke"].includes(layoutFlag)) {
    throw new CliError(`--layout must be single|replicated|hub-spoke, got ${JSON.stringify(layoutFlag)}`);
  }
  const layout = layoutFlag as Layout | undefined;
  const root = topologyRoot(dir);
  const loaded = loadContracts(root);

  switch (sub ?? "plan") {
    case "inspect": {
      // Contracts only - no environment, no placement: what the repo
      // declares, validated. Never executes repository scripts.
      const profiles = loaded.contracts.map((c) => ({
        profile: c.profile,
        subdir: c.subdir,
        contractVersion: c.contractVersion,
        supportedLayouts: c.supportedLayouts,
        agent: c.agent,
        endpoints: c.endpoints,
        apps: c.apps.map((a) => ({
          name: a.name,
          chart: a.chart,
          repo: a.repo,
          version: a.version,
          multiplicity: a.multiplicity,
          dataBoundary: a.dataBoundary,
          endpoints: a.endpoints,
        })),
        requires: c.requires,
      }));
      // Warnings never fail a command - same ok semantics as plan/urls.
      const okAll = !loaded.findings.some((f) => f.severity === "error");
      if (json) jsonOut({ command: "topology-inspect", ok: okAll, profiles, findings: loaded.findings });
      else {
        for (const p of profiles) {
          console.log(`${p.profile}  (contract v${p.contractVersion}, layouts: ${p.supportedLayouts.join(", ")})`);
          console.log(`  agent: ${p.agent.multiplicity}/${p.agent.dataBoundary}`);
          for (const e of p.endpoints) {
            console.log(`  endpoint ${e.name} :${e.port}${e.path ?? "/"} ${e.type}${e.provides ? ` provides ${e.provides}` : ""}`);
          }
          for (const a of p.apps) {
            console.log(`  app ${a.name} ${a.multiplicity}/${a.dataBoundary} (${a.repo === "local" ? "local" : `${a.chart}@${a.version}`})`);
            for (const e of a.endpoints) {
              console.log(`    endpoint ${e.name} :${e.port}${e.path ?? "/"} ${e.type}${e.provides ? ` provides ${e.provides}` : ""}`);
            }
          }
          for (const r of p.requires) {
            const into = r.inject.env ? `env ${r.inject.env}` : `${r.inject.appValue!.app}.${r.inject.appValue!.path}`;
            console.log(`  requires ${r.capability} (${r.locality}) -> ${into}`);
          }
        }
        printFindings(loaded.findings);
      }
      if (!okAll) {
        throw new CliError(
          `topology inspect: ${loaded.findings.filter((f) => f.severity === "error").length} error(s)`,
        );
      }
      return;
    }
    case "plan":
    case "urls":
    case "print":
    case "doctor":
    case "emit": {
      const env = loadEnvironment(root, environment);
      const plan = compileTopology(loaded.contracts, env.environment, {
        layout,
        priorFindings: [...loaded.findings, ...env.findings],
        // #176/TOPO017: the caller that KNOWS the registered clusters
        // (the Pulumi preview gate) passes them; standalone runs omit
        // the flag and the check stays off.
        ...(argoDestinations !== undefined
          ? { knownArgoDestinations: argoDestinations.split(",").map((s) => s.trim()).filter(Boolean) }
          : {}),
      });
      if (sub === "emit") {
        // Materialize the generated trees (ADR-34). REFUSES before any
        // write on plan errors - compilation failures never reach Git.
        let emitNote: string | undefined;
        if (!output) {
          // The bundle-destination default (#673, ADR 0172): with no
          // --output, the repo's own .harness-hg/destination.yaml names
          // the GitOps repo; it is cloned/pulled idempotently and the
          // records land there for the author to review and push.
          const dest = readBundleDestination(root);
          if (!dest) {
            throw new CliError(
              "topology emit requires --output <gitops-repo-dir> " +
                "(or a harness-hg/destination.yaml naming the GitOps repo - hg bundle init writes one)",
            );
          }
          output = topologyRoot(dest.repoUrl);
          emitNote = `destination from ${dest.file} (${dest.repoUrl}) - review and push from ${output}`;
        }
        // Knob validation BEFORE any write - a malformed value here lands
        // in Git and fails at the ApplicationSet, hours later (codex catch).
        if (routerImage !== undefined && (!routerImage.trim() || /\s/.test(routerImage))) {
          throw new CliError(`--router-image ${JSON.stringify(routerImage)}: not a plausible image reference`);
        }
        if (observerUrl !== undefined && !/^https?:\/\/\S+$/.test(observerUrl)) {
          throw new CliError(`--observer-url ${JSON.stringify(observerUrl)}: must be an http(s) URL`);
        }
        if (!plan.ok) {
          const n = plan.findings.filter((f) => f.severity === "error").length;
          if (json) jsonOut({ command: "topology-emit", ok: false, findings: plan.findings, written: [], deleted: [] });
          else printFindings(plan.findings);
          throw new CliError(`topology emit: ${n} error(s) - nothing was written`);
        }
        const sourceSha = gitHeadOf(root) ?? "0".repeat(40);
        // Connections (ADR-152) ride the same emit: a compile error here is
        // an emit error - a stale or missing projection is a credential fact.
        const compiledConns = compileConnectionsFromRoot(root, loaded.contracts, env.environment.bundledProfiles);
        const connErrors = compiledConns?.result.findings.filter((f) => f.severity === "error") ?? [];
        if (connErrors.length > 0) {
          for (const f of connErrors) console.error(`  ✗ [${f.profile}] ${f.check}: ${f.message}`);
          throw new CliError(`topology emit: ${connErrors.length} connection error(s) - nothing was written`);
        }
        const tree = renderTree(root, loaded.contracts, plan, env.environment, {
          sourceSha,
          environmentSource: environment,
          routerImage,
          observerUrl,
          ...(compiledConns ? { connections: { files: compiledConns.files, gateway: compiledConns.gateway } } : {}),
        });
        const result = writeTree(path.resolve(output), tree);
        if (json) {
          jsonOut({ command: "topology-emit", ok: true, output: path.resolve(output), ...result, findings: plan.findings });
        } else {
          for (const f of result.written) console.log(`  + ${f}`);
          for (const f of result.deleted) console.log(`  - ${f}`);
          printFindings(plan.findings);
          ok(
            `topology emit: ${result.written.length} written, ${result.unchanged.length} unchanged, ${result.deleted.length} deleted -> ${output}`,
          );
          if (emitNote) log(`  ${emitNote}`);
        }
        return;
      }
      if (sub === "doctor") {
        // --fix FIRST (the mechanical v2 upgrade, diff printed, nothing
        // committed; a refused file becomes a finding, not an abort), so
        // the report below always describes the POST-fix repository.
        const fixes: { file: string; changed: boolean }[] = [];
        const fixFindings: ValidationFinding[] = [];
        if (fix) {
          for (const { dir } of discoverContractDirs(root)) {
            const layout = agentLayout(dir);
            if (!layout.legacy) continue; // the agent-team layout is already the split shape
            const file = layout.agentFile;
            if (!fs.existsSync(file)) continue;
            try {
              const result = fixToV2(file);
              fixes.push({ file: path.relative(root, result.file), changed: result.changed });
              if (result.changed) {
                fs.writeFileSync(file, result.after);
                if (!json) {
                  console.log(`--- ${path.relative(root, file)} (upgraded to contract v2)`);
                  for (const line of result.after.split("\n")) {
                    if (!result.before.includes(line) && line.trim()) console.log(`  + ${line}`);
                  }
                }
              }
            } catch (e) {
              fixFindings.push({
                profile: path.basename(dir),
                severity: "warning",
                check: "fix-refused",
                message: (e as Error).message,
                file: path.relative(root, file),
              });
            }
          }
        }
        // (Re)compile against what is on disk NOW.
        const current = fixes.some((f) => f.changed) ? loadContracts(root) : loaded;
        const doctorPlan = fixes.some((f) => f.changed)
          ? compileTopology(current.contracts, env.environment, {
              layout,
              priorFindings: [...current.findings, ...env.findings],
            })
          : plan;
        doctorPlan.findings.push(...fixFindings);
        doctorPlan.findings.push(...lintRepo(root, current.contracts, doctorPlan));
        if (deep) {
          doctorPlan.findings.push(...deepCheck(root, current.contracts, path.join(HG_HOME, "topology-charts")));
        }
        const okDoctor = !doctorPlan.findings.some((f) => f.severity === "error");
        if (json) {
          jsonOut({ command: "topology-doctor", ok: okDoctor, layout: doctorPlan.layout, findings: doctorPlan.findings, fixes });
        } else {
          printFindings(doctorPlan.findings);
          const warnings = doctorPlan.findings.filter((f) => f.severity === "warning").length;
          const errors = doctorPlan.findings.length - warnings;
          if (okDoctor) ok(`topology doctor: ${errors} error(s), ${warnings} warning(s)`);
        }
        if (!okDoctor) {
          throw new CliError(`topology doctor: ${doctorPlan.findings.filter((f) => f.severity === "error").length} error(s)`);
        }
        return;
      }
      if (sub === "print") {
        if (json) jsonOut({ command: "topology-print", ok: plan.ok, lines: renderTopology(plan, env.environment), findings: plan.findings });
        else {
          for (const line of renderTopology(plan, env.environment)) console.log(line);
          printFindings(plan.findings);
        }
        if (!plan.ok) {
          throw new CliError(`topology print: ${plan.findings.filter((f) => f.severity === "error").length} error(s)`);
        }
        return;
      }
      if (sub === "urls") {
        const rows = plan.endpoints.map((e) => ({
          profile: e.profile,
          component: e.component,
          instance: e.scope,
          endpoint: e.endpoint,
          type: e.type,
          url: e.url ?? e.internalUrl,
          provides: e.provides,
        }));
        if (json) jsonOut({ command: "topology-urls", ok: plan.ok, layout: plan.layout, urls: rows, findings: plan.findings });
        else {
          const cols = ["profile", "component", "instance", "endpoint", "type"] as const;
          const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => r[c].length)));
          console.log(cols.map((c, i) => c.toUpperCase().padEnd(w[i]!)).join("  ") + "  URL");
          for (const r of rows) {
            console.log(cols.map((c, i) => r[c].padEnd(w[i]!)).join("  ") + `  ${r.url}`);
          }
          printFindings(plan.findings);
        }
      } else {
        if (json) jsonOut({ command: "topology-plan", ...plan });
        else {
          log(`layout ${plan.layout} (${plan.sovereignty}): ${plan.agents.length} agent instance(s), ${plan.apps.length} app instance(s), ${plan.bindings.length} binding(s)`);
          for (const a of plan.agents) {
            console.log(`  agent ${a.id}  ns=${a.namespace} target=${a.target} dest=${a.argoDestination}`);
          }
          for (const a of plan.apps) {
            console.log(`  app   ${a.id}  ns=${a.namespace} target=${a.target}${a.pairedAgent ? ` (with ${a.pairedAgent})` : ""}`);
          }
          for (const b of plan.bindings) {
            const cross = b.crossRegion ? "  CROSS-REGION" : "";
            console.log(`  bind  ${b.capability}: ${b.consumer} -> ${b.provider}${cross}`);
          }
          printFindings(plan.findings);
        }
      }
      if (!plan.ok) {
        throw new CliError(`topology ${sub}: ${plan.findings.filter((f) => f.severity === "error").length} error(s)`);
      }
      if (!json) ok(`topology ${sub}: ok (${plan.agents.length} agents, ${plan.apps.length} apps)`);
      return;
    }
    default:
      throw new CliError(`unknown topology subcommand ${JSON.stringify(sub)} (inspect|plan|urls|print|doctor|emit)`);
  }
}

/** .harness-hg/destination.yaml (bundle-destination/v1alpha1, #673):
 * the repo's declared GitOps destination, or undefined when absent. */
function readBundleDestination(root: string): { repoUrl: string; branch: string; file: string } | undefined {
  // harness-hg/destination.yaml (ADR 0178); the never-built dotdir path
  // hg bundle init wrote until then stays readable. Never environment/.
  const file = [path.join(root, "harness-hg", "destination.yaml"), path.join(root, ".harness-hg", "destination.yaml")]
    .find((f) => fs.existsSync(f));
  if (!file) return undefined;
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as
    | { apiVersion?: string; gitops?: { repoUrl?: string; branch?: string } }
    | null;
  if (doc?.apiVersion !== "hermes-gitops.factorylevel.dev/bundle-destination/v1alpha1") {
    throw new CliError(`${file}: unsupported apiVersion ${JSON.stringify(doc?.apiVersion)}`);
  }
  if (!doc.gitops?.repoUrl) throw new CliError(`${file}: gitops.repoUrl is required`);
  return { repoUrl: doc.gitops.repoUrl, branch: doc.gitops.branch ?? "main", file: path.relative(root, file) };
}
