// hg bundle init (ADR 0178): the scaffold writes the agent-team tree and
// nothing it cannot fill honestly, every written file says why it exists,
// a second run writes nothing, and Hermes is refused with the path.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgents } from "../src/agent-bundle/command.ts";
import { scaffoldBundle } from "../src/agent-bundle/scaffold.ts";

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((e) => {
    const abs = join(dir, e);
    return statSync(abs).isDirectory() ? walk(abs, `${prefix}${e}/`) : [`${prefix}${e}`];
  });
}

describe("hg bundle init scaffold (ADR 0178)", () => {
  test("writes exactly the agent-team tree for two Eve agents, headers on every file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-init-"));
    const { wrote } = scaffoldBundle({
      dir, team: "demo", gitopsRepoUrl: "https://x/y.git",
      agents: [{ harness: "eve", name: "manager" }, { harness: "eve", name: "research" }],
    });
    const perAgent = (n: string) => [
      `agents/eve/${n}/harness-hg/agent.yaml`, `agents/eve/${n}/harness-hg/backup.yaml`,
      `agents/eve/${n}/harness-hg/dashboard.yaml`, `agents/eve/${n}/harness-hg/test.yaml`,
      `agents/eve/${n}/src/agent/agent.ts`, `agents/eve/${n}/src/agent/instructions.md`, `agents/eve/${n}/src/package.json`,
    ];
    expect([...wrote].sort()).toEqual(
      [".gitignore", "README.md", "evals/suite.yaml", "harness-hg/destination.yaml", "harness-hg/team.yaml",
       "harness-hg/workspaces.yaml", ...perAgent("manager"), ...perAgent("research")].sort(),
    );
    expect(walk(dir).sort()).toEqual([...wrote].sort());
    for (const f of wrote) {
      const first = readFileSync(join(dir, f), "utf8").split("\n")[0]!;
      // JSON has no comment syntax; its description field is the header.
      const ok = first.startsWith("#") || first.startsWith("//") || f.endsWith("package.json") || f === "README.md" || f.endsWith("instructions.md");
      expect(ok, `${f} starts with: ${first}`).toBe(true);
    }
    expect(readFileSync(join(dir, "harness-hg", "team.yaml"), "utf8")).toContain("harnesses: [eve]");
    expect(readFileSync(join(dir, "harness-hg", "workspaces.yaml"), "utf8")).toContain("profiles: [manager, research]");
    // staggered backups: never the same minute
    expect(readFileSync(join(dir, "agents/eve/manager/harness-hg/backup.yaml"), "utf8")).toContain('"0 3 * * *"');
    expect(readFileSync(join(dir, "agents/eve/research/harness-hg/backup.yaml"), "utf8")).toContain('"0 4 * * *"');
    // what is NOT written is said, one line each
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    for (const f of ["apps.yaml", "bundles.yaml", "communication.yaml", "connections.yaml", "capabilities.yaml", "topology.yaml"]) {
      expect(readme).toContain(`harness-hg/${f}`);
    }
    // a second run writes nothing
    expect(scaffoldBundle({ dir, team: "demo", gitopsRepoUrl: "https://x/y.git", agents: [{ harness: "eve", name: "manager" }] }).wrote).toEqual([]);
  });

  test("--agents parses eve:<name> and bare names; Hermes is refused with the copy-from path", () => {
    expect(parseAgents("eve:manager, research")).toEqual([{ harness: "eve", name: "manager" }, { harness: "eve", name: "research" }]);
    expect(() => parseAgents("hermes:sre")).toThrow(/agents\/hermes\/sre\/src/);
    expect(() => parseAgents("eve:Bad_Name")).toThrow(/DNS-1123/);
    expect(() => parseAgents("eve:a,eve:a")).toThrow(/listed twice/);
    expect(() => parseAgents("langchain:x")).toThrow(/unknown harness/);
  });
});
