// hg topology doctor: repository lint on top of compilation, the --deep
// chart cross-check, and the --fix mechanical v2 upgrade (design 10
// §safe fixes). Lint findings are warnings - the compiler's TOPO rules
// stay the errors.

import * as fs from "node:fs";
import { agentLayout } from "../layout.ts";
import * as path from "node:path";
import { isMap, parseDocument } from "yaml";
import { PLATFORM_ROOT } from "../lib.ts";
import type { ValidationFinding } from "../platform/index.ts";
import { discoverContractDirs, type Contract } from "./contract.ts";
import type { TopologyPlan } from "./compile.ts";

// Cluster-internal URL literal: http(s)://<svc-ish-host>.svc[.cluster.local][:port][/path]
const CLUSTER_URL_RE =
  /https?:\/\/[a-z0-9][a-z0-9.-]*\.svc(?:\.cluster\.local)?(?![\w.-])(?::\d+)?(?:\/\S*)?/gi;

function walkStrings(node: unknown, at: string, hit: (value: string, at: string) => void): void {
  if (typeof node === "string") hit(node, at);
  else if (Array.isArray(node)) node.forEach((v, i) => walkStrings(v, `${at}[${i}]`, hit));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walkStrings(v, at ? `${at}.${k}` : k, hit);
  }
}

/** Warnings for hardcoded cluster URLs - in authored values (the relay
 * literal, copy-pasted across four profiles) and in agent-readable prose
 * (SOUL.md, skills/), where a dependency can hide from every schema. */
export function lintRepo(root: string, contracts: Contract[], plan: TopologyPlan): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  // service.namespace prefixes of every compiled internal endpoint, so a
  // literal that IS a declared endpoint gets named and a fix suggested.
  const endpointHosts = new Map<string, string>(); // "svc.ns" -> binding id + capability
  for (const e of plan.endpoints) {
    const host = e.internalUrl.replace(/^https?:\/\//, "").split(".svc")[0]!;
    endpointHosts.set(host, e.provides ? `${e.id} (provides ${e.provides})` : e.id);
  }
  const byProfile = new Map(contracts.map((c) => [c.subdir, c] as const));
  for (const { dir, subdir } of discoverContractDirs(root)) {
    const contract = byProfile.get(subdir);
    if (!contract) continue;
    const layout = agentLayout(dir);
    const contractFiles = layout.legacy
      ? [layout.agentFile]
      : fs.readdirSync(layout.contractDir).sort().filter((f) => f.endsWith(".yaml")).map((f) => path.join(layout.contractDir, f));
    for (const extFile of contractFiles) {
      if (!fs.existsSync(extFile)) continue;
      const doc = parseDocument(fs.readFileSync(extFile, "utf8")).toJS() as unknown;
      walkStrings(doc, "", (value, at) => {
        for (const m of value.match(CLUSTER_URL_RE) ?? []) {
          const host = m.replace(/^https?:\/\//, "").split(".svc")[0]!;
          const known = endpointHosts.get(host);
          findings.push({
            profile: contract.profile,
            severity: "warning",
            check: "hardcoded-cluster-url",
            message: known
              ? `${at} hardcodes ${m}, which is declared endpoint ${known}`
              : `${at} hardcodes cluster URL ${m}`,
            file: path.relative(root, extFile),
            fix: "declare a requires[] capability and inject the resolved URL (contract v2) instead of a literal",
          });
        }
      });
    }
    // Prose: SOUL.md and skills/**/*.md - the research->kanban failure
    // mode, a dependency visible to the agent and to nothing else.
    const proseFiles = [path.join(dir, "SOUL.md")];
    const skillsDir = path.join(dir, "skills");
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { recursive: true }) as string[]) {
        if (entry.endsWith(".md")) proseFiles.push(path.join(skillsDir, entry));
      }
    }
    for (const file of proseFiles) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.match(CLUSTER_URL_RE) ?? []) {
        findings.push({
          profile: contract.profile,
          severity: "warning",
          check: "prose-cluster-url",
          message: `hardcoded cluster URL in agent-readable prose: ${m}`,
          file: path.relative(root, file),
          fix: "inject the URL as an env var via requires[] (HERMES_CAP_*) and reference the variable in prose",
        });
      }
    }
    // #437: the chart backup routines tar the data PVC (HERMES_HOME) and
    // nothing else. Hermes' own backup walks the active memory provider's
    // backup_paths() - ~/.honcho, ~/.hindsight - which live OUTSIDE the
    // volume, so a profile that configures such a provider has memory in
    // no backup the platform takes, while every backup surface stays
    // green. No deployed profile sets memory.provider today (recorded in
    // _docs/wiki/platform/backups.md); this lint is the
    // guard that keeps a future one from landing silently.
    const configFile = path.join(dir, "config.yaml");
    if (fs.existsSync(configFile)) {
      const cfg = parseDocument(fs.readFileSync(configFile, "utf8")).toJS() as {
        memory?: { provider?: unknown };
      } | null;
      const provider = cfg?.memory?.provider;
      if (typeof provider === "string" && provider.length > 0) {
        findings.push({
          profile: contract.profile,
          severity: "warning",
          check: "memory-provider-backup-coverage",
          message:
            `config.yaml sets memory.provider: ${provider} - upstream Hermes archives that ` +
            "provider's external paths (hermes_cli/backup.py backup_paths()) but the chart's " +
            "backup routine tars only the data volume, so its memory state would be in NO " +
            "platform backup",
          file: path.relative(root, configFile),
          fix: "keep memory state under the data volume (HERMES_HOME), or add a covering routine and name it in hermes.dev/backup-protects",
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// --deep: render the pinned charts, cross-check declared endpoints

function helmAvailable(): boolean {
  return Bun.spawnSync(["helm", "version", "--short"]).exitCode === 0;
}

function chartDirFor(root: string, app: { chart: string; repo: string; version?: string }, cache: string): string | undefined {
  if (app.repo === "local") {
    // Local charts live in the platform tree; the inspected repo may
    // carry its own charts/ as well - prefer the repo's copy.
    for (const base of [root, PLATFORM_ROOT]) {
      const dir = path.join(base, app.chart);
      if (fs.existsSync(path.join(dir, "Chart.yaml"))) return dir;
    }
    return undefined;
  }
  // The persona convention: OCI charts also live in the repo's charts/
  // tree (published from there) - use the in-repo source when present, so
  // --deep works offline; else pull the pinned version into the cache.
  const inRepo = path.join(root, "charts", app.chart);
  if (fs.existsSync(path.join(inRepo, "Chart.yaml"))) return inRepo;
  const dest = path.join(cache, `${app.chart}-${app.version}`);
  if (fs.existsSync(path.join(dest, app.chart, "Chart.yaml"))) return path.join(dest, app.chart);
  fs.mkdirSync(dest, { recursive: true });
  const pull = Bun.spawnSync(["helm", "pull", `${app.repo.replace(/\/$/, "")}/${app.chart}`, "--version", app.version ?? "", "--untar", "--untardir", dest]);
  if (pull.exitCode !== 0) return undefined;
  return path.join(dest, app.chart);
}

/** Render each app chart that declares endpoints and assert the declared
 * Service/port actually exist in the rendered output. Warning-level:
 * final Service names depend on release wiring until the ApplicationSet
 * cutover, so a mismatch is a signal, not a verdict. */
export function deepCheck(root: string, contracts: Contract[], cacheDir: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (!helmAvailable()) {
    return [
      {
        profile: "*",
        severity: "warning",
        check: "deep-skipped",
        message: "helm is not available - --deep chart cross-checks were skipped",
      },
    ];
  }
  for (const c of contracts) {
    for (const app of c.apps) {
      if (app.endpoints.length === 0) continue;
      const chartDir = chartDirFor(root, app, cacheDir);
      if (!chartDir) {
        findings.push({
          profile: c.profile,
          severity: "warning",
          check: "deep-chart-missing",
          message: `app ${app.name}: chart ${app.chart} (${app.repo}) could not be resolved for rendering`,
        });
        continue;
      }
      // Render with the AUTHORED values - a chart whose values rename or
      // gate its Service must be checked in the app's own configuration.
      const helmArgs = ["helm", "template", app.name, chartDir];
      let valuesFile: string | undefined;
      if (app.values && Object.keys(app.values).length > 0) {
        valuesFile = path.join(cacheDir, `${c.profile}-${app.name}-values.json`);
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(valuesFile, JSON.stringify(app.values));
        helmArgs.push("-f", valuesFile);
      }
      const rendered = Bun.spawnSync(helmArgs);
      if (valuesFile) fs.rmSync(valuesFile, { force: true });
      if (rendered.exitCode !== 0) {
        findings.push({
          profile: c.profile,
          severity: "warning",
          check: "deep-render-failed",
          message: `app ${app.name}: helm template failed: ${rendered.stderr.toString().trim().split("\n").pop()}`,
        });
        continue;
      }
      // Collect rendered Services: name -> ports
      const services = new Map<string, Set<number>>();
      for (const docText of rendered.stdout.toString().split(/^---$/m)) {
        if (!/kind:\s*Service\s*$/m.test(docText)) continue;
        const name = /name:\s*(\S+)/.exec(docText)?.[1];
        if (!name) continue;
        const ports = new Set<number>();
        for (const p of docText.matchAll(/\bport:\s*(\d+)/g)) ports.add(Number(p[1]));
        services.set(name, ports);
      }
      for (const e of app.endpoints) {
        const svc = e.service ?? app.name;
        let match = services.get(svc);
        if (!match) {
          // Suffix fallback (release-prefixed names) only when UNIQUE -
          // two candidates would let the wrong Service validate the port.
          const suffixed = [...services.entries()].filter(([n]) => n.endsWith(`-${svc}`));
          if (suffixed.length === 1) match = suffixed[0]![1];
          else if (suffixed.length > 1) {
            findings.push({
              profile: c.profile,
              severity: "warning",
              check: "deep-endpoint-ambiguous",
              message: `app ${app.name} endpoint ${e.name}: ${suffixed.length} rendered Services end in -${svc} (${suffixed.map(([n]) => n).join(", ")}) - declare the exact name`,
            });
            continue;
          }
        }
        if (!match) {
          findings.push({
            profile: c.profile,
            severity: "warning",
            check: "deep-endpoint-service",
            message: `app ${app.name} endpoint ${e.name}: no rendered Service named ${svc} (rendered: ${[...services.keys()].join(", ") || "none"})`,
          });
        } else if (!match.has(e.port)) {
          findings.push({
            profile: c.profile,
            severity: "warning",
            check: "deep-endpoint-port",
            message: `app ${app.name} endpoint ${e.name}: Service ${svc} does not expose port ${e.port} (has: ${[...match].join(", ")})`,
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// --fix: the mechanical v2 upgrade, comment-preserving and idempotent

export interface FixResult {
  file: string;
  changed: boolean;
  before: string;
  after: string;
}

/** Upgrade one hermes-gitops.yaml to contract v2 IN PLACE semantically:
 * add contractVersion: 2 and EXPLICIT topology blocks carrying the legacy
 * defaults (supportedLayouts [single]; agent singleton/target; apps
 * per-agent/target). Nothing else changes - expose stays (the record
 * still renders it; the compiler projects it onto endpoints), values and
 * comments survive via the yaml document API. Running twice is a no-op. */
export function fixToV2(file: string): FixResult {
  const before = fs.readFileSync(file, "utf8");
  const doc = parseDocument(before);
  if (doc.contents !== null && !isMap(doc.contents)) {
    // A sequence/scalar root is not a contract - refuse rather than risk
    // rebuilding it into something else (the caller reports per file).
    throw new Error(`${file}: root is not a mapping - refusing to rewrite`);
  }
  if (doc.contents === null) doc.set("contractVersion", 2);
  if (!doc.has("contractVersion")) {
    // New keys land at the TOP so the version marker leads the file.
    const rest = parseDocument(before);
    const fresh = parseDocument("contractVersion: 2\n");
    if (rest.contents && fresh.contents && isMap(rest.contents) && isMap(fresh.contents)) {
      // Rebuild: marker + topology, then the original mapping items.
      const topo = parseDocument(
        "topology:\n  supportedLayouts: [single]\n  agent:\n    multiplicity: singleton\n    dataBoundary: target\n",
      );
      // @ts-expect-error yaml collection internals - items are YAMLMap pairs
      fresh.contents.items.push(...topo.contents.items, ...rest.contents.items);
    }
    let out = fresh.toString();
    // Per-app explicit topology, via the document API on the rebuilt text.
    const rebuilt = parseDocument(out);
    const apps = rebuilt.get("apps") as { items?: unknown[] } | undefined;
    if (apps?.items) {
      apps.items.forEach((_item, i) => {
        if (!rebuilt.hasIn(["apps", i, "topology"])) {
          rebuilt.setIn(["apps", i, "topology"], rebuilt.createNode({ multiplicity: "per-agent", dataBoundary: "target" }));
        }
      });
      out = rebuilt.toString();
    }
    return { file, changed: out !== before, before, after: out };
  }
  // Already v2: only fill missing explicit blocks.
  if (!doc.has("topology")) {
    doc.set(
      "topology",
      doc.createNode({ supportedLayouts: ["single"], agent: { multiplicity: "singleton", dataBoundary: "target" } }),
    );
  }
  const apps = doc.get("apps") as { items?: unknown[] } | undefined;
  if (apps?.items) {
    apps.items.forEach((_item, i) => {
      if (!doc.hasIn(["apps", i, "topology"])) {
        doc.setIn(["apps", i, "topology"], doc.createNode({ multiplicity: "per-agent", dataBoundary: "target" }));
      }
    });
  }
  const after = doc.toString();
  return { file, changed: after !== before, before, after };
}
