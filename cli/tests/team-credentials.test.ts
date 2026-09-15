// The team credential gate (ADR 0196, layer 1): access first, then completeness, then the
// declared envRequires of every rendered record - each failure named with its path and fix, and
// never a value.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { ChildFailed } from "../src/lib.ts";
import { UNSET_SECRET_MARKER, configPresence, parsePulumiPath, formatPulumiPath, unsetSecretPaths } from "../src/env/stack-config.ts";
import { run, childFailure, meaningfulLine, type Run } from "../src/team/process.ts";
import { StackConfigError, deliveredSecretNames, readStackDocument, readStackFile, unsetMarkerFindings } from "../src/team/delivery.ts";
import { CredentialGateError, credentialFindings, credentialPreflight, probeAccess, pulumiEnvironment, teamBackend, uncoveredRequirements } from "../src/team/credentials.ts";
import { readBootstrapInputs } from "../src/team/providers.ts";
import type { TeamPlan } from "../src/team/plan.ts";

const temporary: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-credentials-")); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

// Distinctive fixture values: no message, finding or report may ever contain one.
const PLAIN = "plaintext-fixture-value-7731";
const CIPHER = "v1:fixture:CIPHERTEXT-FIXTURE-4410";
const ENV_VALUE = "shell-fixture-value-2290";
const secure = (value = CIPHER) => ({ secure: value });
/** The environment spec named for stack `factory`: its backend is gs://example-project-factory-state. */
const SPEC = { apiVersion: "hermes-gitops.factorylevel.dev/environment/v1alpha2", name: "factory", project: "example-project" };

function agent(name: string, environment: string[] = [], extra: Record<string, unknown> = {}) {
  return { name, subdir: `agents/eve/${name}/src`, environment, tools: [], writablePaths: [], skills: [], ...extra };
}
function plan(overrides: Partial<TeamPlan> = {}): TeamPlan {
  return {
    version: 1, id: "factory-teams",
    sources: [{ id: "social", repository: "https://github.com/example/social", ref: "main", private: false, agents: [agent("marketing-research")] }],
    destination: { repository: "https://github.com/example/generated", branch: "main", credentialEnv: "HG_FACTORY_GIT", autoMerge: true },
    environment: "environment.yaml", argoDestinations: ["in-cluster"],
    runtime: { image: `example/eve@sha256:${"a".repeat(64)}`, platform: "linux/amd64" },
    bootstrap: { directory: "infra", stack: "factory" }, kubeContext: "default", authorizations: [], acceptance: [],
    ...overrides,
  } as TeamPlan;
}
function bootstrap(config: Record<string, unknown> | undefined, files: Record<string, unknown> = {}) {
  const root = temp();
  fs.mkdirSync(path.join(root, "infra"), { recursive: true });
  if (config) fs.writeFileSync(path.join(root, "infra/Pulumi.factory.yaml"), stringify({ secretsprovider: "passphrase", config }));
  for (const [file, doc] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof doc === "string" ? doc : stringify(doc));
  }
  return root;
}
const everyText = (value: unknown) => JSON.stringify(value) + (value instanceof Error ? value.message : "");
function expectNoValues(value: unknown) {
  const text = everyText(value);
  for (const secret of [PLAIN, CIPHER, ENV_VALUE]) expect(text).not.toContain(secret);
}
async function caught(promise: Promise<unknown> | (() => unknown)): Promise<CredentialGateError> {
  try { typeof promise === "function" ? promise() : await promise; } catch (error) { return error as CredentialGateError; }
  throw new Error("expected the credential gate to refuse");
}
/** A Run that answers by argv prefix, producing REAL classified child failures. */
function scripted(outcomes: [string, { stdout?: string; stderr?: string; code?: number }][], seen: { argv: string[]; env?: NodeJS.ProcessEnv }[] = []): Run {
  return async (argv, _cwd, env) => {
    seen.push({ argv, env });
    const outcome = outcomes.find(([prefix]) => argv.join(" ").startsWith(prefix))?.[1] ?? { stdout: "" };
    if (outcome.code) throw childFailure(argv[0]!, outcome.code, outcome.stderr ?? "", env ?? process.env);
    return outcome.stdout ?? "";
  };
}

describe("stack configuration, read without decrypting", () => {
  test("paths parse and format in Pulumi's --path spelling", () => {
    expect(parsePulumiPath("hermes-gitops-bootstrap:agentSecrets.marketing-research.APIFY_API_TOKEN")).toEqual(["hermes-gitops-bootstrap:agentSecrets", "marketing-research", "APIFY_API_TOKEN"]);
    expect(parsePulumiPath('ns:channels[0]["dotted.key"]')).toEqual(["ns:channels", 0, "dotted.key"]);
    expect(formatPulumiPath(["ns:channels", 0, "dotted.key", "plain_key"])).toBe('ns:channels[0]["dotted.key"].plain_key');
    expect(parsePulumiPath("ns:a..b")).toBeUndefined();
  });
  test("presence distinguishes ciphertext, plaintext, empty, the unset placeholder and absence", () => {
    const doc = { config: { "p:token": secure(), "p:plain": PLAIN, "p:blank": "", "p:null": null, "p:unset": secure(UNSET_SECRET_MARKER),
      "p:tree": { a: { b: secure() } }, "p:whole": secure(), "p:list": [PLAIN] } };
    expect(configPresence(doc, "p:token")).toBe("encrypted");
    expect(configPresence(doc, "p:plain")).toBe("plaintext");
    expect(configPresence(doc, "p:blank")).toBe("empty");
    expect(configPresence(doc, "p:null")).toBe("empty");
    expect(configPresence(doc, "p:unset")).toBe("unset");
    expect(configPresence(doc, "p:tree.a.b")).toBe("encrypted");
    expect(configPresence(doc, "p:tree.a.missing")).toBe("absent");
    expect(configPresence(doc, "p:whole.inside")).toBe("opaque");
    expect(configPresence(doc, "p:list")).toBe("not-scalar");
    expect(configPresence(doc, "token", "p")).toBe("encrypted"); // a bare key is the project's
    expect(configPresence(undefined, "p:token")).toBe("absent");
  });
  test("every placeholder is found by path, nested and in lists", () => {
    const doc = { config: { "p:a": secure(UNSET_SECRET_MARKER), "p:b": { "w-1": { password: secure(UNSET_SECRET_MARKER), ok: secure() } }, "p:c": [secure(), secure(UNSET_SECRET_MARKER)] } };
    expect(unsetSecretPaths(doc)).toEqual(["p:a", "p:b.w-1.password", "p:c[1]"]);
  });
});

describe("delivery to the pod Secret ag-eve-<name>-env", () => {
  test("config keys, agentSecrets bindings and provisioned Slack apps deliver; inputs, adopted apps and placeholders do not", () => {
    const root = bootstrap({
      "hermes-gitops-bootstrap:agentSecrets": {
        "marketing-research": { ANTHROPIC_API_KEY: secure(), WORKFLOW_ENABLED: PLAIN, CONTENT_BRANCH: "", APIFY_API_TOKEN: secure(UNSET_SECRET_MARKER) },
      },
      "hermes-gitops-bootstrap:slack": { enabled: true, apps: { "marketing-research": { displayName: "R" }, "marketing-manager": { displayName: "M", appId: "A0ADOPTED01" } } },
    });
    const p = plan({ credentials: { configFile: "infra/Pulumi.factory.yaml",
      bindings: { HG_EVENT_MODEL: "hermes-gitops-bootstrap:agentSecrets.event-coordinator.ANTHROPIC_API_KEY", HG_CRM: "hermes-gitops-bootstrap:applicationSecrets.event-coordinator.crm.KEY" },
      inputs: { HG_READS_ONLY: "hermes-gitops-bootstrap:agentSecrets.inputs-only.READ_KEY" } } });
    expect(deliveredSecretNames(p, root)).toEqual({
      "marketing-research": ["ANTHROPIC_API_KEY", "CONTENT_BRANCH", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "WORKFLOW_ENABLED"],
      "event-coordinator": ["ANTHROPIC_API_KEY"],
    });
  });
  test("with no credentials block the bootstrap stack's own config file is the baseline", () => {
    const root = bootstrap({ "hermes-gitops-bootstrap:agentSecrets": { "marketing-research": { ANTHROPIC_API_KEY: secure() } } });
    expect(deliveredSecretNames(plan(), root)).toEqual({ "marketing-research": ["ANTHROPIC_API_KEY"] });
    expect(deliveredSecretNames(plan(), bootstrap(undefined))).toEqual({});
  });
});

describe("declared envRequires coverage", () => {
  const research = (envRequires: unknown, environment: string[] = ["ANTHROPIC_API_KEY"]) => ({
    p: plan({ sources: [{ id: "social", repository: "https://github.com/example/social", ref: "main", private: false, agents: [agent("marketing-research", environment)] }],
      credentials: { configFile: "infra/Pulumi.factory.yaml", bindings: {} } }),
    requirements: [{ agent: "marketing-research", envRequires, agentFile: "social:agents/eve/marketing-research/harness-hg/agent.yaml" }],
  });
  test("optional entries are ignored; a bare string is required and secret", () => {
    const root = bootstrap({ "hermes-gitops-bootstrap:agentSecrets": { "marketing-research": { ANTHROPIC_API_KEY: secure() } } });
    const { p, requirements } = research([{ name: "APIFY_API_TOKEN", required: false, secret: true }, "ANTHROPIC_API_KEY"]);
    expect(uncoveredRequirements(p, root, requirements)).toEqual([]);
    const bare = research(["POSTIZ_API_KEY"]);
    expect(uncoveredRequirements(bare.p, root, bare.requirements).map(f => [f.kind, f.envNames[0]])).toEqual([["undelivered", "POSTIZ_API_KEY"]]);
  });
  test("an empty plaintext value, a placeholder and a missing startup-proof name each fail; provisioned Slack names are exempt from the proof rule", () => {
    const root = bootstrap({
      "hermes-gitops-bootstrap:agentSecrets": { "marketing-research": { ANTHROPIC_API_KEY: secure(), SLACK_HOME_CHANNEL: "", WEBHOOK_SECRET: secure(UNSET_SECRET_MARKER), INFERLAB_TEAM_TOKEN: secure() } },
      "hermes-gitops-bootstrap:slack": { enabled: true, apps: { "marketing-research": { displayName: "R" } } },
    });
    const { p, requirements } = research([
      { name: "ANTHROPIC_API_KEY", required: true }, { name: "SLACK_HOME_CHANNEL", required: true, secret: false },
      { name: "WEBHOOK_SECRET", required: true }, { name: "INFERLAB_TEAM_TOKEN", required: true },
      { name: "SLACK_BOT_TOKEN", required: true }, { name: "CONFIG_ONLY", required: true, secret: false },
    ]);
    const findings = uncoveredRequirements(p, root, requirements);
    expect(findings.map(f => [f.kind, f.envNames[0]])).toEqual([
      ["empty", "SLACK_HOME_CHANNEL"], ["unset", "WEBHOOK_SECRET"], ["unproven", "INFERLAB_TEAM_TOKEN"], ["undelivered", "CONFIG_ONLY"],
    ]);
    const undelivered = findings.at(-1)!;
    expect(undelivered.pulumiPath).toBe("hermes-gitops-bootstrap:agentSecrets.marketing-research.CONFIG_ONLY");
    expect(undelivered.agentFile).toBe("social:agents/eve/marketing-research/harness-hg/agent.yaml");
    expect(undelivered.fix.join("\n")).toContain("credentials.bindings: { HG_MARKETING_RESEARCH_CONFIG_ONLY: hermes-gitops-bootstrap:agentSecrets.marketing-research.CONFIG_ONLY }");
    expect(undelivered.fix.join("\n")).toContain("(cd infra && pulumi config set --secret --path 'hermes-gitops-bootstrap:agentSecrets.marketing-research.CONFIG_ONLY' --stack factory --config-file Pulumi.factory.yaml)");
  });
  test("a binding or a whole-encrypted agentSecrets block is judged honestly", () => {
    const covered = research(["APIFY_API_TOKEN"], ["APIFY_API_TOKEN"]);
    covered.p.credentials!.bindings = { HG_APIFY: "hermes-gitops-bootstrap:agentSecrets.marketing-research.APIFY_API_TOKEN" };
    const blank = bootstrap({ "hermes-gitops-bootstrap:agentSecrets": { "marketing-research": { APIFY_API_TOKEN: "" } } });
    expect(uncoveredRequirements(covered.p, blank, covered.requirements)).toEqual([]); // the binding replaces the blank value
    const opaque = bootstrap({ "hermes-gitops-bootstrap:agentSecrets": secure() });
    expect(uncoveredRequirements(covered.p, opaque, research(["APIFY_API_TOKEN"]).requirements).map(f => f.kind)).toEqual(["opaque"]);
  });
});

describe("the completeness preflight lists every gap at once", () => {
  function mixed() {
    const root = bootstrap({
      "hermes-gitops-bootstrap:gitopsGitToken": secure(),
      "hermes-gitops-bootstrap:cloudflareApiToken": secure(UNSET_SECRET_MARKER),
      "hermes-gitops-bootstrap:agentGitAuth": { "event-coordinator": { password: secure(UNSET_SECRET_MARKER) } },
      "hermes-gitops-bootstrap:agentSecrets": { "marketing-research": { ANTHROPIC_API_KEY: secure(), WORKFLOW_ENABLED: PLAIN } },
    }, { "infra/environments/factory.yaml": SPEC });
    const p = plan({
      sources: [
        { id: "social", repository: "https://github.com/example/social", ref: "main", private: true, credentialEnv: "HG_FACTORY_GIT", agents: [
          agent("marketing-research", ["ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN"], { gitAuthSecretRef: "g", environmentBindings: { ANTHROPIC_API_KEY: "HG_RESEARCH_MODEL", SLACK_BOT_TOKEN: "HG_RESEARCH_SLACK" } }),
          agent("marketing-engagement", ["ANTHROPIC_API_KEY"], { gitAuthSecretRef: "g", environmentBindings: { ANTHROPIC_API_KEY: "HG_ENGAGEMENT_MODEL" }, appValueBindings: { "postiz.auth.jwtSecret": "HG_POSTIZ_JWT" } }),
        ] },
        { id: "events", repository: "https://github.com/example/events", ref: "main", private: true, credentialEnv: "HG_EVENTS_GIT", agents: [
          agent("event-coordinator", ["ANTHROPIC_API_KEY"], { gitAuthSecretRef: "g", environmentBindings: { ANTHROPIC_API_KEY: "HG_EVENT_MODEL" } }),
        ] },
      ],
      credentials: { configFile: "infra/Pulumi.factory.yaml",
        inputs: {
          HG_FACTORY_GIT: "hermes-gitops-bootstrap:gitopsGitToken",                                          // present
          HG_RESEARCH_MODEL: "hermes-gitops-bootstrap:agentSecrets.marketing-research.ANTHROPIC_API_KEY",   // present
          HG_ENGAGEMENT_MODEL: "hermes-gitops-bootstrap:agentSecrets.marketing-engagement.ANTHROPIC_API_KEY", // absent
          HG_CLOUDFLARE: "hermes-gitops-bootstrap:cloudflareApiToken",                                     // placeholder
        },
        bindings: {
          HG_EVENT_MODEL: "hermes-gitops-bootstrap:agentSecrets.event-coordinator.ANTHROPIC_API_KEY", // no source at all
          HG_GIT_EVENT: "hermes-gitops-bootstrap:agentGitAuth.event-coordinator.password",             // from the shell env
          HG_CRM_KEY: "hermes-gitops-bootstrap:applicationSecrets.event-coordinator.crm.KEY",             // integration output
        },
        secretInputs: {
          HG_RESEARCH_SLACK: { namespace: "ag-eve-marketing-research", secret: "ag-eve-marketing-research-env", key: "SLACK_BOT_TOKEN" },
          HG_POSTIZ_JWT: { namespace: "ag-eve-marketing-engagement", secret: "postiz", key: "JWT_SECRET" },
        } },
      integrations: [{ id: "crm", directory: "infra/integrations/crm", stack: "factory", configFile: "infra/crm.yaml", provision: {}, activate: {}, outputs: { HG_CRM_KEY: ["credentials", "key"] } }],
    });
    return { root, p };
  }
  test("present, absent, placeholder and shell-only entries resolve to the complete list", () => {
    const { root, p } = mixed();
    const { findings, deferred } = credentialFindings(p, root, { HG_GIT_EVENT: ENV_VALUE });
    expect(findings.map(f => [f.kind, f.envNames.join(","), f.pulumiPath ?? "-"]).sort()).toEqual([
      ["binding", "HG_EVENT_MODEL", "hermes-gitops-bootstrap:agentSecrets.event-coordinator.ANTHROPIC_API_KEY"],
      ["input", "HG_CLOUDFLARE", "hermes-gitops-bootstrap:cloudflareApiToken"],
      ["input", "HG_ENGAGEMENT_MODEL", "hermes-gitops-bootstrap:agentSecrets.marketing-engagement.ANTHROPIC_API_KEY"],
      ["source-credential", "HG_EVENTS_GIT", "-"],
      ["unset", "HG_GIT_EVENT", "hermes-gitops-bootstrap:agentGitAuth.event-coordinator.password"],
    ].sort());
    const binding = findings.find(f => f.kind === "binding")!;
    expect(binding.neededBy).toContainEqual({ kind: "agent", name: "event-coordinator", as: "ANTHROPIC_API_KEY" });
    expect(binding.fix.join("\n")).toContain("credentials.inputs: { HG_EVENT_MODEL: hermes-gitops-bootstrap:agentSecrets.event-coordinator.ANTHROPIC_API_KEY }");
    expect(findings.find(f => f.envNames[0] === "HG_ENGAGEMENT_MODEL")!.neededBy).toContainEqual({ kind: "agent", name: "marketing-engagement", as: "ANTHROPIC_API_KEY" });
    expect(deferred.map(d => d.envName).sort()).toEqual(["HG_POSTIZ_JWT", "HG_RESEARCH_SLACK"]);
    expectNoValues({ findings, deferred });
  });
  test("the refusal is one CliError grouped by agent, naming installation, paths and fixes and no value", async () => {
    const { root, p } = mixed();
    const error = await caught(credentialPreflight(p, root, "plan", scripted([
      ["pulumi stack ls", { stdout: JSON.stringify([{ name: "factory" }]) }],
      ["kubectl config get-contexts", { stdout: "default\n" }],
      ["kubectl --context default", { stdout: "yes" }],
    ]), { HG_GIT_EVENT: ENV_VALUE }));
    expect(error).toBeInstanceOf(CredentialGateError);
    expect(error.findings).toHaveLength(5);
    expect(error.message).toContain("team factory-teams");
    expect(error.message).toMatch(/^agent event-coordinator$/m);
    expect(error.message).toMatch(/^source events$/m);
    expect(error.message).toContain("pulumi config set --secret --path 'hermes-gitops-bootstrap:cloudflareApiToken' --stack factory --config-file Pulumi.factory.yaml");
    expect(error.message).toContain("HG_POSTIZ_JWT"); // named as checked when the run reads the cluster
    expect(error.message).toContain("(cd infra && PULUMI_BACKEND_URL=gs://example-project-factory-state pulumi config set --secret --path 'hermes-gitops-bootstrap:cloudflareApiToken'");
    expectNoValues(error);
  });
  test("placeholders in any stack file the plan names are findings, attributed to their agent", () => {
    const { root, p } = mixed();
    fs.writeFileSync(path.join(root, "infra/crm.yaml"), stringify({ config: { "hg-crm:dsn": secure(UNSET_SECRET_MARKER) } }));
    const found = unsetMarkerFindings(p, root);
    expect(found.map(f => f.pulumiPath)).toEqual(["hermes-gitops-bootstrap:cloudflareApiToken", "hermes-gitops-bootstrap:agentGitAuth.event-coordinator.password", "hg-crm:dsn"]);
    expect(found[1]!.neededBy).toContainEqual({ kind: "agent", name: "event-coordinator", as: "password" });
    expect(found[2]!.fix[0]).toContain("(cd infra/integrations/crm && pulumi config set --secret --path 'hg-crm:dsn' --stack factory --config-file ../../crm.yaml)");
  });
});

describe("classified child failures", () => {
  const cases: [string, string, RegExp, RegExp][] = [
    ["google-auth", `error: read ".pulumi/meta.yaml": Get "https://storage.googleapis.com/inferlab-pulumi-state/.pulumi%2Fmeta.yaml": oauth2: "invalid_grant" "reauth related error (invalid_rapt)" ya29.fixture-token-4455`, /Google credentials need re-authentication/, /gcloud auth application-default login/],
    ["google-auth", "error: missing google credentials: unable to find gcp credentials: google: could not find default credentials", /Google credentials/, /GOOGLE_APPLICATION_CREDENTIALS/],
    ["kms-denied", "error: secrets (code=PermissionDenied): rpc error: code = PermissionDenied desc = Permission 'cloudkms.cryptoKeyVersions.useToDecrypt' denied on resource 'projects/p/locations/us/keyRings/pulumi/cryptoKeys/k'", /Cloud KMS refused to decrypt/, /cloudkms\.cryptoKeyDecrypter/],
    ["backend-login", "error: PULUMI_ACCESS_TOKEN must be set for login during non-interactive CLI sessions", /not logged in to a backend/, /PULUMI_BACKEND_URL/],
    ["stack-missing", "error: no stack named 'factory' found", /stack factory not found on backend gs:\/\/inferlab-pulumi-state/, /expected/],
    ["config-key-missing", "error: configuration key 'agentSecrets.marketing-research.APIFY_API_TOKEN' not found for stack 'factory'", /configuration key agentSecrets\.marketing-research\.APIFY_API_TOKEN is not set for stack factory/, /pulumi config set --secret --path/],
    ["kube-context-missing", 'error: context "default" does not exist', /kube context default does not exist/, /merge that cluster's kubeconfig as context default/],
    ["kube-unreachable", "Unable to connect to the server: dial tcp 10.0.0.9:6443: i/o timeout", /Kubernetes API server is unreachable/, /network/],
    ["kube-forbidden", 'Error from server (Forbidden): secrets "ag-eve-x-env" is forbidden: User "system:serviceaccount:a:b" cannot get resource "secrets" in API group "" in the namespace "ag-eve-x"', /RBAC denies get on secrets in namespace ag-eve-x/, /grant/],
  ];
  for (const [kind, stderr, cause, fix] of cases) test(`${kind}: ${stderr.slice(0, 48)}…`, async () => {
    const dir = temp();
    const failure = await run(["sh", "-c", 'printf "%s\\n" "$HG_FAKE_STDERR" >&2; exit 6'], dir, { ...process.env, HG_FAKE_STDERR: stderr, PULUMI_BACKEND_URL: "gs://inferlab-pulumi-state", HG_TEAM_DIAGNOSTICS_DIR: path.join(dir, "diag") }).then(() => undefined, (e: unknown) => e);
    expect(failure).toBeInstanceOf(ChildFailed);
    const child = failure as ChildFailed;
    expect(child.failure?.kind).toBe(kind as NonNullable<ChildFailed["failure"]>["kind"]);
    expect(child.childExitCode).toBe(6);
    expect(child.message).toMatch(cause);
    expect(child.message).toMatch(fix);
    expect(child.message).toContain("diagnostics:");
    // Only a failure that really comes from a declared input says so.
    if (kind === "config-key-missing") expect(child.message).toContain("repair the declared input");
    else expect(child.message).not.toContain("repair the declared input");
    expect(child.message).not.toContain("ya29.fixture-token-4455");
  });
  // Real factory failures, 2026-09-10: none of them came from a declared input.
  test("Argo CD without its cluster config is a platform fault, not an input", async () => {
    const stderr = "time=\"2026-09-10\" level=fatal msg=\"rpc error: code = Unknown desc = error getting application cluster config: error creating cluster client: unable to create K8s REST config: stat /home/argocd/.kube/config: no such file or directory\"\ncommand terminated with exit code 20";
    const failure = await run(["sh", "-c", 'printf "%s\\n" "$HG_FAKE_STDERR" >&2; exit 20'], temp(), { ...process.env, HG_FAKE_STDERR: stderr }).catch((e: unknown) => e) as ChildFailed;
    expect(failure.failure?.kind).toBe("argocd-cluster-config");
    expect(failure.childExitCode).toBe(20);
    expect(failure.message).toContain("Argo CD could not reach the application cluster (in-cluster config missing)");
    expect(failure.message).not.toContain("repair the declared input");
  });
  test("a failed kubectl exec into an agent names pod, container, namespace and acceptance scenario", () => {
    const argv = ["kubectl", "--context", "default", "-n", "ag-eve-marketing-research", "exec", "statefulset/ag-eve-marketing-research", "--",
      "env", `HG_TEAM_ACCEPTANCE_ID=${"a".repeat(64)}:marketing-research-top-reels`, "node", "--input-type=module", "-e", "process.exit(1)"];
    const failure = childFailure("kubectl", 1, 'Defaulted container "eve-agent" out of: eve-agent, build-agent (init)\ncommand terminated with exit code 1', process.env, { argv });
    expect(failure.failure?.kind).toBe("kube-exec-failed");
    expect(failure.childExitCode).toBe(1);
    expect(failure.message).toContain("statefulset/ag-eve-marketing-research, container eve-agent, namespace ag-eve-marketing-research, acceptance scenario marketing-research-top-reels");
    expect(failure.message).toContain("scenario marketing-research-top-reels's output");
    expect(failure.message).not.toContain("repair the declared input");
  });
  test("an Eve build validation error names the agent, the source file and the Expected line, without npm noise", () => {
    const stderr = [
      "npm notice", "npm notice New minor version of npm available! 10.8.2 -> 10.9.0", "",
      "> event-coordinator@0.1.0 build", "> eve build",
      'Expected the connection export "default" from "connections/twenty.ts" to match the public eve shape. The "url" field must be a valid URL.',
      "npm notice To update run: npm install -g npm@10.9.0",
    ].join("\n");
    const argv = ["docker", "run", "--rm", "--name", "hg-startup-event-coordinator-4242", "--platform", "linux/amd64", "example/eve@sha256:abc", "sh", "-c", "..."];
    const failure = childFailure("docker", 1, stderr, { ...process.env, HG_PROJECT_SUBDIR: "agents/eve/event-coordinator/src" }, { argv });
    expect(failure.failure?.kind).toBe("eve-build-validation");
    expect(failure.message).toContain('Eve build validation failed for agent event-coordinator: Expected the connection export "default" from "connections/twenty.ts" to match the public eve shape. The "url" field must be a valid URL.');
    expect(failure.message).toContain("fix connections/twenty.ts in the persona repository's agent source (agents/eve/event-coordinator/src)");
    expect(failure.message).not.toContain("npm notice");
    expect(failure.message).not.toContain("repair the declared input");
  });
  test("an unrecognised failure surfaces its last meaningful line: no npm notices, blanks, credential shapes or declared values", async () => {
    const stderr = ["Error: the webhook relay refused the payload (HTTP 422)", "npm notice New version", "", "  secure: v1:abcdefgh:CIPHERTEXTCIPHERTEXT==",
      `token ${"Q".repeat(40)}`, "\u001b[31mnpm notice done\u001b[0m"].join("\n");
    expect(meaningfulLine(stderr)).toBe("Error: the webhook relay refused the payload (HTTP 422)");
    expect(meaningfulLine("fatal: cannot use relay-fixture-value-5521 here", ["relay-fixture-value-5521"])).not.toContain("relay-fixture-value-5521");
    const failure = await run(["sh", "-c", 'printf "%s\\n" "$HG_FAKE_STDERR" >&2; exit 3'], temp(), { ...process.env, HG_FAKE_STDERR: stderr, RELAY_API_KEY: "relay-fixture-value-5521" }).catch((e: unknown) => e) as ChildFailed;
    expect(failure.failure).toBeUndefined();
    expect(failure.childExitCode).toBe(3);
    expect(failure.message).toContain("sh failed (exit 3): Error: the webhook relay refused the payload (HTTP 422)");
    expect(failure.message).not.toContain("CIPHERTEXT");
    expect(failure.message).not.toContain("QQQQ");
    expect(failure.message).not.toContain("repair the declared input");
    const echoed = await run(["sh", "-c", 'echo "relay rejected $RELAY_API_KEY" >&2; exit 4'], temp(), { ...process.env, RELAY_API_KEY: "relay-fixture-value-5521" }).catch((e: unknown) => e) as ChildFailed;
    expect(echoed.message).not.toContain("relay-fixture-value-5521");
  });
});

describe("the access probe runs before any credential is judged", () => {
  const withSecretInputs = () => plan({ credentials: { configFile: "infra/Pulumi.factory.yaml", bindings: {},
    inputs: { HG_MISSING: "hermes-gitops-bootstrap:agentSecrets.marketing-research.NOT_THERE" },
    secretInputs: { HG_SLACK: { namespace: "ag-eve-marketing-research", secret: "ag-eve-marketing-research-env", key: "SLACK_BOT_TOKEN" } } } });

  test("the backend is derived from the environment spec named by the stack, beside or under environments/", () => {
    const root = bootstrap({}, { "infra/environments/factory-events/environment.yaml": SPEC, "infra/environments/factory.yaml": { ...SPEC, apiVersion: "hermes-gitops.factorylevel.dev/environment/v1alpha1" },
      "infra/environments/factory-communication/topology.yaml": { version: 1 } });
    expect(teamBackend(plan(), root, undefined)).toMatchObject({ derived: "gs://example-project-factory-state" });
    expect(teamBackend(plan(), bootstrap({}), undefined).derived).toBeUndefined();
    const split = bootstrap({}, { "infra/environments/factory.yaml": SPEC, "infra/environments/other/environment.yaml": { ...SPEC, project: "another-project" } });
    expect(() => teamBackend(plan(), split, undefined)).toThrow(/gs:\/\/another-project-factory-state.*gs:\/\/example-project-factory-state|gs:\/\/example-project-factory-state.*gs:\/\/another-project-factory-state/s);
  });
  test("every Pulumi child gets the derived backend, and a different operator backend is refused naming both", async () => {
    const root = bootstrap({ "hermes-gitops-bootstrap:gitopsGitToken": secure() }, { "infra/environments/factory.yaml": SPEC });
    const p = plan({ credentials: { configFile: "infra/Pulumi.factory.yaml", bindings: {}, inputs: { HG_TEST_BACKEND_TOKEN: "hermes-gitops-bootstrap:gitopsGitToken" } } });
    const seen: { argv: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const saved = process.env.PULUMI_BACKEND_URL;
    try {
      delete process.env.PULUMI_BACKEND_URL;
      await readBootstrapInputs(p, root, async (argv, _cwd, env) => { seen.push({ argv, env }); return JSON.stringify({ value: "fixture" }); });
      expect(seen[0]!.env?.PULUMI_BACKEND_URL).toBe("gs://example-project-factory-state");
      expect(pulumiEnvironment(p, root, {}).PULUMI_BACKEND_URL).toBe("gs://example-project-factory-state");
      process.env.PULUMI_BACKEND_URL = "gs://inferlab-pulumi-state";
      const error = await caught(readBootstrapInputs(p, root, async () => "{}"));
      expect(error).toBeInstanceOf(CredentialGateError);
      expect(error.message).toContain("gs://inferlab-pulumi-state");
      expect(error.message).toContain("gs://example-project-factory-state");
    } finally {
      if (saved === undefined) delete process.env.PULUMI_BACKEND_URL; else process.env.PULUMI_BACKEND_URL = saved;
      delete process.env.HG_TEST_BACKEND_TOKEN;
    }
  });
  test("backend, stack, Google credentials and kube context failures arrive in ONE message, and no input is judged missing", async () => {
    const root = bootstrap({}, { "infra/environments/factory.yaml": SPEC });
    const seen: { argv: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const exec = scripted([
      ["pulumi stack ls", { code: 1, stderr: `error: Get "https://storage.googleapis.com/example-project-factory-state/.pulumi%2Fmeta.yaml": oauth2: "invalid_grant" "reauth related error (invalid_rapt)"` }],
      ["kubectl config get-contexts", { stdout: "k3d-hermes-gitops-cli\n" }],
    ], seen);
    const error = await caught(credentialPreflight(withSecretInputs(), root, "plan", exec, { PULUMI_BACKEND_URL: "gs://inferlab-pulumi-state" }));
    expect(error).toBeInstanceOf(CredentialGateError);
    expect(error.access.map(f => f.kind)).toEqual(["backend-mismatch", "google-auth", "kube-context-missing"]);
    expect(error.findings).toEqual([]);
    expect(error.message).toContain("cannot read the encrypted team configuration: Google credentials need re-authentication");
    expect(error.message).toContain("gcloud auth application-default login");
    expect(error.message).toContain("PULUMI_BACKEND_URL=gs://example-project-factory-state");
    expect(error.message).toContain("No declared input has been judged missing yet");
    expect(error.message).toContain("k3d-hermes-gitops-cli");
    expect(error.message).not.toContain("NOT_THERE");
    expect(seen.find(c => c.argv[0] === "pulumi")!.env?.PULUMI_BACKEND_URL).toBe("gs://example-project-factory-state");
  });
  test("a stack missing from a reachable backend is named with the backend searched and the one expected", async () => {
    const root = bootstrap({}, { "infra/environments/factory.yaml": SPEC });
    const failures = await probeAccess(withSecretInputs(), root, "plan", scripted([
      ["pulumi stack ls", { stdout: JSON.stringify([{ name: "scratch" }]) }],
      ["kubectl config get-contexts", { stdout: "default\n" }],
      ["kubectl --context default", { stdout: "yes" }],
    ]), {});
    expect(failures.map(f => f.kind)).toEqual(["stack-missing"]);
    expect(failures[0]!.cause).toContain("stack factory not found on backend gs://example-project-factory-state");
    expect(failures[0]!.fix).toContain("infra/environments/factory.yaml");
  });
  test("an unreachable API server and an RBAC denial are named per namespace", async () => {
    const p = withSecretInputs();
    p.credentials!.secretInputs!.HG_OTHER = { namespace: "ag-eve-marketing-sre", secret: "s", key: "K" };
    const reachable = scripted([
      ["pulumi stack ls", { stdout: JSON.stringify([{ name: "factory" }]) }],
      ["kubectl config get-contexts", { stdout: "default\n" }],
      ["kubectl --context default --request-timeout=5s auth can-i get secrets/ag-eve-marketing-research-env -n ag-eve-marketing-research", { stdout: "yes" }],
      ["kubectl --context default --request-timeout=5s auth can-i get secrets/s -n ag-eve-marketing-sre", { code: 1, stderr: "" }],
    ]);
    const denied = await probeAccess(p, bootstrap({}, { "infra/environments/factory.yaml": SPEC }), "plan", reachable, {});
    expect(denied.map(f => [f.kind, f.cause])).toEqual([["kube-forbidden", "RBAC denies get on secrets/s in namespace ag-eve-marketing-sre"]]);
    const unreachable = await probeAccess(p, bootstrap({}, { "infra/environments/factory.yaml": SPEC }), "plan", scripted([
      ["pulumi stack ls", { stdout: JSON.stringify([{ name: "factory" }]) }],
      ["kubectl config get-contexts", { stdout: "default\n" }],
      ["kubectl --context", { code: 1, stderr: "Unable to connect to the server: dial tcp 10.0.0.9:6443: i/o timeout" }],
    ]), {});
    expect(unreachable.map(f => f.kind)).toEqual(["kube-unreachable"]);
  });
  test("Google credentials are checked directly only when Pulumi did not already exercise them", async () => {
    const root = bootstrap({}, { "infra/Pulumi.factory.yaml": "secretsprovider: gcpkms://projects/p/locations/us/keyRings/pulumi/cryptoKeys/k\nconfig: {}\n", "infra/environments/factory.yaml": SPEC });
    const p = plan({ credentials: { configFile: "infra/Pulumi.factory.yaml", bindings: {} } });
    const seen: { argv: string[] }[] = [];
    const failures = await probeAccess(p, root, "plan", scripted([
      ["pulumi stack ls", { code: 1, stderr: "error: unexpected response from the state backend" }],
      ["gcloud auth application-default print-access-token", { code: 1, stderr: "ERROR: (gcloud.auth.application-default.print-access-token) Reauthentication failed. cannot prompt during non-interactive execution." }],
    ], seen), {});
    expect(seen.map(c => c.argv[0])).toEqual(["pulumi", "gcloud"]);
    expect(failures.map(f => f.kind)).toEqual(["probe-failed", "google-auth"]);
    const seenGs: { argv: string[] }[] = [];
    const gs = await probeAccess(p, root, "plan", scripted([["pulumi stack ls", { stdout: JSON.stringify([{ name: "factory" }]) }]], seenGs), {});
    expect(gs).toEqual([]);
    expect(seenGs.map(c => c.argv[0])).toEqual(["pulumi"]);
  });
});

// Codex review of ADR 0196 layer 1: one test per accepted finding.
describe("review hardening", () => {
  test("a declared value inside a captured name is scrubbed before classifying, and from the structured failure", () => {
    const secret = "stack-secret-value-8812";
    const env = { ...process.env, HG_STACK_TOKEN: secret, PULUMI_BACKEND_URL: "gs://example-project-factory-state" };
    for (const stderr of [`error: no stack named '${secret}' found`, `error: configuration key 'agentSecrets.${secret}' not found for stack 'factory'`, `error: context "${secret}" does not exist`]) {
      const failure = childFailure("pulumi", 255, stderr, env);
      expect(failure.failure).toBeDefined();
      expect(failure.message).not.toContain(secret);
      expect(JSON.stringify(failure.failure)).not.toContain(secret);
    }
  });
  test("a malformed stack file is named by file and position, never quoted", async () => {
    const secret = "duplicate-key-secret-7733";
    const text = `secretsprovider: passphrase\nconfig:\n  hermes-gitops-bootstrap:agentSecrets:\n    marketing-research:\n      APIFY_API_TOKEN: ${secret}\n      APIFY_API_TOKEN: ${secret}\n`;
    expect(() => parse(text)).toThrow(secret); // what the parser's own message would have leaked
    const root = bootstrap(undefined, { "infra/Pulumi.factory.yaml": text, "infra/environments/factory.yaml": SPEC });
    expect(readStackFile(root, "infra/Pulumi.factory.yaml").problem).toMatch(/^infra\/Pulumi\.factory\.yaml is not valid YAML \(line \d+, column \d+\)$/);
    expect(() => readStackDocument(root, "infra/Pulumi.factory.yaml")).toThrow(StackConfigError);
    const p = plan({ credentials: { configFile: "infra/Pulumi.factory.yaml", bindings: {} } });
    expect(everyText(await caught(() => unsetMarkerFindings(p, root)))).not.toContain(secret);
    const error = await caught(credentialPreflight(p, root, "plan", scripted([["pulumi stack ls", { stdout: JSON.stringify([{ name: "factory" }]) }]]), {}));
    expect(error.access.map(f => f.kind)).toEqual(["config-unreadable"]);
    expect(everyText(error)).not.toContain(secret);
  });
  test("an absent or malformed environment spec refuses before any Pulumi call; the last login is never used", async () => {
    const p = plan({ credentials: { configFile: "infra/Pulumi.factory.yaml", bindings: {}, inputs: { HG_TEST_UNDERIVED: "hermes-gitops-bootstrap:gitopsGitToken" } } });
    const config = { "hermes-gitops-bootstrap:gitopsGitToken": secure() };
    const seen: { argv: string[] }[] = [];
    const absent = bootstrap(config);
    const failures = await probeAccess(p, absent, "plan", scripted([], seen), { PULUMI_BACKEND_URL: "gs://inferlab-pulumi-state" });
    expect(failures.map(f => f.kind)).toEqual(["backend-underived"]);
    expect(failures[0]!.cause).toContain("infra/environments/factory.yaml");
    expect(failures[0]!.fix).toContain("PULUMI_BACKEND_URL=gs://inferlab-pulumi-state is not used");
    const malformed = bootstrap(config, { "infra/environments/factory.yaml": "apiVersion: hermes-gitops.factorylevel.dev/environment/v1alpha2\nname: factory\nproject: [unclosed\n" });
    const bad = await probeAccess(p, malformed, "plan", scripted([], seen), {});
    expect(bad.map(f => f.kind)).toEqual(["backend-underived"]);
    expect(bad[0]!.cause).toMatch(/infra\/environments\/factory\.yaml is not valid YAML \(line \d+, column \d+\)/);
    const other = bootstrap(config, { "infra/environments/factory.yaml": { version: 1, name: "factory" } });
    expect((await probeAccess(p, other, "plan", scripted([], seen), {}))[0]!.cause).toContain("is not an environment spec");
    expect(seen).toEqual([]);
    expect(() => pulumiEnvironment(p, absent, {})).toThrow(/no environment spec derives its state backend/);
    let called = false;
    await expect(readBootstrapInputs(p, absent, async () => { called = true; return "{}"; })).rejects.toThrow(CredentialGateError);
    expect(called).toBe(false);
    delete process.env.HG_TEST_UNDERIVED;
  });
  test("RBAC scoped by resourceNames passes: each declared Secret is probed by name, never the whole namespace", async () => {
    const p = plan({ credentials: { configFile: "infra/Pulumi.factory.yaml", bindings: {}, secretInputs: {
      HG_A: { namespace: "ag-eve-marketing-research", secret: "ag-eve-marketing-research-env", key: "SLACK_BOT_TOKEN" },
      HG_B: { namespace: "ag-eve-marketing-research", secret: "ag-eve-marketing-research-env", key: "SLACK_SIGNING_SECRET" },
      HG_C: { namespace: "ag-eve-marketing-engagement", secret: "postiz", key: "JWT_SECRET" },
    } } });
    const seen: { argv: string[] }[] = [];
    const failures = await probeAccess(p, bootstrap({}, { "infra/environments/factory.yaml": SPEC }), "plan", scripted([
      ["pulumi stack ls", { stdout: JSON.stringify([{ name: "factory" }]) }],
      ["kubectl config get-contexts", { stdout: "default\n" }],
      // A Role limited by resourceNames: namespace-wide get is denied, the named Secrets allowed.
      ["kubectl --context default --request-timeout=5s auth can-i get secrets -n", { code: 1, stderr: "" }],
      ["kubectl --context default --request-timeout=5s auth can-i get secrets/ag-eve-marketing-research-env -n ag-eve-marketing-research", { stdout: "yes" }],
      ["kubectl --context default --request-timeout=5s auth can-i get secrets/postiz -n ag-eve-marketing-engagement", { stdout: "yes" }],
    ], seen), {});
    expect(failures).toEqual([]);
    expect(seen.filter(c => c.argv.includes("can-i")).map(c => c.argv[7])).toEqual(["secrets/ag-eve-marketing-research-env", "secrets/postiz"]);
  });
  test("every repair command carries the derived backend", () => {
    const root = bootstrap({ "hermes-gitops-bootstrap:cloudflareApiToken": secure(UNSET_SECRET_MARKER) }, { "infra/environments/factory.yaml": SPEC });
    const p = plan({ credentials: { configFile: "infra/Pulumi.factory.yaml", bindings: {} } });
    expect(credentialFindings(p, root, {}).findings.map(f => f.fix[0])).toEqual([
      "(cd infra && PULUMI_BACKEND_URL=gs://example-project-factory-state pulumi config set --secret --path 'hermes-gitops-bootstrap:cloudflareApiToken' --stack factory --config-file Pulumi.factory.yaml)",
    ]);
    const uncovered = uncoveredRequirements(p, root, [{ agent: "marketing-research", envRequires: ["APIFY_API_TOKEN"] }]);
    expect(uncovered[0]!.fix.join("\n")).toContain("(cd infra && PULUMI_BACKEND_URL=gs://example-project-factory-state pulumi config set --secret --path 'hermes-gitops-bootstrap:agentSecrets.marketing-research.APIFY_API_TOKEN'");
  });
  test("an unreadable stack file is an access failure, never absent", async () => {
    if (process.getuid?.() === 0) return; // root reads through permissions
    const root = bootstrap(undefined, { "infra/locked/Pulumi.factory.yaml": { config: {} }, "infra/environments/factory.yaml": SPEC });
    const p = plan({ credentials: { configFile: "infra/locked/Pulumi.factory.yaml", bindings: {}, inputs: { HG_LOCKED: "hermes-gitops-bootstrap:gitopsGitToken" } } });
    const locked = path.join(root, "infra/locked");
    fs.chmodSync(locked, 0o000);
    try {
      expect(readStackFile(root, "infra/locked/Pulumi.factory.yaml").problem).toBe("infra/locked/Pulumi.factory.yaml cannot be read (EACCES)");
      const error = await caught(credentialPreflight(p, root, "plan", scripted([["pulumi stack ls", { stdout: JSON.stringify([{ name: "factory" }]) }]]), {}));
      expect(error.access.map(f => f.kind)).toEqual(["config-unreadable"]);
      expect(error.findings).toEqual([]);
    } finally { fs.chmodSync(locked, 0o755); }
  });
});
