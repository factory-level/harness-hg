// The static demo (`make site` -> site/demo/) renders on fixture data with
// no backend: the DEMO DATA badge shows and an avatar image decodes from
// the extensionless files build-site.sh lays out. Gated behind NX_BROWSER=1
// like acceptance.test.ts; needs `make site` to have run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";

const ON = process.env.NX_BROWSER === "1";
const SITE = path.join(import.meta.dir, "..", "..", "site");

let browser: Browser;
let server: ReturnType<typeof Bun.serve> | null = null;

describe.skipIf(!ON)("the static Nexus UI demo", () => {
  beforeAll(async () => {
    const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
    browser = await chromium.launch({ executablePath: exe, headless: true });
    // A dumb static server: no content-type guessing beyond html/css/js, so
    // the extensionless avatars arrive as octet-stream - the worst case a
    // real host can hand the <img>.
    server = Bun.serve({
      port: 0,
      fetch(req) {
        let p = decodeURIComponent(new URL(req.url).pathname);
        if (p.endsWith("/")) p += "index.html";
        const f = path.join(SITE, p);
        if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response("nope", { status: 404 });
        const ct = f.endsWith(".html") ? "text/html" : f.endsWith(".css") ? "text/css" : f.endsWith(".js") ? "text/javascript" : f.endsWith(".json") ? "application/json" : "application/octet-stream";
        return new Response(fs.readFileSync(f), { headers: { "content-type": ct } });
      },
    });
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("renders fixture data and real avatars without an API", async () => {
    expect(fs.existsSync(path.join(SITE, "demo", "demo.js"))).toBe(true);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const failed: string[] = [];
    page.on("pageerror", (e) => failed.push(String(e)));
    await page.goto(`http://127.0.0.1:${server!.port}/demo/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".nx-root", { timeout: 10_000 });
    expect(failed).toEqual([]);
    expect(await page.locator("text=DEMO DATA").count()).toBeGreaterThan(0);
    await page.goto(`http://127.0.0.1:${server!.port}/demo/#/avatars`, { waitUntil: "networkidle" });
    await page.waitForSelector("img", { timeout: 10_000 });
    const decoded = await page.evaluate(() =>
      Promise.all(Array.from(document.images).slice(0, 5).map((i) => i.decode().then(() => i.naturalWidth > 0, () => false))),
    );
    expect(decoded).toContain(true);
    await page.close();
  }, 60_000);
});
