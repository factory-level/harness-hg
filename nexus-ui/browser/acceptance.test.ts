// The browser acceptance matrix, re-pointed at the rebuild (#668 - keep
// the suite, swap the target; the #307 floor carried from
// dashboard/browser/acceptance.test.ts). Gated behind NX_BROWSER=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import * as fs from "node:fs";
import { startHarness, type Harness } from "./serve.ts";

const ON = process.env.NX_BROWSER === "1";
const TARGET = process.env.NX_TARGET;
const FIXTURE = ON && !TARGET;

// 720×450 is 1440×900 at 200% zoom: browser zoom shrinks CSS pixels,
// so the zoomed layout IS the small-viewport layout.
const VIEWPORTS = [
  { w: 360, h: 800, label: "phone" },
  { w: 768, h: 1024, label: "tablet" },
  { w: 1440, h: 900, label: "desktop" },
  { w: 720, h: 450, label: "200% zoom" },
];
const VIEWS = ["#/fleet", "#/communication", "#/agents", "#/backups", "#/avatars"];

let browser: Browser;
let harness: Harness | null = null;
let base = "";

async function open(
  pageUrl: string,
  opts: { w?: number; h?: number; reducedMotion?: boolean; theme?: string } = {},
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: opts.w ?? 1440, height: opts.h ?? 900 },
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  if (opts.theme) {
    await ctx.addInitScript((t) => localStorage.setItem("nx-theme", t), opts.theme);
  }
  const page = await ctx.newPage();
  await page.goto(pageUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".nx-root", { timeout: 10_000 });
  return page;
}

describe.skipIf(!ON)("the browser acceptance matrix (nexus-ui)", () => {
  beforeAll(async () => {
    const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
    browser = process.env.NX_CDP
      ? await chromium.connectOverCDP(process.env.NX_CDP)
      : await chromium.launch({ executablePath: exe, headless: true });
    if (FIXTURE) harness = startHarness();
    base = TARGET ?? harness!.url;
  });
  afterAll(async () => {
    await browser?.close();
    harness?.stop();
  });

  test("no view lets the browser scroll, at any size, in either theme", async () => {
    for (const vp of VIEWPORTS) {
      for (const theme of ["dark", "light"]) {
        const page = await open(base, { w: vp.w, h: vp.h, theme });
        for (const view of VIEWS) {
          await page.goto(`${base}/${view}`, { waitUntil: "networkidle" });
          await page.waitForSelector(".nx-root");
          const m = await page.evaluate(() => ({
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
            bodyScrolls: document.body.scrollHeight > window.innerHeight + 1,
            theme: document.querySelector(".nx-root")?.getAttribute("data-nx-theme"),
          }));
          expect({ vp: vp.label, theme, view, overflowX: m.overflowX > 0 }).toEqual({ vp: vp.label, theme, view, overflowX: false });
          expect({ vp: vp.label, view, bodyScrolls: m.bodyScrolls }).toEqual({ vp: vp.label, view, bodyScrolls: false });
          expect(m.theme).toBe(theme);
        }
        await page.context().close();
      }
    }
  }, 240_000);

  test("theme and settings are two controls with one job each", async () => {
    const page = await open(base);
    const toggle = page.locator('button[aria-label^="Switch to"]');
    const before = await page.locator(".nx-root").getAttribute("data-nx-theme");
    await toggle.click();
    const after = await page.locator(".nx-root").getAttribute("data-nx-theme");
    expect(after).not.toBe(before);
    // The settings menu is the Astryx DropdownMenu now - address it by
    // role, which is the contract, not by a bespoke class. Closed menus
    // stay in the DOM, so the claim is visibility, not existence.
    expect(await page.locator('[role="menu"]:visible').count()).toBe(0);
    await page.reload({ waitUntil: "networkidle" });
    expect(await page.locator(".nx-root").getAttribute("data-nx-theme")).toBe(after);
    await page.locator('button[aria-label="Settings"]').click();
    await page.waitForSelector('[role="menu"][aria-label="Settings"]');
    expect(await page.locator(".nx-root").getAttribute("data-nx-theme")).toBe(after);
    await page.context().close();
  }, 30_000);

  test("the settings menu paints ON TOP of page content (layering)", async () => {
    const page = await open(base);
    await page.locator('button[aria-label="Settings"]').click();
    await page.waitForSelector('[role="menu"][aria-label="Settings"]');
    const box = (await page.locator('[role="menu"][aria-label="Settings"]').boundingBox())!;
    const topmost = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menu"]') !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(topmost).toBe(true);
    await page.context().close();
  }, 30_000);

  test("the drawer opens in the TOP LAYER and Escape closes it", async () => {
    const page = await open(`${base}/#/backups`);
    await page.locator(".nx-bk-shelfhead").first().click();
    await page.locator(".nx-bk-row").first().click();
    await page.waitForSelector(".nx-drawer[open]");
    const modal = await page.evaluate(() => (document.querySelector(".nx-drawer") as HTMLDialogElement).matches(":modal"));
    expect(modal).toBe(true);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => (document.querySelector(".nx-drawer") as HTMLDialogElement | null)?.open ?? false)).toBe(false);
    await page.context().close();
  }, 30_000);

  test("measured pages centre their columns at desktop width", async () => {
    const page = await open(`${base}/#/agents`);
    const head = (await page.locator(".nx-agents .nx-view-head").boundingBox())!;
    const vw = 1440;
    const left = head.x;
    const right = vw - (head.x + head.width);
    expect(Math.abs(left - right)).toBeLessThan(9);
    await page.context().close();
  }, 30_000);

  // ── Edit-mode probes (fixture only: demo edits stay local; a live
  // target would take real writes) ────────────────────────────────────
  test.skipIf(!FIXTURE)("placing a note disarms the tool, focuses its editor, and Escape commits", async () => {
    const page = await open(`${base}/#/fleet`);
    await page.getByRole("button", { name: "Edit board" }).click();
    const before = await page.locator(".nx-note").count();
    await page.getByRole("button", { name: "Note", exact: true }).click();
    await page.locator(".nx-canvas").click({ position: { x: 300, y: 620 } });
    // One note, editor focused, tool disarmed to Select.
    await page.waitForSelector(".nx-note-editor");
    expect(await page.locator(".nx-note").count()).toBe(before + 1);
    expect(await page.evaluate(() => document.activeElement?.className)).toContain("nx-note-editor");
    expect(await page.getByRole("button", { name: "Note", exact: true }).getAttribute("aria-pressed")).toBe("false");
    // Typed text survives Escape (it commits; it used to discard).
    await page.keyboard.type("probed");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    expect(await page.locator(".nx-note", { hasText: "probed" }).count()).toBe(1);
    // A second canvas click places NOTHING - the tool is no longer armed.
    await page.locator(".nx-canvas").click({ position: { x: 500, y: 620 } });
    await page.waitForTimeout(100);
    expect(await page.locator(".nx-note").count()).toBe(before + 1);
    await page.context().close();
  }, 60_000);

  test.skipIf(!FIXTURE)("demo mode says 'Local only' instead of a dead Save button", async () => {
    const page = await open(`${base}/#/fleet`);
    await page.getByRole("button", { name: "Edit board" }).click();
    await page.getByRole("button", { name: "Note", exact: true }).click();
    await page.locator(".nx-canvas").click({ position: { x: 300, y: 620 } });
    await page.waitForSelector(".nx-note-editor");
    await page.keyboard.press("Escape");
    let word = "";
    for (let i = 0; i < 30; i++) {
      word = (await page.locator(".nx-ws-savestate").textContent()) ?? "";
      if (/local only/i.test(word)) break;
      await page.waitForTimeout(100);
    }
    expect(word).toMatch(/local only/i);
    expect(await page.locator(".nx-ws-savestate button").count()).toBe(0);
    await page.context().close();
  }, 60_000);

  test.skipIf(!FIXTURE)("⌘Z / ⇧⌘Z drive history from the keyboard", async () => {
    const page = await open(`${base}/#/fleet`);
    await page.getByRole("button", { name: "Edit board" }).click();
    const before = await page.locator(".nx-note").count();
    await page.getByRole("button", { name: "Note", exact: true }).click();
    await page.locator(".nx-canvas").click({ position: { x: 300, y: 620 } });
    await page.waitForSelector(".nx-note-editor");
    await page.keyboard.press("Escape"); // commit the (empty) editor
    await page.waitForTimeout(100);
    expect(await page.locator(".nx-note").count()).toBe(before + 1);
    await page.keyboard.press("Control+z"); // undo the placement
    await page.waitForTimeout(100);
    expect(await page.locator(".nx-note").count()).toBe(before);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(100);
    expect(await page.locator(".nx-note").count()).toBe(before + 1);
    await page.context().close();
  }, 60_000);

  test.skipIf(!FIXTURE)("a selected note resizes by its corner grip", async () => {
    const page = await open(`${base}/#/fleet`);
    await page.getByRole("button", { name: "Edit board" }).click();
    await page.getByRole("button", { name: "Note", exact: true }).click();
    await page.locator(".nx-canvas").click({ position: { x: 300, y: 620 } });
    await page.waitForSelector(".nx-note-editor");
    await page.keyboard.press("Escape"); // commit; note stays selected
    await page.waitForSelector(".nx-grip");
    const before = (await page.locator(".nx-note").last().boundingBox())!;
    const g = (await page.locator(".nx-grip").boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 80, g.y + g.height / 2 + 50, { steps: 5 });
    await page.mouse.up();
    const after = (await page.locator(".nx-note").last().boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 60);
    expect(after.height).toBeGreaterThan(before.height + 30);
    await page.context().close();
  }, 60_000);

  test.skipIf(!FIXTURE)("a wire is selectable via its fat hit path, and Delete removes it", async () => {
    const page = await open(`${base}/#/fleet`);
    await page.getByRole("button", { name: "Edit board" }).click();
    const before = await page.locator(".nx-edge").count();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const cards = page.locator(".nx-cardnode");
    await cards.nth(0).click();
    await cards.nth(1).click();
    await page.waitForTimeout(100);
    expect(await page.locator(".nx-edge").count()).toBe(before + 1);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.locator(".nx-edge-hit").last().click();
    await page.waitForSelector(".nx-ctxbar");
    expect(await page.locator(".nx-ctxbar-what").textContent()).toBe("Connection");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(100);
    expect(await page.locator(".nx-edge").count()).toBe(before);
    await page.context().close();
  }, 60_000);

  test.skipIf(!FIXTURE)("the gallery lists the real library; reduced motion inverts to per-tile play", async () => {
    const page = await open(`${base}/#/avatars`, { reducedMotion: true });
    const tiles = page.locator(".nx-ava-tile");
    expect(await tiles.count()).toBeGreaterThanOrEqual(8);
    // reduced motion: the play control exists per tile and the img wears -still
    const firstImg = tiles.first().locator("img");
    expect(await firstImg.getAttribute("src")).toContain("-still");
    await tiles.first().locator('button[aria-label^="Play"]').click();
    expect(await firstImg.getAttribute("src")).not.toContain("-still");
    await page.context().close();
  }, 30_000);
});
