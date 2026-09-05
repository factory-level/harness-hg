// The agent runtime manifest builder (ADR-153), offline.
//
// The point of these tests is the CONTRACT the charts must match: the
// manifest is compared against the copy the eve-agent / eve-bundle charts
// mount (EVE022), so anything the builder decides here - sorting, which
// fields are omitted, where a workspace is mounted - is a claim about what
// the templates render too.

import { describe, expect, test } from "bun:test";
import { manifestDiff } from "../src/harness/eve/prove.ts";
import {
  buildRuntimeManifest,
  manifestFromBundle,
  manifestFromRecord,
  serializeRuntimeManifest,
  validateRuntimeManifest,
  RUNTIME_MANIFEST_CONTRACT,
} from "../src/harness/manifest.ts";

const CTX = { name: "echo", instance: "ag-eve-echo", namespace: "ag-eve-echo", runtimeImage: "img:1" };

describe("buildRuntimeManifest", () => {
  test("sorts every list, so two producers can be compared", () => {
    const m = buildRuntimeManifest({
      name: "echo",
      engine: "eve",
      instance: "ag-eve-echo",
      namespace: "ag-eve-echo",
      runtimeImage: "img:1",
      source: "https://example.com/x.git",
      revision: "a".repeat(40),
      workspaces: [
        { name: "zeta", path: "/w/zeta", access: "read-write", repository: "r2", revision: "b".repeat(40) },
        { name: "alpha", path: "/w/alpha", access: "read-only", repository: "r1", revision: "c".repeat(40) },
      ],
      requiredSecrets: ["Z_TOKEN", "A_TOKEN", "Z_TOKEN"],
      connections: [
        { name: "platform-github", provider: "github" },
        { name: "company-discord", provider: "discord" },
      ],
      apps: ["site", "docs", "site"],
    });
    expect(m.contract).toBe(RUNTIME_MANIFEST_CONTRACT);
    expect(m.spec.workspaces.map((w) => w.name)).toEqual(["alpha", "zeta"]);
    expect(m.spec.requiredSecrets).toEqual(["A_TOKEN", "Z_TOKEN"]);
    expect(m.spec.connections.map((c) => c.name)).toEqual(["company-discord", "platform-github"]);
    expect(m.spec.apps).toEqual(["docs", "site"]);
  });

  test("omits bundle and subdir rather than emitting empty ones", () => {
    const m = buildRuntimeManifest({
      name: "echo", engine: "eve", instance: "i", namespace: "n", runtimeImage: "img:1",
      source: "s", revision: "r", workspaces: [], requiredSecrets: [], connections: [], apps: [],
    });
    expect("bundle" in m.spec).toBe(false);
    expect("subdir" in m.spec.source).toBe(false);
  });

  test("serializes as two-space JSON with a trailing newline", () => {
    const m = buildRuntimeManifest({
      name: "e", engine: "eve", instance: "i", namespace: "n", runtimeImage: "img:1",
      source: "s", revision: "r", workspaces: [], requiredSecrets: [], connections: [], apps: [],
    });
    const text = serializeRuntimeManifest(m);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(m);
  });
});

describe("manifestFromRecord (standalone)", () => {
  const record = {
    persona: "echo",
    runtime: "eve",
    source: "https://example.com/x.git",
    sha: "a".repeat(40),
    sourceSubdir: "agents/echo",
    envRequires: [{ name: "ANTHROPIC_API_KEY" }, { name: "DISCORD_BOT_TOKEN" }],
    apps: [{ name: "docs-site" }],
    connections: [{ name: "company-discord", provider: "discord" }],
    workspace: { repositories: [{ name: "own-source", source: "https://example.com/x.git", sha: "b".repeat(40), access: "read-only" }] },
  };

  test("mounts a standalone agent's workspaces under /app/workspaces", () => {
    // The eve-agent chart's $wsRepos loop mounts there, on the data claim,
    // NOT at the binding's declared mountPath. The manifest reports what
    // the pod actually has.
    const m = manifestFromRecord(record, CTX);
    expect(m.spec.workspaces).toEqual([
      { name: "own-source", path: "/app/workspaces/own-source", access: "read-only", repository: "https://example.com/x.git", revision: "b".repeat(40) },
    ]);
  });

  test("carries names, revisions and the record's own apps", () => {
    const m = manifestFromRecord(record, CTX);
    expect(m.spec.engine).toBe("eve");
    expect(m.spec.source).toEqual({ repository: "https://example.com/x.git", revision: "a".repeat(40), subdir: "agents/echo" });
    expect(m.spec.requiredSecrets).toEqual(["ANTHROPIC_API_KEY", "DISCORD_BOT_TOKEN"]);
    expect(m.spec.apps).toEqual(["docs-site"]);
    expect(m.spec.connections).toEqual([{ name: "company-discord", provider: "discord" }]);
  });

  test("a record with no runtime key is a Hermes agent", () => {
    const m = manifestFromRecord({ persona: "manager", source: "s", sha: "r" }, { ...CTX, instance: "hermes-manager" });
    expect(m.spec.engine).toBe("hermes");
  });
});

describe("manifestFromBundle (a member)", () => {
  const bundle = {
    runtime: "eve",
    name: "team",
    profiles: [
      {
        name: "echo",
        source: "https://example.com/x.git",
        sha: "a".repeat(40),
        sourceSubdir: "agents/echo",
        envRequires: ["ANTHROPIC_API_KEY"],
        repositoryRefs: ["own-source"],
        connections: [{ name: "company-discord", provider: "discord" }],
      },
      { name: "greeter", source: "https://example.com/x.git", sha: "a".repeat(40), repositoryRefs: [] },
    ],
    repositories: [
      { name: "own-source", source: "https://example.com/x.git", sha: "b".repeat(40), access: "read-only", mountPath: "/workspaces/own-source" },
      { name: "unbound", source: "https://example.com/y.git", sha: "c".repeat(40), access: "read-write", mountPath: "/workspaces/unbound" },
    ],
  };
  const ctx = { instance: "ag-eve-team-echo", namespace: "ag-eve-team", runtimeImage: "img:1" };

  test("a member gets ONLY the repositories its repositoryRefs names", () => {
    const m = manifestFromBundle(bundle, "echo", ctx)!;
    expect(m.spec.bundle).toBe("team");
    expect(m.spec.workspaces.map((w) => w.name)).toEqual(["own-source"]);
    expect(m.spec.workspaces[0]!.path).toBe("/workspaces/own-source");
  });

  test("a member with no bindings gets none, and no apps (EVE020)", () => {
    const m = manifestFromBundle(bundle, "greeter", ctx)!;
    expect(m.spec.workspaces).toEqual([]);
    expect(m.spec.apps).toEqual([]);
    expect(m.spec.requiredSecrets).toEqual([]);
  });

  test("an unknown member is null, never an empty manifest", () => {
    expect(manifestFromBundle(bundle, "nobody", ctx)).toBeNull();
  });
});

describe("manifestDiff (EVE022's comparison)", () => {
  const base = manifestFromRecord(
    {
      persona: "echo", runtime: "eve", source: "s", sha: "a".repeat(40),
      workspace: { repositories: [{ name: "own-source", source: "s", sha: "b".repeat(40), access: "read-only" }] },
    },
    CTX,
  );

  test("key ORDER is not a difference", () => {
    // Helm's toJson sorts keys; JSON.stringify keeps insertion order. A
    // stringify comparison above the leaves reported every array element
    // as differing - the trap this test exists to keep shut.
    const reordered = JSON.parse(JSON.stringify(base, Object.keys(base.spec.workspaces[0]!).sort().concat(
      ["contract", "spec", "name", "engine", "instance", "namespace", "runtimeImage", "source", "workspaces",
       "requiredSecrets", "connections", "apps", "repository", "revision"])));
    expect(manifestDiff(base, reordered)).toEqual([]);
  });

  test("names the field that differs, not just that they differ", () => {
    const other = JSON.parse(JSON.stringify(base));
    other.spec.workspaces[0].access = "read-write";
    other.spec.source.revision = "c".repeat(40);
    const diffs = manifestDiff(base, other);
    expect(diffs).toHaveLength(2);
    expect(diffs.join("\n")).toContain("spec.source.revision");
    expect(diffs.join("\n")).toContain("spec.workspaces[0].access");
  });

  test("a missing field is reported as absent, not skipped", () => {
    const other = JSON.parse(JSON.stringify(base));
    delete other.spec.runtimeImage;
    expect(manifestDiff(base, other).join("")).toContain("spec.runtimeImage");
  });
});

describe("validateRuntimeManifest (the frozen contract)", () => {
  test("what the builder produces is valid", () => {
    const m = manifestFromRecord(
      {
        persona: "echo", runtime: "eve", source: "https://example.com/x.git", sha: "a".repeat(40),
        sourceSubdir: "agents/echo", envRequires: ["AI_GATEWAY_API_KEY"],
        connections: [{ name: "company-discord", provider: "discord" }],
        workspace: { repositories: [{ name: "own-source", source: "https://example.com/x.git", sha: "b".repeat(40), access: "read-only" }] },
      },
      CTX,
    );
    expect(validateRuntimeManifest(m)).toEqual([]);
  });

  test("a VALUE where a name belongs is refused", () => {
    // The failure this contract exists to prevent: a credential smuggled
    // into what is a ConfigMap in the agent's namespace.
    const m: any = manifestFromRecord({ persona: "e", runtime: "eve", source: "s", sha: "a".repeat(40) }, CTX);
    m.spec.requiredSecrets = [{ name: "AI_GATEWAY_API_KEY", value: "sk-not-real" }];
    expect(validateRuntimeManifest(m).length).toBeGreaterThan(0);
  });

  test("an invented field names itself in the error", () => {
    const m: any = manifestFromRecord({ persona: "e", runtime: "eve", source: "s", sha: "a".repeat(40) }, CTX);
    m.spec.replicas = 2;
    expect(validateRuntimeManifest(m).join("")).toContain("replicas");
  });
});
