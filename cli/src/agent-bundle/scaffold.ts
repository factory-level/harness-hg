// The agent-team skeleton (#673, ADR 0178): what `hg bundle init` writes.
// A TEAM in the agent-team tree - `harness-hg/` at any level is exactly
// what the platform reads; everything beside it belongs to the harness or
// the team. Eve agents only (Eve is the strategic runtime; Hermes is frozen
// legacy and grows no new authoring surface - ADR 0172). Templates live
// HERE, not in examples/: examples/ is a proof surface (examples/agent-team
// is this scaffold's committed output) and reusing a fixture as a template
// would couple them.
//
// Only what the scaffold can fill HONESTLY is written. An absent
// harness-hg/*.yaml is a feature that is off - no bundles.yaml means every
// agent standalone, no apps.yaml means no supporting workloads - so the
// omitted files are listed in the README with one line each, never
// written as empty stubs.
//
// NOTE the naming register: this subject is the agent-team REPO (an
// external repo authored against the contract). It is unrelated to ADR-28
// profile BUNDLES (harness-hg/bundles.yaml, one pod for many profiles) -
// cli/src/platform/profile-bundles.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import versions from "../../../versions.json";
import { TEAM_API_VERSION } from "../layout.ts";

export interface ScaffoldResult {
  wrote: string[];
}

export interface ScaffoldAgent {
  harness: "eve";
  name: string;
}

// The pin comes from versions.json ONLY (ADR-63) - a literal fallback
// here would be the second copy cli/tests/versions.test.ts exists to
// refuse.
const eveVersion = (versions as { runtimes: { eve: { version: string } } }).runtimes.eve.version;

/** Every team-level file the contract knows, one line each - the README's
 * "what is not here and why" list, so an absent file reads as a choice. */
const OMITTED_TEAM_FILES: [string, string][] = [
  ["apps.yaml", "shared workloads (a board, a publisher): one chart each, with the agent that owns it - absent = none"],
  ["bundles.yaml", "which agents share one pod (ADR-28) - absent = every agent standalone"],
  ["communication.yaml", "ChatOps connection aliases + the durable transport - absent = no ChatOps, no queued routes"],
  ["connections.yaml", "third-party app registrations (GitHub App) the team binds to - absent = none"],
  ["capabilities.yaml", "capability -> provider bindings the team brings - absent = only peer endpoints provide"],
  ["topology.yaml", "the layout the team is built for (regions, no cluster names) - absent = single"],
];

function agentFiles(agent: ScaffoldAgent, index: number): Record<string, string> {
  const { name } = agent;
  const base = `agents/${agent.harness}/${name}`;
  // Staggered so two agents' archives never race the same minute.
  const hour = 3 + (index % 4);
  return {
    [`${base}/harness-hg/agent.yaml`]: `# What this agent IS to the platform (agent-team/v1alpha1 Agent). The
# directory name is its identity and must equal src/package.json name.
# Read by the emitter (env contract) and the topology compiler.
apiVersion: ${TEAM_API_VERSION}
kind: Agent
harness: ${agent.harness}
# Every environment variable the agent needs, by NAME - values are delivered
# by the platform's env Secret, never written here.
envRequires:
  - name: ANTHROPIC_API_KEY
    description: Anthropic API key; agent.ts calls the provider directly.
# What this agent supports, never where it runs (placement is the team's
# topology.yaml + the bootstrap's grants).
topology:
  supportedLayouts: [single]
`,
    [`${base}/harness-hg/backup.yaml`]: `# Archive intent only - schedule + retention; the destination is the
# platform's. Read by the emitter into the record's backup routine;
# \`hg backup run|verify|restore\` drive it. Absent = nothing backed up.
apiVersion: ${TEAM_API_VERSION}
kind: Backup
schedule: "0 ${hour} * * *"
retention: 7
`,
    [`${base}/harness-hg/test.yaml`]: `# Dev-loop config (agent-team/v1alpha1 AgentTest): placeholder values the
# LOCAL loop (\`hg test\`) runs with - never production credentials. A
# placeholder is loudly skipped by proofs, never silently green. Nothing
# in the cluster reads this file.
apiVersion: ${TEAM_API_VERSION}
kind: AgentTest
secrets:
  ANTHROPIC_API_KEY: dev-placeholder
`,
    [`${base}/harness-hg/dashboard.yaml`]: `# The agent's Nexus card (dashboard.hermes-gitops/v1alpha2): what the
# control plane's dashboard shows for it. \`hg nexus compile --source .\`
# validates; \`hg nexus emit\` projects it into the destination.
apiVersion: dashboard.hermes-gitops/v1alpha2
kind: NexusContribution
metadata:
  id: ${name}
  title: ${name}
spec:
  components:
    - id: ${name}
      kind: agent
      title: ${name}
      description: Scaffolded by hg bundle init - describe what this agent does.
      bind:
        profile: ${name}
`,
    [`${base}/src/package.json`]: `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        description:
          "One npm project = one Eve agent; the package name is the agent's identity and must equal the agents/eve/<name> directory (a DNS-1123 label, at most 40 characters).",
        engines: { node: ">=24" },
        scripts: { dev: "eve dev", build: "eve build", start: "eve start --host 0.0.0.0" },
        dependencies: { "@ai-sdk/anthropic": "^4.0.40", eve: eveVersion },
      },
      null,
      2,
    )}\n`,
    [`${base}/src/agent/agent.ts`]: `// The agent's runtime config - the Eve project the pod builds and runs.
// The one credential it needs is ANTHROPIC_API_KEY, declared in
// ../harness-hg/agent.yaml envRequires and delivered by the env Secret,
// never written here. Bound limits keep the data volume (and its backup
// archive) sized by intent.
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-haiku-4-5"),
  limits: {
    maxInputTokensPerSession: 2_000_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
`,
    [`${base}/src/agent/instructions.md`]: `You are ${name}. Say what you are doing, do it, and stop.
`,
  };
}

function repoFiles(team: string, agents: ScaffoldAgent[], gitopsRepoUrl: string): Record<string, string> {
  const harnesses = [...new Set(agents.map((a) => a.harness))];
  const names = agents.map((a) => a.name);
  const omitted = OMITTED_TEAM_FILES.map(([f, why]) => `- \`harness-hg/${f}\` - ${why}`).join("\n");
  return {
    "harness-hg/team.yaml": `# The team's identity (agent-team/v1alpha1 AgentTeam) - read FIRST by every
# hg verb and the emitter: its presence is what makes this an agent-team
# repository, and \`name\` is the one operational category every record,
# backup, alarm and event route of this repo groups under on Nexus.
# harnesses[] must list every agents/<harness>/ directory here.
apiVersion: ${TEAM_API_VERSION}
kind: AgentTeam
name: ${team}
displayName: ${team}
harnesses: [${harnesses.join(", ")}]
`,
    "harness-hg/destination.yaml": `# Where THIS repo's emitted records go (bundle-destination/v1alpha1).
# \`hg topology emit\` uses it as the default destination when no --output
# names one. A URL, never a local path.
apiVersion: hermes-gitops.factorylevel.dev/bundle-destination/v1alpha1
gitops:
  repoUrl: ${gitopsRepoUrl}
  branch: main
`,
    "harness-hg/workspaces.yaml": `# Repository mounts the TEAM brings (environment-workspaces v1alpha1): a
# git checkout granted to agents at a pinned commit. \`source: self\` = the
# agent's OWN source at the deployed revision - no credential, no second
# repo. The bootstrap may grant more (its environment spec's
# grants.workspaces); a repository named on both sides refuses.
# \`hg workspace doctor --dir .\` validates; \`hg workspace verify\` probes
# the checkout. Declare least-privilege from day one.
apiVersion: hermes.gitops/v1alpha1
kind: WorkspaceBindings

repositories:
  - name: own-source
    source: self
    mount: { path: /workspaces/own-source, access: read-only }

bindings:
  - repository: own-source
    profiles: [${names.join(", ")}]
    purpose: own-source
`,
    "evals/suite.yaml": `# The repo's deterministic eval suite (cli/schemas/evals/v1alpha2) -
# deliberately NOT a deployment surface: a repo with a broken suite
# deploys identically. \`hg eval --dir .\` runs it.
apiVersion: hermes-gitops.factorylevel.dev/evals/v1alpha2
name: ${team}-suite
`,
    ".gitignore": `# Eve build output and dependencies - the pod builds from the committed
# lockfile with \`npm ci\`; vendored dependencies are a bug here.
agents/*/*/src/node_modules/
agents/*/*/src/.output/
agents/*/*/src/.eve/
`,
    "README.md": `# ${team} — an agent team

Authored against the Harness Hg contract (ADR 0178). The one rule of this tree:
**\`harness-hg/\` at any level is exactly what the platform reads.** Everything beside it
belongs to the harness (\`src/\`, the payload it installs) or to the team.

\`\`\`
harness-hg/                      the TEAM: identity, destination, mounts (+ the files below when you need them)
agents/<harness>/<name>/
  harness-hg/                    the AGENT: agent.yaml, backup.yaml, test.yaml, dashboard.yaml (+ endpoints.yaml)
  src/                           the payload the harness builds and runs
evals/                           behaviour suite - never deployed
\`\`\`

Not scaffolded, because absent means honestly off - add one when you need it:

${omitted}
- \`agents/<harness>/<name>/harness-hg/endpoints.yaml\` - what the agent exposes and receives - absent = nothing

The loop:

\`\`\`bash
hg validate --dir .          # the contract gate, every failure at once
hg topology plan --dir .     # the physical plan
hg topology emit --dir .     # records -> the destination (harness-hg/destination.yaml)
hg gitops doctor <dest>      # the destination verifies clean
\`\`\`
`,
  };
}

/** Write the skeleton. Never overwrites - an existing file is a
 * finding, not a casualty (idempotent re-run skips it). */
export function scaffoldBundle(opts: {
  dir: string;
  team: string;
  agents: ScaffoldAgent[];
  gitopsRepoUrl: string;
}): ScaffoldResult {
  const files: Record<string, string> = repoFiles(opts.team, opts.agents, opts.gitopsRepoUrl);
  opts.agents.forEach((a, i) => Object.assign(files, agentFiles(a, i)));
  const wrote: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(opts.dir, rel);
    if (fs.existsSync(abs)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    wrote.push(rel);
  }
  return { wrote };
}
