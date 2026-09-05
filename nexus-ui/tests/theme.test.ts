// The committed theme.css is a projection of design/tokens.json - this
// test IS the drift gate (CI also re-runs gen-theme + git diff, so a
// hand-edited committed file fails twice).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderTheme } from "../scripts/render-theme";

const ROOT = path.join(import.meta.dir, "..");
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, "design", "tokens.json"), "utf8"));

describe("theme projection", () => {
  test("committed theme.css matches design/tokens.json byte-for-byte", () => {
    const committed = fs.readFileSync(path.join(ROOT, "src", "theme", "theme.css"), "utf8");
    expect(committed).toBe(renderTheme(tokens));
  });

  test("the layer scale ascends and app-root sits at the host boundary", () => {
    const inPage = Object.entries(tokens.layers).filter(([n]) => n !== "app-root");
    const values = inPage.map(([, z]) => z as number);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
    expect(tokens.layers["app-root"]).toBe(60);
  });

  test("every color token has both modes and no mode value is empty", () => {
    for (const [name, v] of Object.entries<Record<string, string>>(tokens.colors)) {
      expect(v.light, name).toBeTruthy();
      expect(v.dark, name).toBeTruthy();
    }
  });

  test("the edit accent has a real dark value (the old hardcode had none)", () => {
    expect(tokens.colors["edit-acc"].dark).not.toBe(tokens.colors["edit-acc"].light);
  });
});
