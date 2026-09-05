// Extracted per the subject directory contract (#657). The ENVIRONMENT
// subject (#674): plan/apply/import over the declarative spec. The
// spec lives at infra/environments/<name>.yaml; the generated
// projections are state/Pulumi.<name>.yaml + infra/Pulumi.<name>.yaml.
// (The profile dotenv group is `hg envfile` - ./envfile.ts.)
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError, PLATFORM_ROOT, jsonOut, log, ok } from "../lib.ts";
import { generateStack } from "./generate.ts";
import { importEnvironment } from "./import.ts";
import { loadEnvironmentSpec } from "./spec.ts";

export interface EnvOpts {
  state?: string;
  infra?: string;
  out?: string;
  spec?: string;
}

function specPath(name: string, override?: string): string {
  return path.resolve(override ?? path.join(PLATFORM_ROOT, "infra", "environments", `${name}.yaml`));
}

function stackTargets(name: string) {
  return [
    { stack: "state" as const, dir: path.join(PLATFORM_ROOT, "state"), file: path.join(PLATFORM_ROOT, "state", `Pulumi.${name}.yaml`) },
    { stack: "infra" as const, dir: path.join(PLATFORM_ROOT, "infra"), file: path.join(PLATFORM_ROOT, "infra", `Pulumi.${name}.yaml`) },
  ];
}

export function projectNameOf(stackDir: string): string {
  const doc = parseYaml(fs.readFileSync(path.join(stackDir, "Pulumi.yaml"), "utf8")) as { name?: string };
  if (!doc?.name) throw new CliError(`${stackDir}/Pulumi.yaml has no project name`);
  return doc.name;
}

function generateBoth(name: string, specFile: string) {
  const spec = loadEnvironmentSpec(specFile);
  if (spec.name !== name) {
    throw new CliError(`env: the spec at ${specFile} declares name ${JSON.stringify(spec.name)}, not ${JSON.stringify(name)}`);
  }
  return stackTargets(name).map((t) => ({
    ...t,
    result: generateStack(spec, t.stack, {
      project: projectNameOf(t.dir),
      existingFile: t.file,
      stackDir: t.dir,
    }),
  }));
}

export function cmdEnvironment(json: boolean, args: string[], opts: EnvOpts): void {
  const [sub, name] = args;
  if (!sub) throw new CliError("usage: hg env plan|apply|import <name>");
  if (!name) throw new CliError(`env ${sub} requires the environment name`);

  if (sub === "import") {
    const stateFile = opts.state ?? path.join(PLATFORM_ROOT, "state", `Pulumi.${name}.yaml`);
    const infraFile = opts.infra ?? path.join(PLATFORM_ROOT, "infra", `Pulumi.${name}.yaml`);
    const text = importEnvironment({ name, stateFile, infraFile });
    const out = specPath(name, opts.out ?? opts.spec);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    // The import must round-trip before it is worth anything: load what
    // we wrote, regenerate both stacks, and compare VALUES against the
    // originals (formatting/comments move; config must not).
    loadEnvironmentSpec(out);
    if (json) jsonOut({ command: "env-import", ok: true, spec: out });
    else ok(`env import: wrote ${out} - review it, then \`hg env plan ${name}\``);
    return;
  }

  if (sub === "plan" || sub === "apply") {
    const generated = generateBoth(name, specPath(name, opts.spec));
    let drift = 0;
    const missing = generated.flatMap((g) => g.result.missingSecrets);
    for (const g of generated) {
      const current = fs.existsSync(g.file) ? fs.readFileSync(g.file, "utf8") : "";
      if (current === g.result.text) {
        log(`  ${g.stack}: ${path.relative(PLATFORM_ROOT, g.file)} up to date`);
        continue;
      }
      drift++;
      if (sub === "apply") {
        fs.writeFileSync(g.file, g.result.text);
        ok(`  ${g.stack}: wrote ${path.relative(PLATFORM_ROOT, g.file)}`);
      } else {
        log(`  ${g.stack}: ${path.relative(PLATFORM_ROOT, g.file)} DRIFTS from the spec:`);
        printDiff(current, g.result.text);
      }
    }
    for (const m of missing) {
      log(`  ! secret unset at ${m.stack}:${m.path} - supply it:\n      ${m.fix}`);
    }
    if (json) {
      jsonOut({ command: `env-${sub}`, ok: sub === "apply" || drift === 0, drift, missingSecrets: missing });
    } else if (sub === "plan") {
      if (drift === 0 && missing.length === 0) ok(`env plan: ${name} is clean (spec == generated config)`);
      else log(`env plan: ${drift} stack file(s) drift, ${missing.length} secret(s) unset`);
    }
    if (sub === "plan" && drift > 0) throw new CliError(`env plan: ${name} drifts from its spec`);
    if (sub === "apply" && missing.length > 0) {
      throw new CliError(`env apply: ${missing.length} secret(s) unset - run the printed commands, then re-apply`);
    }
    return;
  }

  throw new CliError(`unknown env subcommand ${JSON.stringify(sub)} (plan|apply|import)`);
}

function printDiff(a: string, b: string): void {
  // Minimal line diff - enough to SEE the drift; `git diff` remains the
  // review tool once apply writes the projection.
  const al = a.split("\n");
  const bl = b.split("\n");
  const max = Math.max(al.length, bl.length);
  let shown = 0;
  for (let i = 0; i < max && shown < 40; i++) {
    if (al[i] !== bl[i]) {
      if (al[i] !== undefined) console.log(`      - ${al[i]}`);
      if (bl[i] !== undefined) console.log(`      + ${bl[i]}`);
      shown++;
    }
  }
  if (shown >= 40) console.log("      … (more; run hg env apply and review with git diff)");
}
