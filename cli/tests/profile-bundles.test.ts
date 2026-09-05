import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as yaml } from "yaml";
import {
  compileBundles,
  loadBundleDeclarations,
  writeBundleTree,
} from "../src/platform/profile-bundles.ts";
import {
  mergeWorkspacesIntoBundles,
  type NormalizedWorkspaceBinding,
} from "../src/workspace/bindings.ts";

// Repositories reach bundles ONLY through workspace bindings now (#365);
// the authored fixture stays repository-free and tests merge one in.
function binding(over: Partial<NormalizedWorkspaceBinding> = {}): NormalizedWorkspaceBinding {
  return {
    repository: "product",
    source: "https://example.invalid/product.git",
    resolvedRevision: "c".repeat(40),
    mountPath: "/workspaces/product",
    access: "read-write",
    purpose: "product-context",
    targetProfiles: ["coder"],
    ...over,
  };
}

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup(): { root: string; declaration: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hg-bundles-"));
  temporary.push(root);
  for (const [name, sha, needsEnv] of [
    ["coder", "a".repeat(40), true],
    ["reviewer", "b".repeat(40), false],
  ] as const) {
    const dir = path.join(root, "profiles", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "profile.yaml"),
      yaml({
        spec: {
          persona: name,
          source: `https://example.invalid/${name}.git`,
          sha,
          ...(needsEnv ? { envRequires: ["MODEL_KEY"] } : {}),
        },
      }),
    );
  }
  const declaration = path.join(root, "environment", "bundles.yaml");
  fs.mkdirSync(path.dirname(declaration), { recursive: true });
  fs.writeFileSync(
    declaration,
    yaml({
      version: 1,
      bundles: [
        {
          name: "engineering",
          profiles: [
            { name: "coder", envSecretRef: "engineering-coder-env", apiServerPort: 8642 },
            { name: "reviewer" },
          ],
        },
      ],
    }),
  );
  return { root, declaration };
}

describe("profile bundle compiler", () => {
  test("renders one runtime record containing multiple profiles", () => {
    const { root, declaration } = setup();
    const input = mergeWorkspacesIntoBundles(loadBundleDeclarations(declaration), [binding()]);
    const result = compileBundles(root, input);

    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.profiles.map((profile) => profile.name)).toEqual([
      "coder",
      "reviewer",
    ]);
    expect(result.bundles[0]?.profiles[0]?.repositoryRefs).toEqual(["product"]);
    expect(result.bundles[0]?.profiles[0]?.terminalCwd).toBe("/workspaces/product");
    expect(result.bundles[0]?.profiles[1]?.repositoryRefs).toEqual([]);
    expect(
      result.files.get("deployments/bundles/engineering/deployment.yaml"),
    ).toContain("bundle: engineering");
    expect(result.files.get("deployments/bundles/engineering/values.yaml")).toContain(
      "repositoryRefs:\n        - product",
    );
  });

  test("a v3 displayName compiles into deployment.yaml only (#567)", () => {
    // The title is presentation for Nexus, read from deployment.yaml;
    // values.yaml stays pure chart input, so the hermes-bundle chart's
    // strict values schema and goldens never see the field.
    const { root, declaration } = setup();
    fs.writeFileSync(
      declaration,
      yaml({
        version: 3,
        bundles: [
          {
            name: "engineering",
            displayName: "Engineering Team",
            profiles: [
              { name: "coder", envSecretRef: "engineering-coder-env", apiServerPort: 8642 },
              { name: "reviewer" },
            ],
          },
        ],
      }),
    );
    const result = compileBundles(root, loadBundleDeclarations(declaration));
    expect(result.bundles[0]?.displayName).toBe("Engineering Team");
    expect(result.files.get("deployments/bundles/engineering/deployment.yaml")).toContain(
      "displayName: Engineering Team",
    );
    expect(result.files.get("deployments/bundles/engineering/values.yaml")).not.toContain(
      "displayName",
    );
    // Undeclared: the key is absent, not empty - older trees stay
    // byte-identical.
    const bare = compileBundles(
      root,
      loadBundleDeclarations(
        (() => {
          fs.writeFileSync(
            declaration,
            yaml({
              version: 3,
              bundles: [
                {
                  name: "engineering",
                  profiles: [
                    { name: "coder", envSecretRef: "engineering-coder-env", apiServerPort: 8642 },
                    { name: "reviewer" },
                  ],
                },
              ],
            }),
          );
          return declaration;
        })(),
      ),
    );
    expect(bare.files.get("deployments/bundles/engineering/deployment.yaml")).not.toContain(
      "displayName",
    );
  });

  test("stamps the runtime and its chart; Hermes records default to hermes-bundle (ADR-150)", () => {
    const { root, declaration } = setup();
    const result = compileBundles(root, loadBundleDeclarations(declaration));
    expect(result.bundles[0]?.runtime).toBe("hermes");
    expect(result.bundles[0]?.chart).toBe("hermes-bundle");
    expect(result.files.get("deployments/bundles/engineering/deployment.yaml")).toContain("chart: hermes-bundle");
    expect(result.files.get("deployments/bundles/engineering/values.yaml")).toContain("runtime: hermes");
  });

  test("an all-Eve bundle compiles to eve-bundle and skips the Hermes API-key rule", () => {
    const { root, declaration } = setup();
    for (const name of ["coder", "reviewer"]) {
      const file = path.join(root, "profiles", name, "profile.yaml");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("spec:\n", "spec:\n  runtime: eve\n"));
    }
    // coder declares apiServerPort WITHOUT an envSecretRef carrying API_SERVER_KEY -
    // a Hermes error, a plain listen port for Eve.
    fs.writeFileSync(
      declaration,
      fs.readFileSync(declaration, "utf8").replace("envSecretRef: engineering-coder-env\n", "envSecretRef: engineering-coder-env\n"),
    );
    const result = compileBundles(root, loadBundleDeclarations(declaration));
    expect(result.bundles[0]?.runtime).toBe("eve");
    expect(result.bundles[0]?.chart).toBe("eve-bundle");
    expect(result.files.get("deployments/bundles/engineering/deployment.yaml")).toContain("chart: eve-bundle");
    expect(result.files.get("deployments/bundles/engineering/values.yaml")).toContain("runtime: eve");
  });

  test("a mixed-runtime bundle is refused naming both members", () => {
    const { root, declaration } = setup();
    const file = path.join(root, "profiles", "reviewer", "profile.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("spec:\n", "spec:\n  runtime: eve\n"));
    expect(() => compileBundles(root, loadBundleDeclarations(declaration))).toThrow(
      /members must share one runtime - coder is hermes, reviewer is eve/,
    );
  });

  test("an Eve bundle refuses the Hermes dashboard and baseImageTag knobs", () => {
    const { root, declaration } = setup();
    for (const name of ["coder", "reviewer"]) {
      const file = path.join(root, "profiles", name, "profile.yaml");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("spec:\n", "spec:\n  runtime: eve\n"));
    }
    const base = loadBundleDeclarations(declaration);
    const withDash = { ...base, bundles: [{ ...base.bundles![0]!, dashboard: { enabled: true, envSecretRef: "d-env" } }] };
    expect(() => compileBundles(root, withDash as never)).toThrow(/dashboard.enabled is a Hermes dashboard knob/);
    const withImage = { ...base, bundles: [{ ...base.bundles![0]!, deployment: { baseImageTag: "x" } }] };
    expect(() => compileBundles(root, withImage as never)).toThrow(/baseImageTag names the Hermes image/);
  });

  test("does not let one profile belong to two runtime bundles", () => {
    const { root, declaration } = setup();
    const input = loadBundleDeclarations(declaration);
    input.bundles.push({ name: "other", profiles: [{ name: "coder" }] });

    expect(() => compileBundles(root, input)).toThrow(
      "profile coder is assigned to both bundle engineering and other",
    );
  });

  test("rejects a profile reference to an undeclared repository", () => {
    const { root, declaration } = setup();
    const input = loadBundleDeclarations(declaration);
    input.bundles[0]!.profiles[1]!.repositoryRefs = ["missing"];

    expect(() => compileBundles(root, input)).toThrow(
      'repositoryRef "missing" does not name a declared bundle repository',
    );
  });

  test("keeps repository mounts under the workspace root", () => {
    const { root, declaration } = setup();
    const input = mergeWorkspacesIntoBundles(loadBundleDeclarations(declaration), [
      binding({ mountPath: "/etc/product" }),
    ]);

    expect(() => compileBundles(root, input)).toThrow(
      "must be an absolute child of /workspaces",
    );
  });

  test("requires auth configuration for shared dashboards", () => {
    const { root, declaration } = setup();
    const input = loadBundleDeclarations(declaration);
    input.bundles[0]!.dashboard = { enabled: true };

    expect(() => compileBundles(root, input)).toThrow(
      "dashboard.enabled requires dashboard.envSecretRef",
    );
  });

  test("requires a profile secret when exposing its API server", () => {
    const { root, declaration } = setup();
    const input = loadBundleDeclarations(declaration);
    input.bundles[0]!.profiles[1]!.apiServerPort = 8643;

    expect(() => compileBundles(root, input)).toThrow(
      "apiServerPort requires envSecretRef containing API_SERVER_KEY",
    );
  });

  test("check mode reports drift without changing the tree", () => {
    const { root, declaration } = setup();
    const result = compileBundles(root, loadBundleDeclarations(declaration));

    expect(writeBundleTree(root, result, true).changed).toBe(true);
    expect(fs.existsSync(path.join(root, "deployments", "bundles"))).toBe(false);

    writeBundleTree(root, result, false);
    expect(writeBundleTree(root, result, true).changed).toBe(false);
  });
});

// Review findings on the original PR. Each of these compiled cleanly before
// the fix, and each broke a guarantee the contract advertises.
describe("profile bundle compiler: declarations that must be refused", () => {
  test("a repository mounted INSIDE another is refused", () => {
    // The outer mount gets readOnly:true and the inner one is mounted
    // writable underneath it, so a tree declared read-only is partly
    // writable while the declaration still reads as though it holds.
    // Bindings are the only repository source now, so the refusal fires
    // at merge - before anything compiles.
    const { declaration } = setup();
    expect(() =>
      mergeWorkspacesIntoBundles(loadBundleDeclarations(declaration), [
        binding({ access: "read-only" }),
        binding({
          repository: "generated",
          mountPath: "/workspaces/product/generated",
          purpose: "generated",
        }),
      ]),
    ).toThrow(/nested inside/);
  });

  test("a sibling whose name merely shares a prefix is still allowed", () => {
    // Guards against a naive startsWith check: /workspaces/ab is not a
    // child of /workspaces/a.
    const { root, declaration } = setup();
    const input = mergeWorkspacesIntoBundles(loadBundleDeclarations(declaration), [
      binding({ repository: "a", mountPath: "/workspaces/a", access: "read-only", purpose: "a" }),
      binding({ repository: "ab", mountPath: "/workspaces/ab", purpose: "ab" }),
    ]);
    expect(() => compileBundles(root, input)).not.toThrow();
  });

  test("authored bundle-local repositories are refused with the migration message", () => {
    const { declaration } = setup();
    const doc = parseYaml(fs.readFileSync(declaration, "utf8")) as Record<string, unknown>;
    (doc["bundles"] as Record<string, unknown>[])[0]!["repositories"] = [
      {
        name: "product",
        source: "https://example.invalid/product.git",
        sha: "c".repeat(40),
        mountPath: "/workspaces/product",
        access: "read-write",
      },
    ];
    fs.writeFileSync(declaration, yaml(doc));
    expect(() => loadBundleDeclarations(declaration)).toThrow(
      /bundle-local repository declarations are no longer accepted.*environment\/workspaces\.yaml/s,
    );
  });

  test("authored repositoryRefs are refused too; an EMPTY list is tolerated", () => {
    const { declaration } = setup();
    const doc = parseYaml(fs.readFileSync(declaration, "utf8")) as {
      bundles: { profiles: Record<string, unknown>[] }[];
    };
    doc.bundles[0]!.profiles[0]!["repositoryRefs"] = [];
    fs.writeFileSync(declaration, yaml(doc));
    expect(() => loadBundleDeclarations(declaration)).not.toThrow();

    doc.bundles[0]!.profiles[0]!["repositoryRefs"] = ["product"];
    fs.writeFileSync(declaration, yaml(doc));
    expect(() => loadBundleDeclarations(declaration)).toThrow(/repositoryRefs \[product\]/);
  });

  test("a profile record whose sourceSubdir the chart would reject fails HERE", () => {
    // The profile contract is looser than the chart's values schema, so
    // without this the record compiles and Helm rejects it at deploy time -
    // three steps from the cause.
    const { root, declaration } = setup();
    const profile = path.join(root, "profiles", "coder", "profile.yaml");
    fs.writeFileSync(
      profile,
      yaml({
        spec: {
          persona: "coder",
          source: "https://example.invalid/coder.git",
          sha: "a".repeat(40),
          sourceSubdir: "dist ributions/../etc",
          envRequires: ["MODEL_KEY"],
        },
      }),
    );
    expect(() => compileBundles(root, loadBundleDeclarations(declaration))).toThrow(
      /sourceSubdir/,
    );
  });

  test("an ordinary sourceSubdir still compiles", () => {
    const { root, declaration } = setup();
    const profile = path.join(root, "profiles", "coder", "profile.yaml");
    fs.writeFileSync(
      profile,
      yaml({
        spec: {
          persona: "coder",
          source: "https://example.invalid/coder.git",
          sha: "a".repeat(40),
          sourceSubdir: ".hermes-dist/agent",
          envRequires: ["MODEL_KEY"],
        },
      }),
    );
    expect(() => compileBundles(root, loadBundleDeclarations(declaration))).not.toThrow();
  });
});
