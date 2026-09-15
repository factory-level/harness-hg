import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChildFailed, CliError, type ChildFailure } from "../lib.ts";
import { scrub } from "../reconcile/index.ts";

/** Environment names the loaded plan declares as credential-bearing. Scrubbed by name whatever
 * they are called; the pattern below only catches conventional names. */
export const declaredSecrets = new Set<string>();
export type Run = (argv: string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, input?: string) => Promise<string>;

export const GOOGLE_FIX = "run `gcloud auth application-default login` (or set GOOGLE_APPLICATION_CREDENTIALS to a deployer key), then resume";

/** Name the cause of a failed child from its stderr (ADR 0196), so a refusal says "Google
 * credentials need re-authentication" rather than "repair the declared input". Only names are
 * captured from the output - a stack, a config key, a context, a verb, a resource, a namespace -
 * each bounded to name characters; nothing else of the child's output reaches the message. */
export function classifyFailure(tool: string, stderr: string, env: NodeJS.ProcessEnv = process.env, argv: string[] = [tool], secrets: string[] = []): ChildFailure | undefined {
  const backend = env.PULUMI_BACKEND_URL;
  if (/invalid_grant|invalid_rapt|reauth related error|Reauthentication (?:failed|required)|could not find default credentials|missing google credentials|unable to find gcp credentials|googleapi: Error 401|storage\.googleapis\.com\S*[^\n]{0,120}\b(?:401|403)\b/i.test(stderr)) {
    return { kind: "google-auth", cause: "Google credentials need re-authentication, so the Pulumi state and the stack's encrypted configuration cannot be read", fix: GOOGLE_FIX };
  }
  if (/cloudkms|cryptoKeyVersions\.useToDecrypt/i.test(stderr) && /PermissionDenied|permission|denied|\b403\b/i.test(stderr)) {
    return { kind: "kms-denied", cause: "Cloud KMS refused to decrypt the stack's secrets",
      fix: "grant roles/cloudkms.cryptoKeyDecrypter on the stack's key to the identity in use (or impersonate the deployer with PULUMI_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT), then resume" };
  }
  if (/PULUMI_ACCESS_TOKEN must be set|not logged in|run `?pulumi login/i.test(stderr)) {
    return { kind: "backend-login", cause: "Pulumi is not logged in to a backend",
      fix: `export PULUMI_BACKEND_URL=${backend ?? "<the installation's state backend>"} (hg team derives it from the stack's environment spec), then resume` };
  }
  let match = /no stack named '([^'\s]{1,200})' found/.exec(stderr);
  if (match) {
    return { kind: "stack-missing", cause: `stack ${match[1]} not found on backend ${backend ?? "of the current pulumi login"}`,
      fix: backend ? `the stack is expected on ${backend}; create it there, or correct the stack name` : "export PULUMI_BACKEND_URL to the backend expected to hold it (hg team derives it from the stack's environment spec)" };
  }
  match = /configuration key '([^'\s]{1,200})' not found for stack '([^'\s]{1,200})'/.exec(stderr);
  if (match) {
    return { kind: "config-key-missing", cause: `configuration key ${match[1]} is not set for stack ${match[2]}`,
      fix: `repair the declared input: store it with pulumi config set --secret --path '${match[1]}' --stack ${match[2]} --config-file <the plan's configFile>, then resume` };
  }
  if (/unable to create K8s REST config|error getting application cluster config/.test(stderr)) {
    return { kind: "argocd-cluster-config", cause: "Argo CD could not reach the application cluster (in-cluster config missing)",
      fix: "repair the Argo CD application controller's access to the destination cluster (its in-cluster service account, or the registered cluster Secret); this is a platform configuration fault, not a declared input" };
  }
  // Eve's build validation names the declaration it rejected: `Expected the connection export
  // "default" from "connections/twenty.ts" to match the public eve shape. ...`
  const expected = /^\s*(Expected [^\n]{0,400}?(?:public eve shape|export "[^"\n]{1,80}" from "[^"\n]{1,200}")[^\n]{0,300})$/m.exec(stderr);
  if (expected) {
    const line = meaningfulLine(expected[1]!, secrets);
    const file = /from "([\w./-]{1,200}\.(?:ts|mts|tsx|js|mjs))"/.exec(expected[1]!)?.[1];
    const nameAt = argv.indexOf("--name");
    const agent = /^hg-startup-([a-z][a-z0-9-]{0,39})-\d+$/.exec(nameAt >= 0 ? argv[nameAt + 1] ?? "" : "")?.[1];
    const subdir = typeof env.HG_PROJECT_SUBDIR === "string" && /^[\w./-]{1,200}$/.test(env.HG_PROJECT_SUBDIR) ? env.HG_PROJECT_SUBDIR : undefined;
    return { kind: "eve-build-validation",
      cause: `Eve build validation failed${agent ? ` for agent ${agent}` : ""}${line ? `: ${line}` : ""}`,
      fix: `fix ${file ?? "the rejected declaration"} in the persona repository's agent source${subdir ? ` (${subdir})` : ""}, commit, and resume; this is source content, not a declared input` };
  }
  match = /context "([^"\s]{1,200})" does not exist|context was not found for specified context: ([^\s]{1,200})/.exec(stderr);
  if (match) {
    const context = match[1] ?? match[2];
    return { kind: "kube-context-missing", cause: `kube context ${context} does not exist in this kubeconfig`,
      fix: `run on the destination host where the watcher runs, or merge that cluster's kubeconfig as context ${context}` };
  }
  if (/\(Forbidden\)|is forbidden:/.test(stderr)) {
    match = /cannot ([a-z]{1,40}) resource "([\w.-]{1,100})"(?: in API group "[^"]{0,100}")?(?: in the namespace "([\w.-]{1,100})")?/.exec(stderr);
    const verb = match?.[1] ?? "access", resource = match?.[2] ?? "the requested resource", namespace = match?.[3];
    return { kind: "kube-forbidden", cause: `RBAC denies ${verb} on ${resource}${namespace ? ` in namespace ${namespace}` : ""}`,
      fix: `grant the context's identity ${verb} on ${resource}${namespace ? ` in ${namespace}` : ""}, or use the context the watcher runs with` };
  }
  if (/Unable to connect to the server/.test(stderr) || (tool === "kubectl" && /i\/o timeout|connection refused|no such host|context deadline exceeded|TLS handshake timeout/i.test(stderr))) {
    return { kind: "kube-unreachable", cause: "the Kubernetes API server is unreachable",
      fix: "check the context's server address and the network path to it (VPN, tunnel, firewall), then resume" };
  }
  const exited = /command terminated with exit code (\d{1,3})/.exec(stderr);
  if (exited && (tool === "kubectl" || argv.includes("exec"))) {
    const exec = execTarget(argv);
    const container = exec.container ?? /Defaulted container "([\w.-]{1,100})"/.exec(stderr)?.[1];
    const where = [exec.target ?? "the pod", container ? `container ${container}` : "", exec.namespace ? `namespace ${exec.namespace}` : "",
      exec.scenario ? `acceptance scenario ${exec.scenario}` : ""].filter(Boolean);
    const logs = exec.namespace && exec.target ? ` and \`kubectl -n ${exec.namespace} logs ${exec.target}${container ? ` -c ${container}` : ""}\`` : "";
    return { kind: "kube-exec-failed", cause: `the command run in ${where.join(", ")} exited ${exited[1]}`,
      fix: `read ${exec.scenario ? `scenario ${exec.scenario}'s` : "the command's"} output in the diagnostics${logs}; this is the deployed agent's behaviour, not a declared input` };
  }
  return undefined;
}

/** Lines that say nothing about the failure, and lines shaped like a credential or ciphertext:
 * neither is ever surfaced. */
const NOISE = /^(?:npm (?:notice|warn)\b|npm error (?:A complete log|Log files)|Defaulted container |command terminated with exit code )/i;
const CREDENTIAL_SHAPED = /secure:|ya29\.|\bgh[pousr]_|github_pat_|xox[abposr]-|\bsk-[A-Za-z0-9]|AKIA[0-9A-Z]{12}|-----BEGIN|\bv1:[A-Za-z0-9+/=]{6,}:|\beyJ[A-Za-z0-9_-]{8,}|\b(?:Bearer|Basic) [A-Za-z0-9+/=._-]{8,}|[A-Za-z0-9+/_=-]{32,}/;

/** The last line of a child's stderr worth reading: declared secret values scrubbed, colour codes,
 * blank lines, npm notices and anything credential-shaped dropped, capped at 300 characters. */
export function meaningfulLine(stderr: string, secrets: string[] = []): string | undefined {
  const lines = scrub(stderr, secrets).split("\n")
    .map(line => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim())
    .filter(line => line && !NOISE.test(line) && !CREDENTIAL_SHAPED.test(line));
  const last = lines.at(-1);
  return last && last.length > 300 ? `${last.slice(0, 297)}...` : last;
}

/** Pod, container, namespace and acceptance scenario of a `kubectl exec`, from its argv. */
function execTarget(argv: string[]): { target?: string; container?: string; namespace?: string; scenario?: string } {
  const name = (value: string | undefined) => (value && /^[\w./:-]{1,200}$/.test(value) ? value : undefined);
  const split = argv.indexOf("--");
  const own = split >= 0 ? argv.slice(0, split) : argv;
  const flag = (names: string[]) => { const i = own.findIndex(a => names.includes(a)); return i >= 0 ? name(own[i + 1]) : undefined; };
  let target: string | undefined;
  for (let i = own.indexOf("exec") + 1; i > 0 && i < own.length; i++) {
    if (["-c", "--container", "-n", "--namespace", "--context"].includes(own[i]!)) { i++; continue; }
    if (own[i]!.startsWith("-")) continue;
    target = name(own[i]); break;
  }
  const scenario = (split >= 0 ? argv.slice(split) : []).map(a => /^HG_TEAM_ACCEPTANCE_ID=[^:\s]*:([a-z][a-z0-9-]{0,62})$/.exec(a)?.[1]).find(Boolean);
  return { target, container: flag(["-c", "--container"]), namespace: flag(["-n", "--namespace"]), scenario };
}

/** Every environment value a failed child's output must not echo. */
function secretValues(env: NodeJS.ProcessEnv, input?: string): string[] {
  return [...Object.entries(env).filter(([key]) => declaredSecrets.has(key) || /TOKEN|SECRET|PASSWORD|CREDENTIAL|GIT_CONFIG_VALUE|API_KEY/i.test(key)).map(([, value]) => value).filter((x): x is string => Boolean(x)), ...(input ? [input, input.trim()] : [])];
}

/** The exception for a failed child: a named cause and fix when its stderr is recognised;
 * otherwise its last meaningful error line. The diagnostics path stays either way, and "repair
 * the declared input" is never guessed - only a recognised input failure names an input. */
export function childFailure(tool: string, code: number, stderr: string, env: NodeJS.ProcessEnv,
  options: { diagnostic?: string; timedOut?: boolean; argv?: string[]; input?: string } = {}): ChildFailed {
  const pointer = options.diagnostic ? `diagnostics: ${options.diagnostic}` : "inspect private provider diagnostics";
  const secrets = secretValues(env, options.input);
  // Scrub first: a declared value inside a captured stack, key or context name must not survive
  // into the cause, the fix or the structured failure the ledger records.
  const clean = scrub(stderr, secrets);
  const classified = options.timedOut ? undefined : classifyFailure(tool, clean, env, options.argv ?? [tool], secrets);
  const failure = classified && { ...classified, cause: scrub(classified.cause, secrets), fix: scrub(classified.fix, secrets) };
  if (failure) return new ChildFailed(`${tool} failed (exit ${code}): ${failure.cause}. Fix: ${failure.fix}; ${pointer}`, code, failure);
  const line = meaningfulLine(clean, secrets);
  return new ChildFailed(`${tool} ${options.timedOut ? "timed out" : `failed (exit ${code})`}${line ? `: ${line}` : ""}; ${pointer}; fix the cause it names, then resume`, options.timedOut ? 124 : code);
}

/** Child output reaches an exception only as a classified cause or one filtered, scrubbed line:
 * provider output may contain secrets. */
export const run: Run = (argv, cwd, env = process.env, timeoutMs = 120_000, input) => new Promise((resolve, reject) => {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {}); child.stdin.end(input);
  let output = "", stderr = "", bytes = 0, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  child.stdout.on("data", data => {
    bytes += data.length;
    if (bytes <= 32 * 1024 * 1024) output += data.toString();
    else child.kill("SIGKILL");
  });
  child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-64_000); });
  child.on("error", () => { clearTimeout(timer); reject(new CliError(`${argv[0]} could not start; check the installed tool and permissions`)); });
  child.on("close", code => {
    clearTimeout(timer);
    if (code !== 0 || bytes > 32 * 1024 * 1024) {
      let diagnostic = "";
      if (env.HG_TEAM_DIAGNOSTICS_DIR) {
        fs.mkdirSync(env.HG_TEAM_DIAGNOSTICS_DIR, { recursive: true, mode: 0o700 });
        diagnostic = path.join(env.HG_TEAM_DIAGNOSTICS_DIR, `${randomUUID()}.log`);
        fs.writeFileSync(diagnostic, scrub(stderr, secretValues(env, input)), { mode: 0o600 });
      }
      reject(childFailure(argv[0]!, code ?? 1, stderr, env, { ...(diagnostic ? { diagnostic } : {}), timedOut, argv, ...(input ? { input } : {}) }));
    }
    else resolve(output);
  });
});

export function gitEnvironment(token?: string): NodeJS.ProcessEnv {
  // No credential-bearing URL or argv. Disable interactive prompts and global helpers.
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: token ? "2" : "1",
    GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    ...(token ? { GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } : {}) };
}
