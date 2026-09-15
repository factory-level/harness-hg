// Rebuild the social preview from the existing mark and vendored fonts.
// Usage: bun infra/scripts/render-share-card.ts (requires nexus-ui dependencies).
import { chromium } from "../../nexus-ui/node_modules/playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const font = readFileSync(resolve(root, "landing/fonts/figtree-latin.woff2")).toString("base64");
const mark = readFileSync(resolve(root, "_docs/wiki/assets/mark.svg")).toString("base64");
const executablePath = process.env.HG_CHROME_PATH ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
if (!executablePath) throw new Error("Install Chrome or set HG_CHROME_PATH to its executable.");
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: Figtree; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 300 900; }
    * { box-sizing: border-box; } body { margin: 0; background: #EEEFF4; color: #141824; font-family: Figtree, sans-serif; }
    main { width: 1200px; height: 630px; padding: 64px 72px; position: relative; }
    header { display: flex; gap: 18px; align-items: center; font-size: 32px; font-weight: 650; }
    header span { color: #965423; } img { width: 60px; height: 60px; }
    h1 { font-size: 68px; line-height: 1.08; letter-spacing: -2px; max-width: 1000px; margin: 42px 0 24px; font-weight: 650; }
    p { font-size: 27px; color: #5F6379; margin: 0; }
    footer { position: absolute; bottom: 52px; left: 72px; right: 72px; border-top: 1px solid #bec1cc; padding-top: 24px; display: flex; justify-content: space-between; font-size: 23px; }
    .action { color: #965423; font-weight: 600; }
  </style></head><body><main>
    <header><img alt="" src="data:image/svg+xml;base64,${mark}">Harness <span>Hg</span></header>
    <h1>Run teams of AI agents<br>on Kubernetes from Git.</h1>
    <p>Your team declares. Argo CD reconciles. Nexus UI shows the result.</p>
    <footer><span class="action">Explore the demo · Build an agent team</span><span>Open source · Beta</span></footer>
  </main></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(root, "landing/assets/share-card.png") });
  console.log("Wrote landing/assets/share-card.png (1200×630)");
} finally {
  await browser.close();
}
