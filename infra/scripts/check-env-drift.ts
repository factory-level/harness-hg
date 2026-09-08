// Read-only source/projection parity. Credential readiness belongs to hg env plan/apply.
import fs from "node:fs";
import path from "node:path";
import { generateEnvironmentProjections } from "../../cli/src/env/command.ts";

const root = path.resolve(import.meta.dir, "../..");
const directory = path.join(root, "infra/environments");
let failed = false;
for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".yaml")).sort()) {
  const name = file.slice(0, -5);
  const projections = generateEnvironmentProjections(name, path.join(directory, file));
  const drift = projections.filter(({ file, result }) => !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== result.text);
  if (drift.length) {
    failed = true;
    console.error(`DRIFT: environment ${name}: ${drift.map(({ file }) => path.relative(root, file)).join(", ")} (run hg env apply ${name})`);
  } else {
    console.log(`OK: environment ${name} matches its generated config`);
  }
}
if (failed) process.exit(1);
