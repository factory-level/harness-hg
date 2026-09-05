// hg gitops doctor: verify a bootstrapped GitOps repository against what
// the platform believes it wrote (design 10, ADR-37). Read-only, pure
// filesystem - no cluster, no state.json, no git operations. Findings in
// the ValidationFinding shape; errors fail the command, a legacy
// (pre-record) repo is warnings only - it still works, it just predates
// the lifecycle.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { ValidationFinding } from "../platform/index.ts";

const MANAGED_RECORD = "bootstrap/scaffold.yaml";

interface ScaffoldRecord {
  version?: number;
  managedFiles?: { path: string; sha256: string }[];
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function listDirs(base: string): string[] {
  // A doctor reports; it never throws on a malformed repo - a file where
  // a directory belongs, a dangling symlink, or a permission hole all
  // degrade to "nothing listed" and the shape checks name the oddity.
  try {
    return fs
      .readdirSync(base)
      .filter((e) => {
        try {
          return fs.statSync(path.join(base, e)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Every check over a bootstrapped GitOps repo. Pure: reads files under
 * `repo`, returns findings, mutates nothing. */
export function gitopsDoctor(repo: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const warn = (check: string, message: string, file?: string, fix?: string) =>
    findings.push({ profile: "*", severity: "warning", check, message, file, fix });
  const err = (check: string, message: string, file?: string, fix?: string) =>
    findings.push({ profile: "*", severity: "error", check, message, file, fix });

  if (!fs.existsSync(path.join(repo, "bootstrap"))) {
    err("scaffold", `${repo} has no bootstrap/ tree - not a scaffolded GitOps repository`);
    return findings;
  }

  // 1. The ownership manifest (ADR-37).
  const recordFile = path.join(repo, MANAGED_RECORD);
  if (!fs.existsSync(recordFile)) {
    warn(
      "scaffold-record",
      "bootstrap/scaffold.yaml is absent - this repository predates the managed-file " +
        "lifecycle; platform releases cannot reach its bootstrap files",
      MANAGED_RECORD,
      "run `hg gitops upgrade` to adopt it",
    );
  } else {
    let record: ScaffoldRecord = {};
    try {
      record = (parseYaml(fs.readFileSync(recordFile, "utf8")) as ScaffoldRecord) ?? {};
    } catch (e) {
      err("scaffold-record", `bootstrap/scaffold.yaml is unreadable: ${(e as Error).message}`, MANAGED_RECORD);
    }
    if (record.version !== undefined && record.version !== 2) {
      warn("scaffold-record", `scaffold.yaml version ${record.version} is unknown to this CLI (expected 2)`, MANAGED_RECORD);
    }
    // 2. Managed-file hashes: edited or deleted files are being REFUSED
    //    by the reconciler - doctor names each so the operator can decide.
    const entries = Array.isArray(record.managedFiles) ? record.managedFiles : [];
    if (record.managedFiles !== undefined && !Array.isArray(record.managedFiles)) {
      err("scaffold-record", "scaffold.yaml managedFiles is not a list - a malformed record", MANAGED_RECORD);
    }
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
        err("scaffold-record", `scaffold.yaml carries a malformed managedFiles entry: ${JSON.stringify(entry)}`, MANAGED_RECORD);
        continue;
      }
      const abs = path.join(repo, entry.path);
      if (!fs.existsSync(abs)) {
        warn(
          "managed-file",
          `${entry.path} is recorded as plugin-managed but deleted - the reconciler respects the deletion`,
          entry.path,
          "restore the file to resume management, or accept the deletion",
        );
        continue;
      }
      let onDisk: string;
      try {
        onDisk = fs.readFileSync(abs, "utf8");
      } catch (e) {
        warn("managed-file", `${entry.path} is unreadable: ${(e as Error).message}`, entry.path);
        continue;
      }
      if (sha256(onDisk) !== entry.sha256) {
        warn(
          "managed-file",
          `${entry.path} was edited since the plugin wrote it - platform updates to it are being refused`,
          entry.path,
          "revert the edit to resume management, or carry it deliberately",
        );
      }
    }
  }

  // 3. Generators present?
  const legacyGen = fs.existsSync(path.join(repo, "bootstrap", "applicationset.yaml"));
  const newGens = ["agents", "apps", "endpoints"].filter((n) =>
    fs.existsSync(path.join(repo, "bootstrap", "applicationsets", `${n}.yaml`)),
  );
  if (!legacyGen && newGens.length === 0) {
    err("generators", "no ApplicationSet at all - nothing reconciles this repository");
  } else if (newGens.length > 0 && newGens.length < 3) {
    err(
      "generators",
      `partial generator set: bootstrap/applicationsets/ has [${newGens.join(", ")}] - agents, apps and endpoints ship together`,
    );
  }

  // 4. Records vs catalogue: a profiles/ record whose catalogue twin is
  //    missing was emitted before the catalogue existed.
  const profiles = listDirs(path.join(repo, "profiles"));
  for (const name of profiles) {
    if (!fs.existsSync(path.join(repo, "profiles", name, "profile.yaml"))) continue;
    if (!fs.existsSync(path.join(repo, "catalog", "profiles", name, "contract.yaml"))) {
      warn(
        "catalogue",
        `profiles/${name} has no catalog/profiles/${name} twin - emitted before the catalogue existed`,
        `profiles/${name}/profile.yaml`,
        "reinstall the profile (any publish co-writes the catalogue), or run `hg gitops upgrade`",
      );
    }
  }

  // 5. deployments/ vs plan.yaml: every planned instance has its record
  //    directory and every directory is planned - a mismatch means the
  //    tree was hand-touched or a regeneration was interrupted.
  const planFile = path.join(repo, "deployments", "plan.yaml");
  if (fs.existsSync(planFile)) {
    let plan: { agents?: string[]; apps?: string[] } = {};
    try {
      plan = (parseYaml(fs.readFileSync(planFile, "utf8")) as typeof plan) ?? {};
    } catch (e) {
      err("plan", `deployments/plan.yaml is unreadable: ${(e as Error).message}`, "deployments/plan.yaml");
    }
    const flat = (id: string) => id.replace(/[@/]/g, "-");
    for (const kind of ["agents", "apps"] as const) {
      const raw = (plan as Record<string, unknown>)[kind];
      if (raw !== undefined && !Array.isArray(raw)) {
        err("plan", `plan.yaml ${kind} is not a list - a malformed plan`, "deployments/plan.yaml", "re-run hg topology emit");
        continue;
      }
      const ids = (raw ?? []) as string[];
      const dirs = new Set(listDirs(path.join(repo, "deployments", kind)));
      for (const id of ids) {
        if (!dirs.has(flat(id))) {
          err("plan", `plan.yaml lists ${kind} instance ${id} but deployments/${kind}/${flat(id)}/ is missing`, "deployments/plan.yaml", "re-run `hg topology emit`");
        }
        dirs.delete(flat(id));
      }
      for (const orphan of dirs) {
        err("plan", `deployments/${kind}/${orphan}/ exists but plan.yaml does not list it - stale or hand-added`, `deployments/${kind}/${orphan}`, "re-run `hg topology emit`");
      }
    }
  } else if (fs.existsSync(path.join(repo, "deployments"))) {
    err("plan", "deployments/ exists without plan.yaml - an interrupted or hand-built tree", "deployments", "re-run `hg topology emit`");
  }

  return findings;
}

// ---------------------------------------------------------------------------
// hg gitops upgrade: adopt a legacy (pre-lifecycle) repository - one
// reviewable working-tree change, NEVER pushed by this command. The
// operator reviews, runs the printed cluster pre-flight, then pushes.

import { contractFromRecord } from "../topology/contract.ts";
import { defaultEnvironment } from "../topology/environment.ts";
import { compile } from "../topology/compile.ts";
import { renderTree, writeTree } from "../topology/emit.ts";
import { PLATFORM_ROOT } from "../lib.ts";

/** cluster-values' appProject.sourceRepos with every oci:// entry doubled by
 * its scheme-less twin (#187) - sorted, deduplicated, empty when absent. */
export function operatorSourceRepos(repo: string): string[] {
  const file = path.join(repo, "bootstrap", "values", "cluster-values.yaml");
  if (!fs.existsSync(file)) return [];
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as { appProject?: { sourceRepos?: unknown } } | null;
  const repos = doc?.appProject?.sourceRepos;
  if (!Array.isArray(repos)) return [];
  const out = new Set<string>();
  for (const r of repos) {
    // URL-shaped only, so a rendered item can never change the YAML node it
    // lands in (mirrors scaffold.py's _REPO_URL_RE).
    if (typeof r !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~:/@%+-]*$/.test(r)) {
      throw new Error("cluster-values appProject.sourceRepos must be a list of repository URLs (no whitespace, quotes or '#')");
    }
    out.add(r);
    if (r.startsWith("oci://")) out.add(r.slice("oci://".length));
  }
  return [...out].sort();
}

const UPGRADE_MANAGED = [
  "bootstrap/project.yaml",
  "bootstrap/applicationsets/agents.yaml",
  "bootstrap/applicationsets/apps.yaml",
  "bootstrap/applicationsets/endpoints.yaml",
];

interface Substitutions {
  gitopsRepoUrl: string;
  gitopsBranch: string;
  hermesGitopsRepoUrl: string;
  chartRevision: string;
}

/** The legacy applicationset.yaml carries every substituted value this
 * repo was scaffolded with - extract rather than ask. */
export function extractSubstitutions(legacyText: string): Substitutions {
  const doc = parseYaml(legacyText) as {
    spec?: {
      generators?: { git?: { repoURL?: string; revision?: string } }[];
      template?: { spec?: { sources?: { repoURL?: string; targetRevision?: string; path?: string }[] } };
    };
  };
  const git = doc.spec?.generators?.[0]?.git ?? {};
  const chartSource = (doc.spec?.template?.spec?.sources ?? []).find((s) => s.path);
  if (!git.repoURL || !git.revision || !chartSource?.repoURL || !chartSource.targetRevision) {
    throw new Error(
      "bootstrap/applicationset.yaml does not carry the expected substituted values - cannot derive the scaffold substitutions",
    );
  }
  return {
    gitopsRepoUrl: git.repoURL,
    gitopsBranch: git.revision,
    hermesGitopsRepoUrl: chartSource.repoURL,
    chartRevision: chartSource.targetRevision,
  };
}

export interface UpgradeResult {
  written: string[];
  deleted: string[];
  preflight: string[]; // the kubectl commands the operator runs BEFORE pushing
  findings: ValidationFinding[];
}

/** Convert a legacy repo in the working tree: environment/ synthesized
 * from cluster-values, records reconstructed into the catalogue, the
 * fleet compiled into deployments/, the three generators written with the
 * extracted substitutions, the legacy generator deleted, scaffold.yaml
 * adopted. profiles/ STAYS - the records are the agents generator's WHAT
 * layer until the hermesprofile record bump. */
export function gitopsUpgrade(repo: string): UpgradeResult {
  const pre = gitopsDoctor(repo);
  const hardErrors = pre.filter((f) => f.severity === "error");
  if (hardErrors.length > 0) {
    return { written: [], deleted: [], preflight: [], findings: pre };
  }
  if (fs.existsSync(path.join(repo, MANAGED_RECORD))) {
    return {
      written: [],
      deleted: [],
      preflight: [],
      findings: [
        ...pre,
        { profile: "*", severity: "error", check: "upgrade", message: "already adopted - bootstrap/scaffold.yaml exists (the reconciler manages this repo)" },
      ],
    };
  }
  const legacyFile = path.join(repo, "bootstrap", "applicationset.yaml");
  if (!fs.existsSync(legacyFile)) {
    return {
      written: [],
      deleted: [],
      preflight: [],
      findings: [...pre, { profile: "*", severity: "error", check: "upgrade", message: "no legacy bootstrap/applicationset.yaml - nothing to upgrade from" }],
    };
  }
  // A half-migrated tree is refused, never silently normalized - the
  // writeTree prune would delete anything it did not render.
  for (const tree of ["catalog", "deployments"]) {
    if (fs.existsSync(path.join(repo, tree))) {
      return {
        written: [],
        deleted: [],
        preflight: [],
        findings: [
          ...pre,
          {
            profile: "*",
            severity: "error",
            check: "upgrade",
            message: `${tree}/ already exists - a half-migrated tree; remove it (or finish by hand) before upgrading`,
          },
        ],
      };
    }
  }
  const subs = extractSubstitutions(fs.readFileSync(legacyFile, "utf8"));

  // COMPILE FIRST - every failure path must leave the tree untouched, so
  // reconstruction and compilation happen before the first write.
  const contracts = [];
  const catalogue = new Map<string, string>();
  const shaByProfile = new Map<string, string>();
  for (const name of listDirs(path.join(repo, "profiles"))) {
    const recordFile = path.join(repo, "profiles", name, "profile.yaml");
    if (!fs.existsSync(recordFile)) continue;
    const record = parseYaml(fs.readFileSync(recordFile, "utf8")) as { spec?: Record<string, unknown> };
    const spec = record?.spec ?? {};
    const { contract, authored } = contractFromRecord(name, spec);
    contracts.push(contract);
    catalogue.set(name, authored);
    if (typeof spec["sha"] === "string") {
      shaByProfile.set(name, spec["sha"]);
    }
  }
  const env = defaultEnvironment();
  const plan = compile(contracts, env, {});
  if (!plan.ok) {
    return { written: [], deleted: [], preflight: [], findings: [...pre, ...plan.findings] };
  }

  const written: string[] = [];
  const writeRel = (rel: string, content: string) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(rel);
  };

  // 1. environment/: the sole target IS today's cluster, byte-copying its
  //    values; policy lifts the sourceRepos allowlist as the one authority.
  const clusterValuesFile = path.join(repo, "bootstrap", "values", "cluster-values.yaml");
  const clusterValuesText = fs.existsSync(clusterValuesFile) ? fs.readFileSync(clusterValuesFile, "utf8") : "";
  writeRel("environment/targets/in-cluster/values.yaml", clusterValuesText || "# no cluster-values.yaml found\n");
  writeRel(
    "environment/topology.yaml",
    [
      "# Synthesized by `hg gitops upgrade`: the single-target topology this",
      "# repository already runs. Grow it deliberately (design 10).",
      "version: 1",
      "layout: single",
      "regions:",
      "  - name: local",
      "    jurisdiction: NA",
      "    targets:",
      "      - name: in-cluster",
      "        argoDestination: in-cluster",
      "",
    ].join("\n"),
  );
  const clusterValues = (parseYaml(clusterValuesText || "{}") as { appProject?: { sourceRepos?: string[] } }) ?? {};
  const sourceRepos = (clusterValues.appProject?.sourceRepos ?? []).filter((r) => typeof r === "string");
  writeRel(
    "environment/policy.yaml",
    "# Synthesized by `hg gitops upgrade` from cluster-values appProject.sourceRepos.\n" +
      (sourceRepos.length
        ? "allowedChartSources:\n" + sourceRepos.map((r) => `  - ${r}`).join("\n") + "\n"
        : "{}\n"),
  );

  // 2. Records -> catalogue + compiled deployments (compiled above).
  // Per-profile provenance: records naturally come from different repos
  // and commits; each keeps its own sha (zeros only for a sha-less record).
  const tree = renderTree(repo, contracts, plan, env, {
    sourceSha: "0".repeat(40),
    catalogue,
    sourceShaByProfile: shaByProfile,
  });
  const emitResult = writeTree(repo, tree);
  written.push(...emitResult.written);

  // 3. The three generators, rendered from the platform's template with
  //    the substitutions the legacy generator carried.
  const tokens: Record<string, string> = {
    __GITOPS_REPO_URL__: subs.gitopsRepoUrl,
    __GITOPS_BRANCH__: subs.gitopsBranch,
    __HERMES_GITOPS_REPO_URL__: subs.hermesGitopsRepoUrl,
    __CHART_REVISION__: subs.chartRevision,
    // The environment's half of the AppProject allowlist, from cluster-values
    // (mirrors scaffold.py's operator_source_repos: oci:// entries twinned).
    "__OPERATOR_SOURCE_REPOS__\n": operatorSourceRepos(repo)
      .map((r) => `    - ${r}\n`)
      .join(""),
  };
  const hashes: Record<string, string> = {};
  for (const rel of UPGRADE_MANAGED) {
    if (rel === "bootstrap/project.yaml") {
      // project.yaml pre-exists (seeded); adopt its CURRENT bytes rather
      // than overwrite an operator-tuned allowlist. A seeded copy that
      // still carries the whole-line allowlist token (never rendered)
      // gets it rendered first - adopting a literal token would record an
      // invalid AppProject as the plugin's own.
      const existing = path.join(repo, rel);
      if (fs.existsSync(existing)) {
        let current = fs.readFileSync(existing, "utf8");
        const slot = "__OPERATOR_SOURCE_REPOS__\n";
        if (current.includes(slot)) {
          current = current.replaceAll(slot, tokens[slot]!);
          writeRel(rel, current);
        }
        hashes[rel] = sha256(current);
        continue;
      }
    }
    const template = path.join(PLATFORM_ROOT, "infra", "gitops-template", rel);
    let text = fs.readFileSync(template, "utf8");
    for (const [token, value] of Object.entries(tokens)) text = text.replaceAll(token, value);
    writeRel(rel, text);
    hashes[rel] = sha256(text);
  }

  // 4. Delete the legacy generator; adopt via scaffold.yaml.
  fs.rmSync(legacyFile);
  const record = {
    version: 2,
    templateRevision: subs.chartRevision,
    substitutions: subs,
    managedFiles: Object.keys(hashes)
      .sort()
      .map((p) => ({ path: p, sha256: hashes[p]! })),
  };
  writeRel(MANAGED_RECORD, yamlStringify(record, { sortMapEntries: true }));

  const preflight = [
    "# BEFORE pushing this commit, run against the argocd namespace so deleting",
    "# the legacy generator can never cascade into workload deletion:",
    "kubectl -n argocd patch applicationset hermes-gitops-profiles --type merge -p '{\"spec\":{\"syncPolicy\":{\"preserveResourcesOnDeletion\":true}}}'",
    "kubectl -n argocd get applications -l hermes-gitops.factorylevel.dev/managed=true -o name | xargs -r -I{} kubectl -n argocd patch {} --type json -p '[{\"op\":\"remove\",\"path\":\"/metadata/finalizers\"}]'",
    "# After Argo picks up the new generators and every Application is Synced/Healthy,",
    "# delete the legacy ApplicationSet object:",
    "kubectl -n argocd delete applicationset hermes-gitops-profiles",
  ];
  return { written, deleted: ["bootstrap/applicationset.yaml"], preflight, findings: pre };
}
