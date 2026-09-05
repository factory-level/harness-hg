// Screenshot pairs for the Wave-3 review loop: old (dashboard demo) vs
// new (nexus-ui standalone) per screen, both themes, committed under
// design/review/ so every screen PR carries its evidence.
// Usage: bun browser/capture.ts <screen> <oldUrl> <newUrl>
import { chromium } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";

const [screen, oldUrl, newUrl] = process.argv.slice(2);
if (!screen || !oldUrl || !newUrl) {
  console.error("usage: bun browser/capture.ts <screen> <oldUrl> <newUrl>");
  process.exit(2);
}
const OUT = path.join(import.meta.dir, "..", "design", "review");
fs.mkdirSync(OUT, { recursive: true });
const exe = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe!, headless: true });

for (const [age, url] of [["old", oldUrl], ["new", newUrl]] as const) {
  for (const theme of ["dark", "light"] as const) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript((t: string) => {
      try {
        localStorage.setItem("nx-theme", t);
      } catch {
        // storage may be unavailable; the default (dark) then stands
      }
    }, theme);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(900); // let entry animations settle
    const file = path.join(OUT, `${screen}-${age}-${theme}.png`);
    await page.screenshot({ path: file });
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
    await page.close();
  }
}
await browser.close();
