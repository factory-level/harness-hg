// #660 / ADR 0164: the plane convention as data, and PLANE001.

import { describe, expect, test } from "bun:test";
import { isControlPlaneNamespace, planeConvention } from "../src/platform/planes.ts";

describe("the plane convention (control-plane/planes.yaml)", () => {
  test("the known control-plane namespaces are recognized", () => {
    for (const ns of ["argocd", "external-secrets", "hermes-secrets", "hermes-system", "hermes-monitoring", "hermes-system-marketing"]) {
      expect(isControlPlaneNamespace(ns), ns).toBe(true);
    }
  });

  test("workload namespaces are not control plane", () => {
    for (const ns of ["hermes-support-agent", "ag-eve-vision-manager", "hermes-marketing-core"]) {
      expect(isControlPlaneNamespace(ns), ns).toBe(false);
    }
  });

  test("the collision that motivates PLANE001: a profile named `system`", () => {
    expect(isControlPlaneNamespace("hermes-system")).toBe(true);
  });

  test("the label keys are the documented scheme", () => {
    const c = planeConvention();
    expect(c.labels.plane).toBe("hermes-gitops.factorylevel.dev/plane");
    expect(c.labels.component).toBe("hermes-gitops.factorylevel.dev/component");
  });
});
