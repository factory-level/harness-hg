// The avatar/font inventory fallbacks must name a directory that exists in
// this checkout - the retired dashboard/ tree once made the inventory read
// empty and `hg nexus emit` pruned every avatar from the GitOps tree.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { platformAvatarsDir, platformFontsDir } from "../src/local/shared.ts";

describe("platform inventories", () => {
  test("the avatar inventory directory exists and is not empty", () => {
    const dir = platformAvatarsDir();
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).some((f) => f.endsWith(".webp") || f.endsWith(".gif"))).toBe(true);
  });
  test("the font inventory directory exists", () => {
    expect(existsSync(platformFontsDir())).toBe(true);
  });
});
