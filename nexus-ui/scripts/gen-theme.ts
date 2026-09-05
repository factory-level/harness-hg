// Emits src/theme/theme.css from design/tokens.json - the committed theme
// is a projection, drift-checked (tests/theme.test.ts + CI git diff) and
// never hand-edited. Scoping is spike-verified: everything under .nx-root,
// dark as a full token-for-token override, no :root rules - the plugin
// never leaks into the host page.
import * as fs from "node:fs";
import * as path from "node:path";
import { renderTheme } from "./render-theme";

const ROOT = path.join(import.meta.dir, "..");
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, "design", "tokens.json"), "utf8"));
const out = path.join(ROOT, "src", "theme", "theme.css");
fs.mkdirSync(path.dirname(out), { recursive: true });
const css = renderTheme(tokens);
fs.writeFileSync(out, css);
console.log(`wrote ${path.relative(ROOT, out)} (${css.length} bytes)`);
