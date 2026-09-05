// ADR-53 parity: `hg nexus set` must be able to express every chart value
// the Pulumi bootstrap can set. helm's --set cannot - it splits on commas
// and coerces anything that looks numeric - so overrides go through a
// values FILE. These pin the two cases that drove that decision.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nexusHelmArgs, nexusValuesDoc } from "../src/platform/index.ts";

describe("nexus value overrides (ADR-53)", () => {
  test("dotted keys expand into a nested document", () => {
    expect(nexusValuesDoc({ "adapters.gateway.enabled": "true", "state.size": "5Gi" })).toEqual({
      adapters: { gateway: { enabled: true } },
      state: { size: "5Gi" },
    });
  });

  test("siblings under one parent merge instead of clobbering", () => {
    expect(nexusValuesDoc({ "adapters.argo.enabled": "false", "adapters.gateway.enabled": "true" })).toEqual({
      adapters: { argo: { enabled: false }, gateway: { enabled: true } },
    });
  });

  test("a comma survives - the case --set could not express", () => {
    // helm --set would read this as two assignments and lose the URL.
    const doc = nexusValuesDoc({ "alert.url": "https://hooks.example/a,b" });
    expect(doc).toEqual({ alert: { url: "https://hooks.example/a,b" } });
  });

  test("only exact literals coerce; version-like strings stay strings", () => {
    expect(nexusValuesDoc({ cacheSeconds: "30", staleAfterSeconds: "90" })).toEqual({
      cacheSeconds: 30,
      staleAfterSeconds: 90,
    });
    // Only integers coerce. A decimal is an image/chart version far more
    // often than a number, and `tag: 1` would be a wrong image reference
    // that reads like a typo in the manifest rather than a CLI bug.
    expect(nexusValuesDoc({ tag: "1.0" })).toEqual({ tag: "1.0" });
    expect(nexusValuesDoc({ tag: "1.0.3", owner: "pulumi" })).toEqual({ tag: "1.0.3", owner: "pulumi" });
  });
});

// The precedence half of the same contract, which the tests above missed:
// they proved a values FILE can express things `--set` cannot, and never
// checked which one helm actually applies. It applies `--set` - over every
// `-f`, in either argument order - so a derived `--set` silently defeated
// `hg nexus set` for gitopsUrl, gitopsBranch, argocdBaseUrl and
// grafanaBaseUrl. Codex found it; these pin it shut.
describe("nexus value precedence (ADR-53)", () => {
  test("the helm argv uses no --set at all", () => {
    const args = nexusHelmArgs(["-f", "/tmp/derived.json", "-f", "/tmp/overrides.json"]);
    expect(args).not.toContain("--set");
    // …and none of the derived keys leaks in as one under another spelling.
    expect(args.join(" ")).not.toMatch(/--set(-string|-json|-file)?\b/);
  });

  test("the operator's file comes after the derived one", () => {
    const args = nexusHelmArgs(["-f", "/tmp/derived.json", "-f", "/tmp/overrides.json"]);
    const derived = args.indexOf("/tmp/derived.json");
    const overrides = args.indexOf("/tmp/overrides.json");
    expect(derived).toBeGreaterThan(-1);
    // Later -f wins in helm, so this ordering IS the override mechanism.
    expect(overrides).toBeGreaterThan(derived);
  });

  test("helm really does let the later -f win", () => {
    // Asserting our own argv is not enough - the claim is about helm's
    // behaviour, so ask helm. Skipped rather than failed where helm is
    // absent; `make chart-test` covers the same binary.
    const which = Bun.spawnSync(["helm", "version", "--short"]);
    if (which.exitCode !== 0) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-prec-"));
    const derived = path.join(dir, "derived.json");
    const override = path.join(dir, "override.json");
    fs.writeFileSync(derived, JSON.stringify({ gitopsUrl: "git://x", argocdBaseUrl: "DERIVED" }));
    fs.writeFileSync(override, JSON.stringify({ argocdBaseUrl: "OPERATOR" }));
    const chart = path.join(import.meta.dir, "..", "..", "control-plane", "nexus", "chart");
    const out = Bun.spawnSync(["helm", "template", "nexus", chart, "-f", derived, "-f", override]);
    const text = out.stdout.toString();
    expect(text).toContain("OPERATOR");
    expect(text).not.toContain("DERIVED");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
