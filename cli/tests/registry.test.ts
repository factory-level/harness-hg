// The local OCI registry emulation (#302's stand-in).
//
// Persona app charts are private OCI artifacts (ADR-31), so nothing on
// this loop could pull them: Argo CD got a 403 and the Application sat
// `Unknown / Healthy` - which is to say the app had never deployed while
// looking fine on a list. The loop now serves its own registry.

import { describe, expect, test } from "bun:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { chartsWantedBy, redirectOciRepos, registryHost, registryRepo } from "../src/platform/registry.ts";
import type { HgState } from "../src/lib.ts";

const state = {
  gatewayIp: "172.25.0.1",
  ports: { git: 1, http: 2, sink: 3, registry: 5111 },
} as HgState;

const record = (apps: unknown[]) => stringifyYaml({ spec: { apps } });

describe("addressing", () => {
  test("the registry is reachable at the host gateway, like the issuer", () => {
    // Charts are PUSHED from this host and PULLED from inside the
    // cluster. One address has to satisfy both, and 127.0.0.1 does not.
    expect(registryHost(state)).toBe("172.25.0.1:5111");
    expect(registryRepo(state)).toBe("oci://172.25.0.1:5111/charts");
  });
});

describe("chartsWantedBy", () => {
  test("the RECORDS decide what to publish, not the charts directory", () => {
    // Publishing everything in charts/ would push versions no record
    // asks for; the cluster is the consumer, so it names the set.
    const wanted = chartsWantedBy(
      [record([{ chart: "postiz", repo: "oci://ghcr.io/x/charts", version: "0.2.0" }])],
      parseYaml,
    );
    expect([...wanted]).toEqual([["postiz", "0.2.0"]]);
  });

  test("a non-OCI app is not published", () => {
    const wanted = chartsWantedBy(
      [record([{ chart: "monitoring", repo: "local", version: "1.0.0" }])],
      parseYaml,
    );
    expect(wanted.size).toBe(0);
  });

  test("an app with no pinned version is skipped rather than guessed", () => {
    const wanted = chartsWantedBy(
      [record([{ chart: "postiz", repo: "oci://ghcr.io/x/charts" }])],
      parseYaml,
    );
    expect(wanted.size).toBe(0);
  });

  test("the same chart across records resolves to one version", () => {
    const wanted = chartsWantedBy(
      [
        record([{ chart: "kanban", repo: "oci://ghcr.io/x/charts", version: "1.0.0" }]),
        record([{ chart: "kanban", repo: "oci://ghcr.io/x/charts", version: "1.0.0" }]),
      ],
      parseYaml,
    );
    expect(wanted.get("kanban")).toBe("1.0.0");
  });
});

describe("redirectOciRepos", () => {
  test("an oci repo is redirected to the local registry", () => {
    const out = redirectOciRepos(
      record([{ chart: "postiz", repo: "oci://ghcr.io/factory-level/charts", version: "0.2.0" }]),
      state,
      parseYaml,
      stringifyYaml,
    );
    expect(out).toContain("oci://172.25.0.1:5111/charts");
    expect(out).not.toContain("ghcr.io");
  });

  test("a non-OCI repo is untouched", () => {
    const yaml = record([{ chart: "monitoring", repo: "local", version: "1.0.0" }]);
    expect(redirectOciRepos(yaml, state, parseYaml, stringifyYaml)).toBe(yaml);
  });

  test("an already-redirected record is returned unchanged", () => {
    // Idempotence matters: `up` runs on every reconciler tick, and
    // re-serialising a record on every one would churn the GitOps repo.
    const yaml = record([{ chart: "postiz", repo: "oci://172.25.0.1:5111/charts", version: "0.2.0" }]);
    expect(redirectOciRepos(yaml, state, parseYaml, stringifyYaml)).toBe(yaml);
  });

  test("a record with no apps is returned unchanged", () => {
    const yaml = stringifyYaml({ spec: { persona: "x" } });
    expect(redirectOciRepos(yaml, state, parseYaml, stringifyYaml)).toBe(yaml);
  });
});
