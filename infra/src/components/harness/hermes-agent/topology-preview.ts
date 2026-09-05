// Preview-time topology gate (#145, ADR-98's forerunner): an unresolved
// required capability fails `pulumi preview`, not a pod hours later.
//
// The topology compiler has resolved capabilities and failed hard on a
// missing provider (TOPO004) since ADR-33 - but only on the CLI paths
// (`hg platform apply`, `hg topology emit`). The Pulumi bootstrap, the
// one path that actually MUTATES an environment from scratch, never
// invoked it: an agents[] entry whose contract required a capability
// nothing provides sailed through `pulumi preview` and `pulumi up`, and
// the failure surfaced as a pod restarting on a missing env var.
//
// This module runs the same compile at PLAN time, the way
// resolveSourceRevision already does plan-time work (git ls-remote):
//   - agents are grouped by (source, ref) - one repo checkout compiles
//     every profile it hosts, because bindings cross profiles;
//   - a local-path source is used in place; a remote source is
//     shallow-fetched at its resolved sha into a per-sha cache dir;
//   - `bun cli topology plan --dir <root>` is the check - the CLI is the
//     single owner of compilation, and its non-zero exit IS the verdict.
//
// SCOPE, stated plainly (Codex finding, accepted as a documented bound
// rather than fixed): the gate compiles each repository's WHOLE contract
// set - the same scope every CLI path compiles - so a stack deploying a
// SUBSET of a repository's distributions can pass preview on a provider
// it does not deploy, and a consumer/provider pair split across two
// repositories is not a supported configuration anywhere in the platform
// (loadContracts takes one root). Partial-fleet deployment does not
// exist in any current environment; when it does, the fix is a
// --profiles filter on the CLI, not a second compiler here.
//
// Failure semantics mirror resolveSourceRevision's, with one deliberate
// asymmetry: infrastructure failures (offline, clone refused) DEGRADE
// with a warning - correctness of the deploy does not depend on the
// check having run - but a compile that RAN and found errors fails the
// preview hard, with the TOPO findings verbatim. Degrading that half
// would be #145's exact anti-pattern: a plan you looked at and believed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as pulumi from "@pulumi/pulumi";
import type { AgentSpec } from "../../../control-flow/config.ts";
import { resolveSourceRevision } from "./index.ts";

// FIVE levels up, not four: this module lives at
// src/components/harness/hermes-agent/, one deeper than it did before the
// harness directory (ADR-153). A relative path computed from the module's
// own location is not an import, so nothing type-checks it - moving the
// file silently pointed this at infra/cli/src/main.ts and `pulumi
// preview` on the factory stack failed with "Module not found", which is
// where it was caught.
const CLI_MAIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "cli", "src", "main.ts");

/** One compile unit: a repo root and the agents it hosts. Exported for
 * the unit tests - grouping is the pure half of this module. */
export interface SourceGroup {
  source: string;
  ref: string;
  agents: string[]; // slugs, for the failure message
}

/** A source that names a local directory rather than a git remote - the
 * same prefix set resolveSourceRevision treats as non-URL. */
export function isLocalSource(source: string): boolean {
  return /^[/.~]/.test(source);
}

/** Group agents by (source, ref): bindings cross profiles, so every
 * profile of one checkout compiles together, once. */
export function groupBySource(agents: AgentSpec[]): SourceGroup[] {
  const byKey = new Map<string, SourceGroup>();
  for (const a of agents) {
    const key = `${a.source} ${a.ref}`;
    let g = byKey.get(key);
    if (!g) {
      g = { source: a.source, ref: a.ref, agents: [] };
      byKey.set(key, g);
    }
    g.agents.push(a.name ?? (a.subdir ? `${a.source}/${a.subdir}` : a.source));
  }
  return [...byKey.values()];
}

/** Materialize a group's repo root, or null (with the reason) when the
 * infrastructure step failed and the check must degrade.
 *
 * The cache is keyed by commit sha alone, and that is CORRECT: a git
 * commit sha is content-addressed, so the same sha in two remotes (a
 * fork carrying an upstream commit) names byte-identical trees - reuse
 * across sources is a feature, not contamination. What sha-keying does
 * NOT give is completion atomicity (Codex catch): the fetch now builds
 * in a temp sibling and RENAMES into place, so the final path exists
 * only for a finished checkout - a crashed fetch can never leave a
 * half-tree that silently compiles to an empty, trivially-passing plan,
 * and a concurrent preview either wins the rename or reuses the
 * winner's result. */
function materialize(group: SourceGroup): { root: string } | { skip: string } {
  if (isLocalSource(group.source)) {
    const root = group.source.startsWith("~")
      ? path.join(os.homedir(), group.source.slice(1))
      : path.resolve(group.source);
    if (!fs.existsSync(root)) return { skip: `local source ${root} does not exist` };
    return { root };
  }
  const sha = resolveSourceRevision(group.source, group.ref);
  if (sha === null) return { skip: `could not resolve ${group.source}#${group.ref || "HEAD"} to a sha` };
  const cacheRoot = path.join(os.homedir(), ".cache", "hermes-gitops", "preview-contracts");
  const root = path.join(cacheRoot, sha);
  // Existence of the FINAL path means a completed checkout - nothing
  // else ever creates it (see the rename below).
  if (fs.existsSync(root)) return { root };
  const staging = `${root}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  let remote = group.source;
  if (!/^(?:[a-z+]+:\/\/|git@)/.test(remote)) remote = `https://${remote}`;
  const runGit = (args: string[]) =>
    spawnSync("git", args, {
      cwd: staging,
      timeout: 60_000,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  const init = runGit(["init", "--quiet"]);
  const fetch = init.status === 0 ? runGit(["fetch", "--quiet", "--depth", "1", remote, sha]) : init;
  const checkout = fetch.status === 0 ? runGit(["checkout", "--quiet", "FETCH_HEAD"]) : fetch;
  if (checkout.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    const detail = (checkout.stderr ?? "").trim().split("\n").pop() ?? "git failed";
    return { skip: `could not fetch ${group.source}@${sha.slice(0, 12)}: ${detail}` };
  }
  try {
    fs.renameSync(staging, root);
  } catch {
    // A concurrent preview renamed first; its checkout is the same
    // content (sha-addressed), so use it and drop ours.
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(root)) return { skip: `cache rename failed for ${sha.slice(0, 12)}` };
  }
  return { root };
}

export interface CompileResult {
  ok: boolean;
  output: string;
  /** Resolved capability bindings from `topology plan --json`, when the
   * compile succeeded and the output parsed. Absent on failure or on an
   * older CLI - the reserved-env check simply does not run then. */
  bindings?: { capability: string; consumer: string; inject?: { env?: string } }[];
}

export interface TopologyCheckDeps {
  materialize: (g: SourceGroup) => { root: string } | { skip: string };
  compile: (root: string, argoDestinations: string[]) => CompileResult;
  warn: (msg: string) => void;
}

const realDeps: TopologyCheckDeps = {
  materialize,
  compile: (root, argoDestinations) => {
    const run = spawnSync(
      "bun",
      [
        CLI_MAIN,
        "topology",
        "plan",
        "--dir",
        root,
        // #176/TOPO017: this caller KNOWS the registered clusters, so
        // the destination join runs. "in-cluster" is implicit.
        "--argo-destinations",
        argoDestinations.join(","),
        // JSON so the plan's bindings come back for the reserved-env
        // collision check below.
        "--json",
      ],
      {
        timeout: 120_000,
        encoding: "utf-8",
        env: { ...process.env },
      },
    );
    if (run.error || run.status === null) {
      // bun missing / timeout: infrastructure, not a verdict.
      return { ok: true, output: `SKIPPED: ${run.error?.message ?? "timed out"}` };
    }
    let bindings: CompileResult["bindings"];
    if (run.status === 0) {
      try {
        const doc = JSON.parse(run.stdout ?? "{}") as { bindings?: CompileResult["bindings"] };
        bindings = Array.isArray(doc.bindings) ? doc.bindings : undefined;
      } catch {
        bindings = undefined;
      }
    }
    return { ok: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim(), bindings };
  },
  warn: (msg) => pulumi.log.warn(msg),
};

/** The gate. Throws (failing preview) when any group's contracts compile
 * with errors; warns and continues when a group cannot be materialized.
 *
 * `argoDestinations` is the stack's registered targetClusters[] names -
 * the compiler's TOPO017 join between cluster registration and topology
 * consumption (#176).
 *
 * `reservedEnv` is the union of agentSecrets.<instance> variable NAMES
 * (never values) - the render-time envGuard can only see declared
 * envRequires, but the env Secret carries every configured agentSecrets
 * key, and an injection colliding with an UNDECLARED one would still
 * shadow it under Kubernetes env-beats-envFrom precedence (Codex catch).
 * This is the one place both facts meet before anything deploys. */
export function checkAgentTopology(
  agents: AgentSpec[],
  argoDestinations: string[] = [],
  reservedEnv: string[] = [],
  deps: TopologyCheckDeps = realDeps,
): void {
  const reserved = new Set(reservedEnv);
  for (const group of groupBySource(agents)) {
    const mat = deps.materialize(group);
    if ("skip" in mat) {
      deps.warn(
        `topology preview check skipped for [${group.agents.join(", ")}]: ${mat.skip} - ` +
          "an unresolved capability in these contracts will NOT fail this preview",
      );
      continue;
    }
    const result = deps.compile(mat.root, argoDestinations);
    if (!result.ok) {
      throw new Error(
        `topology compile failed for agents [${group.agents.join(", ")}] from ${group.source}` +
          `${group.ref ? "#" + group.ref : ""}:\n${result.output}\n` +
          "Fix the findings above (each names its TOPO rule, the profile, and the change to make) - " +
          "an unresolved required capability must fail at preview, not as a restarting pod (#145).",
      );
    }
    const clashes = (result.bindings ?? []).filter(
      (b) => b.inject?.env !== undefined && reserved.has(b.inject.env),
    );
    if (clashes.length > 0) {
      throw new Error(
        clashes
          .map(
            (b) =>
              `capability ${b.capability} injects env ${b.inject!.env} into ${b.consumer}, but that ` +
              `variable is also delivered by an agentSecrets entry - the injection would silently ` +
              `SHADOW the secret's value (explicit env beats envFrom in Kubernetes)`,
          )
          .join("\n") +
          "\nRename the requires[].inject.env target (convention: HERMES_CAP_<NAME>_URL), or remove " +
          "the agentSecrets key. The chart's envGuard covers declared envRequires; this check covers " +
          "the agentSecrets keys the chart cannot see.",
      );
    }
  }
}
