// A local OCI registry for persona charts (#302's local emulation).
//
// Persona-owned application charts are published as OCI artifacts to a
// PRIVATE registry (ADR-31: app charts live in the persona repo, never
// the platform repo). On the local loop nothing can pull them - Argo CD
// gets a 403 from ghcr, the Application sits `Unknown / Healthy`, and
// the app has simply never deployed while looking fine on a list.
//
// So the loop serves its own. `registry:2` on the k3d docker network,
// reachable from BOTH sides at the host-gateway address - the same
// property the Dex issuer needs and for the same reason: charts are
// pushed from this host and pulled from inside the cluster, and one
// address has to satisfy both.
//
// This is an EMULATION, deliberately. It proves the chart renders,
// deploys, and provisions what it claims - everything except whether a
// real registry would let us in. That last part stays #302.

import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, CLUSTER_NAME, HG_HOME, log, ok, sh, STAGING, type HgState } from "../lib.ts";

// The default loop keeps the bare name it has always had; an isolated loop
// (HG_CLUSTER_NAME) gets its own container so `docker rm -f` below cannot
// kill the other loop's registry.
export const REGISTRY_CONTAINER = CLUSTER_NAME === "hermes-gitops-cli" ? "hg-oci-registry" : `hg-oci-registry-${CLUSTER_NAME}`;
const K3D_NETWORK = `k3d-${CLUSTER_NAME}`;

export function registryHost(state: HgState): string {
  return `${state.gatewayIp}:${state.ports!.registry}`;
}

/** Where persona charts land: one repository namespace, matching the
 * `charts/` path every persona repo publishes under. */
export function registryRepo(state: HgState): string {
  return `oci://${registryHost(state)}/charts`;
}

/** A self-signed cert for the gateway IP.
 *
 * Not decoration: Argo CD pulls OCI charts with
 * `--insecure-skip-tls-verify`, which skips VERIFICATION and still
 * speaks TLS - so a plain-HTTP registry fails with "server gave HTTP
 * response to HTTPS client" no matter how insecure the client is willing
 * to be. Different flags for different problems, and the registry has to
 * be the one that moves.
 *
 * It also buys something real: every pull on this loop now exercises the
 * TLS path a published registry would use. */
export function ensureRegistryCert(state: HgState): string {
  const dir = path.join(HG_HOME, "registry-tls");
  fs.mkdirSync(dir, { recursive: true });
  const crt = path.join(dir, "tls.crt");
  const key = path.join(dir, "tls.key");
  if (fs.existsSync(crt) && fs.existsSync(key)) return dir;
  sh([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-days", "3650",
    "-keyout", key, "-out", crt,
    "-subj", "/CN=hg-oci-registry",
    // The IP SAN is the load-bearing part: the pull URL is an address,
    // not a name, and a cert without it fails before verification is
    // even skipped.
    "-addext", `subjectAltName=IP:${state.gatewayIp},DNS:localhost`,
  ], { quiet: true });
  fs.chmodSync(key, 0o600);
  return dir;
}

function containerRunning(): boolean {
  const out = sh(["docker", "ps", "--filter", `name=^${REGISTRY_CONTAINER}$`, "--format", "{{.Names}}"], {
    allowFail: true,
    quiet: true,
  });
  return out.trim() === REGISTRY_CONTAINER;
}

export function ensureRegistry(state: HgState): void {
  state.ports!.registry ??= 5111;
  const port = state.ports!.registry;
  if (containerRunning()) {
    ok(`oci registry up: ${registryHost(state)}`);
    return;
  }
  // Remove a stopped container of the same name; `docker run` would
  // otherwise fail on the name and read as "docker is broken".
  sh(["docker", "rm", "-f", REGISTRY_CONTAINER], { allowFail: true, quiet: true });
  const certDir = ensureRegistryCert(state);
  log(`starting the local OCI registry on ${registryHost(state)}...`);
  sh([
    "docker", "run", "-d", "--name", REGISTRY_CONTAINER,
    "--restart", "unless-stopped",
    // Bound to the host gateway interface only, never 0.0.0.0: the
    // cluster must reach it and the LAN must not.
    "-p", `${state.gatewayIp}:${port}:5000`,
    "--network", K3D_NETWORK,
    "-v", `${certDir}:/certs:ro`,
    "-e", "REGISTRY_HTTP_TLS_CERTIFICATE=/certs/tls.crt",
    "-e", "REGISTRY_HTTP_TLS_KEY=/certs/tls.key",
    "registry:2",
  ], { quiet: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = Bun.spawnSync(["curl", "-skf", "-m", "2", "-o", "/dev/null", `https://${registryHost(state)}/v2/`]);
    if ((probe.exitCode ?? 1) === 0) {
      ok(`oci registry up: ${registryHost(state)}`);
      return;
    }
    Bun.sleepSync(500);
  }
  throw new CliError(`the local OCI registry never answered on https://${registryHost(state)}/v2/`);
}

/** Package and push every chart under `<personaRepo>/charts/` at the
 * version the records ask for. Idempotent: a re-push of the same version
 * is what `helm push` already does, and re-running `up` must not need a
 * version bump. */
export function publishPersonaCharts(state: HgState, personaRepo: string, wanted: Map<string, string>): number {
  const chartsDir = path.join(personaRepo, "charts");
  if (!fs.existsSync(chartsDir)) return 0;
  const outDir = path.join(STAGING, "oci-charts");
  fs.mkdirSync(outDir, { recursive: true });
  let pushed = 0;
  for (const entry of fs.readdirSync(chartsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(chartsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "Chart.yaml"))) continue;
    const version = wanted.get(entry.name);
    if (!version) continue; // nothing in the fleet asks for this chart
    // Package AT the requested version rather than the chart's own: the
    // record pins a version, and a registry that holds a different one
    // fails at sync with a message about a missing tag rather than about
    // a version mismatch.
    sh(["helm", "package", dir, "--version", version, "-d", outDir], { quiet: true });
    // Skip VERIFICATION, not TLS: the registry serves a self-signed
    // cert precisely so Argo CD's own `--insecure-skip-tls-verify` pull
    // works unchanged (see ensureRegistryCert).
    sh([
      "helm", "push", path.join(outDir, `${entry.name}-${version}.tgz`),
      registryRepo(state), "--insecure-skip-tls-verify",
    ], { quiet: true });
    log(`published ${entry.name} ${version} -> ${registryRepo(state)}`);
    pushed += 1;
  }
  if (pushed > 0) {
    fs.writeFileSync(
      path.join(HG_HOME, "oci-registry.json"),
      `${JSON.stringify({ repo: registryRepo(state), charts: [...wanted] }, null, 2)}\n`,
    );
  }
  return pushed;
}

/** chart name -> pinned version, across every record in the fleet. The
 * records are the authority on what the cluster will ask for. */
export function chartsWantedBy(recordYamls: string[], parse: (y: string) => unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const yaml of recordYamls) {
    const rec = parse(yaml) as { spec?: { apps?: { chart?: string; repo?: string; version?: string }[] } };
    for (const app of rec.spec?.apps ?? []) {
      if (!app.repo?.startsWith("oci://") || !app.chart || !app.version) continue;
      out.set(app.chart, app.version);
    }
  }
  return out;
}

/** Rewrite oci:// app repos onto the local registry. LOCAL LOOP ONLY -
 * the emitted record keeps the real registry, and only what this host
 * applies is redirected, so nothing about the persona repository or the
 * published contract changes. */
export function redirectOciRepos(recordYaml: string, state: HgState, parse: (y: string) => any, stringify: (o: any) => string): string {
  const record = parse(recordYaml);
  let touched = false;
  for (const app of record?.spec?.apps ?? []) {
    if (typeof app.repo === "string" && app.repo.startsWith("oci://") && !app.repo.includes(registryHost(state))) {
      app.repo = registryRepo(state);
      touched = true;
    }
  }
  return touched ? stringify(record) : recordYaml;
}
