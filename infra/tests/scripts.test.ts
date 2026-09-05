// Offline unit tests for the pure script-building surface of the
// hermes-install / hermes-agent components — no Pulumi runtime involved.
import { describe, expect, test } from "bun:test";
import {
  buildInstallScript,
  shellQuote,
} from "../src/components/harness/hermes-install/index.ts";
import {
  AGENT_DECOMMISSION_SCRIPT,
  AGENT_INSTALL_SCRIPT,
  agentDesiredStateEnv,
  agentSlug,
  overridesDocument,
  resolveSourceRevision,
} from "../src/components/harness/hermes-agent/index.ts";
import type { AgentSpec } from "../src/control-flow/config.ts";

function agent(partial: Partial<AgentSpec>): AgentSpec {
  return {
    runtime: "hermes" as const,
    source: "github.com/example/agent",
    ref: "",
    subdir: "",
    name: null,
    overrides: null,
    ...partial,
  };
}

describe("shellQuote", () => {
  test("passes plain tokens through", () => {
    expect(shellQuote("github.com/example/agent")).toBe("github.com/example/agent");
  });
  test("quotes shell metacharacters", () => {
    expect(shellQuote("a b;c")).toBe("'a b;c'");
  });
  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });
});

describe("buildInstallScript", () => {
  test("git URL source becomes a PEP 508 git+ spec with ref pin", () => {
    const script = buildInstallScript("https://github.com/x/fork.git", "v2", "/plugin");
    expect(script).toContain(
      "uv tool install git+https://github.com/x/fork.git@v2 --with /plugin --force",
    );
    expect(script).toContain("hermes_agent.plugins");
    expect(script).toContain("_resolve_hermes_py");
  });

  test("an already-prefixed git+ source is not double-prefixed", () => {
    const script = buildInstallScript("git+https://github.com/x/fork.git", "", "/plugin");
    expect(script).toContain("uv tool install git+https://github.com/x/fork.git --with /plugin --force");
  });

  test("local directory source WITH ref installs pinned from the git database (D3)", () => {
    const script = buildInstallScript(import.meta.dir, "abc123", "/plugin");
    expect(script).toContain(`uv tool install git+file://${import.meta.dir}@abc123 --with /plugin --force`);
    expect(script).not.toContain("--editable");
  });

  test("local directory source installs editable", () => {
    // The repo root itself is a directory that always exists.
    const script = buildInstallScript(import.meta.dir, "", "/plugin");
    expect(script).toContain(`uv tool install --editable ${import.meta.dir} --with /plugin --force`);
  });
});

describe("agentSlug", () => {
  test("prefers the explicit name", () => {
    expect(agentSlug(agent({ name: "My Agent" }))).toBe("my-agent");
  });
  test("falls back to a sanitized source", () => {
    expect(agentSlug(agent({}))).toBe("github-com-example-agent");
  });
  test("subdir participates - one monorepo, many distributions must not collide", () => {
    const a = agentSlug(agent({ subdir: "distributions/manager" }));
    const b = agentSlug(agent({ subdir: "distributions/research" }));
    expect(a).toBe("github-com-example-agent-distributions-manager");
    expect(a).not.toBe(b);
  });
  test("degenerate input falls back to 'agent'", () => {
    expect(agentSlug(agent({ source: "###" }))).toBe("agent");
  });
});

describe("overridesDocument", () => {
  test("null when there is nothing to override", () => {
    expect(overridesDocument(agent({}))).toBeNull();
  });

  test("the document is exactly the overrides mapping (apps rides along)", () => {
    const doc = overridesDocument(
      agent({
        overrides: {
          deployment: { diskSizeGb: 50 },
          apps: [{ name: "vector-db", values: { replicas: 2 } }],
        },
      }),
    );
    expect(doc).not.toBeNull();
    // JSON is a strict subset of YAML — the plugin's yaml.safe_load reads
    // this document unchanged.
    const parsed = JSON.parse(doc!);
    expect(parsed).toEqual({
      deployment: { diskSizeGb: 50 },
      apps: [{ name: "vector-db", values: { replicas: 2 } }],
    });
  });
});

describe("agent install (K1: static script + env-carried desired state)", () => {
  test("the script is static - no per-agent values embedded", () => {
    expect(AGENT_INSTALL_SCRIPT).toContain("$HERMES_GITOPS_DESIRED_SOURCE");
    expect(AGENT_INSTALL_SCRIPT).toContain("HERMES_GITOPS_DESIRED_NAME");
    expect(AGENT_INSTALL_SCRIPT).toContain("HERMES_GITOPS_DESIRED_OVERRIDES_DOC");
    expect(AGENT_INSTALL_SCRIPT).toContain("hermes profile install");
    // ADR 0178: a /src subdir clones the source beside the install and names
    // the contract dir for the emitter hook; nothing else changes.
    expect(AGENT_INSTALL_SCRIPT).toContain("*/src|src)");
    expect(AGENT_INSTALL_SCRIPT).toContain('export HERMES_GITOPS_CONTRACT_DIR="$CWORK/src/${AGENT_DIR:+$AGENT_DIR/}harness-hg"');
    expect(AGENT_INSTALL_SCRIPT).toContain("HERMES_GITOPS_DESIRED_SOURCE_SHA");
    // an existing profile re-installs with --force (update cannot change the
    // subdir - found live on the ADR 0178 cutover); never `profile update`
    expect(AGENT_INSTALL_SCRIPT).toContain('"$@" --force');
    expect(AGENT_INSTALL_SCRIPT).not.toContain("hermes profile update");
    expect(AGENT_INSTALL_SCRIPT).not.toContain("github.com");
  });

  test("F5: the first install carries no --force; already-exists re-installs with --force (update cannot change a subdir)", () => {
    const firstInstall = AGENT_INSTALL_SCRIPT.split("\n").find((l) => l.startsWith("set -- hermes profile install"))!;
    expect(firstInstall).not.toContain("--force");
    expect(AGENT_INSTALL_SCRIPT).not.toContain("hermes profile update");
    expect(AGENT_INSTALL_SCRIPT).toContain('"$@" --force');
  });

  test("desired-state env carries source/ref/name/overrides as discrete keys", () => {
    const a = agent({
      ref: "v1",
      name: "my-agent",
      overrides: { apps: [{ name: "vector-db", values: { replicas: 2 } }] },
    });
    const env = agentDesiredStateEnv(a, overridesDocument(a), () => "c".repeat(40));
    expect(env["HERMES_GITOPS_DESIRED_SOURCE"]).toBe("github.com/example/agent");
    expect(env["HERMES_GITOPS_DESIRED_REF"]).toBe("v1");
    expect(env["HERMES_GITOPS_DESIRED_NAME"]).toBe("my-agent");
    expect(JSON.parse(env["HERMES_GITOPS_DESIRED_OVERRIDES_DOC"]!)).toEqual({
      apps: [{ name: "vector-db", values: { replicas: 2 } }],
    });
    expect(env["HERMES_GITOPS_AGENT_SLUG"]).toBe("my-agent");
    expect(env["HERMES_GITOPS_DESIRED_SOURCE_SHA"]).toBe("c".repeat(40));
  });

  test("optional keys are absent when undeclared (no-op preview when unchanged)", () => {
    const env = agentDesiredStateEnv(agent({}), null, () => null);
    expect(env["HERMES_GITOPS_DESIRED_REF"]).toBeUndefined();
    expect(env["HERMES_GITOPS_DESIRED_NAME"]).toBeUndefined();
    expect(env["HERMES_GITOPS_DESIRED_OVERRIDES_DOC"]).toBeUndefined();
  });
});

describe("resolveSourceRevision (F5: mutable-ref drift)", () => {
  test("an immutable 40-hex ref is returned as-is, no network", () => {
    const sha = "a".repeat(40);
    expect(resolveSourceRevision("github.com/org/repo", sha)).toBe(sha);
  });

  test("a local git repo's branch resolves to its tip sha", () => {
    // this repo itself is a git checkout
    const repoRoot = new URL("../..", import.meta.url).pathname;
    const resolved = resolveSourceRevision(repoRoot, "");
    expect(resolved).toMatch(/^[0-9a-f]{40}$/);
  });

  test("an unreachable source returns null (degrades, not breaks)", () => {
    expect(resolveSourceRevision("/nonexistent/repo/path", "")).toBeNull();
  });
});

describe("AGENT_DECOMMISSION_SCRIPT (F6)", () => {
  test("static script prunes via the plugin CLI, by name or source", () => {
    expect(AGENT_DECOMMISSION_SCRIPT).toContain("gitops_emitter.decommission_cli");
    expect(AGENT_DECOMMISSION_SCRIPT).toContain("HERMES_GITOPS_DESIRED_NAME");
    expect(AGENT_DECOMMISSION_SCRIPT).toContain("--source");
    // teardown races never block destroy
    expect(AGENT_DECOMMISSION_SCRIPT).toContain("exit 0");
  });
});

describe("agentDesiredStateEnv subdir threading", () => {
  test("agents[].subdir rides HERMES_GITOPS_DESIRED_SUBDIR", () => {
    const env = agentDesiredStateEnv(
      agent({ subdir: ".hermes-dist/agent" }),
      null,
      () => "0000000000000000000000000000000000000000",
    );
    expect(env["HERMES_GITOPS_DESIRED_SUBDIR"]).toBe(".hermes-dist/agent");
  });

  test("root layout omits the env var", () => {
    const env = agentDesiredStateEnv(
      agent({}),
      null,
      () => "0000000000000000000000000000000000000000",
    );
    expect("HERMES_GITOPS_DESIRED_SUBDIR" in env).toBe(false);
  });
});
