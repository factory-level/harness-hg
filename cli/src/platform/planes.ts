// The plane convention (#660, ADR 0164), read from control-plane/planes.yaml
// - the same data the plane-label test asserts against, so the CLI and the
// gates cannot disagree about which namespaces are control plane.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_ROOT } from "../lib.ts";

export interface PlaneConvention {
  labels: { plane: string; component: string };
  controlPlaneNamespaces: string[];
  controlPlaneNamespacePrefixes: string[];
  workloadNamespacePrefixes: string[];
}

let cached: PlaneConvention | null = null;
export function planeConvention(): PlaneConvention {
  if (!cached) {
    cached = parseYaml(
      fs.readFileSync(path.join(PLATFORM_ROOT, "control-plane", "planes.yaml"), "utf8"),
    ) as PlaneConvention;
  }
  return cached;
}

/** Whether a namespace belongs to the control plane. A declaration must
 * never land an agent in one (PLANE001). */
export function isControlPlaneNamespace(ns: string): boolean {
  const c = planeConvention();
  return c.controlPlaneNamespaces.includes(ns) || c.controlPlaneNamespacePrefixes.some((p) => ns.startsWith(p));
}
