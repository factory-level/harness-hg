// Offline unit tests for the cluster module's pure surface (issue #4
// [A2]) — no Pulumi runtime, no cloud SDKs.
import { describe, expect, test } from "bun:test";
import { DEFAULT_CLUSTER_NAME, gkeKubeconfig } from "../src/components/cluster/index.ts";

describe("gkeKubeconfig", () => {
  const doc = gkeKubeconfig("hermes-gitops", "203.0.113.7", "Q0FEQVRB");

  test("embeds cluster name, endpoint, and CA data", () => {
    expect(doc).toContain("name: hermes-gitops");
    expect(doc).toContain("server: https://203.0.113.7");
    expect(doc).toContain("certificate-authority-data: Q0FEQVRB");
    expect(doc).toContain("current-context: hermes-gitops");
  });

  test("authenticates via the gke exec plugin, no static credential", () => {
    expect(doc).toContain("command: gke-gcloud-auth-plugin");
    expect(doc).toContain("apiVersion: client.authentication.k8s.io/v1beta1");
    expect(doc).not.toContain("token:");
    expect(doc).not.toContain("client-key");
  });

  test("is valid YAML-shaped config (kind: Config)", () => {
    expect(doc.startsWith("apiVersion: v1\nkind: Config\n")).toBe(true);
  });
});

describe("DEFAULT_CLUSTER_NAME", () => {
  test("is hermes-gitops", () => {
    expect(DEFAULT_CLUSTER_NAME).toBe("hermes-gitops");
  });
});
