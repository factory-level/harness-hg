// hg bundle init (#673, ADR 0178): the agent-bundle loop's front door.
// Scaffold a new agent-team repo (Eve agents only - Hermes is frozen
// legacy, ADR 0172), then prove the scaffold passes its own gate and
// print the loop it just entered. The subject is the agent-team REPO; see
// scaffold.ts's note on the unrelated ADR-28 profile-bundles register.
import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, jsonOut, log, ok, sh } from "../lib.ts";
import { FrontDoorStep, runFrontDoor } from "../frontdoor.ts";
import { cmdValidate } from "../validate/command.ts";
import { scaffoldBundle, type ScaffoldAgent } from "./scaffold.ts";

const DNS_LABEL = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

/** `--agents eve:manager,eve:research` -> the agents to scaffold. A bare
 * name is Eve. Hermes is refused with the copy-from-examples path: a
 * scaffold cannot honestly fill env_requires, a model or skills, so it
 * would write a profile that installs and does nothing. */
export function parseAgents(spec: string): ScaffoldAgent[] {
  const out: ScaffoldAgent[] = [];
  for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [harness, name] = entry.includes(":") ? entry.split(":", 2) : ["eve", entry];
    if (harness === "hermes") {
      throw new CliError(
        `--agents ${entry}: Hermes agents are not scaffolded (ADR 0172: Hermes is frozen legacy). ` +
          `Copy examples/communication-plane/distributions/<x> into agents/hermes/${name}/src and ` +
          `write agents/hermes/${name}/harness-hg/agent.yaml (harness: hermes) by hand`,
      );
    }
    if (harness !== "eve") throw new CliError(`--agents ${entry}: unknown harness ${JSON.stringify(harness)} (eve)`);
    if (!name || !DNS_LABEL.test(name) || name.length > 40) {
      throw new CliError(`--agents ${entry}: ${JSON.stringify(name ?? "")} is not a DNS-1123 label (max 40)`);
    }
    if (out.some((a) => a.name === name)) throw new CliError(`--agents: ${name} is listed twice`);
    out.push({ harness: "eve", name });
  }
  if (out.length === 0) throw new CliError("--agents names no agent");
  return out;
}

export function cmdBundle(
  json: boolean,
  args: string[],
  opts: { agent?: string; agents?: string; gitops?: string; dryRun: boolean },
): void {
  const [sub, target] = args;
  if (sub !== "init") {
    throw new CliError(`unknown bundle subcommand ${JSON.stringify(sub ?? "")} (init)`);
  }
  if (!target) throw new CliError("bundle init requires a directory: hg bundle init <dir>");
  if (opts.agent && opts.agents) throw new CliError("--agent and --agents are alternatives - pass one");
  const dir = path.resolve(target);
  // The team's name: the directory, minus a `.harness-hg` suffix by convention.
  const team = path.basename(dir).replace(/\.harness-hg$/, "").replace(/[^a-z0-9-]/g, "-").slice(0, 40);
  if (!DNS_LABEL.test(team)) {
    throw new CliError(`team name ${JSON.stringify(team)} (from the directory) is not a DNS-1123 label`);
  }
  const agents = parseAgents(opts.agents ?? opts.agent ?? team);
  const gitopsRepoUrl = opts.gitops ?? "https://github.com/<org>/<name>.gitops.git";
  const agentsFlag = opts.agents ? ` --agents ${opts.agents}` : opts.agent ? ` --agent ${opts.agent}` : "";

  let result = { wrote: [] as string[] };
  const steps: FrontDoorStep[] = [
    {
      title: `scaffold the team repo (${agents.length} Eve agent${agents.length === 1 ? "" : "s"}: ${agents.map((a) => a.name).join(", ")})`,
      command: `hg bundle init ${target}${agentsFlag}${opts.gitops ? ` --gitops ${opts.gitops}` : ""}`,
      run: () => {
        fs.mkdirSync(dir, { recursive: true });
        result = scaffoldBundle({ dir, team, agents, gitopsRepoUrl });
        if (result.wrote.length === 0) {
          log("  (every file already exists - nothing overwritten)");
        }
        for (const f of result.wrote) log(`  + ${f}`);
      },
    },
    ...agents.map((a): FrontDoorStep => {
      const src = path.join(dir, "agents", a.harness, a.name, "src");
      return {
        title: `the lockfile ${a.name}'s pod \`npm ci\` build contract needs`,
        command: `npm install --package-lock-only  # in ${path.relative(process.cwd(), src)}`,
        probe: () => (fs.existsSync(path.join(src, "package-lock.json")) ? "lockfile present" : false),
        run: () => {
          sh(["npm", "install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: src });
        },
      };
    }),
    {
      title: "the scaffold passes its own contract gate",
      command: `hg validate --dir ${target}`,
      run: () => cmdValidate(true, dir),
    },
    {
      title: "a git repository exists",
      command: `git init ${target}`,
      probe: () => (fs.existsSync(path.join(dir, ".git")) ? "already a repo" : false),
      run: () => {
        sh(["git", "init", "-q", dir]);
      },
    },
  ];

  runFrontDoor("bundle init", steps, { dryRun: opts.dryRun });
  if (opts.dryRun) return;

  if (json) {
    jsonOut({ command: "bundle-init", ok: true, dir, team, agents, wrote: result.wrote });
    return;
  }
  ok(`bundle init: ${team} is a valid agent team (${agents.map((a) => a.name).join(", ")}) - the loop from here:`);
  log(`  hg topology plan --dir ${target}     # the physical plan`);
  log(`  hg topology emit --dir ${target}     # records -> ${gitopsRepoUrl}`);
  log(`  hg eval --dir ${target}/evals        # the deterministic suite`);
  if (!opts.gitops) {
    log(`  ! set the real destination in ${path.join(target, "harness-hg", "destination.yaml")}`);
  }
}
