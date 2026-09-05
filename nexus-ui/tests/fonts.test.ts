// #435 / ADR-105: the brand faces are self-hosted. The deployed CSP has
// no external origin, so any stylesheet that reaches for one is silently
// refused in the browser and the page falls back to system-ui - a
// regression this suite exists to make loud at build time instead. The
// faces are a platform inventory (control-plane/nexus/fonts/) that rides
// the gitops repo like the avatars and is served by a validated route;
// they deliberately do NOT ride the chart or the stylesheet (the Helm
// release Secret sits near its 1MiB cap - inlining them as data: URIs
// broke a factory roll).
//
// History: the old dashboard/ tree carried this gate; the #732 flip
// retired that tree and the rebuilt nexus-ui shipped without the
// @font-face rules for a week - every screen rendered in system-ui
// again. The gate is back, pointed at the rebuild's generated theme.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const NEXUS = path.join(ROOT, "..", "control-plane", "nexus");
const themeCss = fs.readFileSync(path.join(ROOT, "src", "theme", "theme.css"), "utf8");
const distCss = fs.readFileSync(path.join(NEXUS, "dist", "style.css"), "utf8");
const FONTS = path.join(NEXUS, "fonts");
const ROUTE = /url\(\s*["']?(\/api\/plugins\/hermes-gitops\/nexus\/assets\/fonts\/[a-z0-9-]+\.woff2)["']?\s*\)/g;

describe("self-hosted fonts (#435, ADR-105)", () => {
  test("the built stylesheet references no external origin", () => {
    expect(distCss).not.toMatch(/@import\s+url\(\s*["']?https?:/);
    expect(distCss).not.toMatch(/url\(\s*["']?https?:/);
  });

  test("all three faces resolve through the fonts asset route, in source and in dist", () => {
    // Quotes are optional: the minifier strips them on the way into dist.
    for (const [label, css] of [["theme.css", themeCss], ["dist/style.css", distCss]] as const) {
      const urls = [...css.matchAll(ROUTE)];
      expect(urls.length, label).toBe(3);
      expect(css.match(/@font-face/g)?.length, label).toBe(3);
      // Every URL the stylesheet asks for names a file the inventory
      // actually carries - a rename in one place is a broken face.
      for (const [, u] of urls) {
        const name = u!.split("/").pop()!;
        expect(fs.existsSync(path.join(FONTS, name)), `${label}: ${name}`).toBe(true);
      }
    }
  });

  test("the faces are variable and swap in (never block text on a 404)", () => {
    // Demo mode and a first run cannot serve the route (ADR-105's stated
    // cost); swap keeps the fallback text painted meanwhile.
    expect(themeCss.match(/font-display:\s*swap/g)?.length).toBe(3);
    expect(themeCss.match(/font-weight:\s*400 800/g)?.length).toBe(3);
  });

  test("every committed font is genuine woff2 under the serve-time cap", () => {
    // The commit-side half of the mirrored validator: plugin_api's
    // font_asset_error refuses non-woff2 and >256KB at serve; this sweep
    // keeps the committed inventory servable.
    const files = fs.readdirSync(FONTS).filter((n) => n.endsWith(".woff2"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const n of files) {
      const bytes = fs.readFileSync(path.join(FONTS, n));
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
    }
  });

  test("nothing injects a runtime font stylesheet", () => {
    for (const f of ["src/index.tsx", "src/standalone.tsx"]) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(text, f).not.toContain("fonts.googleapis.com");
      expect(text, f).not.toContain('rel = "stylesheet"');
    }
  });
});
