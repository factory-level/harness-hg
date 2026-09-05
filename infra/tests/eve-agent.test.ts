// Offline unit tests for the EveAgents component's pure surface (ADR-149):
// the per-agent Command environment and the emit/decommission scripts. No
// Pulumi runtime, no git, no network - the sha resolver is injected.
import { describe, expect, test } from "bun:test";
import * as pulumi from "@pulumi/pulumi";
import versions from "../../versions.json" with { type: "json" };
import {
  EVE_DECOMMISSION_SCRIPT,
  EVE_EMIT_SCRIPT,
  availableSecretNames,
  eveAgentEnv,
} from "../src/components/harness/eve-agent/index.ts";
import {
  parseControlPlaneIngress,
  parseSlack,
  type AgentSpec,
  type BootstrapConfig,
} from "../src/control-flow/config.ts";

function cfg(partial: Partial<BootstrapConfig> = {}): BootstrapConfig {
  return {
    clusterProvider: "none",
    kubeconfigPath: null,
    kubeconfigContext: null,
    gitopsRepoUrl: "https://github.com/org/gitops.git",
    gitopsBranch: "main",
    gitopsBranchProtection: null,
    gitopsRequiredReviewers: null,
    nexusCapabilities: { workspaceReset: false, views: {} },
    slack: parseSlack(undefined),
    hermesGitopsRepoUrl: "https://github.com/factory-level/harness-hg.git",
    chartRevision: "main",
    providers: { compute: "pod", secret: "k8s", ingress: "none" },
    versions: { argocdChart: "1", esoChart: "1", pkoChart: "1" },
    stages: { hermes: false, agents: true, cluster: false },
    argocdRepoCreds: {
      gitopsToken: null,
      gitopsUsername: "git",
      hermesGitopsToken: null,
      hermesGitopsUsername: "git",
    },
    targetClusters: [],
    helmOciRegistries: [],
    agentSecrets: { echo: { AI_GATEWAY_API_KEY: "secret-value-never-emitted" } },
    routerSecrets: {},
    agentGitAuth: {},
    pluginConfig: {
      mode: "pr",
      prAutoMerge: false,
      allowDirectCommit: null,
      profilesPath: null,
      defaultsFile: null,
      overridesDir: null,
      gitAuthorName: null,
      gitAuthorEmail: null,
      imageRepository: null,
      imageTag: null,
    },
    fleetDefaults: null,
    hermesInstall: { source: "", ref: "", pluginPath: "/plugin", scaffold: true },
    agents: [],
    controlPlaneIngress: parseControlPlaneIngress(undefined),
    cloudflareApiToken: null,
    gitopsGitToken: pulumi.secret("ghp_token"),
    reconcile: {
      enabled: false, version: "unpinned", repoUrl: "", branch: "main",
      intervalSeconds: 60, checks: [], apply: "",
    },
    ...partial,
  };
}

const echo: AgentSpec = {
  runtime: "eve",
  source: "github.com/org/agents",
  ref: "main",
  subdir: "agents/echo",
  name: null,
  overrides: null,
};

const SHA = "3f06a1b2c3d4e5f60718293a4b5c6d7e8f901234";
const resolved = () => SHA;
const unresolved = () => null;

describe("availableSecretNames", () => {
  test("a provisioned slack app's SLACK_* names join its config names (ADR 0175)", () => {
    const c = cfg({
      agentSecrets: { "manager-eve": { ANTHROPIC_API_KEY: "x" } },
      slack: parseSlack({
        enabled: true,
        teamId: "T0000000000",
        apps: { "manager-eve": { displayName: "M", botScopes: ["chat:write"] } },
      }),
    });
    expect(availableSecretNames(c)["manager-eve"]).toEqual([
      "ANTHROPIC_API_KEY",
      "SLACK_BOT_TOKEN",
      "SLACK_SIGNING_SECRET",
    ]);
  });

  test("an ADOPTED app and a disabled slack block add nothing", () => {
    const adopted = cfg({
      agentSecrets: { "manager-eve": { SLACK_BOT_TOKEN: "x" } },
      slack: parseSlack({
        enabled: true,
        teamId: "T0000000000",
        apps: { "manager-eve": { displayName: "M", botScopes: ["chat:write"], appId: "A0HANDMADE1" } },
      }),
    });
    expect(availableSecretNames(adopted)["manager-eve"]).toEqual(["SLACK_BOT_TOKEN"]);
    // Disabled slack (the fixture default): config names pass through untouched.
    expect(availableSecretNames(cfg({}))).toEqual({ echo: ["AI_GATEWAY_API_KEY"] });
  });

  test("an instance whose ONLY secrets are provisioned still appears", () => {
    const c = cfg({
      slack: parseSlack({
        enabled: true,
        teamId: "T0000000000",
        apps: { "manager-eve": { displayName: "M", botScopes: ["chat:write"] } },
      }),
    });
    expect(availableSecretNames(c)["manager-eve"]).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_SIGNING_SECRET",
    ]);
  });
});

describe("eveAgentEnv", () => {
  test("carries the plugin config contract, the env config source and the runtime pin", () => {
    const env = eveAgentEnv(cfg(), echo, "/plugin", "install", resolved);
    expect(env["HERMES_GITOPS_CONFIG_SOURCE"]).toBe("env");
    expect(env["HERMES_GITOPS_GITOPS_REPO_URL"]).toBe("https://github.com/org/gitops.git");
    expect(env["HERMES_GITOPS_GITOPS_BRANCH"]).toBe("main");
    expect(env["HERMES_GITOPS_MODE"]).toBe("pr");
    expect(env["HERMES_GITOPS_PR_AUTO_MERGE"]).toBe("false");
    expect(env["HERMES_GITOPS_PLUGIN_PATH"]).toBe("/plugin");
    expect(env["HERMES_GITOPS_EVE_VERSION"]).toBe(versions.runtimes.eve.version);
    expect(env["HERMES_GITOPS_EVE_EVENT"]).toBe("install");
    expect(env["HERMES_GITOPS_REQUIRE_EMITTER"]).toBe("1");
    expect(env["GITOPS_GIT_TOKEN"]).toBeDefined();
  });

  test("overrides.appValues reaches the emit as JSON; absent means no variable (ADR-150)", () => {
    expect(eveAgentEnv(cfg(), echo, "/plugin", "install", resolved)["HERMES_GITOPS_EVE_APP_VALUES_JSON"]).toBeUndefined();
    const withValues: AgentSpec = { ...echo, overrides: { appValues: { db: { auth: { key: "k" } } } } };
    expect(eveAgentEnv(cfg(), withValues, "/plugin", "install", resolved)["HERMES_GITOPS_EVE_APP_VALUES_JSON"]).toBe(
      JSON.stringify({ db: { auth: { key: "k" } } }),
    );
    expect(EVE_EMIT_SCRIPT).toContain("--app-values");
  });

  test("carries the desired state and the plan-time resolved sha", () => {
    const env = eveAgentEnv(cfg(), echo, "/plugin", "install", resolved);
    expect(env["HERMES_GITOPS_DESIRED_SOURCE"]).toBe("github.com/org/agents");
    expect(env["HERMES_GITOPS_DESIRED_REF"]).toBe("main");
    expect(env["HERMES_GITOPS_DESIRED_SUBDIR"]).toBe("agents/echo");
    expect(env["HERMES_GITOPS_DESIRED_SOURCE_SHA"]).toBe(SHA);
    expect(env["HERMES_GITOPS_DESIRED_NAME"]).toBeUndefined();
    expect(env["HERMES_GITOPS_DESIRED_OVERRIDES_DOC"]).toBeUndefined();
  });

  test("an unresolvable ref omits the sha input (the script resolves at apply time)", () => {
    const env = eveAgentEnv(cfg(), echo, "/plugin", "install", unresolved);
    expect(env["HERMES_GITOPS_DESIRED_SOURCE_SHA"]).toBeUndefined();
  });

  test("agentSecrets feed the fail-loud check as names only, never values", () => {
    const env = eveAgentEnv(cfg(), echo, "/plugin", "install", resolved);
    expect(JSON.parse(env["HERMES_GITOPS_AVAILABLE_SECRETS_JSON"] as string)).toEqual({
      echo: ["AI_GATEWAY_API_KEY"],
    });
    expect(JSON.stringify(env)).not.toContain("secret-value-never-emitted");
  });
});

describe("the emit and decommission scripts", () => {
  test("the emit script clones, checks out the sha and runs emit_cli from the plugin checkout", () => {
    expect(EVE_EMIT_SCRIPT).toContain("git clone --quiet");
    expect(EVE_EMIT_SCRIPT).toContain('checkout --quiet --detach "$SHA"');
    expect(EVE_EMIT_SCRIPT).toContain("python -m gitops_emitter.emit_cli --runtime eve");
    expect(EVE_EMIT_SCRIPT).toContain('--expect-eve-version "$HERMES_GITOPS_EVE_VERSION"');
    expect(EVE_EMIT_SCRIPT).toContain('uv run --directory "$HERMES_GITOPS_PLUGIN_PATH"');
    // never a `hermes` invocation - no stage 1 for Eve
    expect(EVE_EMIT_SCRIPT).not.toContain("hermes profile");
    expect(EVE_EMIT_SCRIPT).toContain("set -eu");
    // the scratch checkout is cleaned up whatever happens
    expect(EVE_EMIT_SCRIPT).toContain("trap 'rm -rf \"$WORK\"' EXIT");
  });

  test("the decommission script prunes by name or source through the unchanged CLI", () => {
    expect(EVE_DECOMMISSION_SCRIPT).toContain("gitops_emitter.decommission_cli \"$HERMES_GITOPS_DESIRED_NAME\"");
    expect(EVE_DECOMMISSION_SCRIPT).toContain("gitops_emitter.decommission_cli --source");
    // a monorepo's agents share one source - the subdir disambiguates
    expect(EVE_DECOMMISSION_SCRIPT).toContain('--subdir "$HERMES_GITOPS_DESIRED_SUBDIR"');
    expect(EVE_DECOMMISSION_SCRIPT).toContain("exit 0"); // a gone checkout is reported, not fatal
  });

  test("no script carries a literal eve version (ADR-63)", () => {
    for (const s of [EVE_EMIT_SCRIPT, EVE_DECOMMISSION_SCRIPT]) {
      expect(s).not.toContain(versions.runtimes.eve.version);
    }
  });
});
