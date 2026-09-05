// Offline unit tests for the pure config-parsing surface of
// control-flow/config.ts — no Pulumi runtime involved.
import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  DEFAULT_ARGOCD_CHART_VERSION,
  DEFAULT_ESO_CHART_VERSION,
  DEFAULT_PKO_CHART_VERSION,
  gitopsRepoIsPlaceholder,
  parseAgents,
  agentInstanceName,
  validateEveSecretOwnership,
  parseArgoRepoCreds,
  parseClusterProvider,
  isGithubRepoUrl,
  parseFleetDefaults,
  parsePluginConfig,
  parseSlack,
  validateAgentOverrides,
  parseHelmOciRegistries,
  parseTargetClusters,
  parseControlPlaneIngress,
  controlPlaneHostnames,
  validatePrerequisites,
  parseReconcile,
  type BootstrapConfig,
  parseHermesInstall,
  parseProviders,
  parseStages,
  parseVersions,
  parseNexusCapabilities,
} from "../src/control-flow/config.ts";
import { clusterSecretStringData, ociRegistrySlug } from "../src/components/argocd/index.ts";
import {
  validateHermesExtensionFile,
  EXTENSION_KEYS,
  EXTENSION_KEYS_V2,
  APP_ENTRY_KEYS_V2,
} from "../src/control-flow/config.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";

describe("parseClusterProvider", () => {
  test("defaults to none when absent/empty", () => {
    expect(parseClusterProvider(undefined)).toBe("none");
    expect(parseClusterProvider(null)).toBe("none");
    expect(parseClusterProvider("")).toBe("none");
  });

  test("accepts every enum member", () => {
    for (const v of ["none", "k3s-local", "gke-autopilot", "eks-fargate"] as const) {
      expect(parseClusterProvider(v)).toBe(v);
    }
  });

  test("rejects an unknown value with the valid options listed", () => {
    expect(() => parseClusterProvider("minikube")).toThrow(ConfigError);
    expect(() => parseClusterProvider("minikube")).toThrow(
      /expected one of: none, k3s-local, gke-autopilot, eks-fargate/,
    );
  });
});

describe("parseProviders", () => {
  test("accepts the valid pod/k8s/ingress combination", () => {
    expect(parseProviders({ compute: "pod", secret: "k8s", ingress: "ingress" })).toEqual({
      compute: "pod",
      secret: "k8s",
      ingress: "ingress",
    });
  });

  test("rejects a missing key with a readable message", () => {
    expect(() => parseProviders({ compute: "pod", secret: "k8s" })).toThrow(ConfigError);
    expect(() => parseProviders({ compute: "pod", secret: "k8s" })).toThrow(
      /providers\.ingress is required/,
    );
  });

  test("rejects the removed gce/libvirt compute values", () => {
    for (const legacy of ["gce", "libvirt"]) {
      expect(() =>
        parseProviders({ compute: legacy, secret: "k8s", ingress: "none" }),
      ).toThrow(/providers\.compute = "\w+" is not valid; expected one of: pod/);
    }
  });

  test("rejects an unknown secret provider", () => {
    expect(() =>
      parseProviders({ compute: "pod", secret: "aws", ingress: "none" }),
    ).toThrow(ConfigError);
  });
});

describe("parseVersions / parseStages / parseHermesInstall", () => {
  test("versions default to the pinned charts", () => {
    expect(parseVersions({})).toEqual({
      argocdChart: DEFAULT_ARGOCD_CHART_VERSION,
      esoChart: DEFAULT_ESO_CHART_VERSION,
      pkoChart: DEFAULT_PKO_CHART_VERSION,
    });
  });

  test("stages default to all-on and honor explicit false", () => {
    expect(parseStages({})).toEqual({ hermes: true, agents: true, cluster: true });
    expect(parseStages({ cluster: false })).toEqual({
      hermes: true,
      agents: true,
      cluster: false,
    });
  });

  test("hermes install defaults", () => {
    expect(parseHermesInstall({})).toEqual({
      source: "",
      ref: "",
      pluginPath: "",
      scaffold: true,
    });
    expect(parseHermesInstall({ scaffold: false }).scaffold).toBe(false);
  });
});

describe("parseAgents", () => {
  test("null/undefined means no agents", () => {
    expect(parseAgents(undefined)).toEqual([]);
    expect(parseAgents(null)).toEqual([]);
  });

  test("non-list agents config is rejected", () => {
    expect(() => parseAgents({ source: "x" })).toThrow(/agents must be a list/);
  });

  test("agent entries require source", () => {
    expect(() => parseAgents([{}])).toThrow(/agents\[0\]\.source is required/);
  });

  test("agent entry fields are normalized", () => {
    expect(
      parseAgents([
        {
          source: "github.com/example/agent",
          ref: "v1",
          name: "my-agent",
          overrides: { deployment: { diskSizeGb: 50 } },
        },
      ]),
    ).toEqual([
      {
        runtime: "hermes",
        source: "github.com/example/agent",
        ref: "v1",
        subdir: "",
        name: "my-agent",
        overrides: { deployment: { diskSizeGb: 50 } },
      },
    ]);
  });

  test("agents[].runtime defaults to hermes, accepts eve, rejects anything else (ADR-149)", () => {
    expect(parseAgents([{ source: "x" }])[0]!.runtime).toBe("hermes");
    expect(parseAgents([{ source: "x", runtime: "hermes" }])[0]!.runtime).toBe("hermes");
    expect(
      parseAgents([{ source: "github.com/example/agents", ref: "main", subdir: "agents/echo", runtime: "eve" }]),
    ).toEqual([
      {
        runtime: "eve",
        source: "github.com/example/agents",
        ref: "main",
        subdir: "agents/echo",
        name: null,
        overrides: null,
      },
    ]);
    expect(() => parseAgents([{ source: "x", runtime: "vercel" }])).toThrow(
      /runtime must be one of hermes, eve/,
    );
    expect(() => parseAgents([{ source: "x", runtime: 1 }])).toThrow(/runtime must be one of/);
  });

  test("agents[].overrides is refused for runtime: eve", () => {
    expect(() =>
      parseAgents([{ source: "x", runtime: "eve", overrides: { deployment: { diskSizeGb: 20 } } }]),
    ).toThrow(/overrides.deployment is not supported for runtime: eve/);
    // appValues is the one override an Eve instance carries (ADR-150).
    expect(
      parseAgents([{ source: "x", runtime: "eve", overrides: { appValues: { db: { size: 1 } } } }])[0]!.overrides,
    ).toEqual({ appValues: { db: { size: 1 } } });
  });

  test("agents[].subdir parses and is validated (fork --subdir form)", () => {
    expect(
      parseAgents([{ source: "github.com/example/mono", subdir: ".hermes-dist/agent/" }]),
    ).toEqual([
      {
        runtime: "hermes",
        source: "github.com/example/mono",
        ref: "",
        subdir: ".hermes-dist/agent",
        name: null,
        overrides: null,
      },
    ]);
    expect(() => parseAgents([{ source: "x", subdir: "/abs" }])).toThrow(
      /subdir must be a relative path/,
    );
    expect(() => parseAgents([{ source: "x", subdir: "a/../b" }])).toThrow(
      /subdir must be a relative path/,
    );
    expect(() => parseAgents([{ source: "x", subdir: 5 }])).toThrow(
      /subdir must be a string/,
    );
  });

  test("the removed agents[].workloads key is rejected with a migration hint", () => {
    expect(() => parseAgents([{ source: "x", workloads: ["a"] }])).toThrow(
      /workloads was removed.*apps/s,
    );
  });

  test("non-mapping overrides are rejected", () => {
    expect(() => parseAgents([{ source: "x", overrides: ["a"] }])).toThrow(
      /overrides must be a mapping/,
    );
  });
});

describe("gitopsRepoIsPlaceholder", () => {
  test("flags the known placeholder markers", () => {
    for (const url of [
      "https://example.invalid/replace-me/gitops.git",
      "https://github.com/__GITOPS_REPO_URL__/x.git",
      "https://github.com/REPLACE_ME/gitops.git",
    ]) {
      expect(gitopsRepoIsPlaceholder(url)).toBe(true);
    }
  });

  test("accepts a real repo URL", () => {
    expect(gitopsRepoIsPlaceholder("https://github.com/factory-level/gitops.git")).toBe(false);
  });
});

describe("parseArgoRepoCreds", () => {
  test("defaults usernames to git and tokens to null", () => {
    expect(parseArgoRepoCreds({})).toEqual({
      gitopsToken: null,
      gitopsUsername: "git",
      hermesGitopsToken: null,
      hermesGitopsUsername: "git",
    });
  });
});

describe("clusterSecretStringData (C1: Argo CD cluster Secret payload)", () => {
  test("builds the declarative-setup stringData shape", () => {
    expect(
      clusterSecretStringData({
        name: "workload-eu-1",
        server: "https://10.0.0.5:6443",
        bearerToken: "sa-token",
        caData: "Y2E=",
        insecure: false,
      }),
    ).toEqual({
      name: "workload-eu-1",
      server: "https://10.0.0.5:6443",
      config: JSON.stringify({
        bearerToken: "sa-token",
        tlsClientConfig: { insecure: false, caData: "Y2E=" },
      }),
    });
  });

  test("omits caData from the TLS block when insecure", () => {
    const data = clusterSecretStringData({
      name: "dev",
      server: "https://127.0.0.1:6443",
      bearerToken: "t",
      caData: null,
      insecure: true,
    });
    expect(JSON.parse(data["config"] as string)).toEqual({
      bearerToken: "t",
      tlsClientConfig: { insecure: true },
    });
  });
});

describe("parseTargetClusters (C1: remote workload cluster registration)", () => {
  const VALID = {
    name: "workload-eu-1",
    server: "https://10.0.0.5:6443",
    bearerToken: "sa-token",
    caData: "Y2E=",
  };

  test("absent config means no registered clusters (backward compatible)", () => {
    expect(parseTargetClusters(undefined)).toEqual([]);
    expect(parseTargetClusters(null)).toEqual([]);
  });

  test("valid entry parses with insecure defaulting to false", () => {
    expect(parseTargetClusters([VALID])).toEqual([
      {
        name: "workload-eu-1",
        server: "https://10.0.0.5:6443",
        bearerToken: "sa-token",
        caData: "Y2E=",
        insecure: false,
      },
    ]);
  });

  test("unknown keys fail at preview", () => {
    expect(() => parseTargetClusters([{ ...VALID, bogus: 1 }])).toThrow(
      /bogus is not a recognized target-cluster key/,
    );
  });

  test("name must be a DNS-1123 label", () => {
    expect(() => parseTargetClusters([{ ...VALID, name: "Bad_Name" }])).toThrow(
      /must be a DNS-1123 label/,
    );
  });

  test("in-cluster is reserved", () => {
    expect(() => parseTargetClusters([{ ...VALID, name: "in-cluster" }])).toThrow(
      /reserved/,
    );
  });

  test("duplicate names fail", () => {
    expect(() => parseTargetClusters([VALID, VALID])).toThrow(/declared twice/);
  });

  test("server must be https", () => {
    expect(() => parseTargetClusters([{ ...VALID, server: "http://x" }])).toThrow(
      /https:\/\/ API server URL/,
    );
  });

  test("bearerToken is required", () => {
    const { bearerToken: _drop, ...rest } = VALID;
    expect(() => parseTargetClusters([rest])).toThrow(/bearerToken is required/);
  });

  test("caData or insecure is required", () => {
    const { caData: _drop, ...rest } = VALID;
    expect(() => parseTargetClusters([rest])).toThrow(/caData .* or insecure/);
    expect(parseTargetClusters([{ ...rest, insecure: true }])[0]?.insecure).toBe(true);
  });
});

describe("parseHelmOciRegistries (#187: helm-OCI repository Secrets)", () => {
  const VALID = { url: "oci://ghcr.io/factory-level/charts" };

  test("absent config means no registries (backward compatible)", () => {
    expect(parseHelmOciRegistries(undefined)).toEqual([]);
    expect(parseHelmOciRegistries(null)).toEqual([]);
  });

  test("valid anonymous entry parses with insecure defaulting to false", () => {
    expect(parseHelmOciRegistries([VALID])).toEqual([
      {
        url: "oci://ghcr.io/factory-level/charts",
        username: null,
        token: null,
        insecure: false,
      },
    ]);
  });

  test("url must be oci:// (the record/allowlist identity form)", () => {
    expect(() => parseHelmOciRegistries([{ url: "https://ghcr.io/x" }])).toThrow(
      /must be the registry's oci:\/\/ URL/,
    );
    expect(() => parseHelmOciRegistries([{ url: "ghcr.io/x" }])).toThrow(
      /must be the registry's oci:\/\/ URL/,
    );
  });

  test("unknown keys fail at preview", () => {
    expect(() => parseHelmOciRegistries([{ ...VALID, bogus: 1 }])).toThrow(
      /bogus is not a recognized helm-OCI registry key/,
    );
  });

  test("username and token must come together", () => {
    expect(() => parseHelmOciRegistries([{ ...VALID, username: "u" }])).toThrow(
      /username and token together/,
    );
    expect(() => parseHelmOciRegistries([{ ...VALID, token: "t" }])).toThrow(
      /username and token together/,
    );
    expect(
      parseHelmOciRegistries([{ ...VALID, username: "u", token: "t" }])[0],
    ).toEqual({ url: VALID.url, username: "u", token: "t", insecure: false });
  });

  test("duplicate urls fail", () => {
    expect(() => parseHelmOciRegistries([VALID, { ...VALID }])).toThrow(
      /declared twice/,
    );
  });

  test("insecure must be a boolean", () => {
    expect(() => parseHelmOciRegistries([{ ...VALID, insecure: "yes" }])).toThrow(
      /insecure must be a boolean/,
    );
  });

  test("non-string credentials fail at preview (never reach stringData)", () => {
    expect(() =>
      parseHelmOciRegistries([{ ...VALID, username: 123, token: "t" }]),
    ).toThrow(/username must be a non-empty string/);
    expect(() =>
      parseHelmOciRegistries([{ ...VALID, username: "u", token: true }]),
    ).toThrow(/token must be a non-empty string/);
    expect(() =>
      parseHelmOciRegistries([{ ...VALID, username: "", token: "t" }]),
    ).toThrow(/username must be a non-empty string/);
  });
});

describe("ociRegistrySlug (#187: repository Secret identity)", () => {
  test("distinct hosts that flatten to the same readable prefix stay distinct", () => {
    const a = ociRegistrySlug("registry.example/x-y");
    const b = ociRegistrySlug("registry.example/x/y");
    expect(a).not.toBe(b);
    expect(a.startsWith("registry-example-x-y-")).toBe(true);
  });

  test("long URLs stay within DNS-label bounds", () => {
    const slug = ociRegistrySlug(`ghcr.io/${"very-long-org-name/".repeat(20)}charts`);
    expect(slug.length).toBeLessThanOrEqual(49);
    expect(slug).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  });

  test("is deterministic", () => {
    expect(ociRegistrySlug("ghcr.io/factory-level/charts")).toBe(
      ociRegistrySlug("ghcr.io/factory-level/charts"),
    );
  });
});

describe("validatePrerequisites", () => {
  function cfg(partial: Partial<BootstrapConfig>): BootstrapConfig {
    return {
      clusterProvider: "none",
      kubeconfigPath: null,
      kubeconfigContext: null,
      gitopsRepoUrl: "https://example.invalid/replace-me/gitops.git",
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
      agentSecrets: {},
      routerSecrets: {},
      agentGitAuth: {},
      pluginConfig: {
        mode: null,
        prAutoMerge: null,
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
      hermesInstall: { source: "", ref: "", pluginPath: "", scaffold: true },
      agents: [],
      controlPlaneIngress: parseControlPlaneIngress(undefined),
      cloudflareApiToken: null,
      gitopsGitToken: null,
      reconcile: {
        enabled: false, version: "unpinned", repoUrl: "", branch: "main",
        intervalSeconds: 60, checks: [], apply: "",
      },
      ...partial,
    };
  }

  test("agents + real repo + no token fails at preview naming the key", () => {
    const c = cfg({
      gitopsRepoUrl: "https://github.com/org/gitops.git",
      agents: [{ runtime: "hermes", source: "github.com/org/agent", ref: "", subdir: "", name: null, overrides: null }],
    });
    expect(() => validatePrerequisites(c)).toThrow(/gitopsGitToken is required/);
  });

  test("placeholder repo skips the token requirement", () => {
    const c = cfg({
      agents: [{ runtime: "hermes", source: "github.com/org/agent", ref: "", subdir: "", name: null, overrides: null }],
    });
    validatePrerequisites(c); // no throw
  });

  test("no agents skips the token requirement", () => {
    validatePrerequisites(cfg({ gitopsRepoUrl: "https://github.com/org/gitops.git" }));
  });

  test("stages.hermes without source fails naming the key", () => {
    const c = cfg({ stages: { hermes: true, agents: false, cluster: false } });
    expect(() => validatePrerequisites(c)).toThrow(/hermes\.source is required/);
  });

  test("a provisioned slack app with config-sourced SLACK_* secrets is refused (ADR 0175)", () => {
    const c = cfg({
      agents: [
        { runtime: "eve", source: "github.com/org/agents", ref: "main", subdir: "a", name: "manager-eve", overrides: null },
      ],
      slack: parseSlack({
        enabled: true,
        teamId: "T0123456789",
        apps: { "manager-eve": { displayName: "M", botScopes: ["chat:write"] } },
      }),
      agentSecrets: { "manager-eve": { SLACK_BOT_TOKEN: "xoxb-x", OTHER: "ok" } },
    });
    expect(() => validatePrerequisites(c)).toThrow(/provision outputs \(ADR 0175\)/);
  });

  test("an ADOPTED slack app keeps config-sourced SLACK_* secrets", () => {
    const c = cfg({
      agents: [
        { runtime: "eve", source: "github.com/org/agents", ref: "main", subdir: "a", name: "manager-eve", overrides: null },
      ],
      slack: parseSlack({
        enabled: true,
        teamId: "T0123456789",
        apps: { "manager-eve": { displayName: "M", botScopes: ["chat:write"], appId: "A0HANDMADE1" } },
      }),
      agentSecrets: { "manager-eve": { SLACK_BOT_TOKEN: "xoxb-x", SLACK_SIGNING_SECRET: "s" } },
    });
    validatePrerequisites(c); // no throw
  });

  function baseConfig(): BootstrapConfig {
    return cfg({});
  }

  // Minimal valid cloudflare CPI block reused by both cases below.
  const cpi = {
    provider: "cloudflare",
    accountId: "acc",
    zoneId: "z",
    zoneName: "example.com",
    teamName: "team",
    access: { emailDomain: "example.com" },
  };

});

describe("parsePluginConfig / parseFleetDefaults", () => {
  test("plugin config fields default to null (unset = plugin fallbacks)", () => {
    const parsed = parsePluginConfig({});
    expect(Object.values(parsed).every((v) => v === null)).toBe(true);
  });

  test("set fields pass through", () => {
    expect(parsePluginConfig({ imageTag: "v1", profilesPath: "p" })).toMatchObject({
      imageTag: "v1",
      profilesPath: "p",
    });
  });

  test("fleetDefaults accepts a mapping, rejects non-mappings", () => {
    expect(parseFleetDefaults(undefined)).toBeNull();
    expect(parseFleetDefaults({ deployment: { diskSizeGb: 100 } })).toEqual({
      deployment: { diskSizeGb: 100 },
    });
    expect(() => parseFleetDefaults(["x"])).toThrow(/must be a mapping/);
  });
});

describe("validateAgentOverrides (K3: typed IaC override model)", () => {
  test("valid override document passes", () => {
    validateAgentOverrides(
      {
        deployment: { diskSizeGb: 250, baseImageTag: "hermes-base-2026-07" },
        expose: { services: [{ name: "tools", port: 8080 }] },
        apps: [{ name: "vector-db", values: { auth: { apiKeySecretRef: "x" } } }],
        gitAuthSecretRef: "my-deploy-key",
      },
      "agents[0].overrides",
    );
  });

  test("removed override keys fail with a migration hint", () => {
    expect(() =>
      validateAgentOverrides({ workload_selection: ["memory-store"] }, "agents[0].overrides"),
    ).toThrow(/workload_selection was removed.*apps/s);
    expect(() =>
      validateAgentOverrides({ reach: { regions: ["us-west"] } }, "agents[0].overrides"),
    ).toThrow(/reach was removed.*single-cluster/s);
    expect(() =>
      validateAgentOverrides({ targetCluster: "workload-eu-1" }, "agents[0].overrides"),
    ).toThrow(/targetCluster was removed.*single-cluster/s);
  });

  test("a typo'd top-level key fails at preview naming the allowed set", () => {
    expect(() =>
      validateAgentOverrides({ deplyoment: { diskSizeGb: 1 } }, "agents[0].overrides"),
    ).toThrow(/deplyoment is not a recognized override key.*apps, appValues, backup, deployment, expose/);
  });

  test("a typo'd deployment field fails", () => {
    expect(() =>
      validateAgentOverrides({ deployment: { diskSizeGB: 1 } }, "agents[0].overrides"),
    ).toThrow(/deployment\.diskSizeGB is not a recognized/);
  });

  test("removed VM-era deployment keys fail with a migration hint", () => {
    expect(() =>
      validateAgentOverrides({ deployment: { machineType: "e2-standard-4" } }, "agents[0].overrides"),
    ).toThrow(/deployment\.machineType was removed.*pod compute only/s);
  });

  test("apps overrides are by-name partial patches (name required, rest optional)", () => {
    validateAgentOverrides(
      { apps: [{ name: "vector-db", values: { replicas: 2 } }] },
      "agents[0].overrides",
    );
    expect(() =>
      validateAgentOverrides({ apps: [{ values: { replicas: 2 } }] }, "agents[0].overrides"),
    ).toThrow(/apps\[0\]\.name must be a DNS-1123 label/);
    expect(() =>
      validateAgentOverrides({ apps: [{ name: "a", repo: "ftp://nope" }] }, "agents[0].overrides"),
    ).toThrow(/repo must be "local" or a https:\/\/ \/ oci:\/\//);
  });

  test("parseAgents wires the validation in", () => {
    expect(() =>
      parseAgents([{ source: "x", overrides: { bogus: 1 } }]),
    ).toThrow(/bogus is not a recognized override key/);
  });
});

describe("isGithubRepoUrl + mode posture (F3)", () => {
  test("github URLs detected in the operator-plausible forms", () => {
    for (const u of [
      "https://github.com/org/repo.git",
      "github.com/org/repo",
      "git@github.com:org/repo.git",
    ]) {
      expect(isGithubRepoUrl(u)).toBe(true);
    }
    expect(isGithubRepoUrl("file:///tmp/gitops.git")).toBe(false);
    expect(isGithubRepoUrl("https://gitlab.com/org/repo.git")).toBe(false);
  });

  test("invalid pluginConfig.mode rejected at preview", () => {
    expect(() => parsePluginConfig({ mode: "yolo" })).toThrow(/"direct" or "pr"/);
    expect(parsePluginConfig({ mode: "pr", prAutoMerge: false })).toMatchObject({
      mode: "pr",
      prAutoMerge: false,
    });
  });
});

describe("validateHermesExtensionFile (K7: developer packaging fail-fast)", () => {
  function repoWith(content: string | null, subdir = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "k7-ext-"));
    if (content !== null) {
      const root = subdir ? join(dir, subdir) : dir;
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "hermes-gitops.yaml"), content);
    }
    return dir;
  }

  test("no extension file is fine (repo simply isn't K7-packaged)", () => {
    validateHermesExtensionFile(repoWith(null), "agents[0]");
  });

  test("subdir-layout extension is found beside the manifest", () => {
    const dir = repoWith("deplyoment:\n  x: 1\n", ".hermes-dist/agent");
    expect(() =>
      validateHermesExtensionFile(dir, "agents[0]", ".hermes-dist/agent"),
    ).toThrow(/deplyoment.*allowed:/);
    // Without the subdir arg the (root-layout) lookup finds nothing.
    validateHermesExtensionFile(dir, "agents[0]");
  });

  const VALID_APPS =
    "apps:\n" +
    "  - name: vector-db\n" +
    "    chart: qdrant\n" +
    "    repo: https://qdrant.github.io/qdrant-helm\n" +
    "    version: 1.9.1\n" +
    "    values:\n" +
    "      replicas: 1\n" +
    "    valuesRequired:\n" +
    "      - auth.apiKeySecretRef\n" +
    "  - name: docs-site\n" +
    "    chart: charts/test-page\n" +
    "    repo: local\n";

  test("a valid extension passes", () => {
    validateHermesExtensionFile(
      repoWith(VALID_APPS + "deployment:\n  diskSizeGb: 20\n  baseImageTag: \"1.2.3\"\n"),
      "agents[0]",
    );
  });

  test("an empty extension is valid", () => {
    validateHermesExtensionFile(repoWith(""), "agents[0]");
  });

  test("unknown top-level key fails at preview naming it", () => {
    expect(() =>
      validateHermesExtensionFile(repoWith("deplyoment:\n  diskSizeGb: 20\n"), "agents[0]"),
    ).toThrow(/deplyoment.*allowed:/);
  });

  test("removed top-level keys fail with migration hints", () => {
    expect(() =>
      validateHermesExtensionFile(
        repoWith("workloads:\n  - name: test-page\n    default: true\n"),
        "agents[0]",
      ),
    ).toThrow(/`workloads` was removed.*apps/s);
    expect(() =>
      validateHermesExtensionFile(repoWith("reach:\n  regions: [us-west]\n"), "agents[0]"),
    ).toThrow(/`reach` was removed.*single-cluster/s);
    expect(() =>
      validateHermesExtensionFile(repoWith("targetCluster: workload-eu-1\n"), "agents[0]"),
    ).toThrow(/`targetCluster` was removed.*single-cluster/s);
  });

  test("typo'd deployment field fails", () => {
    expect(() =>
      validateHermesExtensionFile(repoWith("deployment:\n  diskSizeGB: 20\n"), "agents[0]"),
    ).toThrow(/deployment\.diskSizeGB is not a recognized/);
  });

  test("removed VM-era deployment fields fail with a hint", () => {
    expect(() =>
      validateHermesExtensionFile(repoWith("deployment:\n  machineType: e2-standard-4\n"), "agents[0]"),
    ).toThrow(/deployment\.machineType was removed.*pod compute only/s);
  });

  test("apps entries enforce the contract rules (name/chart/repo/version)", () => {
    expect(() =>
      validateHermesExtensionFile(repoWith("apps:\n  - chart: qdrant\n    repo: local\n"), "agents[0]"),
    ).toThrow(/apps\[0\]\.name must be a DNS-1123 label/);
    expect(() =>
      validateHermesExtensionFile(
        repoWith("apps:\n  - name: a\n    chart: qdrant\n    repo: https://x.example\n"),
        "agents[0]",
      ),
    ).toThrow(/version is required for remote helm repos/);
    expect(() =>
      validateHermesExtensionFile(
        repoWith("apps:\n  - name: a\n    chart: charts/x\n    repo: local\n    version: 1.0.0\n"),
        "agents[0]",
      ),
    ).toThrow(/version is forbidden for repo: local/);
    expect(() =>
      validateHermesExtensionFile(
        repoWith("apps:\n  - name: a\n    chart: x\n    repo: git@github.com:x/y\n"),
        "agents[0]",
      ),
    ).toThrow(/repo must be "local" or a https:\/\/ \/ oci:\/\//);
    expect(() =>
      validateHermesExtensionFile(
        repoWith(
          "apps:\n  - name: a\n    chart: charts/x\n    repo: local\n  - name: a\n    chart: charts/y\n    repo: local\n",
        ),
        "agents[0]",
      ),
    ).toThrow(/"a" is declared twice/);
    expect(() =>
      validateHermesExtensionFile(
        repoWith("apps:\n  - name: a\n    chart: charts/x\n    repo: local\n    bogus: 1\n"),
        "agents[0]",
      ),
    ).toThrow(/apps\[0\]\.bogus is not a recognized app key/);
  });

  test("invalid YAML fails with the parse error", () => {
    expect(() =>
      validateHermesExtensionFile(repoWith("deployment: [unclosed\n"), "agents[0]"),
    ).toThrow(/not valid YAML/);
  });
});

describe("parseControlPlaneIngress (spec §25)", () => {
  const VALID = {
    provider: "cloudflare",
    accountId: "acc",
    zoneId: "zone",
    zoneName: "example.com",
    teamName: "myteam",
    access: { emailDomain: "example.com" },
  };

  test("absent config defaults to provider none (feature off)", () => {
    const c = parseControlPlaneIngress(undefined);
    expect(c.provider).toBe("none");
    expect(c.hostnames.grafana).toBe("grafana");
    expect(c.hostnames.hermes).toBe("");
    expect(c.agentSubdomains).toBe(true);
  });

  test("valid cloudflare config parses with defaults filled", () => {
    const c = parseControlPlaneIngress(VALID);
    expect(c.provider).toBe("cloudflare");
    expect(c.sessionDuration).toBe("24h");
    // http, not https: argocd-server runs --insecure and an https origin
    // gets its handshake reset - found live as a tunnel 502 (e24f1438).
    expect(c.services.argocd).toBe("http://argocd-server.argocd.svc");
    expect(c.services.traefik).toBe("http://traefik.kube-system.svc:80");
    expect(c.agentHostHeaderDomain).toBe("hermes.local");
  });

  test("unknown keys fail loudly", () => {
    expect(() => parseControlPlaneIngress({ ...VALID, tunelName: "x" })).toThrow(
      /not a recognized key/,
    );
    expect(() =>
      parseControlPlaneIngress({ ...VALID, access: { emailDomian: "x" } }),
    ).toThrow(/access\.emailDomian/);
  });

  test("cloudflare requires the account/zone/team identifiers", () => {
    for (const key of ["accountId", "zoneId", "zoneName", "teamName"] as const) {
      const { [key]: _drop, ...rest } = VALID;
      expect(() => parseControlPlaneIngress(rest)).toThrow(new RegExp(`${key} is required`));
    }
  });

  test("cloudflare requires at least one access include", () => {
    expect(() => parseControlPlaneIngress({ ...VALID, access: {} })).toThrow(
      /emailDomain, serviceTokenIds and\/or groups/,
    );
    const c = parseControlPlaneIngress({
      ...VALID,
      access: { serviceTokenIds: ["tok-1"] },
    });
    expect(c.access.serviceTokenIds).toEqual(["tok-1"]);
  });

  test("hermes hostname without a hermes service fails (no in-cluster default)", () => {
    expect(() =>
      parseControlPlaneIngress({ ...VALID, hostnames: { hermes: "hermes" } }),
    ).toThrow(/services\.hermes is required/);
  });

  test("provider none skips the requireds entirely", () => {
    expect(parseControlPlaneIngress({ provider: "none" }).provider).toBe("none");
  });

  test("google IdP client parses only as a pair (#332)", () => {
    const both = parseControlPlaneIngress({
      ...VALID,
      access: { ...VALID.access, googleClientId: "id.apps.googleusercontent.com", googleClientSecret: "s3cret" },
    });
    expect(both.access.googleClientId).toBe("id.apps.googleusercontent.com");
    expect(both.access.googleClientSecret).toBe("s3cret");
    // Absent = feature off, empty strings.
    expect(parseControlPlaneIngress(VALID).access.googleClientId).toBe("");
    // Half-configured fails at preview, not at login time.
    for (const half of [{ googleClientId: "id" }, { googleClientSecret: "s" }]) {
      expect(() =>
        parseControlPlaneIngress({ ...VALID, access: { ...VALID.access, ...half } }),
      ).toThrow(/must be set together/);
    }
  });

  test("nexus hostname/service keys parse (the #332 allowlist gap)", () => {
    // hostnames.nexus was implemented end to end but missing from
    // CPI_HOSTNAME_KEYS/CPI_SERVICE_KEYS, so the documented config threw
    // at preview. This routes it through the REAL parser - the resolver
    // tests below all hand-build the object and never caught it.
    const c = parseControlPlaneIngress({
      ...VALID,
      accessGroups: { operators: { emails: ["op@example.com"] } },
      hostnames: { nexus: "nexus" },
      services: { nexus: "http://nexus.hermes-nexus.svc" },
      access: {
        emailDomain: "",
        groups: { grafana: ["operators"], argocd: ["operators"], nexus: ["operators"] },
      },
    });
    expect(c.hostnames.nexus).toBe("nexus");
    expect(controlPlaneHostnames(c, []).find((h) => h.key === "nexus")?.host).toBe(
      "nexus.example.com",
    );
  });
});

describe("controlPlaneHostnames (spec §25 + subdomain per agent)", () => {
  const CPI = parseControlPlaneIngress({
    provider: "cloudflare",
    accountId: "acc",
    zoneId: "zone",
    zoneName: "example.com",
    teamName: "myteam",
    access: { emailDomain: "example.com" },
  });
  const agent = (name: string | null) => ({
    runtime: "hermes" as const,
    source: "github.com/org/agent",
    ref: "",
    subdir: "",
    name,
    overrides: null,
  });

  test("control-plane services resolve; only https origins skip TLS verify", () => {
    const hosts = controlPlaneHostnames(CPI, []);
    expect(hosts.map((h) => h.host)).toEqual(["grafana.example.com", "argocd.example.com"]);
    // argocd's default origin is http since e24f1438 (server runs --insecure).
    expect(hosts.find((h) => h.key === "argocd")?.noTlsVerify).toBe(false);
    expect(hosts.find((h) => h.key === "grafana")?.noTlsVerify).toBe(false);
    // The derive rule itself: an https origin still flips noTlsVerify on.
    const httpsCpi = {
      ...CPI,
      services: { ...CPI.services, argocd: "https://argocd-server.argocd.svc" },
    };
    expect(controlPlaneHostnames(httpsCpi, []).find((h) => h.key === "argocd")?.noTlsVerify).toBe(
      true,
    );
  });

  test("prometheus is NOT published by default - Access would be its only gate", () => {
    // Grafana and Argo CD have logins, so Access is a second gate in front
    // of them. Prometheus has none: publishing it makes Access the only
    // thing between the internet and every metric. Opt-in, never default.
    expect(controlPlaneHostnames(CPI, []).map((h) => h.key)).not.toContain("prometheus");
  });

  test("prometheus publishes when given a label, dialing the in-cluster server", () => {
    const cpi = { ...CPI, hostnames: { ...CPI.hostnames, prometheus: "prometheus" } };
    const p = controlPlaneHostnames(cpi, []).find((h) => h.key === "prometheus");
    expect(p?.host).toBe("prometheus.example.com");
    expect(p?.service).toBe("http://monitoring-prometheus.hermes-monitoring.svc:9090");
    expect(p?.noTlsVerify).toBe(false);
  });

  test("nexus is NOT published by default - exposure is a deliberate choice", () => {
    // Unlike hermes (which has no in-cluster Service at all), Nexus HAS a
    // real origin since ADR-48. Off by default is therefore an exposure
    // decision, not a missing target.
    expect(controlPlaneHostnames(CPI, []).map((h) => h.key)).not.toContain("nexus");
  });

  test("nexus publishes when given a label, dialing its in-cluster Service", () => {
    const cpi = { ...CPI, hostnames: { ...CPI.hostnames, nexus: "nexus" } };
    const n = controlPlaneHostnames(cpi, []).find((h) => h.key === "nexus");
    expect(n?.host).toBe("nexus.example.com");
    expect(n?.service).toBe("http://nexus.hermes-nexus.svc");
    expect(n?.noTlsVerify).toBe(false);
  });

  test("nexus takes its own Access group assignment", () => {
    // ADR-53: publishing Nexus is what gives it an Access application, so
    // the group assignment has to reach it like any other target.
    const cpi = {
      ...CPI,
      hostnames: { ...CPI.hostnames, nexus: "nexus" },
      access: { ...CPI.access, emailDomain: "", groups: { grafana: ["sre"], argocd: ["sre"], nexus: ["operators"] } },
    };
    const n = controlPlaneHostnames(cpi, []).find((h) => h.key === "nexus");
    expect(n?.groups).toEqual(["operators"]);
  });

  test("a published nexus with no group and no fallback fails at preview", () => {
    // The lockout guard must cover the new target too - an Access policy
    // with zero includes locks everyone out of the dashboard.
    const cpi = {
      ...CPI,
      hostnames: { ...CPI.hostnames, nexus: "nexus" },
      access: { ...CPI.access, emailDomain: "", groups: { grafana: ["sre"], argocd: ["sre"] } },
    };
    expect(() => controlPlaneHostnames(cpi, [])).toThrow(/"nexus"[\s\S]*no access\.groups assignment/);
  });

  test("all three control-plane UIs can sit behind ONE Access group", () => {
    const cpi = {
      ...CPI,
      hostnames: { ...CPI.hostnames, prometheus: "prometheus" },
      access: { ...CPI.access, emailDomain: "", groups: { grafana: ["sre"], argocd: ["sre"], prometheus: ["sre"] } },
    };
    const hosts = controlPlaneHostnames(cpi, []);
    expect(hosts.map((h) => h.key)).toEqual(["grafana", "argocd", "prometheus"]);
    expect(hosts.every((h) => h.groups.length === 1 && h.groups[0] === "sre")).toBe(true);
  });

  test("an agent named after a reserved control-plane label is refused", () => {
    // The zone's labels are one namespace shared by control-plane targets,
    // agent subdomains and workload endpoints. Without this, an agent named
    // "grafana" would silently mint a second grafana.example.com and the
    // last DNS record would win.
    expect(() => controlPlaneHostnames(CPI, [agent("grafana")])).toThrow(
      /is published by more than one target/,
    );
  });

  test("one subdomain per agent, routed via traefik with the profile host header", () => {
    const hosts = controlPlaneHostnames(CPI, [agent("support-agent")]);
    const sub = hosts.find((h) => h.key === "agent-support-agent");
    expect(sub?.host).toBe("support-agent.example.com");
    expect(sub?.service).toBe("http://traefik.kube-system.svc:80");
    expect(sub?.hostHeader).toBe("support-agent.hermes.local");
  });

  test("a null agent name fails loudly instead of silently missing a subdomain", () => {
    expect(() => controlPlaneHostnames(CPI, [agent(null)])).toThrow(
      /agents\[0\]\.name is required/,
    );
  });

  test("agentSubdomains off ignores agents entirely", () => {
    const cpi = { ...CPI, agentSubdomains: false };
    expect(controlPlaneHostnames(cpi, [agent(null)]).map((h) => h.key)).toEqual([
      "grafana",
      "argocd",
    ]);
  });
});

describe("Zero Trust access groups (accessGroups + access.groups)", () => {
  const BASE = {
    provider: "cloudflare",
    accountId: "acc",
    zoneId: "zone",
    zoneName: "example.com",
    teamName: "myteam",
  };
  const GROUPS = {
    "platform-admins": { emails: ["alice@example.com"] },
    viewers: { emailDomains: ["example.com"] },
    ci: { serviceTokenIds: ["tok-1"] },
  };
  const agent = (name: string) => ({
    runtime: "hermes" as const,
    source: "github.com/org/agent",
    ref: "",
    subdir: "",
    name,
    overrides: null,
  });

  test("groups parse and are assigned per target", () => {
    const c = parseControlPlaneIngress({
      ...BASE,
      accessGroups: GROUPS,
      access: {
        groups: {
          grafana: ["viewers", "platform-admins"],
          argocd: ["platform-admins"],
          agents: ["viewers"],
        },
      },
    });
    expect(Object.keys(c.accessGroups).sort()).toEqual(["ci", "platform-admins", "viewers"]);
    const hosts = controlPlaneHostnames(c, [agent("support-agent")]);
    expect(hosts.find((h) => h.key === "grafana")?.groups).toEqual([
      "viewers",
      "platform-admins",
    ]);
    expect(hosts.find((h) => h.key === "argocd")?.groups).toEqual(["platform-admins"]);
    expect(hosts.find((h) => h.key === "agent-support-agent")?.groups).toEqual(["viewers"]);
  });

  test("agent:<name> assignment overrides the all-agents default", () => {
    const c = parseControlPlaneIngress({
      ...BASE,
      accessGroups: GROUPS,
      access: {
        emailDomain: "example.com",
        groups: { agents: ["viewers"], "agent:support-agent": ["platform-admins"] },
      },
    });
    const hosts = controlPlaneHostnames(c, [agent("support-agent"), agent("docs-bot")]);
    expect(hosts.find((h) => h.key === "agent-support-agent")?.groups).toEqual([
      "platform-admins",
    ]);
    expect(hosts.find((h) => h.key === "agent-docs-bot")?.groups).toEqual(["viewers"]);
  });

  test("an undeclared group name fails naming the declared ones", () => {
    expect(() =>
      parseControlPlaneIngress({
        ...BASE,
        accessGroups: GROUPS,
        access: { groups: { argocd: ["platform-admin"] } },
      }),
    ).toThrow(/references group "platform-admin".*declared: ci, platform-admins, viewers/s);
  });

  test("a group with no member rule fails (lockout guard)", () => {
    expect(() =>
      parseControlPlaneIngress({ ...BASE, accessGroups: { empty: {} }, access: { groups: { grafana: ["empty"] } } }),
    ).toThrow(/has no member rule/);
  });

  test("an unknown target key fails", () => {
    expect(() =>
      parseControlPlaneIngress({
        ...BASE,
        accessGroups: GROUPS,
        access: { groups: { prometheus: ["viewers"] } },
      }),
    ).toThrow(/not a recognized target/);
  });

  test("a hostname with neither groups nor fallback fails at resolution", () => {
    const c = parseControlPlaneIngress({
      ...BASE,
      accessGroups: GROUPS,
      access: { groups: { grafana: ["viewers"] } }, // argocd left uncovered, no fallback
    });
    expect(() => controlPlaneHostnames(c, [])).toThrow(/"argocd" has no access.groups/);
  });

  test("agent:<name> naming a non-existent agent fails (typo guard)", () => {
    const c = parseControlPlaneIngress({
      ...BASE,
      accessGroups: GROUPS,
      access: { emailDomain: "example.com", groups: { "agent:supprt-agent": ["viewers"] } },
    });
    expect(() => controlPlaneHostnames(c, [agent("support-agent")])).toThrow(
      /agent:supprt-agent.*no published subdomain/s,
    );
  });

  test("groups alone satisfy the who-may-enter requirement", () => {
    const c = parseControlPlaneIngress({
      ...BASE,
      accessGroups: GROUPS,
      access: {
        groups: { grafana: ["viewers"], argocd: ["platform-admins"], agents: ["viewers"] },
      },
    });
    expect(c.access.emailDomain).toBe("");
    expect(controlPlaneHostnames(c, []).length).toBe(2);
  });
});

describe("workload endpoints (workload:<agent>/<app>, ADR-40)", () => {
  const BASE = {
    provider: "cloudflare",
    accountId: "acc",
    zoneId: "zone",
    zoneName: "example.com",
    teamName: "myteam",
    accessGroups: {
      "platform-admins": { emails: ["alice@example.com"] },
      marketing: { emailDomains: ["example.com"] },
    },
  };
  const agent = (name: string) => ({
    runtime: "hermes" as const,
    source: "github.com/org/agent",
    ref: "",
    subdir: "",
    name,
    overrides: null,
  });
  const valid = (over: Record<string, unknown> = {}) => ({
    ...BASE,
    access: {
      groups: {
        grafana: ["platform-admins"],
        argocd: ["platform-admins"],
        agents: ["platform-admins"],
        "workload:smm/postiz": ["marketing"],
      },
    },
    workloadEndpoints: {
      "smm/postiz": {
        hostname: "postiz.example.com",
        origin: "http://postiz.hermes-smm.svc:5000",
      },
    },
    ...over,
  });

  test("a declared endpoint with a workload: assignment resolves, after agents", () => {
    const c = parseControlPlaneIngress(valid());
    const hosts = controlPlaneHostnames(c, [agent("smm")]);
    expect(hosts.map((h) => h.key)).toEqual([
      "grafana",
      "argocd",
      "agent-smm",
      "workload-smm-postiz",
    ]);
    const w = hosts.find((h) => h.key === "workload-smm-postiz");
    expect(w?.host).toBe("postiz.example.com");
    expect(w?.service).toBe("http://postiz.hermes-smm.svc:5000");
    expect(w?.hostHeader).toBeNull();
    expect(w?.groups).toEqual(["marketing"]);
  });

  test("origin TLS verification stays ON unless explicitly opted out", () => {
    // Unlike the built-in argocd target, an https workload origin is
    // NOT auto-noTlsVerify - that would defeat origin authentication.
    const https = parseControlPlaneIngress(
      valid({
        workloadEndpoints: {
          "smm/postiz": { hostname: "postiz.example.com", origin: "https://postiz.hermes-smm.svc" },
        },
      }),
    );
    expect(
      controlPlaneHostnames(https, [agent("smm")]).find((h) => h.key === "workload-smm-postiz")
        ?.noTlsVerify,
    ).toBe(false);
    const optedOut = parseControlPlaneIngress(
      valid({
        workloadEndpoints: {
          "smm/postiz": {
            hostname: "postiz.example.com",
            origin: "https://postiz.hermes-smm.svc",
            noTlsVerify: true,
          },
        },
      }),
    );
    expect(
      controlPlaneHostnames(optedOut, [agent("smm")]).find((h) => h.key === "workload-smm-postiz")
        ?.noTlsVerify,
    ).toBe(true);
  });

  test("a malformed endpoint key fails", () => {
    for (const key of ["noslash", "Bad_/x", "a/b/c", "a/"]) {
      expect(() =>
        parseControlPlaneIngress(
          valid({
            workloadEndpoints: {
              [key]: { hostname: "postiz.example.com", origin: "http://x.svc" },
            },
          }),
        ),
      ).toThrow(/must be "<agent>\/<app>"/);
    }
  });

  test("an unknown endpoint value key fails", () => {
    expect(() =>
      parseControlPlaneIngress(
        valid({
          workloadEndpoints: {
            "smm/postiz": { hostname: "postiz.example.com", origin: "http://x.svc", port: 5000 },
          },
        }),
      ),
    ).toThrow(/port is not a recognized key/);
  });

  test("a non-http(s), host-less, or unparsable origin fails", () => {
    for (const origin of ["tcp://x.svc:5432", "http://", "postiz.svc:5000", "http://x .svc"]) {
      expect(() =>
        parseControlPlaneIngress(
          valid({
            workloadEndpoints: {
              "smm/postiz": { hostname: "postiz.example.com", origin },
            },
          }),
        ),
      ).toThrow(/must be an http:\/\/ or https:\/\/ URL with a host/);
    }
  });

  test("a hostname with uppercase or malformed labels fails (DNS is case-insensitive)", () => {
    for (const hostname of ["Postiz.example.com", "po_stiz.example.com", "postiz..example.com"]) {
      expect(() =>
        parseControlPlaneIngress(
          valid({
            workloadEndpoints: {
              "smm/postiz": { hostname, origin: "http://x.svc" },
            },
          }),
        ),
      ).toThrow(/lowercase labels/);
    }
  });

  test("a hostname outside the zone fails", () => {
    expect(() =>
      parseControlPlaneIngress(
        valid({
          workloadEndpoints: {
            "smm/postiz": { hostname: "postiz.other.io", origin: "http://x.svc" },
          },
        }),
      ),
    ).toThrow(/outside the configured zone/);
  });

  test("a workload: assignment without a declared endpoint fails", () => {
    expect(() =>
      parseControlPlaneIngress(valid({ workloadEndpoints: {} })),
    ).toThrow(/names an undeclared workload endpoint/);
  });

  test("a declared endpoint without a workload: assignment fails even with the flat fallback", () => {
    expect(() =>
      parseControlPlaneIngress(
        valid({
          access: {
            emailDomain: "example.com",
            groups: { grafana: ["platform-admins"] },
          },
        }),
      ),
    ).toThrow(/workload targets have no fallback/);
  });

  test("an endpoint naming an agent not in agents[] fails at resolution", () => {
    const c = parseControlPlaneIngress(valid());
    expect(() => controlPlaneHostnames(c, [agent("other-agent")])).toThrow(
      /workloadEndpoints\.smm\/postiz names an agent that is not in agents\[\]/,
    );
  });

  test("a workload hostname colliding with an agent subdomain fails", () => {
    const c = parseControlPlaneIngress(
      valid({
        workloadEndpoints: {
          "smm/postiz": { hostname: "smm.example.com", origin: "http://x.svc" },
        },
      }),
    );
    expect(() => controlPlaneHostnames(c, [agent("smm")])).toThrow(
      /published by more than one target/,
    );
  });

  test("two endpoint keys colliding on the resource key fail", () => {
    const c = parseControlPlaneIngress(
      valid({
        access: {
          groups: {
            grafana: ["platform-admins"],
            argocd: ["platform-admins"],
            agents: ["platform-admins"],
            "workload:smm-a/b": ["marketing"],
            "workload:smm/a-b": ["marketing"],
          },
        },
        workloadEndpoints: {
          "smm-a/b": { hostname: "a.example.com", origin: "http://a.svc" },
          "smm/a-b": { hostname: "b.example.com", origin: "http://b.svc" },
        },
      }),
    );
    expect(() => controlPlaneHostnames(c, [agent("smm"), agent("smm-a")])).toThrow(
      /same resource key/,
    );
  });
});

describe("contract v2 (ADR-33): extension-file dispatch + override rejection", () => {
  function repoWith(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "v2-ext-"));
    writeFileSync(join(dir, "hermes-gitops.yaml"), content);
    return dir;
  }

  const V2_FULL =
    "contractVersion: 2\n" +
    "topology:\n" +
    "  supportedLayouts: [single, hub-spoke]\n" +
    "  agent:\n" +
    "    multiplicity: per-region\n" +
    "    dataBoundary: region\n" +
    "endpoints:\n" +
    "  - name: dashboard\n" +
    "    port: 9119\n" +
    "    type: authenticated\n" +
    "requires:\n" +
    "  - capability: content-board\n" +
    "    inject:\n" +
    "      env: HERMES_CAP_CONTENT_BOARD_URL\n" +
    "apps:\n" +
    "  - name: content-kanban\n" +
    "    chart: content-kanban\n" +
    "    repo: oci://ghcr.io/factory-level/charts\n" +
    "    version: 0.3.0\n" +
    "    topology:\n" +
    "      multiplicity: singleton\n" +
    "      dataBoundary: global\n" +
    "    endpoints:\n" +
    "      - name: api\n" +
    "        service: content-kanban\n" +
    "        port: 80\n" +
    "        type: private\n" +
    "        provides: content-board\n";

  test("a v2 file with topology/endpoints/requires passes the shallow key check", () => {
    validateHermesExtensionFile(repoWith(V2_FULL), "agents[0]");
  });

  test("v2 keys WITHOUT the contractVersion marker fail as unknown (v1 path)", () => {
    expect(() =>
      validateHermesExtensionFile(
        repoWith("topology:\n  supportedLayouts: [single]\n"),
        "agents[0]",
      ),
    ).toThrow(/topology.*allowed:/s);
  });

  test("contractVersion must be exactly 2", () => {
    expect(() =>
      validateHermesExtensionFile(repoWith("contractVersion: 1\n"), "agents[0]"),
    ).toThrow(/contractVersion must be exactly 2/);
  });

  test("unknown keys still fail in a v2 file", () => {
    expect(() =>
      validateHermesExtensionFile(
        repoWith("contractVersion: 2\nplacement:\n  target: eu\n"),
        "agents[0]",
      ),
    ).toThrow(/placement.*allowed:/s);
  });

  test("per-instance overrides reject v2 profile-owned keys with a pointed message", () => {
    expect(() =>
      validateAgentOverrides(
        { topology: { supportedLayouts: ["replicated"] } },
        "agents[0].overrides",
      ),
    ).toThrow(/topology is profile-owned \(ADR-33\)/);
    expect(() =>
      validateAgentOverrides({ endpoints: [] }, "agents[0].overrides"),
    ).toThrow(/endpoints are profile-owned/);
    expect(() =>
      validateAgentOverrides({ requires: [] }, "agents[0].overrides"),
    ).toThrow(/requirements are profile-owned/);
    expect(() =>
      validateAgentOverrides({ contractVersion: 2 }, "agents[0].overrides"),
    ).toThrow(/never in an override/);
  });

  test("mirror guard: the hand lists equal the vendored schemas' property keys", () => {
    const schemaV1 = JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "agent-bundle-contracts", "hermes-gitops-extension", "v1alpha1", "hermes-gitops.schema.json"),
        "utf8",
      ),
    );
    const schemaV2 = JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "agent-bundle-contracts", "hermes-gitops-extension", "v1alpha2", "hermes-gitops.schema.json"),
        "utf8",
      ),
    );
    expect([...EXTENSION_KEYS].sort()).toEqual(Object.keys(schemaV1.properties).sort());
    expect([...EXTENSION_KEYS_V2].sort()).toEqual(Object.keys(schemaV2.properties).sort());
    const appPropsV2 = schemaV2.properties.apps.items.properties;
    expect([...APP_ENTRY_KEYS_V2].sort()).toEqual(Object.keys(appPropsV2).sort());
  });
});

describe("parseReconcile", () => {
  test("defaults: disabled, unpinned, empty commands", () => {
    const r = parseReconcile(undefined);
    expect(r.enabled).toBe(false);
    expect(r.version).toBe("unpinned");
    expect(r.intervalSeconds).toBe(60);
    expect(r.checks).toEqual([]);
  });

  test("enabled without a repoUrl refuses loudly - a timer needs a repository", () => {
    expect(() => parseReconcile({ enabled: true })).toThrow(/repoUrl is required/);
  });

  test("unknown keys refuse - a typo'd knob must not silently no-op", () => {
    expect(() => parseReconcile({ enabeld: true })).toThrow(/not a recognized key/);
  });

  test("a full block round-trips", () => {
    const r = parseReconcile({
      enabled: true,
      version: "v1.2.3",
      repoUrl: "https://git.test/deploy.git",
      branch: "prod",
      intervalSeconds: 120,
      checks: ["hg topology doctor --dir ."],
      apply: "pulumi up --yes --cwd infra",
    });
    expect(r.version).toBe("v1.2.3");
    expect(r.branch).toBe("prod");
    expect(r.intervalSeconds).toBe(120);
    expect(r.checks).toEqual(["hg topology doctor --dir ."]);
  });

  test("a sub-10s interval falls back to the default - no hot loops", () => {
    expect(parseReconcile({ enabled: true, repoUrl: "x", intervalSeconds: 1 }).intervalSeconds).toBe(60);
  });
});

describe("parseNexusCapabilities (ADR-84)", () => {
  test("an unset key is the production posture, not an empty object", () => {
    // The safe answer has to be what an operator who sets nothing gets:
    // reset off, every launch view served.
    for (const raw of [undefined, null]) {
      const c = parseNexusCapabilities(raw);
      expect(c.workspaceReset).toBe(false);
      expect(c.views).toEqual({ system: true, communication: true, agents: true, backups: true });
    }
  });

  test("a string boolean is REFUSED, not silently ignored", () => {
    // `workspaceReset: "true"` in stack config would reach the backend as
    // a string, which demands a real boolean and resolves it to false -
    // an operator would enable reset, see it not work, and have nothing
    // to read. Refuse at the edge instead.
    expect(() => parseNexusCapabilities({ workspaceReset: "true" })).toThrow(/must be a boolean/);
    expect(() => parseNexusCapabilities({ views: { system: "false" } })).toThrow(/must be a boolean/);
  });

  test("only gateable views may be withheld", () => {
    // Fleet Canvas is the product and has no flag; a typo must not read
    // as "that view is required".
    expect(() => parseNexusCapabilities({ views: { fleet: false } })).toThrow(/not a gateable view/);
    expect(() => parseNexusCapabilities({ views: { sytem: false } })).toThrow(/not a gateable view/);
  });

  test("an unknown top-level key is refused", () => {
    expect(() => parseNexusCapabilities({ workspacereset: true })).toThrow(/not a recognized key/);
  });

  test("a partial views map keeps the rest served", () => {
    const c = parseNexusCapabilities({ views: { system: false } });
    expect(c.views).toEqual({ system: false, communication: true, agents: true, backups: true });
    expect(c.workspaceReset).toBe(false);
  });

  test("reset can be enabled deliberately", () => {
    expect(parseNexusCapabilities({ workspaceReset: true }).workspaceReset).toBe(true);
  });

  test("a non-mapping is refused", () => {
    expect(() => parseNexusCapabilities("yes")).toThrow(/must be a mapping/);
    expect(() => parseNexusCapabilities([])).toThrow(/must be a mapping/);
  });
});

describe("validateEveSecretOwnership (ADR-151)", () => {
  const base = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      agents: [
        { runtime: "eve", source: "github.com/org/agents", ref: "main", subdir: "agents/echo", name: null, overrides: null },
        { runtime: "hermes", source: "github.com/org/persona", ref: "main", subdir: "distributions/manager", name: null, overrides: null },
      ],
      agentSecrets: {},
      agentGitAuth: {},
      ...over,
    }) as never;
  test("a Secret keyed by an Eve entry's derived name passes; a stray key is refused", () => {
    expect(() => validateEveSecretOwnership(base({ agentSecrets: { echo: { A: "1" }, manager: { B: "2" } } }))).not.toThrow();
    expect(() => validateEveSecretOwnership(base({ agentSecrets: { "echo-prod": { A: "1" } } }))).toThrow(/matches no agents\[\] entry/);
  });
  test("an Eve entry whose subdir basename is not a label must set agents[].name", () => {
    const bad = base({ agents: [{ runtime: "eve", source: "x", ref: "main", subdir: "agents/My Agent", name: null, overrides: null }] });
    expect(() => validateEveSecretOwnership(bad)).toThrow(/set agents\[\]\.name/);
  });
  test("agentInstanceName: name, else subdir basename, else source basename", () => {
    expect(agentInstanceName({ name: "pkg", subdir: "agents/echo", source: "x" })).toBe("pkg");
    expect(agentInstanceName({ name: null, subdir: "agents/echo", source: "x" })).toBe("echo");
    // the agent-team layout (ADR 0178): the payload segment is skipped
    expect(agentInstanceName({ name: null, subdir: "agents/eve/echo/src", source: "x" })).toBe("echo");
    expect(agentInstanceName({ name: null, subdir: "src", source: "x" })).toBe("src");
    expect(agentInstanceName({ name: null, subdir: "", source: "https://github.com/org/solo.git" })).toBe("solo");
  });
});

describe("K7 for the agent-team layout (ADR 0178)", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const { validateHermesExtensionFile } = require("../src/control-flow/config.ts") as typeof import("../src/control-flow/config.ts");
  function repo(agentYaml: string): string {
    const root = mkdtempSync(join(tmpdir(), "k7-team-"));
    mkdirSync(join(root, "agents", "eve", "echo", "harness-hg"), { recursive: true });
    mkdirSync(join(root, "agents", "eve", "echo", "src"), { recursive: true });
    writeFileSync(join(root, "agents", "eve", "echo", "harness-hg", "agent.yaml"), agentYaml);
    return root;
  }
  test("a valid agent.yaml beside the src payload passes; the legacy file is not looked for", () => {
    const root = repo("apiVersion: hermes-gitops.factorylevel.dev/agent-team/v1alpha1\nkind: Agent\nharness: eve\nenvRequires: [X]\n");
    expect(() => validateHermesExtensionFile(root, "agents[0]", "agents/eve/echo/src")).not.toThrow();
  });
  test("harness vs path disagreement and a wrong apiVersion are refused at preview", () => {
    const bad = repo("apiVersion: hermes-gitops.factorylevel.dev/agent-team/v1alpha1\nkind: Agent\nharness: hermes\n");
    expect(() => validateHermesExtensionFile(bad, "agents[0]", "agents/eve/echo/src")).toThrow(/path and the declaration must agree/);
    const wrong = repo("apiVersion: nope\nkind: Agent\nharness: eve\n");
    expect(() => validateHermesExtensionFile(wrong, "agents[0]", "agents/eve/echo/src")).toThrow(/apiVersion/);
  });
});
