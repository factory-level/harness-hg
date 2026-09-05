import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yaml } from "yaml";
import {
  canonicalGitUrl,
  compileWorkspaceBindings,
  loadWorkspaceDeclarations,
  mergeWorkspacesIntoBundles,
  readWorkspaceProfileRecords,
  workspaceFiles,
  writeWorkspaceTree,
  type NormalizedWorkspaceBinding,
  type WorkspaceDeclarations,
} from "../src/workspace/bindings.ts";
import { compileBundles, type BundleDeclarations } from "../src/platform/profile-bundles.ts";

const PIN = "0123456789abcdef0123456789abcdef01234567";
const DEPLOYED = "f".repeat(40);

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(root);
  return root;
}

function declarations(overrides: Partial<WorkspaceDeclarations> = {}): WorkspaceDeclarations {
  return {
    apiVersion: "hermes.gitops/v1alpha1",
    kind: "WorkspaceBindings",
    repositories: [
      {
        name: "strategy-context",
        source: {
          url: "git@github.com:org/strategy-context.git",
          revision: { mode: "pinned", sha: PIN },
          authSecretRef: "hermes-strategy-context-git",
        },
        mount: { path: "/workspaces/strategy-context", access: "read-only" },
      },
    ],
    bindings: [
      {
        repository: "strategy-context",
        profiles: ["manager", "research"],
        purpose: "strategy-context",
      },
    ],
    ...overrides,
  };
}

const RECORDS = new Map([
  ["manager", { source: "https://example.invalid/personas.git", sha: "a".repeat(40) }],
  ["research", { source: "https://example.invalid/personas.git", sha: "b".repeat(40) }],
  ["sre", { source: "https://github.com/org/operation", sha: DEPLOYED, gitAuthSecretRef: "hermes-sre-git-auth" }],
]);

function errorsOf(result: { findings: { severity: string; message: string }[] }): string[] {
  return result.findings.filter((f) => f.severity === "error").map((f) => f.message);
}

describe("compileWorkspaceBindings", () => {
  test("a pinned binding normalizes with the exact generated model of #361", () => {
    const result = compileWorkspaceBindings(declarations(), RECORDS, { requireResolution: true });
    expect(errorsOf(result)).toEqual([]);
    expect(result.bindings).toEqual([
      {
        repository: "strategy-context",
        source: "git@github.com:org/strategy-context.git",
        resolvedRevision: PIN,
        mountPath: "/workspaces/strategy-context",
        access: "read-only",
        purpose: "strategy-context",
        targetProfiles: ["manager", "research"],
        authSecretRef: "hermes-strategy-context-git",
      },
    ]);
  });

  test("application-revision resolves to the named application's deployed sha", () => {
    const decl = declarations({
      repositories: [
        {
          name: "operation-source",
          source: {
            url: "git@github.com:org/operation.git",
            revision: { mode: "application-revision", application: "sre" },
            authSecretRef: "hermes-operation-git",
          },
          mount: { path: "/workspaces/operation", access: "read-only" },
        },
      ],
      bindings: [{ repository: "operation-source", profiles: ["sre"], purpose: "operation-source" }],
    });
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    expect(errorsOf(result)).toEqual([]);
    expect(result.bindings[0]!.resolvedRevision).toBe(DEPLOYED);
  });

  test("application-revision refuses when the record tracks a DIFFERENT repository", () => {
    const decl = declarations({
      repositories: [
        {
          name: "operation-source",
          source: {
            url: "git@github.com:org/some-other-repo.git",
            revision: { mode: "application-revision", application: "sre" },
            authSecretRef: "hermes-operation-git",
          },
          mount: { path: "/workspaces/operation", access: "read-only" },
        },
      ],
      bindings: [{ repository: "operation-source", profiles: ["sre"], purpose: "operation-source" }],
    });
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    expect(errorsOf(result).join("\n")).toContain("not");
    expect(result.bindings).toEqual([]);
  });

  test("an unknown application is an error whether or not resolution is required", () => {
    const decl = declarations({
      repositories: [
        {
          name: "operation-source",
          source: {
            url: "git@github.com:org/operation.git",
            revision: { mode: "application-revision", application: "ghost" },
            authSecretRef: "hermes-operation-git",
          },
          mount: { path: "/workspaces/operation", access: "read-only" },
        },
      ],
      bindings: [{ repository: "operation-source", profiles: ["sre"], purpose: "operation-source" }],
    });
    for (const requireResolution of [true, false]) {
      const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution });
      expect(errorsOf(result).join("\n")).toContain('unknown application "ghost"');
    }
  });

  test("an application record without a full sha refuses to resolve", () => {
    const records = new Map(RECORDS);
    records.set("sre", { source: "https://github.com/org/operation", sha: "short" });
    const decl = declarations({
      repositories: [
        {
          name: "operation-source",
          source: {
            url: "https://github.com/org/operation",
            revision: { mode: "application-revision", application: "sre" },
            authSecretRef: "hermes-operation-git",
          },
          mount: { path: "/workspaces/operation", access: "read-only" },
        },
      ],
      bindings: [{ repository: "operation-source", profiles: ["sre"], purpose: "operation-source" }],
    });
    const result = compileWorkspaceBindings(decl, records, { requireResolution: true });
    expect(errorsOf(result).join("\n")).toContain("no full commit SHA");
  });

  test("source: self resolves url, sha and credential from EACH bound profile's record", () => {
    const decl = declarations({
      repositories: [
        {
          name: "operation-source",
          source: "self",
          mount: { path: "/workspaces/operation", access: "read-only" },
        },
      ],
      bindings: [
        { repository: "operation-source", profiles: ["sre", "manager"], purpose: "operation-source" },
      ],
    });
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    expect(errorsOf(result)).toEqual([]);
    expect(result.bindings).toEqual([
      {
        repository: "operation-source",
        source: "https://github.com/org/operation",
        resolvedRevision: DEPLOYED,
        mountPath: "/workspaces/operation",
        access: "read-only",
        purpose: "operation-source",
        targetProfiles: ["sre"],
        authSecretRef: "hermes-sre-git-auth",
      },
      {
        repository: "operation-source",
        source: "https://example.invalid/personas.git",
        resolvedRevision: "a".repeat(40),
        mountPath: "/workspaces/operation",
        access: "read-only",
        purpose: "operation-source",
        targetProfiles: ["manager"],
      },
    ]);
  });

  test("source: self refuses a profile whose record cannot resolve", () => {
    const records = new Map(RECORDS);
    records.set("sre", { source: "https://github.com/org/operation", sha: "not-a-sha" });
    const decl = declarations({
      repositories: [
        { name: "operation-source", source: "self", mount: { path: "/workspaces/operation", access: "read-only" } },
      ],
      bindings: [{ repository: "operation-source", profiles: ["sre"], purpose: "operation-source" }],
    });
    const result = compileWorkspaceBindings(decl, records, { requireResolution: true });
    expect(errorsOf(result).join("\n")).toContain("no source and full commit SHA to resolve self against");
    expect(result.bindings).toEqual([]);
  });

  test("an unknown target profile is named in the finding", () => {
    const decl = declarations({
      bindings: [{ repository: "strategy-context", profiles: ["nobody"], purpose: "strategy-context" }],
    });
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    expect(errorsOf(result).join("\n")).toContain('unknown profile "nobody"');
  });

  test("a binding naming an undeclared repository is refused", () => {
    const decl = declarations({
      bindings: [{ repository: "ghost-repo", profiles: ["manager"], purpose: "strategy-context" }],
    });
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    expect(errorsOf(result).join("\n")).toContain("does not name a declared repository");
  });

  test("an ssh source without authSecretRef is refused; https stays legal", () => {
    const decl = declarations();
    delete decl.repositories[0]!.source.authSecretRef;
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    expect(errorsOf(result).join("\n")).toContain("needs authSecretRef");

    const https = declarations();
    https.repositories[0]!.source.url = "https://github.com/org/strategy-context";
    delete https.repositories[0]!.source.authSecretRef;
    expect(errorsOf(compileWorkspaceBindings(https, RECORDS, { requireResolution: true }))).toEqual([]);
  });

  test("duplicate repository names are refused", () => {
    const decl = declarations();
    decl.repositories.push(JSON.parse(JSON.stringify(decl.repositories[0])));
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    expect(errorsOf(result).join("\n")).toContain("duplicate");
  });

  test("two repositories at the same or NESTED mount for one profile are refused", () => {
    const second = {
      name: "generated",
      source: {
        url: "https://github.com/org/generated",
        revision: { mode: "pinned", sha: PIN } as const,
      },
      mount: { path: "/workspaces/strategy-context/generated", access: "read-only" as const },
    };
    const decl = declarations();
    decl.repositories.push(second);
    decl.bindings.push({ repository: "generated", profiles: ["manager"], purpose: "generated" });
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    expect(errorsOf(result).join("\n")).toContain("nested inside");

    // The same pair split across DIFFERENT profiles is fine.
    const split = declarations();
    split.repositories.push(second);
    split.bindings = [
      { repository: "strategy-context", profiles: ["manager"], purpose: "strategy-context" },
      { repository: "generated", profiles: ["research"], purpose: "generated" },
    ];
    expect(errorsOf(compileWorkspaceBindings(split, RECORDS, { requireResolution: true }))).toEqual([]);
  });

  test("a repository bound to no profile warns as dead configuration", () => {
    const decl = declarations({ bindings: [] as WorkspaceDeclarations["bindings"] });
    decl.bindings = [];
    const result = compileWorkspaceBindings(decl, RECORDS, { requireResolution: true });
    const warnings = result.findings.filter((f) => f.severity === "warning");
    expect(warnings.map((f) => f.message).join("\n")).toContain("bound to no profile");
  });
});

describe("canonicalGitUrl", () => {
  test("ssh, https and .git spellings of one repository compare equal", () => {
    for (const spelling of [
      "git@github.com:Org/Repo.git",
      "https://github.com/org/repo",
      "ssh://git@github.com/org/repo.git",
      "https://github.com/org/repo/",
    ]) {
      expect(canonicalGitUrl(spelling)).toBe("github.com/org/repo");
    }
  });
});

function bundleDeclarations(): BundleDeclarations {
  return {
    version: 2,
    bundles: [
      {
        name: "marketing-core",
        profiles: [
          { name: "manager", envSecretRef: "core-env", apiServerPort: 8642 },
          { name: "research" },
          { name: "bystander" },
        ],
      },
    ],
  };
}

describe("mergeWorkspacesIntoBundles", () => {
  const bindings: NormalizedWorkspaceBinding[] = [
    {
      repository: "strategy-context",
      source: "git@github.com:org/strategy-context.git",
      resolvedRevision: PIN,
      mountPath: "/workspaces/strategy-context",
      access: "read-only",
      purpose: "strategy-context",
      targetProfiles: ["manager", "research"],
      authSecretRef: "hermes-strategy-context-git",
    },
  ];

  test("bound bundle members share ONE repository; the unbound sibling gets no ref", () => {
    const merged = mergeWorkspacesIntoBundles(bundleDeclarations(), bindings);
    const bundle = merged.bundles[0]!;
    expect(bundle.repositories).toEqual([
      {
        name: "strategy-context",
        source: "git@github.com:org/strategy-context.git",
        sha: PIN,
        mountPath: "/workspaces/strategy-context",
        access: "read-only",
        gitAuthSecretRef: "hermes-strategy-context-git",
      },
    ]);
    const refs = Object.fromEntries(bundle.profiles.map((p) => [p.name, p.repositoryRefs ?? []]));
    expect(refs).toEqual({
      manager: ["strategy-context"],
      research: ["strategy-context"],
      bystander: [],
    });
    // The authored declaration is untouched.
    expect(bundleDeclarations().bundles[0]!.repositories).toBeUndefined();
  });

  test("the merged declaration compiles through the REAL bundle compiler end to end", () => {
    const root = tempDir("hg-workspaces-");
    for (const [name, sha] of [
      ["manager", "a".repeat(40)],
      ["research", "b".repeat(40)],
      ["bystander", "c".repeat(40)],
    ] as const) {
      const dir = path.join(root, "profiles", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "profile.yaml"),
        yaml({ spec: { persona: name, source: `https://example.invalid/${name}.git`, sha } }),
      );
    }
    const merged = mergeWorkspacesIntoBundles(bundleDeclarations(), bindings);
    const compiled = compileBundles(root, merged);
    const values = compiled.files.get("deployments/bundles/marketing-core/values.yaml")!;
    expect(values).toContain(`sha: ${PIN}`);
    expect(values).toContain("mountPath: /workspaces/strategy-context");
    const spec = compiled.bundles[0]!;
    expect(spec.profiles.find((p) => p.name === "manager")!.repositoryRefs).toEqual(["strategy-context"]);
    expect(spec.profiles.find((p) => p.name === "bystander")!.repositoryRefs).toEqual([]);
    // Exactly one physical checkout, selectively mounted: terminalCwd
    // defaulting proves the single-repo rule still applies post-merge.
    expect(spec.profiles.find((p) => p.name === "research")!.terminalCwd).toBe("/workspaces/strategy-context");
  });

  test("bindings are the ONLY repository source: merge replaces any pre-existing set", () => {
    // Authored bundle-local repositories are refused by
    // loadBundleDeclarations (#365, tested in profile-bundles.test.ts);
    // anything still present programmatically is not merged with - it is
    // overwritten by the generated set.
    const stale = bundleDeclarations();
    stale.bundles[0]!.repositories = [
      {
        name: "old-strategy",
        source: "git@github.com:org/old.git",
        sha: "9".repeat(40),
        mountPath: "/workspaces/old",
        access: "read-only",
      },
    ];
    const merged = mergeWorkspacesIntoBundles(stale, bindings);
    expect(merged.bundles[0]!.repositories!.map((r) => r.name)).toEqual(["strategy-context"]);
  });

  test("nested mounts split across DIFFERENT profiles still collide at the bundle level", () => {
    // Legal per profile (each profile sees one mount), refused per bundle:
    // the checkouts share one physical PVC, so the bundle compiler would
    // reject the merged declaration three steps later. Merge refuses now.
    const nested: NormalizedWorkspaceBinding[] = [
      bindings[0]!,
      {
        repository: "generated",
        source: "https://github.com/org/generated",
        resolvedRevision: PIN,
        mountPath: "/workspaces/strategy-context/generated",
        access: "read-only",
        purpose: "generated",
        targetProfiles: ["bystander"],
      },
    ];
    expect(() => mergeWorkspacesIntoBundles(bundleDeclarations(), nested)).toThrow(/nested inside/);
  });

  test("one repository resolving DIFFERENTLY for two co-bundled profiles is refused", () => {
    // A `self` expansion where two bundle members' records name different
    // revisions: one physical checkout cannot serve both, and silently
    // keeping whichever landed last would mount a sibling's source.
    const perProfile: NormalizedWorkspaceBinding[] = [
      { ...bindings[0]!, targetProfiles: ["manager"] },
      { ...bindings[0]!, resolvedRevision: "b".repeat(40), targetProfiles: ["research"] },
    ];
    expect(() => mergeWorkspacesIntoBundles(bundleDeclarations(), perProfile)).toThrow(
      /resolves differently for different bound profiles/,
    );
  });

  test("two bindings delivering one repository to one bundle yield ONE ref, not duplicates", () => {
    const twice: NormalizedWorkspaceBinding[] = [
      { ...bindings[0]!, targetProfiles: ["manager"] },
      { ...bindings[0]!, purpose: "second-purpose", targetProfiles: ["manager"] },
    ];
    const merged = mergeWorkspacesIntoBundles(bundleDeclarations(), twice);
    expect(merged.bundles[0]!.profiles.find((p) => p.name === "manager")!.repositoryRefs).toEqual([
      "strategy-context",
    ]);
    expect(merged.bundles[0]!.repositories!.length).toBe(1);
  });

  test("a bundle whose members appear in no binding is untouched", () => {
    const other: BundleDeclarations = {
      version: 2,
      bundles: [{ name: "ops", profiles: [{ name: "sre" }] }],
    };
    const merged = mergeWorkspacesIntoBundles(other, bindings);
    expect(merged.bundles[0]!.repositories).toBeUndefined();
    expect(merged.bundles[0]!.profiles[0]!.repositoryRefs).toBeUndefined();
  });
});

describe("emission", () => {
  const binding: NormalizedWorkspaceBinding = {
    repository: "strategy-context",
    source: "git@github.com:org/strategy-context.git",
    resolvedRevision: PIN,
    mountPath: "/workspaces/strategy-context",
    access: "read-only",
    purpose: "strategy-context",
    targetProfiles: ["manager", "research"],
    authSecretRef: "hermes-strategy-context-git",
  };

  test("the bindings record pins the normalized shape, byte for byte", () => {
    const files = workspaceFiles([binding], new Set(["manager", "research"]));
    expect([...files.keys()]).toEqual(["deployments/workspaces/bindings.yaml"]);
    expect(files.get("deployments/workspaces/bindings.yaml")).toBe(
      [
        "spec:",
        "  bindings:",
        "    - access: read-only",
        "      authSecretRef: hermes-strategy-context-git",
        "      mountPath: /workspaces/strategy-context",
        "      purpose: strategy-context",
        "      repository: strategy-context",
        "      resolvedRevision: 0123456789abcdef0123456789abcdef01234567",
        "      source: git@github.com:org/strategy-context.git",
        "      targetProfiles:",
        "        - manager",
        "        - research",
        "",
      ].join("\n"),
    );
  });

  test("an INDEPENDENT bound profile gets a chart values file in the hermes-profile shape", () => {
    // research is bundled, manager is not: manager gets the values file,
    // research travels through the bundle values instead.
    const files = workspaceFiles([binding], new Set(["research"]));
    expect([...files.keys()].sort()).toEqual([
      "deployments/workspaces/bindings.yaml",
      "deployments/workspaces/profiles/manager.yaml",
    ]);
    expect(files.get("deployments/workspaces/profiles/manager.yaml")).toBe(
      [
        "spec:",
        "  workspace:",
        "    repositories:",
        "      - access: read-only",
        "        gitAuthSecretRef: hermes-strategy-context-git",
        "        mountPath: /workspaces/strategy-context",
        "        name: strategy-context",
        "        sha: 0123456789abcdef0123456789abcdef01234567",
        "        source: git@github.com:org/strategy-context.git",
        "    terminalCwd: /workspaces/strategy-context",
        "",
      ].join("\n"),
    );
  });

  test("several repositories on an independent profile refuse to emit (no terminalCwd surface yet)", () => {
    const second: NormalizedWorkspaceBinding = {
      ...binding,
      repository: "playbooks",
      mountPath: "/workspaces/playbooks",
      purpose: "playbooks",
      targetProfiles: ["manager"],
    };
    expect(() => workspaceFiles([binding, second], new Set(["research"]))).toThrow(
      /multi-repository independent profiles/,
    );
    // The same pair is fine when the profile is bundled.
    expect(workspaceFiles([binding, second], new Set(["manager", "research"])).size).toBe(1);
  });

  test("writeWorkspaceTree is idempotent and prunes when the declaration goes away", () => {
    const root = tempDir("hg-workspaces-");
    const files = workspaceFiles([binding], new Set(["research"]));
    expect(writeWorkspaceTree(root, files).changed).toBe(true);
    expect(writeWorkspaceTree(root, files).changed).toBe(false);
    expect(writeWorkspaceTree(root, new Map(), true).deleted.sort()).toEqual([
      "deployments/workspaces/bindings.yaml",
      "deployments/workspaces/profiles/manager.yaml",
    ]);
    expect(writeWorkspaceTree(root, new Map()).changed).toBe(true);
    expect(fs.existsSync(path.join(root, "deployments", "workspaces"))).toBe(false);
  });
});

describe("loadWorkspaceDeclarations + readWorkspaceProfileRecords", () => {
  test("a schema-valid file loads; an unknown apiVersion is refused loudly", () => {
    const root = tempDir("hg-workspaces-");
    const file = path.join(root, "workspaces.yaml");
    fs.writeFileSync(file, yaml(declarations()));
    expect(loadWorkspaceDeclarations(file).repositories[0]!.name).toBe("strategy-context");

    fs.writeFileSync(file, yaml({ ...declarations(), apiVersion: "hermes.gitops/v9" }));
    expect(() => loadWorkspaceDeclarations(file)).toThrow(/unsupported apiVersion/);

    fs.writeFileSync(file, yaml({ ...declarations(), bindings: [] }));
    expect(() => loadWorkspaceDeclarations(file)).toThrow(/failed workspace schema validation/);
  });

  test("profile records read source and sha; garbage records yield no entry", () => {
    const root = tempDir("hg-workspaces-");
    const good = path.join(root, "profiles", "manager");
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, "profile.yaml"), yaml({ spec: { source: "u", sha: "s" } }));
    const bad = path.join(root, "profiles", "broken");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "profile.yaml"), "{: not yaml");
    const records = readWorkspaceProfileRecords(root);
    expect(records.get("manager")).toEqual({ source: "u", sha: "s" });
    expect(records.has("broken")).toBe(false);
  });
});
