// hg env new (#676): day-0 from the root-of-trust coordinates onward.
// The manual root of trust (bucket + KMS + IAM, state/README.md §1)
// stays manual BY DESIGN; everything after it is this orchestration of
// existing pieces - the spec compiler (#674), `pulumi`, and the server
// subject it hands off to. The operator supplies project + names once
// in the spec; every gs:// and gcpkms:// URI is assembled here.
//
// Backend/identity handling deliberately never mutates operator state:
// each pulumi invocation gets PULUMI_BACKEND_URL (and, for the infra
// stack, PULUMI_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT) as per-command env
// - the test-harness convention - instead of `pulumi login` rewriting
// ~/.pulumi/credentials.json. The dry-run transcript prints those
// prefixes, so it is hand-executable verbatim.
import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, PLATFORM_ROOT, jsonOut, log, ok } from "../lib.ts";
import { FrontDoorStep, runFrontDoor } from "../frontdoor.ts";
import { generateStack } from "./generate.ts";
import { projectNameOf } from "./command.ts";
import {
  EnvironmentSpec,
  envDeployerEmail,
  envStateBucketUri,
  loadEnvironmentSpec,
  rootSecretsProviderUri,
  rootStateBucketUri,
} from "./spec.ts";
import type { ProofFinding, ProofResult } from "../backup/platform.ts";

interface RunOpts {
  cwd: string;
  env: Record<string, string>;
  /** capture output instead of streaming (probes). */
  capture?: boolean;
  allowFail?: boolean;
}

function run(cmd: string[], opts: RunOpts): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: opts.capture ? "pipe" : "inherit",
    stderr: opts.capture ? "pipe" : "inherit",
  });
  const out = opts.capture ? `${proc.stdout ?? ""}${proc.stderr ?? ""}` : "";
  if (proc.exitCode !== 0 && !opts.allowFail) {
    throw new CliError(`command failed (${proc.exitCode}): ${cmd.join(" ")}${out ? `\n${out}` : ""}`);
  }
  return { code: proc.exitCode ?? 1, out };
}

function envPrefix(env: Record<string, string>): string {
  const parts = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

// ---------------------------------------------------------------------------
// Preflight - every finding at once, ProofResult shape, ENV001..

export function envNewPreflight(spec: EnvironmentSpec): ProofResult {
  const startedAt = new Date().toISOString();
  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });

  const onPath = (bin: string) => Bun.which(bin) !== null;
  add("ENV001", onPath("pulumi") ? "pass" : "fail", "toolchain",
    onPath("pulumi") ? "pulumi on PATH" : "pulumi not on PATH - install it (https://get.pulumi.com)");
  add("ENV002", onPath("gcloud") ? "pass" : "fail", "toolchain",
    onPath("gcloud") ? "gcloud on PATH" : "gcloud not on PATH - the root-of-trust probes need it");

  // ADC: ambient credentials every pulumi/gcloud call below rides on.
  if (onPath("gcloud")) {
    const adc = run(["gcloud", "auth", "application-default", "print-access-token"],
      { cwd: PLATFORM_ROOT, env: {}, capture: true, allowFail: true });
    add("ENV003", adc.code === 0 ? "pass" : "fail", "auth",
      adc.code === 0
        ? "application-default credentials present"
        : "no application-default credentials - run: gcloud auth application-default login");

    // The root of trust must EXIST before anything here runs (§1 stays
    // manual). Probed over REST with the ADC token - the SAME credential
    // pulumi rides - because `gcloud storage` uses the separate user
    // login, whose expiry would report a phantom "missing" here.
    const token = adc.out.trim().split("\n").pop() ?? "";
    const probe = (url: string): number => {
      const r = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "-H", `Authorization: Bearer ${token}`, url],
        { cwd: PLATFORM_ROOT, env: {}, capture: true, allowFail: true });
      return Number(r.out.trim() || 0);
    };
    const bucket = rootStateBucketUri(spec).replace("gs://", "");
    const bCode = adc.code === 0 ? probe(`https://storage.googleapis.com/storage/v1/b/${bucket}`) : 0;
    add("ENV004", bCode === 200 ? "pass" : adc.code !== 0 ? "unknown" : "fail", "root-of-trust",
      bCode === 200
        ? `root state bucket gs://${bucket} exists`
        : bCode === 404
          ? `root state bucket gs://${bucket} does not exist - run state/README.md §1 first`
          : `root state bucket gs://${bucket} not readable (HTTP ${bCode}) - check ADC identity/permissions`);

    const k = spec.rootKms;
    const keyUrl = `https://cloudkms.googleapis.com/v1/projects/${spec.project}/locations/${k.location}/keyRings/${k.keyring}/cryptoKeys/${k.key}`;
    const kCode = adc.code === 0 ? probe(keyUrl) : 0;
    add("ENV005", kCode === 200 ? "pass" : adc.code !== 0 ? "unknown" : "fail", "root-of-trust",
      kCode === 200
        ? `root KMS key ${k.keyring}/${k.key} exists`
        : kCode === 404
          ? `root KMS key ${k.keyring}/${k.key} does not exist - run state/README.md §1 first`
          : `root KMS key ${k.keyring}/${k.key} not readable (HTTP ${kCode}) - check ADC identity/permissions`);
  } else {
    for (const id of ["ENV003", "ENV004", "ENV005"]) add(id, "unknown", "root-of-trust", "gcloud absent; not probed");
  }

  add("ENV006", spec.state.agents.includes(spec.name) ? "pass" : "fail", "spec",
    spec.state.agents.includes(spec.name)
      ? `spec state.agents includes ${spec.name}`
      : `spec state.agents does not include ${spec.name} - the environment must provision its own backend`);

  const summary = {
    pass: findings.filter((f) => f.status === "pass").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command: "env new preflight",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    findings,
    summary,
  };
}

// ---------------------------------------------------------------------------
// The steps.

export function cmdEnvNew(json: boolean, name: string, opts: { spec?: string; dryRun: boolean }): void {
  const specFile = path.resolve(
    opts.spec ?? path.join(PLATFORM_ROOT, "infra", "environments", `${name}.yaml`),
  );
  const spec = loadEnvironmentSpec(specFile);
  if (spec.name !== name) {
    throw new CliError(`env new: the spec at ${specFile} declares ${JSON.stringify(spec.name)}, not ${JSON.stringify(name)}`);
  }

  const stateDir = path.join(PLATFORM_ROOT, "state");
  const infraDir = path.join(PLATFORM_ROOT, "infra");
  const rootEnv = { PULUMI_BACKEND_URL: rootStateBucketUri(spec) };
  const envBackend = {
    PULUMI_BACKEND_URL: envStateBucketUri(spec, name),
    PULUMI_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: envDeployerEmail(spec, name),
  };
  const secretsProvider = rootSecretsProviderUri(spec);

  // Preflight: refuse on any fail, every finding printed (the server
  // bootstrap standard).
  const pre = envNewPreflight(spec);
  for (const f of pre.findings) {
    const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
    log(`  ${mark} [${f.id}] ${f.component}: ${f.message}`);
  }
  if (!pre.ok && !opts.dryRun) {
    throw new CliError("env new: preflight failed - fix the ✗ findings (the root of trust stays manual by design)");
  }

  const stackExists = (cwd: string, env: Record<string, string>): boolean =>
    run(["pulumi", "stack", "select", name, "--non-interactive"], { cwd, env, capture: true, allowFail: true }).code === 0;

  const steps: FrontDoorStep[] = [
    {
      title: `state stack ${name} exists in the root backend`,
      command: `${envPrefix(rootEnv)}pulumi stack init ${name} --secrets-provider ${secretsProvider}  # in state/`,
      probe: () => (stackExists(stateDir, rootEnv) ? "stack selectable" : false),
      run: () => {
        run(["pulumi", "stack", "init", name, "--secrets-provider", secretsProvider, "--non-interactive"],
          { cwd: stateDir, env: rootEnv });
      },
    },
    {
      title: "state stack config generated from the spec",
      command: `hg env apply ${name}`,
      run: () => {
        const g = generateStack(spec, "state", {
          project: projectNameOf(stateDir), existingFile: path.join(stateDir, `Pulumi.${name}.yaml`), stackDir: stateDir,
        });
        fs.writeFileSync(path.join(stateDir, `Pulumi.${name}.yaml`), g.text);
      },
    },
    {
      title: "state stack up (buckets, deploy SA, IAM)",
      command: `${envPrefix(rootEnv)}pulumi up --yes -s ${name}  # in state/`,
      run: () => {
        run(["bun", "install", "--frozen-lockfile"], { cwd: stateDir, env: {}, capture: true });
        run(["pulumi", "up", "--yes", "--non-interactive", "-s", name], { cwd: stateDir, env: rootEnv });
      },
    },
    {
      title: `infra stack ${name} exists in its own backend (impersonating the deploy SA)`,
      command: `${envPrefix(envBackend)}pulumi stack init ${name} --secrets-provider ${secretsProvider}  # in infra/`,
      probe: () => (stackExists(infraDir, envBackend) ? "stack selectable" : false),
      run: () => {
        run(["pulumi", "stack", "init", name, "--secrets-provider", secretsProvider, "--non-interactive"],
          { cwd: infraDir, env: envBackend });
      },
    },
    {
      title: "infra stack config generated from the spec (secrets become findings until set)",
      command: `hg env apply ${name}`,
      run: () => {
        const g = generateStack(spec, "infra", {
          project: projectNameOf(infraDir), existingFile: path.join(infraDir, `Pulumi.${name}.yaml`), stackDir: infraDir,
        });
        fs.writeFileSync(path.join(infraDir, `Pulumi.${name}.yaml`), g.text);
        if (g.missingSecrets.length > 0) {
          const fixes = g.missingSecrets
            .map((m) => `  ${m.fix.replace(" && pulumi ", ` && ${envPrefix(envBackend)}pulumi `)}`)
            .join("\n");
          throw new CliError(
            `${g.missingSecrets.length} secret(s) unset - supply each, then re-run env new:\n${fixes}`,
          );
        }
      },
    },
    {
      title: "infra stack up (the environment converges)",
      command: `${envPrefix(envBackend)}pulumi up --yes -s ${name}  # in infra/`,
      run: () => {
        run(["bun", "install", "--frozen-lockfile"], { cwd: infraDir, env: {}, capture: true });
        run(["pulumi", "up", "--yes", "--non-interactive", "-s", name], { cwd: infraDir, env: envBackend });
      },
    },
  ];

  runFrontDoor("env new", steps, { dryRun: opts.dryRun });

  if (json) {
    jsonOut({ command: "env-new", ok: true, environment: name, dryRun: opts.dryRun, preflight: pre });
    return;
  }
  if (!opts.dryRun) {
    ok(`env new: ${name} converged - hand-off:`);
    log(`  hg server preflight --host <server>       # SRV001.. before any host work`);
    log(`  hg server bootstrap --host <server>       # sync root, pinned tools, k3s, traefik`);
    log(`  hg server register --environment ${name}  # the permanent lifecycle message`);
  }
}
