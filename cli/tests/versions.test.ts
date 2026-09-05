// versions.json is THE resolved-versions surface (ADR-63): a pin that also
// exists as a literal in source is two answers to "what version installs",
// and the copy is the one that rots. This test greps the live source trees
// for every pinned value and fails on any literal outside versions.json.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import versions from "../../versions.json";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const SOURCE_TREES = ["cli/src", "infra/src"];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(p);
    else if (entry.name.endsWith(".ts")) yield p;
  }
}

describe("versions.json is the single source", () => {
  const pins = [
    versions.charts.argocd,
    versions.charts.eso,
    versions.charts.pko,
    versions.host.k3s,
    versions.host.kubectl,
    versions.host.helm,
    versions.host.bun,
    versions.runtimes.eve.version,
  ];

  test("no source file carries a literal copy of a pin", () => {
    const offenders: string[] = [];
    for (const tree of SOURCE_TREES) {
      for (const file of sourceFiles(path.join(ROOT, tree))) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          const code = line.split("//")[0]!; // comments may cite versions as prose
          for (const pin of pins) {
            if (code.includes(`"${pin}"`)) offenders.push(`${path.relative(ROOT, file)}:${i + 1} pins "${pin}"`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  // The Eve runtime pin (ADR-149) has three consumers outside the grep trees
  // - chart metadata, chart values and the reference Eve project - each of
  // which Helm/npm read as a literal. They must equal the pin, not merely
  // avoid copying it.
  test("the eve-agent chart and the example Eve project carry the pinned eve version", () => {
    const eve = versions.runtimes.eve.version;
    const chart = fs.readFileSync(path.join(ROOT, "harness/eve/charts/eve-agent/Chart.yaml"), "utf8");
    expect(chart).toContain(`appVersion: "${eve}"`);
    const values = fs.readFileSync(path.join(ROOT, "harness/eve/charts/eve-agent/values.yaml"), "utf8");
    expect(values).toContain(`tag: "${eve}"`);
    expect(values).toContain(`repository: ${versions.runtimes.eve.imageRepository}`);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "examples/eve-agent/agents/echo/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["eve"]).toBe(eve);
    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, "examples/eve-agent/agents/echo/package-lock.json"), "utf8"),
    ) as { packages: Record<string, { version: string }> };
    expect(lock.packages["node_modules/eve"]?.version).toBe(eve);
  });

  test("the eve-runtime image build reads its pin from versions.json, never a literal", () => {
    const build = fs.readFileSync(path.join(ROOT, "harness/eve/image/build.sh"), "utf8");
    expect(build).toContain("versions.json");
    expect(build).not.toContain(`"${versions.runtimes.eve.version}"`);
    const dockerfile = fs.readFileSync(path.join(ROOT, "harness/eve/image/Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG EVE_VERSION");
    expect(dockerfile).not.toContain(versions.runtimes.eve.version);
  });

  test("the vendored k3s installer matches its recorded checksum", () => {
    const body = fs.readFileSync(path.join(ROOT, "infra/scripts/server/vendor/k3s-install.sh"));
    const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    expect(digest).toBe(versions.host.k3sInstallerSha256);
  });
});

// #661 / ADR 0165: the Loki chart's image defaults equal versions.json's
// pins - one source of truth, the eve-runtime precedent.
import { parse as parseYamlLoki } from "yaml";
import { readFileSync as readLoki } from "node:fs";
import { join as joinLoki } from "node:path";
test("loki chart image defaults match versions.json", () => {
  const versions = JSON.parse(readLoki(joinLoki(import.meta.dir, "..", "..", "versions.json"), "utf8")) as {
    loki: { lokiImage: string; promtailImage: string };
  };
  const values = parseYamlLoki(
    readLoki(joinLoki(import.meta.dir, "..", "..", "control-plane", "loki", "chart", "values.yaml"), "utf8"),
  ) as { images: { loki: string; promtail: string } };
  expect(values.images.loki).toBe(versions.loki.lokiImage);
  expect(values.images.promtail).toBe(versions.loki.promtailImage);
});

// #664 / ADR 0167: the wiki chart's image default equals versions.json's pin.
test("wiki chart image default matches versions.json", () => {
  const v = JSON.parse(readLoki(joinLoki(import.meta.dir, "..", "..", "versions.json"), "utf8")) as { wiki: { image: string } };
  const values = parseYamlLoki(
    readLoki(joinLoki(import.meta.dir, "..", "..", "control-plane", "wiki", "chart", "values.yaml"), "utf8"),
  ) as { image: string };
  expect(values.image).toBe(v.wiki.image);
});

// #845: the Nexus chart's image default equals versions.json's pin, so the
// local loop builds exactly the image the chart names and never needs the
// legacy agent image for Nexus.
test("nexus chart image default matches versions.json", () => {
  const v = JSON.parse(readLoki(joinLoki(import.meta.dir, "..", "..", "versions.json"), "utf8")) as { nexus: { image: string } };
  const values = parseYamlLoki(
    readLoki(joinLoki(import.meta.dir, "..", "..", "control-plane", "nexus", "chart", "values.yaml"), "utf8"),
  ) as { image: { repository: string; tag: string } };
  expect(`${values.image.repository}:${values.image.tag}`).toBe(v.nexus.image);
  const build = readLoki(joinLoki(import.meta.dir, "..", "..", "control-plane", "nexus", "image", "build.sh"), "utf8");
  expect(build).toContain("versions.json");
});
