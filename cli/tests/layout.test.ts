// The agent-team layout (ADR 0178): agents/<harness>/<name>/{harness-hg,src}
// is discovered, validated, and FOLDED into the legacy raw shape - the proof
// is that a split authoring loads to the same contract as the legacy file it
// was split from. Findings name every way the split can disagree with itself.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yaml } from "yaml";
import { discoverContractDirs, loadContracts } from "../src/topology/contract.ts";
import { inputsHash } from "../src/topology/emit.ts";
import { createHash } from "node:crypto";
import { agentLayout, readAgentDeclaration, teamDir } from "../src/layout.ts";
import { loadTestConfig } from "../src/lib.ts";

const API = "hermes-gitops.factorylevel.dev/agent-team/v1alpha1";

const ENDPOINTS = [{ name: "hooks", path: "/webhooks/brief", port: 8644, signature: "hmac-sha256", type: "webhook" }];
const EXTERNAL_INPUTS = [
  {
    name: "brief",
    event: "strategy.brief-updated/v1",
    subject: "repository.full_name",
    verification: { type: "github-hmac-sha256", secretRef: { name: "router-secrets", key: "brief" } },
  },
];
const INBOUND_ROUTE = {
  name: "brief-fanout",
  from: { externalInput: "brief" },
  delivery: { mode: "queued", guarantee: "at-least-once" },
  outputs: [{ agent: { profile: "echo", handler: "brief", session: { mode: "keyed", key: "subject" } } }],
};
const APP_ROUTE = {
  name: "board-alerts",
  from: { app: "board", output: "alerts" },
  delivery: { mode: "queued", guarantee: "at-least-once" },
  outputs: [{ chatops: "company_discord#sre-alerts" }],
};
const APP = {
  name: "board",
  chart: "cli/test-env/charts/test-page",
  repo: "local",
  topology: { multiplicity: "singleton", dataBoundary: "global" },
  outputs: [{ name: "alerts", event: "observability.alert/v1", subject: "groupKey", adapter: { type: "webhook", inject: { appValue: { path: "alerts.webhookUrl" } } } }],
};
const TOPOLOGY = { supportedLayouts: ["single", "hub-spoke"], agent: { multiplicity: "per-region", dataBoundary: "region" } };
const REQUIRES = [{ capability: "content-board", inject: { env: "HERMES_CAP_CONTENT_BOARD_URL" } }];

/** The legacy v5 authoring of one Eve agent with everything on. */
const LEGACY_EVE = {
  contractVersion: 5,
  runtime: { kind: "eve", envRequires: ["AI_GATEWAY_API_KEY", { name: "GREETING", required: false, secret: false }] },
  topology: TOPOLOGY,
  requires: REQUIRES,
  deployment: { diskSizeGb: 20 },
  gitAuthSecretRef: "echo-git-auth",
  backup: { schedule: "0 3 * * *", retention: 14 },
  endpoints: ENDPOINTS,
  communication: { externalInputs: EXTERNAL_INPUTS, routes: [INBOUND_ROUTE, APP_ROUTE] },
  apps: [APP],
};

function evePayload(dir: string, name: string) {
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies: { eve: "0.0.0" } }));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "agent", "instructions.md"), "echo\n");
}

function legacyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "layout-legacy-"));
  const dir = join(root, "agents", "echo");
  evePayload(dir, "echo");
  writeFileSync(join(dir, "hermes-gitops.yaml"), yaml(LEGACY_EVE));
  return root;
}

/** The same agent, split across harness-hg/ files + the team's apps.yaml. */
function teamRepo(opts: { harness?: string; teamHarnesses?: string[]; team?: boolean; pkgName?: string; apps?: object[]; agent?: object; endpoints?: object } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "layout-team-"));
  const harness = opts.harness ?? "eve";
  const agentDir = join(root, "agents", harness, "echo");
  const hg = join(agentDir, "harness-hg");
  mkdirSync(hg, { recursive: true });
  mkdirSync(join(root, "harness-hg"), { recursive: true });
  if (opts.team !== false) {
    writeFileSync(join(root, "harness-hg", "team.yaml"), yaml({ apiVersion: API, kind: "AgentTeam", name: "demo", displayName: "Demo", harnesses: opts.teamHarnesses ?? ["eve", "hermes"] }));
  }
  writeFileSync(join(root, "harness-hg", "apps.yaml"), yaml({ apiVersion: API, kind: "Apps", apps: opts.apps ?? [{ ...APP, agent: "echo", routes: [APP_ROUTE] }] }));
  evePayload(join(agentDir, "src"), opts.pkgName ?? "echo");
  writeFileSync(join(hg, "agent.yaml"), yaml(opts.agent ?? {
    apiVersion: API, kind: "Agent", harness: "eve",
    envRequires: LEGACY_EVE.runtime.envRequires, topology: TOPOLOGY, requires: REQUIRES,
    deployment: { diskSizeGb: 20 }, gitAuthSecretRef: "echo-git-auth",
  }));
  writeFileSync(join(hg, "backup.yaml"), yaml({ apiVersion: API, kind: "Backup", schedule: "0 3 * * *", retention: 14 }));
  writeFileSync(join(hg, "endpoints.yaml"), yaml(opts.endpoints ?? { apiVersion: API, kind: "Endpoints", endpoints: ENDPOINTS, externalInputs: EXTERNAL_INPUTS, routes: [INBOUND_ROUTE] }));
  writeFileSync(join(hg, "test.yaml"), yaml({ apiVersion: API, kind: "AgentTest", secrets: { AI_GATEWAY_API_KEY: "dev-placeholder" }, smoke: [{ service: "ag-eve-echo", port: 3000, path: "/eve/v1/health", expect_contains: "ok" }] }));
  return root;
}

const stripSubdir = (c: object) => {
  const { subdir: _s, ...rest } = c as { subdir: string };
  return rest;
};

describe("agent-team layout discovery + fold (ADR 0178)", () => {
  test("agents/<harness>/<name>/ is discovered with src/ as the contract dir and the harness from the path", () => {
    const root = teamRepo();
    const dirs = discoverContractDirs(root);
    expect(dirs.map((d) => [d.subdir, d.runtime])).toEqual([["agents/eve/echo/src", "eve"]]);
    const layout = agentLayout(dirs[0]!.dir);
    expect(layout.legacy).toBe(false);
    expect(layout.harness).toBe("eve");
    expect(layout.name).toBe("echo");
    expect(layout.agentFile).toBe(join(root, "agents", "eve", "echo", "harness-hg", "agent.yaml"));
    expect(layout.teamDir).toBe(join(root, "harness-hg"));
  });

  test("the split authoring loads to the SAME contract as the legacy v5 file (the fold's proof)", () => {
    const legacy = loadContracts(legacyRepo());
    const team = loadContracts(teamRepo());
    expect(legacy.findings).toEqual([]);
    expect(team.findings).toEqual([]);
    expect(team.contracts.length).toBe(1);
    expect(team.contracts[0]!.subdir).toBe("agents/eve/echo/src");
    expect(stripSubdir(team.contracts[0]!)).toEqual(stripSubdir(legacy.contracts[0]!));
  });

  test("the folded raw document is the v5 shape byte-for-byte in content: runtime, backup, apps minus owner/routes, communication assembled from both files", () => {
    const root = teamRepo();
    const { raw } = readAgentDeclaration(join(root, "agents", "eve", "echo", "src"));
    expect(raw["contractVersion"]).toBe(5);
    expect(raw["runtime"]).toEqual(LEGACY_EVE.runtime);
    expect(raw["backup"]).toEqual({ schedule: "0 3 * * *", retention: 14 });
    expect(raw["apps"]).toEqual([APP]);
    expect(raw["communication"]).toEqual({ externalInputs: EXTERNAL_INPUTS, routes: [INBOUND_ROUTE, APP_ROUTE] });
    expect(raw["expose"]).toBeUndefined();
  });

  test("a Hermes agent with expose folds to contract v3 and keeps expose (the record's Service ports)", () => {
    const root = mkdtempSync(join(tmpdir(), "layout-hermes-"));
    const agentDir = join(root, "agents", "hermes", "mgr");
    mkdirSync(join(agentDir, "harness-hg"), { recursive: true });
    mkdirSync(join(agentDir, "src"), { recursive: true });
    mkdirSync(join(root, "harness-hg"), { recursive: true });
    writeFileSync(join(root, "harness-hg", "team.yaml"), yaml({ apiVersion: API, kind: "AgentTeam", name: "demo", displayName: "Demo", harnesses: ["hermes"] }));
    writeFileSync(join(agentDir, "src", "distribution.yaml"), yaml({ name: "mgr", version: "1.0.0", env_requires: [{ name: "ANTHROPIC_API_KEY", required: true }] }));
    writeFileSync(join(agentDir, "harness-hg", "agent.yaml"), yaml({ apiVersion: API, kind: "Agent", harness: "hermes", topology: TOPOLOGY, deployment: { diskSizeGb: 10 } }));
    const expose = { services: [{ name: "tools", port: 8642, path: "/" }, { name: "hooks", port: 8644, path: "/" }], access: { policy: "service-token" } };
    writeFileSync(join(agentDir, "harness-hg", "endpoints.yaml"), yaml({ apiVersion: API, kind: "Endpoints", expose, endpoints: ENDPOINTS }));
    const { raw, findings } = readAgentDeclaration(join(agentDir, "src"));
    expect(findings).toEqual([]);
    expect(raw["contractVersion"]).toBe(3);
    expect(raw["expose"]).toEqual(expose);
    expect(raw["runtime"]).toBeUndefined();
    const loaded = loadContracts(root);
    expect(loaded.findings).toEqual([]);
    expect(loaded.contracts[0]!.runtime).toBe("hermes");
    expect(loaded.contracts[0]!.envRequires).toEqual(["ANTHROPIC_API_KEY"]);
    // expose projects onto endpoints exactly as a legacy v3 file does
    expect(loaded.contracts[0]!.endpoints.map((e) => e.name).sort()).toEqual(["hooks", "tools"]);
  });

  test("findings name every disagreement: harness vs path, missing team, unlisted harness, identity, unknown owner, duplicate app, expose on eve", () => {
    const checks = (root: string) => loadContracts(root).findings.map((f) => `${f.check}: ${f.message}`);

    const badHarness = teamRepo({ agent: { apiVersion: API, kind: "Agent", harness: "hermes", topology: TOPOLOGY } });
    expect(checks(badHarness).join("\n")).toMatch(/harness: "hermes" but the directory is agents\/eve\//);

    expect(checks(teamRepo({ team: false })).join("\n")).toMatch(/contract-team: .*needs harness-hg\/team.yaml/);
    expect(checks(teamRepo({ teamHarnesses: ["hermes"] })).join("\n")).toMatch(/contract-team: .*harness eve is not listed/);
    expect(checks(teamRepo({ pkgName: "other" })).join("\n")).toMatch(/contract-identity: .*names it "other"/);

    const orphanApp = teamRepo({ apps: [{ ...APP, agent: "nobody" }] });
    expect(checks(orphanApp).join("\n")).toMatch(/apps-owner: .*owned by "nobody"/);

    const dupApp = teamRepo({ apps: [{ ...APP, agent: "echo" }, { ...APP, agent: "echo", chart: "cli/test-env/charts/other" }] });
    expect(checks(dupApp).join("\n")).toMatch(/apps-unique: .*declared twice under echo/);
    // a per-agent app may repeat under different owners; a singleton may not
    const perAgent = { name: "monitoring", chart: "control-plane/monitoring/chart", repo: "local", topology: { multiplicity: "per-agent", dataBoundary: "target" } };
    const twoOwners = teamRepo({ apps: [{ ...perAgent, agent: "echo" }, { ...perAgent, agent: "nobody" }] });
    expect(checks(twoOwners).filter((c) => c.startsWith("apps-unique"))).toEqual([]);
    const twoBoards = teamRepo({ apps: [{ ...APP, agent: "echo" }, { ...APP, agent: "nobody" }] });
    expect(checks(twoBoards).join("\n")).toMatch(/singleton app board is declared by both echo and nobody/);

    const eveExpose = teamRepo({ endpoints: { apiVersion: API, kind: "Endpoints", expose: { services: [{ name: "x", port: 1 }] } } });
    expect(checks(eveExpose).join("\n")).toMatch(/expose is Hermes-only/);
  });

  test("a route under an app must be from that app", () => {
    const root = teamRepo({ apps: [{ ...APP, agent: "echo", routes: [{ ...APP_ROUTE, from: { app: "other", output: "alerts" } }] }] });
    expect(loadContracts(root).findings.map((f) => f.message).join("\n")).toMatch(/route board-alerts is from app "other"/);
  });

  test("hg test reads harness-hg/test.yaml (apiVersion + kind are not unknown keys)", () => {
    const root = teamRepo();
    const cfg = loadTestConfig(join(root, "agents", "eve", "echo", "src"));
    expect(cfg.secrets).toEqual({ AI_GATEWAY_API_KEY: "dev-placeholder" });
    expect(cfg.smoke.length).toBe(1);
  });

  test("teamDir prefers harness-hg/ and falls back to environment/", () => {
    const root = teamRepo();
    expect(teamDir(root)).toBe(join(root, "harness-hg"));
    const legacy = legacyRepo();
    expect(teamDir(legacy)).toBe(join(legacy, "environment"));
  });

  test("a legacy root profile's inputsHash is the pre-ADR-0178 hash, label for label (a changed hash marks every emitted tree stale)", () => {
    const root = mkdtempSync(join(tmpdir(), "layout-hash-"));
    const dist = yaml({ name: "solo", version: "1.0.0" });
    const ext = yaml({ contractVersion: 4 });
    writeFileSync(join(root, "distribution.yaml"), dist);
    writeFileSync(join(root, "hermes-gitops.yaml"), ext);
    // The old algorithm, verbatim: `${subdir}/${f}` labels with subdir "".
    const parts = [`/distribution.yaml\n${dist}`, `/hermes-gitops.yaml\n${ext}`].sort().join("\x00");
    expect(inputsHash(root)).toBe(createHash("sha256").update(parts).digest("hex"));
  });

  test("a stray harness-hg/ file in a legacy repo switches nothing: team.yaml is the switch", () => {
    const root = legacyRepo();
    mkdirSync(join(root, "harness-hg"), { recursive: true });
    writeFileSync(join(root, "harness-hg", "destination.yaml"), "apiVersion: hermes-gitops.factorylevel.dev/bundle-destination/v1alpha1\ngitops: {repoUrl: https://x/y.git}\n");
    expect(teamDir(root)).toBe(join(root, "environment"));
    // ...and a legacy test file still refuses the agent-team keys
    writeFileSync(join(root, "agents", "echo", "hermes-gitops.test.yaml"), "apiVersion: x\n");
    expect(() => loadTestConfig(join(root, "agents", "echo"))).toThrow(/unknown key "apiVersion"/);
  });

  test("a schema-invalid team.yaml or apps.yaml is ONE finding, never one per agent and never 'missing team'", () => {
    const root = teamRepo();
    writeFileSync(join(root, "harness-hg", "team.yaml"), yaml({ apiVersion: API, kind: "AgentTeam", name: "demo", displayName: "Demo", harnesses: [] }));
    const f1 = loadContracts(root).findings;
    expect(f1.length).toBe(1);
    expect(f1[0]!.check).toBe("contract-schema");
    expect(f1[0]!.profile).toBe("team");
    const root2 = teamRepo();
    writeFileSync(join(root2, "harness-hg", "apps.yaml"), yaml({ apiVersion: API, kind: "Apps", apps: [{ name: "x" }] }));
    const f2 = loadContracts(root2).findings;
    // one schema error per missing required field, each reported ONCE on the
    // team file - never repeated per agent, never a per-agent contract-team
    expect(f2.every((f) => f.file === "harness-hg/apps.yaml" && f.profile === "team")).toBe(true);
    expect(new Set(f2.map((f) => f.message)).size).toBe(f2.length);
  });

  test("expose + requires[].optional cannot both be carried: the finding names the source field", () => {
    const root = mkdtempSync(join(tmpdir(), "layout-hermes-opt-"));
    const agentDir = join(root, "agents", "hermes", "mgr");
    mkdirSync(join(agentDir, "harness-hg"), { recursive: true });
    mkdirSync(join(agentDir, "src"), { recursive: true });
    mkdirSync(join(root, "harness-hg"), { recursive: true });
    writeFileSync(join(root, "harness-hg", "team.yaml"), yaml({ apiVersion: API, kind: "AgentTeam", name: "demo", displayName: "Demo", harnesses: ["hermes"] }));
    writeFileSync(join(agentDir, "src", "distribution.yaml"), yaml({ name: "mgr", version: "1.0.0" }));
    writeFileSync(join(agentDir, "harness-hg", "agent.yaml"), yaml({ apiVersion: API, kind: "Agent", harness: "hermes", requires: [{ capability: "content-board", optional: true, inject: { env: "X_URL" } }] }));
    writeFileSync(join(agentDir, "harness-hg", "endpoints.yaml"), yaml({ apiVersion: API, kind: "Endpoints", expose: { services: [{ name: "tools", port: 8642 }] } }));
    const f = loadContracts(root).findings;
    expect(f.length).toBe(1);
    expect(f[0]!.message).toMatch(/content-board: `optional` cannot be carried beside endpoints.yaml's expose/);
    expect(f[0]!.file).toBe("agents/hermes/mgr/harness-hg/agent.yaml");
  });

  test("the legacy layout is untouched: discovery, subdir and the file it reads", () => {
    const root = legacyRepo();
    const dirs = discoverContractDirs(root);
    expect(dirs.map((d) => d.subdir)).toEqual(["agents/echo"]);
    const layout = agentLayout(dirs[0]!.dir);
    expect(layout.legacy).toBe(true);
    expect(layout.agentFile).toBe(join(root, "agents", "echo", "hermes-gitops.yaml"));
    expect(layout.testFile).toBe(join(root, "agents", "echo", "hermes-gitops.test.yaml"));
  });
});
