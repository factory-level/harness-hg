// hg gitops doctor, offline: synthesized GitOps repositories in tmpdirs.

import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yaml } from "yaml";
import { gitopsDoctor } from "../src/gitops/index.ts";

function sha(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A pristine post-lifecycle repo: record + generators + one profile with
 * its catalogue twin + a deployments tree matching plan.yaml. */
function pristineRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gitops-doctor-"));
  const managed: Record<string, string> = {
    "bootstrap/project.yaml": "kind: AppProject\n",
    "bootstrap/applicationset.yaml": "kind: ApplicationSet\n",
    "bootstrap/applicationsets/agents.yaml": "kind: ApplicationSet # agents\n",
    "bootstrap/applicationsets/apps.yaml": "kind: ApplicationSet # apps\n",
    "bootstrap/applicationsets/endpoints.yaml": "kind: ApplicationSet # endpoints\n",
  };
  for (const [rel, content] of Object.entries(managed)) write(root, rel, content);
  write(
    root,
    "bootstrap/scaffold.yaml",
    yaml({
      version: 2,
      managedFiles: Object.entries(managed).map(([p, c]) => ({ path: p, sha256: sha(c) })),
    }),
  );
  write(root, "profiles/p/profile.yaml", "spec: {persona: p}\n");
  write(root, "catalog/profiles/p/contract.yaml", "# authored\n");
  write(root, "deployments/agents/p/deployment.yaml", "spec: {}\n");
  write(root, "deployments/apps/p-monitoring/deployment.yaml", "spec: {}\n");
  write(root, "deployments/plan.yaml", yaml({ agents: ["p"], apps: ["p/monitoring"] }));
  return root;
}

describe("gitopsDoctor", () => {
  test("a pristine post-lifecycle repo is clean", () => {
    expect(gitopsDoctor(pristineRepo())).toEqual([]);
  });

  test("an edited managed file is a warning naming it", () => {
    const root = pristineRepo();
    writeFileSync(join(root, "bootstrap", "project.yaml"), "kind: AppProject # edited\n");
    const findings = gitopsDoctor(root);
    expect(findings.length).toBe(1);
    expect(findings[0]!.check).toBe("managed-file");
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain("project.yaml");
  });

  test("a deleted managed file is a warning, not an error", () => {
    const root = pristineRepo();
    rmSync(join(root, "bootstrap", "applicationsets", "endpoints.yaml"));
    const findings = gitopsDoctor(root);
    // the deletion warning AND the partial-generator error both fire
    expect(findings.some((f) => f.check === "managed-file" && f.severity === "warning" && f.message.includes("deleted"))).toBe(true);
    expect(findings.some((f) => f.check === "generators" && f.severity === "error")).toBe(true);
  });

  test("a pre-lifecycle repo is warnings only and exits ok", () => {
    const root = pristineRepo();
    rmSync(join(root, "bootstrap", "scaffold.yaml"));
    const findings = gitopsDoctor(root);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
    expect(findings.some((f) => f.check === "scaffold-record")).toBe(true);
  });

  test("a profiles/ record without its catalogue twin is named", () => {
    const root = pristineRepo();
    rmSync(join(root, "catalog", "profiles", "p", "contract.yaml"));
    const findings = gitopsDoctor(root);
    expect(findings.some((f) => f.check === "catalogue" && f.message.includes("profiles/p"))).toBe(true);
  });

  test("deployments/ vs plan.yaml mismatches are errors both directions", () => {
    const root = pristineRepo();
    rmSync(join(root, "deployments", "apps", "p-monitoring"), { recursive: true });
    write(root, "deployments/agents/stale-thing/deployment.yaml", "spec: {}\n");
    const findings = gitopsDoctor(root);
    expect(findings.filter((f) => f.check === "plan" && f.severity === "error").length).toBe(2);
  });

  test("no bootstrap tree at all is a hard error", () => {
    const root = mkdtempSync(join(tmpdir(), "gitops-doctor-"));
    const findings = gitopsDoctor(root);
    expect(findings[0]!.severity).toBe("error");
  });
});

describe("hg gitops doctor CLI (subprocess)", () => {
  const MAIN = join(import.meta.dir, "..", "src", "main.ts");
  function hg(args: string[]): { code: number; stdout: string } {
    const home = mkdtempSync(join(tmpdir(), "gitops-home-"));
    const proc = Bun.spawnSync(["bun", MAIN, ...args], {
      env: { ...process.env, HERMES_GITOPS_HOME: home },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString() };
  }

  test("warnings-only exits zero; errors emit the JSON document before failing", () => {
    const legacy = pristineRepo();
    rmSync(join(legacy, "bootstrap", "scaffold.yaml"));
    const okRun = hg(["gitops", "doctor", legacy, "--json"]);
    expect(okRun.code).toBe(0);
    expect(JSON.parse(okRun.stdout).ok).toBe(true);

    const broken = mkdtempSync(join(tmpdir(), "gitops-empty-"));
    const failRun = hg(["gitops", "doctor", broken, "--json"]);
    expect(failRun.code).toBe(1);
    const doc = JSON.parse(failRun.stdout); // document BEFORE the throw
    expect(doc.ok).toBe(false);
  });

  test("a malformed record and plan degrade to findings, never a crash", () => {
    const root = pristineRepo();
    writeFileSync(join(root, "bootstrap", "scaffold.yaml"), "version: 2\nmanagedFiles: 1\n");
    writeFileSync(join(root, "deployments", "plan.yaml"), "agents: not-a-list\napps: []\n");
    const findings = gitopsDoctor(root);
    expect(findings.some((f) => f.check === "scaffold-record" && f.message.includes("not a list"))).toBe(true);
    expect(findings.some((f) => f.check === "plan" && f.message.includes("not a list"))).toBe(true);
  });
});

const TEMPLATE = join(import.meta.dir, "..", "..", "infra", "gitops-template", "bootstrap", "applicationset.yaml");

describe("operatorSourceRepos", () => {
  test("twins oci:// entries scheme-less, sorted and deduplicated; absent file is empty", async () => {
    const { operatorSourceRepos } = await import("../src/gitops/index.ts");
    const root = mkdtempSync(join(tmpdir(), "gitops-repos-"));
    expect(operatorSourceRepos(root)).toEqual([]);
    write(root, "bootstrap/values/cluster-values.yaml", yaml({ appProject: { sourceRepos: ["oci://r.example/c", "https://h.example/x", "r.example/c"] } }));
    expect(operatorSourceRepos(root)).toEqual(["https://h.example/x", "oci://r.example/c", "r.example/c"]);
  });

  test("refuses an entry that is not URL-shaped (YAML injection)", async () => {
    const { operatorSourceRepos } = await import("../src/gitops/index.ts");
    const root = mkdtempSync(join(tmpdir(), "gitops-repos-"));
    write(root, "bootstrap/values/cluster-values.yaml", yaml({ appProject: { sourceRepos: ["https://h.example/x # mirror"] } }));
    expect(() => operatorSourceRepos(root)).toThrow(/repository URLs/);
  });

  test("upgrade renders a seeded project.yaml that still carries the allowlist token", async () => {
    const { gitopsUpgrade } = await import("../src/gitops/index.ts");
    const { parse } = await import("yaml");
    const root = legacyRepo();
    write(root, "bootstrap/project.yaml", "spec:\n  sourceRepos:\n    - https://git.example/fleet.git\n__OPERATOR_SOURCE_REPOS__\n");
    gitopsUpgrade(root);
    const text = readFileSync(join(root, "bootstrap", "project.yaml"), "utf8");
    expect(text).not.toContain("__OPERATOR_SOURCE_REPOS__");
    expect(text).toContain("    - ghcr.io/factory-level/charts\n    - oci://ghcr.io/factory-level/charts\n");
    const record = parse(readFileSync(join(root, "bootstrap", "scaffold.yaml"), "utf8"));
    const entry = record.managedFiles.find((e: { path: string }) => e.path === "bootstrap/project.yaml");
    expect(entry.sha256).toBe(sha(text));
  });
});

function legacyRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "gitops-upgrade-"));
    let legacy = readFileSync(TEMPLATE, "utf8");
    for (const [token, value] of Object.entries({
      __GITOPS_REPO_URL__: "https://git.example/fleet.git",
      __GITOPS_BRANCH__: "main",
      __HERMES_GITOPS_REPO_URL__: "https://git.example/platform.git",
      __CHART_REVISION__: "v1.2.3",
    })) legacy = legacy.replaceAll(token, value);
    write(root, "bootstrap/applicationset.yaml", legacy);
    write(root, "bootstrap/project.yaml", "kind: AppProject # operator-tuned\n");
    write(
      root,
      "bootstrap/values/cluster-values.yaml",
      yaml({ providers: { compute: "pod", secret: "k8s", ingress: "ingress" }, appProject: { sourceRepos: ["oci://ghcr.io/factory-level/charts"] } }),
    );
    write(
      root,
      "profiles/persona-b/profile.yaml",
      yaml({
        spec: {
          persona: "persona-b",
          source: "https://git.example/other.git",
          sha: "b".repeat(40),
          apps: [{ name: "monitoring", chart: "charts/monitoring", repo: "local" }],
        },
      }),
    );
    write(
      root,
      "profiles/persona-a/profile.yaml",
      yaml({
        spec: {
          persona: "persona-a",
          source: "https://git.example/personas.git",
          sha: "a".repeat(40),
          apps: [{ name: "monitoring", chart: "charts/monitoring", repo: "local" }],
          expose: { services: [{ name: "dashboard", port: 9119, path: "/" }] },
          backup: { schedule: "0 3 * * *" },
          envRequires: ["ANTHROPIC_API_KEY"],
        },
      }),
    );
  return root;
}

describe("gitopsUpgrade (legacy adoption, working-tree only)", () => {
  test("the full adoption: environment, catalogue, deployments, generators, manifest", async () => {
    const { gitopsUpgrade } = await import("../src/gitops/index.ts");
    const { parse } = await import("yaml");
    const root = legacyRepo();
    const result = gitopsUpgrade(root);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.deleted).toEqual(["bootstrap/applicationset.yaml"]);
    expect(existsSync(join(root, "bootstrap", "applicationset.yaml"))).toBe(false);
    // profiles/ STAYS - the agents generator's WHAT layer
    expect(existsSync(join(root, "profiles", "persona-a", "profile.yaml"))).toBe(true);

    // environment synthesized; policy lifts the allowlist
    expect(readFileSync(join(root, "environment", "topology.yaml"), "utf8")).toContain("layout: single");
    expect(readFileSync(join(root, "environment", "policy.yaml"), "utf8")).toContain("oci://ghcr.io/factory-level/charts");
    expect(readFileSync(join(root, "environment", "targets", "in-cluster", "values.yaml"), "utf8")).toContain("compute: pod");

    // catalogue reconstructed with the record's sha as provenance
    const prov = parse(readFileSync(join(root, "catalog", "profiles", "persona-a", "provenance.yaml"), "utf8"));
    expect(prov.sourceSha).toBe("a".repeat(40));
    // per-profile provenance: mixed shas each keep their own
    const provB = parse(readFileSync(join(root, "catalog", "profiles", "persona-b", "provenance.yaml"), "utf8"));
    expect(provB.sourceSha).toBe("b".repeat(40));
    expect(readFileSync(join(root, "catalog", "profiles", "persona-a", "contract.yaml"), "utf8")).toContain("monitoring");

    // deployments compiled with legacy identity (D5: zero workload moves)
    const agent = parse(readFileSync(join(root, "deployments", "agents", "persona-a", "deployment.yaml"), "utf8"));
    expect(agent.spec.namespace).toBe("hermes-persona-a");
    expect(agent.spec.application).toBe("hermes-persona-a");
    expect(agent.spec.argoDestination).toBe("in-cluster");

    // generators carry the EXTRACTED substitutions
    const agents = readFileSync(join(root, "bootstrap", "applicationsets", "agents.yaml"), "utf8");
    expect(agents).toContain("https://git.example/fleet.git");
    expect(agents).toContain("targetRevision: v1.2.3");
    expect(agents).not.toContain("__GITOPS_REPO_URL__");

    // scaffold.yaml adopted; project.yaml kept operator-tuned and recorded as-is
    const record = parse(readFileSync(join(root, "bootstrap", "scaffold.yaml"), "utf8"));
    expect(record.substitutions.chartRevision).toBe("v1.2.3");
    const projectEntry = record.managedFiles.find((e: { path: string }) => e.path === "bootstrap/project.yaml");
    expect(projectEntry.sha256).toBe(sha("kind: AppProject # operator-tuned\n"));
    expect(readFileSync(join(root, "bootstrap", "project.yaml"), "utf8")).toContain("operator-tuned");

    // the pre-flight names the finalizer strip and the deferred deletion
    expect(result.preflight.join("\n")).toContain("preserveResourcesOnDeletion");

    // doctor is clean afterwards; a second upgrade refuses
    const { gitopsDoctor } = await import("../src/gitops/index.ts");
    expect(gitopsDoctor(root)).toEqual([]);
    const second = gitopsUpgrade(root);
    expect(second.written).toEqual([]);
    expect(second.findings.some((f) => f.check === "upgrade" && f.message.includes("already adopted"))).toBe(true);
  });
});

  test("a half-migrated tree refuses instead of being silently normalized", async () => {
    const { gitopsUpgrade } = await import("../src/gitops/index.ts");
    const { parse } = await import("yaml");
    const root = legacyRepo();
    write(root, "deployments/agents/handmade/deployment.yaml", "spec: {}\n");
    const result = gitopsUpgrade(root);
    expect(result.written).toEqual([]);
    // refused either by doctor's plan gate (no plan.yaml) or the explicit
    // half-migrated check - both are refusals, neither normalizes
    expect(
      result.findings.some(
        (f) => f.severity === "error" && (f.check === "upgrade" || f.check === "plan"),
      ),
    ).toBe(true);
    // the hand-made file survives untouched
    expect(existsSync(join(root, "deployments", "agents", "handmade", "deployment.yaml"))).toBe(true);
  });
