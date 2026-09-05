// The #667 lint gates, as source-text tests (the dashboard's
// style-system.test.ts precedent: no DOM, no browser, fails in CI).
// These enforce the anti-pattern list (_docs/design/nexus-ui/anti-patterns.md).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({
  rel: path.relative(ROOT, p),
  text: fs.readFileSync(p, "utf8"),
}));

const THEME = "src/theme/theme.css";
const LAYER_FILE = "src/layers.ts";

describe("style gates (#667)", () => {
  test("no numeric z-index/zIndex outside the layer model and the generated theme", () => {
    // A named request - z-index: var(--nx-z-<layer>) - is the sanctioned
    // form anywhere; a NUMBER outside the layer file is the violation.
    const offenders = files
      .filter((f) => f.rel !== THEME && f.rel !== LAYER_FILE)
      .filter((f) => {
        const uses = [...f.text.matchAll(/z-index\s*:\s*([^;\n]+)|zIndex\s*[:=]\s*([^,;\n]+)/g)];
        return uses.some((m) => {
          const v = (m[1] ?? m[2] ?? "").trim();
          return !/^var\(--nx-z-[a-z-]+\)/.test(v) && !/^layerVar\(/.test(v);
        });
      })
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("position fixed/absolute lives only inside primitives (and the theme)", () => {
    const allowed = (rel: string) =>
      rel.startsWith("src/primitives/") || rel === THEME;
    const offenders = files
      .filter((f) => !allowed(f.rel))
      .filter((f) => /position\s*:\s*(fixed|absolute)/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("no palette literals outside the generated theme (tokens flow from design/tokens.json)", () => {
    // Comments carry issue refs (#667) that look like hex - strip them
    // before scanning; only code/CSS values count.
    const stripComments = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const offenders = files
      .filter((f) => f.rel !== THEME)
      .filter((f) => /#[0-9a-fA-F]{6,8}\b|(?<![\w.])rgba?\(/.test(stripComments(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("no !important", () => {
    const offenders = files.filter((f) => f.text.includes("!important")).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("no module-scope mutable state in components (let/var at top level)", () => {
    // Factories returning state are fine (createHoverRegistry); bare
    // module-level `let` in component files is the #401-era coupling.
    const offenders = files
      .filter((f) => f.rel.endsWith(".tsx"))
      .filter((f) => /^(let|var)\s/m.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("every in-page layer name resolves to a token the theme defines", async () => {
    const { PAGE_LAYERS } = await import("../src/layers");
    const theme = fs.readFileSync(path.join(ROOT, THEME), "utf8");
    for (const l of PAGE_LAYERS) {
      expect(theme, l).toContain(`--nx-z-${l}:`);
    }
  });
});
