// Resolving a profile's runtime manifest OFFLINE (ADR-153).
//
// It reads exactly the value documents the ApplicationSet layers onto the
// chart - the record, the workspace values, the connection projection, or,
// for a bundled member, the bundle's values.yaml - and hands them to the
// pure builder in ./manifest.ts. No cluster, no network: `hg agent inspect`
// and `hg agent render` are safe in CI, and `hg agent prove` EVE022 has an
// independent second opinion to compare the pod's mounted copy against.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { EVE_RUNTIME_IMAGE, STAGING, VERSIONS, instanceNameOf, nsOf, type HgState, type ProfileCtx } from "../lib.ts";
import { bundleApplications } from "../platform/index.ts";
import {
  manifestFromBundle,
  manifestFromRecord,
  type AgentRecordValues,
  type BundleValues,
  type RuntimeManifest,
} from "./manifest.ts";

/** The default overlay root: the local loop's staging tree. A reconciled
 * environment keeps the same layout in the GitOps repository, so
 * `--gitops <clone>` points this at a checkout of it (the convention
 * `hg workspace verify` and `hg nexus install` already use). */
export function gitopsRoot(gitopsDir?: string): string {
  return gitopsDir ?? path.join(STAGING, "gitops");
}

function readYaml(file: string): Record<string, any> | null {
  if (!fs.existsSync(file)) return null;
  return (parseYaml(fs.readFileSync(file, "utf8")) as Record<string, any> | null) ?? null;
}

/** The runtime image an agent of this engine actually runs.
 *
 * versions.json is the pin (ADR-63) and a record's
 * `spec.deployment.runtimeImageTag` overrides the tag, exactly as the
 * chart does - EXCEPT in the local loop, where `hg up` passes the
 * locally-built `eve-runtime:hermes-gitops-dev` to the release as a
 * valuesObject (platform.ts). The manifest must say what runs, not what
 * would run somewhere else, so the local override wins here too. `state`
 * absent (a `--gitops` clone of a real environment) means no override. */
export function runtimeImageOf(runtime: string, tagOverride?: string, local = false): string {
  if (runtime !== "eve") return "";
  if (local) return EVE_RUNTIME_IMAGE;
  const eve = VERSIONS.runtimes?.eve;
  if (!eve) return "";
  return `${eve.imageRepository}:${tagOverride ?? eve.version}`;
}

export interface ResolvedManifest {
  manifest: RuntimeManifest;
  /** The files it was built from, in layering order - printed by
   * `hg agent inspect` so a surprising manifest is traceable to a document
   * rather than to this code. */
  sources: string[];
}

/** Resolve one profile's runtime manifest from the emitted overlay.
 *
 * Returns null when the profile has no record yet (nothing has been
 * emitted for it) - the caller reports that as "not rendered", never as an
 * empty manifest, which would read as "deployed with nothing". */
export function resolveRuntimeManifest(
  state: HgState,
  ctx: ProfileCtx,
  gitopsDir?: string,
): ResolvedManifest | null {
  const root = gitopsRoot(gitopsDir);
  // The local loop is "this staging tree, this cluster": an explicit
  // --gitops clone is somebody else's environment and gets the pinned
  // image, not this box's dev build.
  const local = !gitopsDir && !!state.ports;
  const bundle = bundleApplications(state).find((b) => b.profiles.includes(ctx.name));

  if (bundle) {
    const file = path.join(root, "deployments", "bundles", bundle.name, "values.yaml");
    const doc = readYaml(file);
    const values = (doc?.spec ?? null) as BundleValues | null;
    if (!values) return null;
    const member = (values.profiles ?? []).find((p) => p.name === ctx.name);
    const manifest = manifestFromBundle(values, ctx.name, {
      instance: `${bundle.application}-${ctx.name}`,
      namespace: bundle.namespace,
      runtimeImage: runtimeImageOf(values.runtime ?? ctx.runtime, undefined, local),
    });
    if (!manifest || !member) return null;
    return { manifest, sources: [path.relative(root, file)] };
  }

  const recordFile = path.join(root, "profiles", ctx.name, "profile.yaml");
  const record = (readYaml(recordFile)?.spec ?? null) as AgentRecordValues | null;
  if (!record) return null;
  const sources = [path.relative(root, recordFile)];

  // The two overlays the agents ApplicationSet layers over the record.
  const wsFile = path.join(root, "deployments", "workspaces", "profiles", `${ctx.name}.yaml`);
  const ws = readYaml(wsFile);
  if (ws?.spec?.workspace) {
    record.workspace = ws.spec.workspace;
    sources.push(path.relative(root, wsFile));
  }
  const connFile = path.join(root, "deployments", "connections", "profiles", `${ctx.name}.yaml`);
  const conn = readYaml(connFile);
  if (conn?.spec?.connections) {
    record.connections = conn.spec.connections;
    sources.push(path.relative(root, connFile));
  }

  const manifest = manifestFromRecord(record, {
    name: ctx.name,
    instance: instanceNameOf(ctx.name, ctx.runtime),
    namespace: nsOf(ctx.name),
    runtimeImage: runtimeImageOf(record.runtime ?? ctx.runtime, record.deployment?.runtimeImageTag, local),
  });
  return { manifest, sources };
}
