// The connections compiler (ADR-152): pure over the declaration and the
// profiles' deployed coordinates - the structural rules, the generated
// records, the bundle fold, and the desired-set writer.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileConnections,
  connectionFiles,
  loadConnectionDeclarations,
  mergeConnectionsIntoBundles,
  writeConnectionTree,
  type ConnectionDeclarations,
  type ProfileTarget,
} from "../src/connection/compile.ts";

const targets: Record<string, ProfileTarget> = {
  echo: { runtime: "eve", instance: "ag-eve-echo", namespace: "ag-eve-echo", service: "ag-eve-echo", port: 3000 },
  greeter: { runtime: "eve", instance: "ag-eve-greeter", namespace: "ag-eve-greeter", service: "ag-eve-greeter", port: 3000 },
  manager: { runtime: "hermes", instance: "hermes-manager", namespace: "hermes-manager", service: "hermes-manager", port: 8644 },
};
const decl = (connections: ConnectionDeclarations["connections"]): ConnectionDeclarations => ({
  apiVersion: "hermes.gitops/v1alpha1",
  kind: "Connections",
  connections,
});

describe("compileConnections", () => {
  test("an eve binding is routed to its channel URL; a hermes binding is projection-only with a warning", () => {
    const r = compileConnections(
      decl([{ name: "company-discord", provider: "discord", bindings: [{ profile: "echo", match: { guilds: ["1"] } }, { profile: "manager" }] }]),
      targets,
    );
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.bindings.map((b) => [b.profile, b.url])).toEqual([
      ["echo", "http://ag-eve-echo.ag-eve-echo.svc.cluster.local:3000/eve/v1/discord"],
      ["manager", null],
    ]);
    expect(r.findings.some((f) => f.check === "connections CONN006" && f.profile === "manager")).toBe(true);
  });

  test("CONN002 unknown profile, CONN003 two connections of one provider on one profile, CONN004 foreign match vocabulary", () => {
    const r = compileConnections(
      decl([
        { name: "a", provider: "discord", bindings: [{ profile: "nobody" }, { profile: "echo" }] },
        { name: "b", provider: "discord", bindings: [{ profile: "echo" }] },
        { name: "gh", provider: "github", bindings: [{ profile: "greeter", match: { guilds: ["1"] } }] },
      ]),
      targets,
    );
    const codes = r.findings.filter((f) => f.severity === "error").map((f) => f.check);
    expect(codes).toContain("connections CONN002");
    expect(codes).toContain("connections CONN003");
    expect(codes).toContain("connections CONN004");
    // the refused bindings never produce records
    expect(r.bindings.map((b) => `${b.connection}/${b.profile}`)).toEqual(["a/echo"]);
  });

  test("CONN005 a binding after a catch-all never matches (warning, still compiled)", () => {
    const r = compileConnections(
      decl([{ name: "c", provider: "discord", bindings: [{ profile: "echo" }, { profile: "greeter", match: { guilds: ["1"] } }] }]),
      targets,
    );
    expect(r.findings.some((f) => f.check === "connections CONN005")).toBe(true);
    expect(r.bindings).toHaveLength(2);
  });
});

describe("connectionFiles + the bundle fold", () => {
  const r = compileConnections(
    decl([
      { name: "company-discord", provider: "discord", bindings: [{ profile: "echo", match: { guilds: ["1"] } }, { profile: "greeter" }] },
      { name: "platform-github", provider: "github", bindings: [{ profile: "echo", match: { repositories: ["o/r"] } }] },
    ]),
    targets,
  );

  test("one values file per standalone profile with the provider's fixed key set; the gateway record carries ordered routes", () => {
    const files = connectionFiles(r.bindings);
    expect([...files.keys()].sort()).toEqual([
      "deployments/connections/gateway.yaml",
      "deployments/connections/profiles/echo.yaml",
      "deployments/connections/profiles/greeter.yaml",
    ]);
    const echo = files.get("deployments/connections/profiles/echo.yaml")!;
    expect(echo).toContain("secretName: connection-company-discord");
    expect(echo).toContain("- DISCORD_PUBLIC_KEY");
    expect(echo).toContain("- GITHUB_WEBHOOK_SECRET");
    const gw = files.get("deployments/connections/gateway.yaml")!;
    expect(gw).toContain("verifyKey: DISCORD_PUBLIC_KEY");
    expect(gw).toContain("url: http://ag-eve-echo.ag-eve-echo.svc.cluster.local:3000/eve/v1/discord");
    expect(gw.indexOf("profile: echo")).toBeLessThan(gw.indexOf("profile: greeter"));
    // determinism
    expect(connectionFiles(r.bindings).get("deployments/connections/gateway.yaml")).toBe(gw);
  });

  test("a bundled member gets no per-profile file; its projection rides in the bundle declaration", () => {
    const files = connectionFiles(r.bindings, new Set(["echo"]));
    expect(files.has("deployments/connections/profiles/echo.yaml")).toBe(false);
    const merged = mergeConnectionsIntoBundles(
      { version: 4, bundles: [{ name: "team", profiles: [{ name: "echo" }, { name: "greeter" }] }] } as never,
      r.bindings,
    ) as { bundles: { profiles: { name: string; connections?: { name: string }[] }[] }[] };
    expect(merged.bundles[0]!.profiles[0]!.connections!.map((c) => c.name)).toEqual(["company-discord", "platform-github"]);
    expect(merged.bundles[0]!.profiles[1]!.connections!.map((c) => c.name)).toEqual(["company-discord"]);
  });

  test("writeConnectionTree writes the desired set and prunes what disappeared (fail closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-conn-"));
    const first = writeConnectionTree(dir, connectionFiles(r.bindings));
    expect(first.written.length).toBe(3);
    expect(existsSync(join(dir, "deployments/connections/profiles/greeter.yaml"))).toBe(true);
    const second = writeConnectionTree(dir, connectionFiles(r.bindings));
    expect(second.changed).toBe(false);
    const third = writeConnectionTree(dir, new Map());
    expect(third.deleted.length).toBe(3);
    expect(existsSync(join(dir, "deployments/connections"))).toBe(false);
  });
});

describe("loadConnectionDeclarations", () => {
  test("refuses an unknown apiVersion and a schema violation loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-conn-load-"));
    mkdirSync(join(dir, "environment"));
    const file = join(dir, "environment", "connections.yaml");
    writeFileSync(file, "apiVersion: hermes.gitops/v9\nkind: Connections\nconnections: []\n");
    expect(() => loadConnectionDeclarations(file)).toThrow(/unsupported apiVersion/);
    writeFileSync(file, "apiVersion: hermes.gitops/v1alpha1\nkind: Connections\nconnections:\n  - name: x\n    provider: slack\n    bindings: [{profile: echo}]\n");
    expect(() => loadConnectionDeclarations(file)).toThrow(/failed connections schema validation/);
    writeFileSync(file, readFileSync(join(import.meta.dir, "../../agent-bundle-contracts/environment-connections/v1alpha1/examples/connections/valid-full.yaml"), "utf8"));
    expect(loadConnectionDeclarations(file).connections).toHaveLength(2);
  });
});
