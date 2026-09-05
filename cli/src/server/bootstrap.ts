// `hg server` - the destination-server verbs (design 18): preflight a
// clean Linux host over ssh, then bootstrap it from pinned repository-owned
// automation. Nothing here talks to a cluster; it prepares the machine the
// cluster will run on. The one root step (k3s) uses the VENDORED upstream
// installer at infra/scripts/server/vendor/k3s-install.sh, verified against
// versions.json before it runs - never `curl | sh` of a moving script.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import versions from "../../../versions.json" with { type: "json" };
import { CliError, PLATFORM_ROOT, jsonOut, log, ok, warn } from "../lib.ts";
import { getObject, latestVerification, listBackupIds, sinkFromUrl, type GcsSink } from "../backup/gcs-sink.ts";
import { emitLifecycleEvent, registerEnvironment } from "../communication/lifecycle-events.ts";
import type { ProofFinding, ProofResult } from "../backup/platform.ts";

export const DEFAULT_SYNC_ROOT = "/mnt/ssd/hermes-gitops";
const SERVER_SCRIPTS = path.join(PLATFORM_ROOT, "infra", "scripts", "server");

// Minimums for the reference deployment (fable §5.1 sizing is "measure and
// document"; these are the floor the marketing fleet actually needs).
const MIN_CPUS = 4;
const MIN_MEM_KB = 8 * 1024 * 1024;
const MIN_SYNC_AVAIL_KB = 50 * 1024 * 1024;

export interface SshRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command on the host over ssh (BatchMode - never prompts).
 *
 * ssh JOINS its command args with spaces and hands the remote shell one
 * string to re-split - so `["bash", "-c", "a && b"]` reaches bash as
 * `-c a` (&& b becomes $0 args) and every compound command silently
 * truncates to its first word. Each element is single-quoted here so
 * the remote shell sees exactly the argv the caller wrote. Environment
 * prefixes must use `env` (`["env", "K=V", "cmd"]`): a quoted
 * assignment is a command word, not an assignment. */
export function sshRun(host: string, cmd: string[], opts: { input?: string } = {}): SshRunResult {
  const remote = cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const proc = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, remote], {
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

export function parseFacts(raw: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) facts[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return facts;
}

/** Pure evaluation of preflight facts -> SRV00x findings (tested). */
export function evaluatePreflight(
  facts: Record<string, string>,
  opts: { backendUrl: string | null; allowLocalState: boolean },
): ProofFinding[] {
  const f: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    f.push({ id, status, component, message });

  const os = `${facts["os_id"]} ${facts["os_version"]}`;
  if (facts["os_id"] === "ubuntu" && (facts["os_version"] ?? "").startsWith("24.04") && facts["arch"] === "x86_64")
    add("SRV001", "pass", "os", `${os} ${facts["arch"]}`);
  else add("SRV001", "fail", "os", `unsupported: ${os} ${facts["arch"]} (need Ubuntu 24.04 x86_64)`);

  const cpus = Number(facts["nproc"] ?? 0);
  const memKb = Number(facts["mem_kb"] ?? 0);
  if (cpus >= MIN_CPUS && memKb >= MIN_MEM_KB)
    add("SRV002", "pass", "resources", `${cpus} cpus, ${Math.round(memKb / 1024 / 1024)}GiB memory`);
  else add("SRV002", "fail", "resources", `${cpus} cpus / ${memKb}kB memory below floor (${MIN_CPUS} cpus, 8GiB)`);

  const availKb = Number(facts["sync_avail_kb"] ?? 0);
  if (facts["sync_parent_exists"] !== "yes")
    add("SRV003", "fail", "sync-root", "sync-root parent mount is missing");
  else if (facts["sync_dev"] === facts["root_dev"])
    add("SRV003", "fail", "sync-root", `sync root shares the root device ${facts["root_dev"]} - design 18 requires a separate disk`);
  else if (availKb < MIN_SYNC_AVAIL_KB)
    add("SRV003", "fail", "sync-root", `only ${Math.round(availKb / 1024 / 1024)}GiB free on ${facts["sync_dev"]} (need 50GiB)`);
  else add("SRV003", "pass", "sync-root", `${facts["sync_dev"]}, ${Math.round(availKb / 1024 / 1024)}GiB free`);

  const reach = ["reach_github", "reach_gcs", "reach_discord"].map((k) => [k, facts[k] ?? "000"] as const);
  const unreachable = reach.filter(([, code]) => code === "000");
  if (facts["dns_ok"] !== "yes") add("SRV004", "fail", "network", "DNS resolution failed (github.com)");
  else if (unreachable.length > 0)
    add("SRV004", "fail", "network", `unreachable: ${unreachable.map(([k]) => k.replace("reach_", "")).join(", ")}`);
  else add("SRV004", "pass", "network", `github ${facts["reach_github"]}, gcs ${facts["reach_gcs"]}, discord ${facts["reach_discord"]}`);

  if (facts["ntp_synced"] === "yes") add("SRV005", "pass", "time", "NTP synchronized");
  else add("SRV005", "fail", "time", `NTP not synchronized (${facts["ntp_synced"]})`);

  const conflicts = ["kubeadm", "minikube"].filter((t) => facts[`present_${t}`] === "yes");
  const k3sPresent = facts["present_k3s"] === "yes";
  const k3sMatches = facts["k3s_version"] === versions.host.k3s;
  if (conflicts.length > 0)
    add("SRV006", "fail", "cluster", `conflicting cluster software installed: ${conflicts.join(", ")}`);
  else if (k3sPresent && !k3sMatches)
    add("SRV006", "fail", "cluster", `k3s ${facts["k3s_version"]} installed but the pin is ${versions.host.k3s}`);
  else if (!k3sPresent && facts["port_6443"] === "busy")
    add("SRV006", "fail", "cluster", "port 6443 is in use by something that is not k3s");
  else add("SRV006", "pass", "cluster", k3sPresent ? `k3s ${versions.host.k3s} already installed` : "no cluster software, port 6443 free");

  if (facts["sudo_nopasswd"] === "yes") add("SRV007", "pass", "sudo", "passwordless sudo available");
  else
    add("SRV007", "unknown", "sudo",
      "sudo needs a password - the k3s install/uninstall steps will print the one command to run interactively");

  if (opts.backendUrl?.startsWith("gs://"))
    add("SRV008", "pass", "pulumi-state", `remote backend ${opts.backendUrl}`);
  else if (opts.allowLocalState)
    add("SRV008", "unknown", "pulumi-state", `local backend ${opts.backendUrl ?? "none"} allowed by --allow-local-state (local loop only)`);
  else
    add("SRV008", "fail", "pulumi-state",
      `pulumi backend is ${opts.backendUrl ?? "not logged in"} - a destination server requires remote state ` +
        "(pulumi login gs://...); pass --allow-local-state only for the local loop");

  return f;
}

function proofResult(command: string, startedAt: string, findings: ProofFinding[]): ProofResult {
  const summary = {
    pass: findings.filter((x) => x.status === "pass").length,
    fail: findings.filter((x) => x.status === "fail").length,
    unknown: findings.filter((x) => x.status === "unknown").length,
  };
  return {
    apiVersion: "cli.hermes.dev/v1alpha1",
    kind: "ProofResult",
    command,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: summary.fail === 0,
    findings,
    summary,
  };
}

function pulumiBackendUrl(): string | null {
  const proc = Bun.spawnSync(["pulumi", "whoami", "--json"], { stdout: "pipe", stderr: "pipe" });
  if ((proc.exitCode ?? 1) !== 0) return null;
  try {
    const parsed = JSON.parse(proc.stdout.toString()) as { url?: string };
    return parsed.url ?? null;
  } catch {
    return null;
  }
}

export interface ServerOpts {
  syncRoot: string;
  allowLocalState: boolean;
}

export function runPreflight(host: string, opts: ServerOpts): ProofResult {
  const startedAt = new Date().toISOString();
  const script = fs.readFileSync(path.join(SERVER_SCRIPTS, "preflight.sh"), "utf8");
  const res = sshRun(host, ["env", `SYNC_ROOT=${opts.syncRoot}`, "bash", "-s"], { input: script });
  if (res.code !== 0) {
    return proofResult("server preflight", startedAt, [
      { id: "SRV000", status: "fail", component: "ssh", message: `cannot run preflight on ${host}: ${res.stderr.trim() || res.stdout.trim()}` },
    ]);
  }
  const findings = evaluatePreflight(parseFacts(res.stdout), {
    backendUrl: pulumiBackendUrl(),
    allowLocalState: opts.allowLocalState,
  });
  return proofResult("server preflight", startedAt, findings);
}

/** The vendored installer, verified against versions.json BEFORE use. */
function vendoredK3sInstaller(): string {
  const p = path.join(SERVER_SCRIPTS, "vendor", "k3s-install.sh");
  const body = fs.readFileSync(p);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  if (digest !== versions.host.k3sInstallerSha256)
    throw new CliError(
      `vendored k3s installer checksum mismatch (${digest}) - refresh versions.json k3sInstallerSha256 deliberately or restore the file`,
    );
  return body.toString("utf8");
}

export interface ServerIdentity {
  serverId: string;
  bootstrappedAt: string;
}

export function runBootstrap(host: string, opts: ServerOpts): ServerIdentity {
  const proof = runPreflight(host, opts);
  for (const finding of proof.findings)
    (finding.status === "fail" ? warn : log)(`${finding.id} ${finding.status}: ${finding.message}`);
  if (!proof.ok) throw new CliError("preflight failed - fix the findings above, then rerun");
  const facts = parseFacts(sshRun(host, ["env", `SYNC_ROOT=${opts.syncRoot}`, "bash", "-s"], {
    input: fs.readFileSync(path.join(SERVER_SCRIPTS, "preflight.sh"), "utf8"),
  }).stdout);

  // 1. The sync root's owned directories (design 18 layout).
  const mk = sshRun(host, ["mkdir", "-p",
    ...["checkout", "state", "logs", "backups", "serve-git", "env"].map((d) => `${opts.syncRoot}/${d}`)]);
  if (mk.code !== 0) throw new CliError(`cannot create the sync root layout: ${mk.stderr.trim()}`);

  // 2. Unprivileged pinned tools.
  log(`installing pinned tools (kubectl ${versions.host.kubectl}, helm ${versions.host.helm}, bun ${versions.host.bun}, uv ${versions.host.uv})`);
  const pins = [
    `KUBECTL_VERSION=${versions.host.kubectl}`, `KUBECTL_SHA256=${versions.host.kubectlSha256}`,
    `HELM_VERSION=${versions.host.helm}`, `HELM_SHA256=${versions.host.helmSha256}`,
    `BUN_VERSION=${versions.host.bun}`, `BUN_SHA256=${versions.host.bunSha256}`,
    `BUN_BASELINE_SHA256=${versions.host.bunBaselineSha256}`,
    `UV_VERSION=${versions.host.uv}`, `UV_SHA256=${versions.host.uvSha256}`,
    `PULUMI_VERSION=${versions.host.pulumi}`, `PULUMI_SHA512=${versions.host.pulumiSha512}`,
    `GCLOUD_VERSION=${versions.host.gcloud}`, `GCLOUD_SHA256=${versions.host.gcloudSha256}`,
  ];
  const inst = sshRun(host, ["env", ...pins, "bash", "-s"], {
    input: fs.readFileSync(path.join(SERVER_SCRIPTS, "install-pinned.sh"), "utf8"),
  });
  if (inst.code !== 0) throw new CliError(`pinned tool install failed:\n${inst.stderr.trim()}`);

  // 3. k3s - the one root step, from the VENDORED installer.
  // The freshly-collected preflight facts already carry the k3s version -
  // a second ad-hoc probe through ssh's argument flattening is how a
  // quoting bug once made an installed k3s read as absent (bash -c saw
  // only `echo`).
  if (facts["k3s_version"] === versions.host.k3s) {
    ok(`k3s ${versions.host.k3s} already installed`);
  } else {
    // The pins are BAKED into the staged copy: a narrow sudoers rule
    // permits `sh /tmp/hg-k3s-install.sh` verbatim, and a `sudo env`
    // wrapper would fall outside it.
    const installer =
      `#!/bin/sh\nexport INSTALL_K3S_VERSION='${versions.host.k3s}'\n` +
      `export INSTALL_K3S_EXEC='--write-kubeconfig-mode 644 --disable traefik'\n` +
      vendoredK3sInstaller();
    const put = sshRun(host, ["bash", "-c", "cat > /tmp/hg-k3s-install.sh && chmod +x /tmp/hg-k3s-install.sh"], { input: installer });
    if (put.code !== 0) throw new CliError(`cannot stage the k3s installer: ${put.stderr.trim()}`);
    const sudoCmd = `sh /tmp/hg-k3s-install.sh`;
    const scopedSudo = sshRun(host, ["sudo", "-n", "-l", "--", "/usr/bin/sh", "/tmp/hg-k3s-install.sh"]).code === 0;
    if (facts["sudo_nopasswd"] === "yes" || scopedSudo) {
      log(`installing k3s ${versions.host.k3s} (root step)`);
      const k3s = sshRun(host, ["sudo", "-n", "/usr/bin/sh", "/tmp/hg-k3s-install.sh"]);
      if (k3s.code !== 0) throw new CliError(`k3s install failed:\n${k3s.stderr.trim()}`);
    } else {
      throw new CliError(
        `sudo needs a password on ${host}. Run the one root step yourself, then rerun bootstrap:\n` +
          `  ssh -t ${host} "sudo ${sudoCmd}"`,
      );
    }
  }

  // 3b. The `hg` shim: reconciler checks and operator sessions invoke
  // plain `hg`, which only exists as a bun bin in the plugin checkout -
  // a check string that works on every dev machine failed on the first
  // real server (command not found, commit blocked).
  const shim = `#!/bin/sh\nexec "$HOME/.local/bin/bun" "${opts.syncRoot}/plugin/cli/src/main.ts" "$@"\n`;
  const sh = sshRun(host, ["bash", "-c", "cat > ~/.local/bin/hg && chmod +x ~/.local/bin/hg"], { input: shim });
  if (sh.code !== 0) throw new CliError(`cannot write the hg shim: ${sh.stderr.trim()}`);

  // 4. Kubeconfig for the unprivileged user (mode 644 was set above).
  const kc = sshRun(host, ["bash", "-c", "mkdir -p ~/.kube && cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && chmod 600 ~/.kube/config"]);
  if (kc.code !== 0) throw new CliError(`cannot place the kubeconfig: ${kc.stderr.trim()}`);

  // 3c. Traefik, ClusterIP-only. k3s installs with --disable traefik
  // because its bundled variant ships a LoadBalancer + svclb host ports
  // (80/443 on the machine - the tunnel-only inbound posture broken by
  // default, found by edge prove). The agents' tunnel origins route
  // through traefik as the in-cluster Ingress, so the platform applies
  // the SAME bundled chart back with a ClusterIP service.
  const traefikChart = `# Applied by hg server bootstrap - the platform's ClusterIP traefik.
# The CRD chart FIRST: --disable traefik disables BOTH bundled manifests,
# and the app chart's install job crash-loops until the CRDs exist
# (found live: 176 restarts over 14 unattended hours on server B).
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: traefik-crd
  namespace: kube-system
spec:
  chart: https://%{KUBERNETES_API}%/static/charts/${versions.host.k3sTraefikCrdChart}
  targetNamespace: kube-system
---
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: traefik
  namespace: kube-system
spec:
  chart: https://%{KUBERNETES_API}%/static/charts/${versions.host.k3sTraefikChart}
  targetNamespace: kube-system
  valuesContent: |-
    # The official image: rancher's mirror lags tags (v3.6.12 was absent
    # the day this ran), and only a live k3s has the embedded copy.
    image:
      registry: docker.io
      repository: traefik
    service:
      type: ClusterIP
    # A ClusterIP traefik publishes nothing into Ingress status, and
    # Argo scores a statusless Ingress Progressing FOREVER - the fleet
    # sat at Progressing with every pod green (found live, server B).
    # Chart 39.x has no ingressEndpoint VALUE (silently ignored - also
    # found live): publishedService copies status from the ClusterIP
    # service, which has none, so turn it off and set the static
    # endpoint flag directly.
    providers:
      kubernetesIngress:
        publishedService:
          enabled: false
    additionalArguments:
      - "--providers.kubernetesingress.ingressendpoint.hostname=traefik.kube-system.svc"
    priorityClassName: system-cluster-critical
    tolerations:
      - key: CriticalAddonsOnly
        operator: Exists
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      - key: node-role.kubernetes.io/master
        operator: Exists
        effect: NoSchedule
`;
  const remoteUser = host.includes("@") ? host.split("@")[0] : "root";
  // A just-installed k3s registers the HelmChart CRD asynchronously; an
  // immediate apply loses the race (openapi 404, found live at the first
  // unattended reinstall). Bounded wait, then apply.
  for (let i = 0; i < 30; i++) {
    const crd = sshRun(host, [
      "env", `PATH=/home/${remoteUser}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      "kubectl", "get", "crd", "helmcharts.helm.cattle.io", "-o", "name",
    ]);
    if (crd.code === 0 && crd.stdout.trim()) break;
    sshRun(host, ["sleep", "5"]);
  }
  const tf = sshRun(host, [
    "env", `PATH=/home/${remoteUser}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    // --validate=false: right after a k3s (re)install the aggregated
    // openapi for helm.cattle.io lags the CRD itself and client-side
    // validation 404s; admission still validates server-side.
    "kubectl", "apply", "--validate=false", "-f", "-",
  ], { input: traefikChart });
  if (tf.code !== 0) throw new CliError(`cannot apply the ClusterIP traefik chart: ${tf.stderr.trim()}`);

  // 5. Server identity: written once; destroy removes it, so the next
  // bootstrap of the same machine IS a new server identity.
  const idPath = `${opts.syncRoot}/server-id`;
  const existing = sshRun(host, ["cat", idPath]);
  if (existing.code === 0 && existing.stdout.trim()) {
    const identity = JSON.parse(existing.stdout) as ServerIdentity;
    ok(`server identity ${identity.serverId} (bootstrapped ${identity.bootstrappedAt})`);
    return identity;
  }
  const identity: ServerIdentity = { serverId: crypto.randomUUID(), bootstrappedAt: new Date().toISOString() };
  const wr = sshRun(host, ["bash", "-c", `cat > ${idPath}`], { input: JSON.stringify(identity, null, 2) + "\n" });
  if (wr.code !== 0) throw new CliError(`cannot write ${idPath}: ${wr.stderr.trim()}`);
  ok(`server identity ${identity.serverId} written to ${idPath}`);
  return identity;
}

// ---------------------------------------------------------------------------
// hg server destroy (Fable 1 §25-27, ADR-66). Hermes-scoped, always:
// a destination server may be shared with workloads that are none of this
// platform's business, so the deletion set is an explicit allowlist a
// test can check for containment - never a glob at the root, never the
// disks, never the machine.

/** The systemd user units the platform installs on a destination server. */
export const HERMES_USER_UNITS = [
  "hermes-reconcile.service", "hermes-reconcile.timer",
  "hermes-platform-backup.service", "hermes-platform-backup.timer",
  "hermes-restore-verify.service", "hermes-restore-verify.timer",
];

/** Everything destroy deletes, as absolute paths on the host. Pure - the
 * containment test asserts every path is under the sync root or is one
 * of the two named user files (kubeconfig, unit files are handled by
 * systemd disable + rm in their own dir). env/ IS in scope: cached
 * credentials on the doomed machine must not survive to quietly satisfy
 * the restore test (design 13). */
export function destroyScope(syncRoot: string): string[] {
  const owned = ["checkout", "state", "logs", "backups", "serve-git", "env", "reconcile", "server-id"];
  return owned.map((d) => `${syncRoot}/${d}`);
}

/** The sink's verdict on a backup: the manifest's verification, overlaid
 * by the newest append-only verification object. Reads ONLY the manifest
 * (never the archives) with the reader identity - the gate must not need
 * the doomed server, and must not trust its disk. */
export function sinkVerificationState(sink: GcsSink, backupId: string): { state: string; restoredAt?: string } {
  const ids = listBackupIds(sink);
  if (!ids.includes(backupId)) {
    throw new CliError(`backup ${backupId} is not in gs://${sink.bucket} (have: ${ids.join(", ") || "none"})`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-destroy-gate-"));
  try {
    const local = path.join(tmp, "manifest.json");
    getObject(sink, [sink.prefix, "backups", backupId, "manifest.json"].filter(Boolean).join("/"), local);
    const manifest = JSON.parse(fs.readFileSync(local, "utf8")) as { verification?: { state?: string; restoredAt?: string } };
    const merged = latestVerification(sink, backupId) ?? manifest.verification;
    return { state: merged?.state ?? "unknown", ...(merged?.restoredAt ? { restoredAt: merged.restoredAt } : {}) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface DestroyArgs {
  backupId: string;
  sinkUrl: string;
  nuclear: boolean;
  environment: string;
}

export async function runDestroy(host: string, opts: ServerOpts, args: DestroyArgs): Promise<ProofResult> {
  const startedAt = new Date().toISOString();
  const scope = destroyScope(opts.syncRoot);
  const scopeList = [...HERMES_USER_UNITS.map((u) => `~/.config/systemd/user/${u}`), "k3s (k3s-uninstall.sh)", ...scope, "~/.kube/config"];

  // 1. The backup gate - unconditional, from the SINK, with the reader.
  // An optional safety gate is not a gate, and the doomed server's disk
  // saying "restorable" proves nothing once the disk is gone.
  const sink: GcsSink = { ...sinkFromUrl(args.sinkUrl), impersonate: process.env["HG_RESTORE_READER_SA"] };
  const verification = sinkVerificationState(sink, args.backupId);
  if (verification.state !== "restorable") {
    throw new CliError(
      `backup ${args.backupId} is ${JSON.stringify(verification.state)} in the sink - destruction requires ` +
        "a RESTORABLE backup (run: hg platform verify-restore --sink " + args.sinkUrl + ")",
    );
  }
  ok(`gate: ${args.backupId} is restorable (verified ${verification.restoredAt ?? "unknown"})`);

  // 2. Consent - the same spelling hg reset uses for its destructive tier.
  if (!args.nuclear) {
    console.error("hg server destroy would remove, on " + host + ":");
    for (const item of scopeList) console.error(`  - ${item}`);
    console.error("and NOTHING else (the docker fleet and both disks stay). Rerun with --nuclear to consent.");
    throw new CliError("refusing without --nuclear");
  }

  // 3. The approval trail, then the act.
  await emitLifecycleEvent({
    kind: "approval", phase: "started", environment: args.environment,
    facts: { operation: "server destroy", host, backupId: args.backupId, scope: `${scopeList.length} items, Harness Hg-scoped` },
  });
  await emitLifecycleEvent({
    kind: "destroy", phase: "started", environment: args.environment,
    facts: { host, backupId: args.backupId },
  });

  const findings: ProofFinding[] = [];
  const add = (id: string, status: ProofFinding["status"], component: string, message: string) =>
    findings.push({ id, status, component, message });
  try {
    // Timers first - a tick firing mid-destruction would fight it.
    sshRun(host, ["systemctl", "--user", "disable", "--now", ...HERMES_USER_UNITS.filter((u) => u.endsWith(".timer"))]);
    sshRun(host, ["bash", "-c", `cd ~/.config/systemd/user 2>/dev/null && rm -f ${HERMES_USER_UNITS.join(" ")}; systemctl --user daemon-reload`]);

    // k3s - the one root step, mirrored from bootstrap.
    const hasK3s = sshRun(host, ["bash", "-c", "test -x /usr/local/bin/k3s-uninstall.sh && echo yes || echo no"]).stdout.trim();
    if (hasK3s === "yes") {
      // Probe the EXACT command the narrow sudoers rule permits -
      // `sudo -n true` fails under a scoped NOPASSWD entry and read a
      // fully-authorized host as unauthorized (found live at the gate).
      const sudoOk = sshRun(host, ["sudo", "-n", "-l", "--", "/usr/local/bin/k3s-uninstall.sh"]).code === 0;
      if (!sudoOk) {
        throw new CliError(
          `sudo needs a password on ${host}. Run the one root step yourself, then rerun destroy:\n` +
            `  ssh -t ${host} "sudo /usr/local/bin/k3s-uninstall.sh"`,
        );
      }
      log("uninstalling k3s (root step)");
      const un = sshRun(host, ["sudo", "-n", "/usr/local/bin/k3s-uninstall.sh"]);
      if (un.code !== 0) throw new CliError(`k3s-uninstall failed:\n${un.stderr.trim()}`);
    }

    // The sync root's owned entries - the allowlist, nothing else.
    const rm = sshRun(host, ["rm", "-rf", ...scope]);
    if (rm.code !== 0) throw new CliError(`sync-root wipe failed: ${rm.stderr.trim()}`);
    sshRun(host, ["rm", "-f", ".kube/config"]);

    // 4. Verification - DSTR001..005.
    const port = sshRun(host, ["bash", "-c", "ss -tln 2>/dev/null | awk '{print $4}' | grep -q ':6443$' && echo busy || echo free"]);
    add("DSTR001", port.stdout.trim() === "free" ? "pass" : "fail", "cluster", `port 6443 ${port.stdout.trim()}`);
    const k3sGone = sshRun(host, ["bash", "-c", "command -v k3s >/dev/null 2>&1 && echo present || echo absent"]);
    add("DSTR002", k3sGone.stdout.trim() === "absent" ? "pass" : "fail", "cluster", `k3s binary ${k3sGone.stdout.trim()}`);
    const left = sshRun(host, ["bash", "-c", `ls ${opts.syncRoot} 2>/dev/null | grep -xE '${["checkout", "state", "logs", "backups", "serve-git", "env", "reconcile", "server-id"].join("|")}' | tr '\\n' ' '`]);
    add("DSTR003", left.stdout.trim() === "" ? "pass" : "fail", "sync-root",
      left.stdout.trim() === "" ? "no owned entries remain" : `remains: ${left.stdout.trim()}`);
    const units = sshRun(host, ["bash", "-c", `ls ~/.config/systemd/user 2>/dev/null | grep -c '^hermes-' || true`]);
    add("DSTR004", units.stdout.trim() === "0" ? "pass" : "fail", "timers", `${units.stdout.trim()} hermes-* unit(s) remain`);
    const kube = sshRun(host, ["bash", "-c", "test -e .kube/config && echo present || echo absent"]);
    add("DSTR006", kube.stdout.trim() === "absent" ? "pass" : "fail", "kubeconfig", `~/.kube/config ${kube.stdout.trim()}`);
    // The backup outlives the machine - re-read from HERE, not the host.
    try {
      const after = sinkVerificationState(sink, args.backupId);
      add("DSTR005", after.state === "restorable" ? "pass" : "fail", "backup",
        `${args.backupId} still ${after.state} in gs://${sink.bucket} (read with the reader identity)`);
    } catch (err) {
      add("DSTR005", "fail", "backup", (err as Error).message);
    }
  } catch (err) {
    await emitLifecycleEvent({
      kind: "destroy", phase: "failed", environment: args.environment,
      facts: { host, error: err instanceof CliError ? err.message.slice(0, 200) : "unexpected error" },
    });
    throw err;
  }

  const summary = {
    pass: findings.filter((f) => f.status === "pass").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };
  const proof: ProofResult = {
    apiVersion: "cli.hermes.dev/v1alpha1", kind: "ProofResult", command: "server destroy",
    startedAt, finishedAt: new Date().toISOString(), ok: summary.fail === 0, findings, summary,
  };
  await emitLifecycleEvent({
    kind: "destroy", phase: proof.ok ? "completed" : "failed", environment: args.environment,
    facts: { host, backupId: args.backupId, verified: `${summary.pass}/${findings.length} checks` },
  });
  return proof;
}

export async function cmdServer(sub: string | undefined, json: boolean, flags: {
  host?: string;
  syncRoot?: string;
  allowLocalState: boolean;
  channel?: string;
  role?: string;
  environment?: string;
  backup?: string;
  sink?: string;
  nuclear: boolean;
}): Promise<void> {
  // `register` talks to Discord, not to a host - no --host needed.
  if (sub === "register") {
    if (!flags.channel) throw new CliError("server register needs --channel <discord-channel-id>");
    const registration = await registerEnvironment({
      environment: flags.environment ?? "factory",
      channelId: flags.channel,
      ...(flags.role ? { roleId: flags.role } : {}),
      facts: { syncRoot: flags.syncRoot ?? DEFAULT_SYNC_ROOT, k3s: versions.host.k3s },
    });
    if (json) jsonOut(registration);
    return;
  }
  const host = flags.host;
  if (!host) throw new CliError("--host <user@host> is required");
  const opts: ServerOpts = {
    syncRoot: flags.syncRoot ?? DEFAULT_SYNC_ROOT,
    allowLocalState: flags.allowLocalState,
  };
  switch (sub) {
    case "preflight": {
      const proof = runPreflight(host, opts);
      if (json) jsonOut(proof);
      else
        for (const finding of proof.findings)
          (finding.status === "fail" ? warn : log)(`${finding.id} ${finding.status}: ${finding.component} - ${finding.message}`);
      if (!proof.ok) process.exitCode = 1;
      break;
    }
    case "bootstrap": {
      await emitLifecycleEvent({ kind: "bootstrap", phase: "started", environment: flags.environment ?? "", facts: { host } });
      try {
        const identity = runBootstrap(host, opts);
        await emitLifecycleEvent({
          kind: "bootstrap", phase: "completed", environment: flags.environment ?? "",
          facts: { host, serverId: identity.serverId, k3s: versions.host.k3s },
        });
        if (json) jsonOut({ host, syncRoot: opts.syncRoot, ...identity, versions: versions.host });
        else ok(`server ${host} bootstrapped (identity ${identity.serverId})`);
      } catch (err) {
        await emitLifecycleEvent({
          kind: "bootstrap", phase: "failed", environment: flags.environment ?? "",
          facts: { host, error: err instanceof CliError ? err.message.slice(0, 200) : "unexpected error" },
        });
        throw err;
      }
      break;
    }
    case "destroy": {
      if (!flags.backup || !flags.sink) {
        throw new CliError("server destroy needs --backup <backup-id> and --sink gs://... (the gate reads the SINK, never the host)");
      }
      const proof = await runDestroy(host, opts, {
        backupId: flags.backup,
        sinkUrl: flags.sink,
        nuclear: flags.nuclear,
        environment: flags.environment ?? "factory",
      });
      if (json) jsonOut(proof);
      else
        for (const finding of proof.findings)
          (finding.status === "fail" ? warn : log)(`${finding.id} ${finding.status}: ${finding.component} - ${finding.message}`);
      if (!proof.ok) process.exitCode = 1;
      else ok(`server ${host} destroyed (Harness Hg scope only) - backup ${flags.backup} remains readable`);
      break;
    }
    default:
      throw new CliError(`unknown server subcommand: ${sub ?? "(none)"} (preflight | bootstrap | register | destroy)`);
  }
}
